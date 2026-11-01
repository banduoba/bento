//! Wire protocol. Requests are never included in snapshots or debug output.
use serde::{Deserialize, Serialize};

macro_rules! wire_enum { ($name:ident { $($variant:ident),+ $(,)? }) => {
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum $name { $($variant),+ }
}; }
wire_enum!(OperationKind {
    Copy,
    Move,
    Trash,
    Rename,
    Create,
    Zip,
    Undo,
    Recovery
});
wire_enum!(CreateKind {
    Directory,
    Text,
    Markdown,
    Template
});
wire_enum!(JobState {
    Queued,
    Running,
    WaitingConflict,
    Cancelling,
    Completed,
    Partial,
    Failed,
    Cancelled
});
impl JobState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Partial | Self::Failed | Self::Cancelled
        )
    }
}
wire_enum!(Phase {
    Preparing,
    Scanning,
    Copying,
    Metadata,
    Publishing,
    RemovingSource,
    Archiving,
    Undoing,
    Recovering,
    Finished
});
wire_enum!(Cancelability {
    Immediate,
    Checkpoint,
    Finishing
});
wire_enum!(OutcomeStatus {
    Succeeded,
    Noop,
    Skipped,
    Failed,
    Cancelled,
    NotStarted,
    Partial
});
wire_enum!(SourceDisposition {
    Unchanged,
    Removed,
    CleanupIncomplete,
    Unknown
});
wire_enum!(RetryKind {
    None,
    RetryItem,
    FinishSourceCleanup,
    ManualRecovery
});
wire_enum!(ConflictDecision {
    Skip,
    KeepBoth,
    Replace,
    Cancel
});
wire_enum!(RecoveryAction {
    RestoreBackup,
    FinishSourceCleanup,
    DiscardStaging
});

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationRequest {
    pub request_id: String,
    pub kind: OperationKind,
    pub items: Vec<OperationItem>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub options: OperationOptions,
    #[serde(default)]
    pub intent: Option<String>,
    #[serde(default)]
    pub owner_tab_id: Option<String>,
    #[serde(default)]
    pub clip_revision: Option<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationItem {
    pub item_id: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub target_name: Option<String>,
    #[serde(default)]
    pub create_kind: Option<CreateKind>,
}
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationOptions {
    #[serde(default)]
    pub keep_both: bool,
    #[serde(default)]
    pub archive_name: Option<String>,
    #[serde(default)]
    pub separate: bool,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub compression_level: Option<u8>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationError {
    pub code: String,
    pub message: String,
    pub phase: Phase,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemOutcome {
    pub item_id: String,
    pub source: Option<String>,
    pub requested_destination: Option<String>,
    pub actual_destination: Option<String>,
    pub status: OutcomeStatus,
    pub effect_id: Option<String>,
    pub published: bool,
    pub source_disposition: SourceDisposition,
    pub retry: RetryKind,
    pub error: Option<OperationError>,
    pub affected_directories: Vec<String>,
}
impl ItemOutcome {
    pub fn new(item_id: impl Into<String>, status: OutcomeStatus) -> Self {
        Self {
            item_id: item_id.into(),
            source: None,
            requested_destination: None,
            actual_destination: None,
            status,
            effect_id: None,
            published: false,
            source_disposition: SourceDisposition::Unchanged,
            retry: RetryKind::None,
            error: None,
            affected_directories: vec![],
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub items_finished: usize,
    pub items_total: usize,
    /// All byte counts are decimal strings, including small values.
    pub bytes_done: String,
    pub bytes_total: Option<String>,
    pub current_item_id: Option<String>,
    pub current_path: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub conflict_id: String,
    pub job_id: String,
    pub revision: u64,
    pub item_id: String,
    pub source: String,
    pub destination: String,
    pub source_kind: String,
    pub destination_kind: String,
    pub reason: String,
    pub allowed_decisions: Vec<ConflictDecision>,
}
/// Executor describes the current conflict; coordinator generates token/revision.
#[derive(Clone, Debug)]
pub struct ConflictSpec {
    pub item_id: String,
    pub source: String,
    pub destination: String,
    pub source_kind: String,
    pub destination_kind: String,
    pub reason: String,
    pub allowed_decisions: Vec<ConflictDecision>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    /// Admission time in Unix milliseconds; zero denotes a legacy snapshot without a timestamp.
    #[serde(default)]
    pub submitted_at_ms: u64,
    pub session_id: String,
    pub job_id: String,
    pub revision: u64,
    pub request_id: String,
    pub kind: OperationKind,
    pub state: JobState,
    pub phase: Phase,
    pub owner_tab_id: Option<String>,
    pub clip_revision: Option<String>,
    pub intent: Option<String>,
    pub cancel_requested: bool,
    pub cancelability: Cancelability,
    pub progress: Progress,
    pub conflict: Option<Conflict>,
    pub outcome_count: usize,
    pub undo_id: Option<String>,
    pub error: Option<OperationError>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub session_id: String,
    pub revision: u64,
    pub jobs: Vec<JobSnapshot>,
    pub busy: bool,
    pub accepting: bool,
    pub latest_undo_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomesPage {
    pub session_id: String,
    pub job_id: String,
    pub revision: u64,
    pub outcomes: Vec<ItemOutcome>,
    pub offset: usize,
    pub total: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRecord {
    pub recovery_id: String,
    pub description: String,
    pub source: Option<String>,
    pub destination: Option<String>,
    pub actions: Vec<RecoveryAction>,
}
/// Internal work variant; undo/recovery IDs are server-issued and resolved only by executor.
#[derive(Clone, PartialEq, Eq)]
pub enum Work {
    Operation(OperationRequest),
    Undo {
        undo_id: String,
    },
    Recovery {
        recovery_id: String,
        action: RecoveryAction,
    },
}
#[derive(Default)]
pub struct ExecutionResult {
    pub undo_id: Option<String>,
    /// True only when every pending inverse step of Work::Undo completed.
    pub undo_complete: bool,
    pub error: Option<OperationError>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_roundtrip_preserves_password_and_path_spaces() {
        let raw = r#"{"requestId":"req-1","kind":"zip","items":[{"itemId":"i-1","source":"/tmp/ spaced "}],"destination":"/tmp/out","options":{"password":"secret","compressionLevel":9}}"#;
        let request: OperationRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(request.items[0].source.as_deref(), Some("/tmp/ spaced "));
        let encoded = serde_json::to_string(&request).unwrap();
        let decoded: OperationRequest = serde_json::from_str(&encoded).unwrap();
        assert!(request == decoded);
    }
    #[test]
    fn decimal_byte_counts_roundtrip_without_js_precision_loss() {
        let progress = Progress {
            items_finished: 0,
            items_total: 1,
            bytes_done: u64::MAX.to_string(),
            bytes_total: None,
            current_item_id: None,
            current_path: None,
        };
        let json = serde_json::to_value(&progress).unwrap();
        assert_eq!(json["bytesDone"], "18446744073709551615");
        assert_eq!(serde_json::from_value::<Progress>(json).unwrap(), progress);
    }
    #[test]
    fn unknown_request_fields_rejected() {
        assert!(serde_json::from_str::<OperationRequest>(
            r#"{"requestId":"r","kind":"undo","items":[],"backupPath":"/tmp/x"}"#
        )
        .is_err());
    }
}
