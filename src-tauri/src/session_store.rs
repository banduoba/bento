//! Serialized, atomic storage for the versioned navigation session.
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct SessionStore {
    io: Mutex<()>,
}

fn is_current_session(value: &Value) -> bool {
    value.is_object() && value.get("version").and_then(Value::as_u64) == Some(1)
}

impl SessionStore {
    pub(crate) fn load(&self, dir: &Path) -> Result<Option<Value>, String> {
        let _guard = self.io.lock().map_err(|e| e.to_string())?;
        match fs::read(dir.join("session.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| format!("Cannot read session.json: {e}")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("Cannot read session.json: {e}")),
        }
    }

    pub(crate) fn save(&self, dir: &Path, session: &Value) -> Result<(), String> {
        if !is_current_session(session) {
            return Err("Session must be an object with version 1".into());
        }
        let bytes = serde_json::to_vec_pretty(session).map_err(|e| e.to_string())?;
        let _guard = self.io.lock().map_err(|e| e.to_string())?;
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let destination = dir.join("session.json");
        match fs::read(&destination) {
            Ok(previous) => {
                let current = serde_json::from_slice::<Value>(&previous)
                    .map(|value| is_current_session(&value))
                    .unwrap_or(false);
                if !current {
                    // Keep exact original bytes, including invalid UTF-8. A failed backup
                    // must return before a replacement of the user's session is attempted.
                    let (mut file, mut recovery) =
                        PrivateFile::create(dir, "session-recovery-", ".json")
                            .map_err(|e| format!("Cannot back up session.json: {e}"))?;
                    file.write_all(&previous)
                        .and_then(|_| file.sync_all())
                        .map_err(|e| format!("Cannot back up session.json: {e}"))?;
                    recovery.keep = true;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Cannot read previous session.json: {e}")),
        }
        replace_session(dir, &destination, &bytes)
    }
}

fn replace_session(dir: &Path, destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let (mut file, temporary) = PrivateFile::create(dir, ".session-write-", ".tmp")
        .map_err(|e| format!("Cannot create session temporary file: {e}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("Cannot write session.json: {e}"))?;
    // Same-directory rename makes the complete replacement visible atomically.
    // All fallible writes/syncs happen first, preserving the old file on failure.
    fs::rename(&temporary.path, destination)
        .map_err(|e| format!("Cannot replace session.json: {e}"))?;
    Ok(())
}

/// Only this operation's freshly created resource is removed on failure.
struct PrivateFile {
    path: PathBuf,
    keep: bool,
}
impl PrivateFile {
    fn create(dir: &Path, prefix: &str, suffix: &str) -> io::Result<(File, Self)> {
        static NEXT_FILE: AtomicU64 = AtomicU64::new(1);
        loop {
            let sequence = NEXT_FILE.fetch_add(1, Ordering::Relaxed);
            let path = dir.join(format!("{prefix}{}-{sequence}{suffix}", std::process::id()));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            match options.open(&path) {
                Ok(file) => return Ok((file, Self { path, keep: false })),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
    }
}
impl Drop for PrivateFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[tauri::command]
pub(crate) async fn load_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<SessionStore>>,
) -> Result<Option<Value>, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.load(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn save_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<SessionStore>>,
    session: Value,
) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.save(&dir, &session))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::sync::{mpsc, Arc};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let n = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir =
                std::env::temp_dir().join(format!("bento-session-{}-{n}", std::process::id()));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
        fn backups(&self) -> Vec<std::path::PathBuf> {
            fs::read_dir(&self.0)
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| {
                    p.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("session-recovery-")
                })
                .collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn absent_session_is_none_but_bad_json_is_an_error() {
        let f = Fixture::new();
        let store = SessionStore::default();
        assert_eq!(store.load(&f.0).unwrap(), None);
        fs::write(f.0.join("session.json"), b"{broken").unwrap();
        assert!(store.load(&f.0).is_err());
        fs::remove_file(f.0.join("session.json")).unwrap();
        fs::create_dir(f.0.join("session.json")).unwrap();
        assert!(
            store.load(&f.0).is_err(),
            "directory/read failure cannot become null"
        );
    }

    #[test]
    fn save_roundtrips_all_fields_and_preserves_path_bytes() {
        let f = Fixture::new();
        let store = SessionStore::default();
        let value = json!({"version":1,"panes":[{"tabs":[{"path":"/挂载/ 空 格 ","history":["/A","/挂载/ 空 格 "],"hi":1}]}],"workspaces":[{"name":"独立"}]});
        store.save(&f.0, &value).unwrap();
        assert_eq!(store.load(&f.0).unwrap(), Some(value));
        assert!(f.backups().is_empty());
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(f.0.join("session.json")).unwrap().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn rejects_nonobject_or_unsupported_version_without_touching_previous() {
        let f = Fixture::new();
        fs::write(f.0.join("session.json"), b"previous bytes").unwrap();
        for bad in [
            Value::Null,
            json!([]),
            json!({}),
            json!({"version":2}),
            json!({"version":"1"}),
        ] {
            assert!(SessionStore::default().save(&f.0, &bad).is_err());
            assert_eq!(
                fs::read(f.0.join("session.json")).unwrap(),
                b"previous bytes"
            );
        }
        assert!(f.backups().is_empty());
    }

    #[test]
    fn preserves_corrupt_and_unknown_version_bytes_in_unique_private_backups() {
        let f = Fixture::new();
        let store = SessionStore::default();
        let old_backup = f.0.join("session-recovery-existing.json");
        fs::write(&old_backup, b"existing recovery").unwrap();
        for bytes in [
            b"{broken\xff".as_slice(),
            b"{ \"version\": 9, \"future\": true }".as_slice(),
        ] {
            fs::write(f.0.join("session.json"), bytes).unwrap();
            store.save(&f.0, &json!({"version":1})).unwrap();
            let backup = f
                .backups()
                .into_iter()
                .find(|p| fs::read(p).unwrap() == bytes)
                .expect("original exact bytes backed up");
            #[cfg(unix)]
            assert_eq!(fs::metadata(backup).unwrap().mode() & 0o777, 0o600);
        }
        assert_eq!(f.backups().len(), 3);
        assert_eq!(fs::read(old_backup).unwrap(), b"existing recovery");
        store.save(&f.0, &json!({"version":1,"new":true})).unwrap();
        assert_eq!(
            f.backups().len(),
            3,
            "valid v1 replacement needs no recovery file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn permission_errors_propagate_and_failed_backup_or_write_preserves_previous() {
        let f = Fixture::new();
        let file = f.0.join("session.json");
        let store = SessionStore::default();
        fs::write(&file, b"{broken").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0)).unwrap();
        let read_result = store.load(&f.0);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_result.is_err(), "permission denied must reject load");
        for original in [b"{broken".as_slice(), b"{\"version\":1}".as_slice()] {
            fs::write(&file, original).unwrap();
            fs::set_permissions(&f.0, fs::Permissions::from_mode(0o500)).unwrap();
            let result = store.save(&f.0, &json!({"version":1,"new":true}));
            fs::set_permissions(&f.0, fs::Permissions::from_mode(0o700)).unwrap();
            assert!(result.is_err());
            assert_eq!(fs::read(&file).unwrap(), original);
            assert!(f.backups().is_empty());
            assert_eq!(
                fs::read_dir(&f.0).unwrap().count(),
                1,
                "no leaked temporary file"
            );
        }
    }

    #[test]
    fn filesystem_operations_wait_for_the_store_lock() {
        let f = Fixture::new();
        let store = Arc::new(SessionStore::default());
        let guard = store.io.lock().unwrap();
        let other = store.clone();
        let dir = f.0.clone();
        let (tx, rx) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            tx.send(other.save(&dir, &json!({"version":1}))).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
        assert!(!f.0.join("session.json").exists());
        drop(guard);
        rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        writer.join().unwrap();
    }

    #[test]
    fn failed_rename_keeps_destination_and_removes_its_temporary_file() {
        let f = Fixture::new();
        let destination = f.0.join("session.json");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("keep"), b"original").unwrap();
        assert!(replace_session(&f.0, &destination, b"new session").is_err());
        assert_eq!(fs::read(destination.join("keep")).unwrap(), b"original");
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
    }

    #[test]
    fn load_returns_unknown_version_for_frontend_recovery_and_save_creates_parent_dirs() {
        let f = Fixture::new();
        let dir = f.0.join("new/nested");
        let store = SessionStore::default();
        store.save(&dir, &json!({"version":1})).unwrap();
        fs::write(dir.join("session.json"), b"{\"version\":99}").unwrap();
        assert_eq!(store.load(&dir).unwrap(), Some(json!({"version":99})));
    }

    #[test]
    fn concurrent_readers_only_observe_complete_replacements() {
        let f = Fixture::new();
        let store = Arc::new(SessionStore::default());
        store
            .save(&f.0, &json!({"version":1,"revision":0}))
            .unwrap();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                for revision in 1..40 {
                    store
                        .save(
                            &f.0,
                            &json!({"version":1,"revision":revision,"payload":"x".repeat(10000)}),
                        )
                        .unwrap();
                }
            });
            for _ in 0..100 {
                let bytes = fs::read(f.0.join("session.json")).unwrap();
                let value: Value = serde_json::from_slice(&bytes)
                    .expect("atomic visibility even without store lock");
                assert_eq!(value["version"], 1);
            }
        });
        assert_eq!(store.load(&f.0).unwrap().unwrap()["revision"], 39);
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
    }
}
