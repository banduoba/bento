use super::*;
use std::sync::mpsc;
use std::time::Duration;
fn request(id: &str) -> OperationRequest {
    OperationRequest {
        request_id: id.into(),
        kind: OperationKind::Copy,
        items: vec![OperationItem {
            item_id: "i-1".into(),
            source: Some("/tmp/source".into()),
            target_name: None,
            create_kind: None,
        }],
        destination: Some("/tmp/dest".into()),
        options: OperationOptions::default(),
        intent: None,
        owner_tab_id: None,
        clip_revision: None,
    }
}
struct Success;
impl OperationExecutor for Success {
    fn execute(&self, _: &Work, ctx: &OperationContext) -> ExecutionResult {
        let mut o = ItemOutcome::new("i-1", OutcomeStatus::Succeeded);
        o.effect_id = Some("effect-1".into());
        o.published = true;
        ctx.record_outcome(o);
        ExecutionResult {
            undo_id: Some("undo-1".into()),
            ..Default::default()
        }
    }
}
#[test]
fn identical_request_is_idempotent_and_changed_payload_rejected() {
    let q = OperationManager::new(Arc::new(Success), Arc::new(|_| {}));
    let one = q.enqueue(request("r1")).unwrap();
    assert_eq!(q.enqueue(request("r1")).unwrap().job_id, one.job_id);
    let mut changed = request("r1");
    changed.destination = Some("/tmp/other".into());
    assert!(q.enqueue(changed).is_err());
    q.wait_idle();
    assert_eq!(q.get(&one.job_id).unwrap().state, JobState::Completed);
}

