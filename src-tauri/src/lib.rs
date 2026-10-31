use rayon::prelude::*;
use serde::Serialize;

#[cfg(target_os = "macos")]
mod quick_look;

use std::ffi::CString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

mod native_icons;
use native_icons::file_icons;

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

fn fsearch_global(query: &str, limit: usize) -> Option<Vec<SearchItem>> {
    let eng = fsearch_engine()?;
    let home = std::env::var("HOME").unwrap_or_default();
    let q = fsearch::Query::parse(query, &home).ok()?;
    let found = eng.search(&q).ok()?;
    Some(
        found
            .into_iter()
            .take(limit)
            .map(|f| {
                let path = f.path;
                let is_dir = (f.kind & 0b11) == fsearch::walk::KIND_DIR;
                let md = fs::metadata(&path).ok();
                SearchItem {
                    dir: path
                        .parent()
                        .map(|x| x.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    name: path
                        .file_name()
                        .map(|x| x.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    path: path.to_string_lossy().into_owned(),
                    is_dir,
                    size: if f.size > 0 { f.size } else { md.as_ref().map(|m| if m.is_dir() { 0 } else { m.len() }).unwrap_or(0) },
                    mtime_ms: md.as_ref().map(mtime_of).unwrap_or((f.mtime as i64) as f64 * 1000.0),
                    btime_ms: md.as_ref().map(btime_of).unwrap_or(0.0),
                    lines: None,
                    matches: None,
                }
            })
            .collect(),
    )
}

#[derive(Serialize, Clone)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    mtime_ms: f64,
    btime_ms: f64,
    ext: String,
}

#[derive(Serialize)]
struct ListResult {
    entries: Vec<Entry>,
}

fn make_entry(p: &Path, name: String) -> Option<Entry> {
    let md = fs::metadata(p).or_else(|_| fs::symlink_metadata(p)).ok()?;
    let is_dir = md.is_dir();
    let size = if is_dir { 0 } else { md.len() };
    let mtime_ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    Some(Entry {
        name,
        path: p.to_string_lossy().into_owned(),
        is_dir,
        size,
        mtime_ms,
        btime_ms: md.created().ok().and_then(btime_ms_of).unwrap_or(0.0),
        ext,
    })
}

/// 并行列出目录内容（rayon 多线程 stat，大文件夹扫描快）
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
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for i in 2..10000u32 {
        let c = dir.join(format!("{} {}{}", stem, i, ext));
        if !c.exists() {
            return c;
        }
    }
    dir.join(format!("{}-{}", name, std::process::id()))
}

/// 拷贝/移动时目标重名的命名：「name copy.ext」，再重名依次「name copy 1.ext」「name copy 2.ext」…
/// 对已带「copy[ N]」后缀的名字（以及旧版的中文「副本[N]」）先去掉后缀再编号
/// （「a copy.txt」再拷 → 「a copy 1.txt」，而不是「a copy copy.txt」）
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

fn copy_name_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let base = strip_copy_suffix(stem);
    let first = dir.join(format!("{} copy{}", base, ext));
    if !first.exists() {
        return first;
    }
    for i in 1..10000u32 {
        let c = dir.join(format!("{} copy {}{}", base, i, ext));
        if !c.exists() {
            return c;
        }
    }
    dir.join(format!("{}-{}", name, std::process::id()))
}

