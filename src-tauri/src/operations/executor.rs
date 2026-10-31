//! The single queue worker owns filesystem mutation; callbacks never run under its locks.
use super::{
    identity::{self, Manifest},
    journal::{self, Journal, OwnedRoot, Protected, Record},
    queue::{OperationContext, OperationExecutor},
    types::*,
    undo::{Effect, EffectKind},
};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Point {
    Chunk,
    Metadata,
    BeforePublish,
    AfterPublish,
    BeforeSourceCleanup,
    BackupCapture,
    AfterBackupCapture,
    Journal,
    UndoCapture,
    UndoMoved,
    RenameTarget,
    ArchiveSpawned,
    CapturedSource,
    Cloned,
}
type Hook = Arc<dyn Fn(Point, &Path, &OperationContext) -> io::Result<()> + Send + Sync>;
pub struct FileExecutor {
    pub(crate) app: PathBuf,
    pub(crate) journal: Journal,
    pub(crate) undo: Mutex<HashMap<String, Vec<Effect>>>,
    hook: Hook,
    clone_files: bool,
    #[cfg(test)]
    child_ids: Mutex<Vec<u32>>,
}
impl FileExecutor {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let journal = Journal::open(&app_data_dir).map_err(|e| e.to_string())?;
        Ok(Self {
            app: app_data_dir,
            journal,
            undo: Mutex::new(HashMap::new()),
            hook: Arc::new(|_, _, _| Ok(())),
            clone_files: true,
            #[cfg(test)]
            child_ids: Mutex::new(vec![]),
        })
    }
    pub(crate) fn at(&self, p: Point, path: &Path, c: &OperationContext) -> io::Result<()> {
        (self.hook)(p, path, c)
    }
    pub(crate) fn save(&self, r: &Record, c: &OperationContext) -> io::Result<()> {
        self.at(Point::Journal, &r.destination, c)?;
        self.journal.save(r)
    }
    fn execute_request(&self, r: &OperationRequest, c: &OperationContext) -> ExecutionResult {
        if r.kind == OperationKind::Zip {
            return self.execute_zip(r, c);
        }
        let mut effects = vec![];
        for item in &r.items {
            if c.is_cancelled() {
                break;
            }
            c.set_phase(Phase::Scanning, Cancelability::Checkpoint);
            let mut out = ItemOutcome::new(&item.item_id, OutcomeStatus::Failed);
            out.source = item.source.clone();
            match self.item(r, item, c, &mut out) {
                Ok(effect) => {
                    if let Some(e) = effect {
                        out.effect_id = Some(e.id.clone());
                        effects.push(e);
                    }
                }
                Err(e) => {
                    if out.status != OutcomeStatus::Partial {
                        out.status = if c.is_cancelled() {
                            OutcomeStatus::Cancelled
                        } else {
                            OutcomeStatus::Failed
                        };
                    }
                    out.error = Some(error(&e, Phase::Preparing));
                    if out.retry == RetryKind::None {
                        out.retry = RetryKind::RetryItem;
                    }
                }
            }
            c.record_outcome(out);
        }
        self.remember(effects)
    }
    pub(crate) fn remember(&self, effects: Vec<Effect>) -> ExecutionResult {
        if effects.is_empty() {
            return ExecutionResult::default();
        }
        let id = journal::id("undo");
        self.undo
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), effects);
        ExecutionResult {
            undo_id: Some(id),
            ..Default::default()
        }
    }
    fn item(
        &self,
        r: &OperationRequest,
        item: &OperationItem,
        c: &OperationContext,
        out: &mut ItemOutcome,
    ) -> io::Result<Option<Effect>> {
        let source = item.source.as_ref().map(PathBuf::from);
        if let Some(s) = &source {
            if !s.is_absolute() {
                return Err(invalid("源路径必须为绝对路径"));
            }
        }
        let moving = matches!(
            r.kind,
            OperationKind::Move | OperationKind::Rename | OperationKind::Trash
        );
        let creating = r.kind == OperationKind::Create;
        let source = if creating && item.create_kind == Some(CreateKind::Template) {
            Some(
                crate::resolve_template(
                    &self.app.join("templates"),
                    source.as_deref().ok_or_else(|| invalid("模板路径缺失"))?,
                )
                .map_err(io::Error::other)?,
            )
        } else {
            source
        };
        let source = source.as_deref();
        if !creating && source.is_none() {
            return Err(invalid("源路径缺失"));
        }
        let default_name = if creating {
            match item.create_kind {
                Some(CreateKind::Directory) => "未命名文件夹".into(),
                Some(CreateKind::Markdown) => "未命名.md".into(),
                Some(CreateKind::Text) => "未命名.txt".into(),
                Some(CreateKind::Template) => basename(source.unwrap())?,
                None => return Err(invalid("新建类型缺失")),
            }
        } else {
            basename(source.unwrap())?
        };
        let name = item.target_name.as_deref().unwrap_or(&default_name);
        valid_name(name)?;
        let parent = match r.kind {
            OperationKind::Rename => source
                .unwrap()
                .parent()
                .ok_or_else(|| invalid("源路径没有父目录"))?
                .to_path_buf(),
            OperationKind::Trash => self.trash_root(source.unwrap())?,
            _ => PathBuf::from(
                r.destination
                    .as_ref()
                    .ok_or_else(|| invalid("目标目录缺失"))?,
            ),
        };
        if !parent.is_absolute() || !parent.is_dir() {
            return Err(invalid("目标必须为存在的绝对目录"));
        }
        let requested = parent.join(name);
        out.requested_destination = Some(display(&requested));
        if let Some(src) = source {
            if moving && same_entity(src, &requested) {
                out.status = OutcomeStatus::Noop;
                out.actual_destination = Some(display(src));
                return Ok(None);
            }
            ensure_outside(src, &parent)?;
        }
        let mut source_manifest = source
            .map(|s| Manifest::capture(s, &|| checkpoint(c)))
            .transpose()?;
        let auto = r.options.keep_both || r.kind == OperationKind::Trash || creating;
        let mut destination = requested.clone();
        let mut replacement = None;
        if !crate::entry_available(&destination) {
            match self.choose_destination(source, &requested, item, c, auto, creating)? {
                Choice::Skip => {
                    out.status = OutcomeStatus::Skipped;
                    return Ok(None);
                }
                Choice::Target(path, old) => {
                    destination = path;
                    replacement = old;
                }
            }
        }
        checkpoint(c)?;
        if moving && replacement.is_none() {
            match self.fast_move(
                source.unwrap(),
                &destination,
                source_manifest.as_ref().unwrap(),
                c,
                out,
            ) {
                Ok(Some(effect)) => return Ok(Some(effect)),
                Ok(None) => {
                    if !source_manifest
                        .as_ref()
                        .unwrap()
                        .matches_captured(source.unwrap())
                    {
                        return Err(identity::changed());
                    }
                    source_manifest = Some(Manifest::capture(source.unwrap(), &|| checkpoint(c))?);
                }
                Err(e) => return Err(e),
            }
        }
        let mut record = Record::new(source.map(Path::to_path_buf), destination.clone());
        record.source_manifest = source_manifest.clone();
        record.move_intent = moving;
        let root = OwnedRoot::create(&parent)?;
        record.roots.push(root.clone());
        let incoming = root.path.join("incoming");
        record.incoming = Some(incoming.clone());
        if let Err(e) = self.save(&record, c) {
            let _ = root.cleanup();
            return Err(e);
        }
        let prepared = (|| {
            if creating && item.create_kind != Some(CreateKind::Template) {
                if item.create_kind == Some(CreateKind::Directory) {
                    crate::create_private_dir(&incoming)?;
                } else {
                    OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o644)
                        .open(&incoming)?
                        .sync_all()?;
                }
            } else {
                self.copy_tree(source.unwrap(), &incoming, c, &item.item_id, &mut 0)?;
            }
            let manifest = Manifest::capture(&incoming, &|| checkpoint(c))?;
            if let Some(original) = &source_manifest {
                if !original.matches(source.unwrap()) || !original.same_contents(&manifest) {
                    return Err(identity::changed());
                }
            }
            record.incoming_manifest = Some(manifest);
            record.phase = "prepared".into();
            self.save(&record, c)?;
            checkpoint(c)?;
            Ok(())
        })();
        if let Err(e) = prepared {
            self.abandon(&record);
            return Err(e);
        }
        // Every destructive step below is a protected finishing section.
        c.set_phase(Phase::Publishing, Cancelability::Finishing);
        self.at(Point::BeforePublish, &destination, c)
            .inspect_err(|_| self.abandon(&record))?;
        // A cancellation at the final hook still precedes publication.
        if let Err(e) = checkpoint(c) {
            self.abandon(&record);
            return Err(e);
        }
        if let Some(old) = replacement.take() {
            if let Err(e) = self.capture_backup(&mut record, &old, c) {
                return self.retained_failure(&record, item, out, e);
            }
        }
        match self.publish_incoming(&mut record, source, &requested, item, c, auto, creating) {
            Ok(true) => destination = record.destination.clone(),
            Ok(false) => {
                self.abandon(&record);
                out.status = OutcomeStatus::Skipped;
                return Ok(None);
            }
            Err(e) => return self.retained_failure(&record, item, out, e),
        }
        out.published = true;
        out.actual_destination = Some(display(&destination));
        out.affected_directories = affected(source, &destination);
        let mut effect = Effect::new(
            item.item_id.clone(),
            if moving {
                EffectKind::Move
            } else {
                EffectKind::Created
            },
            source.map(Path::to_path_buf),
            destination.clone(),
            record.incoming_manifest.clone().unwrap(),
            record.id.clone(),
        );
        // Capture once, then compare; never adopt an intervening user modification.
        let published_manifest = Manifest::capture(&destination, &|| Ok(()));
        let published_manifest = match published_manifest {
            Ok(m)
                if record
                    .incoming_manifest
                    .as_ref()
                    .unwrap()
                    .same_captured_manifest(&m) =>
            {
                m
            }
            _ => {
                out.status = OutcomeStatus::Partial;
                out.retry = RetryKind::ManualRecovery;
                out.effect_id = Some(record.id.clone());
                record.phase = "publishedUncertain".into();
                let _ = self.journal.save(&record);
                return Err(identity::changed());
            }
        };
        record.destination_manifest = Some(published_manifest);
        effect.manifest = record.destination_manifest.clone().unwrap();
        record.phase = "published".into();
        record.cleanup_pending = moving;
        effect.backup = record.protected.first().cloned();
        effect.source_manifest = record.source_manifest.clone();
        let settled = (|| {
            self.save(&record, c)?;
            self.at(Point::AfterPublish, &destination, c)?;
            if moving {
                c.set_phase(Phase::RemovingSource, Cancelability::Finishing);
                self.finish_source(&mut record, c)?;
            }
            Ok(())
        })();
        if let Err(e) = settled {
            out.status = OutcomeStatus::Partial;
            out.source_disposition = if moving {
                SourceDisposition::CleanupIncomplete
            } else {
                SourceDisposition::Unchanged
            };
            out.retry = if moving {
                RetryKind::FinishSourceCleanup
            } else {
                RetryKind::ManualRecovery
            };
            out.error = Some(error(&e, Phase::RemovingSource));
            // A partially copied move must never become a normal move-back undo.
            effect.kind = if moving {
                EffectKind::IncompleteMove
            } else {
                EffectKind::Created
            };
            let _ = self.journal.save(&record);
        } else {
            out.status = OutcomeStatus::Succeeded;
            if moving {
                out.source_disposition = SourceDisposition::Removed;
            }
            self.finish_record(&record);
        }
        Ok(Some(effect))
    }
    fn publish_incoming(
        &self,
        record: &mut Record,
        source: Option<&Path>,
        requested: &Path,
        item: &OperationItem,
        c: &OperationContext,
        auto: bool,
        creating: bool,
    ) -> io::Result<bool> {
        for _ in 0..128 {
            match rename_prepared(record.incoming.as_ref().unwrap(), &record.destination) {
                Ok(()) => return Ok(true),
                Err(e)
                    if e.kind() == io::ErrorKind::AlreadyExists && record.protected.is_empty() =>
                {
                    match self.choose_destination(source, requested, item, c, auto, creating)? {
                        Choice::Skip => return Ok(false),
                        Choice::Target(path, old) => {
                            record.destination = path;
                            self.save(record, c)?;
                            checkpoint(c)?;
                            c.set_phase(Phase::Publishing, Cancelability::Finishing);
                            if let Some(old) = old {
                                self.capture_backup(record, &old, c)?;
                            }
                        }
                    }
                }
                Err(e) => return Err(e),
            }
        }
        Err(invalid("目标重名冲突过多"))
    }
    fn choose_destination(
        &self,
        source: Option<&Path>,
        requested: &Path,
        item: &OperationItem,
        c: &OperationContext,
        auto: bool,
        creating: bool,
    ) -> io::Result<Choice> {
        for _ in 0..128 {
            checkpoint(c)?;
            if crate::entry_available(requested) {
                return Ok(Choice::Target(requested.to_path_buf(), None));
            }
            if auto {
                return Ok(Choice::Target(
                    if creating {
                        crate::unique_path(requested.parent().unwrap(), &basename(requested)?)
                    } else {
                        crate::copy_name_path(requested.parent().unwrap(), &basename(requested)?)
                    },
                    None,
                ));
            }
            let old = Manifest::capture(requested, &|| checkpoint(c))?;
            let source_kind = source.map(kind).unwrap_or("file".into());
            let target_kind = kind(requested);
            let mut allowed = vec![
                ConflictDecision::Skip,
                ConflictDecision::KeepBoth,
                ConflictDecision::Cancel,
            ];
            if source_kind == "file"
                && target_kind == "file"
                && !source.is_some_and(|s| same_entity(s, requested))
            {
                allowed.insert(2, ConflictDecision::Replace);
            }
            let decision = c.wait_for_conflict(ConflictSpec {
                item_id: item.item_id.clone(),
                source: source.map(display).unwrap_or_default(),
                destination: display(requested),
                source_kind,
                destination_kind: target_kind,
                reason: "目标名称已被占用".into(),
                allowed_decisions: allowed.clone(),
            });
            if !old.matches(requested) {
                continue;
            }
            match decision {
                ConflictDecision::Cancel => return Err(cancelled()),
                ConflictDecision::Skip => return Ok(Choice::Skip),
                ConflictDecision::KeepBoth => {
                    return Ok(Choice::Target(
                        crate::copy_name_path(requested.parent().unwrap(), &basename(requested)?),
                        None,
                    ))
                }
                ConflictDecision::Replace if allowed.contains(&ConflictDecision::Replace) => {
                    return Ok(Choice::Target(requested.to_path_buf(), Some(old)))
                }
                _ => return Err(invalid("不支持替换此类对象")),
            }
        }
        Err(invalid("目标持续变化，请重试"))
    }
    fn capture_backup(
        &self,
        r: &mut Record,
        old: &Manifest,
        c: &OperationContext,
    ) -> io::Result<()> {
        if !old.matches(&r.destination) {
            return Err(identity::changed());
        }
        let backup = r.roots[0].path.join("original");
        r.protected.push(Protected {
            path: backup.clone(),
            original: r.destination.clone(),
            manifest: old.clone(),
        });
        r.phase = "capturingBackup".into();
        self.save(r, c)?;
        self.at(Point::BackupCapture, &r.destination, c)?;
        crate::rename_no_replace(&r.destination, &backup)?;
        if !old.matches_captured(&backup) {
            let _ = crate::rename_no_replace(&backup, &r.destination);
            return Err(identity::changed());
        }
        r.protected[0].manifest = Manifest::capture(&backup, &|| Ok(()))?;
        r.phase = "backupHeld".into();
        self.save(r, c)?;
        self.at(Point::AfterBackupCapture, &backup, c)
    }
    fn fast_move(
        &self,
        source: &Path,
        dest: &Path,
        manifest: &Manifest,
        c: &OperationContext,
        out: &mut ItemOutcome,
    ) -> io::Result<Option<Effect>> {
        let root = OwnedRoot::create(source.parent().ok_or_else(|| invalid("源没有父目录"))?)?;
        let held = root.path.join("source");
        let mut r = Record::new(Some(source.to_path_buf()), dest.to_path_buf());
        r.source_manifest = Some(manifest.clone());
        r.move_intent = true;
        r.roots.push(root.clone());
        r.protected.push(Protected {
            path: held.clone(),
            original: source.to_path_buf(),
            manifest: manifest.clone(),
        });
        if let Err(e) = self.save(&r, c) {
            let _ = root.cleanup();
            return Err(e);
        }
        checkpoint(c).inspect_err(|_| self.abandon(&r))?;
        c.set_phase(Phase::Publishing, Cancelability::Finishing);
        let attempt = (|| {
            self.at(Point::BeforePublish, dest, c)?;
            checkpoint(c)?;
            rename_prepared(source, &held)?;
            if !manifest.matches_captured(&held) {
                return Err(identity::changed());
            }
            r.phase = "sourceHeld".into();
            self.save(&r, c)?;
            self.at(Point::RenameTarget, dest, c)?;
            rename_prepared(&held, dest)
        })();
        match attempt {
            Ok(()) => {
                out.published = true;
                out.actual_destination = Some(display(dest));
                out.source_disposition = SourceDisposition::Removed;
                out.affected_directories = affected(Some(source), dest);
                let moved = Manifest::capture(dest, &|| Ok(()))?;
                if !manifest.same_captured_manifest(&moved) {
                    out.status = OutcomeStatus::Partial;
                    out.retry = RetryKind::ManualRecovery;
                    out.effect_id = Some(r.id.clone());
                    r.phase = "publishedUncertain".into();
                    let _ = self.journal.save(&r);
                    return Err(identity::changed());
                }
                let mut effect = Effect::new(
                    out.item_id.clone(),
                    EffectKind::Move,
                    Some(source.to_path_buf()),
                    dest.to_path_buf(),
                    moved.clone(),
                    r.id.clone(),
                );
                effect.source_manifest = Some(manifest.clone());
                r.destination_manifest = Some(moved);
                r.protected.clear();
                r.phase = "published".into();
                if let Err(e) = self
                    .save(&r, c)
                    .and_then(|_| self.at(Point::AfterPublish, dest, c))
                {
                    out.status = OutcomeStatus::Partial;
                    out.retry = RetryKind::ManualRecovery;
                    out.error = Some(error(&e, Phase::Publishing));
                } else {
                    out.status = OutcomeStatus::Succeeded;
                    self.finish_record(&r);
                }
                Ok(Some(effect))
            }
            Err(e) => {
                if crate::published_destination(&e).is_some() {
                    if manifest.identity().matches(dest) {
                        r.protected[0].path = dest.to_path_buf();
                    }
                    r.phase = "moveMetadataUncertain".into();
                    let _ = self.journal.save(&r);
                    out.status = OutcomeStatus::Partial;
                    out.effect_id = Some(r.id.clone());
                    out.retry = RetryKind::ManualRecovery;
                    out.source_disposition = SourceDisposition::Unknown;
                    out.affected_directories = affected(Some(source), dest);
                    return Err(e);
                }
                if held.exists() || fs::symlink_metadata(&held).is_ok() {
                    if rename_prepared(&held, source).is_err() {
                        let _ = self.journal.save(&r);
                        out.status = OutcomeStatus::Partial;
                        out.retry = RetryKind::ManualRecovery;
                        out.affected_directories = affected(Some(source), dest);
                        return Err(e);
                    }
                }
                r.protected.clear();
                self.abandon(&r);
                if crate::is_exdev(&e) {
                    Ok(None)
                } else {
                    Err(e)
                }
            }
        }
    }
    pub(crate) fn finish_source(&self, r: &mut Record, c: &OperationContext) -> io::Result<()> {
        self.at(Point::BeforeSourceCleanup, r.source.as_deref().unwrap(), c)?;
        let dest_guard = r
            .destination_manifest
            .as_ref()
            .ok_or_else(|| invalid("目标身份缺失"))?;
        if !dest_guard.matches(&r.destination) {
            return Err(identity::changed());
        }
        let source = r.source.as_ref().unwrap().clone();
        let original = r.source_manifest.as_ref().unwrap().clone();
        // A prior attempt may have already captured the source before deletion failed.
        let held = if let Some(held) = r.protected.iter().find(|p| p.original == source).cloned() {
            held
        } else {
            if !original.matches(&source) {
                return Err(identity::changed());
            }
            let root = OwnedRoot::create(source.parent().unwrap())?;
            let held = Protected {
                path: root.path.join("source"),
                original: source.clone(),
                manifest: original.clone(),
            };
            r.roots.push(root);
            r.protected.push(held.clone());
            r.phase = "capturingSource".into();
            self.save(r, c)?;
            rename_prepared(&source, &held.path)?;
            if !original.matches_captured(&held.path) {
                let _ = crate::rename_no_replace(&held.path, &source);
                return Err(identity::changed());
            }
            held
        };
        if !held.manifest.matches_remaining(&held.path) {
            return Err(identity::changed());
        }
        r.phase = "removingSource".into();
        self.save(r, c)?;
        self.at(Point::CapturedSource, &held.path, c)?;
        remove_captured(&held.path)?;
        r.protected.retain(|p| p.path != held.path);
        r.cleanup_pending = false;
        r.phase = "sourceRemoved".into();
        self.save(r, c)
    }
    fn copy_tree(
        &self,
        source: &Path,
        dest: &Path,
        c: &OperationContext,
        item: &str,
        bytes: &mut u64,
    ) -> io::Result<()> {
        checkpoint(c)?;
        let md = fs::symlink_metadata(source)?;
        c.set_phase(Phase::Copying, Cancelability::Checkpoint);
        if md.file_type().is_symlink() {
            std::os::unix::fs::symlink(fs::read_link(source)?, dest)?;
        } else if md.is_dir() {
            crate::create_private_dir(dest)?;
            for e in fs::read_dir(source)? {
                let e = e?;
                self.copy_tree(&e.path(), &dest.join(e.file_name()), c, item, bytes)?;
            }
        } else if md.is_file() {
            let mut cloned = false;
            #[cfg(target_os = "macos")]
            if self.clone_files {
                use std::{ffi::CString, os::unix::ffi::OsStrExt};
                c.set_phase(Phase::Copying, Cancelability::Finishing);
                let src = CString::new(source.as_os_str().as_bytes())?;
                let dst = CString::new(dest.as_os_str().as_bytes())?;
                cloned = unsafe {
                    libc::clonefile(src.as_ptr(), dst.as_ptr(), 1 /* CLONE_NOFOLLOW */)
                } == 0;
                checkpoint(c)?;
            }
            if cloned {
                *bytes = bytes.saturating_add(md.len());
                c.progress(*bytes, None, Some(item.into()), Some(display(source)));
                self.at(Point::Cloned, source, c)?;
            } else {
                c.set_phase(Phase::Copying, Cancelability::Checkpoint);

                let mut input = OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(source)?;
                let mut output = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(dest)?;
                let mut buf = [0u8; 1024 * 256];
                loop {
                    checkpoint(c)?;
                    let n = input.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    output.write_all(&buf[..n])?;
                    *bytes = bytes.saturating_add(n as u64);
                    c.progress(*bytes, None, Some(item.into()), Some(display(source)));
                    self.at(Point::Chunk, source, c)?;
                }
                output.sync_all()?;
            }
        } else {
            return Err(invalid("不支持此类文件"));
        }
        checkpoint(c)?;
        c.set_phase(Phase::Metadata, Cancelability::Finishing);
        self.at(Point::Metadata, dest, c)?;
        crate::preserve_move_metadata(source, dest)?;
        if !md.file_type().is_symlink()
            && fs::symlink_metadata(dest)?.permissions().mode() & 0o7777
                != md.permissions().mode() & 0o7777
        {
            return Err(invalid("目标卷无法保留文件权限"));
        }
        checkpoint(c)
    }
    pub(crate) fn trash_root(&self, source: &Path) -> io::Result<PathBuf> {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let root = match home {
            Some(home) if source.starts_with(&home) => home.join(".Trash"),
            _ => self.app.join("Trash"),
        };
        fs::create_dir_all(&root)?;
        Ok(root)
    }
    pub(crate) fn abandon(&self, r: &Record) {
        // Captured originals/uncertain identities are never staging garbage.
        let mut reconciled = r.clone();
        reconciled
            .protected
            .retain(|p| fs::symlink_metadata(&p.path).is_ok());
        if !reconciled.protected.is_empty() || r.cleanup_pending {
            let _ = self.journal.save(&reconciled);
            return;
        }
        if r.roots.iter().all(|root| root.cleanup().is_ok()) {
            let _ = self.journal.remove(&r.id);
        } else {
            let _ = self.journal.save(r);
        }
    }
    pub(crate) fn finish_record(&self, r: &Record) {
        if r.protected.is_empty() && !r.cleanup_pending {
            self.abandon(r);
        } else {
            let _ = self.journal.save(r);
        }
    }
    fn retained_failure(
        &self,
        record: &Record,
        item: &OperationItem,
        out: &mut ItemOutcome,
        err: io::Error,
    ) -> io::Result<Option<Effect>> {
        if record
            .incoming_manifest
            .as_ref()
            .is_some_and(|m| m.identity().matches(&record.destination))
        {
            let mut retained = record.clone();
            retained.phase = "publishedMetadataUncertain".into();
            let _ = self.journal.save(&retained);
            out.status = OutcomeStatus::Partial;
            out.published = true;
            out.effect_id = Some(record.id.clone());
            out.actual_destination = Some(display(&record.destination));
            out.retry = RetryKind::ManualRecovery;
            out.affected_directories = affected(record.source.as_deref(), &record.destination);
            return Err(err);
        }
        let protected = record
            .protected
            .iter()
            .find(|p| fs::symlink_metadata(&p.path).is_ok())
            .cloned();
        self.abandon(record);
        if let Some(backup) = protected {
            out.status = OutcomeStatus::Partial;
            out.retry = RetryKind::ManualRecovery;
            out.error = Some(error(&err, Phase::Publishing));
            out.affected_directories = affected(record.source.as_deref(), &record.destination);
            let mut effect = Effect::new(
                item.item_id.clone(),
                EffectKind::Created,
                record.source.clone(),
                record.destination.clone(),
                backup.manifest.clone(),
                record.id.clone(),
            );
            effect.inverse_done = true;
            effect.backup = Some(backup);
            Ok(Some(effect))
        } else {
            Err(err)
        }
    }
}
impl OperationExecutor for FileExecutor {
    fn execute(&self, work: &Work, c: &OperationContext) -> ExecutionResult {
        match work {
            Work::Operation(r) => self.execute_request(r, c),
            Work::Undo { undo_id } => self.execute_undo(undo_id, c),
            Work::Recovery {
                recovery_id,
                action,
            } => self.execute_recovery(recovery_id, *action, c),
        }
    }
    fn recoveries(&self) -> Result<Vec<RecoveryRecord>, String> {
        Ok(self.journal.recoveries())
    }
}
enum Choice {
    Skip,
    Target(PathBuf, Option<Manifest>),
}
pub(crate) fn display(p: &Path) -> String {
    p.to_string_lossy().into()
}
pub(crate) fn basename(p: &Path) -> io::Result<String> {
    p.file_name()
        .map(|s| s.to_string_lossy().into())
        .ok_or_else(|| invalid("文件名缺失"))
}
fn valid_name(s: &str) -> io::Result<()> {
    if s.is_empty() || s == "." || s == ".." || s.contains('/') || s.contains('\0') {
        Err(invalid("文件名无效"))
    } else {
        Ok(())
    }
}
pub(crate) fn invalid(s: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, s)
}
fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "cancelled")
}
fn checkpoint(c: &OperationContext) -> io::Result<()> {
    c.checkpoint().map_err(|_| cancelled())
}
pub(crate) fn error(e: &io::Error, phase: Phase) -> OperationError {
    OperationError {
        code: if e.kind() == io::ErrorKind::Interrupted {
            "cancelled"
        } else {
            "filesystem"
        }
        .into(),
        message: e.to_string(),
        phase,
    }
}
pub(crate) fn affected(source: Option<&Path>, destination: &Path) -> Vec<String> {
    let mut paths = vec![];
    for p in [source.and_then(Path::parent), destination.parent()]
        .into_iter()
        .flatten()
    {
        let p = display(p);
        if !paths.contains(&p) {
            paths.push(p);
        }
    }
    paths
}
fn same_entity(a: &Path, b: &Path) -> bool {
    super::identity::Identity::read(a)
        .ok()
        .zip(super::identity::Identity::read(b).ok())
        .is_some_and(|(a, b)| a == b)
}
fn kind(p: &Path) -> String {
    match fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() => "link",
        Ok(m) if m.is_dir() => "directory",
        Ok(m) if m.is_file() => "file",
        _ => "other",
    }
    .into()
}
fn ensure_outside(source: &Path, parent: &Path) -> io::Result<()> {
    if fs::symlink_metadata(source)?.is_dir() {
        let src = fs::canonicalize(source)?;
        let dst = fs::canonicalize(parent)?;
        if dst.starts_with(&src) {
            return Err(invalid("不能将文件夹复制或移动到自身内部"));
        }
    }
    Ok(())
}
#[cfg(test)]
#[path = "executor_tests.rs"]
mod tests;

