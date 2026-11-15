//! Editing commands owned by the focused native Quick Look panel.
use objc2::runtime::AnyObject;
use objc2::{msg_send, sel, ClassType};
use objc2_app_kit::{NSEventModifierFlags, NSWindow};
use objc2_foundation::NSObjectProtocol;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PreviewEdit {
    Copy,
    SelectAll,
}

pub(super) fn key_action(
    characters: &str,
    modifiers: NSEventModifierFlags,
    panel_is_key: bool,
    event_is_from_panel: bool,
) -> Option<PreviewEdit> {
    let shortcut_modifiers = NSEventModifierFlags::Command
        | NSEventModifierFlags::Shift
        | NSEventModifierFlags::Control
        | NSEventModifierFlags::Option;
    if !panel_is_key
        || !event_is_from_panel
        || modifiers & shortcut_modifiers != NSEventModifierFlags::Command
    {
        return None;
    }
    match characters.to_ascii_lowercase().as_str() {
        "c" => Some(PreviewEdit::Copy),
        "a" => Some(PreviewEdit::SelectAll),
        _ => None,
    }
}

pub(super) fn menu_action(id: &str, panel_is_key: bool) -> Option<PreviewEdit> {
    if !panel_is_key {
        return None;
    }
    match id {
        "edit-copy" => Some(PreviewEdit::Copy),
        "edit-select-all" => Some(PreviewEdit::SelectAll),
        _ => None,
    }
}

/// Send only to a responder inside the preview. NSApplication.sendAction with a
/// nil target can fall back to the main window when the preview cannot copy.
/// Stop before a window/application fallback; a read-only/empty selection must
/// never copy the underlying file instead of the selected document text.
pub(super) fn perform(panel: &NSWindow, action: PreviewEdit) -> bool {
    let selector = match action {
        PreviewEdit::Copy => sel!(copy:),
        PreviewEdit::SelectAll => sel!(selectAll:),
    };
    let mut responder = panel.firstResponder();
    // Defensive bound for a malformed third-party preview responder chain.
    for _ in 0..64 {
        let Some(current) = responder else {
            return false;
        };
        if current.isKindOfClass(NSWindow::class()) {
            return false;
        }
        if current.respondsToSelector(selector) {
            unsafe {
                let sender: Option<&AnyObject> = None;
                match action {
                    PreviewEdit::Copy => {
                        let _: () = msg_send![&*current, copy: sender];
                    }
                    PreviewEdit::SelectAll => {
                        let _: () = msg_send![&*current, selectAll: sender];
                    }
                }
            }
            return true;
        }
        responder = unsafe { current.nextResponder() };
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_preview_text_receives_copy_and_select_all() {
        let cmd = NSEventModifierFlags::Command;
        assert_eq!(key_action("c", cmd, true, true), Some(PreviewEdit::Copy));
        assert_eq!(
            key_action("a", cmd, true, true),
            Some(PreviewEdit::SelectAll)
        );
        assert_eq!(
            key_action("C", cmd | NSEventModifierFlags::CapsLock, true, true),
            Some(PreviewEdit::Copy)
        );
        assert_eq!(menu_action("edit-copy", true), Some(PreviewEdit::Copy));
        assert_eq!(
            menu_action("edit-select-all", true),
            Some(PreviewEdit::SelectAll)
        );
    }

    #[test]
    fn a_visible_preview_does_not_capture_file_or_text_field_copy_in_other_windows() {
        let cmd = NSEventModifierFlags::Command;
        assert_eq!(key_action("c", cmd, false, true), None);
        assert_eq!(key_action("c", cmd, true, false), None);
        assert_eq!(menu_action("edit-copy", false), None);
    }

    #[test]
    fn modified_shortcuts_and_other_commands_keep_their_existing_routes() {
        let cmd = NSEventModifierFlags::Command;
        for modifier in [
            NSEventModifierFlags::Shift,
            NSEventModifierFlags::Option,
            NSEventModifierFlags::Control,
        ] {
            assert_eq!(key_action("c", cmd | modifier, true, true), None);
            assert_eq!(key_action("a", cmd | modifier, true, true), None);
        }
        assert_eq!(
            key_action("c", NSEventModifierFlags::empty(), true, true),
            None
        );
        for key in ["v", "x", "z", " ", ""] {
            assert_eq!(key_action(key, cmd, true, true), None);
        }
        for id in ["edit-copy-paths", "edit-copy-names", "file-duplicate"] {
            assert_eq!(menu_action(id, true), None);
        }
    }
}
