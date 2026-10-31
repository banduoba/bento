//! Pure quit handshake state; callers perform UI/runtime work after dropping its lock.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ExitDecision {
    Allow,
    Request(u64),
    Drain(u64),
    Prevent,
}

#[derive(Default)]
pub(crate) struct ExitGate {
    next_request: u64,
    pending: Option<u64>,
    approved_once: bool,
}
impl ExitGate {
    #[cfg(test)]
    pub(crate) fn request(&mut self, has_windows: bool, explicit: bool) -> ExitDecision {
        self.request_with_operations(has_windows, explicit, false)
    }
    pub(crate) fn request_with_operations(
        &mut self,
        has_windows: bool,
        explicit: bool,
        busy: bool,
    ) -> ExitDecision {
        let approved = std::mem::take(&mut self.approved_once);
        if (!has_windows || approved) && !busy {
            self.pending = None;
            return ExitDecision::Allow;
        }
        if let Some(request_id) = self.pending {
            if explicit && busy {
                return ExitDecision::Drain(request_id);
            }
            if explicit {
                // A second deliberate quit is the escape hatch for an unresponsive
                // frontend. Never silently discard unsaved state on a timer.
                self.pending = None;
                return ExitDecision::Allow;
            }
            return ExitDecision::Prevent;
        }
        self.next_request += 1;
        self.pending = Some(self.next_request);
        ExitDecision::Request(self.next_request)
    }

    fn is_pending(&self, request_id: u64) -> bool {
        self.pending == Some(request_id)
    }

    /// Returns whether the caller should invoke app.exit after releasing the lock.
    pub(crate) fn reply(&mut self, request_id: u64, allow_exit: bool) -> bool {
        if self.pending != Some(request_id) {
            return false;
        }
        self.pending = None;
        self.approved_once = allow_exit;
        allow_exit
    }
}

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub(crate) struct ExitState(Mutex<ExitGate>, AtomicU64);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitRequest {
    request_id: u64,
}

pub(crate) fn on_exit_requested(app: &AppHandle, code: Option<i32>, api: tauri::ExitRequestApi) {
    let has_windows = !app.webview_windows().is_empty();
    let operations = app.try_state::<crate::operations::OperationState>();
    let busy = operations.as_ref().is_some_and(|queue| queue.is_busy());
    let decision = {
        let state = app.state::<ExitState>();
        let Ok(mut gate) = state.0.lock() else {
            api.prevent_exit();
            eprintln!("[session-exit] quit gate lock poisoned");
            return;
        };
        gate.request_with_operations(has_windows, code.is_some(), busy)
    };
    #[cfg(debug_assertions)]
    eprintln!(
        "[session-exit] runtime request code={code:?} windows={has_windows} decision={decision:?}"
    );
    match decision {
        ExitDecision::Allow => {
            // Admission and idle check are atomic, closing the enqueue/quit race.
            if operations
                .as_ref()
                .is_some_and(|queue| !queue.seal_if_idle())
            {
                api.prevent_exit();
                app.exit(0);
            }
        }
        ExitDecision::Drain(request_id) => {
            api.prevent_exit();
            drain_after_repeated_quit(app, request_id);
        }
        ExitDecision::Prevent => api.prevent_exit(),
        ExitDecision::Request(request_id) => {
            api.prevent_exit();
            if let Err(error) = app.emit("bento-session-exit-requested", ExitRequest { request_id })
            {
                // Keep the pending request: a second explicit quit remains available.
                eprintln!("[session-exit] could not request frontend flush: {error}");
            }
        }
    }
}

/// A busy window must remain available to answer conflicts and the quit prompt.
/// The frontend's existing CloseRequested handler owns the choice and final flush.
pub(crate) fn on_window_close(app: &AppHandle, api: &tauri::CloseRequestApi) {
    if app
        .try_state::<crate::operations::OperationState>()
        .is_some_and(|queue| queue.is_busy())
    {
        api.prevent_close();
    }
}

