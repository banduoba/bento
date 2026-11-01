use rayon::prelude::*;
use serde::Serialize;

#[cfg(target_os = "macos")]
mod quick_look;
#[cfg(target_os = "macos")]
mod native_files;

use std::ffi::CString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

mod rename_preview;
mod session_store;
mod session_exit;
mod list_stream;
mod native_icons;
mod search_results;
use native_icons::file_icons;

use bento_fswatch::{make_entry, Entry, FsWatcher};

/// fsearch 引擎（getattrlistbulk 全盘索引 + FSEvents 实时更新 + 模糊匹配）
/// 懒初始化：首次全局搜索时启动，首轮建索引期间查询会 Err → 回退 mdfind
static FSEARCH: OnceLock<Option<fsearch::Engine>> = OnceLock::new();

fn fsearch_engine() -> Option<&'static fsearch::Engine> {
    FSEARCH
        .get_or_init(|| {
            let home = std::env::var("HOME").unwrap_or_default();
            match fsearch::Engine::start(fsearch::Options {
                dir: fsearch::default_dir(&home),
                home: home.clone(),
                skip: None,
            }) {
                Ok(e) => Some(e),
                Err(err) => {
                    eprintln!("fsearch init failed: {err}");
                    None
                }
            }
        })
        .as_ref()
}

#[derive(Serialize)]
struct ListResult {
    entries: Vec<Entry>,
}

/// 并行列出目录内容（rayon 多线程 stat，大文件夹扫描快）。
/// 窗格打开当前目录走 `list_dir_stream`，大约 500 条一批，第一屏不用等整表。
/// 侧边栏、展开的子目录和 bench 扫描仍用这一次返回。
#[tauri::command]
async fn list_dir(path: String, show_hidden: bool) -> Result<ListResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rd = fs::read_dir(&path).map_err(|e| format!("无法读取目录 {}: {}", path, e))?;
        let items: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        let entries: Vec<Entry> = items
            .par_iter()
            .filter_map(|p| {
                let name = p.file_name()?.to_string_lossy().into_owned();
                if !show_hidden && name.starts_with('.') {
                    return None;
                }
                make_entry(p, name)
            })
            .collect();
        Ok(ListResult { entries })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 生成不冲突的目标路径：name 已存在时用 "name 2"、"name 3"…
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if entry_available(&candidate) {
        return candidate;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for i in 2..10000u32 {
        let c = dir.join(format!("{} {}{}", stem, i, ext));
        if entry_available(&c) {
            return c;
        }
    }
    dir.join(format!("{}-{}", name, std::process::id()))
}

/// 拷贝/移动时目标重名的命名：「name copy.ext」，再重名依次「name copy 1.ext」「name copy 2.ext」…
/// 对已带「copy[ N]」后缀的名字（以及旧版的中文「副本[N]」）先去掉后缀再编号
/// （「a copy.txt」再拷 → 「a copy 1.txt」，而不是「a copy copy.txt」）
#[cfg(any(not(target_os = "macos"), test))]
fn strip_copy_suffix(stem: &str) -> &str {
    if let Some(i) = stem.rfind(" copy") {
        let rest = &stem[i + " copy".len()..];
        let numbered = rest.strip_prefix(' ').map_or(false, |d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit()));
        if rest.is_empty() || numbered {
            return &stem[..i];
        }
    }
    if let Some(i) = stem.rfind(" 副本") {
        if stem[i + " 副本".len()..].chars().all(|c| c.is_ascii_digit()) {
            return &stem[..i];
        }
    }
    stem
}

#[cfg(any(not(target_os = "macos"), test))]
fn copy_name_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if entry_available(&candidate) {
        return candidate;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let base = strip_copy_suffix(stem);
    let first = dir.join(format!("{} copy{}", base, ext));
    if entry_available(&first) {
        return first;
    }
    for i in 1..10000u32 {
        let c = dir.join(format!("{} copy {}{}", base, i, ext));
        if entry_available(&c) {
            return c;
        }
    }
    dir.join(format!("{}-{}", name, std::process::id()))
}

fn entry_available(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path), Err(err) if err.kind() == io::ErrorKind::NotFound)
}

/// The kernel checks absence and renames in one operation, including dangling links.
fn rename_no_replace(src: &Path, dst: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let src = CString::new(src.as_os_str().as_bytes())?;
    let dst = CString::new(dst.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let rc = unsafe { libc::renamex_np(src.as_ptr(), dst.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let rc = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            src.as_ptr(),
            libc::AT_FDCWD,
            dst.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "此平台不支持非覆盖移动",
    ));
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn create_private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path)?;
    #[cfg(target_os = "macos")]
    {
        // POSIX mode alone does not revoke ACLs inherited from the destination.
        use std::os::unix::ffi::OsStrExt;
        unsafe extern "C" {
            fn acl_init(count: libc::c_int) -> *mut libc::c_void;
            fn acl_set_file(
                path: *const libc::c_char,
                kind: libc::c_int,
                acl: *mut libc::c_void,
            ) -> libc::c_int;
            fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
        }
        let name = CString::new(path.as_os_str().as_bytes())?;
        let acl = unsafe { acl_init(0) };
        let result = if acl.is_null() {
            Err(io::Error::last_os_error())
        } else {
            let rc = unsafe {
                acl_set_file(name.as_ptr(), 0x100 /* ACL_TYPE_EXTENDED */, acl)
            };
            let error = if rc == 0 {
                None
            } else {
                Some(io::Error::last_os_error())
            };
            unsafe {
                acl_free(acl);
            }
            error.map_or(Ok(()), Err)
        };
        if let Err(error) = result {
            let _ = fs::remove_dir(path);
            return Err(error);
        }
    }
    Ok(())
}

// Keep APFS clone-on-write copies; the private staging parent protects cloned ACLs.
#[cfg(any(not(target_os = "macos"), test))]
fn copy_regular_file(src: &Path, dst: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let source = CString::new(src.as_os_str().as_bytes())?;
        let dest = CString::new(dst.as_os_str().as_bytes())?;
        if unsafe { libc::clonefile(source.as_ptr(), dest.as_ptr(), 0) } == 0 {
            return Ok(());
        }
    }
    use std::os::unix::fs::OpenOptionsExt;
    let mut input = fs::File::open(src)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(dst)?;
    io::copy(&mut input, &mut output)?;
    Ok(())
}

/// macOS metadata includes mode, ACLs, extended attributes, and timestamps.
/// Any unsupported/failed metadata operation aborts publication and source deletion.
#[cfg(any(not(target_os = "macos"), test))]
fn preserve_move_metadata(src: &Path, dst: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let src = CString::new(src.as_os_str().as_bytes())?;
        let dst = CString::new(dst.as_os_str().as_bytes())?;
        let rc = unsafe {
            libc::copyfile(
                src.as_ptr(),
                dst.as_ptr(),
                std::ptr::null_mut(),
                libc::COPYFILE_METADATA | libc::COPYFILE_NOFOLLOW,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let meta = fs::symlink_metadata(src)?;
        if !meta.file_type().is_symlink() {
            fs::set_permissions(dst, meta.permissions())?;
        }
        Ok(())
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn is_exdev(err: &io::Error) -> bool {
    err.raw_os_error() == Some(libc::EXDEV) || err.kind() == io::ErrorKind::CrossesDevices
}

/// 跨卷复制用：保留符号链接本身，不跟随链接去复制（或删除）目标。
#[cfg(any(not(target_os = "macos"), test))]
fn copy_for_move(src: &Path, dst: &Path) -> io::Result<()> {
    copy_for_move_with(src, dst, &preserve_move_metadata)
}

#[cfg(any(not(target_os = "macos"), test))]
fn copy_for_move_with(
    src: &Path,
    dst: &Path,
    metadata: &impl Fn(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        std::os::unix::fs::symlink(fs::read_link(src)?, dst)?;
    } else if meta.is_dir() {
        // Private from its first instant, writable during population even for 0500 sources.
        create_private_dir(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_for_move_with(&entry.path(), &dst.join(entry.file_name()), metadata)?;
        }
    } else if meta.is_file() {
        copy_regular_file(src, dst)?;
    } else {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "不支持移动此类文件",
        ));
    }
    metadata(src, dst)
        .map_err(|err| io::Error::new(err.kind(), format!("无法保留文件元数据: {err}")))?;
    if !meta.file_type().is_symlink() {
        use std::os::unix::fs::PermissionsExt;
        if fs::symlink_metadata(dst)?.permissions().mode() & 0o7777
            != meta.permissions().mode() & 0o7777
        {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "目标卷无法保留文件权限，源文件保持原样",
            ));
        }
    }
    Ok(())
}

#[cfg(any(not(target_os = "macos"), test))]
fn remove_path(path: &Path) -> io::Result<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        fs::remove_file(path)
    } else {
        fs::remove_dir_all(path)
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn temp_move_dir(dir: &Path) -> io::Result<PathBuf> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    for _ in 0..1000 {
        let seq = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let candidate = dir.join(format!(".bento-move-{}-{seq}", std::process::id()));
        match create_private_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "无法创建安全临时目录",
    ))
}

// Only called on our exclusively created private staging tree.
#[cfg(any(not(target_os = "macos"), test))]
fn cleanup_staging(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.is_dir() && !meta.file_type().is_symlink() {
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    cleanup_staging(&entry.path());
                }
            }
            let _ = fs::remove_dir(path);
        } else {
            let _ = fs::remove_file(path);
        }
    }
}

// Keep publication state structured across the io::Error boundary. A later deletion failure
// must refresh changed directories and must never retry under a new destination name.
#[cfg(any(not(target_os = "macos"), test))]
#[derive(Debug)]
struct PublishedDestination {
    dest: PathBuf,
    error: io::Error,
}
#[cfg(any(not(target_os = "macos"), test))]
impl std::fmt::Display for PublishedDestination {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "已复制到「{}」，但无法删除源（请检查源是否残留）: {}", self.dest.display(), self.error)
    }
}
#[cfg(any(not(target_os = "macos"), test))]
impl std::error::Error for PublishedDestination {}

#[cfg(any(not(target_os = "macos"), test))]
fn published_destination(error: &io::Error) -> Option<&Path> {
    error.get_ref()?.downcast_ref::<PublishedDestination>().map(|state| state.dest.as_path())
}

/// 跨卷移动：先把内容复制到目标卷的临时名，改名成功后才删除源。
/// 复制或改名失败时删掉临时文件，源保持原样。
#[cfg(any(not(target_os = "macos"), test))]
fn copy_then_remove(src: &Path, dst: &Path) -> io::Result<()> {
    copy_then_remove_with(src, dst, copy_for_move, remove_path)
}

#[cfg(any(not(target_os = "macos"), test))]
fn copy_then_remove_with(
    src: &Path,
    dst: &Path,
    copy: impl FnOnce(&Path, &Path) -> io::Result<()>,
    remove_src: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let parent = dst
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "目标路径无效"))?;
    let staging = temp_move_dir(parent)?;
    let tmp = staging.join("item");
    if let Err(err) = copy(src, &tmp) {
        cleanup_staging(&staging);
        return Err(io::Error::new(
            err.kind(),
            format!("复制未完成，源文件保持原样: {err}"),
        ));
    }
    if let Err(err) = rename_no_replace(&tmp, dst) {
        cleanup_staging(&staging);
        return Err(io::Error::new(
            err.kind(),
            format!("复制未完成，源文件保持原样: {err}"),
        ));
    }
    cleanup_staging(&staging);
    if let Err(err) = remove_src(src) {
        return Err(io::Error::new(
            err.kind(),
            PublishedDestination { dest: dst.to_path_buf(), error: err },
        ));
    }
    Ok(())
}

/// 同卷 rename；仅当内核返回 EXDEV 时才复制后删除。
#[cfg(any(not(target_os = "macos"), test))]
fn relocate(src: &Path, dst: &Path) -> io::Result<()> {
    relocate_with(src, dst, rename_no_replace)
}

