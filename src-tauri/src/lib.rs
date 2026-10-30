use rayon::prelude::*;
use serde::Serialize;
use std::ffi::CString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

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

fn do_transfer(sp: &Path, dp: &Path, mode: &str) -> io::Result<()> {
    if mode == "move" {
        if fs::rename(sp, dp).is_ok() {
            return Ok(());
        }
        // 跨卷移动：拷贝后删除源
        copy_recursive(sp, dp)?;
        if sp.is_dir() {
            fs::remove_dir_all(sp)?;
        } else {
            fs::remove_file(sp)?;
        }
        Ok(())
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

#[derive(Serialize, Clone)]
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
                let dp = unique_path(&dest_dir, &name);
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

/// 用 ditto 压缩为 zip（保留父文件夹名），返回 zip 路径
#[tauri::command]
async fn zip_paths(sources: Vec<String>, dest_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&dest_dir);
        if !dir.is_dir() {
            return Err(format!("目标不是文件夹: {}", dest_dir));
        }
        let base = if sources.len() == 1 {
            let p = Path::new(&sources[0]);
            format!(
                "{}.zip",
                p.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "归档".into())
            )
        } else {
            "归档.zip".to_string()
        };
        let dest = unique_path(&dir, &base);
        let mut cmd = std::process::Command::new("ditto");
        cmd.args(["-c", "-k", "--sequesterRsrc", "--keepParent"]);
        for s in &sources {
            cmd.arg(s);
        }
        cmd.arg(&dest);
        let out = cmd.output().map_err(|e| format!("压缩失败: {}", e))?;
        if !out.status.success() {
            return Err(format!("压缩失败: {}", String::from_utf8_lossy(&out.stderr)));
        }
        Ok(dest.to_string_lossy().into_owned())
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

/// macOS 快速查看窗口
#[tauri::command]
async fn quick_look(path: String) -> Result<(), String> {
    std::process::Command::new("qlmanage")
        .args(["-p", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
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
        let pattern: String = words.join(" ").replace('"', "");
        if pattern.is_empty() {
            return Ok(Vec::new());
        }
        let query = fsearch::Query::parse(&format!("{}grep:{}", filters, pattern), &home)?;
        let t0 = std::time::Instant::now();
        let g = fsearch::Grep::new(&pattern, fsearch::GrepMode::Literal)?;
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

#[derive(Serialize)]
struct TextPreview {
    kind: String, // "text" | "binary" | "image" | "too-large"
    text: String,
    truncated: bool,
    match_lines: Vec<f64>,
}

fn is_image_path(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp") | Some("bmp")
    )
}

/// 读取文本文件内容供搜索预览：全量（截断至 max_bytes）+ 命中行号
#[tauri::command]
async fn read_text_preview(
    path: String,
    query: String,
    max_bytes: Option<usize>,
) -> Result<TextPreview, String> {
    let _ = max_bytes; // 预览统一 256KB 上限，参数保留兼容前端
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        if is_image_path(p) {
            return Ok(TextPreview {
                kind: "image".into(),
                text: String::new(),
                truncated: false,
                match_lines: Vec::new(),
            });
        }
        let cap = max_bytes.unwrap_or(262_144);
        let md = fs::metadata(p).map_err(|e| format!("无法读取: {}", e))?;
        let truncated = md.len() > cap as u64;
        let take = if truncated {
            // 截断到行边界附近，避免切出半行
            let mut end = cap;
            let f = fs::File::open(p).map_err(|e| e.to_string())?;
            use std::io::Read;
            let mut buf = vec![0u8; cap];
            f.take(cap as u64).read_exact(&mut buf).ok();
            if let Some(pos) = buf.iter().rposition(|&b| b == b'\n') {
                end = pos;
            }
            let s = String::from_utf8_lossy(&buf[..end]).into_owned();
            return Ok(TextPreview {
                kind: "text".into(),
                text: s,
                truncated,
                match_lines: Vec::new(),
            });
        } else {
            md.len() as usize
        };
        let bytes = fs::read(p).map_err(|e| e.to_string())?;
        // 二进制检测：前 8KB 含 NUL
        let probe = &bytes[..bytes.len().min(8192)];
        if probe.contains(&0u8) {
            return Ok(TextPreview {
                kind: "binary".into(),
                text: String::new(),
                truncated: false,
                match_lines: Vec::new(),
            });
        }
        let full = String::from_utf8_lossy(&bytes[..take.min(bytes.len())]).into_owned();
        // 逐行截断（单行超长——如压缩 JS——会拖垮前端渲染）并限制总行数
        let text: String = full
            .lines()
            .take(3000)
            .map(|l| {
                if l.chars().count() > 300 {
                    let t: String = l.chars().take(300).collect();
                    format!("{} …", t)
                } else {
                    l.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        // 匹配规则：空格分隔 = AND；每个词含非字母数字字符时（如 library(forest）
        // 拆为子片段，行须包含全部子片段；纯字母数字词整词匹配
        let terms: Vec<Vec<String>> = query
            .split_whitespace()
            .filter(|w| !w.contains(':'))
            .map(|w| {
                let lw = w.to_lowercase();
                if lw.chars().all(|c| c.is_alphanumeric() || c == '_') {
                    vec![lw]
                } else {
                    lw.split(|c: char| !(c.is_alphanumeric() || c == '_'))
                        .filter(|f| !f.is_empty())
                        .map(|f| f.to_string())
                        .collect()
                }
            })
            .collect();
        let mut match_lines = Vec::new();
        if !terms.is_empty() {
            for (i, line) in text.lines().enumerate() {
                let lc = line.to_lowercase();
                if terms
                    .iter()
                    .all(|frags| frags.iter().any(|f| lc.contains(f.as_str())))
                {
                    match_lines.push((i + 1) as f64);
                    if match_lines.len() >= 20 {
                        break;
                    }
                }
            }
        }
        Ok(TextPreview {
            kind: "text".into(),
            text,
            truncated,
            match_lines,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把文件引用写进系统剪贴板（AppleScript alias 列表格式 = NSFilenamesPboardType，
/// Finder/微信/邮件均可直接粘贴文件本体）
#[tauri::command]
async fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    if paths.iter().any(|p| p.contains('"')) {
        return Err("路径包含引号，无法写入剪贴板".into());
    }
    eprintln!("[clipboard] writing {} paths", paths.len());
    let list: Vec<String> = paths
        .iter()
        .map(|p| format!("POSIX file \"{}\"", p))
        .collect();
    let script = format!("set the clipboard to {{{}}}", list.join(", "));
    let out = std::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| e.to_string())?;
    eprintln!(
        "[clipboard] osascript status={} stderr={}",
        out.status,
        String::from_utf8_lossy(&out.stderr).trim()
    );
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
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

/// 立即保存窗口大小/位置（前端在 resize/move 防抖后调用）
#[tauri::command]
async fn save_window_state(app: AppHandle) -> Result<(), String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 自定义菜单：不带任何会与前端冲突的标准快捷键
            // （默认菜单的 ⌘W 关窗 / ⌘R 刷新 / ⌘C 拷贝 会抢先拦截按键事件）
            let about = PredefinedMenuItem::about(app, None, None)?;
            let quit = PredefinedMenuItem::quit(app, None)?;
            let app_menu = SubmenuBuilder::new(app, "Bento")
                .item(&about)
                .separator()
                .item(&quit)
                .build()?;

            let close_item = MenuItemBuilder::with_id("close-win", "关闭窗口").build(app)?;
            let file_menu = SubmenuBuilder::new(app, "文件").item(&close_item).build()?;

            let minimize = PredefinedMenuItem::minimize(app, None)?;
            let maximize = PredefinedMenuItem::maximize(app, None)?;
            let window_menu = SubmenuBuilder::new(app, "窗口")
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
            open_privacy_settings,
            disk_space,
            home_dir,
            log_debug,
            append_trace_log,
            append_error_log,
            save_window_state,
            fsearch_status,
            load_config,
            save_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
