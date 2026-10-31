//! Finder 同款快速查看：QuickLookUI 的共享 `QLPreviewPanel`。
//!
//! `qlmanage -p` 只是调试预览窗。系统面板是进程内单例，必须由响应链上某个对象
//! 接受控制（`acceptsPreviewPanelControl:` → `beginPreviewPanelControl:`），
//! 并在主线程操作。WKWebView 不会接这个面板，所以在主窗口的 NSWindow 子类上
//! 补这三个方法，由它们把数据源/委托设到下面的控制器。
//!
//! 空格 / Esc 关闭：预览视图经常先吃掉按键，委托的 `handleEvent` 收不到。
//! 面板可见时用本地事件监视器在派发前拦截，和 Finder 一样关掉面板。

use std::cell::RefCell;
use std::ffi::c_void;
use std::path::Path;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};

use block2::RcBlock;
use objc2::ffi::NSInteger;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, ProtocolObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSEvent, NSEventMask, NSEventModifierFlags, NSEventType, NSWindow, NSWindowDelegate,
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_quick_look_ui::{QLPreviewPanel, QLPreviewPanelDataSource, QLPreviewPanelDelegate};
use tauri::{AppHandle, Emitter, Manager};

struct Ivars {
    items: RefCell<Vec<Retained<NSURL>>>,
    session: RefCell<PreviewSession>,
    app: RefCell<Option<AppHandle>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "BentoQuickLookController"]
    #[ivars = Ivars]
    struct QuickLookController;

    unsafe impl NSObjectProtocol for QuickLookController {}

    unsafe impl NSWindowDelegate for QuickLookController {
        #[unsafe(method(windowShouldClose:))]
        fn window_should_close(&self, _sender: &NSWindow) -> bool {
            self.notify_closed();
            true
        }
    }

    unsafe impl QLPreviewPanelDataSource for QuickLookController {
        #[unsafe(method(numberOfPreviewItemsInPreviewPanel:))]
        fn number_of_items(&self, _panel: Option<&QLPreviewPanel>) -> NSInteger {
            self.ivars().items.borrow().len() as NSInteger
        }

        #[unsafe(method_id(previewPanel:previewItemAtIndex:))]
        fn item_at(
            &self,
            _panel: Option<&QLPreviewPanel>,
            index: NSInteger,
        ) -> Option<Retained<NSURL>> {
            self.ivars().items.borrow().get(index as usize).cloned()
        }
    }

    unsafe impl QLPreviewPanelDelegate for QuickLookController {
        #[unsafe(method(previewPanel:handleEvent:))]
        fn handle_event(&self, panel: Option<&QLPreviewPanel>, event: Option<&NSEvent>) -> Bool {
            let (Some(panel), Some(event)) = (panel, event) else {
                return Bool::NO;
            };
            if event.isARepeat() || !is_dismiss_key(event) {
                return Bool::NO;
            }
            self.dismiss(panel);
            Bool::YES
        }
    }
);

impl QuickLookController {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars {
            items: RefCell::new(Vec::new()),
            session: RefCell::new(PreviewSession::default()),
            app: RefCell::new(None),
        });
        unsafe { msg_send![super(this), init] }
    }

    fn notify_closed(&self) {
        let session = self.ivars().session.borrow_mut().close();
        if let (Some(session), Some(app)) = (session, self.ivars().app.borrow().as_ref()) {
            let _ = app.emit(
                "bento-quick-look-closed",
                serde_json::json!({ "session": session }),
            );
        }
    }

    fn dismiss(&self, panel: &QLPreviewPanel) {
        self.notify_closed();
        panel.orderOut(None);
    }

    fn navigate(&self, direction: i32) -> bool {
        let session = self.ivars().session.borrow().id.clone();
        if let (Some(session), Some(app)) = (session, self.ivars().app.borrow().as_ref()) {
            let _ = app.emit(
                "bento-quick-look-navigate",
                serde_json::json!({ "session": session, "direction": direction }),
            );
            return true;
        }
        false
    }

    fn set_items(&self, items: Vec<Retained<NSURL>>) {
        *self.ivars().items.borrow_mut() = items;
    }
}

/// 进程内唯一控制器。面板不保留数据源，所以这里泄漏持有到进程结束。
static CONTROLLER: AtomicPtr<QuickLookController> = AtomicPtr::new(std::ptr::null_mut());

fn controller(mtm: MainThreadMarker) -> &'static QuickLookController {
    let existing = CONTROLLER.load(Ordering::Acquire);
    if !existing.is_null() {
        return unsafe { &*existing };
    }
    let ptr = Retained::into_raw(QuickLookController::new(mtm));
    CONTROLLER.store(ptr, Ordering::Release);
    unsafe { &*ptr }
}

fn shared_panel(mtm: MainThreadMarker) -> Option<Retained<QLPreviewPanel>> {
    unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) }
}

fn panel_is_visible(mtm: MainThreadMarker) -> bool {
    if !unsafe { QLPreviewPanel::sharedPreviewPanelExists(mtm) } {
        return false;
    }
    shared_panel(mtm).is_some_and(|panel| panel.isVisible())
}