#[cfg(any(not(target_os = "macos"), test))]
fn relocate_with(
    src: &Path,
    dst: &Path,
    rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    match rename(src, dst) {
        Ok(()) => Ok(()),
        Err(err) if is_exdev(&err) => copy_then_remove(src, dst),
        Err(err) => Err(io::Error::new(err.kind(), format!("移动失败: {err}"))),
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn do_transfer(sp: &Path, dp: &Path, mode: &str) -> io::Result<()> {
    if mode == "move" {
        relocate(sp, dp)
    } else {
        copy_then_remove_with(sp, dp, copy_for_move, |_| Ok(()))
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn failed_transfer(source: &str, error: io::Error) -> TransferItem {
    let published = published_destination(&error);
    let affected_directories = if let Some(dest) = published {
        [Path::new(source).parent(), dest.parent()].into_iter().flatten()
            .map(|path| path.to_string_lossy().into_owned()).collect()
    } else { Vec::new() };
    TransferItem {
        source: source.to_string(),
        dest: published.map(|path| path.to_string_lossy().into_owned()).unwrap_or_default(),
        ok: false,
        error: Some(error.to_string()),
        affected_directories,
        ..Default::default()
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn transfer_one_item(source: &str, dest_dir: &Path, mode: &str) -> TransferItem {
    transfer_one_item_with(source, dest_dir, mode, do_transfer)
}

#[cfg(any(not(target_os = "macos"), test))]
fn transfer_one_item_with(
    source: &str,
    dest_dir: &Path,
    mode: &str,
    mut perform: impl FnMut(&Path, &Path, &str) -> io::Result<()>,
) -> TransferItem {
    let fail = |error: String| TransferItem {
        source: source.to_string(),
        dest: String::new(),
        ok: false,
        error: Some(error),
        affected_directories: Vec::new(),
        ..Default::default()
    };
    let sp = PathBuf::from(source);
    if fs::symlink_metadata(&sp).is_err() {
        return fail("源不存在".into());
    }
    // 已经在目标目录：剪切后粘贴到原处，不动文件。
    if mode == "move" && sp.parent().is_some_and(|parent| parent == dest_dir) {
        return TransferItem {
            source: source.to_string(),
            dest: source.to_string(),
            ok: true,
            error: None,
            affected_directories: Vec::new(),
            ..Default::default()
        };
    }
    let name = sp
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "untitled".into());
    for _ in 0..10000 {
        let dp = copy_name_path(dest_dir, &name);
        if dp.starts_with(&sp) {
            return fail("不能将文件夹移动到其自身内部".into());
        }
        match perform(&sp, &dp, mode) {
            Ok(()) => {
                return TransferItem {
                    source: source.to_string(),
                    dest: dp.to_string_lossy().into_owned(),
                    ok: true,
                    error: None,
                    affected_directories: Vec::new(),
                    ..Default::default()
                }
            }
            Err(err) if published_destination(&err).is_some() => return failed_transfer(source, err),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return failed_transfer(source, err),
        }
    }
    fail("目标重名冲突过多，请重试".into())
}

#[cfg(any(not(target_os = "macos"), test))]
fn move_one_item(source: &str, dest_dir: &Path) -> TransferItem {
    transfer_one_item(source, dest_dir, "move")
}

#[cfg(any(not(target_os = "macos"), test))]
fn move_into(
    sources: &[String],
    dest: &str,
    mut on_each: impl FnMut(usize, usize),
) -> Result<Vec<TransferItem>, String> {
    let dest_dir = PathBuf::from(dest);
    if !dest_dir.is_dir() {
        return Err(format!("目标不是文件夹: {dest}"));
    }
    let total = sources.len();
    let mut out = Vec::with_capacity(total);
    for (i, source) in sources.iter().enumerate() {
        out.push(move_one_item(source, &dest_dir));
        on_each(i + 1, total);
    }
    Ok(out)
}

#[derive(Serialize, Clone, Debug, Default)]
struct TransferItem {
    source: String,
    dest: String,
    ok: bool,
    error: Option<String>,
    #[serde(rename = "affectedDirectories", skip_serializing_if = "Vec::is_empty")]
    affected_directories: Vec<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<FileIdentity>,
}

#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
    dev: String,
    ino: String,
}

fn file_identity(path: &Path) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path)?;
    Ok(FileIdentity {
        dev: metadata.dev().to_string(),
        ino: metadata.ino().to_string(),
    })
}

/// A completed write remains successful even when its identity cannot be read.
/// Only identified receipts may be registered for Undo.
#[derive(Serialize, Debug)]
struct WriteReceipt {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<FileIdentity>,
}

fn completion_receipt(path: PathBuf) -> WriteReceipt {
    WriteReceipt { identity: file_identity(&path).ok(), path: path.to_string_lossy().into_owned() }
}

#[derive(Serialize, Debug, Default)]
struct WriteBatch {
    entries: Vec<WriteReceipt>,
    error: Option<String>,
}

fn check_identity(path: &Path, expected: Option<&FileIdentity>) -> io::Result<()> {
    let actual = file_identity(path)?;
    if expected.is_some_and(|expected| *expected != actual) {
        return Err(io::Error::other("文件已被替换，无法安全撤销"));
    }
    Ok(())
}

/// macOS delegates progress, conflicts and cancellation to Finder/AppKit.
#[tauri::command]
async fn transfer(
    app: AppHandle,
    sources: Vec<String>,
    dest: String,
    mode: String,
) -> Result<Vec<TransferItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            native_files::transfer(&app, &sources, &dest, &mode)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let dest_dir = PathBuf::from(&dest);
            if !dest_dir.is_dir() {
                return Err(format!("目标不是文件夹: {dest}"));
            }
            let _ = app;
            Ok(sources
                .iter()
                .map(|s| transfer_one_item(s, &dest_dir, &mode))
                .collect())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Deserialize)]
struct RestoreMove {
    source: String,
    dest: String,
    identity: Option<FileIdentity>,
}

#[cfg(any(not(target_os = "macos"), test))]
fn restore_into(moves: &[RestoreMove]) -> Vec<TransferItem> {
    moves
        .iter()
        .map(|m| {
            let src = Path::new(&m.source);
            let dst = Path::new(&m.dest);
            let result = (|| {
                if !src.is_absolute() || !dst.is_absolute() || dst.file_name().is_none() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "恢复需要完整文件路径",
                    ));
                }
                check_identity(src, m.identity.as_ref())?;
                if src == dst {
                    return Ok(());
                }
                if dst.starts_with(src) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "不能恢复到自身内部",
                    ));
                }
                // Exact restoration never invents a new basename or recreates missing parents.
                relocate(src, dst)
            })();
            TransferItem {
                source: m.source.clone(),
                dest: m.dest.clone(),
                ok: result.is_ok(),
                error: result.err().map(|e| e.to_string()),
                affected_directories: Vec::new(),
                ..Default::default()
            }
        })
        .collect()
}

#[tauri::command]
async fn restore_moves(moves: Vec<RestoreMove>) -> Result<Vec<TransferItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            native_files::restore(&moves)
        }
        #[cfg(not(target_os = "macos"))]
        {
            restore_into(&moves)
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Cut/paste uses the same native move path as drag/drop.
#[tauri::command]
async fn move_items(
    app: AppHandle,
    sources: Vec<String>,
    dest: String,
) -> Result<Vec<TransferItem>, String> {
    transfer(app, sources, dest, "move".into()).await
}

#[derive(Serialize, Clone, Debug)]
struct TrashEntry {
    original: String,
    trashed: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<FileIdentity>,
}

#[derive(Serialize, Default, Debug)]
struct TrashResult {
    entries: Vec<TrashEntry>,
    error: Option<String>,
    cancelled: bool,
}

#[derive(serde::Deserialize)]
struct ExpectedIdentity {
    path: String,
    dev: String,
    ino: String,
}

#[tauri::command]
async fn trash(
    paths: Vec<String>,
    expected: Option<Vec<ExpectedIdentity>>,
    app: AppHandle,
) -> Result<TrashResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            native_files::trash(&app, &paths, expected.as_deref())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = app;
            for path in &paths {
                let identity = expected
                    .as_ref()
                    .and_then(|items| items.iter().find(|i| &i.path == path))
                    .map(|i| FileIdentity {
                        dev: i.dev.clone(),
                        ino: i.ino.clone(),
                    });
                check_identity(Path::new(path), identity.as_ref()).map_err(|e| e.to_string())?;
            }
            trash::delete_all(&paths).map_err(|e| e.to_string())?;
            Ok(TrashResult::default())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 新建文件夹，自动命名「未命名文件夹」「未命名文件夹 2」…，返回实际路径
#[tauri::command]
async fn make_dir(path: String) -> Result<String, String> {
    Ok(make_dir_with_receipt(path).await?.path)
}

#[tauri::command]
async fn make_dir_with_receipt(path: String) -> Result<WriteReceipt, String> {
    let target = place_new_file(Path::new(&path), "未命名文件夹", |path| fs::create_dir(path), "创建失败")?;
    Ok(completion_receipt(target))
}

/// Pure name preview; deliberately does not receive paths or touch the filesystem.
#[tauri::command]
async fn regex_rename_preview(names: Vec<String>, pattern: String, replacement: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || rename_preview::replace_names(&names, &pattern, &replacement))
        .await.map_err(|error| format!("正则预览失败：{error}"))?
}

#[tauri::command]
async fn rename(old_path: String, new_name: String) -> Result<String, String> {
    Ok(rename_with_receipt(old_path, new_name).await?.path)
}

#[tauri::command]
async fn rename_with_receipt(old_path: String, new_name: String) -> Result<WriteReceipt, String> {
    let old = PathBuf::from(&old_path);
    let name = new_name.trim();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    if name.contains('/') || name == "." || name == ".." {
        return Err("名称不合法".into());
    }
    let dest = match old.parent() {
        Some(p) => p.join(name),
        None => return Err("路径错误".into()),
    };
    if !entry_available(&dest) && dest != old {
        return Err(format!("「{}」已存在", name));
    }
    if dest != old { rename_no_replace(&old, &dest).map_err(|e| format!("重命名失败: {}", e))?; }
    Ok(completion_receipt(dest))
}

#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-R", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ZipOptions {
    /// 压缩包文件名（不含路径；缺省：单个源=源名.zip，多个源=归档.zip）
    name: Option<String>,
    /// 压缩级别 0-9（速度快=1，体积小=9，自定义=1..9），缺省 1
    level: Option<u8>,
    password: Option<String>,
    /// 多个源时各自压成独立的 zip
    separate: Option<bool>,
}

/// 调系统 zip 创建一个归档。源在同一父目录时在该目录下压缩（保留符号链接 -y）；
/// 源分散在不同目录时，先在临时目录里建符号链接再压缩（不加 -y，跟随链接存真实内容）。
/// 注意：密码通过 `-P` 传入（传统 ZipCrypto，macOS 归档实用工具可直接解压；进程列表短暂可见）。
fn run_zip(sources: &[String], dest: &Path, level: u8, password: Option<&str>) -> Result<(), String> {
    let mut cmd = std::process::Command::new("zip");
    cmd.args(["-r", "-q"]).arg(format!("-{}", level.min(9)));
    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        cmd.arg("-P").arg(pw);
    }
    let first_parent = Path::new(&sources[0]).parent().map(|p| p.to_path_buf());
    let same_parent = first_parent.is_some()
        && sources.iter().all(|s| Path::new(s).parent().map(|p| p.to_path_buf()) == first_parent);
    let base_name = |s: &str| {
        Path::new(s)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "item".into())
    };
    let mut stage: Option<PathBuf> = None;
    let mut names: Vec<String> = Vec::new();
    if same_parent {
        cmd.arg("-y").current_dir(first_parent.unwrap());
        names.extend(sources.iter().map(|s| base_name(s)));
    } else {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let st = std::env::temp_dir().join(format!("bento-zip-{}-{}", std::process::id(), nanos));
        fs::create_dir_all(&st).map_err(|e| format!("压缩失败: {}", e))?;
        for s in sources {
            let link = unique_path(&st, &base_name(s));
            if let Err(e) = std::os::unix::fs::symlink(s, &link) {
                let _ = fs::remove_dir_all(&st);
                return Err(format!("压缩失败: {}", e));
            }
            names.push(link.file_name().unwrap().to_string_lossy().into_owned());
        }
        cmd.current_dir(&st);
        stage = Some(st);
    }
    cmd.arg(dest).args(&names).args(["-x", "*.DS_Store"]);
    let out = cmd.output();
    if let Some(st) = stage {
        let _ = fs::remove_dir_all(st);
    }
    let out = out.map_err(|e| format!("压缩失败: {}", e))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("压缩失败: {}", if msg.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { msg }));
    }
    Ok(())
}

/// 压缩为 zip，返回创建的 zip 路径列表（「单独压缩」时每个源一个）
#[tauri::command]
async fn zip_paths(sources: Vec<String>, dest_dir: String, options: Option<ZipOptions>) -> Result<Vec<String>, String> {
    let result = zip_paths_with_receipt(sources, dest_dir, options).await?;
    if let Some(error) = result.error { return Err(error); }
    Ok(result.entries.into_iter().map(|entry| entry.path).collect())
}

#[tauri::command]
async fn zip_paths_with_receipt(sources: Vec<String>, dest_dir: String, options: Option<ZipOptions>) -> Result<WriteBatch, String> {
    tauri::async_runtime::spawn_blocking(move || zip_paths_into(sources, PathBuf::from(dest_dir), options.unwrap_or_default()))
        .await.map_err(|e| e.to_string())?
}

fn zip_paths_into(sources: Vec<String>, dir: PathBuf, opts: ZipOptions) -> Result<WriteBatch, String> {
    if !dir.is_dir() {
        return Err(format!("目标不是文件夹: {}", dir.display()));
    }
    if sources.is_empty() {
        return Ok(WriteBatch::default());
    }
    let level = opts.level.unwrap_or(1).min(9);
    let base_of = |s: &str| {
        Path::new(s)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "归档".into())
    };
    let groups: Vec<(Vec<String>, String)> = if opts.separate.unwrap_or(false) && sources.len() > 1 {
        sources.iter().map(|s| (vec![s.clone()], format!("{}.zip", base_of(s)))).collect()
    } else {
        let name = match opts.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) if n.to_lowercase().ends_with(".zip") => n.to_string(),
            Some(n) => format!("{}.zip", n),
            None if sources.len() == 1 => format!("{}.zip", base_of(&sources[0])),
            None => "归档.zip".to_string(),
        };
        vec![(sources.clone(), name)]
    };
    let mut created = Vec::new();
    for (srcs, name) in groups {
        let dest = unique_path(&dir, &name.replace('/', "_"));
        if let Err(e) = run_zip(&srcs, &dest, level, opts.password.as_deref()) {
            let _ = fs::remove_file(&dest);
            return Ok(WriteBatch { entries: created, error: Some(e) });
        }
        created.push(completion_receipt(dest));
    }
    Ok(WriteBatch { entries: created, error: None })
}

