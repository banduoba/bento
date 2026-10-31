pub mod executor;
mod identity;
mod journal;
mod undo;
pub mod queue;
pub mod types;

use queue::OperationManager;
use std::sync::Arc;
use tauri::State;
use types::*;
pub type OperationState = Arc<OperationManager>;

// Only a returned manager Err is proof that this call admitted no new job.
// Transport failures or panics after admission must not use this classification.
fn admission_rejected(message: impl Into<String>) -> OperationError {
    OperationError {
        code: "admissionRejected".into(),
        message: message.into(),
        phase: Phase::Preparing,
    }
}
fn classify_admission(result: Result<JobSnapshot, String>) -> Result<JobSnapshot, OperationError> {
    result.map_err(admission_rejected)
}
fn admission_unknown() -> OperationError {
    OperationError {
        code: "admissionUnknown".into(),
        message: "Could not confirm operation admission; synchronize before retrying".into(),
        phase: Phase::Preparing,
    }
}
fn enqueue_admission(
    manager: &OperationManager,
    request: serde_json::Value,
) -> Result<JobSnapshot, OperationError> {
    // Decode here instead of in Tauri's argument conversion so malformed DTOs
    // receive the same definitive rejection. Never echo serde errors or payloads.
    let request: OperationRequest = serde_json::from_value(request)
        .map_err(|_| admission_rejected("invalid operation request"))?;
    classify_admission(manager.enqueue(request))
}

#[tauri::command]
pub fn enqueue_operation(
    state: State<'_, OperationState>,
    request: serde_json::Value,
) -> Result<JobSnapshot, OperationError> {
    enqueue_admission(state.inner(), request)
}
#[tauri::command]
pub fn list_operation_jobs(state: State<'_, OperationState>) -> QueueSnapshot {
    state.list()
}
#[tauri::command]
pub fn get_operation_job(
    state: State<'_, OperationState>,
    job_id: String,
) -> Result<JobSnapshot, String> {
    state.get(&job_id)
}
#[tauri::command]
pub fn get_operation_outcomes(
    state: State<'_, OperationState>,
    job_id: String,
    offset: usize,
    limit: usize,
) -> Result<OutcomesPage, String> {
    state.outcomes(&job_id, offset, limit)
}
#[tauri::command]
pub fn cancel_operation(
    state: State<'_, OperationState>,
    job_id: String,
) -> Result<JobSnapshot, String> {
    state.cancel(&job_id)
}
#[tauri::command]
pub fn resolve_operation_conflict(
    state: State<'_, OperationState>,
    job_id: String,
    conflict_id: String,
    revision: u64,
    decision: ConflictDecision,
    apply_to_remaining: bool,
) -> Result<JobSnapshot, String> {
    state.resolve(
        &job_id,
        &conflict_id,
        revision,
        decision,
        apply_to_remaining,
    )
}
#[tauri::command]
pub fn undo_operation(
    state: State<'_, OperationState>,
    undo_id: String,
    request_id: String,
) -> Result<JobSnapshot, OperationError> {
    classify_admission(state.undo(undo_id, request_id))
}
#[tauri::command]
pub async fn list_operation_recoveries(
    state: State<'_, OperationState>,
) -> Result<Vec<RecoveryRecord>, String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.recoveries())
        .await
        .map_err(|_| "recovery query failed".to_string())?
}
#[tauri::command]
pub async fn recover_operation(
    state: State<'_, OperationState>,
    recovery_id: String,
    action: RecoveryAction,
    request_id: String,
) -> Result<JobSnapshot, OperationError> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        classify_admission(manager.recover(recovery_id, action, request_id))
    })
    .await
    // Joining can fail after the worker admitted a job. Keep it uncertain.
    .map_err(|_| admission_unknown())?
}
#[tauri::command]
pub async fn prepare_operation_exit(
    state: State<'_, OperationState>,
    cancel_remaining: bool,
) -> Result<QueueSnapshot, String> {
    let manager = state.inner().clone();
    let snapshot = manager.prepare_exit(cancel_remaining);
    if !cancel_remaining {
        return Ok(snapshot);
    }
    tauri::async_runtime::spawn_blocking(move || manager.wait_idle())
        .await
        .map_err(|_| "operation drain failed".to_string())
}

#[tauri::command]
pub fn ack_operation_outcomes(
    state: State<'_, OperationState>,
    job_id: String,
    revision: u64,
    outcome_count: usize,
) -> Result<(), String> {
    state.acknowledge(&job_id, revision, outcome_count)
}

#[cfg(test)]
#[path = "admission_tests.rs"]
mod admission_tests;
