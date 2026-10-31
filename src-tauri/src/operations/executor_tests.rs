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

#[test]
fn zip_combined_emits_one_effect_for_all_inputs_and_undo_preserves_sources() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("a"), b"A").unwrap();
    fs::write(d.join("b"), b"B").unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let mut r = request(OperationKind::Zip, &d.join("a"), &d.join("dest"));
    r.items.push(OperationItem {
        item_id: "second".into(),
        source: Some(display(&d.join("b"))),
        target_name: None,
        create_kind: None,
    });
    let c = OperationContext::detached("zip");
    let result = e.execute(&Work::Operation(r), &c);
    let outcomes = c.recorded_outcomes();
    assert_eq!(outcomes.len(), 2);
    assert!(outcomes
        .iter()
        .all(|o| o.status == OutcomeStatus::Succeeded));
    assert_eq!(outcomes.iter().filter(|o| o.effect_id.is_some()).count(), 1);
    let archive = outcomes[0].actual_destination.as_ref().unwrap();
    let listing = std::process::Command::new("unzip")
        .args(["-Z1", archive])
        .output()
        .unwrap();
    assert!(listing.status.success());
    assert_eq!(String::from_utf8(listing.stdout).unwrap(), "a\nb\n");
    assert!(
        e.execute(
            &Work::Undo {
                undo_id: result.undo_id.unwrap()
            },
            &OperationContext::detached("undo")
        )
        .undo_complete
    );
    assert!(d.join("a").exists());
    assert!(d.join("b").exists());
}
#[test]
fn exdev_fallback_publishes_then_reports_failed_source_cleanup_without_recopy() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"content").unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    let calls = Arc::new(AtomicU64::new(0));
    let calls2 = calls.clone();
    e.hook = Arc::new(move |point, _, _| {
        if point == Point::RenameTarget && calls2.fetch_add(1, Ordering::Relaxed) == 0 {
            return Err(io::Error::from_raw_os_error(libc::EXDEV));
        }
        if point == Point::BeforeSourceCleanup {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected source cleanup failure",
            ));
        }
        Ok(())
    });
    let c = OperationContext::detached("move");
    let result = e.execute(
        &Work::Operation(request(
            OperationKind::Move,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    let out = &c.recorded_outcomes()[0];
    assert_eq!(out.status, OutcomeStatus::Partial);
    assert_eq!(out.retry, RetryKind::FinishSourceCleanup);
    assert_eq!(fs::read(d.join("dest/source")).unwrap(), b"content");
    assert!(d.join("source").exists());
    assert!(
        !e.execute(
            &Work::Undo {
                undo_id: result.undo_id.clone().unwrap()
            },
            &OperationContext::detached("undo")
        )
        .undo_complete
    );
    e.hook = Arc::new(|_, _, _| Ok(()));
    let recovery = e
        .recoveries()
        .unwrap()
        .into_iter()
        .find(|r| r.actions.contains(&RecoveryAction::FinishSourceCleanup))
        .unwrap();
    let rc = OperationContext::detached("recover");
    e.execute(
        &Work::Recovery {
            recovery_id: recovery.recovery_id,
            action: RecoveryAction::FinishSourceCleanup,
        },
        &rc,
    );
    assert_eq!(rc.recorded_outcomes()[0].status, OutcomeStatus::Succeeded);
    assert!(!d.join("source").exists());
    assert!(
        e.execute(
            &Work::Undo {
                undo_id: result.undo_id.unwrap()
            },
            &OperationContext::detached("undo2")
        )
        .undo_complete
    );
    assert_eq!(fs::read(d.join("source")).unwrap(), b"content");
}
#[test]
fn cancel_during_copy_removes_unpublished_owned_stage() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), vec![7u8; 1024 * 1024]).unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    e.clone_files = false;
    e.hook = Arc::new(|point, _, c| {
        if point == Point::Chunk {
            c.request_cancel();
        }
        Ok(())
    });
    let c = OperationContext::detached("copy");
    let r = e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    assert!(r.undo_id.is_none());
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Cancelled);
    assert_eq!(fs::read_dir(d.join("dest")).unwrap().count(), 0);
    assert!(e.recoveries().unwrap().is_empty());
    assert!(d.join("source").exists());
}
#[test]
fn replacement_capture_failure_is_partial_and_restart_retains_original() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"incoming").unwrap();
    fs::write(d.join("dest/source"), b"original").unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    e.hook = Arc::new(|point, _, _| {
        if point == Point::AfterBackupCapture {
            return Err(io::Error::other("injected crash boundary"));
        }
        Ok(())
    });
    let c = OperationContext::detached_with_decisions("replace", vec![ConflictDecision::Replace]);
    e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Partial);
    drop(e);
    let e = FileExecutor::new(d.join("app")).unwrap();
    let records = e.recoveries().unwrap();
    assert_eq!(records.len(), 1);
    let c = OperationContext::detached("recovery");
    e.execute(
        &Work::Recovery {
            recovery_id: records[0].recovery_id.clone(),
            action: RecoveryAction::RestoreBackup,
        },
        &c,
    );
    assert_eq!(fs::read(d.join("dest/source")).unwrap(), b"original");
    assert!(e.recoveries().unwrap().is_empty());
}
#[test]
fn authorized_rename_inverse_refreshes_prior_copy_guard_but_edits_still_block() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"content").unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let copy = e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &OperationContext::detached("copy"),
    );
    let mut rename = request(
        OperationKind::Rename,
        &d.join("dest/source"),
        &d.join("dest"),
    );
    rename.items[0].target_name = Some("renamed".into());
    let moved = e.execute(
        &Work::Operation(rename),
        &OperationContext::detached("rename"),
    );
    assert!(
        e.execute(
            &Work::Undo {
                undo_id: moved.undo_id.unwrap()
            },
            &OperationContext::detached("undo-rename")
        )
        .undo_complete
    );
    assert!(
        e.execute(
            &Work::Undo {
                undo_id: copy.undo_id.unwrap()
            },
            &OperationContext::detached("undo-copy")
        )
        .undo_complete
    );
    assert!(!d.join("dest/source").exists());
}

