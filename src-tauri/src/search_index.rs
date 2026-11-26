//! Rebuild Bento's index on restart. The upstream engine owns workers and an
//! on-disk catalog for its lifetime, so a rebuild starts in a fresh directory.
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

static STORAGE: OnceLock<Storage> = OnceLock::new();

struct Storage {
    root: PathBuf,
    marker: PathBuf,
    active: Option<String>,
    started: Instant,
    error: Mutex<Option<String>>,
    pruned: AtomicBool,
}

fn generation_name(name: &str) -> bool {
    let Some((timestamp, pid)) = name
        .strip_prefix("generation-")
        .and_then(|n| n.split_once('-'))
    else {
        return false;
    };
    timestamp.parse::<u128>().is_ok() && pid.parse::<u32>().is_ok()
}

fn read_generation(marker: &Path) -> Option<String> {
    let mut value = String::new();
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(marker)
        .ok()?
        .take(128)
        .read_to_string(&mut value)
        .ok()?;
    generation_name(value.trim()).then(|| value.trim().to_owned())
}

fn try_lock(path: &Path, create: bool) -> std::io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other("invalid search index lock"));
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(file)
}

impl Storage {
    fn new(root: PathBuf, marker: PathBuf) -> Self {
        let active = read_generation(&marker);
        Self {
            root,
            marker,
            active,
            started: Instant::now(),
            error: Mutex::new(None),
            pruned: AtomicBool::new(false),
        }
    }

    fn active_dir(&self) -> Option<PathBuf> {
        self.active.as_ref().map(|name| self.root.join(name))
    }

    fn check_root(&self) -> std::io::Result<()> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.root)?;
        if !fs::symlink_metadata(&self.root)?.is_dir() {
            return Err(std::io::Error::other(
                "invalid search index cache directory",
            ));
        }
        Ok(())
    }

    fn phase(&self) -> &'static str {
        let Some(dir) = self.active_dir() else {
            return "available";
        };
        if self.error.lock().is_ok_and(|error| error.is_some()) {
            return "failed";
        }
        if fsearch::index::Index::saved_event_id(&dir.join("index.bin")).is_some() {
            return "ready";
        }
        if self.started.elapsed() > Duration::from_secs(30 * 60) {
            "failed"
        } else {
            "building"
        }
    }

    fn request(&self) -> Result<(), String> {
        self.check_root()
            .map_err(|e| format!("无法打开索引缓存：{e}"))?;
        let _guard = try_lock(&self.root.join("maintenance.lock"), true)
            .map_err(|e| format!("无法取得索引维护锁，请稍后重试：{e}"))?;
        if read_generation(&self.marker) != self.active || self.phase() == "building" {
            return Err("索引重建已在进行中。".into());
        }
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let name = format!("generation-{timestamp}-{}", std::process::id());
        let dir = self.root.join(&name);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|e| format!("无法创建新索引目录：{e}"))?;
        let update = (|| {
            let parent = self.marker.parent().ok_or("索引设置目录无效")?;
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            super::settings_backup::atomic_write(&self.marker, name.as_bytes())
        })();
        if update.is_err() {
            let _ = fs::remove_dir(dir);
        }
        update
    }

    // Retire only stamped Bento generations, after the selected catalog has
    // been published. A second Bento process may still own an older generation.
    fn prune(&self) -> std::io::Result<()> {
        let _guard = try_lock(&self.root.join("maintenance.lock"), true)?;
        if self.phase() != "ready" || read_generation(&self.marker) != self.active {
            return Ok(());
        }
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !generation_name(name)
                || self.active.as_deref() == Some(name)
                || !entry.file_type()?.is_dir()
            {
                continue;
            }
            let dir = entry.path();
            if let Ok(_lease) = try_lock(&dir.join("daemon.lock"), false) {
                fs::remove_dir_all(dir)?;
            } else {
                let _ = fs::remove_dir(dir);
            }
        }
        Ok(())
    }
}

pub(crate) fn configure(app: &tauri::App) {
    if let (Ok(cache), Ok(data)) = (app.path().app_cache_dir(), app.path().app_data_dir()) {
        let _ = STORAGE.set(Storage::new(
            cache.join("search-index"),
            data.join("search-index-generation"),
        ));
    }
}

