//! Private, atomic recovery ledger. Only identities recorded here authorize recovery.
use super::identity::{Identity, Manifest};
use super::types::{RecoveryAction, RecoveryRecord};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::{
        fs::{OpenOptionsExt, PermissionsExt},
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
        if !self.valid() {
            return Err(super::identity::changed());
        }
        crate::cleanup_staging(&self.path);
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