fn drain_after_repeated_quit(app: &AppHandle, request_id: u64) {
    let state = app.state::<ExitState>();
    if state.1.swap(request_id, Ordering::AcqRel) == request_id {
        return;
    }
    let Some(queue) = app.try_state::<crate::operations::OperationState>() else {
        let _ = state
            .1
            .compare_exchange(request_id, 0, Ordering::AcqRel, Ordering::Acquire);
        return;
    };
    let queue = queue.inner().clone();
    queue.prepare_exit(true);
    {
        let gate = state.0.lock().unwrap();
        if !gate.is_pending(request_id) {
            if gate.pending.is_none() {
                queue.resume_admission();
            }
            let _ = state
                .1
                .compare_exchange(request_id, 0, Ordering::AcqRel, Ordering::Acquire);
            return;
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let drained = tauri::async_runtime::spawn_blocking(move || queue.wait_idle()).await;
        let state = app.state::<ExitState>();
        let _ = state
            .1
            .compare_exchange(request_id, 0, Ordering::AcqRel, Ordering::Acquire);
        let still_pending = state
            .0
            .lock()
            .map(|gate| gate.is_pending(request_id))
            .unwrap_or(false);
        if drained.is_ok() && still_pending {
            let _ = app.emit("bento-operation-exit-drained", ExitRequest { request_id });
        }
    });
}

#[tauri::command]
pub(crate) fn session_exit_reply(
    app: AppHandle,
    state: tauri::State<'_, ExitState>,
    request_id: u64,
    allow_exit: bool,
) -> Result<(), String> {
    let operations = app.try_state::<crate::operations::OperationState>();
    let exit = {
        let mut gate = state.0.lock().map_err(|e| e.to_string())?;
        // This lock order is gate -> queue, and neither operation emits or does IO.
        // Native request processing releases the queue lock before taking gate.
        if !gate.is_pending(request_id) {
            return Ok(());
        }
        if allow_exit {
            if operations
                .as_ref()
                .is_some_and(|queue| !queue.seal_if_idle())
            {
                return Err(
                    "file operations are still finishing; drain before session exit".into(),
                );
            }
        } else if let Some(queue) = operations.as_ref() {
            queue.resume_admission();
        }
        gate.reply(request_id, allow_exit)
    };
    if exit {
        app.exit(0);
    }
    Ok(())
}