/// 空格（keyCode 49）或 Esc（53）。带 ⌘/⌃/⌥ 的组合（如聚焦搜索）不拦截。
fn is_dismiss_key(event: &NSEvent) -> bool {
    if event.r#type() != NSEventType::KeyDown {
        return false;
    }
    let mods = NSEventModifierFlags::Command
        | NSEventModifierFlags::Control
        | NSEventModifierFlags::Option;
    if event.modifierFlags().intersects(mods) {
        return false;
    }
    let code = event.keyCode();
    code == 49
        || code == 53
        || event
            .charactersIgnoringModifiers()
            .is_some_and(|s| s.to_string() == " ")
}

fn install_key_monitor() {
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    let block = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
        let event_ref = unsafe { event.as_ref() };
        let pass = event.as_ptr();
        let Some(mtm) = MainThreadMarker::new() else {
            return pass;
        };
        if !panel_is_visible(mtm) {
            return pass;
        }
        let ctrl = controller(mtm);
        let mods = NSEventModifierFlags::Command
            | NSEventModifierFlags::Control
            | NSEventModifierFlags::Option
            | NSEventModifierFlags::Shift;
        if !event_ref.modifierFlags().intersects(mods) {
            let direction = match event_ref.keyCode() {
                125 => Some(1),
                126 => Some(-1),
                _ => None,
            };
            if direction.is_some_and(|direction| ctrl.navigate(direction)) {
                return std::ptr::null_mut();
            }
        }
        if !is_dismiss_key(event_ref) {
            return pass;
        }
        // 吞掉连发，避免面板刚打开就被重复的 keydown 关掉；第一次则关闭。
        if !event_ref.isARepeat() {
            if let Some(panel) = shared_panel(mtm) {
                ctrl.dismiss(&panel);
            }
        }
        std::ptr::null_mut()
    });
    let block: &'static RcBlock<dyn Fn(NonNull<NSEvent>) -> *mut NSEvent> =
        Box::leak(Box::new(block));
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, block)
    };
    if monitor.is_none() {
        eprintln!("[quicklook] local key monitor was not installed");
    }
}

fn attach_panel(panel: &QLPreviewPanel, ctrl: &QuickLookController) {
    let source = ProtocolObject::from_ref(ctrl);
    unsafe {
        panel.setDataSource(Some(source));
        panel.setDelegate(Some(ctrl));
    }
}

fn detach_panel(panel: &QLPreviewPanel) {
    unsafe {
        panel.setDataSource(None);
        panel.setDelegate(None);
    }
}

unsafe extern "C" fn accepts_preview_panel_control(
    _this: *mut AnyObject,
    _cmd: objc2::runtime::Sel,
    _panel: *mut AnyObject,
) -> Bool {
    Bool::YES
}

unsafe extern "C" fn begin_preview_panel_control(
    _this: *mut AnyObject,
    _cmd: objc2::runtime::Sel,
    panel: *mut AnyObject,
) {
    if panel.is_null() {
        return;
    }
    let ctrl = CONTROLLER.load(Ordering::Acquire);
    if ctrl.is_null() {
        return;
    }
    let panel = unsafe { &*(panel as *const QLPreviewPanel) };
    attach_panel(panel, unsafe { &*ctrl });
}

unsafe extern "C" fn end_preview_panel_control(
    _this: *mut AnyObject,
    _cmd: objc2::runtime::Sel,
    panel: *mut AnyObject,
) {
    if panel.is_null() {
        return;
    }
    let panel = unsafe { &*(panel as *const QLPreviewPanel) };
    detach_panel(panel);
}

fn install_window_hooks(ns_window: *mut c_void) {
    static DONE: AtomicBool = AtomicBool::new(false);
    if ns_window.is_null() || DONE.load(Ordering::Acquire) {
        return;
    }
    unsafe {
        let obj = &*(ns_window as *const AnyObject);
        let mut cls = obj.class();
        if cls.name().to_bytes().starts_with(b"NSKVONotifying_") {
            if let Some(sup) = cls.superclass() {
                cls = sup;
            }
        }
        let accepts = std::mem::transmute::<
            unsafe extern "C" fn(*mut AnyObject, objc2::runtime::Sel, *mut AnyObject) -> Bool,
            objc2::runtime::Imp,
        >(accepts_preview_panel_control);
        let begin = std::mem::transmute::<
            unsafe extern "C" fn(*mut AnyObject, objc2::runtime::Sel, *mut AnyObject),
            objc2::runtime::Imp,
        >(begin_preview_panel_control);
        let end = std::mem::transmute::<
            unsafe extern "C" fn(*mut AnyObject, objc2::runtime::Sel, *mut AnyObject),
            objc2::runtime::Imp,
        >(end_preview_panel_control);
        let cls = cls as *const AnyClass as *mut AnyClass;
        let ok_a = objc2::ffi::class_addMethod(
            cls,
            sel!(acceptsPreviewPanelControl:),
            accepts,
            c"c@:@".as_ptr(),
        );
        let ok_b = objc2::ffi::class_addMethod(
            cls,
            sel!(beginPreviewPanelControl:),
            begin,
            c"v@:@".as_ptr(),
        );
        let ok_e =
            objc2::ffi::class_addMethod(cls, sel!(endPreviewPanelControl:), end, c"v@:@".as_ptr());
        eprintln!(
            "[quicklook] window hooks accepts={} begin={} end={}",
            ok_a.as_bool(),
            ok_b.as_bool(),
            ok_e.as_bool()
        );
    }
    DONE.store(true, Ordering::Release);
}

