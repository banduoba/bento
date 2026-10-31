//! One FIFO writer. Locks protect memory only; executor and event sink run unlocked.
use super::types::*;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub trait OperationExecutor: Send + Sync + 'static {
    fn execute(&self, work: &Work, context: &OperationContext) -> ExecutionResult;
    fn recoveries(&self) -> Result<Vec<RecoveryRecord>, String> {
        Ok(vec![])
    }
}
type EventSink = Arc<dyn Fn(JobSnapshot) + Send + Sync>;
struct Job {
    snapshot: JobSnapshot,
    work: Work,
    outcomes: Vec<ItemOutcome>,
    cancel: Arc<AtomicBool>,
    answer: Option<ConflictDecision>,
    remaining: Option<(String, String, ConflictDecision)>,
    last_progress: Instant,
    acknowledged: bool,
}
struct State {
    session_id: String,
    revision: u64,
    next_id: u64,
    jobs: HashMap<String, Job>,
    order: Vec<String>,
    requests: HashMap<String, String>,
    fifo: VecDeque<String>,
    running: Option<String>,
    undo: Vec<Option<String>>,
    accepting: bool,
    shutdown: bool,
}
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
    emit: EventSink,
}
pub struct OperationManager {
    shared: Arc<Shared>,
    executor: Arc<dyn OperationExecutor>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn bounded(value: &Option<String>, max: usize) -> bool {
    value
        .as_ref()
        .is_none_or(|s| s.len() <= max && !s.contains('\0'))
}
fn valid_path(path: &str) -> bool {
    path.starts_with('/') && path.len() <= 32768 && !path.contains('\0')
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\0')
        && name.len() <= 255
}
fn validate(request: &OperationRequest) -> Result<(), String> {
    let reject = || Err("invalid operation request".into());
    if !valid_id(&request.request_id)
        || request.items.is_empty()
        || request.items.len() > 10_000
        || !bounded(&request.owner_tab_id, 128)
        || !bounded(&request.intent, 128)
        || !bounded(&request.clip_revision, 128)
        || !bounded(&request.options.password, 1024)
        || request.options.compression_level.is_some_and(|n| n > 9)
        || request
            .options
            .archive_name
            .as_ref()
            .is_some_and(|s| !valid_name(s))
    {
        return reject();
    }
    if matches!(request.kind, OperationKind::Undo | OperationKind::Recovery) {
        return reject();
    }
    if request.destination.as_ref().is_some_and(|p| !valid_path(p)) {
        return reject();
    }
    if matches!(
        request.kind,
        OperationKind::Copy | OperationKind::Move | OperationKind::Create | OperationKind::Zip
    ) && request.destination.is_none()
    {
        return reject();
    }
    let mut ids = HashSet::new();
    for item in &request.items {
        if !valid_id(&item.item_id)
            || !ids.insert(&item.item_id)
            || item.source.as_ref().is_some_and(|p| !valid_path(p))
            || item.target_name.as_ref().is_some_and(|n| !valid_name(n))
        {
            return reject();
        }
        if request.kind == OperationKind::Create {
            if item.create_kind.is_none()
                || (item.create_kind == Some(CreateKind::Template) && item.source.is_none())
            {
                return reject();
            }
        } else if item.source.is_none() {
            return reject();
        }
        if request.kind == OperationKind::Rename && item.target_name.is_none() {
            return reject();
        }
    }
    if serde_json::to_vec(request)
        .map_err(|_| "invalid request")?
        .len()
        > 4 * 1024 * 1024
    {
        return Err("operation request too large".into());
    }
    Ok(())
}
fn bump(state: &mut State, id: &str) -> JobSnapshot {
    state.revision += 1;
    let job = state.jobs.get_mut(id).unwrap();
    job.snapshot.revision += 1;
    job.snapshot.clone()
}
fn busy(state: &State) -> bool {
    state.running.is_some()
        || state
            .fifo
            .iter()
            .any(|id| !state.jobs[id].snapshot.state.is_terminal())
}
fn summary(state: &State) -> QueueSnapshot {
    QueueSnapshot {
        session_id: state.session_id.clone(),
        revision: state.revision,
        jobs: state
            .order
            .iter()
            .map(|id| state.jobs[id].snapshot.clone())
            .collect(),
        busy: busy(state),
        accepting: state.accepting,
        latest_undo_id: state.undo.last().cloned().flatten(),
    }
}
impl OperationManager {
    pub fn new(executor: Arc<dyn OperationExecutor>, emit: EventSink) -> Self {
        static SESSIONS: AtomicU64 = AtomicU64::new(1);
        let session_id = format!(
            "s-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            SESSIONS.fetch_add(1, Ordering::Relaxed)
        );
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                session_id,
                revision: 0,
                next_id: 1,
                jobs: HashMap::new(),
                order: vec![],
                requests: HashMap::new(),
                fifo: VecDeque::new(),
                running: None,
                undo: vec![],
                accepting: true,
                shutdown: false,
            }),
            wake: Condvar::new(),
            emit,
        });
        let worker_shared = shared.clone();
        let worker_executor = executor.clone();
        std::thread::Builder::new()
            .name("bento-file-operations".into())
            .spawn(move || worker(worker_shared, worker_executor))
            .expect("start operation worker");
        Self { shared, executor }
    }
    pub fn enqueue(&self, request: OperationRequest) -> Result<JobSnapshot, String> {
        validate(&request)?;
        self.admit(request.request_id.clone(), Work::Operation(request), false)
    }
    pub fn undo(&self, undo_id: String, request_id: String) -> Result<JobSnapshot, String> {
        if !valid_id(&undo_id) {
            return Err("invalid undo ID".into());
        }
        self.admit(request_id, Work::Undo { undo_id }, true)
    }
    pub fn recover(
        &self,
        recovery_id: String,
        action: RecoveryAction,
        request_id: String,
    ) -> Result<JobSnapshot, String> {
        if !valid_id(&recovery_id) {
            return Err("invalid recovery ID".into());
        }
        // Idempotent replay must still work after the recovery record is consumed.
        {
            let state = self.shared.state.lock().unwrap();
            if let Some(id) = state.requests.get(&request_id) {
                let job = state
                    .jobs
                    .get(id)
                    .ok_or("request already completed; history evicted")?;
                return if job.work
                    == (Work::Recovery {
                        recovery_id,
                        action,
                    }) {
                    Ok(job.snapshot.clone())
                } else {
                    Err("requestId already used for different payload".into())
                };
            }
        }
        let records = self.executor.recoveries()?; // Never under queue lock.
        if !records
            .iter()
            .any(|r| r.recovery_id == recovery_id && r.actions.contains(&action))
        {
            return Err("unknown recovery or unsupported action".into());
        }
        self.admit(
            request_id,
            Work::Recovery {
                recovery_id,
                action,
            },
            true,
        )
    }
    fn admit(
        &self,
        request_id: String,
        work: Work,
        idle_only: bool,
    ) -> Result<JobSnapshot, String> {
        if !valid_id(&request_id) {
            return Err("invalid request ID".into());
        }
        let snapshot = {
            let mut state = self.shared.state.lock().unwrap();
            if let Some(id) = state.requests.get(&request_id) {
                let job = state
                    .jobs
                    .get(id)
                    .ok_or("request already completed; history evicted")?;
                return if job.work == work {
                    Ok(job.snapshot.clone())
                } else {
                    Err("requestId already used for different payload".into())
                };
            }
            if !state.accepting || state.shutdown {
                return Err("operation queue is draining for exit".into());
            }
            if idle_only && busy(&state) {
                return Err("operation queue must be idle".into());
            }
            if let Work::Undo { undo_id } = &work {
                if state.undo.last().and_then(|id| id.as_ref()) != Some(undo_id) {
                    return Err("only latest available undo may be applied".into());
                }
            }
            if state.jobs.len() >= 256 {
                let oldest = state
                    .order
                    .iter()
                    .find(|id| state.jobs[*id].snapshot.state.is_terminal() && state.jobs[*id].acknowledged)
                    .cloned()
                    .ok_or("operation history is awaiting outcome acknowledgement; retry after results sync")?;
                state.jobs.remove(&oldest);
                state.order.retain(|id| id != &oldest);
                state.fifo.retain(|id| id != &oldest);
                // Keep requestId -> old jobId as a compact session tombstone.
                // A replay gets an explicit error, never a second file mutation.
            }
            let (kind, total, owner_tab_id, clip_revision, intent) = match &work {
                Work::Operation(r) => {
                    if r.intent.as_deref() == Some("cutPaste")
                        && r.clip_revision.is_some()
                        && state.jobs.values().any(|j| {
                            !j.snapshot.state.is_terminal()
                                && j.snapshot.intent.as_deref() == Some("cutPaste")
                                && j.snapshot.clip_revision == r.clip_revision
                        })
                    {
                        return Err("this cut revision is already queued".into());
                    }
                    (
                        r.kind,
                        r.items.len(),
                        r.owner_tab_id.clone(),
                        r.clip_revision.clone(),
                        r.intent.clone(),
                    )
                }
                Work::Undo { .. } => (OperationKind::Undo, 0, None, None, None),
                Work::Recovery { .. } => (OperationKind::Recovery, 0, None, None, None),
            };
            let id = format!("{}-j-{}", state.session_id, state.next_id);
            state.next_id += 1;
            let snapshot = JobSnapshot {
                session_id: state.session_id.clone(),
                job_id: id.clone(),
                revision: 1,
                request_id: request_id.clone(),
                kind,
                state: JobState::Queued,
                phase: Phase::Preparing,
                owner_tab_id,
                clip_revision,
                intent,
                cancel_requested: false,
                cancelability: Cancelability::Immediate,
                progress: Progress {
                    items_finished: 0,
                    items_total: total,
                    bytes_done: "0".into(),
                    bytes_total: None,
                    current_item_id: None,
                    current_path: None,
                },
                conflict: None,
                outcome_count: 0,
                undo_id: None,
                error: None,
            };
            state.jobs.insert(
                id.clone(),
                Job {
                    snapshot: snapshot.clone(),
                    work,
                    outcomes: vec![],
                    cancel: Arc::new(AtomicBool::new(false)),
                    answer: None,
                    remaining: None,
                    last_progress: Instant::now() - Duration::from_secs(1),
                    acknowledged: false,
                },
            );
            state.order.push(id.clone());
            state.requests.insert(request_id, id.clone());
            state.fifo.push_back(id);
            state.revision += 1;
            snapshot
        };
        (self.shared.emit)(snapshot.clone());
        self.shared.wake.notify_all();
        Ok(snapshot)
    }
    pub fn list(&self) -> QueueSnapshot {
        summary(&self.shared.state.lock().unwrap())
    }
    pub fn resume_admission(&self) {
        let mut state = self.shared.state.lock().unwrap();
        if !state.shutdown && !state.accepting {
            state.accepting = true;
            state.revision += 1;
        }
    }
    /// Atomic exit admission barrier: no job can start after an idle approval.
    pub fn seal_if_idle(&self) -> bool {
        let mut state = self.shared.state.lock().unwrap();
        if busy(&state) {
            return false;
        }
        if state.accepting {
            state.accepting = false;
            state.revision += 1;
        }
        true
    }
    pub fn is_busy(&self) -> bool {
        busy(&self.shared.state.lock().unwrap())
    }
    pub fn get(&self, id: &str) -> Result<JobSnapshot, String> {
        self.shared
            .state
            .lock()
            .unwrap()
            .jobs
            .get(id)
            .map(|j| j.snapshot.clone())
            .ok_or_else(|| "unknown job ID".into())
    }
    pub fn outcomes(&self, id: &str, offset: usize, limit: usize) -> Result<OutcomesPage, String> {
        let state = self.shared.state.lock().unwrap();
        let job = state.jobs.get(id).ok_or("unknown job ID")?;
        if offset > job.outcomes.len() || limit == 0 {
            return Err("invalid outcome page".into());
        }
        Ok(OutcomesPage {
            session_id: state.session_id.clone(),
            job_id: id.into(),
            revision: job.snapshot.revision,
            outcomes: job
                .outcomes
                .iter()
                .skip(offset)
                .take(limit.min(200))
                .cloned()
                .collect(),
            offset,
            total: job.outcomes.len(),
        })
    }
    pub fn acknowledge(&self, id: &str, revision: u64, outcome_count: usize) -> Result<(), String> {
        let mut state = self.shared.state.lock().unwrap();
        let job = state.jobs.get_mut(id).ok_or("unknown job ID")?;
        if !job.snapshot.state.is_terminal()
            || job.snapshot.revision != revision
            || job.outcomes.len() != outcome_count
        {
            return Err("only fully retrieved terminal outcomes may be acknowledged".into());
        }
        job.acknowledged = true;
        Ok(())
    }
    pub fn cancel(&self, id: &str) -> Result<JobSnapshot, String> {
        let snapshot = {
            let mut state = self.shared.state.lock().unwrap();
            let job = state.jobs.get_mut(id).ok_or("unknown job ID")?;
            if job.snapshot.state.is_terminal() || job.snapshot.cancel_requested {
                return Ok(job.snapshot.clone());
            }
            cancel_job(job);
            bump(&mut state, id)
        };
        (self.shared.emit)(snapshot.clone());
        self.shared.wake.notify_all();
        Ok(snapshot)
    }
    pub fn resolve(
        &self,
        id: &str,
        token: &str,
        revision: u64,
        decision: ConflictDecision,
        apply: bool,
    ) -> Result<JobSnapshot, String> {
        let snapshot = {
            let mut state = self.shared.state.lock().unwrap();
            let job = state.jobs.get_mut(id).ok_or("unknown job ID")?;
            let conflict = job.snapshot.conflict.as_ref().ok_or("no active conflict")?;
            if job.snapshot.state != JobState::WaitingConflict
                || conflict.conflict_id != token
                || conflict.revision != revision
                || job.answer.is_some()
            {
                return Err("stale conflict response".into());
            }
            if !conflict.allowed_decisions.contains(&decision)
                && decision != ConflictDecision::Cancel
            {
                return Err("unsupported conflict decision".into());
            }
            if apply && decision != ConflictDecision::Cancel {
                job.remaining = Some((
                    conflict.source_kind.clone(),
                    conflict.destination_kind.clone(),
                    decision,
                ));
            }
            job.answer = Some(decision);
            job.snapshot.conflict = None;
            if decision == ConflictDecision::Cancel {
                job.cancel.store(true, Ordering::Release);
                job.snapshot.cancel_requested = true;
                job.snapshot.state = JobState::Cancelling;
            } else {
                job.snapshot.state = JobState::Running;
            }
            bump(&mut state, id)
        };
        (self.shared.emit)(snapshot.clone());
        self.shared.wake.notify_all();
        Ok(snapshot)
    }
    pub fn recoveries(&self) -> Result<Vec<RecoveryRecord>, String> {
        self.executor.recoveries()
    }
    /// Seal admission and cancel before starting an asynchronous wait.
    pub fn prepare_exit(&self, cancel_remaining: bool) -> QueueSnapshot {
        let (snapshot, changed) = {
            let mut state = self.shared.state.lock().unwrap();
            state.accepting = !cancel_remaining;
            state.revision += 1;
            let ids: Vec<_> = state.order.clone();
            let mut changed = vec![];
            if cancel_remaining {
                for id in ids {
                    let job = state.jobs.get_mut(&id).unwrap();
                    if !job.snapshot.state.is_terminal() && !job.snapshot.cancel_requested {
                        cancel_job(job);
                        changed.push(bump(&mut state, &id));
                    }
                }
            }
            (summary(&state), changed)
        };
        for event in changed {
            (self.shared.emit)(event);
        }
        self.shared.wake.notify_all();
        snapshot
    }
    pub fn wait_idle(&self) -> QueueSnapshot {
        let mut state = self.shared.state.lock().unwrap();
        while busy(&state) {
            state = self.shared.wake.wait(state).unwrap();
        }
        summary(&state)
    }
}
impl Drop for OperationManager {
    fn drop(&mut self) {
        let mut state = self.shared.state.lock().unwrap();
        state.shutdown = true;
        state.accepting = false;
        for job in state.jobs.values_mut() {
            if !job.snapshot.state.is_terminal() {
                cancel_job(job);
            }
        }
        self.shared.wake.notify_all();
    }
}
fn fill_unvisited(job: &mut Job, status: OutcomeStatus) {
    if let Work::Operation(request) = &job.work {
        let visited: HashSet<_> = job.outcomes.iter().map(|o| o.item_id.clone()).collect();
        for item in &request.items {
            if !visited.contains(&item.item_id) {
                let mut outcome = ItemOutcome::new(&item.item_id, status);
                outcome.source = item.source.clone();
                job.outcomes.push(outcome);
            }
        }
    }
    job.snapshot.outcome_count = job.outcomes.len();
    job.snapshot.progress.items_finished = job.outcomes.len();
}
fn cancel_job(job: &mut Job) {
    job.cancel.store(true, Ordering::Release);
    job.snapshot.cancel_requested = true;
    job.snapshot.conflict = None;
    if job.snapshot.state == JobState::Queued {
        fill_unvisited(job, OutcomeStatus::NotStarted);
        job.snapshot.state = JobState::Cancelled;
        job.snapshot.phase = Phase::Finished;
    } else {
        job.snapshot.state = JobState::Cancelling;
    }
}