/// Muda's native Quit calls NSApplication.terminate: directly. Tao 0.37 has
/// applicationWillTerminate: only, which is too late for a persistence handshake.
/// Add the missing delegate veto and route all native termination into Tauri's
/// request_exit path. Returning NSTerminateCancel is synchronous; app.exit queues
/// the actual request, so no frontend IPC or gate lock is held in AppKit callbacks.
#[cfg(target_os = "macos")]
pub(crate) fn install_native_quit(app: &tauri::App) -> Result<(), String> {
    use objc2::runtime::{AnyObject, Sel};
    use objc2::{class, msg_send, sel, Encode};
    use std::ffi::CString;
    use std::sync::OnceLock;
    static APP: OnceLock<AppHandle> = OnceLock::new();

    unsafe extern "C-unwind" fn should_terminate(
        _delegate: &AnyObject,
        _selector: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        if let Some(app) = APP.get() {
            #[cfg(debug_assertions)]
            eprintln!("[session-exit] native terminate redirected");
            app.exit(0);
        }
        0 // NSTerminateCancel, an NSUInteger (not BOOL).
    }

    // setup runs on the main thread, after Tao has installed its delegate.
    unsafe {
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if ns_app.is_null() {
            return Err("Cannot install session quit hook: NSApplication missing".into());
        }
        let delegate: *mut AnyObject = msg_send![ns_app, delegate];
        let Some(delegate) = delegate.as_ref() else {
            return Err("Cannot install session quit hook: application delegate missing".into());
        };
        let selector = sel!(applicationShouldTerminate:);
        // Do not replace a future framework implementation whose policy we don't own.
        if delegate.class().instance_method(selector).is_some() {
            return Err(
                "Cannot install session quit hook: applicationShouldTerminate: already implemented"
                    .into(),
            );
        }
        APP.set(app.handle().clone())
            .map_err(|_| "Session quit hook already initialized".to_string())?;
        let implementation = std::mem::transmute::<
            unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize,
            objc2::runtime::Imp,
        >(should_terminate);
        let encoding =
            CString::new(format!("{}@:@", usize::ENCODING)).map_err(|e| e.to_string())?;
        if !objc2::ffi::class_addMethod(
            delegate.class() as *const _ as *mut _,
            selector,
            implementation,
            encoding.as_ptr(),
        )
        .as_bool()
        {
            return Err("Cannot install session quit hook on application delegate".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quit_waits_for_matching_reply_then_allows_exactly_one_runtime_exit() {
        let mut gate = ExitGate::default();
        assert_eq!(gate.request(true, true), ExitDecision::Request(1));
        assert!(!gate.reply(99, true));
        assert_eq!(gate.request(true, false), ExitDecision::Prevent);
        assert!(gate.reply(1, true));
        assert!(
            !gate.reply(1, true),
            "duplicate reply must not schedule another app.exit"
        );
        assert_eq!(gate.request(true, true), ExitDecision::Allow);
        assert_eq!(
            gate.request(true, true),
            ExitDecision::Request(2),
            "approval consumed exactly once"
        );
    }
    #[test]
    fn cancellation_rearms_with_a_new_id_and_old_replies_cannot_exit() {
        let mut gate = ExitGate::default();
        assert_eq!(gate.request(true, true), ExitDecision::Request(1));
        assert!(!gate.reply(7, false));
        assert!(!gate.reply(1, false));
        assert_eq!(gate.request(true, true), ExitDecision::Request(2));
        assert!(!gate.reply(1, true));
        assert!(gate.reply(2, true));
    }
    #[test]
    fn second_explicit_quit_is_an_escape_but_implicit_requests_keep_waiting() {
        let mut gate = ExitGate::default();
        assert_eq!(gate.request(true, true), ExitDecision::Request(1));
        assert_eq!(gate.request(true, false), ExitDecision::Prevent);
        assert_eq!(gate.request(true, true), ExitDecision::Allow);
        assert!(!gate.reply(1, true));
    }
    #[test]
    fn windowless_exit_consumes_any_approval() {
        let mut gate = ExitGate::default();
        assert_eq!(gate.request(true, true), ExitDecision::Request(1));
        assert!(gate.reply(1, true));
        assert_eq!(gate.request(false, false), ExitDecision::Allow);
        assert_eq!(gate.request(true, true), ExitDecision::Request(2));
    }
    #[test]
    fn no_windows_allows_final_exit_and_invalidates_pending_reply() {
        let mut gate = ExitGate::default();
        assert_eq!(gate.request(false, false), ExitDecision::Allow);
        assert_eq!(gate.request(true, true), ExitDecision::Request(1));
        assert_eq!(gate.request(false, false), ExitDecision::Allow);
        assert!(!gate.reply(1, true));
    }
    #[test]
    fn busy_repeat_quit_drains_same_request_without_escape() {
        let mut gate = ExitGate::default();
        assert_eq!(
            gate.request_with_operations(true, true, true),
            ExitDecision::Request(1)
        );
        assert_eq!(
            gate.request_with_operations(true, false, true),
            ExitDecision::Prevent
        );
        assert_eq!(
            gate.request_with_operations(true, true, true),
            ExitDecision::Drain(1)
        );
        assert_eq!(
            gate.request_with_operations(true, true, true),
            ExitDecision::Drain(1)
        );
        assert!(gate.is_pending(1));
        assert!(!gate.reply(99, true));
        assert!(gate.reply(1, true));
        assert_eq!(
            gate.request_with_operations(true, true, false),
            ExitDecision::Allow
        );
    }
    #[test]
    fn windowless_busy_queue_still_requires_drain() {
        let mut gate = ExitGate::default();
        assert_eq!(
            gate.request_with_operations(false, false, true),
            ExitDecision::Request(1)
        );
        assert_eq!(
            gate.request_with_operations(false, true, true),
            ExitDecision::Drain(1)
        );
    }
}
