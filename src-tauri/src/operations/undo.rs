//! Inverse effects are identity guarded, run in reverse order, and remember applied steps.
use super::{
    executor::{affected, basename, display, error, invalid, FileExecutor, Point},
    identity::{self, Manifest},
    journal::{self, OwnedRoot, Protected, Record},
    queue::OperationContext,
    types::*,
};
use std::{fs, io, path::PathBuf};
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum EffectKind {
    Created,
    Move,
    IncompleteMove,
}
#[derive(Clone)]
pub(crate) struct Effect {
    pub id: String,
    pub item_id: String,
    pub kind: EffectKind,
    pub source: Option<PathBuf>,
    pub destination: PathBuf,
    pub manifest: Manifest,
    pub source_manifest: Option<Manifest>,
    pub journal_id: String,
    pub backup: Option<Protected>,
    pub inverse_done: bool,
    pub complete: bool,
    pub inverse_destination: Option<PathBuf>,
    pub held: Option<Protected>,
}
impl Effect {
    pub fn new(
        item_id: String,
        kind: EffectKind,
        source: Option<PathBuf>,
        destination: PathBuf,
        manifest: Manifest,
        journal_id: String,
    ) -> Self {
        Self {
            id: journal::id("effect"),
            item_id,
            kind,
            source,
            destination,
            manifest,
            source_manifest: None,
            journal_id,
            backup: None,
            inverse_done: false,
            complete: false,
            inverse_destination: None,
            held: None,
        }
    }
}
impl FileExecutor {
    pub(crate) fn execute_undo(&self, id: &str, c: &OperationContext) -> ExecutionResult {
        let count = self
            .undo
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(Vec::len);
        let Some(count) = count else {
            return ExecutionResult {
                error: Some(error(&invalid("撤销记录不存在"), Phase::Undoing)),
                ..Default::default()
            };
        };
        for index in (0..count).rev() {
            let mut effect = self.undo.lock().unwrap_or_else(|e| e.into_inner())[id][index].clone();
            if effect.complete {
                continue;
            }
            if c.is_cancelled() {
                break;
            }
            c.set_phase(Phase::Undoing, Cancelability::Finishing);
            let mut out = ItemOutcome::new(&effect.item_id, OutcomeStatus::Failed);
            out.source = Some(display(&effect.destination));
            let inverse_before = effect.inverse_done;
            let backup_before = effect.backup.is_some();
            let result = self.undo_effect(&mut effect, c);
            let moved = !inverse_before && effect.inverse_done;
            let restored = backup_before && effect.backup.is_none();
            match result {
                Ok(()) => out.status = OutcomeStatus::Succeeded,
                Err(e) => {
                    out.error = Some(error(&e, Phase::Undoing));
                    out.retry = RetryKind::RetryItem;
                    if moved || restored {
                        out.status = OutcomeStatus::Partial;
                    }
                }
            }
            if moved || restored {
                out.published = true;
                out.effect_id = Some(format!(
                    "{}-inverse-{}",
                    effect.id,
                    if moved { "move" } else { "restore" }
                ));
                out.source_disposition = SourceDisposition::Removed;
                out.actual_destination = if restored {
                    Some(display(&effect.destination))
                } else {
                    effect.inverse_destination.as_deref().map(display)
                };
                out.affected_directories = affected(
                    Some(&effect.destination),
                    effect
                        .inverse_destination
                        .as_deref()
                        .unwrap_or(&effect.destination),
                );
            }
            self.undo
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_mut(id)
                .unwrap()[index] = effect;
            c.record_outcome(out);
        }
        let complete = self.undo.lock().unwrap_or_else(|e| e.into_inner())[id]
            .iter()
            .all(|e| e.complete);
        ExecutionResult {
            undo_complete: complete,
            ..Default::default()
        }
    }
    fn refresh_previous_guards(&self, path: &std::path::Path, previous: &Manifest, new: &Manifest) {
        let mut map = self.undo.lock().unwrap_or_else(|e| e.into_inner());
        for effects in map.values_mut() {
            for effect in effects {
                if effect.destination == path && effect.manifest.same_captured_manifest(previous) {
                    effect.manifest = new.clone();
                }
            }
        }
    }
    fn undo_effect(&self, e: &mut Effect, c: &OperationContext) -> io::Result<()> {
        if e.kind == EffectKind::IncompleteMove {
            return Err(invalid("源清理未完成，请先在恢复操作中处理"));
        }
        let mut record = self.journal.get(&e.journal_id).unwrap_or_else(|| {
            let mut r = Record::new(e.source.clone(), e.destination.clone());
            r.id = e.journal_id.clone();
            r.destination_manifest = Some(e.manifest.clone());
            r
        });
        if !e.inverse_done {
            let target = if let Some(target) = &e.inverse_destination {
                target.clone()
            } else if e.kind == EffectKind::Move {
                e.source.clone().ok_or_else(|| invalid("原始路径缺失"))?
            } else {
                let trash = self.trash_root(&e.destination)?;
                crate::unique_path(&trash, &basename(&e.destination)?)
            };
            if !target.parent().is_some_and(|p| p.is_dir()) {
                return Err(invalid("原始父目录不存在"));
            }
            if !crate::entry_available(&target) {
                return Err(invalid("原始位置已被占用，稍后可重试"));
            }
            e.inverse_destination = Some(target.clone());
            let held = if let Some(held) = &e.held {
                held.clone()
            } else {
                if !e.manifest.matches(&e.destination) {
                    return Err(identity::changed());
                }
                let root = OwnedRoot::create(e.destination.parent().unwrap())?;
                let held = Protected {
                    path: root.path.join("undo"),
                    original: e.destination.clone(),
                    manifest: e.manifest.clone(),
                };
                record.roots.push(root);
                record.protected.push(held.clone());
                record.phase = "undoCapturing".into();
                self.save(&record, c)?;
                self.at(Point::UndoCapture, &e.destination, c)?;
                crate::rename_no_replace(&e.destination, &held.path)?;
                if !e.manifest.matches_captured(&held.path) {
                    let _ = crate::rename_no_replace(&held.path, &e.destination);
                    return Err(identity::changed());
                }
                e.held = Some(held.clone());
                held
            };
            if !held.manifest.matches_captured(&held.path) {
                return Err(identity::changed());
            }
            record.phase = "undoMoving".into();
            self.save(&record, c)?;
            match crate::relocate(&held.path, &target) {
                Ok(()) => {}
                Err(err) => {
                    // A cross-volume inverse may have published before captured-source cleanup failed.
                    // Keep both paths and block replay; recovery retains the unique object.
                    if crate::published_destination(&err).is_some() {
                        record.phase = "undoPublishedPartial".into();
                        let _ = self.journal.save(&record);
                        return Err(err);
                    }
                    if crate::rename_no_replace(&held.path, &e.destination).is_ok() {
                        e.held = None;
                    }
                    return Err(err);
                }
            }
            if e.kind == EffectKind::Move {
                if let Some(previous) = &e.source_manifest {
                    let restored = Manifest::capture(&target, &|| Ok(()))?;
                    if !held.manifest.same_contents(&restored) {
                        return Err(identity::changed());
                    }
                    self.refresh_previous_guards(&target, previous, &restored);
                }
            }
            e.inverse_done = true;
            e.held = None;
            record.protected.retain(|p| p.path != held.path);
            record.phase = "undoMoved".into();
            self.save(&record, c)?;
            self.at(Point::UndoMoved, &target, c)?;
        }
        if let Some(backup) = e.backup.clone() {
            if !backup.manifest.matches_captured(&backup.path) {
                return Err(identity::changed());
            }
            if !backup.original.parent().is_some_and(|p| p.is_dir()) {
                return Err(invalid("原始父目录不存在"));
            }
            record.phase = "restoringBackup".into();
            self.save(&record, c)?;
            crate::rename_no_replace(&backup.path, &backup.original)?;
            let restored = Manifest::capture(&backup.original, &|| Ok(()))?;
            self.refresh_previous_guards(&backup.original, &backup.manifest, &restored);
            record.protected.retain(|p| p.path != backup.path);
            e.backup = None;
            self.save(&record, c)?;
        }
        e.complete = true;
        self.finish_record(&record);
        Ok(())
    }
    pub(crate) fn execute_recovery(
        &self,
        id: &str,
        action: RecoveryAction,
        c: &OperationContext,
    ) -> ExecutionResult {
        let Some(mut record) = self.journal.get(id) else {
            return ExecutionResult {
                error: Some(error(&invalid("恢复记录不存在"), Phase::Recovering)),
                ..Default::default()
            };
        };
        let mut out = ItemOutcome::new(id, OutcomeStatus::Failed);
        out.source = record.source.as_deref().map(display);
        out.requested_destination = Some(display(&record.destination));
        c.set_phase(Phase::Recovering, Cancelability::Finishing);
        let mut recovered_undo = None;
        let result = (|| {
            if !record.recovery().actions.contains(&action) {
                return Err(invalid("此恢复操作不可用"));
            }
            match action {
                RecoveryAction::FinishSourceCleanup => {
                    self.finish_source(&mut record, c)?;
                    // Convert the existing incomplete effect; never copy a second destination.
                    for (undo_id, effects) in self
                        .undo
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .iter_mut()
                    {
                        for e in effects {
                            if e.journal_id == id && e.kind == EffectKind::IncompleteMove {
                                e.kind = EffectKind::Move;
                                recovered_undo = Some(undo_id.clone());
                            }
                        }
                    }
                    out.actual_destination = Some(display(&record.destination));
                    out.source_disposition = SourceDisposition::Removed;
                }
                RecoveryAction::RestoreBackup => {
                    let originals = record.protected.clone();
                    for protected in originals.iter().rev() {
                        if fs::symlink_metadata(&protected.path).is_err() {
                            // Crash after the restore rename but before journaling: recognize identity.
                            if protected.manifest.matches_captured(&protected.original) {
                                record.protected.retain(|p| p.path != protected.path);
                                continue;
                            }
                            return Err(identity::changed());
                        }
                        if !protected.manifest.matches_captured(&protected.path) {
                            return Err(identity::changed());
                        }
                        if !protected.original.parent().is_some_and(|p| p.is_dir()) {
                            return Err(invalid("原始父目录不存在"));
                        }
                        // Restore is exact. An occupied target is left intact; undo can first move a verified published copy to Trash.
                        self.save(&record, c)?;
                        crate::rename_no_replace(&protected.path, &protected.original)?;
                        out.actual_destination = Some(display(&protected.original));
                        record.protected.retain(|p| p.path != protected.path);
                        self.save(&record, c)?;
                    }
                }
                RecoveryAction::DiscardStaging => {
                    if !record.protected.is_empty() || record.cleanup_pending {
                        return Err(invalid("不能丢弃受保护的数据"));
                    }
                    // Only copy-generated staging is disposable; published destinations are never touched.
                    for root in &record.roots {
                        root.cleanup()?;
                    }
                }
            }
            self.finish_record(&record);
            Ok(())
        })();
        match result {
            Ok(()) => {
                out.status = OutcomeStatus::Succeeded;
                out.published = true;
                out.effect_id = Some(journal::id("recovered"));
                out.affected_directories = affected(record.source.as_deref(), &record.destination);
            }
            Err(e) => {
                out.error = Some(error(&e, Phase::Recovering));
                out.retry = RetryKind::ManualRecovery;
            }
        }
        c.record_outcome(out);
        ExecutionResult {
            undo_id: recovered_undo,
            ..Default::default()
        }
    }
}