fn copy_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for e in fs::read_dir(src)? {
            let e = e?;
            copy_recursive(&e.path(), &dst.join(e.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(p) = dst.parent() {
            fs::create_dir_all(p)?;
        }
        fs::copy(src, dst).map(|_| ())
    }
}

/// APFS clonefile：同卷拷贝瞬间完成（零拷贝），失败则回退普通拷贝
#[cfg(target_os = "macos")]
fn clonefile(src: &Path, dst: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(src.as_os_str().as_bytes()).map_err(|_| io::Error::from_raw_os_error(22))?;
    let d = CString::new(dst.as_os_str().as_bytes()).map_err(|_| io::Error::from_raw_os_error(22))?;
    let rc = unsafe { libc::clonefile(c.as_ptr(), d.as_ptr(), 0) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn is_exdev(err: &io::Error) -> bool {
    err.raw_os_error() == Some(libc::EXDEV) || err.kind() == io::ErrorKind::CrossesDevices
}

/// 跨卷复制用：保留符号链接本身，不跟随链接去复制（或删除）目标。
fn copy_for_move(src: &Path, dst: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        let target = fs::read_link(src)?;
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        std::os::unix::fs::symlink(target, dst)?;
        return Ok(());
    }
    if meta.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_for_move(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst).map(|_| ())
    }
}

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

fn temp_move_path(dir: &Path) -> PathBuf {
    let pid = std::process::id();
    for i in 0..1000u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let candidate = dir.join(format!(".bento-move-{pid}-{nanos}-{i}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!(".bento-move-{pid}-fallback"))
}

/// 跨卷移动：先把内容复制到目标卷的临时名，改名成功后才删除源。
/// 复制或改名失败时删掉临时文件，源保持原样。
fn copy_then_remove(src: &Path, dst: &Path) -> io::Result<()> {
    copy_then_remove_with(src, dst, copy_for_move, remove_path)
}

fn copy_then_remove_with(
    src: &Path,
    dst: &Path,
    copy: impl FnOnce(&Path, &Path) -> io::Result<()>,
    remove_src: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let parent = dst
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "目标路径无效"))?;
    let tmp = temp_move_path(parent);
    if let Err(err) = copy(src, &tmp) {
        let _ = remove_path(&tmp);
        return Err(io::Error::new(
            err.kind(),
            format!("复制未完成，源文件保持原样: {err}"),
        ));
    }
    if let Err(err) = fs::rename(&tmp, dst) {
        let _ = remove_path(&tmp);
        return Err(io::Error::new(
            err.kind(),
            format!("复制未完成，源文件保持原样: {err}"),
        ));
    }
    if let Err(err) = remove_src(src) {
        return Err(io::Error::new(
            err.kind(),
            format!(
                "已复制到「{}」，但无法删除源（请检查源是否残留）: {err}",
                dst.display()
            ),
        ));
    }
    Ok(())
}

/// 同卷 rename；仅当内核返回 EXDEV 时才复制后删除。
fn relocate(src: &Path, dst: &Path) -> io::Result<()> {
    relocate_with(src, dst, |s, d| fs::rename(s, d))
}

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

fn do_transfer(sp: &Path, dp: &Path, mode: &str) -> io::Result<()> {
    if mode == "move" {
        relocate(sp, dp)
    } else {
        #[cfg(target_os = "macos")]
        {
            if clonefile(sp, dp).is_ok() {
                return Ok(());
            }
        }
        copy_recursive(sp, dp)
    }
}

fn move_one_item(source: &str, dest_dir: &Path) -> TransferItem {
    let fail = |error: String| TransferItem {
        source: source.to_string(),
        dest: String::new(),
        ok: false,
        error: Some(error),
    };
    let sp = PathBuf::from(source);
    if fs::symlink_metadata(&sp).is_err() {
        return fail("源不存在".into());
    }
    // 已经在目标目录：剪切后粘贴到原处，不动文件。
    if sp.parent().is_some_and(|parent| parent == dest_dir) {
        return TransferItem {
            source: source.to_string(),
            dest: source.to_string(),
            ok: true,
            error: None,
        };
    }
    let name = sp
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "untitled".into());
    let dp = copy_name_path(dest_dir, &name);
    if dp.starts_with(&sp) {
        return fail("不能将文件夹移动到其自身内部".into());
    }
    match relocate(&sp, &dp) {
        Ok(()) => TransferItem {
            source: source.to_string(),
            dest: dp.to_string_lossy().into_owned(),
            ok: true,
            error: None,
        },
        Err(err) => fail(err.to_string()),
    }
}

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

#[derive(Serialize, Clone, Debug)]
struct TransferItem {
    source: String,
    dest: String,
    ok: bool,
    error: Option<String>,
}

