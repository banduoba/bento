use super::*;
use queue::{OperationContext, OperationExecutor};
use serde_json::json;

struct NeverExecute;
impl OperationExecutor for NeverExecute {
    fn execute(&self, _: &Work, _: &OperationContext) -> ExecutionResult {
        panic!("rejected admission must never execute");
    }
}
fn manager() -> OperationManager {
    OperationManager::new(Arc::new(NeverExecute), Arc::new(|_| {}))
}
fn assert_definite_rejection(error: OperationError, expected_message: &str) {
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        json!({
            "code": "admissionRejected", "message": expected_message, "phase": "preparing"
        })
    );
    let decoded: OperationError =
        serde_json::from_value(serde_json::to_value(&error).unwrap()).unwrap();
    assert_eq!(decoded, error);
}
#[test]
fn invalid_rename_is_definitively_rejected_without_admitting_a_job() {
    let q = manager();
    let error = enqueue_admission(
        &q,
        json!({
            "requestId": "bad-rename", "kind": "rename",
            "items": [{"itemId": "i-1", "source": "/tmp/a", "targetName": "a/b"}]
        }),
    )
    .unwrap_err();
    assert_definite_rejection(error, "invalid operation request");
    let snapshot = q.list();
    assert!(!snapshot.busy);
    assert!(snapshot.jobs.is_empty());
    assert_eq!(snapshot.revision, 0);
}
#[test]
fn malformed_request_shape_has_safe_structured_rejection_without_payload_echo() {
    let q = manager();
    for request in [
        json!({"requestId": "bad", "kind": "secret-password", "items": [], "options": {"password": "secret-password"}}),
        json!({"requestId": "bad", "kind": "zip", "items": "secret-password", "options": {"password": "secret-password"}}),
        json!({"requestId": "bad", "kind": "zip", "items": [], "secret-password": "secret-password"}),
        json!(null),
    ] {
        let error = enqueue_admission(&q, request).unwrap_err();
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("secret-password"));
        assert_definite_rejection(error, "invalid operation request");
    }
    assert!(q.list().jobs.is_empty());
    assert!(!q.is_busy());
}
#[test]
fn rejected_undo_and_recovery_manager_results_use_the_same_flat_error_contract() {
    let q = manager();
    assert_definite_rejection(
        classify_admission(q.undo("../backup".into(), "undo".into())).unwrap_err(),
        "invalid undo ID",
    );
    assert_definite_rejection(
        classify_admission(q.recover(
            "unknown-record".into(),
            RecoveryAction::RestoreBackup,
            "recover".into(),
        ))
        .unwrap_err(),
        "unknown recovery or unsupported action",
    );
    assert!(q.list().jobs.is_empty());
    assert!(!q.is_busy());
}
#[test]
fn asynchronous_join_failure_is_never_classified_as_definite_rejection() {
    let error = admission_unknown();
    let wire = serde_json::to_value(error).unwrap();
    assert_eq!(wire["code"], "admissionUnknown");
    assert_eq!(wire["phase"], "preparing");
    assert_ne!(wire["code"], "admissionRejected");
}

struct FailsAfterAdmission;
impl OperationExecutor for FailsAfterAdmission {
    fn execute(&self, _: &Work, _: &OperationContext) -> ExecutionResult {
        ExecutionResult {
            error: Some(OperationError {
                code: "filesystem".into(),
                message: "execution failed".into(),
                phase: Phase::Preparing,
            }),
            ..Default::default()
        }
    }
}
#[test]
fn execution_failure_after_admission_remains_an_accepted_job() {
    let q = OperationManager::new(Arc::new(FailsAfterAdmission), Arc::new(|_| {}));
    let accepted = enqueue_admission(
        &q,
        json!({
            "requestId": "valid-rename", "kind": "rename",
            "items": [{"itemId": "i-1", "source": "/tmp/a", "targetName": "b"}]
        }),
    )
    .expect("an executor failure must not become admissionRejected");
    q.wait_idle();
    let terminal = q.get(&accepted.job_id).unwrap();
    assert_eq!(terminal.state, JobState::Failed);
    assert_eq!(terminal.error.unwrap().code, "filesystem");
    assert_eq!(q.list().jobs.len(), 1);
}
