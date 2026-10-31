use super::*;
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "bento-m6-executor-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn join(&self, p: &str) -> PathBuf {
        self.0.join(p)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        crate::cleanup_staging(&self.0)
    }
}
fn request(kind: OperationKind, src: &Path, dst: &Path) -> OperationRequest {
    OperationRequest {
        request_id: "request".into(),
        kind,
        items: vec![OperationItem {
            item_id: "item".into(),
            source: Some(src.to_string_lossy().into()),
            target_name: None,
            create_kind: None,
        }],
        destination: Some(dst.to_string_lossy().into()),
        options: Default::default(),
        intent: None,
        owner_tab_id: None,
        clip_revision: None,
    }
}
#[test]
fn copy_has_real_effect_and_undo_moves_to_trash() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"content").unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let c = OperationContext::detached("copy");
    let r = e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    assert_eq!(fs::read(d.join("dest/source")).unwrap(), b"content");
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Succeeded);
    let c = OperationContext::detached("undo");
    let r = e.execute(
        &Work::Undo {
            undo_id: r.undo_id.unwrap(),
        },
        &c,
    );
    assert!(r.undo_complete);
    assert!(!d.join("dest/source").exists());
    assert!(d.join("source").exists());
    assert_eq!(
        fs::read(
            c.recorded_outcomes()[0]
                .actual_destination
                .as_ref()
                .unwrap()
        )
        .unwrap(),
        b"content"
    );
}
#[test]
fn undo_protects_same_size_edits_and_new_directory_children() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::create_dir(d.join("source")).unwrap();
    fs::write(d.join("source/a"), b"content").unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let r = e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &OperationContext::detached("copy"),
    );
    fs::write(d.join("dest/source/new"), b"user data").unwrap();
    let c = OperationContext::detached("undo");
    let r = e.execute(
        &Work::Undo {
            undo_id: r.undo_id.unwrap(),
        },
        &c,
    );
    assert!(!r.undo_complete);
    assert_eq!(fs::read(d.join("dest/source/new")).unwrap(), b"user data");
}
#[test]
fn replace_keeps_old_content_and_restores_it_on_undo() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"incoming").unwrap();
    fs::write(d.join("dest/source"), b"old").unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let c = OperationContext::detached_with_decisions("replace", vec![ConflictDecision::Replace]);
    let r = e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    assert_eq!(fs::read(d.join("dest/source")).unwrap(), b"incoming");
    assert_eq!(e.recoveries().unwrap().len(), 1);
    let r = e.execute(
        &Work::Undo {
            undo_id: r.undo_id.unwrap(),
        },
        &OperationContext::detached("undo"),
    );
    assert!(r.undo_complete);
    assert_eq!(fs::read(d.join("dest/source")).unwrap(), b"old");
    assert!(e.recoveries().unwrap().is_empty());
}
#[test]
fn private_recovery_has_single_owner_and_survives_reopen() {
    let d = Scratch::new();
    let one = FileExecutor::new(d.join("app")).unwrap();
    assert!(FileExecutor::new(d.join("app")).is_err());
    drop(one);
    assert!(FileExecutor::new(d.join("app")).is_ok());
}
