//! Native application discovery/launching. Finder and Archive Utility own their UI.
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const MAX_SELECTION: usize = 64;
const ARCHIVE_EXTENSIONS: &[&str] = &[
    "zip", "tar", "tgz", "gz", "tbz", "tbz2", "bz2", "txz", "xz", "cpio",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenApplication {
    path: String,
    name: String,
    bundle_id: Option<String>,
    version: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithApplications {
    default_app: Option<String>,
    apps: Vec<OpenApplication>,
}

fn local_path(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if !path.is_absolute() || raw.contains('\0') {
        return Err("请选择有效的绝对文件路径".into());
    }
    let metadata = fs::metadata(path).map_err(|error| format!("无法访问 {raw}: {error}"))?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(format!("不是可打开的文件或文件夹: {raw}"));
    }
    Ok(path.into())
}
fn selection(paths: Vec<String>) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() || paths.len() > MAX_SELECTION {
        return Err(format!("请选择 1 到 {MAX_SELECTION} 个项目"));
    }
    let mut seen = HashSet::new();
    let mut result = vec![];
    for raw in paths {
        let path = local_path(&raw)?;
        if seen.insert(path.clone()) {
            result.push(path);
        }
    }
    Ok(result)
}
fn application(raw: &str) -> Result<PathBuf, String> {
    let path = local_path(raw)?;
    if !path.is_dir()
        || !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
    {
        return Err("请选择有效的 .app 应用程序".into());
    }
    fs::canonicalize(path).map_err(|error| format!("无法访问应用程序: {error}"))
}
fn archive_paths(paths: Vec<String>) -> Result<Vec<PathBuf>, String> {
    let paths = selection(paths)?;
    for path in &paths {
        let extension = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        if !path.is_file() || !ARCHIVE_EXTENSIONS.contains(&extension.as_str()) {
            return Err(format!(
                "系统解压缩不支持此项目，请选择其他打开方式: {}",
                path.display()
            ));
        }
    }
    Ok(paths)
}
fn open_target(raw: &str) -> Result<String, String> {
    if Path::new(raw).is_absolute() {
        return local_path(raw).map(|path| path.to_string_lossy().into_owned());
    }
    let url = tauri::Url::parse(raw).map_err(|_| "请选择有效文件或 HTTP/HTTPS 链接".to_string())?;
    if raw.trim() != raw || !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("仅支持本地文件和 HTTP/HTTPS 链接".into());
    }
    Ok(raw.into())
}
fn open_command(paths: &[PathBuf], app: Option<&Path>, bundle: Option<&str>) -> Command {
    let mut command = Command::new("/usr/bin/open");
    if let Some(app) = app {
        command.arg("-a").arg(app);
    }
    if let Some(bundle) = bundle {
        command.arg("-b").arg(bundle);
    }
    command.arg("--").args(paths);
    command
}
fn checked_output(command: &mut Command) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|error| format!("无法启动系统操作: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let diagnostic = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(2000)
        .collect::<String>();
    Err(format!(
        "系统操作失败 ({}): {}",
        output.status,
        if diagnostic.is_empty() {
            "系统未返回详细信息"
        } else {
            &diagnostic
        }
    ))
}
fn launch_with(paths: &[PathBuf], app: &Path) -> Result<(), String> {
    checked_output(&mut open_command(paths, Some(app), None))
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

pub async fn open_path(path: String) -> Result<(), String> {
    blocking(move || {
        let target = open_target(&path)?;
        #[cfg(target_os = "macos")]
        {
            checked_output(Command::new("/usr/bin/open").arg("--").arg(target))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = target;
            Err("此系统不支持 macOS 原生打开操作".into())
        }
    })
    .await
}
#[tauri::command]
pub async fn list_open_with(path: String) -> Result<OpenWithApplications, String> {
    blocking(move || {
        let path = local_path(&path)?;
        #[cfg(target_os = "macos")]
        {
            macos::list(&path)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            Err("此系统不支持 macOS 打开方式".into())
        }
    })
    .await
}
#[tauri::command]
pub async fn open_with(paths: Vec<String>, app_path: String) -> Result<(), String> {
    blocking(move || {
        let paths = selection(paths)?;
        let app = application(&app_path)?;
        #[cfg(target_os = "macos")]
        {
            launch_with(&paths, &app)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (paths, app);
            Err("此系统不支持 macOS 打开方式".into())
        }
    })
    .await
}
#[tauri::command]
pub async fn choose_application_and_open(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_dialog::DialogExt;
        let paths = blocking(move || selection(paths)).await?;
        let (send, receive) = std::sync::mpsc::channel();
        app.dialog()
            .file()
            .set_title("选择打开此项目的应用程序")
            .set_directory("/Applications")
            .add_filter("应用程序", &["app"])
            .pick_file(move |selected| {
                let _ = send.send(selected);
            });
        blocking(move || {
            let Some(chosen) = receive.recv().map_err(|error| error.to_string())? else {
                return Ok(false);
            };
            let chosen = chosen.into_path().map_err(|error| error.to_string())?;
            let chosen = application(&chosen.to_string_lossy())?;
            launch_with(&paths, &chosen)?;
            Ok(true)
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, paths);
        Err("此系统不支持 macOS 应用程序选择器".into())
    }
}
#[tauri::command]
pub async fn show_get_info(paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let paths = selection(paths)?;
        #[cfg(target_os = "macos")]
        {
            super::native_files::show_get_info(
                &paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect::<Vec<_>>(),
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = paths;
            Err("此系统不支持 Finder 显示简介".into())
        }
    })
    .await
}
#[tauri::command]
pub async fn extract_archive(paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let paths = archive_paths(paths)?;
        #[cfg(target_os = "macos")]
        {
            checked_output(&mut open_command(
                &paths,
                None,
                Some("com.apple.archiveutility"),
            ))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = paths;
            Err("此系统不支持系统归档实用工具".into())
        }
    })
    .await
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSFileManager, NSString, NSURL};

    fn app_description(path: PathBuf) -> OpenApplication {
        let text = NSString::from_str(&path.to_string_lossy());
        let bundle = NSBundle::bundleWithURL(&NSURL::fileURLWithPath(&text));
        let value = |key: &str| {
            bundle
                .as_ref()
                .and_then(|bundle| bundle.objectForInfoDictionaryKey(&NSString::from_str(key)))
                .and_then(|value| value.downcast::<NSString>().ok())
                .map(|value| value.to_string())
                .filter(|value| !value.is_empty())
        };
        let name = value("CFBundleDisplayName")
            .or_else(|| value("CFBundleName"))
            .unwrap_or_else(|| {
                NSFileManager::defaultManager()
                    .displayNameAtPath(&text)
                    .to_string()
            });
        OpenApplication {
            path: path.to_string_lossy().into_owned(),
            name,
            bundle_id: bundle
                .as_ref()
                .and_then(|bundle| bundle.bundleIdentifier())
                .map(|s| s.to_string()),
            version: value("CFBundleShortVersionString").or_else(|| value("CFBundleVersion")),
        }
    }
    pub(super) fn list(path: &Path) -> Result<OpenWithApplications, String> {
        autoreleasepool(|_| {
            let workspace = NSWorkspace::sharedWorkspace();
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
            let default = workspace
                .URLForApplicationToOpenURL(&url)
                .and_then(|url| url.path())
                .and_then(|path| application(&path.to_string()).ok());
            let urls = workspace.URLsForApplicationsToOpenURL(&url);
            let mut paths = vec![];
            if let Some(default) = &default {
                paths.push(default.clone());
            }
            for url in urls.iter() {
                if let Some(path) = url
                    .path()
                    .and_then(|path| application(&path.to_string()).ok())
                {
                    if !paths.contains(&path) {
                        paths.push(path);
                    }
                }
            }
            Ok(OpenWithApplications {
                default_app: default.map(|path| path.to_string_lossy().into_owned()),
                apps: paths.into_iter().map(app_description).collect(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "bento-native-actions-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self, name: &str) -> String {
            let path = self.0.join(name);
            fs::write(&path, "fixture").unwrap();
            path.to_string_lossy().into_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn launch_failure_returns_nonzero_status_and_native_diagnostic() {
        let error = checked_output(
            Command::new("/bin/sh")
                .args(["-c", "printf 'LaunchServices rejected request' >&2; exit 7"]),
        )
        .unwrap_err();
        assert!(error.contains("7"));
        assert!(error.contains("LaunchServices rejected request"));
        checked_output(Command::new("/bin/sh").args(["-c", "exit 0"])).unwrap();
    }
    #[test]
    fn selection_validates_entire_batch_before_launch_and_keeps_literal_paths() {
        let fixture = Fixture::new();
        let path = fixture.file("汉字 ' $;\n--file.txt");
        assert_eq!(
            selection(vec![path.clone(), path.clone()]).unwrap(),
            [PathBuf::from(&path)]
        );
        assert!(selection(vec![]).is_err());
        assert!(selection(vec![path.clone(); 65]).is_err());
        assert!(selection(vec![
            path.clone(),
            fixture.0.join("missing").to_string_lossy().into_owned()
        ])
        .is_err());
        assert!(selection(vec!["relative.txt".into()]).is_err());
        assert!(selection(vec!["https://example.com/file.txt".into()]).is_err());
        assert_eq!(
            open_target("https://example.com/help?q=a%20b").unwrap(),
            "https://example.com/help?q=a%20b"
        );
        assert_eq!(open_target(&path).unwrap(), path);
        for invalid in [
            "javascript:alert(1)",
            "file:///tmp/a",
            "-a Calculator",
            " https://example.com",
        ] {
            assert!(open_target(invalid).is_err());
        }
    }
    #[test]
    fn open_and_archive_commands_use_literal_argv_and_explicit_system_handler() {
        let paths = [
            PathBuf::from("/tmp/a ' $;\nfile.zip"),
            PathBuf::from("/tmp/-second.zip"),
        ];
        let command = open_command(&paths, Some(Path::new("/Applications/Some App.app")), None);
        assert_eq!(command.get_program(), "/usr/bin/open");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "-a",
                "/Applications/Some App.app",
                "--",
                "/tmp/a ' $;\nfile.zip",
                "/tmp/-second.zip"
            ]
        );
        let archive = open_command(&paths, None, Some("com.apple.archiveutility"));
        assert_eq!(
            archive.get_args().collect::<Vec<_>>(),
            [
                "-b",
                "com.apple.archiveutility",
                "--",
                "/tmp/a ' $;\nfile.zip",
                "/tmp/-second.zip"
            ]
        );
    }
    #[test]
    fn extraction_rejects_unsupported_formats_and_nonfiles_before_any_launch() {
        let fixture = Fixture::new();
        for name in ["a.ZIP", "b.tar.gz", "c.tar.bz2", "d.tar.xz", "e.cpio"] {
            assert_eq!(archive_paths(vec![fixture.file(name)]).unwrap().len(), 1);
        }
        for name in ["a.rar", "b.7z", "c.txt"] {
            assert!(archive_paths(vec![fixture.file(name)]).is_err());
        }
        let folder = fixture.0.join("folder.zip");
        fs::create_dir(&folder).unwrap();
        assert!(archive_paths(vec![folder.to_string_lossy().into_owned()]).is_err());
        assert!(application(&fixture.file("not-app.txt")).is_err());
    }
    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "read-only native app discovery probe; set BENTO_QA_OPEN_WITH_PATH"]
    fn manual_installed_open_with_probe() {
        let path = std::env::var("BENTO_QA_OPEN_WITH_PATH").expect("set BENTO_QA_OPEN_WITH_PATH");
        let apps = tauri::async_runtime::block_on(list_open_with(path)).unwrap();
        println!(
            "BENTO_QA_OPEN_WITH={}",
            serde_json::to_string(&apps).unwrap()
        );
        if let Some(default) = &apps.default_app {
            assert_eq!(&apps.apps[0].path, default);
        }
        assert_eq!(
            apps.apps
                .iter()
                .map(|app| &app.path)
                .collect::<HashSet<_>>()
                .len(),
            apps.apps.len()
        );
    }
}