pub(crate) fn engine_dir(home: &str) -> Result<PathBuf, String> {
    let Some(storage) = STORAGE.get() else {
        return Ok(fsearch::default_dir(home));
    };
    let Some(dir) = storage.active_dir() else {
        return Ok(fsearch::default_dir(home));
    };
    storage.check_root().map_err(|e| e.to_string())?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .map_err(|e| e.to_string())?;
    if !fs::symlink_metadata(&dir).is_ok_and(|md| md.is_dir()) {
        return Err("索引缓存目录无效".into());
    }
    Ok(dir)
}

pub(crate) fn record_start_error(error: &str) {
    if let Some(storage) = STORAGE.get() {
        if let Ok(mut slot) = storage.error.lock() {
            *slot = Some(error.into());
        }
    }
}

pub(crate) fn maintenance_status() -> (&'static str, Option<String>) {
    let Some(storage) = STORAGE.get() else {
        return ("available", None);
    };
    let phase = storage.phase();
    if phase == "ready" && !storage.pruned.swap(true, Ordering::AcqRel) {
        std::thread::spawn(move || {
            if let Err(error) = storage.prune() {
                eprintln!("[fsearch] could not prune older Bento caches: {error}");
            }
        });
    }
    (
        phase,
        storage.error.lock().ok().and_then(|error| error.clone()),
    )
}

#[tauri::command]
pub(crate) async fn rebuild_search_index(app: tauri::AppHandle) -> Result<(), String> {
    let storage = STORAGE.get().ok_or("无法打开 Bento 索引设置。")?;
    tauri::async_runtime::spawn_blocking(move || storage.request())
        .await
        .map_err(|e| e.to_string())??;
    // The frontend persists the session and settings before calling here.
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStrExt;

    #[test]
    fn rebuild_selects_a_fresh_catalog_and_retires_only_unlocked_bento_generations() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp = std::env::temp_dir().join(format!(
            "bento-index-rebuild-{}-{nonce}",
            std::process::id()
        ));
        let root = temp.join("cache");
        let prefs = temp.join("app-data");
        fs::create_dir_all(&prefs).unwrap();
        let session = prefs.join("session.json");
        fs::write(&session, b"persisted tabs").unwrap();
        let marker = prefs.join("search-index-generation");

        let legacy = Storage::new(root.clone(), marker.clone());
        assert!(legacy.active_dir().is_none());
        legacy.request().unwrap();
        assert!(legacy.request().is_err(), "one generation per restart");
        let reopened = Storage::new(root.clone(), marker.clone());
        let active = reopened.active_dir().unwrap();
        assert_eq!(reopened.phase(), "building");
        assert!(reopened.request().is_err(), "no parallel rebuilds");

        let old = root.join("generation-1-1");
        let in_use = root.join("generation-2-1");
        for dir in [&old, &in_use] {
            fs::create_dir(dir).unwrap();
            fs::write(dir.join("index.bin"), b"previous catalog").unwrap();
            File::create(dir.join("daemon.lock")).unwrap();
        }
        let held = try_lock(&in_use.join("daemon.lock"), false).unwrap();
        let unrelated = root.join("keep-me");
        fs::write(&unrelated, b"unrelated").unwrap();
        reopened.prune().unwrap();
        assert!(old.exists(), "preserve older catalog until publication");

        let files = temp.join("files");
        fs::create_dir(&files).unwrap();
        fs::write(files.join("Unindexed-full-filename.txt"), b"user data").unwrap();
        let files = fs::canonicalize(files).unwrap();
        let bytes = files.as_os_str().as_bytes();
        fsearch::index::Index::build(fsearch::walk::scan(bytes, 1), 42, 0, bytes)
            .save(&active.join("index.bin"))
            .unwrap();
        assert_eq!(reopened.phase(), "ready");
        let index = fsearch::index::Index::load(&active.join("index.bin")).unwrap();
        let live = fsearch::live::Live::new(index);
        let exact = fsearch::Query::parse("\"*Unindexed-full-filename.txt*\"", "/").unwrap();
        assert_eq!(
            fsearch::query::Searcher { live: &live }
                .search(&exact)
                .len(),
            1
        );
        reopened.prune().unwrap();
        assert!(!old.exists());
        assert!(in_use.join("index.bin").exists());
        assert!(unrelated.exists());
        assert_eq!(fs::read(&session).unwrap(), b"persisted tabs");
        drop(held);
        fs::remove_dir_all(temp).unwrap();
    }
}