#[test]
fn publication_racer_after_backup_capture_is_preserved_and_reported_partial() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"incoming").unwrap();
    fs::write(d.join("dest/source"), b"original").unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    let target = d.join("dest/source");
    e.hook = Arc::new(move |p, _, _| {
        if p == Point::AfterBackupCapture {
            fs::write(&target, b"racer")?;
        }
        Ok(())
    });
    let c = OperationContext::detached_with_decisions("replace", vec![ConflictDecision::Replace]);
    let r = e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Partial);
    assert_eq!(fs::read(d.join("dest/source")).unwrap(), b"racer");
    assert!(r.undo_id.is_some());
    let record = e.journal.records().pop().unwrap();
    assert_eq!(fs::read(&record.protected[0].path).unwrap(), b"original");
    assert!(
        !e.execute(
            &Work::Undo {
                undo_id: r.undo_id.unwrap()
            },
            &OperationContext::detached("undo")
        )
        .undo_complete
    );
    assert_eq!(fs::read(d.join("dest/source")).unwrap(), b"racer");
}
#[test]
fn metadata_failure_and_final_checkpoint_cancel_leave_source_and_no_published_target() {
    for boundary in [Point::Metadata, Point::BeforePublish] {
        let d = Scratch::new();
        fs::create_dir(d.join("dest")).unwrap();
        fs::write(d.join("source"), b"content").unwrap();
        let mut e = FileExecutor::new(d.join("app")).unwrap();
        e.hook = Arc::new(move |p, _, c| {
            if p == boundary {
                if p == Point::Metadata {
                    return Err(io::Error::other("metadata failed"));
                }
                c.request_cancel();
            }
            Ok(())
        });
        let c = OperationContext::detached("copy");
        e.execute(
            &Work::Operation(request(
                OperationKind::Copy,
                &d.join("source"),
                &d.join("dest"),
            )),
            &c,
        );
        assert!(!d.join("dest/source").exists());
        assert_eq!(fs::read(d.join("source")).unwrap(), b"content");
        assert_eq!(fs::read_dir(d.join("dest")).unwrap().count(), 0);
        assert!(e.recoveries().unwrap().is_empty());
    }
}
#[test]
fn non_exdev_rename_error_never_copies_and_exact_source_is_restored() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"content").unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    e.hook = Arc::new(|p, _, _| {
        assert_ne!(p, Point::Chunk);
        if p == Point::RenameTarget {
            return Err(io::Error::from_raw_os_error(libc::EACCES));
        }
        Ok(())
    });
    let c = OperationContext::detached("move");
    e.execute(
        &Work::Operation(request(
            OperationKind::Move,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Failed);
    assert_eq!(fs::read(d.join("source")).unwrap(), b"content");
    assert!(!d.join("dest/source").exists());
    assert!(e.recoveries().unwrap().is_empty());
}
#[test]
fn dangling_link_conflicts_and_alias_subtree_are_never_overwritten() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"content").unwrap();
    std::os::unix::fs::symlink("missing", d.join("dest/source")).unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let c = OperationContext::detached("copy");
    e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Skipped);
    assert_eq!(
        fs::read_link(d.join("dest/source")).unwrap(),
        PathBuf::from("missing")
    );
    let c = OperationContext::detached_with_decisions("copy2", vec![ConflictDecision::KeepBoth]);
    e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
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
    fs::create_dir(d.join("directory")).unwrap();
    fs::create_dir(d.join("directory/child")).unwrap();
    std::os::unix::fs::symlink(d.join("directory/child"), d.join("alias")).unwrap();
    let c = OperationContext::detached("alias");
    e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("directory"),
            &d.join("alias"),
        )),
        &c,
    );
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Failed);
    assert_eq!(fs::read_dir(d.join("directory/child")).unwrap().count(), 0);
}
#[test]
fn partial_undo_retries_only_failed_effect_and_preserves_missing_parent() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::create_dir(d.join("src")).unwrap();
    fs::write(d.join("src/a"), b"A").unwrap();
    fs::write(d.join("src/b"), b"B").unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let mut r = request(OperationKind::Move, &d.join("src/a"), &d.join("dest"));
    r.items.push(OperationItem {
        item_id: "b".into(),
        source: Some(display(&d.join("src/b"))),
        target_name: None,
        create_kind: None,
    });
    let r = e.execute(&Work::Operation(r), &OperationContext::detached("move"));
    fs::write(d.join("src/a"), b"occupant").unwrap();
    let c = OperationContext::detached("undo");
    assert!(
        !e.execute(
            &Work::Undo {
                undo_id: r.undo_id.clone().unwrap()
            },
            &c
        )
        .undo_complete
    );
    assert_eq!(fs::read(d.join("src/b")).unwrap(), b"B");
    assert!(d.join("dest/a").exists());
    fs::remove_file(d.join("src/a")).unwrap();
    fs::remove_file(d.join("src/b")).unwrap();
    fs::remove_dir(d.join("src")).unwrap();
    assert!(
        !e.execute(
            &Work::Undo {
                undo_id: r.undo_id.clone().unwrap()
            },
            &OperationContext::detached("retry-missing")
        )
        .undo_complete
    );
    assert!(!d.join("src").exists());
    fs::create_dir(d.join("src")).unwrap();
    let c = OperationContext::detached("retry");
    assert!(
        e.execute(
            &Work::Undo {
                undo_id: r.undo_id.unwrap()
            },
            &c
        )
        .undo_complete
    );
    assert_eq!(c.recorded_outcomes().len(), 1);
    assert_eq!(fs::read(d.join("src/a")).unwrap(), b"A");
    assert!(!d.join("src/b").exists());
}
#[test]
fn copy_retains_readonly_directory_mode_and_dangling_symlink() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::create_dir(d.join("source")).unwrap();
    fs::write(d.join("source/a"), b"A").unwrap();
    std::os::unix::fs::symlink("absent", d.join("source/link")).unwrap();
    fs::set_permissions(d.join("source"), fs::Permissions::from_mode(0o500)).unwrap();
    let source_time = fs::metadata(d.join("source")).unwrap().mtime_nsec();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let c = OperationContext::detached("copy");
    e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    assert_eq!(
        c.recorded_outcomes()[0].status,
        OutcomeStatus::Succeeded,
        "{:?}",
        c.recorded_outcomes()
    );
    assert_eq!(
        fs::metadata(d.join("dest/source"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o500
    );
    assert_eq!(
        fs::metadata(d.join("dest/source")).unwrap().mtime_nsec(),
        source_time
    );
    assert_eq!(
        fs::read_link(d.join("dest/source/link")).unwrap(),
        PathBuf::from("absent")
    );
}

#[test]
fn archive_cancel_reaps_the_exact_child_and_leaves_no_archive() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), vec![8u8; 1024 * 1024 * 8]).unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    e.hook = Arc::new(|point, _, c| {
        if point == Point::ArchiveSpawned {
            c.request_cancel();
        }
        Ok(())
    });
    let c = OperationContext::detached("zip");
    e.execute(
        &Work::Operation(request(
            OperationKind::Zip,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Cancelled);
    assert_eq!(fs::read_dir(d.join("dest")).unwrap().count(), 0);
    let ids = e.child_ids.lock().unwrap();
    assert_eq!(ids.len(), 1);
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(ids[0] as i32, &mut status, libc::WNOHANG) },
        -1
    );
    assert_eq!(
        io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
}
#[test]
fn separate_archive_partial_and_password_never_enters_journal() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"data").unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let mut r = request(OperationKind::Zip, &d.join("source"), &d.join("dest"));
    r.options.separate = true;
    r.options.password = Some("private-password-123".into());
    r.items.push(OperationItem {
        item_id: "missing".into(),
        source: Some(display(&d.join("missing"))),
        target_name: None,
        create_kind: None,
    });
    let c = OperationContext::detached("zip");
    let result = e.execute(&Work::Operation(r), &c);
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Succeeded);
    assert_eq!(c.recorded_outcomes()[1].status, OutcomeStatus::Failed);
    assert!(result.undo_id.is_some());
    assert!(!serde_json::to_string(&c.recorded_outcomes())
        .unwrap()
        .contains("private-password-123"));
    for file in fs::read_dir(d.join("app/operations-recovery")).unwrap() {
        let file = file.unwrap();
        if file.path().extension().is_some_and(|e| e == "json") {
            assert!(!fs::read_to_string(file.path())
                .unwrap()
                .contains("private-password-123"));
        }
    }
}
#[test]
fn source_change_after_publication_prevents_source_cleanup() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"original").unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    let source = d.join("source");
    e.hook = Arc::new(move |p, _, _| {
        if p == Point::RenameTarget {
            return Err(io::Error::from_raw_os_error(libc::EXDEV));
        }
        if p == Point::BeforeSourceCleanup {
            fs::write(&source, b"new data")?;
        }
        Ok(())
    });
    let c = OperationContext::detached("move");
    e.execute(
        &Work::Operation(request(
            OperationKind::Move,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Partial);
    assert_eq!(fs::read(d.join("source")).unwrap(), b"new data");
    assert_eq!(fs::read(d.join("dest/source")).unwrap(), b"original");
}
#[test]
fn source_cleanup_partial_tree_is_retryable_without_recopying_destination() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::create_dir(d.join("source")).unwrap();
    fs::write(d.join("source/a"), b"A").unwrap();
    fs::write(d.join("source/b"), b"B").unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    e.hook = Arc::new(|p, path, _| {
        if p == Point::RenameTarget {
            return Err(io::Error::from_raw_os_error(libc::EXDEV));
        }
        if p == Point::CapturedSource {
            fs::remove_file(path.join("a"))?;
            return Err(io::Error::other("partial deletion"));
        }
        Ok(())
    });
    let c = OperationContext::detached("move");
    e.execute(
        &Work::Operation(request(
            OperationKind::Move,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Partial);
    let target_id = identity::Identity::read(&d.join("dest/source")).unwrap();
    e.hook = Arc::new(|_, _, _| Ok(()));
    let record = e
        .recoveries()
        .unwrap()
        .into_iter()
        .find(|r| r.actions.contains(&RecoveryAction::FinishSourceCleanup))
        .unwrap();
    let c = OperationContext::detached("recover");
    e.execute(
        &Work::Recovery {
            recovery_id: record.recovery_id,
            action: RecoveryAction::FinishSourceCleanup,
        },
        &c,
    );
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Succeeded);
    assert!(target_id.matches(&d.join("dest/source")));
    assert_eq!(fs::read(d.join("dest/source/a")).unwrap(), b"A");
    assert_eq!(fs::read(d.join("dest/source/b")).unwrap(), b"B");
    assert!(e.recoveries().unwrap().is_empty());
}
#[test]
fn journal_failure_before_mutation_and_after_publication_are_truthful() {
    for fail_call in [0, 2] {
        let d = Scratch::new();
        fs::create_dir(d.join("dest")).unwrap();
        fs::write(d.join("source"), b"data").unwrap();
        let mut e = FileExecutor::new(d.join("app")).unwrap();
        let calls = Arc::new(AtomicU64::new(0));
        e.hook = Arc::new(move |p, _, _| {
            if p == Point::Journal && calls.fetch_add(1, Ordering::Relaxed) == fail_call {
                return Err(io::Error::other("journal failure"));
            }
            Ok(())
        });
        let c = OperationContext::detached("copy");
        let r = e.execute(
            &Work::Operation(request(
                OperationKind::Copy,
                &d.join("source"),
                &d.join("dest"),
            )),
            &c,
        );
        if fail_call == 0 {
            assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Failed);
            assert!(!d.join("dest/source").exists());
            assert!(r.undo_id.is_none());
        } else {
            assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Partial);
            assert_eq!(fs::read(d.join("dest/source")).unwrap(), b"data");
            assert!(r.undo_id.is_some());
        }
        assert_eq!(fs::read(d.join("source")).unwrap(), b"data");
    }
}
#[test]
fn restart_restore_backup_trashes_only_verified_incoming_and_protects_racer() {
    for racer in [false, true] {
        let d = Scratch::new();
        fs::create_dir(d.join("dest")).unwrap();
        fs::write(d.join("source"), b"incoming").unwrap();
        fs::write(d.join("dest/source"), b"original").unwrap();
        let e = FileExecutor::new(d.join("app")).unwrap();
        let c =
            OperationContext::detached_with_decisions("replace", vec![ConflictDecision::Replace]);
        e.execute(
            &Work::Operation(request(
                OperationKind::Copy,
                &d.join("source"),
                &d.join("dest"),
            )),
            &c,
        );
        drop(e);
        if racer {
            fs::write(d.join("dest/source"), b"user changed").unwrap();
        }
        let e = FileExecutor::new(d.join("app")).unwrap();
        let recovery = e.recoveries().unwrap()[0].clone();
        let c = OperationContext::detached("restore");
        e.execute(
            &Work::Recovery {
                recovery_id: recovery.recovery_id,
                action: RecoveryAction::RestoreBackup,
            },
            &c,
        );
        if racer {
            assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Failed);
            assert_eq!(fs::read(d.join("dest/source")).unwrap(), b"user changed");
            assert_eq!(e.recoveries().unwrap().len(), 1);
        } else {
            assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Succeeded);
            assert_eq!(fs::read(d.join("dest/source")).unwrap(), b"original");
            assert!(e.recoveries().unwrap().is_empty());
            assert_eq!(fs::read(d.join("app/Trash/source")).unwrap(), b"incoming");
        }
    }
}
#[test]
fn recovery_save_failure_after_restore_reports_real_partial_effect() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"incoming").unwrap();
    fs::write(d.join("dest/source"), b"original").unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    e.hook = Arc::new(|p, _, _| {
        if p == Point::AfterBackupCapture {
            Err(io::Error::other("stop after backup"))
        } else {
            Ok(())
        }
    });
    e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &OperationContext::detached_with_decisions("copy", vec![ConflictDecision::Replace]),
    );
    let recovery = e.recoveries().unwrap()[0].clone();
    let calls = Arc::new(AtomicU64::new(0));
    e.hook = Arc::new(move |p, _, _| {
        if p == Point::Journal && calls.fetch_add(1, Ordering::Relaxed) == 1 {
            return Err(io::Error::other("post-restore journal failure"));
        }
        Ok(())
    });
    let c = OperationContext::detached("recover");
    e.execute(
        &Work::Recovery {
            recovery_id: recovery.recovery_id,
            action: RecoveryAction::RestoreBackup,
        },
        &c,
    );
    assert_eq!(fs::read(d.join("dest/source")).unwrap(), b"original");
    let out = &c.recorded_outcomes()[0];
    assert_eq!(out.status, OutcomeStatus::Partial);
    assert!(out.published);
    assert!(out.effect_id.is_some());
    assert!(out.affected_directories.contains(&display(&d.join("dest"))));
}
#[test]
fn cross_volume_inverse_partial_cleanup_retries_without_second_inverse_copy() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"content").unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    let result = e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &OperationContext::detached("copy"),
    );
    e.hook = Arc::new(|p, _, _| {
        if p == Point::UndoRename {
            return Err(io::Error::from_raw_os_error(libc::EXDEV));
        }
        if p == Point::UndoSourceCleanup {
            return Err(io::Error::other("inverse cleanup blocked"));
        }
        Ok(())
    });
    let c = OperationContext::detached("undo");
    assert!(
        !e.execute(
            &Work::Undo {
                undo_id: result.undo_id.clone().unwrap()
            },
            &c
        )
        .undo_complete
    );
    let first = c.recorded_outcomes();
    assert_eq!(first[0].status, OutcomeStatus::Partial);
    assert!(first[0].published);
    let target = PathBuf::from(first[0].actual_destination.as_ref().unwrap());
    assert_eq!(fs::read(&target).unwrap(), b"content");
    let identity = identity::Identity::read(&target).unwrap();
    e.hook = Arc::new(|_, _, _| Ok(()));
    let c = OperationContext::detached("retry");
    assert!(
        e.execute(
            &Work::Undo {
                undo_id: result.undo_id.unwrap()
            },
            &c
        )
        .undo_complete
    );
    assert!(identity.matches(&target));
    assert_eq!(fs::read_dir(d.join("app/Trash")).unwrap().count(), 1);
    assert!(!d.join("dest/source").exists());
    assert!(e.recoveries().unwrap().is_empty());
}
#[cfg(target_os = "macos")]
#[test]
fn readonly_root_with_deny_write_acl_is_preserved_after_publication() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::create_dir(d.join("source")).unwrap();
    fs::write(d.join("source/a"), b"content").unwrap();
    fs::set_permissions(d.join("source"), fs::Permissions::from_mode(0o500)).unwrap();
    assert!(std::process::Command::new("/bin/chmod")
        .args(["+a", "everyone deny add_file,add_subdirectory,delete_child"])
        .arg(d.join("source"))
        .status()
        .unwrap()
        .success());
    let before = Manifest::capture(&d.join("source"), &|| Ok(())).unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let c = OperationContext::detached("copy");
    e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    let outcomes = c.recorded_outcomes();
    let succeeded = outcomes[0].status == OutcomeStatus::Succeeded;
    if succeeded {
        assert!(
            before.same_contents(&Manifest::capture(&d.join("dest/source"), &|| Ok(())).unwrap())
        );
    }
    assert!(before.matches(&d.join("source")));
    assert_eq!(fs::read(d.join("source/a")).unwrap(), b"content");
    assert!(std::process::Command::new("/bin/chmod")
        .arg("-RN")
        .arg(&d.0)
        .status()
        .unwrap()
        .success());
    assert!(succeeded, "{outcomes:?}");
}
#[cfg(target_os = "macos")]
#[test]
fn cancelled_acl_directory_copy_cleans_only_the_owned_private_tree() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::create_dir(d.join("source")).unwrap();
    fs::write(d.join("source/a"), b"source").unwrap();
    assert!(std::process::Command::new("/bin/chmod")
        .args(["+a", "everyone deny delete_child"])
        .arg(d.join("source"))
        .status()
        .unwrap()
        .success());
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    e.hook = Arc::new(|point, path, c| {
        if point == Point::Metadata && path.file_name().is_some_and(|n| n == "incoming") {
            c.request_cancel();
        }
        Ok(())
    });
    let c = OperationContext::detached("cancel");
    e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    let count = fs::read_dir(d.join("dest")).unwrap().count();
    assert_eq!(fs::read(d.join("source/a")).unwrap(), b"source");
    assert!(std::process::Command::new("/bin/chmod")
        .arg("-RN")
        .arg(&d.0)
        .status()
        .unwrap()
        .success());
    assert_eq!(count, 0);
    assert!(e.recoveries().unwrap().is_empty());
}
#[test]
fn failed_move_restores_prior_guard_so_copy_can_still_be_undone() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::create_dir(d.join("other")).unwrap();
    fs::write(d.join("source"), b"content").unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    let copy = e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &OperationContext::detached("copy"),
    );
    e.hook = Arc::new(|p, _, _| {
        if p == Point::RenameTarget {
            Err(io::Error::from_raw_os_error(libc::EACCES))
        } else {
            Ok(())
        }
    });
    e.execute(
        &Work::Operation(request(
            OperationKind::Move,
            &d.join("dest/source"),
            &d.join("other"),
        )),
        &OperationContext::detached("move"),
    );
    e.hook = Arc::new(|_, _, _| Ok(()));
    assert!(
        e.execute(
            &Work::Undo {
                undo_id: copy.undo_id.unwrap()
            },
            &OperationContext::detached("undo")
        )
        .undo_complete
    );
}
#[test]
fn failure_after_source_removed_reports_removed_and_keeps_normal_move_undo() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"data").unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    e.hook = Arc::new(|p, _, _| {
        if p == Point::RenameTarget {
            return Err(io::Error::from_raw_os_error(libc::EXDEV));
        }
        if p == Point::AfterSourceRemoved {
            return Err(io::Error::other("receipt failed after removal"));
        }
        Ok(())
    });
    let c = OperationContext::detached("move");
    let r = e.execute(
        &Work::Operation(request(
            OperationKind::Move,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    let out = &c.recorded_outcomes()[0];
    assert_eq!(out.status, OutcomeStatus::Partial);
    assert_eq!(out.source_disposition, SourceDisposition::Removed);
    assert!(!d.join("source").exists());
    e.hook = Arc::new(|_, _, _| Ok(()));
    assert!(
        e.execute(
            &Work::Undo {
                undo_id: r.undo_id.unwrap()
            },
            &OperationContext::detached("undo")
        )
        .undo_complete
    );
    assert_eq!(fs::read(d.join("source")).unwrap(), b"data");
}
#[test]
fn restart_reconciles_publication_before_journal_without_automatic_source_deletion() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"content").unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let root = OwnedRoot::create(&d.join("dest")).unwrap();
    let incoming = root.path.join("incoming");
    crate::copy_for_move(&d.join("source"), &incoming).unwrap();
    let mut record = Record::new(Some(d.join("source")), d.join("dest/source"));
    record.move_intent = true;
    record.roots.push(root);
    record.incoming = Some(incoming.clone());
    record.incoming_manifest = Some(Manifest::capture(&incoming, &|| Ok(())).unwrap());
    record.source_manifest = Some(Manifest::capture(&d.join("source"), &|| Ok(())).unwrap());
    e.journal.save(&record).unwrap();
    crate::rename_no_replace(&incoming, &record.destination).unwrap();
    drop(e);
    let e = FileExecutor::new(d.join("app")).unwrap();
    assert!(d.join("source").exists());
    let records = e.recoveries().unwrap();
    assert!(records[0]
        .actions
        .contains(&RecoveryAction::FinishSourceCleanup));
    let c = OperationContext::detached("recover");
    e.execute(
        &Work::Recovery {
            recovery_id: records[0].recovery_id.clone(),
            action: RecoveryAction::FinishSourceCleanup,
        },
        &c,
    );
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Succeeded);
    assert!(!d.join("source").exists());
    assert_eq!(fs::read(d.join("dest/source")).unwrap(), b"content");
}
#[test]
fn restart_reconciles_same_volume_rename_before_journal_and_can_restore_exact_name() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"content").unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let original = Manifest::capture(&d.join("source"), &|| Ok(())).unwrap();
    let root = OwnedRoot::create(&d.0).unwrap();
    let held = root.path.join("source");
    let mut record = Record::new(Some(d.join("source")), d.join("dest/source"));
    record.move_intent = true;
    record.source_manifest = Some(original.clone());
    record.roots.push(root);
    record.protected.push(Protected {
        path: held.clone(),
        original: d.join("source"),
        manifest: original,
    });
    e.journal.save(&record).unwrap();
    crate::rename_no_replace(&d.join("source"), &held).unwrap();
    crate::rename_no_replace(&held, &record.destination).unwrap();
    drop(e);
    let e = FileExecutor::new(d.join("app")).unwrap();
    let c = OperationContext::detached("restore");
    e.execute(
        &Work::Recovery {
            recovery_id: record.id,
            action: RecoveryAction::RestoreBackup,
        },
        &c,
    );
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Succeeded);
    assert_eq!(fs::read(d.join("source")).unwrap(), b"content");
    assert!(!d.join("dest/source").exists());
    assert!(e.recoveries().unwrap().is_empty());
}
#[test]
fn cleanup_never_deletes_a_replaced_staging_root() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"content").unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    let stolen = d.join("stolen-owned-root");
    e.hook = Arc::new(move |p, path, _| {
        if p == Point::Metadata {
            let root = path.parent().unwrap();
            fs::rename(root, &stolen)?;
            fs::create_dir(root)?;
            fs::write(root.join("user-data"), b"keep me")?;
            return Err(io::Error::other("root replaced"));
        }
        Ok(())
    });
    let c = OperationContext::detached("copy");
    e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    let root = fs::read_dir(d.join("dest"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(fs::read(root.join("user-data")).unwrap(), b"keep me");
    assert!(!bento_fswatch::is_internal(&root));
    assert_eq!(e.recoveries().unwrap().len(), 1);
}
#[test]
fn create_template_rename_and_partial_trash_keep_unicode_spaces_and_exact_undo() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::create_dir_all(d.join("app/templates")).unwrap();
    fs::write(d.join("app/templates/ 模板 .txt "), b"template bytes").unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let mut r = request(
        OperationKind::Create,
        &d.join("app/templates/ 模板 .txt "),
        &d.join("dest"),
    );
    r.items[0].create_kind = Some(CreateKind::Template);
    let c = OperationContext::detached("template");
    e.execute(&Work::Operation(r), &c);
    assert_eq!(
        fs::read(d.join("dest/ 模板 .txt ")).unwrap(),
        b"template bytes"
    );
    let mut r = request(
        OperationKind::Rename,
        &d.join("dest/ 模板 .txt "),
        &d.join("dest"),
    );
    r.items[0].target_name = Some(" 重命名 .txt ".into());
    let c = OperationContext::detached("rename");
    e.execute(&Work::Operation(r), &c);
    assert_eq!(
        fs::read(d.join("dest/ 重命名 .txt ")).unwrap(),
        b"template bytes"
    );
    let mut r = request(
        OperationKind::Trash,
        &d.join("dest/ 重命名 .txt "),
        &d.join("dest"),
    );
    r.items.push(OperationItem {
        item_id: "missing".into(),
        source: Some(display(&d.join("missing"))),
        target_name: None,
        create_kind: None,
    });
    let c = OperationContext::detached("trash");
    let result = e.execute(&Work::Operation(r), &c);
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Succeeded);
    assert_eq!(c.recorded_outcomes()[1].status, OutcomeStatus::Failed);
    assert!(
        e.execute(
            &Work::Undo {
                undo_id: result.undo_id.unwrap()
            },
            &OperationContext::detached("undo-trash")
        )
        .undo_complete
    );
    assert_eq!(
        fs::read(d.join("dest/ 重命名 .txt ")).unwrap(),
        b"template bytes"
    );
    let mut r = request(OperationKind::Create, &d.join("unused"), &d.join("dest"));
    r.items[0].source = None;
    r.items[0].create_kind = Some(CreateKind::Directory);
    r.items[0].target_name = Some(" 新目录 ".into());
    let c = OperationContext::detached("directory");
    e.execute(&Work::Operation(r), &c);
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Succeeded);
    assert!(d.join("dest/ 新目录 ").is_dir());
}
#[test]
fn deep_directory_copy_uses_bounded_worker_stack() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    let relative = (0..32).fold(PathBuf::new(), |p, _| p.join("nested"));
    fs::create_dir_all(d.join("source").join(&relative)).unwrap();
    fs::write(
        d.join("source").join(&relative).join("file"),
        b"deep contents",
    )
    .unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    e.clone_files = false;
    let c = OperationContext::detached("deep");
    e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("source"),
            &d.join("dest"),
        )),
        &c,
    );
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Succeeded);
    assert_eq!(
        fs::read(d.join("dest/source").join(relative).join("file")).unwrap(),
        b"deep contents"
    );
}