/// 复制/移动多个文件到目标目录，逐项上报进度事件 transfer-progress
#[tauri::command]
async fn transfer(
    app: AppHandle,
    sources: Vec<String>,
    dest: String,
    mode: String,
) -> Result<Vec<TransferItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest_dir = PathBuf::from(&dest);
        if !dest_dir.is_dir() {
            return Err(format!("目标不是文件夹: {}", dest));
        }
        let total = sources.len();
        let mut out = Vec::with_capacity(total);
        for (i, s) in sources.iter().enumerate() {
            let sp = PathBuf::from(s);
            let name = sp
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "untitled".into());
            let item = if !sp.exists() {
                TransferItem {
                    source: s.clone(),
                    dest: String::new(),
                    ok: false,
                    error: Some("源不存在".into()),
                }
            } else if mode == "move" && sp.parent().map(|p| p == dest_dir).unwrap_or(false) {
                TransferItem {
                    source: s.clone(),
                    dest: s.clone(),
                    ok: true,
                    error: None,
                }
            } else {
                let dp = copy_name_path(&dest_dir, &name);
                let res = if dp.starts_with(&sp) {
                    Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "不能将文件夹移动/拷贝到其自身内部".to_string(),
                    ))
                } else {
                    do_transfer(&sp, &dp, &mode)
                };
                match res {
                    Ok(()) => TransferItem {
                        source: s.clone(),
                        dest: dp.to_string_lossy().into_owned(),
                        ok: true,
                        error: None,
                    },
                    Err(e) => TransferItem {
                        source: s.clone(),
                        dest: String::new(),
                        ok: false,
                        error: Some(e.to_string()),
                    },
                }
            };
            out.push(item);
            let _ = app.emit(
                "transfer-progress",
                serde_json::json!({ "done": i + 1, "total": total }),
            );
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ⌘X / ⌘V：把条目移动到目标文件夹。同卷 rename；仅 EXDEV 时复制成功后再删除源。
#[tauri::command]
async fn move_items(
    app: AppHandle,
    sources: Vec<String>,
    dest: String,
) -> Result<Vec<TransferItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        move_into(&sources, &dest, |done, total| {
            let _ = app.emit(
                "transfer-progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 自管废纸篓：主盘文件移入 ~/.Trash（与 Finder 一致），挂载卷/其他用户目录
/// 移入 Bento 回收站（应用数据目录）。返回原始位置与实际废纸篓位置，供 ⌘Z 撤销。
#[derive(Serialize, Clone)]
struct TrashEntry {
    original: String,
    trashed: String,
}

fn bento_trash_dir(app_dir: &Path) -> std::path::PathBuf {
    app_dir.join("Trash")
}

#[tauri::command]
async fn trash(paths: Vec<String>, app: AppHandle) -> Result<Vec<TrashEntry>, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let home = std::env::var("HOME").unwrap_or_default();
    let mut entries = Vec::new();
    for p in &paths {
        let src = Path::new(p);
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into());
        // 主盘（home 内）→ ~/.Trash；否则 → Bento 回收站（该卷可能无可写 .Trashes）
        let in_home = !home.is_empty() && p.starts_with(home.as_str());
        let trash_root = if in_home {
            PathBuf::from(&home).join(".Trash")
        } else {
            bento_trash_dir(&app_dir)
        };
        fs::create_dir_all(&trash_root).map_err(|e| format!("创建废纸篓目录失败: {}", e))?;
        let dest = unique_path(&trash_root, &name);
        do_transfer(src, &dest, "move").map_err(|e| format!("移到废纸篓失败: {}", e))?;
        entries.push(TrashEntry {
            original: p.clone(),
            trashed: dest.to_string_lossy().into_owned(),
        });
    }
    Ok(entries)
}

/// 新建文件夹，自动命名「未命名文件夹」「未命名文件夹 2」…，返回实际路径
#[tauri::command]
async fn make_dir(path: String) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("不是文件夹: {}", path));
    }
    let target = unique_path(&dir, "未命名文件夹");
    fs::create_dir(&target).map_err(|e| format!("创建失败: {}", e))?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
