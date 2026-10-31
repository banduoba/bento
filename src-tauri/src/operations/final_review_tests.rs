//! Regression fixtures for the final M6 privacy, creation and retention review.
use super::*;
use crate::operations::queue::OperationManager;

fn replacement(d: &Scratch) -> (FileExecutor, String, PathBuf) {
    for name in ["incoming", "folder", "export"] {
        fs::create_dir(d.join(name)).unwrap();
    }
    fs::write(d.join("incoming/file"), b"public replacement").unwrap();
    fs::write(d.join("folder/file"), b"private original").unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    let r = e.execute(
        &Work::Operation(request(
            OperationKind::Copy,
            &d.join("incoming/file"),
            &d.join("folder"),
        )),
        &OperationContext::detached_with_decisions("replace", vec![ConflictDecision::Replace]),
    );
    assert!(r.undo_id.is_some());
    let record = e.journal.records().pop().unwrap();
    (e, record.id, record.protected[0].path.clone())
}

#[test]
fn finalreview_parent_exports_reject_private_roots_and_preserve_restart_restore() {
    for kind in [OperationKind::Copy, OperationKind::Zip] {
        let d = Scratch::new();
        let (e, recovery, backup) = replacement(&d);
        let c = OperationContext::detached("export");
        let r = e.execute(
            &Work::Operation(request(kind, &d.join("folder"), &d.join("export"))),
            &c,
        );
        assert_eq!(
            c.recorded_outcomes()[0].status,
            OutcomeStatus::Failed,
            "{kind:?}"
        );
        assert!(r.undo_id.is_none());
        assert_eq!(fs::read_dir(d.join("export")).unwrap().count(), 0);
        assert_eq!(fs::read(&backup).unwrap(), b"private original");
        drop(e);
        let e = FileExecutor::new(d.join("app")).unwrap();
        let c = OperationContext::detached("restore");
        e.execute(
            &Work::Recovery {
                recovery_id: recovery,
                action: RecoveryAction::RestoreBackup,
            },
            &c,
        );
        assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Succeeded);
        assert_eq!(
            fs::read(d.join("folder/file")).unwrap(),
            b"private original"
        );
    }
}

#[test]
fn finalreview_parent_mutations_reject_private_roots_before_source_capture() {
    for kind in [
        OperationKind::Rename,
        OperationKind::Move,
        OperationKind::Trash,
    ] {
        let d = Scratch::new();
        let (mut e, recovery, backup) = replacement(&d);
        // If a move reaches its EXDEV/capture path, fail rather than touching another volume.
        e.hook = Arc::new(|point, _, _| {
            assert_ne!(
                point,
                Point::RenameTarget,
                "private ancestor reached rename/EXDEV"
            );
            Ok(())
        });
        let mut r = request(kind, &d.join("folder"), &d.join("export"));
        r.items[0].target_name = Some("renamed".into());
        let c = OperationContext::detached("mutate");
        e.execute(&Work::Operation(r), &c);
        assert_eq!(
            c.recorded_outcomes()[0].status,
            OutcomeStatus::Failed,
            "{kind:?}"
        );
        assert!(!c.recorded_outcomes()[0].published);
        assert_eq!(fs::read(&backup).unwrap(), b"private original");
        assert_eq!(
            fs::read(d.join("folder/file")).unwrap(),
            b"public replacement"
        );
        drop(e);
        let e = FileExecutor::new(d.join("app")).unwrap();
        let c = OperationContext::detached("restore");
        e.execute(
            &Work::Recovery {
                recovery_id: recovery,
                action: RecoveryAction::RestoreBackup,
            },
            &c,
        );
        assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Succeeded);
        assert_eq!(
            fs::read(d.join("folder/file")).unwrap(),
            b"private original"
        );
    }
}