pub struct OperationContext {
    job_id: String,
    shared: Option<Arc<Shared>>,
    cancel: Arc<AtomicBool>,
    detached_outcomes: Mutex<Vec<ItemOutcome>>,
    detached_decisions: Mutex<VecDeque<ConflictDecision>>,
}
impl OperationContext {
    pub fn detached(job_id: &str) -> Self {
        Self {
            job_id: job_id.into(),
            shared: None,
            cancel: Arc::new(AtomicBool::new(false)),
            detached_outcomes: Mutex::new(vec![]),
            detached_decisions: Mutex::new(VecDeque::new()),
        }
    }
    #[cfg(test)]
    pub fn request_cancel(&self) {
        self.cancel.store(true, Ordering::Release);
        if let Some(shared) = &self.shared {
            shared.wake.notify_all();
        }
    }
    #[cfg(test)]
    pub fn recorded_outcomes(&self) -> Vec<ItemOutcome> {
        self.detached_outcomes.lock().unwrap().clone()
    }
    #[cfg(test)]
    pub fn detached_with_decisions(job_id: &str, decisions: Vec<ConflictDecision>) -> Self {
        let ctx = Self::detached(job_id);
        *ctx.detached_decisions.lock().unwrap() = decisions.into();
        ctx
    }
    pub fn job_id(&self) -> &str {
        &self.job_id
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }
    pub fn checkpoint(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    }
    fn update(&self, change: impl FnOnce(&mut Job) -> bool) {
        let Some(shared) = &self.shared else {
            return;
        };
        let event = {
            let mut state = shared.state.lock().unwrap();
            let job = state.jobs.get_mut(&self.job_id).unwrap();
            if job.snapshot.state.is_terminal() || !change(job) {
                None
            } else {
                Some(bump(&mut state, &self.job_id))
            }
        };
        if let Some(event) = event {
            (shared.emit)(event);
        }
    }
    pub fn set_phase(&self, phase: Phase, cancelability: Cancelability) {
        self.update(|j| {
            if j.snapshot.phase == phase && j.snapshot.cancelability == cancelability {
                return false;
            }
            j.snapshot.phase = phase;
            j.snapshot.cancelability = cancelability;
            true
        });
    }
    pub fn progress(
        &self,
        bytes_done: u64,
        bytes_total: Option<u64>,
        current_item_id: Option<String>,
        current_path: Option<String>,
    ) {
        let Some(shared) = &self.shared else {
            return;
        };
        let event = {
            let mut state = shared.state.lock().unwrap();
            let job = state.jobs.get_mut(&self.job_id).unwrap();
            if job.snapshot.state.is_terminal() {
                return;
            }
            job.snapshot.progress.bytes_done = bytes_done.to_string();
            job.snapshot.progress.bytes_total = bytes_total.map(|n| n.to_string());
            job.snapshot.progress.current_item_id = current_item_id;
            job.snapshot.progress.current_path = current_path;
            let emit = job.last_progress.elapsed() >= Duration::from_millis(100);
            if emit {
                job.last_progress = Instant::now();
            }
            // Even throttled changes receive a revision for authoritative resync.
            let snapshot = bump(&mut state, &self.job_id);
            if emit {
                Some(snapshot)
            } else {
                None
            }
        };
        if let Some(event) = event {
            (shared.emit)(event);
        }
    }