/// 在终端中打开目录
#[tauri::command]
async fn open_terminal(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-a", "Terminal", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// macOS 快速查看：系统 QLPreviewPanel（与 Finder 空格预览同一面板）。
/// `path` 是当前焦点文件；`paths` 可选，多选时按列表顺序预览（空格再次按下则关闭）。
#[tauri::command]
async fn quick_look(
    app: AppHandle,
    path: String,
    paths: Option<Vec<String>>,
    session: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return quick_look::present(app, path, paths, session).await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path, paths, session);
        Err("Quick Look 仅支持 macOS".into())
    }
}

/// Replace the visible item without toggling the panel; stale sessions/revisions are ignored.
#[tauri::command]
async fn update_quick_look(
    app: AppHandle,
    path: String,
    paths: Option<Vec<String>>,
    session: String,
    revision: u64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return quick_look::update(app, path, paths, session, revision).await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path, paths, session, revision);
        Err("Quick Look 仅支持 macOS".into())
    }
}

/// 内置新建文件的默认名。界面是简体中文，所以用「未命名」而不是 Untitled。
fn new_file_basename(kind: &str) -> Result<&'static str, String> {
    match kind {
        "text" | "txt" => Ok("未命名.txt"),
        "markdown" | "md" => Ok("未命名.md"),
        other => Err(format!("不支持的文件类型: {other}")),
    }
}

/// 独占创建：目标已存在时返回 AlreadyExists，调用方换下一个名字，绝不覆盖。
fn create_empty_exclusive(path: &Path) -> io::Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
}

fn copy_exclusive(src: &Path, dst: &Path) -> io::Result<()> {
    let mut input = fs::File::open(src)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dst)?;
    if let Err(e) = io::copy(&mut input, &mut output) {
        drop(output);
        let _ = fs::remove_file(dst);
        return Err(e);
    }
    if let Ok(perm) = input.metadata().map(|m| m.permissions()) {
        let _ = fs::set_permissions(dst, perm);
    }
    Ok(())
}

/// 在目录里放一个不重名的新文件。已占用时用「名称 2.ext」「名称 3.ext」…
/// `create_new` 失败才换名，避免先检查再创建的窗口里把已有文件盖掉。
fn place_new_file(
    dir: &Path,
    name: &str,
    mut write: impl FnMut(&Path) -> io::Result<()>,
    verb: &str,
) -> Result<PathBuf, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err("名称不合法".into());
    }
    if !dir.is_dir() {
        return Err(format!("不是文件夹: {}", dir.display()));
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut last_err: Option<String> = None;
    for i in 1..10000u32 {
        let candidate = if i == 1 {
            dir.join(name)
        } else {
            dir.join(format!("{stem} {i}{ext}"))
        };
        match write(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                last_err = Some(e.to_string());
                break;
            }
        }
    }
    Err(match last_err {
        Some(e) => format!("{verb}: {e}"),
        None => format!("{verb}: 没有可用的文件名"),
    })
}

fn create_named_file(dir: &Path, kind: &str) -> Result<PathBuf, String> {
    let name = new_file_basename(kind)?;
    place_new_file(dir, name, create_empty_exclusive, "创建失败")
}

/// 新建空白文本文档，返回实际路径。保留给已有调用；新界面走 `create_file`。
#[tauri::command]
async fn make_file(path: String) -> Result<String, String> {
    create_file(path, "text".into()).await
}

/// 在当前文件夹新建空白文件。`kind` 为 `text` / `markdown`。
/// 重名时自动「未命名 2.txt」「未命名 2.md」，不覆盖。
#[tauri::command]
async fn create_file(dir: String, kind: String) -> Result<String, String> {
    Ok(create_file_with_receipt(dir, kind).await?.path)
}

#[tauri::command]
async fn create_file_with_receipt(dir: String, kind: String) -> Result<WriteReceipt, String> {
    Ok(completion_receipt(create_named_file(Path::new(&dir), &kind)?))
}

#[derive(Serialize, Clone, Debug)]
struct FileTemplate {
    name: String,
    path: String,
}

fn ensure_templates_dir(app_dir: &Path) -> Result<PathBuf, String> {
    let dir = app_dir.join("templates");
    fs::create_dir_all(&dir).map_err(|e| format!("创建模板目录失败: {e}"))?;
    Ok(dir)
}

/// 只列出模板目录顶层的普通文件。隐藏文件、子目录、指向目录外的符号链接都不算模板。
fn scan_templates(dir: &Path) -> Result<Vec<FileTemplate>, String> {
    let rd = fs::read_dir(dir).map_err(|e| format!("读取模板目录失败: {e}"))?;
    let mut items = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        items.push(FileTemplate {
            name,
            path: entry.path().to_string_lossy().into_owned(),
        });
    }
    items.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(items)
}

fn resolve_template(templates_root: &Path, template: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(templates_root).map_err(|e| format!("模板目录不可用: {e}"))?;
    let src =
        fs::canonicalize(template).map_err(|_| format!("模板不存在: {}", template.display()))?;
    if !src.starts_with(&root) {
        return Err("模板必须位于模板目录内".into());
    }
    if !src.is_file() {
        return Err("模板不是文件".into());
    }
    Ok(src)
}

fn copy_template_file(
    templates_root: &Path,
    dest_dir: &Path,
    template: &Path,
) -> Result<PathBuf, String> {
    let src = resolve_template(templates_root, template)?;
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .ok_or_else(|| "模板名称无效".to_string())?;
    let src_for_copy = src.clone();
    place_new_file(
        dest_dir,
        &name,
        move |dst| copy_exclusive(&src_for_copy, dst),
        "复制模板失败",
    )
}

/// 应用支持目录下的 `templates/`。启动时会创建；打开「新建」菜单时再扫一次。
#[tauri::command]
async fn list_templates(app: AppHandle) -> Result<Vec<FileTemplate>, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = ensure_templates_dir(&app_dir)?;
    scan_templates(&dir)
}

/// 把模板复制到当前文件夹（保留文件名与内容），重名时加「 2」后缀，然后由界面进入重命名。
#[tauri::command]
async fn copy_template(dir: String, template: String, app: AppHandle) -> Result<String, String> {
    Ok(copy_template_with_receipt(dir, template, app).await?.path)
}

#[tauri::command]
async fn copy_template_with_receipt(dir: String, template: String, app: AppHandle) -> Result<WriteReceipt, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = ensure_templates_dir(&app_dir)?;
        let created = copy_template_file(&root, Path::new(&dir), Path::new(&template))?;
        Ok(completion_receipt(created))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone)]
struct SearchItem {
    name: String,
    path: String,
    dir: String,
    is_dir: bool,
    size: u64,
    mtime_ms: f64,
    btime_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    lines: Option<Vec<ContentLine>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    matches: Option<usize>,
}

#[derive(Serialize, Clone)]
struct ContentLine {
    no: f64,
    text: String,
}

fn mtime_of(md: &std::fs::Metadata) -> f64 {
    md.modified()
        .ok()
        .and_then(btime_ms_of)
        .unwrap_or(0.0)
}

fn btime_ms_of(t: std::time::SystemTime) -> Option<f64> {
    t.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as f64)
}

fn btime_of(md: &std::fs::Metadata) -> f64 {
    md.created().ok().and_then(btime_ms_of).unwrap_or(0.0)
}

fn glob_to_regex(glob: &str) -> String {
    let mut out = String::from("^");
    for ch in glob.chars() {
        match ch {
            '*' => out.push_str(".*"),
            '?' => out.push('.'),
            c => {
                if "\\.+()[]{}|^$".contains(c) {
                    out.push('\\');
                }
                out.push(c);
            }
        }
    }
    out.push('$');
    out
}

/// 搜索语法（对文件名，多词 AND）：
/// 纯文本 = 包含匹配；`*`/`?` = 通配符；`ext:jpg` = 后缀过滤；`re:正则` = 正则
/// 例：`*测试*.jpg` = 名字含"测试"的 jpg 文件
fn build_matcher(query: &str) -> Result<impl Fn(&str, &str) -> bool + Send, String> {
    let mut subs: Vec<String> = Vec::new();
    let mut res: Vec<regex::Regex> = Vec::new();
    let mut globs: Vec<regex::Regex> = Vec::new();
    let mut exts: Vec<String> = Vec::new();
    for term in query.split_whitespace() {
        let lower = term.to_lowercase();
        if let Some(pat) = lower.strip_prefix("re:") {
            let re = regex::Regex::new(pat).map_err(|e| format!("正则错误: {}", e))?;
            res.push(re);
        } else if let Some(e) = lower.strip_prefix("ext:").or_else(|| lower.strip_prefix('.')) {
            let e = e.trim_start_matches('.').to_string();
            if !e.is_empty() {
                exts.push(e);
            }
        } else if term.contains('*') || term.contains('?') {
            let re = regex::Regex::new(&glob_to_regex(&lower)).map_err(|e| format!("通配符错误: {}", e))?;
            globs.push(re);
        } else {
            subs.push(lower);
        }
    }
    Ok(move |name: &str, ext: &str| {
        let ln = name.to_lowercase();
        subs.iter().all(|s| ln.contains(s))
            && res.iter().all(|re| re.is_match(name))
            && globs.iter().all(|re| re.is_match(&ln))
            && (exts.is_empty() || exts.iter().any(|e| ext == e))
    })
}

/// Compatibility endpoint: one implementation owns every scope and filter.
#[tauri::command]
async fn search(
    query: String,
    scope: String,
    root: Option<String>,
    show_hidden: bool,
    limit: Option<usize>,
    roots: Option<Vec<String>>,
    mode: Option<String>,
) -> Result<Vec<SearchItem>, search_results::SearchError> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    search_results::search_query(
        query, scope, root, show_hidden, limit, roots, mode,
        format!("legacy_{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)), None,
    ).await.map(|r| r.items)
}

#[cfg(target_os = "macos")]
fn free_bytes(p: &Path) -> Result<u64, String> {
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(p.as_os_str().as_bytes()).map_err(|_| "路径错误".to_string())?;
    unsafe {
        let mut st: libc::statfs = std::mem::zeroed();
        let rc = libc::statfs(c.as_ptr(), &mut st);
        if rc != 0 {
            return Err("获取磁盘空间失败".into());
        }
        Ok((st.f_bavail as u64) * (st.f_bsize as u64))
    }
}

#[cfg(not(target_os = "macos"))]
fn free_bytes(_p: &Path) -> Result<u64, String> {
    Ok(0)
}

#[tauri::command]
async fn disk_space(path: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || free_bytes(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn home_dir() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "无法获取主目录".into())
}

/// 把 `~` / `~/...` 展开成主目录。其他 `~user` 形式与相对路径直接拒绝，
/// 避免 canonicalize 落到进程工作目录。
fn expand_user_path(raw: &str) -> Result<PathBuf, String> {
    let s = raw.trim();
    if s == "~" || s.starts_with("~/") {
        let home = std::env::var("HOME").map_err(|_| "无法获取主目录".to_string())?;
        return expand_with_home(s, &home);
    }
    expand_with_home(s, "")
}

/// `home` 仅在 `~` / `~/` 时使用。绝对路径与非法 `~user` 不读主目录。
fn expand_with_home(raw: &str, home: &str) -> Result<PathBuf, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("请输入路径".into());
    }
    let home = home.trim_end_matches('/');
    if s == "~" || s.starts_with("~/") {
        if s == "~" {
            return Ok(PathBuf::from(home));
        }
        return Ok(PathBuf::from(format!("{home}{}", &s[1..])));
    }
    if s.starts_with('~') {
        return Err("仅支持 ~ 与 ~/ 开头的路径".into());
    }
    if !s.starts_with('/') {
        return Err("请输入绝对路径或以 ~ 开头的路径".into());
    }
    Ok(PathBuf::from(s))
}

/// 展开 `~` 并 canonicalize。目标必须存在且是文件夹，否则返回可读错误。
fn resolve_existing_dir(raw: &str) -> Result<String, String> {
    let path = expand_user_path(raw)?;
    let shown = path.display().to_string();
    match fs::metadata(&path) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(format!("不是文件夹: {shown}")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(format!("路径不存在: {shown}"));
        }
        Err(e) => return Err(format!("无法打开路径 {shown}: {e}")),
    }
    let canon = fs::canonicalize(&path).map_err(|e| format!("无法解析路径 {shown}: {e}"))?;
    Ok(canon.to_string_lossy().into_owned())
}

/// 地址栏回车：展开 `~`、确认目录存在并返回规范路径。
#[tauri::command]
async fn resolve_path(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_existing_dir(&path))
        .await
        .map_err(|e| e.to_string())?
}

