//! Private, atomic recovery ledger. Only identities recorded here authorize recovery.
use super::identity::{Identity, Manifest};
use super::types::{RecoveryAction, RecoveryRecord};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

pub(crate) fn id(prefix: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{prefix}-{}-{now}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct OwnedRoot {
    pub path: PathBuf,
    pub identity: Identity,
}
impl OwnedRoot {
    pub fn create(parent: &Path) -> io::Result<Self> {
        let path = parent.join(format!(".bento-{}", id("operation")));
        crate::create_private_dir(&path)?;
        let identity = Identity::read(&path)?;
        bento_fswatch::register_internal(&path)?;
        Ok(Self { path, identity })
    }
    pub fn valid(&self) -> bool {
        self.identity.matches(&self.path)
    }
    pub fn cleanup(&self) -> io::Result<()> {
        if fs::symlink_metadata(&self.path).is_err_and(|e| e.kind() == io::ErrorKind::NotFound) {
            return Ok(());
        }
        if !self.valid() {
            return Err(super::identity::changed());
        }
        super::executor::remove_captured(&self.path)?;
        if fs::symlink_metadata(&self.path).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "无法清理私有暂存目录",
            ));
        }
        // Registry tombstone suppresses delayed removal events; identity mismatch unhides replacements.
        Ok(())
    }
}
// Only used while Journal::open holds the exclusive owner lock. Keep the parent
// descriptor through preflight and removal so parent path replacements cannot
// redirect unlinkat. This deliberately never calls recursive staging cleanup.
struct EmptyRoot {
    parent: File,
    name: CString,
    identity: Identity,
}
impl EmptyRoot {
    fn prepare(root: &OwnedRoot) -> io::Result<Option<Self>> {
        let name = root.path.file_name().ok_or_else(super::identity::changed)?;
        let private_name = name.as_bytes().strip_prefix(b".bento-operation-");
        if !root.path.is_absolute()
            || root
                .path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            || private_name.is_none_or(|suffix| {
                let parts = suffix.split(|c| *c == b'-').collect::<Vec<_>>();
                parts.len() != 3
                    || parts
                        .iter()
                        .any(|part| part.is_empty() || !part.iter().all(u8::is_ascii_digit))
            })
        {
            return Err(super::identity::changed());
        }
        let metadata = match fs::symlink_metadata(&root.path) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.dev() != root.identity.dev
            || metadata.ino() != root.identity.ino
        {
            return Err(super::identity::changed());
        }
        let parent = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
            .open(root.path.parent().ok_or_else(super::identity::changed)?)?;
        let prepared = Self {
            parent,
            name: CString::new(name.as_bytes())?,
            identity: root.identity.clone(),
        };
        if !prepared.matches()? || fs::read_dir(&root.path)?.next().transpose()?.is_some() {
            return Err(super::identity::changed());
        }
        Ok(Some(prepared))
    }

