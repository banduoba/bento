pub mod queue;
pub mod types;

use queue::OperationManager;
use std::sync::Arc;
use tauri::State;
use types::*;
pub type OperationState = Arc<OperationManager>;

#[tauri::command]
pub fn enqueue_operation(
    state: State<'_, OperationState>,
    request: OperationRequest,
) -> Result<JobSnapshot, String> {
    state.enqueue(request)
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
) -> Result<JobSnapshot, String> {
    state.undo(undo_id, request_id)
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
) -> Result<JobSnapshot, String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.recover(recovery_id, action, request_id))
        .await
        .map_err(|_| "recovery admission failed".to_string())?
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