#[path = "archive.rs"]
mod archive;

/// macOS needs owner write permission when changing a directory's parent, even if
/// its parent is writable. Restore through the open descriptor before source cleanup.
/// The surrounding finishing section owns the staged object and records any failure.
pub(crate) fn rename_prepared(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::unix::{fs::MetadataExt, io::AsRawFd};
    let md = fs::symlink_metadata(source)?;
    if !md.is_dir() || md.mode() & 0o200 != 0 {
        return crate::rename_no_replace(source, destination);
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(source)?;
    if file.metadata()?.ino() != md.ino() || file.metadata()?.dev() != md.dev() {
        return Err(identity::changed());
    }
    if unsafe {
        libc::fchmod(
            file.as_raw_fd(),
            ((md.mode() | 0o200) & 0o7777) as libc::mode_t,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let renamed = crate::rename_no_replace(source, destination);
    if unsafe { libc::fchmod(file.as_raw_fd(), (md.mode() & 0o7777) as libc::mode_t) } != 0 {
        let error = io::Error::last_os_error();
        return if renamed.is_ok() {
            Err(io::Error::new(
                error.kind(),
                crate::PublishedDestination {
                    dest: destination.to_path_buf(),
                    error,
                },
            ))
        } else {
            Err(error)
        };
    }
    renamed
}

// Destruction is limited to a verified tree captured beneath a private owned root.
// Readonly modes are restored if removal cannot complete; no symlink is followed.
fn remove_captured(path: &Path) -> io::Result<()> {
    let md = fs::symlink_metadata(path)?;
    if !md.is_dir() {
        return fs::remove_file(path);
    }
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(md.permissions().mode() | 0o700),
    )?;
    let result = (|| {
        for e in fs::read_dir(path)? {
            remove_captured(&e?.path())?;
        }
        fs::remove_dir(path)
    })();
    if result.is_err() {
        let _ = fs::set_permissions(path, md.permissions());
    }
    result
}
