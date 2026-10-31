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
    for i in 1..270 {
        q.enqueue(request(&format!("r-{i}"))).unwrap();
        q.wait_idle();
    }
    assert_eq!(q.list().jobs.len(), 256);
    assert!(q.get(&first.job_id).is_err());
    assert!(q
        .enqueue(request("r-0"))
        .unwrap_err()
        .contains("history evicted"));
    assert_eq!(q.list().latest_undo_id.as_deref(), Some("undo-1"));
}