    fn matches(&self) -> io::Result<bool> {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::NotFound {
                Ok(false)
            } else {
                Err(error)
            };
        }
        let stat = unsafe { stat.assume_init() };
        if stat.st_mode & libc::S_IFMT != libc::S_IFDIR
            || stat.st_dev as u64 != self.identity.dev
            || stat.st_ino as u64 != self.identity.ino
        {
            return Err(super::identity::changed());
        }
        Ok(true)
    }

    fn remove(self) -> io::Result<()> {
        if !self.matches()? {
            return Ok(());
        }
        // rmdir is the atomic emptiness check: a child created after preflight
        // prevents removal. There is no identity-CAS rmdir; an adversarial rename
        // between this last identity check and unlinkat remains a pathname race.
        if unsafe {
            libc::unlinkat(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                libc::AT_REMOVEDIR,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        self.parent.sync_all()?;
        if self.matches()? {
            return Err(super::identity::changed());
        }
        Ok(())
    }
}

fn reclaim_empty_record(record: &Record) -> io::Result<()> {
    if !record.protected.is_empty()
        || record.cleanup_pending
        || record.move_intent
        || record.incoming.is_some()
        || record.incoming_manifest.is_some()
        || record.roots.is_empty()
        || !matches!(
            record.phase.as_str(),
            "preparing" | "undoCapturing" | "undoMoving" | "undoMoved"
        )
        || record.roots.iter().any(|root| {
            record.destination.starts_with(&root.path)
                || record
                    .source
                    .as_ref()
                    .is_some_and(|source| source.starts_with(&root.path))
        })
    {
        return Err(super::identity::changed());
    }
    // Prove every root before deleting any. If later removal fails, keep the
    // original durable record; already absent roots make the next open retryable.
    let roots = record
        .roots
        .iter()
        .map(EmptyRoot::prepare)
        .collect::<io::Result<Vec<_>>>()?;
    for root in roots.into_iter().flatten() {
        root.remove()?;
    }
    if record.roots.iter().any(|root| {
        !fs::symlink_metadata(&root.path).is_err_and(|e| e.kind() == io::ErrorKind::NotFound)
    }) {
        return Err(super::identity::changed());
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Protected {
    pub path: PathBuf,
    pub original: PathBuf,
    pub manifest: Manifest,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Record {
    pub id: String,
    pub phase: String,
    pub source: Option<PathBuf>,
    pub destination: PathBuf,
    pub roots: Vec<OwnedRoot>,
    pub protected: Vec<Protected>,
    pub source_manifest: Option<Manifest>,
    pub destination_manifest: Option<Manifest>,
    pub incoming: Option<PathBuf>,
    pub incoming_manifest: Option<Manifest>,
    pub cleanup_pending: bool,
    #[serde(default)]
    pub move_intent: bool,
}
impl Record {
    pub fn new(source: Option<PathBuf>, destination: PathBuf) -> Self {
        Self {
            id: id("recovery"),
            phase: "preparing".into(),
            source,
            destination,
            roots: vec![],
            protected: vec![],
            source_manifest: None,
            destination_manifest: None,
            incoming: None,
            incoming_manifest: None,
            cleanup_pending: false,
            move_intent: false,
        }
    }
    pub fn recovery(&self) -> RecoveryRecord {
        let mut actions = vec![];
        if !self.protected.is_empty() {
            actions.push(RecoveryAction::RestoreBackup);
        }
        if self.cleanup_pending {
            actions.push(RecoveryAction::FinishSourceCleanup);
        }
        if self.protected.is_empty() && !self.cleanup_pending {
            actions.push(RecoveryAction::DiscardStaging);
        }
        RecoveryRecord {
            recovery_id: self.id.clone(),
            description: if self.cleanup_pending {
                "目标已发布，源清理尚未完成"
            } else if !self.protected.is_empty() {
                "保留了受保护的原始文件，可恢复"
            } else {
                "未完成操作的私有暂存数据"
            }
            .into(),
            source: self.source.as_ref().map(|p| p.to_string_lossy().into()),
            destination: Some(self.destination.to_string_lossy().into()),
            actions,
        }
    }
}
pub(crate) struct Journal {
    dir: PathBuf,
    _owner: File,
    records: Mutex<BTreeMap<String, Record>>,
}
impl Journal {
    pub fn open(app: &Path) -> io::Result<Self> {
        fs::create_dir_all(app)?;
        let dir = app.join("operations-recovery");
        match crate::create_private_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                let m = fs::symlink_metadata(&dir)?;
                if !m.is_dir() || m.file_type().is_symlink() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "恢复目录身份无效",
                    ));
                }
                fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
            }
            Err(e) => return Err(e),
        }
        let owner = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(dir.join("owner.lock"))?;
        if unsafe { libc::flock(owner.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "另一个 Bento 实例正在使用文件操作恢复目录",
            ));
        }
        bento_fswatch::register_internal(&dir)?;
        let mut records = BTreeMap::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if entry.path().extension().is_none_or(|e| e != "json") {
                continue;
            }
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(entry.path())?;
            let mut record: Record = serde_json::from_reader(file).map_err(|e| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("恢复记录损坏，未修改任何文件: {e}"),
                )
            })?;
            if record.id.is_empty()
                || !record
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "恢复记录 ID 无效",
                ));
            }
            // Inspect the original record before protected-entry normalization:
            // even an apparently restored backup is outside automatic reclamation.
            if entry.file_name() == std::ffi::OsString::from(format!("{}.json", record.id))
                && reclaim_empty_record(&record).is_ok()
                && fs::remove_file(entry.path()).is_ok()
            {
                File::open(&dir)?.sync_all()?;
                continue;
            }
            for root in &record.roots {
                if root.valid() {
                    bento_fswatch::register_internal(&root.path)?;
                }
            }
            // Reconcile a crash between an atomic rename and its journal update.
            // This only observes identities; it never resumes or deletes a source.
            if record.destination_manifest.is_none() {
                let guard = record.incoming_manifest.as_ref().or_else(|| {
                    if record.move_intent {
                        record.source_manifest.as_ref()
                    } else {
                        None
                    }
                });
                if guard.is_some_and(|g| g.matches_captured(&record.destination)) {
                    record.destination_manifest =
                        Manifest::capture(&record.destination, &|| Ok(())).ok();
                    if record.move_intent
                        && record.source.as_ref().is_some_and(|p| {
                            fs::symlink_metadata(p).is_ok()
                                || record.protected.iter().any(|held| {
                                    held.original == *p && fs::symlink_metadata(&held.path).is_ok()
                                })
                        })
                    {
                        record.cleanup_pending = true;
                    }
                }
            }
            for protected in &mut record.protected {
                if fs::symlink_metadata(&protected.path).is_err()
                    && !protected.manifest.matches_captured(&protected.original)
                    && protected.manifest.matches_captured(&record.destination)
                {
                    protected.path = record.destination.clone();
                }
            }
            record.protected.retain(|p| {
                fs::symlink_metadata(&p.path).is_ok() || !p.manifest.matches_captured(&p.original)
            });
            records.insert(record.id.clone(), record);
        }
        Ok(Self {
            dir,
            _owner: owner,
            records: Mutex::new(records),
        })
    }
    pub fn save(&self, record: &Record) -> io::Result<()> {
        let temp = self.dir.join(format!("{}.tmp", id("journal")));
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temp)?;
        let result = (|| {
            serde_json::to_writer(&mut f, record).map_err(io::Error::other)?;
            f.write_all(b"\n")?;
            f.sync_all()?;
            fs::rename(&temp, self.dir.join(format!("{}.json", record.id)))?;
            File::open(&self.dir)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        // Keep recoverable knowledge even if disk IO failed after a filesystem mutation.
        self.records
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(record.id.clone(), record.clone());
        result
    }
    pub fn remove(&self, id: &str) -> io::Result<()> {
        match fs::remove_file(self.dir.join(format!("{id}.json"))) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        File::open(&self.dir)?.sync_all()?;
        self.records
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        Ok(())
    }
    pub fn get(&self, id: &str) -> Option<Record> {
        self.records
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }
    pub fn records(&self) -> Vec<Record> {
        self.records
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }
    pub fn recoveries(&self) -> Vec<RecoveryRecord> {
        self.records().iter().map(Record::recovery).collect()
    }
}