fn file_url(path: &str) -> Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(path))
}

fn push_file(out: &mut Vec<String>, path: &str) {
    if path.is_empty() || out.iter().any(|e| e == path) {
        return;
    }
    if Path::new(path).is_file() {
        out.push(path.to_string());
    }
}

/// 只预览真实文件（目录保持原行为：空格不打开）。顺序沿用前端给出的列表。
fn preview_files(primary: &str, extra: Option<Vec<String>>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(extra) = extra {
        for p in &extra {
            push_file(&mut out, p);
        }
    }
    if out.is_empty() {
        push_file(&mut out, primary);
    }
    out
}

fn show(
    mtm: MainThreadMarker,
    primary: &str,
    extra: Option<Vec<String>>,
    session: Option<String>,
    update: Option<u64>,
) -> Result<(), String> {
    let ctrl = controller(mtm);

    if let Some(revision) = update {
        // An update never presents or toggles. Cocoa and the session gate run together on main.
        if !panel_is_visible(mtm)
            || !session.as_deref().is_some_and(|id| {
                ctrl.ivars()
                    .session
                    .borrow_mut()
                    .accept_update(id, revision)
            })
        {
            return Ok(());
        }
    } else if panel_is_visible(mtm) {
        if let Some(panel) = shared_panel(mtm) {
            ctrl.dismiss(&panel);
        }
        return Ok(());
    }

    let files = preview_files(primary, extra);
    if files.is_empty() {
        return Ok(());
    }
    let index = files.iter().position(|p| p == primary).unwrap_or(0) as NSInteger;
    if update.is_none() {
        ctrl.ivars().session.borrow_mut().open(session);
    }
    ctrl.set_items(files.iter().map(|p| file_url(p)).collect());

    let panel = shared_panel(mtm).ok_or("无法创建快速查看面板")?;
    if update.is_none() {
        panel.makeKeyAndOrderFront(None);
    }
    // beginPreviewPanelControl: 里会挂一次；这里再挂一次，避免面板成为 key window
    // 后把数据源清掉，或响应链没走到窗口钩子时出现空白面板。
    attach_panel(&panel, ctrl);
    unsafe {
        panel.reloadData();
        panel.setCurrentPreviewItemIndex(index);
    }
    eprintln!("[quicklook] show {} item(s) index={index}", files.len());
    Ok(())
}

pub async fn present(
    app: AppHandle,
    path: String,
    paths: Option<Vec<String>>,
    session: Option<String>,
) -> Result<(), String> {
    dispatch(app, path, paths, session, None).await
}

pub async fn update(
    app: AppHandle,
    path: String,
    paths: Option<Vec<String>>,
    session: String,
    revision: u64,
) -> Result<(), String> {
    dispatch(app, path, paths, Some(session), Some(revision)).await
}

async fn dispatch(
    app: AppHandle,
    path: String,
    paths: Option<Vec<String>>,
    session: Option<String>,
    revision: Option<u64>,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.clone()
        .run_on_main_thread(move || {
            let result = (|| {
                let mtm = MainThreadMarker::new().ok_or("Quick Look 必须在主线程运行")?;
                if let Some(window) = app.get_webview_window("main") {
                    let ns = window.ns_window().map_err(|e| e.to_string())?;
                    install_window_hooks(ns);
                }
                *controller(mtm).ivars().app.borrow_mut() = Some(app.clone());
                install_key_monitor();
                show(mtm, &path, paths, session, revision)
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Default)]
struct PreviewSession {
    id: Option<String>,
    revision: u64,
}
impl PreviewSession {
    fn open(&mut self, id: Option<String>) {
        self.id = id;
        self.revision = 0;
    }
    fn accept_update(&mut self, id: &str, revision: u64) -> bool {
        if self.id.as_deref() != Some(id) || revision <= self.revision {
            return false;
        }
        self.revision = revision;
        true
    }
    fn close(&mut self) -> Option<String> {
        self.id.take()
    }
}

#[cfg(test)]
mod tests {
    use super::PreviewSession;
    #[test]
    fn updates_never_toggle_and_late_revisions_cannot_reverse_preview() {
        let mut session = PreviewSession::default();
        session.open(Some("right".into()));
        assert!(session.accept_update("right", 2));
        assert!(!session.accept_update("right", 1));
        assert!(!session.accept_update("left", 3));
        assert_eq!(session.close(), Some("right".into()));
        assert!(!session.accept_update("right", 4));
        session.open(Some("new".into()));
        assert!(!session.accept_update("right", 5));
        assert!(session.accept_update("new", 1));
    }
}