#[test]
fn finalreview_same_prefix_user_data_still_exports_and_moves() {
    for kind in [
        OperationKind::Copy,
        OperationKind::Zip,
        OperationKind::Rename,
        OperationKind::Move,
        OperationKind::Trash,
    ] {
        let d = Scratch::new();
        fs::create_dir_all(d.join("folder/.bento-operation-user")).unwrap();
        fs::create_dir(d.join("export")).unwrap();
        fs::write(
            d.join("folder/.bento-operation-user/original"),
            b"ordinary user data",
        )
        .unwrap();
        let e = FileExecutor::new(d.join("app")).unwrap();
        let mut r = request(kind, &d.join("folder"), &d.join("export"));
        if kind == OperationKind::Rename {
            r.items[0].target_name = Some("renamed".into());
        }
        let c = OperationContext::detached("ordinary");
        e.execute(&Work::Operation(r), &c);
        let out = &c.recorded_outcomes()[0];
        assert_eq!(
            out.status,
            OutcomeStatus::Succeeded,
            "{kind:?}: {:?}",
            out.error
        );
        let actual = PathBuf::from(out.actual_destination.as_ref().unwrap());
        if kind == OperationKind::Zip {
            let content = std::process::Command::new("unzip")
                .arg("-p")
                .arg(&actual)
                .arg("folder/.bento-operation-user/original")
                .output()
                .unwrap();
            assert!(content.status.success());
            assert_eq!(content.stdout, b"ordinary user data");
        } else {
            assert_eq!(
                fs::read(actual.join(".bento-operation-user/original")).unwrap(),
                b"ordinary user data"
            );
        }
    }
}

#[test]
fn finalreview_multi_parent_zip_does_not_dereference_links_into_private_ancestors() {
    let d = Scratch::new();
    let (e, _, backup) = replacement(&d);
    fs::create_dir(d.join("elsewhere")).unwrap();
    std::os::unix::fs::symlink(d.join("folder"), d.join("elsewhere/alias")).unwrap();
    let mut r = request(
        OperationKind::Zip,
        &d.join("incoming/file"),
        &d.join("export"),
    );
    r.items.push(OperationItem {
        item_id: "link".into(),
        source: Some(display(&d.join("elsewhere/alias"))),
        target_name: None,
        create_kind: None,
    });
    r.options.archive_name = Some("mixed.zip".into());
    let c = OperationContext::detached("mixed");
    e.execute(&Work::Operation(r), &c);
    if c.recorded_outcomes()[0].status == OutcomeStatus::Succeeded {
        let listing = std::process::Command::new("unzip")
            .arg("-Z1")
            .arg(d.join("export/mixed.zip"))
            .output()
            .unwrap();
        assert!(listing.status.success());
        let names = String::from_utf8(listing.stdout).unwrap();
        assert!(
            !names.contains("original"),
            "private original leaked: {names}"
        );
        assert!(names.lines().any(|name| name == "alias"));
    } else {
        assert!(!d.join("export/mixed.zip").exists());
    }
    assert_eq!(fs::read(backup).unwrap(), b"private original");
}