async fn rename(old_path: String, new_name: String) -> Result<String, String> {
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
    if dest.exists() && dest != old {
        return Err(format!("「{}」已存在", name));
    }
    fs::rename(&old, &dest).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(dest.to_string_lossy().into_owned())
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
    tauri::async_runtime::spawn_blocking(move || {
        let opts = options.unwrap_or_default();
        let dir = PathBuf::from(&dest_dir);
        if !dir.is_dir() {
            return Err(format!("目标不是文件夹: {}", dest_dir));
        }
        if sources.is_empty() {
            return Ok(Vec::new());
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
        let mut created: Vec<String> = Vec::new();
        for (srcs, name) in groups {
            let dest = unique_path(&dir, &name.replace('/', "_"));
            if let Err(e) = run_zip(&srcs, &dest, level, opts.password.as_deref()) {
                let _ = fs::remove_file(&dest);
                return Err(e);
            }
            created.push(dest.to_string_lossy().into_owned());
        }
        Ok(created)
    })
    .await
    .map_err(|e| e.to_string())?
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
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return quick_look::present(app, path, paths).await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path, paths);
        Err("Quick Look 仅支持 macOS".into())
    }
}

/// 新建空白文本文档，返回实际路径
#[tauri::command]
async fn make_file(path: String) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("不是文件夹: {}", path));
    }
    let target = unique_path(&dir, "未命名.txt");
    fs::File::create_new(&target).map_err(|e| format!("创建失败: {}", e))?;
    Ok(target.to_string_lossy().into_owned())
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

/// 递归搜索时跳过的目录（避免在依赖目录/系统目录里空转）
const SEARCH_SKIP: &[&str] = &["node_modules", ".git", "Library", ".Trash", ".npm", ".cache"];

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