const COMPLETE_PATH_LIMIT: usize = 50;

#[derive(Serialize, Clone, Debug)]
struct PathMatch {
    name: String,
    is_dir: bool,
}

#[derive(Serialize, Clone, Debug)]
struct PathCompletion {
    /// 写回地址栏的文本。保留用户输入的 `~`；唯一的目录会带上末尾 `/`。
    text: String,
    /// 未完成的那一段之前的部分（含末尾 `/`）。前端用它拼接候选。
    base: String,
    matches: Vec<PathMatch>,
}

/// 地址栏 Tab：只读一层目录，按前缀返回至多 50 个候选。
#[tauri::command]
async fn complete_path(path: String) -> Result<PathCompletion, String> {
    tauri::async_runtime::spawn_blocking(move || complete_path_blocking(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn complete_path_blocking(raw: &str) -> Result<PathCompletion, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("请输入路径".into());
    }
    if s == "~" || s.starts_with("~/") {
        let home = std::env::var("HOME").map_err(|_| "无法获取主目录".to_string())?;
        return complete_with_home(s, &home);
    }
    complete_with_home(s, "")
}

fn complete_with_home(raw: &str, home: &str) -> Result<PathCompletion, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("请输入路径".into());
    }
    let base = completion_base(s);
    let (dir, prefix) = completion_dir_and_prefix(s, home)?;
    let matches = read_prefix_matches(&dir, &prefix)?;
    let text = completion_text(&base, &prefix, &matches);
    let matches = matches.into_iter().take(COMPLETE_PATH_LIMIT).collect();
    Ok(PathCompletion {
        text,
        base,
        matches,
    })
}

/// 保留用户写下的 `~`，并保证 base 以 `/` 结尾，方便直接拼接名字。
fn completion_base(s: &str) -> String {
    if s == "~" || s == "~/" {
        return "~/".to_string();
    }
    if s.ends_with('/') {
        return s.to_string();
    }
    match s.rfind('/') {
        Some(i) => s[..=i].to_string(),
        None => String::new(),
    }
}

fn completion_dir_and_prefix(s: &str, home: &str) -> Result<(PathBuf, String), String> {
    let list_children = s == "~" || s.ends_with('/');
    let expanded = expand_with_home(s, home)?;
    if list_children {
        return Ok((strip_trailing_slashes(expanded), String::new()));
    }
    let prefix = expanded
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parent = expanded
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("/"));
    Ok((parent, prefix))
}

fn strip_trailing_slashes(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if s == "/" {
        return PathBuf::from("/");
    }
    let trimmed = s.trim_end_matches('/');
    if trimmed.is_empty() {
        PathBuf::from("/")
    } else {
        PathBuf::from(trimmed)
    }
}

fn read_prefix_matches(dir: &Path, prefix: &str) -> Result<Vec<PathMatch>, String> {
    let shown = dir.display().to_string();
    match fs::metadata(dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(format!("不是文件夹: {shown}")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(format!("路径不存在: {shown}"));
        }
        Err(e) => return Err(format!("无法打开路径 {shown}: {e}")),
    }
    let rd = fs::read_dir(dir).map_err(|e| format!("无法读取目录 {shown}: {e}"))?;
    // 与 shell 一样：前缀不是 `.` 时不补全隐藏项，避免空前缀被点文件占满 50 个名额。
    let want_hidden = prefix.starts_with('.');
    let prefix_lower = prefix.to_lowercase();
    let mut matches = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue;
        }
        if !want_hidden && name.starts_with('.') {
            continue;
        }
        if !prefix_lower.is_empty() && !name.to_lowercase().starts_with(&prefix_lower) {
            continue;
        }
        matches.push(PathMatch {
            name,
            is_dir: entry_is_dir(&entry),
        });
    }
    matches.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.name.cmp(&b.name))
        })
    });
    Ok(matches)
}

fn entry_is_dir(entry: &fs::DirEntry) -> bool {
    match entry.file_type() {
        Ok(ft) if ft.is_dir() => true,
        Ok(ft) if ft.is_symlink() => fs::metadata(entry.path())
            .map(|m| m.is_dir())
            .unwrap_or(false),
        _ => false,
    }
}

fn completion_text(base: &str, prefix: &str, matches: &[PathMatch]) -> String {
    if matches.is_empty() {
        return format!("{base}{prefix}");
    }
    if matches.len() == 1 {
        let slash = if matches[0].is_dir { "/" } else { "" };
        return format!("{base}{}{slash}", matches[0].name);
    }
    let common = common_prefix_ci(matches.iter().map(|m| m.name.as_str()));
    if common.chars().count() >= prefix.chars().count() && common_ci_starts_with(&common, prefix) {
        return format!("{base}{common}");
    }
    format!("{base}{prefix}")
}

fn common_ci_starts_with(text: &str, prefix: &str) -> bool {
    text.to_lowercase().starts_with(&prefix.to_lowercase())
}

fn common_prefix_ci<'a>(names: impl Iterator<Item = &'a str>) -> String {
    let mut names = names;
    let Some(first) = names.next() else {
        return String::new();
    };
    let mut chars: Vec<char> = first.chars().collect();
    for name in names {
        let other: Vec<char> = name.chars().collect();
        let n = chars.len().min(other.len());
        let mut i = 0;
        while i < n && chars_eq_ci(chars[i], other[i]) {
            i += 1;
        }
        chars.truncate(i);
        if chars.is_empty() {
            break;
        }
    }
    chars.into_iter().collect()
}

fn chars_eq_ci(a: char, b: char) -> bool {
    a == b || a.to_lowercase().eq(b.to_lowercase())
}

/// 前端错误黑匣子：webview 的 JS 错误写入 dev 日志
#[tauri::command]
async fn log_debug(msg: String) {
    eprintln!("[webview] {msg}");
}

/// 拖拽/交互 trace 落盘：诊断原生拖拽链路（低频事件专用）
#[tauri::command]
async fn append_trace_log(msg: String, app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let ms = now.as_millis();
    let secs = (ms / 1000) as i64;
    let ms_part = ms % 1000;
    // 简易本地时间格式化（秒级转 ISO 由前端传入，这里记录相对毫秒足够定位时序）
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("trace.log")) {
        let _ = writeln!(f, "[{}.{:03}] {}", secs, ms_part, msg);
    }
    Ok(())
}

/// 前端错误持久化：写入应用数据目录 error.log（安装版无 stderr 也能诊断）
#[tauri::command]
async fn append_error_log(msg: String, app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("error.log")) {
        let _ = writeln!(f, "[{}] {}", ts, msg);
    }
    Ok(())
}

#[derive(Serialize, Clone)]
struct DirActivity {
    path: String,
    mtime_ms: f64,
}