#[cfg(test)]
mod startup_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(id("bento-empty-recovery-test"));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn app(&self) -> PathBuf {
            self.0.join("app")
        }
        fn record(&self) -> Record {
            let source = self.0.join("source");
            let destination = self.0.join("destination");
            fs::write(&source, b"original source").unwrap();
            fs::write(&destination, b"original destination").unwrap();
            let mut record = Record::new(Some(source), destination);
            record.phase = "undoMoving".into();
            record.roots.push(OwnedRoot::create(&self.0).unwrap());
            record
        }
        fn save(&self, record: &Record) -> (PathBuf, Journal) {
            let journal = Journal::open(&self.app()).unwrap();
            journal.save(record).unwrap();
            let path = self
                .app()
                .join("operations-recovery")
                .join(format!("{}.json", record.id));
            (path, journal)
        }
        fn reopen(&self, journal: Journal) -> Journal {
            // Taking ownership proves this fixture's prior owner is dropped.
            // Other parallel tests fork subprocesses: their inherited CLOEXEC
            // fd can retain flock briefly until exec, even after our fd closes.
            drop(journal);
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
            loop {
                match Journal::open(&self.app()) {
                    Ok(journal) => return journal,
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(error) => {
                        panic!("journal did not reopen after dropping its owner: {error}")
                    }
                }
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn startup_reclaims_only_empty_scaffolding_and_is_durable_on_reopen() {
        let fixture = Fixture::new();
        let mut record = fixture.record();
        record.roots.push(OwnedRoot::create(&fixture.0).unwrap());
        record.source_manifest =
            Some(Manifest::capture(record.source.as_ref().unwrap(), &|| Ok(())).unwrap());
        record.destination_manifest =
            Some(Manifest::capture(&record.destination, &|| Ok(())).unwrap());
        let (persisted, mut journal) = fixture.save(&record);
        for _ in 0..2 {
            journal = fixture.reopen(journal);
            assert!(journal.recoveries().is_empty());
            assert!(!persisted.exists());
            assert!(record.roots.iter().all(|root| !root.path.exists()));
            assert_eq!(
                fs::read(record.source.as_ref().unwrap()).unwrap(),
                b"original source"
            );
            assert_eq!(
                fs::read(&record.destination).unwrap(),
                b"original destination"
            );
        }
    }

    #[test]
    fn startup_retries_after_a_previous_partial_empty_root_cleanup() {
        let fixture = Fixture::new();
        let mut record = fixture.record();
        record.roots.push(OwnedRoot::create(&fixture.0).unwrap());
        let (persisted, journal) = fixture.save(&record);
        fs::remove_dir(&record.roots[0].path).unwrap();
        let payload = record.roots[1].path.join("payload");
        fs::write(&payload, b"keep me").unwrap();
        let journal = fixture.reopen(journal);
        assert_eq!(journal.recoveries().len(), 1);
        assert!(persisted.exists());
        assert_eq!(fs::read(&payload).unwrap(), b"keep me");
        fs::remove_file(&payload).unwrap();
        let journal = fixture.reopen(journal);
        assert!(journal.recoveries().is_empty());
        assert!(!persisted.exists());
        assert!(!record.roots[1].path.exists());
    }

    #[test]
    fn startup_retains_records_with_unproven_or_live_recovery_state() {
        for case in [
            "protected",
            "protectedRestored",
            "cleanup",
            "incoming",
            "incomingManifest",
            "moveIntent",
            "nonempty",
            "symlink",
            "replaced",
            "file",
            "ioError",
            "unknownPhase",
            "noRoots",
            "foreignName",
            "sourceOverlap",
            "destinationOverlap",
            "missingIncoming",
            "symlinkParent",
            "relativeRoot",
        ] {
            let fixture = Fixture::new();
            let mut record = fixture.record();
            let root = record.roots[0].clone();
            match case {
                "protected" | "protectedRestored" => {
                    let held = fixture.0.join("held");
                    fs::write(&held, b"protected bytes").unwrap();
                    let original = fixture.0.join("original");
                    let manifest = Manifest::capture(&held, &|| Ok(())).unwrap();
                    record.protected.push(Protected {
                        path: held.clone(),
                        original: original.clone(),
                        manifest,
                    });
                    if case == "protectedRestored" {
                        fs::rename(held, original).unwrap();
                    }
                }
                "cleanup" => record.cleanup_pending = true,
                "incoming" => {
                    let incoming = fixture.0.join("incoming");
                    fs::write(&incoming, b"incoming bytes").unwrap();
                    record.incoming = Some(incoming);
                }
                "incomingManifest" => {
                    record.incoming_manifest =
                        Some(Manifest::capture(&record.destination, &|| Ok(())).unwrap())
                }
                "moveIntent" => record.move_intent = true,
                "nonempty" => fs::write(root.path.join("payload"), b"keep me").unwrap(),
                "symlink" => {
                    fs::remove_dir(&root.path).unwrap();
                    symlink(&record.destination, &root.path).unwrap();
                    // Even a recorded symlink identity cannot authorize directory cleanup.
                    record.roots[0].identity = Identity::read(&root.path).unwrap();
                }
                "replaced" => {
                    fs::rename(&root.path, fixture.0.join("original-root")).unwrap();
                    fs::create_dir(&root.path).unwrap();
                }
                "file" => {
                    fs::remove_dir(&root.path).unwrap();
                    fs::write(&root.path, b"keep file").unwrap();
                    record.roots[0].identity = Identity::read(&root.path).unwrap();
                }
                "ioError" => {
                    let loop_path = fixture.0.join("loop");
                    symlink(&loop_path, &loop_path).unwrap();
                    record.roots[0].path = loop_path.join(root.path.file_name().unwrap());
                }
                "unknownPhase" => record.phase = "futureUnknownPhase".into(),
                "noRoots" => record.roots.clear(),
                "foreignName" => {
                    record.roots[0].path = fixture.0.join("unowned-directory");
                    fs::create_dir(&record.roots[0].path).unwrap();
                    record.roots[0].identity = Identity::read(&record.roots[0].path).unwrap();
                }
                "sourceOverlap" => {
                    // Point a valid empty private root at the source itself.
                    fs::remove_file(record.source.as_ref().unwrap()).unwrap();
                    record.source = Some(root.path.clone());
                }
                "destinationOverlap" => {
                    fs::remove_file(&record.destination).unwrap();
                    record.destination = root.path.clone();
                }
                "missingIncoming" => record.incoming = Some(root.path.join("absent-incoming")),
                "symlinkParent" => {
                    let parent = fixture.0.join("parent");
                    fs::create_dir(&parent).unwrap();
                    let nested = OwnedRoot::create(&parent).unwrap();
                    let alias = fixture.0.join("alias");
                    symlink(&parent, &alias).unwrap();
                    record.roots[0] = OwnedRoot {
                        path: alias.join(nested.path.file_name().unwrap()),
                        identity: nested.identity,
                    };
                }
                "relativeRoot" => {
                    record.roots[0].path = PathBuf::from(root.path.file_name().unwrap())
                }
                _ => unreachable!(),
            }
            let (persisted, mut journal) = fixture.save(&record);
            for _ in 0..2 {
                journal = fixture.reopen(journal);
                assert_eq!(journal.recoveries().len(), 1, "{case}");
                assert!(persisted.exists(), "{case}");
                assert!(fs::symlink_metadata(&root.path).is_ok(), "{case}");
                if case != "destinationOverlap" {
                    assert_eq!(
                        fs::read(&record.destination).unwrap(),
                        b"original destination"
                    );
                }
                if case != "sourceOverlap" {
                    assert_eq!(
                        fs::read(record.source.as_ref().unwrap()).unwrap(),
                        b"original source"
                    );
                }
                if case == "nonempty" {
                    assert_eq!(fs::read(root.path.join("payload")).unwrap(), b"keep me");
                }
                if case == "incoming" {
                    assert_eq!(
                        fs::read(record.incoming.as_ref().unwrap()).unwrap(),
                        b"incoming bytes"
                    );
                }
            }
        }
    }

    #[test]
    fn empty_root_removal_rechecks_replacements_and_never_removes_new_children() {
        for case in ["newChild", "replacement", "symlink"] {
            let fixture = Fixture::new();
            let root = OwnedRoot::create(&fixture.0).unwrap();
            let prepared = EmptyRoot::prepare(&root).unwrap().unwrap();
            match case {
                "newChild" => fs::write(root.path.join("payload"), b"new bytes").unwrap(),
                "replacement" => {
                    fs::rename(&root.path, fixture.0.join("original-root")).unwrap();
                    fs::create_dir(&root.path).unwrap();
                }
                "symlink" => {
                    fs::rename(&root.path, fixture.0.join("original-root")).unwrap();
                    symlink(fixture.0.join("original-root"), &root.path).unwrap();
                }
                _ => unreachable!(),
            }
            assert!(prepared.remove().is_err(), "{case}");
            assert!(fs::symlink_metadata(&root.path).is_ok(), "{case}");
            if case == "newChild" {
                assert_eq!(fs::read(root.path.join("payload")).unwrap(), b"new bytes");
            }
        }
    }

    #[test]
    fn startup_preflights_all_roots_before_any_empty_directory_removal() {
        let fixture = Fixture::new();
        let mut record = fixture.record();
        record.roots.push(OwnedRoot::create(&fixture.0).unwrap());
        fs::write(record.roots[1].path.join("payload"), b"keep me").unwrap();
        let (persisted, journal) = fixture.save(&record);
        let journal = fixture.reopen(journal);
        assert_eq!(journal.recoveries().len(), 1);
        assert!(persisted.exists());
        assert!(record.roots.iter().all(|root| root.path.is_dir()));
        assert_eq!(
            fs::read(record.roots[1].path.join("payload")).unwrap(),
            b"keep me"
        );
    }

    #[test]
    fn startup_requires_exclusive_owner_before_reclaiming_any_roots() {
        let fixture = Fixture::new();
        let record = fixture.record();
        let journal = Journal::open(&fixture.app()).unwrap();
        journal.save(&record).unwrap();
        assert!(
            matches!(Journal::open(&fixture.app()), Err(e) if e.kind() == io::ErrorKind::WouldBlock)
        );
        assert!(record.roots[0].path.is_dir());
        assert_eq!(journal.recoveries().len(), 1);
    }
}
