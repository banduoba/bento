//! Bounded preference backups and atomic configuration replacement.
use serde::Deserialize;
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const MAX_BACKUP_BYTES: usize = 1024 * 1024;
static CONFIG_IO: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Backup {
    format: String,
    version: u32,
    preferences: Preferences,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preferences {
    #[serde(rename = "showHidden")]
    _show_hidden: bool,
    #[serde(rename = "showSidebar")]
    _show_sidebar: bool,
    sidebar_width: u16,
    #[serde(rename = "autoRefresh")]
    _auto_refresh: bool,
    #[serde(rename = "alwaysOnTop")]
    _always_on_top: bool,
    enter_action: String,
    search_paths: Vec<String>,
    search_prefs: SearchPreferences,
    favorites: Vec<Favorite>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchPreferences {
    scope: String,
    sort: String,
    mode: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Favorite {
    name: String,
    path: String,
}
fn valid_path(value: &str) -> bool {
    value.starts_with('/') && !value.contains('\0') && value.encode_utf16().count() <= 4096
}
fn validate(value: &Value) -> Result<(), String> {
    let backup: Backup =
        serde_json::from_value(value.clone()).map_err(|e| format!("设置备份格式无效：{e}"))?;
    if backup.format != "bento-preferences" {
        return Err("不是 Bento 设置备份".into());
    }
    if backup.version != 1 {
        return Err("不支持此设置备份版本".into());
    }
    let p = backup.preferences;
    if !(180..=520).contains(&p.sidebar_width)
        || !["open", "rename"].contains(&p.enter_action.as_str())
        || p.search_paths.len() > 256
        || !p.search_paths.iter().all(|s| valid_path(s))
        || !["pane", "home", "global"].contains(&p.search_prefs.scope.as_str())
        || !["btime", "mtime", "size", "name", "score"].contains(&p.search_prefs.sort.as_str())
        || !["name", "content"].contains(&p.search_prefs.mode.as_str())
        || p.favorites.len() > 256
        || !p.favorites.iter().all(|f| {
            !f.name.trim().is_empty()
                && !f.name.contains('\0')
                && f.name.encode_utf16().count() <= 256
                && valid_path(&f.path)
        })
    {
        return Err("设置备份包含无效偏好值或目录路径".into());
    }
    Ok(())
}

fn read_backup(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("请选择绝对路径".into());
    }
    // Nonblocking open also prevents a selected FIFO from hanging a worker before metadata checks.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| format!("无法读取设置备份：{e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_BACKUP_BYTES as u64 {
        return Err("设置备份必须是不超过 1 MiB 的普通文件".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BACKUP_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BACKUP_BYTES {
        return Err("设置备份超过 1 MiB".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "设置备份必须使用 UTF-8 编码".to_string())?;
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("设置备份 JSON 无效：{e}"))?;
    validate(&value)?;
    Ok(text)
}

fn export_backup(destination: &Path, document: &Value, data_dir: &Path) -> Result<(), String> {
    if !destination.is_absolute() {
        return Err("请选择绝对路径".into());
    }
    validate(document)?;
    let bytes = serde_json::to_vec_pretty(document).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BACKUP_BYTES {
        return Err("设置备份超过 1 MiB".into());
    }
    // Keep a selected backup destination from replacing Bento's own session/config documents.
    let parent = destination.parent().ok_or("备份位置无效")?;
    let resolved_parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if let Ok(data) = fs::canonicalize(data_dir) {
        if resolved_parent.starts_with(data) {
            return Err("请将设置备份保存到 Bento 数据目录之外".into());
        }
    }
    atomic_write(destination, &bytes)
}

pub(crate) fn write_config(dir: &Path, config: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    let _guard = CONFIG_IO.lock().map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    atomic_write(&dir.join("config.json"), &bytes)
}

// Exclusive creation and a same-directory rename preserve the old destination on every
// fallible write/sync/rename failure. Drop cleans only this operation's own temporary file.
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn private_temporary(dir: &Path) -> io::Result<(File, Temporary)> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    loop {
        let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(
            ".bento-settings-{}-{sequence}.tmp",
            std::process::id()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(file) => return Ok((file, Temporary(path))),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}
fn atomic_write(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = destination.parent().ok_or("保存位置无效")?;
    let (mut file, temporary) =
        private_temporary(dir).map_err(|e| format!("无法创建临时设置文件：{e}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("无法保存设置：{e}"))?;
    fs::rename(&temporary.0, destination).map_err(|e| format!("无法替换设置文件：{e}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn read_settings_backup(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_backup(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn export_settings_backup(
    app: tauri::AppHandle,
    path: String,
    document: Value,
) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || export_backup(Path::new(&path), &document, &dir))
        .await
        .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let n = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("bento-backup-{}-{n}", std::process::id()));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn document() -> Value {
        json!({"format":"bento-preferences","version":1,"preferences":{
            "showHidden":true,"showSidebar":false,"sidebarWidth":250,"autoRefresh":true,"alwaysOnTop":false,"enterAction":"open",
            "searchPaths":["/资料/ 空 格 "],"searchPrefs":{"scope":"home","sort":"score","mode":"content"},"favorites":[{"name":"资料","path":"/资料/ 空 格 "}]}})
    }
    #[test]
    fn bounded_regular_file_read_validates_complete_document_without_writing() {
        let f = Fixture::new();
        let path = f.0.join("settings.json");
        let bytes = serde_json::to_vec(&document()).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&read_backup(&path).unwrap()).unwrap(),
            document()
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(read_backup(&f.0).is_err());
        fs::write(&path, vec![b' '; MAX_BACKUP_BYTES + 1]).unwrap();
        assert!(read_backup(&path).is_err());
        fs::write(&path, b"\xff").unwrap();
        assert!(read_backup(&path).is_err());
        fs::write(&path, b"{bad").unwrap();
        assert!(read_backup(&path).is_err());
    }
    #[test]
    fn schema_rejects_future_version_unknown_fields_and_invalid_preference_values() {
        let mut bad = document();
        bad["version"] = json!(2);
        assert!(validate(&bad).is_err());
        let mut bad = document();
        bad["preferences"]["zipPrefs"] = json!({"password":"secret"});
        assert!(validate(&bad).is_err());
        for patch in [
            json!({"sidebarWidth":179}),
            json!({"sidebarWidth":521}),
            json!({"sidebarWidth":250.5}),
            json!({"autoRefresh":"true"}),
            json!({"searchPaths":["relative"]}),
            json!({"searchPaths":["/bad\0path"]}),
            json!({"searchPaths":vec!["/A";257]}),
            json!({"favorites":[{"name":"","path":"/A"}]}),
            json!({"searchPrefs":{"scope":"home","sort":"unknown","mode":"name"}}),
        ] {
            let mut bad = document();
            for (key, value) in patch.as_object().unwrap() {
                bad["preferences"][key] = value.clone();
            }
            assert!(validate(&bad).is_err(), "accepted {patch}");
        }
    }
    #[test]
    fn export_and_config_writes_replace_atomically_with_private_files_and_no_leaks() {
        let f = Fixture::new();
        let data = f.0.join("app-data");
        fs::create_dir(&data).unwrap();
        let file = f.0.join("backup.json");
        fs::write(&file, b"original").unwrap();
        export_backup(&file, &document(), &data).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&read_backup(&file).unwrap()).unwrap(),
            document()
        );
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let original = fs::read(&file).unwrap();
        let mut bad = document();
        bad["version"] = json!(99);
        assert!(export_backup(&file, &bad, &data).is_err());
        assert_eq!(fs::read(&file).unwrap(), original);
        write_config(
            &data,
            &json!({"showHidden":true,"zipPrefs":{"password":"kept"}}),
        )
        .unwrap();
        assert_eq!(
            fs::metadata(data.join("config.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(fs::read_dir(&data).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 2);
    }
    #[test]
    fn failed_atomic_rename_preserves_destination_and_cleans_only_owned_temporary_file() {
        let f = Fixture::new();
        let file = f.0.join("destination.json");
        fs::create_dir(&file).unwrap();
        fs::write(file.join("keep"), b"original").unwrap();
        let foreign = f.0.join(".bento-settings-existing.tmp");
        fs::write(&foreign, b"other operation").unwrap();
        assert!(atomic_write(&file, b"new").is_err());
        assert_eq!(fs::read(file.join("keep")).unwrap(), b"original");
        assert_eq!(fs::read(&foreign).unwrap(), b"other operation");
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 2);
    }
    #[test]
    fn failed_config_and_export_writes_preserve_exact_previous_bytes() {
        let f = Fixture::new();
        let data = f.0.join("data");
        fs::create_dir(&data).unwrap();
        let backup = f.0.join("backup.json");
        fs::write(&backup, b"exact original backup").unwrap();
        fs::write(data.join("config.json"), b"exact original config").unwrap();
        fs::set_permissions(&data, fs::Permissions::from_mode(0o500)).unwrap();
        let result = write_config(&data, &json!({"showHidden":true}));
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(
            fs::read(data.join("config.json")).unwrap(),
            b"exact original config"
        );
        fs::set_permissions(&f.0, fs::Permissions::from_mode(0o500)).unwrap();
        let result = export_backup(&backup, &document(), &data);
        fs::set_permissions(&f.0, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read(&backup).unwrap(), b"exact original backup");
        assert_eq!(fs::read_dir(&data).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 2);
    }
    #[test]
    fn exports_cannot_overwrite_internal_session_or_configuration_even_via_parent_alias() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let data = f.0.join("data");
        fs::create_dir(&data).unwrap();
        fs::write(data.join("session.json"), b"session bytes").unwrap();
        let alias = f.0.join("alias");
        symlink(&data, &alias).unwrap();
        assert!(export_backup(&data.join("session.json"), &document(), &data).is_err());
        assert!(export_backup(&alias.join("config.json"), &document(), &data).is_err());
        assert_eq!(
            fs::read(data.join("session.json")).unwrap(),
            b"session bytes"
        );
        assert_eq!(fs::read_dir(&data).unwrap().count(), 1);
    }
    #[test]
    fn readers_observe_only_complete_configuration_replacements() {
        let f = Fixture::new();
        write_config(&f.0, &json!({"revision":0})).unwrap();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                for revision in 1..30 {
                    write_config(
                        &f.0,
                        &json!({"revision":revision,"payload":"x".repeat(10000)}),
                    )
                    .unwrap();
                }
            });
            for _ in 0..100 {
                let bytes = fs::read(f.0.join("config.json")).unwrap();
                assert!(serde_json::from_slice::<Value>(&bytes).unwrap().is_object());
            }
        });
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(f.0.join("config.json")).unwrap()).unwrap()
                ["revision"],
            29
        );
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
    }
}