/// 递归计算目录「活动时间」：自身与全部子孙条目的最新修改时间。
/// 限时预算（默认 400ms/目录）+ 条目上限，防止巨型目录卡住。
#[tauri::command]
async fn dir_activity(paths: Vec<String>, budget_ms: Option<u64>) -> Result<Vec<DirActivity>, String> {
    let budget = std::time::Duration::from_millis(budget_ms.unwrap_or(400));
    tauri::async_runtime::spawn_blocking(move || {
        let start = std::time::Instant::now();
        let mut out = Vec::new();
        for p in &paths {
            let root = Path::new(p);
            let mut max = fs::metadata(root)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0);
            let mut stack = vec![root.to_path_buf()];
            let mut visited = 0usize;
            while let Some(dir) = stack.pop() {
                if start.elapsed() > budget || visited > 20000 {
                    break;
                }
                if let Ok(rd) = fs::read_dir(&dir) {
                    for e in rd.filter_map(|e| e.ok()) {
                        visited += 1;
                        if visited > 20000 {
                            break;
                        }
                        if let Ok(md) = e.metadata() {
                            if let Ok(t) = md.modified() {
                                if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) {
                                    let ms = d.as_millis() as f64;
                                    if ms > max {
                                        max = ms;
                                    }
                                }
                            }
                            // 不跟随符号链接，防循环
                            if md.is_dir() {
                                stack.push(e.path());
                            }
                        }
                    }
                }
            }
            out.push(DirActivity {
                path: p.clone(),
                mtime_ms: max,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn search_content(
    query: String,
    root: Option<String>,
    limit: Option<usize>,
    roots: Option<Vec<String>>,
) -> Result<Vec<SearchItem>, search_results::SearchError> {
    search(query, if root.is_some() { "pane" } else { "global" }.into(), root,
        false, limit, roots, Some("content".into())).await
}

/// 内容搜索的字面模式：与 search_content 传给 fsearch 的 pattern 完全一致
/// （含 ':' 的词是过滤器，其余词用空格连接，去掉双引号）
fn content_pattern(q: &str) -> String {
    q.split_whitespace()
        .filter(|w| !w.contains(':'))
        .collect::<Vec<_>>()
        .join(" ")
        .replace('"', "")
}

/// 与 fsearch Grep 一致的逐行匹配：整串字面量；pattern 不含大写字母时忽略大小写（smart case）
struct LineMatcher {
    needle: String,
    fold: bool,
}

impl LineMatcher {
    fn new(q: &str) -> Option<Self> {
        let pat = content_pattern(q);
        if pat.is_empty() {
            return None;
        }
        let fold = !pat.chars().any(|c| c.is_uppercase());
        let needle = if fold { pat.to_lowercase() } else { pat };
        Some(Self { needle, fold })
    }
    fn is_match(&self, line: &str) -> bool {
        if self.fold {
            line.to_lowercase().contains(&self.needle)
        } else {
            line.contains(&self.needle)
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextPreview {
    kind: String, // "text" | "binary" | "image" | "too-large"
    text: String,
    truncated: bool,
    /// 预览区内（前 3000 行）的命中行号
    match_lines: Vec<f64>,
    /// 命中位于预览区之外（被截断/超过 3000 行的部分）的行数
    hidden_hits: usize,
}

impl TextPreview {
    fn empty(kind: &str) -> Self {
        Self {
            kind: kind.into(),
            text: String::new(),
            truncated: false,
            match_lines: Vec::new(),
            hidden_hits: 0,
        }
    }
}

fn is_image_path(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp") | Some("bmp")
    )
}

const PREVIEW_MAX_LINES: usize = 3000;
const PREVIEW_MATCH_CAP: usize = 200;
/// 统计「预览区之外命中数」时最多继续扫描的字节数
const PREVIEW_TAIL_SCAN: u64 = 16 << 20;

/// 读取文本文件内容供搜索预览：前 256KB / 3000 行 + 命中行号；
/// 预览区之外的命中只计数（hidden_hits），供前端提示。
#[tauri::command]
async fn read_text_preview(
    path: String,
    query: String,
    max_bytes: Option<usize>,
) -> Result<TextPreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview_file(&path, &query, max_bytes))
        .await
        .map_err(|e| e.to_string())?
}

fn preview_file(path: &str, query: &str, max_bytes: Option<usize>) -> Result<TextPreview, String> {
    {
        use std::io::{BufRead, Read};
        let p = Path::new(&path);
        let preview_metadata = fs::symlink_metadata(p).map_err(|e| format!("无法读取: {e}"))?;
        if !preview_metadata.is_file() { return Err("仅支持预览普通文件".into()); }
        if is_image_path(p) {
            return Ok(TextPreview::empty("image"));
        }
        let cap = max_bytes.unwrap_or(262_144);
        let md = fs::metadata(p).map_err(|e| format!("无法读取: {}", e))?;
        let truncated = md.len() > cap as u64;
        let mut file = fs::File::open(p).map_err(|e| e.to_string())?;
        let mut buf = Vec::with_capacity(md.len().min(cap as u64) as usize);
        (&mut file).take(cap as u64).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        // 二进制检测：前 8KB 含 NUL
        if buf[..buf.len().min(8192)].contains(&0u8) {
            return Ok(TextPreview::empty("binary"));
        }
        // 截断到行边界，避免切出半行；tail 从该边界继续扫描
        let end = if truncated {
            buf.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(buf.len())
        } else {
            buf.len()
        };
        let full = String::from_utf8_lossy(&buf[..end]);
        let matcher = LineMatcher::new(&query);
        let mut match_lines = Vec::new();
        let mut hidden_hits = 0usize;
        let mut shown: Vec<String> = Vec::new();
        for (i, line) in full.lines().enumerate() {
            let hit = matcher.as_ref().is_some_and(|m| m.is_match(line));
            if i < PREVIEW_MAX_LINES {
                if hit && match_lines.len() < PREVIEW_MATCH_CAP {
                    match_lines.push((i + 1) as f64);
                }
                // 单行超长（压缩 JS 等）会拖垮前端渲染，逐行截断
                if line.chars().count() > 300 {
                    let t: String = line.chars().take(300).collect();
                    shown.push(format!("{} …", t));
                } else {
                    shown.push(line.to_string());
                }
            } else if hit {
                hidden_hits += 1;
            }
        }
        // 截断掉的文件尾部：只数命中，不进预览
        if truncated {
            if let Some(m) = &matcher {
                let mut rest = Vec::new();
                let tail_start = end as u64;
                let mut f = fs::File::open(p).map_err(|e| e.to_string())?;
                use std::io::Seek;
                f.seek(std::io::SeekFrom::Start(tail_start)).map_err(|e| e.to_string())?;
                let mut rd = std::io::BufReader::new(f.take(PREVIEW_TAIL_SCAN));
                loop {
                    rest.clear();
                    match rd.read_until(b'\n', &mut rest) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if m.is_match(&String::from_utf8_lossy(&rest)) {
                                hidden_hits += 1;
                            }
                        }
                    }
                }
            }
        }
        eprintln!(
            "[preview] {} size={} truncated={} shown_hits={} hidden_hits={}",
            path,
            md.len(),
            truncated,
            match_lines.len(),
            hidden_hits
        );
        Ok(TextPreview {
            kind: "text".into(),
            text: shown.join("\n"),
            truncated,
            match_lines,
            hidden_hits,
        })
    }
}

#[cfg(test)]
mod preview_tests {
    use super::*;

    fn write_tmp(name: &str, lines: &[String]) -> String {
        let p = std::env::temp_dir().join(format!("bento-preview-{}-{}", std::process::id(), name));
        fs::write(&p, lines.join("\n")).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn filler(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("filler line {i} lorem ipsum dolor sit amet consectetur")).collect()
    }

    #[test]
    fn hits_before_and_after_truncation_are_split() {
        let mut l = filler(9000); // ≈ 500KB > 256KB
        l[4] = "early NEEDLE hit".into();
        l[8800] = "late needle hit".into();
        let p = write_tmp("both", &l);
        let r = preview_file(&p, "needle", None).unwrap();
        let _ = fs::remove_file(&p);
        assert!(r.truncated);
        assert_eq!(r.match_lines, vec![5.0]);
        assert_eq!(r.hidden_hits, 1);
    }

    #[test]
    fn hits_only_beyond_truncation_are_counted_not_lost() {
        let mut l = filler(9000);
        l[8700] = "late needle one".into();
        l[8750] = "late needle two".into();
        let p = write_tmp("late", &l);
        let r = preview_file(&p, "needle", None).unwrap();
        let _ = fs::remove_file(&p);
        assert!(r.truncated);
        assert!(r.match_lines.is_empty());
        assert_eq!(r.hidden_hits, 2);
    }

    #[test]
    fn multiword_query_is_whole_literal_like_the_engine() {
        let l = vec!["alpha beta".to_string(), "beta alpha".to_string(), "alpha only".to_string()];
        let p = write_tmp("multi", &l);
        let r = preview_file(&p, "alpha beta ext:txt", None).unwrap();
        let _ = fs::remove_file(&p);
        assert_eq!(r.match_lines, vec![1.0]);
    }

    #[test]
    fn smart_case_matches_fsearch() {
        let l = vec!["Foo".to_string(), "foo".to_string()];
        let p = write_tmp("case", &l);
        let lower = preview_file(&p, "foo", None).unwrap();
        let upper = preview_file(&p, "Foo", None).unwrap();
        let _ = fs::remove_file(&p);
        assert_eq!(lower.match_lines, vec![1.0, 2.0]);
        assert_eq!(upper.match_lines, vec![1.0]);
    }

    #[test]
    fn serializes_camel_case_for_the_frontend() {
        let json = serde_json::to_value(TextPreview::empty("text")).unwrap();
        assert!(json.get("matchLines").is_some() && json.get("hiddenHits").is_some());
        assert!(json.get("match_lines").is_none());
    }
}

#[cfg(test)]
mod copy_name_tests {
    use super::*;

    #[test]
    fn copies_get_copy_suffix_then_numbered() {
        let d = std::env::temp_dir().join(format!("bento-copyname-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let mk = |n: &str| fs::write(d.join(n), "x").unwrap();
        let name = |p: PathBuf| p.file_name().unwrap().to_string_lossy().into_owned();
        mk("a.txt");
        assert_eq!(name(copy_name_path(&d, "b.txt")), "b.txt"); // 不重名原样
        assert_eq!(name(copy_name_path(&d, "a.txt")), "a copy.txt");
        mk("a copy.txt");
        assert_eq!(name(copy_name_path(&d, "a.txt")), "a copy 1.txt");
        mk("a copy 1.txt");
        assert_eq!(name(copy_name_path(&d, "a.txt")), "a copy 2.txt");
        // 拷贝一个已是 copy 的文件：不叠加「copy copy」
        assert_eq!(name(copy_name_path(&d, "a copy.txt")), "a copy 2.txt");
        // 旧版中文「副本」后缀同样被识别，改用英文编号
        mk("old 副本.txt");
        mk("old.txt");
        assert_eq!(name(copy_name_path(&d, "old 副本.txt")), "old copy.txt");
        // 名字里恰好含 copy 单词但不是后缀：原样保留
        mk("copyright notes.txt");
        assert_eq!(name(copy_name_path(&d, "copyright notes.txt")), "copyright notes copy.txt");
        // 无扩展名 / 文件夹
        fs::create_dir_all(d.join("dir")).unwrap();
        assert_eq!(name(copy_name_path(&d, "dir")), "dir copy");
        let _ = fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod move_items_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn scratch(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "bento-move-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src/dir/nested")).unwrap();
        fs::create_dir_all(root.join("dst")).unwrap();
        fs::write(root.join("src/note.txt"), "hello").unwrap();
        fs::write(root.join("src/dir/nested/f.txt"), "nested").unwrap();
        root
    }

    fn no_progress(_: usize, _: usize) {}

    #[test]
    fn exdev_is_cross_device_only() {
        assert!(is_exdev(&io::Error::from_raw_os_error(libc::EXDEV)));
        assert!(is_exdev(&io::Error::new(
            io::ErrorKind::CrossesDevices,
            "cross"
        )));
        assert!(!is_exdev(&io::Error::new(
            io::ErrorKind::PermissionDenied,
            "busy"
        )));
    }

    #[test]
    fn same_volume_renames_file_and_directory() {
        let root = scratch("rename");
        let sources = vec![
            root.join("src/note.txt").to_string_lossy().into_owned(),
            root.join("src/dir").to_string_lossy().into_owned(),
        ];
        let items = move_into(&sources, root.join("dst").to_str().unwrap(), no_progress).unwrap();
        assert!(items.iter().all(|item| item.ok), "{items:?}");
        assert!(!root.join("src/note.txt").exists());
        assert!(!root.join("src/dir").exists());
        assert_eq!(fs::read(root.join("dst/note.txt")).unwrap(), b"hello");
        assert_eq!(
            fs::read(root.join("dst/dir/nested/f.txt")).unwrap(),
            b"nested"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn name_collision_keeps_both() {
        let root = scratch("collision");
        fs::write(root.join("dst/note.txt"), "old").unwrap();
        let sources = vec![root.join("src/note.txt").to_string_lossy().into_owned()];
        let items = move_into(&sources, root.join("dst").to_str().unwrap(), no_progress).unwrap();
        assert!(items[0].ok, "{items:?}");
        assert!(
            items[0].dest.ends_with("note copy.txt"),
            "{}",
            items[0].dest
        );
        assert_eq!(fs::read(root.join("dst/note.txt")).unwrap(), b"old");
        assert_eq!(fs::read(root.join("dst/note copy.txt")).unwrap(), b"hello");
        assert!(!root.join("src/note.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_to_move_folder_into_itself() {
        let root = scratch("into-self");
        let src = root.join("src/dir");
        let nested = src.join("nested");
        let sources = vec![src.to_string_lossy().into_owned()];
        let items = move_into(&sources, nested.to_str().unwrap(), no_progress).unwrap();
        assert!(!items[0].ok);
        assert!(items[0].error.as_deref().unwrap().contains("自身"));
        assert_eq!(fs::read(src.join("nested/f.txt")).unwrap(), b"nested");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_source_and_bad_dest_do_not_touch_files() {
        let root = scratch("missing");
        let sources = vec![root.join("src/nope.txt").to_string_lossy().into_owned()];
        let items = move_into(&sources, root.join("dst").to_str().unwrap(), no_progress).unwrap();
        assert_eq!(items[0].error.as_deref(), Some("源不存在"));

        let file = root.join("src/note.txt");
        let err = move_into(
            &[file.to_string_lossy().into_owned()],
            file.to_str().unwrap(),
            no_progress,
        )
        .unwrap_err();
        assert!(err.contains("目标不是文件夹"), "{err}");
        assert_eq!(fs::read(&file).unwrap(), b"hello");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn non_exdev_rename_failure_leaves_source() {
        let root = scratch("no-exdev");
        let src = root.join("src/note.txt");
        let dst = root.join("dst/note.txt");
        let err = relocate_with(&src, &dst, |_, _| {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "busy"))
        })
        .unwrap_err();
        assert!(err.to_string().contains("移动失败"));
        assert!(!err.to_string().contains("保持原样"));
        assert_eq!(fs::read(&src).unwrap(), b"hello");
        assert!(!dst.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn exdev_copies_then_deletes_source() {
        let root = scratch("exdev");
        let src = root.join("src/dir");
        let dst = root.join("dst/dir");
        relocate_with(&src, &dst, |_, _| {
            Err(io::Error::from_raw_os_error(libc::EXDEV))
        })
        .unwrap();
        assert!(!src.exists());
        assert_eq!(fs::read(dst.join("nested/f.txt")).unwrap(), b"nested");
        let leftovers: Vec<_> = fs::read_dir(root.join("dst"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".bento-move-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn exdev_copy_failure_keeps_source_and_drops_partial_dest() {
        let root = scratch("exdev-fail");
        let src = root.join("src/note.txt");
        let dst = root.join("dst/note.txt");
        fs::write(root.join("dst/keep.txt"), "keep").unwrap();
        let mut removed_source = false;
        let err = copy_then_remove_with(
            &src,
            &dst,
            |_, tmp| {
                fs::write(tmp, b"partial").unwrap();
                Err(io::Error::other("disk full"))
            },
            |_| {
                removed_source = true;
                Ok(())
            },
        )
        .unwrap_err();
        assert!(!removed_source);
        assert!(err.to_string().contains("源文件保持原样"), "{err}");
        assert_eq!(fs::read(&src).unwrap(), b"hello");
        assert!(!dst.exists());
        assert_eq!(fs::read(root.join("dst/keep.txt")).unwrap(), b"keep");
        let leftovers: Vec<_> = fs::read_dir(root.join("dst"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".bento-move-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn exdev_delete_failure_keeps_source_and_reports() {
        let root = scratch("exdev-delete");
        let src = root.join("src/note.txt");
        let dst = root.join("dst/note.txt");
        let err = copy_then_remove_with(&src, &dst, copy_for_move, |_| {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "busy"))
        })
        .unwrap_err();
        assert!(err.to_string().contains("无法删除源"), "{err}");
        let outcome = failed_transfer(src.to_str().unwrap(), err);
        assert!(!outcome.ok);
        let serialized = serde_json::to_value(&outcome).unwrap();
        assert_eq!(serialized["dest"], dst.to_str().unwrap());
        assert_eq!(serialized["affectedDirectories"], serde_json::json!([
            src.parent().unwrap().to_str().unwrap(), dst.parent().unwrap().to_str().unwrap()
        ]));
        assert_eq!(fs::read(&src).unwrap(), b"hello");
        assert_eq!(fs::read(&dst).unwrap(), b"hello");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn published_failure_is_structured_and_never_retried_as_a_name_collision() {
        let root = scratch("published-outcome");
        let src = root.join("src/note.txt");
        let dest_dir = root.join("dst");
        let mut attempts = 0;
        let outcome = transfer_one_item_with(src.to_str().unwrap(), &dest_dir, "move", |s, d, _| {
            attempts += 1;
            copy_then_remove_with(s, d, copy_for_move, |_| {
                Err(io::Error::new(io::ErrorKind::AlreadyExists, "injected removal failure"))
            })
        });
        assert_eq!(attempts, 1, "a published copy must never be repeated under another name");
        assert!(!outcome.ok);
        assert_eq!(outcome.dest, dest_dir.join("note.txt").to_str().unwrap());
        let serialized = serde_json::to_value(&outcome).unwrap();
        assert_eq!(serialized["affectedDirectories"], serde_json::json!([
            src.parent().unwrap().to_str().unwrap(), dest_dir.to_str().unwrap()
        ]));
        assert_eq!(fs::read(&src).unwrap(), b"hello");
        assert_eq!(fs::read(&outcome.dest).unwrap(), b"hello");
        assert_eq!(fs::read_dir(&dest_dir).unwrap().count(), 1);
        let untouched = transfer_one_item(root.join("missing").to_str().unwrap(), &dest_dir, "move");
        assert!(!untouched.ok);
        assert!(serde_json::to_value(untouched).unwrap().get("affectedDirectories").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn exdev_moves_symlink_without_following_it() {
        let root = scratch("symlink");
        let link = root.join("src/link");
        symlink("missing-target", &link).unwrap();
        let dst = root.join("dst/link");
        relocate_with(&link, &dst, |_, _| {
            Err(io::Error::from_raw_os_error(libc::EXDEV))
        })
        .unwrap();
        assert!(
            fs::symlink_metadata(&link).is_err(),
            "source symlink must be removed"
        );
        assert_eq!(
            fs::read_link(&dst).unwrap(),
            PathBuf::from("missing-target")
        );
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod file_safety_tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "bento-safety-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir_all(path.join("src")).unwrap();
            fs::create_dir_all(path.join("dst")).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) { cleanup_staging(&self.0); }
    }

    #[test]
    fn basic_write_receipts_identify_actual_names_and_rename_unwinds_before_create() {
        let root = Scratch::new();
        let dir = root.0.join("src");
        let first = tauri::async_runtime::block_on(make_dir_with_receipt(dir.to_string_lossy().into_owned())).unwrap();
        let folder = tauri::async_runtime::block_on(make_dir_with_receipt(dir.to_string_lossy().into_owned())).unwrap();
        assert_ne!(first.path, folder.path);
        assert!(folder.path.ends_with("未命名文件夹 2"));
        let file = tauri::async_runtime::block_on(create_file_with_receipt(folder.path.clone(), "text".into())).unwrap();
        let renamed = tauri::async_runtime::block_on(rename_with_receipt(file.path.clone(), "final.txt".into())).unwrap();
        assert_eq!(file.identity, renamed.identity);
        assert_eq!(file.identity, Some(file_identity(Path::new(&renamed.path)).unwrap()));
        let restored = restore_into(&[RestoreMove { source: renamed.path, dest: file.path.clone(), identity: file.identity }]);
        assert!(restored[0].ok);
        assert!(Path::new(&file.path).exists());
    }

    #[test]
    fn template_receipt_and_partial_zip_preserve_completed_identity() {
        let root = Scratch::new();
        let dir = root.0.join("src");
        let template = dir.join("fixture.md");
        fs::write(&template, "fixture").unwrap();
        let copied = copy_template_file(&dir, &root.0.join("dst"), &template).unwrap();
        let receipt = completion_receipt(copied);
        assert_eq!(receipt.identity, Some(file_identity(Path::new(&receipt.path)).unwrap()));
        let result = zip_paths_into(vec![template.to_string_lossy().into_owned(), dir.join("missing").to_string_lossy().into_owned()], root.0.join("dst"), ZipOptions { separate: Some(true), ..Default::default() }).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert!(result.error.is_some());
        let archive = &result.entries[0];
        assert!(archive.path.ends_with("fixture.md.zip"));
        assert_eq!(archive.identity, Some(file_identity(Path::new(&archive.path)).unwrap()));
    }

    #[test]
    fn unavailable_identity_does_not_turn_a_completion_into_a_failure() {
        let root = Scratch::new();
        let completed_path = root.0.join("gone");
        let receipt = completion_receipt(completed_path.clone());
        assert_eq!(receipt.path, completed_path.to_string_lossy());
        assert_eq!(receipt.identity, None);
    }

    #[test]
    fn restore_identity_guard_rejects_a_replaced_source() {
        let root = Scratch::new();
        let source = root.0.join("src/note.txt");
        let dest = root.0.join("dst/note.txt");
        fs::write(&source, "replacement").unwrap();
        let request: RestoreMove = serde_json::from_value(serde_json::json!({
            "source": source, "dest": dest,
            "identity": {"dev": "0", "ino": "0"}
        })).unwrap();
        let result = restore_into(&[request]);
        assert!(!result[0].ok, "a replacement must never be moved by Undo");
        assert_eq!(fs::read(&source).unwrap(), b"replacement");
        assert!(!dest.exists());
    }

    #[test]
    fn exact_restore_recovers_original_name_and_rejects_conflicts_per_item() {
        let root = Scratch::new();
        let source = root.0.join("src/note.txt");
        fs::write(&source, "incoming").unwrap();
        fs::write(root.0.join("dst/note.txt"), "existing").unwrap();
        let forward = move_into(
            &[source.to_string_lossy().into_owned()],
            root.0.join("dst").to_str().unwrap(),
            |_, _| {},
        )
        .unwrap();
        let moves = vec![RestoreMove {
            source: forward[0].dest.clone(),
            dest: source.to_string_lossy().into_owned(),
            identity: None,
        }];
        fs::write(&source, "conflict").unwrap();
        let blocked = restore_into(&moves);
        assert_eq!(blocked.len(), 1);
        assert!(!blocked[0].ok);
        assert_eq!(fs::read(&source).unwrap(), b"conflict");
        fs::remove_file(&source).unwrap();
        let restored = restore_into(&moves);
        assert!(restored[0].ok, "{restored:?}");
        assert_eq!(restored[0].dest, source.to_string_lossy());
        assert_eq!(fs::read(&source).unwrap(), b"incoming");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn cross_volume_keeps_xattrs_acl_and_modified_time() {
        let root = Scratch::new();
        let src = root.0.join("src/private");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("file"), "secret").unwrap();
        fs::set_permissions(&src, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(std::process::Command::new("chmod")
            .args(["+a", "everyone allow readattr,readextattr,readsecurity"])
            .arg(&src)
            .status()
            .unwrap()
            .success());
        assert!(std::process::Command::new("xattr")
            .args(["-w", "com.bento.fixture", "secret"])
            .arg(&src)
            .status()
            .unwrap()
            .success());
        let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        fs::File::open(&src)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let dst = root.0.join("dst/private");
        copy_then_remove(&src, &dst).unwrap();
        assert!(!src.exists());
        assert_eq!(fs::metadata(&dst).unwrap().modified().unwrap(), modified);
        let value = std::process::Command::new("xattr")
            .args(["-p", "com.bento.fixture"])
            .arg(&dst)
            .output()
            .unwrap();
        assert!(value.status.success());
        assert_eq!(String::from_utf8_lossy(&value.stdout).trim(), "secret");
        let acl = std::process::Command::new("ls")
            .arg("-lde")
            .arg(&dst)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&acl.stdout)
            .contains("everyone allow readattr,readextattr,readsecurity"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn staging_does_not_inherit_destination_read_acl() {
        let root = Scratch::new();
        let dst_dir = root.0.join("dst");
        assert!(std::process::Command::new("chmod").args(["+a", "everyone allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit"]).arg(&dst_dir).status().unwrap().success());
        let src = root.0.join("src/file");
        fs::write(&src, "secret").unwrap();
        copy_then_remove_with(
            &src,
            &dst_dir.join("file"),
            |s, tmp| {
                let acl = std::process::Command::new("ls")
                    .arg("-lde")
                    .arg(tmp.parent().unwrap())
                    .output()?;
                let acl = String::from_utf8_lossy(&acl.stdout);
                assert!(
                    !acl.contains("everyone"),
                    "staging must not grant inherited read access: {acl}"
                );
                copy_for_move(s, tmp)
            },
            remove_path,
        )
        .unwrap();
    }

    #[test]
    fn private_staging_and_metadata_failure_keep_source() {
        use std::cell::Cell;
        let root = Scratch::new();
        let src = root.0.join("src/private");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("file"), "secret").unwrap();
        fs::set_permissions(&src, fs::Permissions::from_mode(0o700)).unwrap();
        let saw_child = Cell::new(false);
        let dst = root.0.join("dst/private");
        let err = copy_then_remove_with(
            &src,
            &dst,
            |s, tmp| {
                assert_eq!(
                    fs::metadata(tmp.parent().unwrap())?.permissions().mode() & 0o777,
                    0o700
                );
                copy_for_move_with(s, tmp, &|s, d| {
                    if s.file_name().unwrap() == "file" {
                        saw_child.set(true);
                        assert_eq!(
                            fs::metadata(d.parent().unwrap())?.permissions().mode() & 0o777,
                            0o700
                        );
                    }
                    if s.is_dir() {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "metadata denied",
                        ));
                    }
                    preserve_move_metadata(s, d)
                })
            },
            |_| panic!("metadata failure must never delete the source"),
        )
        .unwrap_err();
        assert!(saw_child.get());
        assert!(err.to_string().contains("元数据"));
        assert_eq!(fs::read(src.join("file")).unwrap(), b"secret");
        assert!(!dst.exists());
        assert_eq!(fs::read_dir(root.0.join("dst")).unwrap().count(), 0);
    }

    #[test]
    fn concurrent_same_name_moves_preserve_every_content() {
        let root = Scratch::new();
        let mut workers = Vec::new();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        for i in 0..8 {
            let src = root.0.join(format!("src/{i}"));
            fs::create_dir(&src).unwrap();
            let src = src.join("note.txt");
            fs::write(&src, i.to_string()).unwrap();
            let dest = root.0.join("dst");
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                move_one_item(src.to_str().unwrap(), &dest)
            }));
        }
        let items: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert!(items.iter().all(|i| i.ok), "{items:?}");
        let mut contents: Vec<_> = items
            .iter()
            .map(|i| fs::read_to_string(&i.dest).unwrap())
            .collect();
        contents.sort();
        assert_eq!(contents, ["0", "1", "2", "3", "4", "5", "6", "7"]);
    }

    #[test]
    fn shared_transfer_copy_keeps_dangling_dest_and_copies_source_link() {
        let root = Scratch::new();
        let src = root.0.join("src/link");
        symlink("source-target", &src).unwrap();
        let dst = root.0.join("dst/link");
        symlink("dest-target", &dst).unwrap();
        let result = transfer_one_item(src.to_str().unwrap(), &root.0.join("dst"), "copy");
        assert!(result.ok, "{result:?}");
        assert_eq!(fs::read_link(&dst).unwrap(), PathBuf::from("dest-target"));
        assert_eq!(
            fs::read_link(&result.dest).unwrap(),
            PathBuf::from("source-target")
        );
        assert!(fs::symlink_metadata(src).is_ok());
    }

    #[test]
    fn cross_volume_nested_directory_modes_survive() {
        let root = Scratch::new();
        let src = root.0.join("src/private");
        fs::create_dir_all(src.join("shared/readonly")).unwrap();
        fs::write(src.join("shared/readonly/file"), "private").unwrap();
        for (path, mode) in [
            (&src, 0o700),
            (&src.join("shared"), 0o750),
            (&src.join("shared/readonly"), 0o500),
        ] {
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        }
        // Exercise the actual EXDEV fallback without needing a second mounted disk.
        let dst = root.0.join("dst/private");
        copy_for_move(&src, &dst).unwrap();
        for (path, mode) in [
            (&dst, 0o700),
            (&dst.join("shared"), 0o750),
            (&dst.join("shared/readonly"), 0o500),
        ] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                mode
            );
        }
        fs::set_permissions(
            src.join("shared/readonly"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        fs::set_permissions(
            dst.join("shared/readonly"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
    }

    #[test]
    fn move_preserves_existing_dangling_symlink() {
        let root = Scratch::new();
        let src = root.0.join("src/note.txt");
        fs::write(&src, "incoming").unwrap();
        let dst = root.0.join("dst/note.txt");
        symlink("missing", &dst).unwrap();
        let result = move_into(
            &[src.to_string_lossy().into_owned()],
            root.0.join("dst").to_str().unwrap(),
            |_, _| {},
        )
        .unwrap();
        assert!(result[0].ok);
        assert_eq!(fs::read_link(&dst).unwrap(), PathBuf::from("missing"));
        assert_eq!(
            fs::read(root.0.join("dst/note copy.txt")).unwrap(),
            b"incoming"
        );
    }

    #[test]
    fn relocate_refuses_existing_destination_atomically() {
        let root = Scratch::new();
        let src = root.0.join("src/file");
        fs::write(&src, "incoming").unwrap();
        let dst = root.0.join("dst/file");
        fs::write(&dst, "existing").unwrap();
        assert_eq!(
            relocate(&src, &dst).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(&src).unwrap(), b"incoming");
        assert_eq!(fs::read(&dst).unwrap(), b"existing");
    }

    #[test]
    fn cross_volume_publish_refuses_a_racing_destination() {
        let root = Scratch::new();
        let src = root.0.join("src/file");
        fs::write(&src, "incoming").unwrap();
        let dst = root.0.join("dst/file");
        let result = copy_then_remove_with(
            &src,
            &dst,
            |s, tmp| {
                copy_for_move(s, tmp)?;
                fs::write(&dst, "racer")?;
                Ok(())
            },
            remove_path,
        );
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&src).unwrap(), b"incoming");
        assert_eq!(fs::read(&dst).unwrap(), b"racer");
    }
}

#[cfg(test)]
mod zip_tests {
    use super::*;

    fn unzip_list(zip: &str) -> String {
        let out = std::process::Command::new("unzip").args(["-Z1", zip]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn fixture(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("bento-ziptest-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src/folder")).unwrap();
        fs::write(root.join("src/a.txt"), "a").unwrap();
        fs::write(root.join("src/folder/inner.txt"), "i").unwrap();
        fs::write(root.join("src/b.txt"), "b").unwrap();
        fs::create_dir_all(root.join("out")).unwrap();
        root
    }

    fn run(root: &Path, names: &[&str], opts: Option<ZipOptions>) -> Result<Vec<String>, String> {
        let sources: Vec<String> = names
            .iter()
            .map(|n| root.join("src").join(n).to_string_lossy().into_owned())
            .collect();
        tauri::async_runtime::block_on(zip_paths(sources, root.join("out").to_string_lossy().into_owned(), opts))
    }

    /// 回归：多选压缩曾报 "ditto: Can't archive multiple sources"
    #[test]
    fn zips_multiple_sources_into_one_archive() {
        let root = fixture("multi");
        let zips = run(&root, &["a.txt", "folder", "b.txt"], None).expect("zip");
        let names = unzip_list(&zips[0]);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(zips.len(), 1);
        assert!(zips[0].ends_with("归档.zip"), "{}", zips[0]);
        for want in ["a.txt", "b.txt", "folder/inner.txt"] {
            assert!(names.lines().any(|l| l == want), "missing {want} in:\n{names}");
        }
    }

    #[test]
    fn single_source_keeps_parent_folder_name() {
        let root = fixture("single");
        let zips = run(&root, &["folder"], None).expect("zip");
        let names = unzip_list(&zips[0]);
        let _ = fs::remove_dir_all(&root);
        assert!(zips[0].ends_with("folder.zip"));
        assert!(names.lines().any(|l| l == "folder/inner.txt"), "{names}");
    }

    #[test]
    fn custom_name_is_used_and_zip_suffix_added() {
        let root = fixture("name");
        let opts = ZipOptions { name: Some("我的归档".into()), ..Default::default() };
        let zips = run(&root, &["a.txt", "b.txt"], Some(opts)).expect("zip");
        let _ = fs::remove_dir_all(&root);
        assert!(zips[0].ends_with("/我的归档.zip"), "{}", zips[0]);
    }

    #[test]
    fn separate_makes_one_zip_per_source() {
        let root = fixture("sep");
        let opts = ZipOptions { separate: Some(true), ..Default::default() };
        let zips = run(&root, &["a.txt", "folder"], Some(opts)).expect("zip");
        let _ = fs::remove_dir_all(&root);
        assert_eq!(zips.len(), 2);
        assert!(zips[0].ends_with("a.txt.zip") && zips[1].ends_with("folder.zip"), "{zips:?}");
    }

    #[test]
    fn password_protects_the_archive() {
        let root = fixture("pw");
        let opts = ZipOptions { password: Some("s3cret".into()), level: Some(9), ..Default::default() };
        let zips = run(&root, &["a.txt"], Some(opts)).expect("zip");
        let z = &zips[0];
        let bad = std::process::Command::new("unzip").args(["-t", "-P", "wrong", z]).output().unwrap();
        let good = std::process::Command::new("unzip").args(["-t", "-P", "s3cret", z]).output().unwrap();
        let _ = fs::remove_dir_all(&root);
        assert!(!bad.status.success(), "wrong password must fail");
        assert!(good.status.success(), "right password must pass");
    }

    #[test]
    fn sources_in_different_folders_are_zipped_together() {
        let root = fixture("mix");
        fs::write(root.join("out/other.txt"), "o").unwrap();
        let sources = vec![
            root.join("src/a.txt").to_string_lossy().into_owned(),
            root.join("out/other.txt").to_string_lossy().into_owned(),
        ];
        let zips = tauri::async_runtime::block_on(zip_paths(sources, root.join("out").to_string_lossy().into_owned(), None))
            .expect("zip");
        let names = unzip_list(&zips[0]);
        let _ = fs::remove_dir_all(&root);
        assert!(names.lines().any(|l| l == "a.txt") && names.lines().any(|l| l == "other.txt"), "{names}");
    }
}

/// 在主线程把文件 URL 写进系统剪贴板（NSURL → NSPasteboard.writeObjects，
/// 与 Finder ⌘C 同构：每个文件一个 pasteboard item，含 public.file-url 及系统自动补的兼容类型）
#[cfg(target_os = "macos")]
fn write_file_urls_to_pasteboard(paths: &[String]) -> Result<usize, String> {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};
    let urls: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = paths
        .iter()
        .map(|p| ProtocolObject::from_retained(NSURL::fileURLWithPath(&NSString::from_str(p))))
        .collect();
    let arr = NSArray::from_retained_slice(&urls);
    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    if !pb.writeObjects(&arr) {
        return Err("NSPasteboard.writeObjects 返回 false".into());
    }
    Ok(urls.len())
}

/// 把文件引用写进系统剪贴板（public.file-url，Finder/微信/邮件粘贴文件本体）
#[tauri::command]
async fn copy_files_to_clipboard(paths: Vec<String>, app: AppHandle) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    eprintln!("[clipboard] writing {} paths: {:?}", paths.len(), paths);
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(write_file_urls_to_pasteboard(&paths));
    })
    .map_err(|e| e.to_string())?;
    let r = tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())?;
    match &r {
        Ok(n) => eprintln!("[clipboard] NSPasteboard wrote {} file urls", n),
        Err(e) => eprintln!("[clipboard] failed: {}", e),
    }
    r.map(|_| ())
}

/// 打开系统的「完全磁盘访问权限」设置页
#[tauri::command]
async fn open_privacy_settings() -> Result<(), String> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 立即保存窗口大小/位置（前端在 resize/move 防抖后调用）。
/// 必须是同步命令（Tauri 会在主线程执行）：插件的 save_window_state 持有状态缓存锁的同时，
/// 要通过 outer_position 等 getter 同步等待主线程；若在 tokio 线程执行，而主线程恰好在窗口
/// Moved/Resized 事件里等同一把锁，就互相死锁（启动恢复窗口位置时实测卡死 60s+，见 PITFALLS）。
#[tauri::command]
fn save_window_state(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
    app.save_window_state(StateFlags::all())
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct FsearchStatus {
    ready: bool,
    entries: usize,
    full_disk_access: bool,
}

/// fsearch 引擎状态（全局索引是否建好）
#[tauri::command]
async fn fsearch_status() -> Result<FsearchStatus, String> {
    match fsearch_engine() {
        Some(eng) => {
            let st = eng.status();
            Ok(FsearchStatus {
                ready: st.ready,
                entries: st.entries,
                full_disk_access: st.full_disk_access,
            })
        }
        None => Err("fsearch 不可用".into()),
    }
}

#[tauri::command]
async fn load_config(app: AppHandle) -> Result<serde_json::Value, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = dir.join("config.json");
    match fs::read_to_string(&file) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(_) => Ok(serde_json::Value::Null),
    }
}

#[tauri::command]
async fn save_config(app: AppHandle, config: serde_json::Value) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(
        dir.join("config.json"),
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// 视图设置：`{ version, defaults, overrides }`。与工作区配置分开，键是规范化路径。
/// 文件不存在时返回 null，由前端回落到默认，不把缺文件当成错误。
#[tauri::command]
async fn load_view_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = dir.join("view-settings.json");
    match fs::read_to_string(&file) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(_) => Ok(serde_json::Value::Null),
    }
}

#[tauri::command]
async fn save_view_settings(app: AppHandle, view_settings: serde_json::Value) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(
        dir.join("view-settings.json"),
        serde_json::to_string_pretty(&view_settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// 可见窗格的当前目录（含展开的子目录）。不再可见的路径会 unwatch。
#[tauri::command]
fn set_watched(paths: Vec<String>, state: tauri::State<'_, FsWatcher>) -> Result<(), String> {
    state.set_paths(paths);
    Ok(())
}

/// 后台窗口也能直接拖出文件：Bento 被其他软件遮住时，点按/拖动 Bento 的可见部分不应把整个窗口
/// 抬到最前（否则会盖住拖拽目标）。AppKit 约定：NSView 的 shouldDelayWindowOrderingForEvent:
/// 返回 YES → mouseDown 时延迟窗口排序，拖拽会话期间窗口保持原层级，仅单击（mouseUp）才激活。
/// wry 没有暴露这个钩子，所以在其 WKWebView 子类上补一个方法（配合 acceptFirstMouse）。
#[cfg(target_os = "macos")]
fn enable_background_drag(app: &tauri::App) {
    use objc2::runtime::{AnyObject, Bool, Sel};
    use objc2::sel;
    unsafe extern "C" fn delay_ordering(_this: *mut AnyObject, _cmd: Sel, _event: *mut AnyObject) -> Bool {
        Bool::YES
    }
    let Some(w) = app.get_webview_window("main") else {
        eprintln!("[bg-drag] main webview window not found");
        return;
    };
    let r = w.with_webview(|wv| unsafe {
        let obj = &*(wv.inner() as *const AnyObject);
        let mut cls = obj.class();
        // 实例可能已被 KVO 换成 NSKVONotifying_* 子类；方法要加在真正的 WryWebView 上才持久
        if cls.name().to_bytes().starts_with(b"NSKVONotifying_") {
            if let Some(sup) = cls.superclass() {
                cls = sup;
            }
        }
        let imp = std::mem::transmute::<
            unsafe extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool,
            objc2::runtime::Imp,
        >(delay_ordering);
        let ok = objc2::ffi::class_addMethod(
            cls as *const _ as *mut _,
            sel!(shouldDelayWindowOrderingForEvent:),
            imp,
            c"B@:@".as_ptr(),
        );
        eprintln!("[bg-drag] class={} addMethod ok={}", cls.name().to_string_lossy(), ok.as_bool());
    });
    if let Err(e) = r {
        eprintln!("[bg-drag] with_webview failed: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(std::sync::Arc::new(session_store::SessionStore::default()))
        .manage(session_exit::ExitState::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            session_exit::install_native_quit(app)?;
            #[cfg(target_os = "macos")]
            enable_background_drag(app);
            let app_handle = app.handle().clone();
            app.manage(
                FsWatcher::new(move |changes| {
                    let _ = app_handle.emit("fs-changed", &changes);
                })
                .expect("fs watcher"),
            );
            // 自定义菜单：不带任何会与前端冲突的标准快捷键
            // （默认菜单的 ⌘W 关窗 / ⌘R 刷新 / ⌘C 拷贝 会抢先拦截按键事件）
            // 「关于」面板全英文：内容在此显式给出，面板自带标签（Version 等）的语言由 src-tauri/Info.plist 的
            // CFBundleLocalizations=en 决定（否则会跟随系统语言变成中文）
            let about_meta = AboutMetadataBuilder::new()
                .name(Some("Bento"))
                .version(Some(env!("CARGO_PKG_VERSION")))
                .copyright(Some("Copyright © 2026 banduoba. Released under the MIT License."))
                .comments(Some("A lightweight multi-pane file manager for macOS."))
                .website(Some("https://github.com/banduoba/bento"))
                .build();
            let about = PredefinedMenuItem::about(app, Some("About Bento"), Some(about_meta))?;
            let quit = PredefinedMenuItem::quit(app, None)?;
            let app_menu = SubmenuBuilder::new(app, "Bento")
                .item(&about)
                .separator()
                .item(&quit)
                .build()?;

            let close_item = MenuItemBuilder::with_id("close-win", "Close Window").build(app)?;
            let file_menu = SubmenuBuilder::new(app, "File").item(&close_item).build()?;

            // The custom Undo accelerator has one frontend route for files and text.
            // Keep clipboard accelerators in the webview's existing handlers.
            let undo = MenuItemBuilder::with_id("edit-undo", "Undo").accelerator("CmdOrCtrl+Z").build(app)?;
            let edit_menu = SubmenuBuilder::new(app, "Edit").item(&undo).build()?;

            let minimize = PredefinedMenuItem::minimize(app, None)?;
            let maximize = PredefinedMenuItem::maximize(app, None)?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .item(&minimize)
                .item(&maximize)
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
                .build()?;
            app.set_menu(menu)?;

            // 启动即预热 fsearch 引擎（后台加载/构建索引），避免首次搜索时慢
            {
                let app = app.handle().clone();
                std::thread::spawn(move || {
                    let _ = &app;
                    if let Some(e) = fsearch_engine() {
                        let st = e.status();
                        eprintln!("[fsearch] ready={} entries={}", st.ready, st.entries);
                    }
                });
            }
            // 模板目录：用户把 .docx 等文件放进来后，「新建」子菜单会列出它们
            if let Ok(app_dir) = app.handle().path().app_data_dir() {
                if let Err(err) = ensure_templates_dir(&app_dir) {
                    eprintln!("[templates] {err}");
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().0 == "edit-undo" {
                if let Some(w) = app.get_webview_window("main") { let _ = w.emit("bento-edit-undo", ()); }
            }
            if event.id().0 == "close-win" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            list_stream::list_dir_stream,
            list_stream::cancel_list_dir,
            transfer,
            move_items,
            restore_moves,
            trash,
            make_dir,
            make_dir_with_receipt,
            rename,
            rename_with_receipt,
            regex_rename_preview,
            open_path,
            reveal_in_finder,
            open_terminal,
            zip_paths,
            zip_paths_with_receipt,
            quick_look,
            update_quick_look,
            make_file,
            create_file,
            create_file_with_receipt,
            list_templates,
            copy_template,
            copy_template_with_receipt,
            search,
            search_results::search_query,
            search_results::cancel_search,
            search_content,
            read_text_preview,
            dir_activity,
            copy_files_to_clipboard,
            set_watched,
            open_privacy_settings,
            disk_space,
            home_dir,
            resolve_path,
            complete_path,
            log_debug,
            append_trace_log,
            append_error_log,
            save_window_state,
            fsearch_status,
            session_store::load_session,
            session_store::save_session,
            session_exit::session_exit_reply,
            load_config,
            save_config,
            load_view_settings,
            save_view_settings,
            file_icons
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                session_exit::on_exit_requested(app, code, api);
            }
        });
}

#[cfg(test)]
mod resolve_path_tests {
    use super::{expand_user_path, resolve_existing_dir};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch() -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("bento-resolve-{n}"));
        fs::create_dir_all(p.join("sub")).unwrap();
        fs::write(p.join("file.txt"), b"hi").unwrap();
        p
    }

    #[test]
    fn tilde_and_absolute_rules() {
        let home = std::env::var("HOME").unwrap();
        let home = home.trim_end_matches('/');
        assert_eq!(expand_user_path("~").unwrap(), PathBuf::from(home));
        assert_eq!(
            expand_user_path("~/Documents").unwrap(),
            PathBuf::from(format!("{home}/Documents"))
        );
        assert_eq!(expand_user_path("~/").unwrap(), PathBuf::from(format!("{home}/")));
        assert!(expand_user_path("~bob").unwrap_err().contains("仅支持"));
        assert!(expand_user_path("Documents").unwrap_err().contains("绝对路径"));
        assert!(expand_user_path("   ").unwrap_err().contains("请输入路径"));
    }

    #[test]
    fn resolves_directory_and_rejects_missing_or_file() {
        let dir = scratch();
        let sub = dir.join("sub");
        let resolved = resolve_existing_dir(sub.to_str().unwrap()).unwrap();
        assert_eq!(resolved, fs::canonicalize(&sub).unwrap().to_string_lossy());

        let nested = sub.join("..");
        let resolved_parent = resolve_existing_dir(nested.to_str().unwrap()).unwrap();
        assert_eq!(
            resolved_parent,
            fs::canonicalize(&dir).unwrap().to_string_lossy()
        );

        let missing = dir.join("nope");
        let err = resolve_existing_dir(missing.to_str().unwrap()).unwrap_err();
        assert!(err.starts_with("路径不存在:"), "{}", err);

        let file = dir.join("file.txt");
        let err = resolve_existing_dir(file.to_str().unwrap()).unwrap_err();
        assert!(err.starts_with("不是文件夹:"), "{}", err);

        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod complete_path_tests {
    use super::{
        complete_path_blocking, complete_with_home, completion_base, completion_text, PathMatch,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let p =
            std::env::temp_dir().join(format!("bento-complete-{}-{n}-{seq}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn names(dir: &PathBuf, prefix: &str) -> Vec<String> {
        let path = if prefix.is_empty() {
            format!("{}/", dir.display())
        } else {
            format!("{}/{}", dir.display(), prefix)
        };
        complete_path_blocking(&path)
            .unwrap()
            .matches
            .into_iter()
            .map(|m| m.name)
            .collect()
    }

    #[test]
    fn base_keeps_tilde_and_trailing_slash() {
        assert_eq!(completion_base("~"), "~/");
        assert_eq!(completion_base("~/"), "~/");
        assert_eq!(completion_base("~/Doc"), "~/");
        assert_eq!(completion_base("~/Documents/"), "~/Documents/");
        assert_eq!(completion_base("/usr/loc"), "/usr/");
        assert_eq!(completion_base("/"), "/");
    }

    #[test]
    fn text_adds_slash_only_for_a_unique_directory() {
        let dir = PathMatch {
            name: "Documents".into(),
            is_dir: true,
        };
        let file = PathMatch {
            name: "notes.txt".into(),
            is_dir: false,
        };
        assert_eq!(completion_text("~/", "Doc", &[dir.clone()]), "~/Documents/");
        assert_eq!(completion_text("~/", "note", &[file]), "~/notes.txt");
        let many = [
            PathMatch {
                name: "Documents".into(),
                is_dir: true,
            },
            PathMatch {
                name: "Downloads".into(),
                is_dir: true,
            },
        ];
        // 两者共享的 `Do` 比已输入的 `D` 更长，补到分叉点。
        assert_eq!(completion_text("~/", "D", &many), "~/Do");
        assert_eq!(completion_text("~/", "Do", &many), "~/Do");
    }

    #[test]
    fn tilde_completes_unique_directory_without_expanding_in_the_text() {
        let home = scratch();
        fs::create_dir(home.join("Documents")).unwrap();
        fs::create_dir(home.join("Downloads")).unwrap();
        let got = complete_with_home("~/Doc", home.to_str().unwrap()).unwrap();
        assert_eq!(got.base, "~/");
        assert_eq!(got.text, "~/Documents/");
        assert_eq!(got.matches.len(), 1);
        assert_eq!(got.matches[0].name, "Documents");
        assert!(got.matches[0].is_dir);

        let many = complete_with_home("~/D", home.to_str().unwrap()).unwrap();
        assert_eq!(many.base, "~/");
        assert_eq!(many.text, "~/Do");
        assert_eq!(many.matches.len(), 2);
        assert_eq!(many.matches[0].name, "Documents");
        assert_eq!(many.matches[1].name, "Downloads");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn case_insensitive_prefix_one_level_only() {
        let dir = scratch();
        fs::create_dir_all(dir.join("Documents/nested")).unwrap();
        fs::write(dir.join("notes.txt"), b"hi").unwrap();
        let got = complete_path_blocking(&format!("{}/doc", dir.display())).unwrap();
        assert_eq!(got.matches.len(), 1);
        assert!(got.text.ends_with("/Documents/"), "{}", got.text);
        let listed = names(&dir, "");
        assert!(listed.contains(&"Documents".to_string()));
        assert!(listed.contains(&"notes.txt".to_string()));
        assert!(!listed.iter().any(|n| n == "nested"));
        let file = complete_path_blocking(&format!("{}/note", dir.display())).unwrap();
        assert!(file.text.ends_with("/notes.txt"), "{}", file.text);
        assert!(!file.text.ends_with('/'));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hidden_entries_only_match_a_dot_prefix() {
        let dir = scratch();
        fs::create_dir(dir.join(".secret")).unwrap();
        fs::create_dir(dir.join("Visible")).unwrap();
        let all = names(&dir, "");
        assert!(all.contains(&"Visible".to_string()));
        assert!(!all.contains(&".secret".to_string()));
        let hid = complete_path_blocking(&format!("{}/.se", dir.display())).unwrap();
        assert_eq!(hid.matches.len(), 1);
        assert_eq!(hid.matches[0].name, ".secret");
        assert!(hid.text.ends_with("/.secret/"), "{}", hid.text);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn caps_at_fifty_but_common_prefix_sees_every_match() {
        let dir = scratch();
        for i in 0..50 {
            fs::create_dir(dir.join(format!("m-a{i:02}"))).unwrap();
        }
        fs::create_dir(dir.join("m-b")).unwrap();
        let got = complete_path_blocking(&format!("{}/m", dir.display())).unwrap();
        assert_eq!(got.matches.len(), 50);
        assert!(got.matches.iter().all(|m| m.name != "m-b"));
        // `m-b` is past the cap, but it still keeps the shared prefix from growing to `m-a`.
        assert!(got.text.ends_with("/m-"), "{}", got.text);
        assert!(!got.text.ends_with("/m-a"), "{}", got.text);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_missing_file_and_relative_paths() {
        let dir = scratch();
        fs::write(dir.join("file.txt"), b"x").unwrap();
        let missing = complete_path_blocking(&format!("{}/nope/a", dir.display())).unwrap_err();
        assert!(missing.starts_with("路径不存在:"), "{missing}");
        let file = complete_path_blocking(&format!("{}/file.txt/a", dir.display())).unwrap_err();
        assert!(file.starts_with("不是文件夹:"), "{file}");
        assert!(complete_path_blocking("Doc")
            .unwrap_err()
            .contains("绝对路径"));
        assert!(complete_path_blocking("~bob/Doc")
            .unwrap_err()
            .contains("仅支持"));
        assert!(complete_path_blocking("   ")
            .unwrap_err()
            .contains("请输入路径"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_directory_completes_with_slash() {
        let dir = scratch();
        fs::create_dir(dir.join("Documents")).unwrap();
        std::os::unix::fs::symlink(dir.join("Documents"), dir.join("DocsLink")).unwrap();
        let got = complete_path_blocking(&format!("{}/DocsL", dir.display())).unwrap();
        assert_eq!(got.matches.len(), 1);
        assert!(got.matches[0].is_dir);
        assert!(got.text.ends_with("/DocsLink/"), "{}", got.text);
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod new_file_tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "bento-newfile-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn name_of(path: &Path) -> String {
        path.file_name().unwrap().to_string_lossy().into_owned()
    }

    #[test]
    fn text_and_markdown_skip_existing_names_without_overwrite() {
        let dir = scratch("kinds");
        fs::write(dir.join("未命名.txt"), b"keep-txt").unwrap();
        fs::write(dir.join("未命名 2.txt"), b"keep-2").unwrap();
        let third = create_named_file(&dir, "text").unwrap();
        assert_eq!(name_of(&third), "未命名 3.txt");
        assert_eq!(fs::read(dir.join("未命名.txt")).unwrap(), b"keep-txt");
        assert_eq!(fs::read(dir.join("未命名 2.txt")).unwrap(), b"keep-2");
        assert_eq!(fs::read(&third).unwrap(), b"");

        let md = create_named_file(&dir, "markdown").unwrap();
        assert_eq!(name_of(&md), "未命名.md");
        fs::write(&md, b"# keep").unwrap();
        let md2 = create_named_file(&dir, "md").unwrap();
        assert_eq!(name_of(&md2), "未命名 2.md");
        assert_eq!(fs::read(&md).unwrap(), b"# keep");
        assert_eq!(fs::read(&md2).unwrap(), b"");
        assert!(create_named_file(&dir, "docx")
            .unwrap_err()
            .contains("不支持"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_to_create_when_the_parent_is_not_a_directory() {
        let dir = scratch("notdir");
        let file = dir.join("file.txt");
        fs::write(&file, b"x").unwrap();
        let err = create_named_file(&file, "text").unwrap_err();
        assert!(err.contains("不是文件夹"), "{err}");
        assert_eq!(fs::read(&file).unwrap(), b"x");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn templates_are_top_level_files_sorted_by_name() {
        let root = scratch("scan");
        let templates = ensure_templates_dir(&root).unwrap();
        fs::write(templates.join("报告.docx"), b"PK").unwrap();
        fs::write(templates.join("a.txt"), b"a").unwrap();
        fs::write(templates.join(".DS_Store"), b"hidden").unwrap();
        fs::create_dir_all(templates.join("nested")).unwrap();
        fs::write(templates.join("nested/skip.txt"), b"no").unwrap();
        let items = scan_templates(&templates).unwrap();
        let names: Vec<_> = items.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "报告.docx"]);
        assert!(items
            .iter()
            .all(|t| Path::new(&t.path).starts_with(&templates)));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_template_keeps_bytes_and_suffixes_collisions() {
        let root = scratch("copy");
        let templates = root.join("templates");
        let dest = root.join("dest");
        fs::create_dir_all(&templates).unwrap();
        fs::create_dir_all(&dest).unwrap();
        let src = templates.join("周报.docx");
        fs::write(&src, b"template-bytes").unwrap();
        fs::write(dest.join("周报.docx"), b"already").unwrap();

        let created = copy_template_file(&templates, &dest, &src).unwrap();
        assert_eq!(name_of(&created), "周报 2.docx");
        assert_eq!(fs::read(&created).unwrap(), b"template-bytes");
        assert_eq!(fs::read(dest.join("周报.docx")).unwrap(), b"already");
        assert_eq!(fs::read(&src).unwrap(), b"template-bytes");

        let fresh_dir = root.join("empty");
        fs::create_dir_all(&fresh_dir).unwrap();
        let first = copy_template_file(&templates, &fresh_dir, &src).unwrap();
        assert_eq!(name_of(&first), "周报.docx");
        assert_eq!(fs::read(&first).unwrap(), b"template-bytes");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_template_rejects_files_outside_the_templates_dir() {
        let root = scratch("escape");
        let templates = root.join("templates");
        let dest = root.join("dest");
        fs::create_dir_all(&templates).unwrap();
        fs::create_dir_all(&dest).unwrap();
        let outside = root.join("secret.docx");
        fs::write(&outside, b"secret").unwrap();
        let err = copy_template_file(&templates, &dest, &outside).unwrap_err();
        assert!(err.contains("模板必须位于模板目录内"), "{err}");
        assert!(!dest.join("secret.docx").exists());
        assert_eq!(fs::read(&outside).unwrap(), b"secret");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_pointing_outside_templates_is_ignored_and_not_copied() {
        let root = scratch("symlink");
        let templates = root.join("templates");
        let dest = root.join("dest");
        fs::create_dir_all(&templates).unwrap();
        fs::create_dir_all(&dest).unwrap();
        let outside = root.join("secret.docx");
        fs::write(&outside, b"secret").unwrap();
        let link = templates.join("link.docx");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(scan_templates(&templates).unwrap().is_empty());
        let err = copy_template_file(&templates, &dest, &link).unwrap_err();
        assert!(err.contains("模板必须位于模板目录内"), "{err}");
        let leftovers: Vec<_> = fs::read_dir(&dest)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = fs::remove_dir_all(&root);
    }
}