struct Blocking {
    entered: mpsc::Sender<String>,
    release: Mutex<mpsc::Receiver<()>>,
    calls: Mutex<Vec<String>>,
}
impl OperationExecutor for Blocking {
    fn execute(&self, work: &Work, ctx: &OperationContext) -> ExecutionResult {
        let Work::Operation(r) = work else {
            return ExecutionResult::default();
        };
        self.calls.lock().unwrap().push(r.request_id.clone());
        self.entered.send(r.request_id.clone()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        if !ctx.is_cancelled() {
            let mut o = ItemOutcome::new("i-1", OutcomeStatus::Succeeded);
            o.published = true;
            ctx.record_outcome(o);
        }
        ExecutionResult::default()
    }
}
fn blocking() -> (Arc<Blocking>, mpsc::Receiver<String>, mpsc::Sender<()>) {
    let (tx, rx) = mpsc::channel();
    let (release, released) = mpsc::channel();
    (
        Arc::new(Blocking {
            entered: tx,
            release: Mutex::new(released),
            calls: Mutex::new(vec![]),
        }),
        rx,
        release,
    )
}
#[test]
fn fifo_queued_cancel_never_executes_and_running_cancel_stops_future_effects() {
    let (executor, entered, release) = blocking();
    let q = OperationManager::new(executor.clone(), Arc::new(|_| {}));
    let first = q.enqueue(request("first")).unwrap();
    assert_eq!(
        entered.recv_timeout(Duration::from_secs(2)).unwrap(),
        "first"
    );
    let second = q.enqueue(request("second")).unwrap();
    let third = q.enqueue(request("third")).unwrap();
    assert_eq!(q.cancel(&second.job_id).unwrap().state, JobState::Cancelled);
    q.cancel(&first.job_id).unwrap();
    release.send(()).unwrap();
    assert_eq!(
        entered.recv_timeout(Duration::from_secs(2)).unwrap(),
        "third"
    );
    release.send(()).unwrap();
    q.wait_idle();
    assert_eq!(*executor.calls.lock().unwrap(), vec!["first", "third"]);
    assert_eq!(q.get(&first.job_id).unwrap().state, JobState::Cancelled);
    assert_eq!(q.get(&third.job_id).unwrap().state, JobState::Completed);
    let terminal = q.get(&second.job_id).unwrap();
    assert_eq!(q.cancel(&second.job_id).unwrap(), terminal);
}
struct Conflicting {
    entered: mpsc::Sender<()>,
    answers: Mutex<Vec<ConflictDecision>>,
}
fn conflict() -> ConflictSpec {
    ConflictSpec {
        item_id: "i-1".into(),
        source: "/tmp/source".into(),
        destination: "/tmp/dest/source".into(),
        source_kind: "file".into(),
        destination_kind: "file".into(),
        reason: "exists".into(),
        allowed_decisions: vec![ConflictDecision::Skip, ConflictDecision::KeepBoth],
    }
}
impl OperationExecutor for Conflicting {
    fn execute(&self, _: &Work, ctx: &OperationContext) -> ExecutionResult {
        self.entered.send(()).unwrap();
        let answer = ctx.wait_for_conflict(conflict());
        self.answers.lock().unwrap().push(answer);
        if answer != ConflictDecision::Cancel {
            ctx.record_outcome(ItemOutcome::new("i-1", OutcomeStatus::Skipped));
        }
        ExecutionResult::default()
    }
}
fn wait_conflict(q: &OperationManager, id: &str) -> Conflict {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(c) = q.get(id).unwrap().conflict {
            return c;
        }
        assert!(Instant::now() < deadline, "conflict timeout");
        std::thread::yield_now();
    }
}
#[test]
fn running_cancel_wakes_conflict_and_stale_responses_are_rejected() {
    let (tx, _rx) = mpsc::channel();
    let executor = Arc::new(Conflicting {
        entered: tx,
        answers: Mutex::new(vec![]),
    });
    let q = OperationManager::new(executor.clone(), Arc::new(|_| {}));
    let job = q.enqueue(request("conflict")).unwrap();
    let c = wait_conflict(&q, &job.job_id);
    assert!(q
        .resolve(
            &job.job_id,
            &c.conflict_id,
            c.revision + 1,
            ConflictDecision::Skip,
            false
        )
        .is_err());
    assert!(q
        .resolve(
            &job.job_id,
            &c.conflict_id,
            c.revision,
            ConflictDecision::Replace,
            false
        )
        .is_err());
    q.cancel(&job.job_id).unwrap();
    q.wait_idle();
    assert_eq!(
        *executor.answers.lock().unwrap(),
        vec![ConflictDecision::Cancel]
    );
    assert!(q
        .resolve(
            &job.job_id,
            &c.conflict_id,
            c.revision,
            ConflictDecision::Skip,
            false
        )
        .is_err());
}
#[test]
fn conflict_resolution_revisions_and_terminal_events_are_monotonic() {
    let (tx, _rx) = mpsc::channel();
    let executor = Arc::new(Conflicting {
        entered: tx,
        answers: Mutex::new(vec![]),
    });
    let events = Arc::new(Mutex::new(vec![]));
    let seen = events.clone();
    let q = OperationManager::new(executor, Arc::new(move |e| seen.lock().unwrap().push(e)));
    let job = q.enqueue(request("r")).unwrap();
    let c = wait_conflict(&q, &job.job_id);
    q.resolve(
        &job.job_id,
        &c.conflict_id,
        c.revision,
        ConflictDecision::Skip,
        true,
    )
    .unwrap();
    q.wait_idle();
    let terminal = q.get(&job.job_id).unwrap();
    assert_eq!(terminal.state, JobState::Completed);
    // Emission may race across callers; revisions define authoritative order.
    let events = events.lock().unwrap();
    let max = events.iter().map(|e| e.revision).max().unwrap();
    assert_eq!(max, terminal.revision);
    assert!(events
        .iter()
        .filter(|e| e.state.is_terminal())
        .all(|e| e.revision == max));
}
struct Partial;
impl OperationExecutor for Partial {
    fn execute(&self, _: &Work, ctx: &OperationContext) -> ExecutionResult {
        let mut o = ItemOutcome::new("i-1", OutcomeStatus::Partial);
        o.published = true;
        o.source_disposition = SourceDisposition::CleanupIncomplete;
        o.retry = RetryKind::FinishSourceCleanup;
        ctx.record_outcome(o);
        ExecutionResult::default()
    }
}
#[test]
fn published_source_cleanup_failure_is_partial_even_without_undo() {
    let q = OperationManager::new(Arc::new(Partial), Arc::new(|_| {}));
    let j = q.enqueue(request("r")).unwrap();
    q.wait_idle();
    assert_eq!(q.get(&j.job_id).unwrap().state, JobState::Partial);
    assert!(q.list().latest_undo_id.is_none());
    assert_eq!(
        q.outcomes(&j.job_id, 0, 200).unwrap().outcomes[0].retry,
        RetryKind::FinishSourceCleanup
    );
}
#[test]
fn exit_drains_real_executor_and_seals_admission_until_continue() {
    let (executor, entered, release) = blocking();
    let q = Arc::new(OperationManager::new(executor, Arc::new(|_| {})));
    q.enqueue(request("r")).unwrap();
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(q.prepare_exit(true).busy);
    assert!(q.enqueue(request("later")).is_err());
    let (done_tx, done_rx) = mpsc::channel();
    let waiter = q.clone();
    let handle = std::thread::spawn(move || done_tx.send(waiter.wait_idle()).unwrap());
    assert!(done_rx.recv_timeout(Duration::from_millis(30)).is_err());
    release.send(()).unwrap();
    assert!(!done_rx.recv_timeout(Duration::from_secs(2)).unwrap().busy);
    handle.join().unwrap();
    assert!(q.prepare_exit(false).accepting);
}
struct Undoing {
    attempts: AtomicU64,
}
impl OperationExecutor for Undoing {
    fn execute(&self, work: &Work, ctx: &OperationContext) -> ExecutionResult {
        if matches!(work, Work::Undo { .. }) {
            let second = self.attempts.fetch_add(1, Ordering::SeqCst) > 0;
            ctx.record_outcome(ItemOutcome::new(
                "inverse-1",
                if second {
                    OutcomeStatus::Succeeded
                } else {
                    OutcomeStatus::Failed
                },
            ));
            return ExecutionResult {
                undo_complete: second,
                ..Default::default()
            };
        }
        Success.execute(work, ctx)
    }
}
#[test]
fn latest_undo_only_and_partial_undo_retains_id_for_retry() {
    let q = OperationManager::new(
        Arc::new(Undoing {
            attempts: AtomicU64::new(0),
        }),
        Arc::new(|_| {}),
    );
    assert!(q.undo("undo-1".into(), "u0".into()).is_err());
    q.enqueue(request("r")).unwrap();
    q.wait_idle();
    assert!(q.undo("/tmp/backup".into(), "bad".into()).is_err());
    let one = q.undo("undo-1".into(), "u1".into()).unwrap();
    q.wait_idle();
    assert_eq!(q.get(&one.job_id).unwrap().state, JobState::Failed);
    assert_eq!(q.list().latest_undo_id.as_deref(), Some("undo-1"));
    q.undo("undo-1".into(), "u2".into()).unwrap();
    q.wait_idle();
    assert!(q.list().latest_undo_id.is_none());
    assert_eq!(
        q.undo("undo-1".into(), "u1".into()).unwrap().job_id,
        one.job_id
    );
}
struct Large;
impl OperationExecutor for Large {
    fn execute(&self, work: &Work, ctx: &OperationContext) -> ExecutionResult {
        let Work::Operation(r) = work else {
            return ExecutionResult::default();
        };
        ctx.progress(u64::MAX, Some(u64::MAX), None, None);
        for item in &r.items {
            let mut o = ItemOutcome::new(&item.item_id, OutcomeStatus::Failed);
            o.error = Some(OperationError {
                code: "error".into(),
                message: "failure with secret-password".into(),
                phase: Phase::Archiving,
            });
            ctx.record_outcome(o);
        }
        ExecutionResult::default()
    }
}
#[test]
fn ten_thousand_outcomes_have_bounded_summaries_and_password_redaction() {
    let events = Arc::new(Mutex::new((0usize, false)));
    let seen = events.clone();
    let q = OperationManager::new(
        Arc::new(Large),
        Arc::new(move |e| {
            let json = serde_json::to_string(&e).unwrap();
            let mut s = seen.lock().unwrap();
            s.0 = s.0.max(json.len());
            s.1 |= json.contains("secret-password");
        }),
    );
    let mut r = request("large");
    r.options.password = Some("secret-password".into());
    r.items = (0..10_000)
        .map(|i| OperationItem {
            item_id: format!("i-{i}"),
            source: Some(format!("/tmp/source-{i}")),
            target_name: None,
            create_kind: None,
        })
        .collect();
    let j = q.enqueue(r).unwrap();
    q.wait_idle();
    let snapshot = q.get(&j.job_id).unwrap();
    assert_eq!(snapshot.outcome_count, 10_000);
    assert_eq!(snapshot.progress.bytes_done, u64::MAX.to_string());
    let page = q.outcomes(&j.job_id, 0, 10_000).unwrap();
    assert_eq!(page.outcomes.len(), 200);
    assert_eq!(page.total, 10_000);
    assert!(!serde_json::to_string(&page)
        .unwrap()
        .contains("secret-password"));
    let seen = events.lock().unwrap();
    assert!(seen.0 < 4096, "summary bytes {}", seen.0);
    assert!(!seen.1);
}
#[test]
fn malformed_ids_paths_and_duplicate_items_fail_before_executor() {
    let q = OperationManager::new(Arc::new(Success), Arc::new(|_| {}));
    for invalid in ["", "../escape", "has space"] {
        let mut r = request("r");
        r.request_id = invalid.into();
        assert!(q.enqueue(r).is_err());
    }
    let mut r = request("relative");
    r.items[0].source = Some("relative/path".into());
    assert!(q.enqueue(r).is_err());
    let mut r = request("duplicate");
    r.items.push(r.items[0].clone());
    assert!(q.enqueue(r).is_err());
    assert!(q.get("stale-job").is_err());
    assert!(q
        .recover(
            "../backup".into(),
            RecoveryAction::RestoreBackup,
            "r".into()
        )
        .is_err());
}
#[test]
fn terminal_history_eviction_preserves_request_tombstones_and_undo() {
    let q = OperationManager::new(Arc::new(Success), Arc::new(|_| {}));
    let first = q.enqueue(request("r-0")).unwrap();
    q.wait_idle();
    let terminal = q.get(&first.job_id).unwrap();
    q.acknowledge(&terminal.job_id, terminal.revision, terminal.outcome_count)
        .unwrap();
    for i in 1..270 {
        let job = q.enqueue(request(&format!("r-{i}"))).unwrap();
        q.wait_idle();
        let terminal = q.get(&job.job_id).unwrap();
        q.acknowledge(&terminal.job_id, terminal.revision, terminal.outcome_count)
            .unwrap();
    }
    assert_eq!(q.list().jobs.len(), 256);
    assert!(q.get(&first.job_id).is_err());
    assert!(q
        .enqueue(request("r-0"))
        .unwrap_err()
        .contains("history evicted"));
    assert_eq!(q.list().latest_undo_id.as_deref(), Some("undo-1"));
}
#[test]
fn missed_events_cannot_evict_unacknowledged_outcomes() {
    let q = OperationManager::new(Arc::new(Success), Arc::new(|_| {}));
    let first = q.enqueue(request("first")).unwrap();
    q.wait_idle();
    for i in 1..256 {
        q.enqueue(request(&format!("r-{i}"))).unwrap();
        q.wait_idle();
    }
    assert!(q
        .enqueue(request("new"))
        .unwrap_err()
        .contains("acknowledgement"));
    let terminal = q.get(&first.job_id).unwrap();
    assert!(q
        .acknowledge(&first.job_id, terminal.revision - 1, terminal.outcome_count)
        .is_err());
    assert!(q.acknowledge(&first.job_id, terminal.revision, 0).is_err());
    assert_eq!(q.outcomes(&first.job_id, 0, 200).unwrap().outcomes.len(), 1);
    q.acknowledge(&first.job_id, terminal.revision, terminal.outcome_count)
        .unwrap();
    q.enqueue(request("new")).unwrap();
    q.wait_idle();
    assert!(q
        .enqueue(request("first"))
        .unwrap_err()
        .contains("history evicted"));
}
#[test]
fn seal_if_idle_rejects_busy_and_prevents_enqueue_after_approval() {
    let (executor, entered, release) = blocking();
    let q = OperationManager::new(executor, Arc::new(|_| {}));
    q.enqueue(request("r")).unwrap();
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(!q.seal_if_idle());
    release.send(()).unwrap();
    q.wait_idle();
    assert!(q.seal_if_idle());
    assert!(q.enqueue(request("late")).is_err());
}
struct Finishing {
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}
impl OperationExecutor for Finishing {
    fn execute(&self, _: &Work, ctx: &OperationContext) -> ExecutionResult {
        ctx.set_phase(Phase::Publishing, Cancelability::Finishing);
        self.entered.send(()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        // Publication/source cleanup is indivisible. A late cancel cannot undo it.
        let mut outcome = ItemOutcome::new("i-1", OutcomeStatus::Succeeded);
        outcome.published = true;
        ctx.record_outcome(outcome);
        ExecutionResult::default()
    }
}
#[test]
fn finishing_cancel_waits_for_real_publication_and_preserves_success() {
    let (tx, rx) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let q = OperationManager::new(
        Arc::new(Finishing {
            entered: tx,
            release: Mutex::new(wait),
        }),
        Arc::new(|_| {}),
    );
    let j = q.enqueue(request("r")).unwrap();
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(
        q.cancel(&j.job_id).unwrap().cancelability,
        Cancelability::Finishing
    );
    assert!(q.is_busy());
    release.send(()).unwrap();
    q.wait_idle();
    let terminal = q.get(&j.job_id).unwrap();
    assert_eq!(terminal.state, JobState::Completed);
    assert!(terminal.cancel_requested);
}
#[test]
fn undo_admission_is_rejected_while_another_writer_runs() {
    let (executor, entered, release) = blocking();
    let q = OperationManager::new(executor, Arc::new(|_| {}));
    q.enqueue(request("r")).unwrap();
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(q
        .undo("undo-1".into(), "u".into())
        .unwrap_err()
        .contains("idle"));
    release.send(()).unwrap();
    q.wait_idle();
}
struct TwoConflicts;
impl OperationExecutor for TwoConflicts {
    fn execute(&self, _: &Work, ctx: &OperationContext) -> ExecutionResult {
        assert_eq!(
            ctx.wait_for_conflict(conflict()),
            ConflictDecision::KeepBoth
        );
        assert_eq!(
            ctx.wait_for_conflict(conflict()),
            ConflictDecision::KeepBoth
        );
        let mut different = conflict();
        different.destination_kind = "directory".into();
        assert_eq!(ctx.wait_for_conflict(different), ConflictDecision::Skip);
        ctx.record_outcome(ItemOutcome::new("i-1", OutcomeStatus::Skipped));
        ExecutionResult::default()
    }
}
#[test]
fn apply_remaining_is_scoped_to_matching_conflict_kinds() {
    let q = OperationManager::new(Arc::new(TwoConflicts), Arc::new(|_| {}));
    let j = q.enqueue(request("r")).unwrap();
    let c = wait_conflict(&q, &j.job_id);
    q.resolve(
        &j.job_id,
        &c.conflict_id,
        c.revision,
        ConflictDecision::KeepBoth,
        true,
    )
    .unwrap();
    let d = wait_conflict(&q, &j.job_id);
    assert_eq!(d.destination_kind, "directory");
    q.resolve(
        &j.job_id,
        &d.conflict_id,
        d.revision,
        ConflictDecision::Skip,
        false,
    )
    .unwrap();
    q.wait_idle();
    assert_eq!(q.get(&j.job_id).unwrap().state, JobState::Completed);
}
struct ReversibleThenUnprotected;
impl OperationExecutor for ReversibleThenUnprotected {
    fn execute(&self, work: &Work, ctx: &OperationContext) -> ExecutionResult {
        if let Work::Operation(r) = work {
            if r.request_id == "unprotected" {
                return Partial.execute(work, ctx);
            }
        }
        Success.execute(work, ctx)
    }
}
#[test]
fn latest_effect_without_safe_inverse_blocks_older_undo() {
    let q = OperationManager::new(Arc::new(ReversibleThenUnprotected), Arc::new(|_| {}));
    q.enqueue(request("reversible")).unwrap();
    q.wait_idle();
    assert_eq!(q.list().latest_undo_id.as_deref(), Some("undo-1"));
    q.enqueue(request("unprotected")).unwrap();
    q.wait_idle();
    assert!(q.list().latest_undo_id.is_none());
    assert!(q.undo("undo-1".into(), "wrong-old-undo".into()).is_err());
}
struct ProgressSync {
    updated: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}
impl OperationExecutor for ProgressSync {
    fn execute(&self, _: &Work, ctx: &OperationContext) -> ExecutionResult {
        ctx.progress(1, Some(2), None, None);
        ctx.progress(2, Some(2), None, None);
        self.updated.send(()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        ctx.record_outcome(ItemOutcome::new("i-1", OutcomeStatus::Succeeded));
        ExecutionResult::default()
    }
}
#[test]
fn throttled_progress_still_advances_authoritative_snapshot_revision() {
    let (tx, rx) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let events = Arc::new(Mutex::new(vec![]));
    let seen = events.clone();
    let q = OperationManager::new(
        Arc::new(ProgressSync {
            updated: tx,
            release: Mutex::new(wait),
        }),
        Arc::new(move |e| seen.lock().unwrap().push(e)),
    );
    let j = q.enqueue(request("r")).unwrap();
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let snapshot = q.get(&j.job_id).unwrap();
    let latest_progress = events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e.progress.bytes_done != "0")
        .last()
        .unwrap()
        .clone();
    assert_eq!(snapshot.progress.bytes_done, "2");
    assert!(snapshot.revision > latest_progress.revision);
    release.send(()).unwrap();
    q.wait_idle();
}
#[test]
fn real_executor_fifo_and_latest_undo_preserve_disk_results() {
    use std::fs;
    let root = std::env::temp_dir().join(format!(
        "bento-m6-queue-integration-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            crate::cleanup_staging(&self.0);
        }
    }
    let _cleanup = Cleanup(root.clone());
    fs::create_dir_all(root.join("destination")).unwrap();
    fs::write(root.join("source"), b"verified contents").unwrap();
    {
        let executor = super::super::executor::FileExecutor::new(root.join("app")).unwrap();
        let q = OperationManager::new(Arc::new(executor), Arc::new(|_| {}));
        let mut copy = request("copy");
        copy.items[0].source = Some(root.join("source").to_string_lossy().into());
        copy.destination = Some(root.join("destination").to_string_lossy().into());
        let copied = q.enqueue(copy.clone()).unwrap();
        let mut rename = request("rename");
        rename.kind = OperationKind::Rename;
        rename.items[0].source = Some(root.join("destination/source").to_string_lossy().into());
        rename.items[0].target_name = Some("renamed".into());
        rename.destination = None;
        let renamed = q.enqueue(rename).unwrap();
        q.wait_idle();
        assert_eq!(q.get(&copied.job_id).unwrap().state, JobState::Completed);
        assert_eq!(q.get(&renamed.job_id).unwrap().state, JobState::Completed);
        assert_eq!(
            fs::read(root.join("destination/renamed")).unwrap(),
            b"verified contents"
        );
        assert!(!root.join("destination/source").exists());
        assert_eq!(q.enqueue(copy).unwrap().job_id, copied.job_id);
        let undo = q.list().latest_undo_id.unwrap();
        let inverse = q.undo(undo, "undo-rename".into()).unwrap();
        q.wait_idle();
        assert_eq!(q.get(&inverse.job_id).unwrap().state, JobState::Completed);
        assert!(root.join("destination/source").exists());
        assert!(!root.join("destination/renamed").exists());
        let undo = q.list().latest_undo_id.unwrap();
        let inverse_copy = q.undo(undo, "undo-copy".into()).unwrap();
        q.wait_idle();
        assert_eq!(
            q.get(&inverse_copy.job_id).unwrap().state,
            JobState::Completed,
            "{:?}",
            q.outcomes(&inverse_copy.job_id, 0, 200).unwrap().outcomes
        );
        assert!(!root.join("destination/source").exists());
        assert_eq!(fs::read(root.join("source")).unwrap(), b"verified contents");
        assert!(q.list().latest_undo_id.is_none());
    }
    crate::cleanup_staging(&root);
}
struct Recoverable;
impl OperationExecutor for Recoverable {
    fn execute(&self, work: &Work, ctx: &OperationContext) -> ExecutionResult {
        let mut o = ItemOutcome::new("i-1", OutcomeStatus::Succeeded);
        o.published = true;
        ctx.record_outcome(o);
        match work {
            Work::Operation(r) => ExecutionResult {
                undo_id: Some(format!("undo-{}", r.request_id)),
                ..Default::default()
            },
            Work::Recovery { .. } => ExecutionResult {
                undo_id: Some("undo-first".into()),
                ..Default::default()
            },
            Work::Undo { .. } => ExecutionResult {
                undo_complete: true,
                ..Default::default()
            },
        }
    }
    fn recoveries(&self) -> Result<Vec<RecoveryRecord>, String> {
        Ok(vec![RecoveryRecord {
            recovery_id: "recovery-first".into(),
            description: "cleanup".into(),
            source: None,
            destination: None,
            actions: vec![RecoveryAction::FinishSourceCleanup],
        }])
    }
}
#[test]
fn recovery_promotes_existing_undo_without_duplicating_its_stack_entry() {
    let q = OperationManager::new(Arc::new(Recoverable), Arc::new(|_| {}));
    q.enqueue(request("first")).unwrap();
    q.wait_idle();
    q.enqueue(request("second")).unwrap();
    q.wait_idle();
    assert!(q
        .recover(
            "unknown".into(),
            RecoveryAction::FinishSourceCleanup,
            "invalid".into()
        )
        .is_err());
    let recovered = q
        .recover(
            "recovery-first".into(),
            RecoveryAction::FinishSourceCleanup,
            "recover".into(),
        )
        .unwrap();
    q.wait_idle();
    assert_eq!(
        q.recover(
            "recovery-first".into(),
            RecoveryAction::FinishSourceCleanup,
            "recover".into()
        )
        .unwrap()
        .job_id,
        recovered.job_id
    );
    assert_eq!(q.list().latest_undo_id.as_deref(), Some("undo-first"));
    q.undo("undo-first".into(), "u1".into()).unwrap();
    q.wait_idle();
    assert_eq!(q.list().latest_undo_id.as_deref(), Some("undo-second"));
    q.undo("undo-second".into(), "u2".into()).unwrap();
    q.wait_idle();
    assert!(q.list().latest_undo_id.is_none());
}
struct ProtectedPartial;
impl OperationExecutor for ProtectedPartial {
    fn execute(&self, work: &Work, ctx: &OperationContext) -> ExecutionResult {
        if let Work::Operation(r) = work {
            if r.request_id == "protected" {
                let mut outcome = ItemOutcome::new("i-1", OutcomeStatus::Partial);
                outcome.retry = RetryKind::ManualRecovery;
                ctx.record_outcome(outcome);
                return ExecutionResult::default();
            }
        }
        Success.execute(work, ctx)
    }
}
#[test]
fn retained_partial_effect_before_publication_blocks_older_undo() {
    let q = OperationManager::new(Arc::new(ProtectedPartial), Arc::new(|_| {}));
    q.enqueue(request("first")).unwrap();
    q.wait_idle();
    q.enqueue(request("protected")).unwrap();
    q.wait_idle();
    assert!(
        q.list().latest_undo_id.is_none(),
        "protected original awaiting recovery must block older undo"
    );
}

struct PanicAfterMutation {
    marker: std::path::PathBuf,
    mutated: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}
impl OperationExecutor for PanicAfterMutation {
    fn execute(&self, work: &Work, ctx: &OperationContext) -> ExecutionResult {
        if matches!(work, Work::Operation(r) if r.request_id == "first") {
            return Success.execute(work, ctx);
        }
        std::fs::write(&self.marker, b"real unreported effect").unwrap();
        self.mutated.send(()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        panic!("injected failure after mutation and before outcome publication");
    }
}
fn panic_after_mutation_case(cancel: bool, inverse: bool) {
    struct Marker(std::path::PathBuf);
    impl Drop for Marker {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let marker = Marker(std::env::temp_dir().join(format!(
            "bento-m6-panic-regression-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
    let (mutated, observed) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let q = OperationManager::new(
        Arc::new(PanicAfterMutation {
            marker: marker.0.clone(),
            mutated,
            release: Mutex::new(wait),
        }),
        Arc::new(|_| {}),
    );
    q.enqueue(request("first")).unwrap();
    q.wait_idle();
    let job = if inverse {
        q.undo("undo-1".into(), "panic-undo".into()).unwrap()
    } else {
        q.enqueue(request("panic")).unwrap()
    };
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(marker.0.exists());
    if cancel {
        q.cancel(&job.job_id).unwrap();
    }
    release.send(()).unwrap();
    q.wait_idle();
    let snapshot = q.get(&job.job_id).unwrap();
    assert_eq!(snapshot.state, JobState::Partial);
    assert_eq!(snapshot.error.as_ref().unwrap().code, "executorPanic");
    let outcomes = q.outcomes(&job.job_id, 0, 200).unwrap().outcomes;
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].status, OutcomeStatus::Partial);
    assert_eq!(outcomes[0].source_disposition, SourceDisposition::Unknown);
    assert_eq!(outcomes[0].retry, RetryKind::ManualRecovery);
    assert!(outcomes[0].error.is_some());
    assert!(q.list().latest_undo_id.is_none());
    assert!(q.undo("undo-1".into(), "unsafe-retry".into()).is_err());
}
#[test]
fn round1_panic_after_real_mutation_blocks_older_undo() {
    panic_after_mutation_case(false, false);
}
#[test]
fn round1_cancelled_panic_does_not_claim_real_mutation_was_not_started() {
    panic_after_mutation_case(true, false);
}
#[test]
fn round1_panicked_inverse_requires_recovery_before_retry() {
    panic_after_mutation_case(true, true);
}

struct PausingUndo {
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
    calls: AtomicU64,
    first_applied: bool,
    first_complete: bool,
    steps: Mutex<Vec<&'static str>>,
}
impl OperationExecutor for PausingUndo {
    fn execute(&self, work: &Work, ctx: &OperationContext) -> ExecutionResult {
        if !matches!(work, Work::Undo { .. }) {
            return Success.execute(work, ctx);
        }
        let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
        if !first || self.first_applied {
            let step = if first {
                "inverse-first"
            } else {
                "inverse-second"
            };
            self.steps.lock().unwrap().push(step);
            let mut outcome = ItemOutcome::new(step, OutcomeStatus::Succeeded);
            outcome.published = true;
            outcome.effect_id = Some(step.into());
            ctx.record_outcome(outcome);
        }
        if first {
            self.entered.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(3))
                .unwrap();
        }
        ExecutionResult {
            undo_complete: !first || self.first_complete,
            ..Default::default()
        }
    }
}
fn paused_undo(
    applied: bool,
    complete: bool,
) -> (
    OperationManager,
    Arc<PausingUndo>,
    JobSnapshot,
    mpsc::Receiver<()>,
    mpsc::Sender<()>,
) {
    let (entered, observed) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let executor = Arc::new(PausingUndo {
        entered,
        release: Mutex::new(wait),
        calls: AtomicU64::new(0),
        first_applied: applied,
        first_complete: complete,
        steps: Mutex::new(vec![]),
    });
    let q = OperationManager::new(executor.clone(), Arc::new(|_| {}));
    q.enqueue(request("first")).unwrap();
    q.wait_idle();
    let inverse = q.undo("undo-1".into(), "inverse".into()).unwrap();
    (q, executor, inverse, observed, release)
}
#[test]
fn round1_cancelled_incomplete_undo_is_partial_and_retry_only_applies_remaining_step() {
    let (q, executor, inverse, observed, release) = paused_undo(true, false);
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    q.cancel(&inverse.job_id).unwrap();
    release.send(()).unwrap();
    q.wait_idle();
    assert_eq!(q.get(&inverse.job_id).unwrap().state, JobState::Partial);
    assert_eq!(q.list().latest_undo_id.as_deref(), Some("undo-1"));
    let retry = q.undo("undo-1".into(), "retry".into()).unwrap();
    q.wait_idle();
    assert_eq!(q.get(&retry.job_id).unwrap().state, JobState::Completed);
    assert_eq!(
        *executor.steps.lock().unwrap(),
        vec!["inverse-first", "inverse-second"]
    );
    assert!(q.list().latest_undo_id.is_none());
}
#[test]
fn round1_cancelled_incomplete_undo_without_applied_steps_is_cancelled() {
    let (q, _, inverse, observed, release) = paused_undo(false, false);
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    q.cancel(&inverse.job_id).unwrap();
    release.send(()).unwrap();
    q.wait_idle();
    assert_eq!(q.get(&inverse.job_id).unwrap().state, JobState::Cancelled);
    assert_eq!(q.list().latest_undo_id.as_deref(), Some("undo-1"));
}
#[test]
fn round1_late_cancel_preserves_completed_undo_with_or_without_new_outcomes() {
    for applied in [true, false] {
        let (q, _, inverse, observed, release) = paused_undo(applied, true);
        observed.recv_timeout(Duration::from_secs(3)).unwrap();
        q.cancel(&inverse.job_id).unwrap();
        release.send(()).unwrap();
        q.wait_idle();
        assert_eq!(q.get(&inverse.job_id).unwrap().state, JobState::Completed);
        assert!(q.list().latest_undo_id.is_none());
    }
}


#[test]
fn finalreview_history_retirement_runs_unlocked_and_does_not_cross_partial_barrier() {
    struct Window {
        shared: Mutex<Option<std::sync::Weak<Shared>>>,
        retired: Mutex<Vec<String>>,
    }
    impl OperationExecutor for Window {
        fn execute(&self, work: &Work, c: &OperationContext) -> ExecutionResult {
            if let Work::Operation(r) = work {
                let mut out = ItemOutcome::new(
                    "i-1",
                    if r.request_id == "barrier" {
                        OutcomeStatus::Partial
                    } else {
                        OutcomeStatus::Succeeded
                    },
                );
                out.published = true;
                c.record_outcome(out);
                ExecutionResult {
                    undo_id: (r.request_id != "barrier").then(|| r.request_id.clone()),
                    ..Default::default()
                }
            } else {
                c.record_outcome(ItemOutcome::new("inverse", OutcomeStatus::Succeeded));
                ExecutionResult {
                    undo_complete: true,
                    ..Default::default()
                }
            }
        }
        fn forget_undo(&self, id: &str) {
            let shared = self
                .shared
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .upgrade()
                .unwrap();
            let state = shared
                .state
                .try_lock()
                .expect("retirement ran under queue lock");
            assert!(busy(&state), "idle was exposed before retirement completed");
            self.retired.lock().unwrap().push(id.into());
        }
    }
    let executor = Arc::new(Window {
        shared: Mutex::new(None),
        retired: Mutex::new(vec![]),
    });
    let q = OperationManager::new(executor.clone(), Arc::new(|_| {}));
    *executor.shared.lock().unwrap() = Some(Arc::downgrade(&q.shared));
    for i in 0..5 {
        q.enqueue(request(&format!("old-{i}"))).unwrap();
        q.wait_idle();
    }
    q.enqueue(request("barrier")).unwrap();
    q.wait_idle();
    for i in 0..29 {
        q.enqueue(request(&format!("new-{i}"))).unwrap();
        q.wait_idle();
    }
    assert_eq!(
        *executor.retired.lock().unwrap(),
        (0..5).map(|i| format!("old-{i}")).collect::<Vec<_>>()
    );
    for i in 0..29 {
        q.undo(
            q.wait_idle().latest_undo_id.unwrap(),
            format!("inverse-{i}"),
        )
        .unwrap();
        q.wait_idle();
    }
    assert!(q.wait_idle().latest_undo_id.is_none());
    assert!(q.undo("old-4".into(), "cannot-cross".into()).is_err());
    assert_eq!(q.shared.state.lock().unwrap().undo, vec![None]);
}