    pub fn record_outcome(&self, mut outcome: ItemOutcome) {
        if self.shared.is_none() {
            self.detached_outcomes.lock().unwrap().push(outcome);
            return;
        }
        self.update(|j| {
            if j.outcomes.iter().any(|o| o.item_id == outcome.item_id) {
                return false;
            }
            if let Work::Operation(r) = &j.work {
                if !r.items.iter().any(|i| i.item_id == outcome.item_id) {
                    return false;
                }
            }
            redact_error(&j.work, &mut outcome.error);
            j.outcomes.push(outcome);
            j.snapshot.outcome_count = j.outcomes.len();
            j.snapshot.progress.items_finished = j.outcomes.len();
            j.snapshot.progress.items_total = j.snapshot.progress.items_total.max(j.outcomes.len());
            true
        });
    }
    pub fn wait_for_conflict(&self, spec: ConflictSpec) -> ConflictDecision {
        if self.is_cancelled() {
            return ConflictDecision::Cancel;
        }
        let Some(shared) = &self.shared else {
            let decision = self
                .detached_decisions
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(ConflictDecision::Skip);
            if decision == ConflictDecision::Cancel {
                self.cancel.store(true, Ordering::Release);
            }
            return decision;
        };
        let event = {
            let mut state = shared.state.lock().unwrap();
            let job = state.jobs.get_mut(&self.job_id).unwrap();
            if self.is_cancelled() || job.snapshot.state.is_terminal() {
                return ConflictDecision::Cancel;
            }
            if let Some((source_kind, destination_kind, decision)) = &job.remaining {
                if source_kind == &spec.source_kind
                    && destination_kind == &spec.destination_kind
                    && spec.allowed_decisions.contains(decision)
                {
                    return *decision;
                }
            }
            let revision = job.snapshot.revision + 1;
            job.snapshot.conflict = Some(Conflict {
                conflict_id: format!("c-{}-{}", self.job_id, revision),
                job_id: self.job_id.clone(),
                revision,
                item_id: spec.item_id,
                source: spec.source,
                destination: spec.destination,
                source_kind: spec.source_kind,
                destination_kind: spec.destination_kind,
                reason: spec.reason,
                allowed_decisions: spec.allowed_decisions,
            });
            job.snapshot.state = JobState::WaitingConflict;
            job.snapshot.cancelability = Cancelability::Immediate;
            job.answer = None;
            bump(&mut state, &self.job_id)
        };
        (shared.emit)(event);
        let mut state = shared.state.lock().unwrap();
        loop {
            if self.is_cancelled() || state.shutdown {
                return ConflictDecision::Cancel;
            }
            if let Some(answer) = state.jobs.get_mut(&self.job_id).unwrap().answer.take() {
                return answer;
            }
            state = shared.wake.wait(state).unwrap();
        }
    }
}
fn redact_error(work: &Work, error: &mut Option<OperationError>) {
    if let (Work::Operation(r), Some(error)) = (work, error) {
        if let Some(password) = &r.options.password {
            if !password.is_empty() {
                error.message = error.message.replace(password, "[redacted]");
            }
        }
    }
}
fn worker(shared: Arc<Shared>, executor: Arc<dyn OperationExecutor>) {
    loop {
        let (id, work, cancel, started) = {
            let mut state = shared.state.lock().unwrap();
            loop {
                if state.shutdown {
                    return;
                }
                if let Some(id) = state.fifo.pop_front() {
                    let job = state.jobs.get_mut(&id).unwrap();
                    if job.snapshot.state.is_terminal() {
                        continue;
                    }
                    job.snapshot.state = JobState::Running;
                    job.snapshot.cancelability = Cancelability::Checkpoint;
                    let work = job.work.clone();
                    let cancel = job.cancel.clone();
                    state.running = Some(id.clone());
                    let started = bump(&mut state, &id);
                    break (id, work, cancel, started);
                }
                shared.wake.notify_all();
                state = shared.wake.wait(state).unwrap();
            }
        };
        (shared.emit)(started);
        let context = OperationContext {
            job_id: id.clone(),
            shared: Some(shared.clone()),
            cancel,
            detached_outcomes: Mutex::new(vec![]),
            detached_decisions: Mutex::new(VecDeque::new()),
        };
        let mut result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            executor.execute(&work, &context)
        }))
        .unwrap_or_else(|_| ExecutionResult {
            error: Some(OperationError {
                code: "executorPanic".into(),
                message: "Operation stopped unexpectedly; inspect recovery records".into(),
                phase: Phase::Finished,
            }),
            ..Default::default()
        });
        redact_error(&work, &mut result.error);
        let finished = {
            let mut state = shared.state.lock().unwrap();
            let job = state.jobs.get_mut(&id).unwrap();
            fill_unvisited(
                job,
                if context.is_cancelled() {
                    OutcomeStatus::NotStarted
                } else {
                    OutcomeStatus::Failed
                },
            );
            let effects = job.outcomes.iter().any(|o| {
                o.published || o.effect_id.is_some() || o.status == OutcomeStatus::Partial
            });
            let partial = job
                .outcomes
                .iter()
                .any(|o| o.status == OutcomeStatus::Partial);
            let failures = result.error.is_some()
                || job
                    .outcomes
                    .iter()
                    .any(|o| o.status == OutcomeStatus::Failed);
            let unfinished = job.outcomes.iter().any(|o| {
                matches!(
                    o.status,
                    OutcomeStatus::NotStarted | OutcomeStatus::Cancelled
                )
            });
            job.snapshot.state = if partial || (effects && (failures || unfinished)) {
                JobState::Partial
            } else if failures {
                JobState::Failed
            } else if unfinished || (context.is_cancelled() && job.outcomes.is_empty()) {
                JobState::Cancelled
            } else {
                JobState::Completed
            };
            job.snapshot.phase = Phase::Finished;
            job.snapshot.cancelability = Cancelability::Immediate;
            job.snapshot.conflict = None;
            job.snapshot.error = result.error;
            job.snapshot.undo_id = result.undo_id.clone().filter(|id| valid_id(id));
            let undo_id = job.snapshot.undo_id.clone();
            if let Work::Undo { undo_id } = &work {
                if result.undo_complete
                    && !failures
                    && state.undo.last().and_then(|id| id.as_ref()) == Some(undo_id)
                {
                    state.undo.pop();
                }
            } else if effects
                && !matches!(
                    &work,
                    Work::Recovery {
                        action: RecoveryAction::DiscardStaging,
                        ..
                    }
                )
            {
                // An effect without a safe inverse is a barrier, not permission
                // to silently undo an older unrelated operation.
                if state.undo.last() != Some(&undo_id) {
                    // Recovery may make an earlier effect undoable again. Promote
                    // its existing ID instead of leaving a duplicate stack entry.
                    if let Some(id) = &undo_id {
                        state.undo.retain(|entry| entry.as_ref() != Some(id));
                    }
                    state.undo.push(undo_id);
                }
            }
            state.running = None;
            bump(&mut state, &id)
        };
        (shared.emit)(finished);
        shared.wake.notify_all();
    }
}

#[cfg(test)]
#[path = "queue_tests.rs"]
mod tests;
