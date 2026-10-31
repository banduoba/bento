//! Inverse effects are identity guarded, run in reverse order, and remember applied steps.
use super::{
    executor::{
        affected, basename, checkpoint, display, error, invalid, remove_captured, rename_prepared,
        FileExecutor, Point,
    },
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
    RestoreOnly,
}
#[derive(Clone)]
pub(crate) struct AncestorReceipt {
    pub undo_id: String,
    pub effect_id: String,
    pub root: PathBuf,
    pub before: Manifest,
}
#[derive(Clone)]
pub(crate) struct PendingInverseReceipt {
    receipts: Vec<AncestorReceipt>,
    backup: Option<Protected>,
    paths: Vec<PathBuf>,
    inverse_before: bool,
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
    pub needs_receipt: bool,
    pub inverse_cleanup_pending: bool,
    pub inverse_guard: Option<Manifest>,
    pub complete: bool,
    pub inverse_destination: Option<PathBuf>,
    pub held: Option<Protected>,
    pub ancestor_receipts: Vec<AncestorReceipt>,
    pub pending_inverse_receipt: Option<PendingInverseReceipt>,
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
            needs_receipt: false,
            inverse_cleanup_pending: false,
            inverse_guard: None,
            complete: false,
            inverse_destination: None,
            held: None,
            ancestor_receipts: vec![],
            pending_inverse_receipt: None,
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
            if effect.complete && effect.pending_inverse_receipt.is_none() {
                continue;
            }
            if c.is_cancelled() {
                break;
            }
            c.set_phase(Phase::Scanning, Cancelability::Checkpoint);
            let mut out = ItemOutcome::new(&effect.item_id, OutcomeStatus::Failed);
            out.source = Some(display(&effect.destination));
            let inverse_before = effect.inverse_done;
            let backup_snapshot = effect.backup.clone();
            let backup_before = backup_snapshot.is_some();
            let mut paths = vec![effect.destination.clone()];
            if let Some(p) = &effect.source {
                paths.push(p.clone());
            }
            if let Some(p) = &backup_snapshot {
                paths.push(p.original.clone());
            }
            // The pre-inverse snapshot belongs to this effect until its exact delta
            // has been checked. A later retry cannot reconstruct it from changed disk.
            let mut result = if effect.pending_inverse_receipt.is_none() {
                self.capture_ancestor_receipts(&paths, c)
                    .map(|mut receipts| {
                        receipts.retain(|r| r.effect_id != effect.id);
                        effect.pending_inverse_receipt = Some(PendingInverseReceipt {
                            receipts,
                            backup: backup_snapshot.clone(),
                            paths,
                            inverse_before,
                        });
                    })
            } else {
                Ok(())
            };
            if result.is_ok() && !effect.complete {
                result = self.undo_effect(&mut effect, c);
            }
            if let Some(pending) = &effect.pending_inverse_receipt {
                let changed = (!pending.inverse_before && effect.inverse_done)
                    || (pending.backup.is_some() && effect.backup.is_none());
                if !changed {
                    effect.pending_inverse_receipt = None;
                } else if result.is_ok() && effect.complete {
                    result = self.finish_inverse_receipt(&effect, pending, c);
                    if result.is_ok() {
                        effect.pending_inverse_receipt = None;
                    }
                }
            }
            let moved = !inverse_before && effect.inverse_done;
            let restored = backup_before && effect.backup.is_none();
            match result {
                Ok(()) => out.status = OutcomeStatus::Succeeded,
                Err(e) => {
                    if c.is_cancelled() {
                        out.status = OutcomeStatus::Cancelled;
                    }
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
            .all(|e| e.complete && e.pending_inverse_receipt.is_none());
        ExecutionResult {
            undo_complete: complete,
            ..Default::default()
        }
    }
    fn finish_inverse_receipt(
        &self,
        effect: &Effect,
        pending: &PendingInverseReceipt,
        c: &OperationContext,
    ) -> io::Result<()> {
        let mut removed = vec![];
        let mut added = vec![];
        if !pending.inverse_before && effect.inverse_done {
            removed.push((effect.destination.clone(), effect.manifest.clone()));
            if let (Some(path), Some(guard)) = (&effect.inverse_destination, &effect.inverse_guard)
            {
                added.push((path.clone(), guard.clone()));
            }
        }
        if let Some(backup) = &pending.backup {
            if effect.backup.is_none() {
                added.push((backup.original.clone(), backup.manifest.clone()));
            }
        }
        self.try_apply_ancestor_receipts(&pending.receipts, &removed, &added, &pending.paths, c)?;
        // A forward post-receipt can also have been cancelled. This alternative
        // is usable only while the owner's exact pre-forward guard still matches.
        let mut original_removed = vec![];
        let mut original_added = vec![];
        if effect.kind == EffectKind::Move {
            if let (Some(path), Some(old), Some(new)) = (
                &effect.source,
                &effect.source_manifest,
                &effect.inverse_guard,
            ) {
                original_removed.push((path.clone(), old.clone()));
                original_added.push((path.clone(), new.clone()));
            }
        }
        if let Some(backup) = &pending.backup {
            if effect.backup.is_none() {
                original_removed.push((backup.original.clone(), backup.manifest.clone()));
                original_added.push((backup.original.clone(), backup.manifest.clone()));
            }
        }
        self.try_apply_ancestor_receipts(
            &effect.ancestor_receipts,
            &original_removed,
            &original_added,
            &pending.paths,
            c,
        )
    }
    pub(crate) fn capture_ancestor_receipts(
        &self,
        paths: &[PathBuf],
        c: &OperationContext,
    ) -> io::Result<Vec<AncestorReceipt>> {
        let candidates = {
            let map = self.undo.lock().unwrap_or_else(|e| e.into_inner());
            map.iter()
                .flat_map(|(id, effects)| {
                    effects
                        .iter()
                        .filter(|e| {
                            !e.complete && paths.iter().any(|p| p.starts_with(&e.destination))
                        })
                        .map(|e| AncestorReceipt {
                            undo_id: id.clone(),
                            effect_id: e.id.clone(),
                            root: e.destination.clone(),
                            before: e.manifest.clone(),
                        })
                })
                .collect::<Vec<_>>()
        };
        let mut receipts = vec![];
        for candidate in candidates {
            match self.scan_manifest(&candidate.root, c, Point::AncestorVerify) {
                Ok(actual) if actual == candidate.before => receipts.push(candidate),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => return Err(e),
                _ => {}
            }
        }
        Ok(receipts)
    }
    pub(crate) fn apply_ancestor_receipts(
        &self,
        receipts: &[AncestorReceipt],
        removals: &[(PathBuf, Manifest)],
        additions: &[(PathBuf, Manifest)],
        touches: &[PathBuf],
        c: &OperationContext,
    ) {
        for receipt in receipts {
            let _ = self.try_apply_ancestor_receipts(
                std::slice::from_ref(receipt),
                removals,
                additions,
                touches,
                c,
            );
        }
    }
    fn try_apply_ancestor_receipts(
        &self,
        receipts: &[AncestorReceipt],
        removals: &[(PathBuf, Manifest)],
        additions: &[(PathBuf, Manifest)],
        touches: &[PathBuf],
        c: &OperationContext,
    ) -> io::Result<()> {
        for receipt in receipts {
            // A previous attempt may already have amended this owner before a later
            // scan failed. Never apply the same delta twice or replace a newer guard.
            let current = self
                .undo
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&receipt.undo_id)
                .and_then(|v| v.iter().find(|e| e.id == receipt.effect_id))
                .is_some_and(|e| e.manifest == receipt.before);
            if !current {
                continue;
            }
            let actual = self.scan_manifest(&receipt.root, c, Point::AncestorVerify)?;
            let Some(amended) =
                receipt
                    .before
                    .amended(&receipt.root, removals, additions, touches, &actual)
            else {
                continue;
            };
            let mut map = self.undo.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(e) = map
                .get_mut(&receipt.undo_id)
                .and_then(|v| v.iter_mut().find(|e| e.id == receipt.effect_id))
            {
                if e.manifest == receipt.before {
                    e.manifest = amended;
                }
            }
        }
        Ok(())
    }
    pub(crate) fn apply_forward_receipts(
        &self,
        e: &Effect,
        out: &ItemOutcome,
        c: &OperationContext,
    ) {
        if e.needs_receipt || e.kind == EffectKind::IncompleteMove {
            return;
        }
        let mut removed = vec![];
        let mut added = vec![];
        if let Some(p) = &e.backup {
            removed.push((p.original.clone(), p.manifest.clone()));
        }
        if e.kind == EffectKind::Move {
            if let (Some(path), Some(guard)) = (&e.source, &e.source_manifest) {
                removed.push((path.clone(), guard.clone()));
            }
        }
        if out.published {
            added.push((e.destination.clone(), e.manifest.clone()));
        }
        self.apply_ancestor_receipts(&e.ancestor_receipts, &removed, &added, &[], c);
    }
    pub(crate) fn refresh_previous_guards(
        &self,
        path: &std::path::Path,
        previous: &Manifest,
        new: &Manifest,
    ) {
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
        let mut committed_this_attempt = false;
        if e.needs_receipt {
            let actual = self.scan_manifest(&e.destination, c, Point::UndoVerify)?;
            if !e.manifest.same_captured_manifest(&actual) {
                return Err(identity::changed());
            }
            e.manifest = actual;
            e.needs_receipt = false;
        }
        if e.kind != EffectKind::RestoreOnly && e.inverse_done && e.inverse_guard.is_none() {
            let target = e
                .inverse_destination
                .as_ref()
                .ok_or_else(identity::changed)?;
            let actual = self.scan_manifest(target, c, Point::UndoVerify)?;
            let expected = record
                .incoming_manifest
                .as_ref()
                .filter(|_| record.destination == *target)
                .unwrap_or(&e.manifest);
            if !expected.same_captured_manifest(&actual) {
                return Err(identity::changed());
            }
            e.inverse_guard = Some(actual.clone());
            record.destination_manifest = Some(actual);
        }
        if e.inverse_cleanup_pending {
            self.finish_inverse_cleanup(e, &mut record, c, false)?;
            if e.kind == EffectKind::Move {
                if let Some(previous) = &e.source_manifest {
                    self.refresh_previous_guards(
                        e.inverse_destination.as_ref().unwrap(),
                        previous,
                        e.inverse_guard.as_ref().unwrap(),
                    );
                }
            }
        }
        if e.kind != EffectKind::RestoreOnly && !e.inverse_done {
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
                let actual = self.scan_manifest(&held.path, c, Point::UndoVerify)?;
                if !held.manifest.same_captured_manifest(&actual) {
                    return Err(identity::changed());
                }
                checkpoint(c)?;
                c.set_phase(Phase::Undoing, Cancelability::Finishing);
                held.clone()
            } else {
                if self.scan_manifest(&e.destination, c, Point::UndoVerify)? != e.manifest {
                    return Err(identity::changed());
                }
                let root = OwnedRoot::create(e.destination.parent().unwrap())?;
                let held = Protected {
                    path: root.path.join("undo"),
                    original: e.destination.clone(),
                    manifest: e.manifest.clone(),
                };
                record.roots.push(root.clone());
                record.protected.push(held.clone());
                record.phase = "undoCapturing".into();
                let capture = (|| {
                    self.save(&record, c)?;
                    self.at(Point::UndoCapture, &e.destination, c)?;
                    checkpoint(c)?;
                    c.set_phase(Phase::Undoing, Cancelability::Finishing);
                    rename_prepared(&e.destination, &held.path)
                })();
                if let Err(err) = capture {
                    // Only an absent captured object permits disposing this preparation.
                    // Earlier replacement backups remain owned by their existing roots.
                    if fs::symlink_metadata(&held.path)
                        .is_err_and(|e| e.kind() == io::ErrorKind::NotFound)
                    {
                        record.protected.retain(|p| p.path != held.path);
                        if root.cleanup().is_ok() {
                            record.roots.retain(|r| r.path != root.path);
                        }
                        self.finish_record(&record);
                    }
                    return Err(err);
                }
                if !e.manifest.matches_captured(&held.path) {
                    let _ = rename_prepared(&held.path, &e.destination);
                    return Err(identity::changed());
                }
                e.held = Some(held.clone());
                held
            };
            committed_this_attempt = true;
            record.phase = "undoMoving".into();
            self.save(&record, c)?;
            match self.move_inverse(e, &held, &target, &mut record, c) {
                Ok(()) => {}
                Err(err) => {
                    if !e.inverse_done {
                        if rename_prepared(&held.path, &e.destination).is_ok() {
                            e.held = None;
                            record.protected.retain(|p| p.path != held.path);
                            if let Ok(current) = Manifest::capture(&e.destination, &|| Ok(())) {
                                if e.manifest.same_captured_manifest(&current) {
                                    e.manifest = current;
                                }
                            }
                        }
                    }
                    let _ = self.journal.save(&record);
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
                    record.protected.retain(|p| {
                        !(p.original == target
                            && p.path == e.destination
                            && p.manifest.same_captured_manifest(&restored))
                    });
                }
            }
            record.phase = "undoMoved".into();
            self.save(&record, c)?;
            self.at(Point::UndoMoved, &target, c)?;
        }
        if let Some(backup) = e.backup.clone() {
            let actual = if committed_this_attempt {
                Manifest::capture(&backup.path, &|| Ok(()))?
            } else {
                self.scan_manifest(&backup.path, c, Point::UndoVerify)?
            };
            if !backup.manifest.same_captured_manifest(&actual) {
                return Err(identity::changed());
            }
            if !committed_this_attempt {
                checkpoint(c)?;
                c.set_phase(Phase::Undoing, Cancelability::Finishing);
            }
            if !backup.original.parent().is_some_and(|p| p.is_dir()) {
                return Err(invalid("原始父目录不存在"));
            }
            record.phase = "restoringBackup".into();
            self.save(&record, c)?;
            crate::rename_no_replace(&backup.path, &backup.original)?;
            e.backup = None;
            record.protected.retain(|p| p.path != backup.path);
            let restored = Manifest::capture(&backup.original, &|| Ok(()))?;
            self.refresh_previous_guards(&backup.original, &backup.manifest, &restored);
            self.save(&record, c)?;
        }
        e.complete = true;
        self.finish_record(&record);
        Ok(())
    }
    fn move_inverse(
        &self,
        e: &mut Effect,
        held: &Protected,
        target: &std::path::Path,
        record: &mut Record,
        c: &OperationContext,
    ) -> io::Result<()> {
        let renamed = self
            .at(Point::UndoRename, target, c)
            .and_then(|_| rename_prepared(&held.path, target));
        match renamed {
            Ok(()) => {
                e.inverse_done = true;
                e.held = None;
                record.protected.retain(|p| p.path != held.path);
                let actual = Manifest::capture(target, &|| Ok(()))?;
                if !held.manifest.same_captured_manifest(&actual) {
                    return Err(identity::changed());
                }
                e.inverse_guard = Some(actual);
                return Ok(());
            }
            Err(err) if crate::is_exdev(&err) => {}
            Err(err) if crate::published_destination(&err).is_some() => {
                e.inverse_done = true;
                return Err(err);
            }
            Err(err) => return Err(err),
        }
        let root = OwnedRoot::create(target.parent().unwrap())?;
        let incoming = root.path.join("inverse");
        record.roots.push(root.clone());
        record.incoming = Some(incoming.clone());
        record.phase = "inverseCopying".into();
        self.save(record, c)?;
        self.copy_tree(&held.path, &incoming, c, &e.item_id, &mut 0)?;
        let prepared = self.scan_manifest(&incoming, c, Point::PreparedVerify)?;
        let source = self.scan_manifest(&held.path, c, Point::SourceVerify)?;
        if !held.manifest.same_contents(&prepared) || !held.manifest.same_captured_manifest(&source)
        {
            return Err(identity::changed());
        }
        record.incoming_manifest = Some(prepared.clone());
        record.source = Some(held.path.clone());
        record.source_manifest = Some(source);
        record.destination = target.to_path_buf();
        record.move_intent = true;
        record.phase = "inversePrepared".into();
        self.save(record, c)?;
        checkpoint(c)?;
        c.set_phase(Phase::Undoing, Cancelability::Finishing);
        if let Err(err) = rename_prepared(&incoming, target) {
            if crate::published_destination(&err).is_some() {
                e.inverse_done = true;
                e.inverse_cleanup_pending = true;
            }
            return Err(err);
        }
        e.inverse_done = true;
        e.inverse_cleanup_pending = true;
        let published = Manifest::capture(target, &|| Ok(()))?;
        if !prepared.same_captured_manifest(&published) {
            return Err(identity::changed());
        }
        e.inverse_guard = Some(published.clone());
        record.destination_manifest = Some(published);
        record.cleanup_pending = true;
        record.phase = "inversePublished".into();
        self.save(record, c)?;
        self.finish_inverse_cleanup(e, record, c, true)
    }
    fn finish_inverse_cleanup(
        &self,
        e: &mut Effect,
        record: &mut Record,
        c: &OperationContext,
        protected: bool,
    ) -> io::Result<()> {
        let target = e
            .inverse_destination
            .as_ref()
            .ok_or_else(identity::changed)?;
        let actual = if protected {
            Manifest::capture(target, &|| Ok(()))?
        } else {
            self.scan_manifest(target, c, Point::UndoVerify)?
        };
        if e.inverse_guard.as_ref() != Some(&actual) {
            return Err(identity::changed());
        }
        let held = e.held.as_ref().ok_or_else(identity::changed)?;
        let remaining = if protected {
            Manifest::capture(&held.path, &|| Ok(()))?
        } else {
            self.scan_manifest(&held.path, c, Point::UndoVerify)?
        };
        if !held.manifest.remaining_agrees(&remaining) {
            return Err(identity::changed());
        }
        if !protected {
            checkpoint(c)?;
            c.set_phase(Phase::Undoing, Cancelability::Finishing);
        }
        self.at(Point::UndoSourceCleanup, &held.path, c)?;
        remove_captured(&held.path)?;
        record.protected.retain(|p| p.path != held.path);
        record.cleanup_pending = false;
        record.phase = "inverseSourceRemoved".into();
        e.held = None;
        e.inverse_cleanup_pending = false;
        self.save(record, c)
    }
    fn reconcile_recovered_owner(
        &self,
        journal_id: &str,
        apply: impl Fn(&mut Effect),
    ) -> Option<String> {
        let mut found = None;
        let mut map = self.undo.lock().unwrap_or_else(|e| e.into_inner());
        for (undo_id, effects) in map.iter_mut() {
            for e in effects {
                if e.journal_id == journal_id {
                    apply(e);
                    found = Some(undo_id.clone());
                }
            }
        }
        found
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
        c.set_phase(Phase::Scanning, Cancelability::Checkpoint);
        let mut recovered_undo = None;
        let mut mutated = false;
        let owner_before = self
            .undo
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .flatten()
            .find(|e| e.journal_id == id)
            .cloned();
        let destination_before = record.destination.clone();
        let manifest_before = record.destination_manifest.clone();
        let mut ancestor_receipts = vec![];
        let mut restored_entries = vec![];
        let mut disposed_incoming = false;
        let mut receipt_paths = vec![record.destination.clone()];
        receipt_paths.extend(record.source.iter().cloned());
        receipt_paths.extend(record.protected.iter().map(|p| p.original.clone()));
        let result = (|| {
            ancestor_receipts = self.capture_ancestor_receipts(&receipt_paths, c)?;
            if record.destination_manifest.is_none() && record.phase.starts_with("published") {
                let expected = record
                    .incoming_manifest
                    .as_ref()
                    .or(record.source_manifest.as_ref())
                    .ok_or_else(identity::changed)?;
                let actual = self.scan_manifest(&record.destination, c, Point::SourceVerify)?;
                if !expected.same_captured_manifest(&actual) {
                    return Err(identity::changed());
                }
                record.destination_manifest = Some(actual);
                self.save(&record, c)?;
            }
            if !record.recovery().actions.contains(&action) {
                return Err(invalid("此恢复操作不可用"));
            }
            match action {
                RecoveryAction::FinishSourceCleanup => {
                    let settled = self.finish_source(&mut record, c, false);
                    mutated = settled.is_ok()
                        || record.phase == "sourceRemoved"
                        || record.protected.iter().any(|p| {
                            record.source.as_ref() == Some(&p.original)
                                && fs::symlink_metadata(&p.path).is_ok()
                        });
                    if record.cleanup_pending {
                        return settled;
                    }
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
                            if e.journal_id == id && e.inverse_cleanup_pending {
                                e.inverse_cleanup_pending = false;
                                e.held = None;
                                recovered_undo = Some(undo_id.clone());
                            }
                        }
                    }
                    out.actual_destination = Some(display(&record.destination));
                    out.source_disposition = SourceDisposition::Removed;
                    settled?;
                }
                RecoveryAction::RestoreBackup => {
                    // Reversing an incomplete move must retain a complete source before
                    // disposing its published copy. A partially deleted captured tree is
                    // handled by FinishSourceCleanup, never adopted as a full source.
                    if record.cleanup_pending {
                        let source = record.source.as_ref().ok_or_else(identity::changed)?;
                        let expected = record
                            .source_manifest
                            .as_ref()
                            .ok_or_else(identity::changed)?;
                        let held = record.protected.iter().find(|p| {
                            p.original == *source && fs::symlink_metadata(&p.path).is_ok()
                        });
                        let path = held.map(|p| p.path.as_path()).unwrap_or(source);
                        let actual = self.scan_manifest(path, c, Point::SourceVerify)?;
                        if !expected.same_captured_manifest(&actual) {
                            return Err(identity::changed());
                        }
                    }
                    // After a replacement, the old target may be restored over our own
                    // still-verified incoming object by moving that object to Trash first.
                    if let Some(backup) = record
                        .protected
                        .iter()
                        .find(|p| p.original == record.destination)
                        .cloned()
                    {
                        if fs::symlink_metadata(&record.destination).is_ok()
                            && fs::symlink_metadata(&backup.path).is_ok()
                        {
                            let manifest = record
                                .destination_manifest
                                .clone()
                                .ok_or_else(identity::changed)?;
                            if self.scan_manifest(&record.destination, c, Point::UndoVerify)?
                                != manifest
                            {
                                return Err(identity::changed());
                            }
                            let owner = self
                                .undo
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .values()
                                .flatten()
                                .find(|e| e.journal_id == id)
                                .cloned();
                            let mut inverse = owner
                                .filter(|e| {
                                    matches!(e.kind, EffectKind::Created | EffectKind::Move)
                                })
                                .unwrap_or_else(|| {
                                    Effect::new(
                                        id.into(),
                                        EffectKind::Created,
                                        None,
                                        record.destination.clone(),
                                        manifest,
                                        record.id.clone(),
                                    )
                                });
                            inverse.backup = Some(backup.clone());
                            let restored = self.undo_effect(&mut inverse, c);
                            mutated = inverse.inverse_done || inverse.backup.is_none();
                            disposed_incoming = inverse.inverse_done;
                            if inverse.backup.is_none() {
                                restored_entries
                                    .push((backup.original.clone(), backup.manifest.clone()));
                            }
                            if inverse.kind == EffectKind::Move && inverse.inverse_done {
                                if let (Some(path), Some(manifest)) =
                                    (&inverse.inverse_destination, &inverse.inverse_guard)
                                {
                                    restored_entries.push((path.clone(), manifest.clone()));
                                }
                            }
                            if mutated {
                                recovered_undo = self.reconcile_recovered_owner(id, |e| {
                                    e.inverse_done = inverse.inverse_done;
                                    e.inverse_guard = inverse.inverse_guard.clone();
                                    e.inverse_destination = inverse.inverse_destination.clone();
                                    e.inverse_cleanup_pending = inverse.inverse_cleanup_pending;
                                    e.held = inverse.held.clone();
                                    e.backup = inverse.backup.clone();
                                    if e.kind != EffectKind::IncompleteMove {
                                        e.complete = inverse.complete;
                                    }
                                });
                            }
                            out.actual_destination = if inverse.backup.is_none() {
                                Some(display(&record.destination))
                            } else {
                                inverse.inverse_destination.as_deref().map(display)
                            };
                            if let Some(target) = &inverse.inverse_destination {
                                out.affected_directories =
                                    affected(Some(&record.destination), target);
                            }
                            record = self.journal.get(id).unwrap_or_else(|| {
                                let mut done = record.clone();
                                done.protected.clear();
                                done
                            });
                            if inverse.backup.is_none() {
                                record
                                    .protected
                                    .retain(|p| p.original != record.destination);
                            }
                            restored?;
                        }
                    }
                    let originals = record.protected.clone();
                    for protected in originals.iter().rev() {
                        if fs::symlink_metadata(&protected.path).is_err() {
                            // Crash after the restore rename but before journaling: recognize identity.
                            let actual = if mutated {
                                Manifest::capture(&protected.original, &|| Ok(()))?
                            } else {
                                self.scan_manifest(&protected.original, c, Point::UndoVerify)?
                            };
                            if protected.manifest.same_captured_manifest(&actual) {
                                record.protected.retain(|p| p.path != protected.path);
                                restored_entries
                                    .push((protected.original.clone(), protected.manifest.clone()));
                                recovered_undo = self.reconcile_recovered_owner(id, |e| {
                                    if e.kind == EffectKind::IncompleteMove
                                        && !disposed_incoming
                                        && e.backup.is_none()
                                        && e.source.as_ref() == Some(&protected.original)
                                    {
                                        e.kind = EffectKind::Created;
                                        e.source = None;
                                        e.source_manifest = None;
                                        e.complete = false;
                                    }
                                    if e.backup.as_ref().is_some_and(|p| p.path == protected.path) {
                                        e.backup = None;
                                        if e.kind == EffectKind::RestoreOnly {
                                            e.complete = true;
                                        }
                                    }
                                });
                                continue;
                            }
                            return Err(identity::changed());
                        }
                        let actual = if mutated {
                            Manifest::capture(&protected.path, &|| Ok(()))?
                        } else {
                            self.scan_manifest(&protected.path, c, Point::UndoVerify)?
                        };
                        if !protected.manifest.same_captured_manifest(&actual) {
                            return Err(identity::changed());
                        }
                        if !protected.original.parent().is_some_and(|p| p.is_dir()) {
                            return Err(invalid("原始父目录不存在"));
                        }
                        // Restore is exact. An occupied target is left intact; undo can first move a verified published copy to Trash.
                        self.save(&record, c)?;
                        if !mutated {
                            checkpoint(c)?;
                            c.set_phase(Phase::Recovering, Cancelability::Finishing);
                        }
                        rename_prepared(&protected.path, &protected.original)?;
                        mutated = true;
                        restored_entries
                            .push((protected.original.clone(), protected.manifest.clone()));
                        recovered_undo = self.reconcile_recovered_owner(id, |e| {
                            if e.kind == EffectKind::IncompleteMove
                                && !disposed_incoming
                                && e.backup.is_none()
                                && e.source.as_ref() == Some(&protected.original)
                            {
                                e.kind = EffectKind::Created;
                                e.source = None;
                                e.source_manifest = None;
                                e.complete = false;
                            }
                            if e.backup.as_ref().is_some_and(|p| p.path == protected.path) {
                                e.backup = None;
                                if e.kind == EffectKind::RestoreOnly {
                                    e.complete = true;
                                }
                            }
                        });
                        out.actual_destination = Some(display(&protected.original));
                        record.protected.retain(|p| p.path != protected.path);
                        record.cleanup_pending = false;
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
            if action == RecoveryAction::RestoreBackup && record.protected.is_empty() {
                // The full source was verified before reversing a pending move, and all
                // protected originals have now been restored. No source deletion remains.
                record.cleanup_pending = false;
                if let Some(owner) = owner_before.as_ref().filter(|e| {
                    !e.inverse_done
                        && e.held.as_ref().is_some_and(|held| {
                            restored_entries
                                .iter()
                                .any(|(path, _)| path == &held.original)
                        })
                }) {
                    // Restoring an interrupted inverse capture rolls that inverse back;
                    // it does not undo the forward effect. Keep the same owner retryable.
                    let actual = Manifest::capture(&owner.destination, &|| Ok(()))?;
                    if !owner
                        .held
                        .as_ref()
                        .unwrap()
                        .manifest
                        .same_captured_manifest(&actual)
                    {
                        return Err(identity::changed());
                    }
                    recovered_undo = self.reconcile_recovered_owner(id, |e| {
                        e.manifest = actual.clone();
                        e.held = None;
                        e.inverse_cleanup_pending = false;
                        e.complete = false;
                    });
                } else if owner_before
                    .as_ref()
                    .is_some_and(|e| e.kind == EffectKind::IncompleteMove)
                    && !disposed_incoming
                {
                    // Restoring the source reverses cleanup only. The already-published
                    // destination remains a guarded copy inverse; never move the source again.
                    recovered_undo = self.reconcile_recovered_owner(id, |e| {
                        e.kind = EffectKind::Created;
                        e.source = None;
                        e.source_manifest = None;
                        e.held = None;
                        e.inverse_cleanup_pending = false;
                        e.complete = false;
                    });
                } else {
                    recovered_undo = self.reconcile_recovered_owner(id, |e| {
                        e.complete = true;
                        e.backup = None;
                        e.held = None;
                        e.inverse_cleanup_pending = false;
                    });
                }
            }
            self.finish_record(&record);
            Ok(())
        })();
        match result {
            Ok(()) => {
                out.status = OutcomeStatus::Succeeded;
                if action != RecoveryAction::DiscardStaging {
                    mutated = true;
                }
            }
            Err(e) => {
                if c.is_cancelled() {
                    out.status = OutcomeStatus::Cancelled;
                }
                out.error = Some(error(&e, Phase::Recovering));
                out.retry = RetryKind::ManualRecovery;
                if mutated {
                    out.status = OutcomeStatus::Partial;
                    let _ = self.journal.save(&record);
                }
            }
        }
        if mutated {
            out.published = true;
            out.effect_id = Some(journal::id("recovered"));
            for dir in affected(record.source.as_deref(), &record.destination) {
                if !out.affected_directories.contains(&dir) {
                    out.affected_directories.push(dir);
                }
            }
        }
        if action == RecoveryAction::RestoreBackup && mutated {
            let mut removed = vec![];
            if disposed_incoming {
                if let Some(guard) = &manifest_before {
                    removed.push((destination_before.clone(), guard.clone()));
                }
            }
            self.apply_ancestor_receipts(
                &ancestor_receipts,
                &removed,
                &restored_entries,
                &receipt_paths,
                c,
            );
            if let Some(owner) = &owner_before {
                let mut original_removed = vec![];
                for (path, guard) in &restored_entries {
                    let original = if owner.source.as_ref() == Some(path) {
                        owner.source_manifest.as_ref().unwrap_or(guard)
                    } else {
                        guard
                    };
                    original_removed.push((path.clone(), original.clone()));
                }
                self.apply_ancestor_receipts(
                    &owner.ancestor_receipts,
                    &original_removed,
                    &restored_entries,
                    &receipt_paths,
                    c,
                );
            }
        }
        c.record_outcome(out);
        ExecutionResult {
            undo_id: recovered_undo,
            ..Default::default()
        }
    }
}