#[cfg(target_os = "macos")]
fn creation_matches_native_sibling(kind: CreateKind, deny_parent_cleanup: bool) {
    use std::os::unix::fs::PermissionsExt;
    let d = Scratch::new();
    fs::create_dir(d.join("shared")).unwrap();
    // Compare the actual destination's native group/SGID policy as well as ACLs.
    // Choose another supplementary group when the current user can assign one.
    use std::os::unix::{fs::MetadataExt, io::AsRawFd};
    let shared = fs::File::open(d.join("shared")).unwrap();
    let mut groups = [0 as libc::gid_t; 128];
    let count = unsafe { libc::getgroups(groups.len() as libc::c_int, groups.as_mut_ptr()) };
    let original_gid = shared.metadata().unwrap().gid();
    if count > 0 {
        for gid in &groups[..count as usize] {
            if *gid != original_gid && unsafe { libc::fchown(shared.as_raw_fd(), !0, *gid) } == 0 {
                break;
            }
        }
    }
    fs::set_permissions(d.join("shared"), fs::Permissions::from_mode(0o2775)).unwrap();
    for acl in [
        "everyone allow read,readattr,readextattr,readsecurity,file_inherit,directory_inherit",
        "everyone deny writeextattr,file_inherit,directory_inherit,only_inherit",
        "everyone deny delete,file_inherit,directory_inherit,only_inherit",
        "everyone allow execute,directory_inherit,limit_inherit,only_inherit",
    ] {
        assert!(std::process::Command::new("/bin/chmod")
            .args(["+a", acl])
            .arg(d.join("shared"))
            .status()
            .unwrap()
            .success());
    }
    if deny_parent_cleanup {
        assert!(std::process::Command::new("/bin/chmod")
            .args(["+a", "everyone deny delete_child,directory_inherit"])
            .arg(d.join("shared"))
            .status()
            .unwrap()
            .success());
    }
    let acl = |path: &Path| {
        let result = std::process::Command::new("/bin/ls")
            .arg("-lde")
            .arg(path)
            .output()
            .unwrap();
        assert!(result.status.success());
        String::from_utf8(result.stdout)
            .unwrap()
            .lines()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
    };
    let parent_acl_before = acl(&d.join("shared"));
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    fs::create_dir(d.join("app/templates")).unwrap();
    fs::write(d.join("app/templates/template.txt"), b"template bytes").unwrap();
    fs::set_permissions(
        d.join("app/templates/template.txt"),
        fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    let reference = d.join("shared/reference");
    if kind == CreateKind::Directory {
        fs::create_dir(&reference).unwrap();
    } else if kind == CreateKind::Template {
        crate::copy_exclusive(&d.join("app/templates/template.txt"), &reference).unwrap();
    } else {
        crate::create_empty_exclusive(&reference).unwrap();
    }
    e.hook = Arc::new(|point, incoming, _| {
        if point == Point::PreparedVerify {
            let root = incoming
                .ancestors()
                .find(|p| {
                    p.file_name()
                        .is_some_and(|n| n.to_string_lossy().starts_with(".bento-operation-"))
                })
                .unwrap();
            assert_eq!(
                fs::metadata(root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            let listing = std::process::Command::new("/bin/ls")
                .arg("-lde")
                .arg(root)
                .output()
                .unwrap();
            assert_eq!(
                String::from_utf8(listing.stdout).unwrap().lines().count(),
                1,
                "outer staging gained an ACL"
            );
        }
        Ok(())
    });
    let mut r = request(
        OperationKind::Create,
        &d.join("app/templates/template.txt"),
        &d.join("shared"),
    );
    r.items[0].create_kind = Some(kind);
    r.items[0].target_name = Some("queued".into());
    if kind != CreateKind::Template {
        r.items[0].source = None;
    }
    let c = OperationContext::detached("create");
    e.execute(&Work::Operation(r), &c);
    let status = c.recorded_outcomes()[0].clone();
    let parent_acl_after = acl(&d.join("shared"));
    let expected_acl = acl(&reference);
    let actual_acl = if d.join("shared/queued").exists() {
        acl(&d.join("shared/queued"))
    } else {
        String::new()
    };
    let expected_metadata = fs::metadata(&reference).unwrap();
    let expected_mode = expected_metadata.permissions().mode() & 0o7777;
    let actual_metadata = fs::metadata(d.join("shared/queued")).ok();
    let actual_mode = actual_metadata
        .as_ref()
        .map(|m| m.permissions().mode() & 0o7777);
    let recoveries = e.recoveries().unwrap();
    let retained_roots = e
        .journal
        .records()
        .into_iter()
        .flat_map(|r| r.roots)
        .collect::<Vec<_>>();
    // Always clear the deliberate deny ACL before assertions/fixture destruction.
    assert!(std::process::Command::new("/bin/chmod")
        .arg("-RN")
        .arg(&d.0)
        .status()
        .unwrap()
        .success());
    assert_eq!(
        status.status,
        OutcomeStatus::Succeeded,
        "{:?}",
        status.error
    );
    if deny_parent_cleanup {
        // The destination itself denies deleting children. Do not bypass that ACL:
        // the harmless private root remains registered and explicitly recoverable.
        assert_eq!(recoveries.len(), 1);
        assert_eq!(recoveries[0].actions, vec![RecoveryAction::DiscardStaging]);
        for root in retained_roots {
            assert!(root.valid());
            assert!(bento_fswatch::is_internal(&root.path));
            assert_eq!(
                fs::metadata(&root.path).unwrap().permissions().mode() & 0o777,
                0o700
            );
            for entry in fs::read_dir(&root.path).unwrap() {
                let path = entry.unwrap().path();
                assert!(path.is_dir());
                assert_eq!(
                    fs::read_dir(path).unwrap().count(),
                    0,
                    "staging retained data after successful creation"
                );
            }
        }
    } else {
        assert!(
            recoveries.is_empty(),
            "creation retained undeletable staging"
        );
    }
    assert_eq!(
        parent_acl_after, parent_acl_before,
        "destination parent ACL was modified"
    );
    assert!(expected_acl.contains("inherited"));
    assert_eq!(
        actual_acl, expected_acl,
        "creation ACL differs from native sibling: {kind:?}"
    );
    assert_eq!(
        actual_mode,
        Some(expected_mode),
        "creation mode differs: {kind:?}"
    );
    assert_eq!(
        actual_metadata.as_ref().unwrap().uid(),
        expected_metadata.uid(),
        "creation owner differs"
    );
    assert_eq!(
        actual_metadata.unwrap().gid(),
        expected_metadata.gid(),
        "creation group differs"
    );
    if kind == CreateKind::Template {
        assert_eq!(
            fs::read(d.join("shared/queued")).unwrap(),
            b"template bytes"
        );
    }
}
#[cfg(target_os = "macos")]
#[test]
fn finalreview_directory_creation_inherits_destination_acl_and_mode() {
    creation_matches_native_sibling(CreateKind::Directory, false);
}
#[cfg(target_os = "macos")]
#[test]
fn finalreview_text_creation_inherits_destination_acl_and_mode() {
    creation_matches_native_sibling(CreateKind::Text, false);
}
#[cfg(target_os = "macos")]
#[test]
fn finalreview_markdown_creation_inherits_destination_acl_and_mode() {
    creation_matches_native_sibling(CreateKind::Markdown, false);
}
#[cfg(target_os = "macos")]
#[test]
fn finalreview_template_creation_inherits_destination_acl_and_mode() {
    creation_matches_native_sibling(CreateKind::Template, false);
}

#[cfg(target_os = "macos")]
#[test]
fn finalreview_parent_delete_child_denial_retains_private_cleanup_record() {
    creation_matches_native_sibling(CreateKind::Directory, true);
}

#[test]
fn finalreview_completed_undo_releases_manifests() {
    let d = Scratch::new();
    fs::create_dir(d.join("dest")).unwrap();
    fs::write(d.join("source"), b"content").unwrap();
    let e = FileExecutor::new(d.join("app")).unwrap();
    for _ in 0..35 {
        let result = e.execute(
            &Work::Operation(request(
                OperationKind::Copy,
                &d.join("source"),
                &d.join("dest"),
            )),
            &OperationContext::detached("copy"),
        );
        assert!(
            e.execute(
                &Work::Undo {
                    undo_id: result.undo_id.unwrap()
                },
                &OperationContext::detached("undo")
            )
            .undo_complete
        );
    }
    assert_eq!(
        e.undo.lock().unwrap().len(),
        0,
        "fully undone manifest owners retained"
    );
}

#[test]
fn finalreview_available_history_is_bounded_and_evicted_backup_restores_after_restart() {
    let d = Scratch::new();
    fs::create_dir(d.join("incoming")).unwrap();
    fs::create_dir(d.join("export")).unwrap();
    fs::create_dir(d.join("managed")).unwrap();
    fs::write(d.join("incoming/file"), b"public replacement").unwrap();
    fs::write(d.join("managed/file"), b"managed original").unwrap();
    let e = Arc::new(FileExecutor::new(d.join("app")).unwrap());
    let q = OperationManager::new(e.clone(), Arc::new(|_| {}));
    let mut r = request(
        OperationKind::Copy,
        &d.join("incoming/file"),
        &d.join("managed"),
    );
    r.request_id = "protected".into();
    let job = q.enqueue(r.clone()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(conflict) = q.get(&job.job_id).unwrap().conflict {
            q.resolve(
                &job.job_id,
                &conflict.conflict_id,
                conflict.revision,
                ConflictDecision::Replace,
                false,
            )
            .unwrap();
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    q.wait_idle();
    let managed_recovery = e
        .journal
        .records()
        .into_iter()
        .find(|r| r.destination == d.join("managed/file"))
        .unwrap()
        .id;
    for i in 0..35 {
        let mut r = request(
            OperationKind::Copy,
            &d.join("incoming/file"),
            &d.join("export"),
        );
        r.request_id = format!("copy-{i}");
        r.items[0].target_name = Some(format!("file-{i}"));
        q.enqueue(r).unwrap();
        q.wait_idle();
    }
    assert_eq!(
        e.undo.lock().unwrap().len(),
        30,
        "ordinary manifest history did not retire"
    );
    assert_eq!(
        q.enqueue(r).unwrap().job_id,
        job.job_id,
        "retired undo must not defeat request idempotency"
    );
    for i in 0..30 {
        let undo = q.wait_idle().latest_undo_id.unwrap();
        q.undo(undo, format!("undo-{i}")).unwrap();
        assert_eq!(
            q.wait_idle().jobs.last().unwrap().state,
            JobState::Completed
        );
    }
    assert!(
        q.wait_idle().latest_undo_id.is_none(),
        "older evicted history became undoable"
    );
    assert!(e.undo.lock().unwrap().is_empty());
    let retained = e.journal.get(&managed_recovery).unwrap();
    assert_eq!(
        fs::read(&retained.protected[0].path).unwrap(),
        b"managed original"
    );
    drop(q);
    // Manager worker releases its Arc asynchronously on shutdown.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while Arc::strong_count(&e) != 1 {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    drop(e);
    let e = FileExecutor::new(d.join("app")).unwrap();
    let c = OperationContext::detached("restore");
    e.execute(
        &Work::Recovery {
            recovery_id: managed_recovery,
            action: RecoveryAction::RestoreBackup,
        },
        &c,
    );
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Succeeded);
    assert_eq!(
        fs::read(d.join("managed/file")).unwrap(),
        b"managed original"
    );
}

#[test]
fn finalreview_multi_parent_zip_verifies_staged_contents_before_child() {
    let d = Scratch::new();
    for dir in ["one", "two", "dest"] {
        fs::create_dir(d.join(dir)).unwrap();
    }
    fs::write(d.join("one/file"), b"original").unwrap();
    fs::write(d.join("two/other"), b"other").unwrap();
    let mut e = FileExecutor::new(d.join("app")).unwrap();
    e.hook = Arc::new(|point, path, _| {
        if point == Point::Metadata && path.file_name().is_some_and(|name| name == "file") {
            fs::write(path, b"tampered")?;
        }
        Ok(())
    });
    let mut r = request(OperationKind::Zip, &d.join("one/file"), &d.join("dest"));
    r.items.push(OperationItem {
        item_id: "second".into(),
        source: Some(display(&d.join("two/other"))),
        target_name: None,
        create_kind: None,
    });
    let c = OperationContext::detached("zip");
    e.execute(&Work::Operation(r), &c);
    assert_eq!(c.recorded_outcomes()[0].status, OutcomeStatus::Failed);
    assert!(
        e.child_ids.lock().unwrap().is_empty(),
        "ZIP consumed unverified staged input"
    );
    assert_eq!(fs::read(d.join("one/file")).unwrap(), b"original");
    assert_eq!(fs::read_dir(d.join("dest")).unwrap().count(), 0);
}