fn walk_search(root: &Path, query: &str, show_hidden: bool, limit: usize) -> Result<Vec<SearchItem>, String> {
    let matcher = build_matcher(query)?;
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 8 {
            continue;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for e in rd.filter_map(|e| e.ok()) {
            if out.len() >= limit {
                break;
            }
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !show_hidden && name.starts_with('.') {
                continue;
            }
            if is_dir && SEARCH_SKIP.contains(&name.as_str()) {
                continue;
            }
            let ext = p
                .extension()
                .map(|x| x.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if matcher(&name, &ext) {
                let md = e.metadata().ok();
                let size = if is_dir {
                    0
                } else {
                    md.as_ref().map(|m| m.len()).unwrap_or(0)
                };
                out.push(SearchItem {
                    dir: dir.to_string_lossy().into_owned(),
                    path: p.to_string_lossy().into_owned(),
                    name,
                    is_dir,
                    size,
                    mtime_ms: md.as_ref().map(mtime_of).unwrap_or(0.0),
                    btime_ms: md.as_ref().map(btime_of).unwrap_or(0.0),
                    lines: None,
                    matches: None,
                });
            }
            if is_dir {
                stack.push((p, depth + 1));
            }
        }
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

fn mdfind_search(query: &str, onlyin: Option<&str>, limit: usize) -> Vec<SearchItem> {
    let mut cmd = std::process::Command::new("mdfind");
    if let Some(d) = onlyin {
        cmd.args(["-onlyin", d]);
    }
    cmd.args(["-name", query]);
    let out = match cmd.output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let paths: Vec<&str> = stdout.lines().take(limit).collect();
    paths
        .par_iter()
        .filter_map(|p| {
            let pb = Path::new(p);
            let name = pb.file_name()?.to_string_lossy().into_owned();
            let md = fs::metadata(pb).ok();
            let is_dir = md.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = md.as_ref().map(|m| if m.is_dir() { 0 } else { m.len() }).unwrap_or(0);
            Some(SearchItem {
                dir: pb
                    .parent()
                    .map(|x| x.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: p.to_string(),
                name,
                is_dir,
                size,
                mtime_ms: md.as_ref().map(mtime_of).unwrap_or(0.0),
                btime_ms: md.as_ref().map(btime_of).unwrap_or(0.0),
                lines: None,
                matches: None,
            })
        })
        .collect()
}

/// 搜索：scope = "pane"(递归 root) | "home"(递归主目录) | "global"(Spotlight)
#[tauri::command]
async fn search(
    query: String,
    scope: String,
    root: Option<String>,
    show_hidden: bool,
    limit: Option<usize>,
    roots: Option<Vec<String>>,
    mode: Option<String>,
) -> Result<Vec<SearchItem>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(200).min(1000);
    // 内容模式：委托 fsearch grep（三词索引）
    if scope == "global" && mode.as_deref() == Some("content") {
        return search_content(q, root, Some(limit), roots).await;
    }
    tauri::async_runtime::spawn_blocking(move || match scope.as_str() {
        // 全局：优先 fsearch 引擎（模糊 + 拼写容错 + 实时 + glob/ext 语法）
        // 并合并**全盘** Spotlight 结果（-onlyin /Volumes 不会递归挂载点，必须全盘查）
        // roots 非空时按前缀过滤（用户在设置里限定的搜索范围）
        "global" => {
            let mut out = match fsearch_global(&q, limit) {
                Some(v) => v,
                None => mdfind_search(&q, None, limit),
            };
            for item in mdfind_search(&q, None, limit) {
                if !out.iter().any(|e| e.path == item.path) {
                    out.push(item);
                }
            }
            if let Some(roots) = roots {
                if !roots.is_empty() {
                    let trimmed: Vec<SearchItem> = out
                        .into_iter()
                        .filter(|item| {
                            roots
                                .iter()
                                .any(|r| item.path.starts_with(r.as_str()))
                        })
                        .collect();
                    out = trimmed;
                }
            }
            Ok(out)
        }
        "home" => {
            let h = std::env::var("HOME").unwrap_or_default();
            walk_search(Path::new(&h), &q, show_hidden, limit)
        }
        _ => match root {
            Some(r) => walk_search(Path::new(&r), &q, show_hidden, limit),
            None => Ok(mdfind_search(&q, None, limit)),
        },
    })
    .await
    .map_err(|e| e.to_string())?
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

/// 文件内容搜索（fsearch grep 三词索引）
#[tauri::command]
async fn search_content(
    query: String,
    root: Option<String>,
    limit: Option<usize>,
    roots: Option<Vec<String>>,
) -> Result<Vec<SearchItem>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(200).min(1000);
    tauri::async_runtime::spawn_blocking(move || {
        let eng = fsearch_engine().ok_or("内容搜索需要 fsearch 引擎（首次建索引中）")?;
        let home = std::env::var("HOME").unwrap_or_default();
        // 过滤器（ext:/kind: 等）进 Query；其余词作为内容模式
        let mut filters = String::new();
        let mut words = Vec::new();
        for w in q.split_whitespace() {
            if w.contains(':') {
                filters.push_str(w);
                filters.push(' ');
            } else {
                words.push(w);
            }
        }
        let pattern: String = content_pattern(&q);
        if pattern.is_empty() {
            return Ok(Vec::new());
        }
        let query = fsearch::Query::parse(&format!("{}grep:{}", filters, pattern), &home)?;
        let t0 = std::time::Instant::now();
        let mut g = fsearch::Grep::new(&pattern, fsearch::GrepMode::Literal)?;
        // 左列表徽标 = 命中行数；放宽 fsearch 默认的每文件 5 行上限，与右栏预览同口径
        g.max_per_file = 20;
        let (res, _) = eng.grep(&query, &g)?;
        eprintln!(
            "[search] content \"{}\": {} files, {} ms",
            pattern,
            res.files.len(),
            t0.elapsed().as_millis()
        );
        let mut out: Vec<SearchItem> = res
            .files
            .iter()
            .map(|f| {
                let pb = PathBuf::from(String::from_utf8_lossy(&f.path).into_owned());
                let lines: Vec<ContentLine> = f
                    .lines
                    .iter()
                    .take(3)
                    .map(|(no, t)| ContentLine {
                        no: *no as f64,
                        text: t.chars().take(200).collect::<String>(),
                    })
                    .collect();
                SearchItem {
                    dir: pb
                        .parent()
                        .map(|x| x.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    name: pb
                        .file_name()
                        .map(|x| x.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    path: pb.to_string_lossy().into_owned(),
                    is_dir: false,
                    size: 0,
                    mtime_ms: 0.0,
                    btime_ms: 0.0,
                    lines: Some(lines),
                    matches: Some(f.lines.len()),
                }
            })
            .collect();
        if let Some(roots) = roots {
            if !roots.is_empty() {
                out.retain(|item| roots.iter().any(|r| item.path.starts_with(r.as_str())));
            }
        }
                out.truncate(limit);
if let Some(r) = root {
            out.retain(|item| item.path.starts_with(r.as_str()));
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
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
        assert_eq!(fs::read(&src).unwrap(), b"hello");
        assert_eq!(fs::read(&dst).unwrap(), b"hello");
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

/// 目录监听：窗格当前目录 + 展开的子目录由前端登记（set_watched），文件增删改时（FSEvents，
/// 150ms 合并）向前端发 `fs-changed`（变化所在的目录列表），窗格即时刷新，无需手动 ⌘R。
struct FsWatcher {
    watcher: std::sync::Mutex<notify::RecommendedWatcher>,
    /// 规范化路径（FSEvents 报告真实路径，如 /private/tmp）→ 前端传入的原始路径
    watched: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<PathBuf, Vec<String>>>>,
}

impl FsWatcher {
    fn new(app: AppHandle) -> notify::Result<Self> {
        use std::collections::{HashMap, HashSet};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};
        let watched: Arc<Mutex<HashMap<PathBuf, Vec<String>>>> = Arc::default();
        let pending: Arc<Mutex<HashSet<String>>> = Arc::default();
        let scheduled = Arc::new(AtomicBool::new(false));
        let (w2, p2, s2) = (watched.clone(), pending.clone(), scheduled.clone());
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if matches!(ev.kind, notify::EventKind::Access(_)) {
                return;
            }
            let mut hit = false;
            {
                let map = w2.lock().unwrap();
                for p in &ev.paths {
                    // 只关心「被监听目录的直接子项」变化；FSEvents 在 OS 层是递归的，其余事件丢弃
                    if let Some(orig) = p.parent().and_then(|d| map.get(d)) {
                        p2.lock().unwrap().extend(orig.iter().cloned());
                        hit = true;
                    }
                }
            }
            if hit && !s2.swap(true, Ordering::SeqCst) {
                let (app, p3, s3) = (app.clone(), p2.clone(), s2.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    s3.store(false, Ordering::SeqCst);
                    let dirs: Vec<String> = p3.lock().unwrap().drain().collect();
                    if !dirs.is_empty() {
                        let _ = app.emit("fs-changed", dirs);
                    }
                });
            }
        })?;
        Ok(Self { watcher: Mutex::new(watcher), watched })
    }
}

#[tauri::command]
fn set_watched(paths: Vec<String>, state: tauri::State<'_, FsWatcher>) -> Result<(), String> {
    use notify::{RecursiveMode, Watcher};
    use std::collections::HashMap;
    let mut want: HashMap<PathBuf, Vec<String>> = HashMap::new();
    for p in paths {
        // 根目录监听会收到整盘事件，不监听
        if p == "/" {
            continue;
        }
        if let Ok(c) = fs::canonicalize(&p) {
            want.entry(c).or_default().push(p);
        }
    }
    // 不在持锁时调用 watch/unwatch：通知线程回调里要拿 watched 锁，避免互相等待
    let current: Vec<PathBuf> = state.watched.lock().unwrap().keys().cloned().collect();
    {
        let mut w = state.watcher.lock().unwrap();
        for old in current.iter().filter(|k| !want.contains_key(*k)) {
            let _ = w.unwatch(old);
        }
        for new in want.keys().filter(|k| !current.contains(k)) {
            if let Err(e) = w.watch(new, RecursiveMode::NonRecursive) {
                eprintln!("[watch] {} failed: {e}", new.display());
            }
        }
    }
    *state.watched.lock().unwrap() = want;
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            enable_background_drag(app);
            app.manage(FsWatcher::new(app.handle().clone()).expect("fs watcher"));
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

            let minimize = PredefinedMenuItem::minimize(app, None)?;
            let maximize = PredefinedMenuItem::maximize(app, None)?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .item(&minimize)
                .item(&maximize)
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &file_menu, &window_menu])
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
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().0 == "close-win" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            transfer,
            move_items,
            trash,
            make_dir,
            rename,
            open_path,
            reveal_in_finder,
            open_terminal,
            zip_paths,
            quick_look,
            make_file,
            search,
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
            load_config,
            save_config,
            file_icons
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
