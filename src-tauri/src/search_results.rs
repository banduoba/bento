//! Typed, bounded search execution. All scopes share visibility and result admission.
use super::{
    btime_of, build_matcher, content_pattern, fsearch_engine, mtime_of, ContentLine, LineMatcher,
    SearchItem,
};
use serde::Serialize;
use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchError {
    pub code: &'static str,
    pub message: String,
}
impl SearchError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
type Result<T> = std::result::Result<T, SearchError>;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    code: &'static str,
    message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub items: Vec<SearchItem>,
    pub truncated: bool,
    pub incomplete: bool,
    pub warnings: Vec<Warning>,
    pub source: String,
}
impl SearchResponse {
    fn new(source: &str) -> Self {
        Self {
            items: vec![],
            truncated: false,
            incomplete: false,
            warnings: vec![],
            source: source.into(),
        }
    }
    fn warn(&mut self, code: &'static str, message: impl Into<String>) {
        self.incomplete = true;
        if self.warnings.len() < 16 && !self.warnings.iter().any(|w| w.code == code) {
            self.warnings.push(Warning {
                code,
                message: message.into(),
            });
        }
    }
}
#[derive(Clone)]
struct Budget {
    file_bytes: usize,
    line_bytes: usize,
    depth: usize,
    entries: usize,
    duration: Duration,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            file_bytes: 16 * 1024 * 1024,
            line_bytes: 64 * 1024,
            depth: 64,
            entries: 100000,
            duration: Duration::from_secs(2),
        }
    }
}
struct Request {
    query: String,
    scope: String,
    root: Option<String>,
    roots: Vec<String>,
    show_hidden: bool,
    mode: String,
    format: String,
    limit: usize,
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(SearchError::new("cancelled", "搜索已取消"))
    } else {
        Ok(())
    }
}
fn format_extensions(format: &str) -> Option<&'static [&'static str]> {
    Some(match format {
        "all" | "folder" => return None,
        "image" => &["png", "jpg", "jpeg", "gif", "webp"],
        "document" => &["doc", "docx", "pdf", "md", "txt"],
        "spreadsheet" => &["xls", "xlsx", "csv"],
        "presentation" => &["ppt", "pptx", "key"],
        "video" => &["mp4", "mov", "mkv"],
        "archive" => &["zip", "rar", "7z", "dmg"],
        _ => &[],
    })
}
fn format_ok(path: &Path, is_dir: bool, format: &str) -> bool {
    match format {
        "all" => true,
        "folder" => is_dir,
        _ => {
            !is_dir
                && format_extensions(format).unwrap_or(&[]).contains(
                    &path
                        .extension()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_lowercase()
                        .as_str(),
                )
        }
    }
}
fn hidden(path: &Path) -> bool {
    path.components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}
fn visible(path: &Path, show_hidden: bool) -> bool {
    !bento_fswatch::is_internal(path) && (show_hidden || !hidden(path))
}
fn directory(raw: &str) -> Result<PathBuf> {
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err(SearchError::new(
            "invalidRoot",
            "搜索范围必须是绝对目录路径",
        ));
    }
    let root = fs::canonicalize(p)
        .map_err(|e| SearchError::new("invalidRoot", format!("无法打开搜索目录 {raw}: {e}")))?;
    if !root.is_dir() || bento_fswatch::is_internal(&root) {
        return Err(SearchError::new(
            "invalidRoot",
            "搜索范围不是可搜索的文件夹",
        ));
    }
    Ok(root)
}
fn item(
    path: &Path,
    md: &fs::Metadata,
    lines: Option<Vec<ContentLine>>,
    matches: Option<usize>,
) -> SearchItem {
    SearchItem {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        dir: path
            .parent()
            .unwrap_or(Path::new("/"))
            .to_string_lossy()
            .into_owned(),
        is_dir: md.is_dir(),
        size: if md.is_dir() { 0 } else { md.len() },
        mtime_ms: mtime_of(md),
        btime_ms: btime_of(md),
        lines,
        matches,
    }
}
fn admit(response: &mut SearchResponse, item: SearchItem, limit: usize) -> bool {
    if response.items.iter().any(|i| i.path == item.path) {
        return false;
    }
    if response.items.len() == limit {
        response.truncated = true;
        return true;
    }
    response.items.push(item);
    false
}
fn content_filters(query: &str) -> String {
    query
        .split_whitespace()
        .filter(|w| w.contains(':'))
        .collect::<Vec<_>>()
        .join(" ")
}
fn parse_query(query: &str, content: bool) -> Result<fsearch::Query> {
    let home = std::env::var("HOME").unwrap_or_default();
    let input = if content {
        content_filters(query)
    } else {
        query.into()
    };
    fsearch::Query::parse(&input, &home).map_err(|e| SearchError::new("invalidQuery", e))
}
fn query_accepts(query: &fsearch::Query, path: &Path, md: &fs::Metadata) -> bool {
    let kind = if md.is_dir() {
        fsearch::walk::KIND_DIR
    } else {
        fsearch::walk::KIND_FILE
    };
    query
        .match_path(
            path.as_os_str().as_bytes(),
            kind,
            md.len(),
            (mtime_of(md) / 1000.0) as u32,
        )
        .is_some()
}

// Fixed-size reads, one bounded line and three bounded snippets: never read_to_end/read_line.
fn scan_file(
    path: &Path,
    matcher: &LineMatcher,
    cancel: &AtomicBool,
    budget: &Budget,
    start: Instant,
    response: &mut SearchResponse,
) -> Result<Option<(Vec<ContentLine>, usize)>> {
    cancelled(cancel)?;
    if bento_fswatch::is_internal(path) {
        return Ok(None);
    }
    let mut file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(f) => f,
        Err(e) => {
            response.warn("readError", format!("部分文件无法读取: {e}"));
            return Ok(None);
        }
    };
    let md = match file.metadata() {
        Ok(m) => m,
        Err(e) => {
            response.warn("readError", format!("部分文件无法读取: {e}"));
            return Ok(None);
        }
    };
    if !md.is_file() {
        return Ok(None);
    }
    scan_reader(
        &mut file,
        md.len(),
        matcher,
        cancel,
        budget,
        start,
        response,
    )
}
fn scan_reader(
    file: &mut impl Read,
    file_len: u64,
    matcher: &LineMatcher,
    cancel: &AtomicBool,
    budget: &Budget,
    start: Instant,
    response: &mut SearchResponse,
) -> Result<Option<(Vec<ContentLine>, usize)>> {
    if file_len > budget.file_bytes as u64 {
        response.warn("fileBudget", "部分文件超过每文件扫描上限");
    }
    let mut bytes = 0;
    let mut line = Vec::with_capacity(budget.line_bytes.min(8192));
    let mut oversized = false;
    let mut no = 1usize;
    let mut hits = 0;
    let mut lines = vec![];
    let finish = |line: &[u8], no: usize, hits: &mut usize, lines: &mut Vec<ContentLine>| -> bool {
        let Ok(text) = std::str::from_utf8(line) else {
            return false;
        };
        if matcher.is_match(text) {
            *hits = (*hits + 1).min(20);
            if lines.len() < 3 {
                lines.push(ContentLine {
                    no: no as f64,
                    text: text.trim_end_matches('\r').chars().take(200).collect(),
                });
            }
        }
        true
    };
    let mut chunk = [0u8; 8192];
    loop {
        cancelled(cancel)?;
        if start.elapsed() >= budget.duration {
            response.warn("timeBudget", "扫描达到时间预算，结果可能不完整");
            break;
        }
        if bytes >= budget.file_bytes {
            break;
        }
        let n = match file.read(&mut chunk[..8192.min(budget.file_bytes - bytes)]) {
            Ok(n) => n,
            Err(e) => {
                response.warn("readError", format!("部分文件无法读取: {e}"));
                return Ok(None);
            }
        };
        if n == 0 {
            if !oversized && !line.is_empty() && !finish(&line, no, &mut hits, &mut lines) {
                return Ok(None);
            }
            break;
        }
        bytes += n;
        if chunk[..n].contains(&0) {
            return Ok(None);
        }
        for &byte in &chunk[..n] {
            if byte == b'\n' {
                if !oversized && !finish(&line, no, &mut hits, &mut lines) {
                    return Ok(None);
                }
                line.clear();
                oversized = false;
                no += 1;
            } else if !oversized {
                if line.len() == budget.line_bytes {
                    oversized = true;
                    line.clear();
                    response.warn("lineBudget", "部分文本行超过单行扫描上限");
                } else {
                    line.push(byte);
                }
            }
        }
        // A file exactly the budget can end without a newline. Metadata establishes EOF.
        if bytes == budget.file_bytes && file_len <= bytes as u64 {
            if !oversized && !line.is_empty() && !finish(&line, no, &mut hits, &mut lines) {
                return Ok(None);
            }
            break;
        }
    }
    Ok((hits > 0).then_some((lines, hits)))
}
fn local_scan(
    request: &Request,
    root: &Path,
    cancel: &AtomicBool,
    budget: &Budget,
) -> Result<SearchResponse> {
    cancelled(cancel)?;
    let content = request.mode == "content";
    let filters = if content {
        Some(parse_query(&request.query, true)?)
    } else {
        None
    };
    let matcher = build_matcher(&request.query).map_err(|e| SearchError::new("invalidQuery", e))?;
    let line_matcher = LineMatcher::new(&request.query);
    let rd = fs::read_dir(root).map_err(|e| {
        SearchError::new(
            "invalidRoot",
            format!("无法读取目录 {}: {e}", root.display()),
        )
    })?;
    let mut response = SearchResponse::new("local");
    if content && line_matcher.is_none() {
        return Err(SearchError::new("invalidQuery", "请输入内容关键词"));
    }
    let start = Instant::now();
    let mut visited = 0;
    let mut stack = vec![(rd, 0usize)];
    while !stack.is_empty() {
        cancelled(cancel)?;
        if start.elapsed() >= budget.duration {
            response.warn("timeBudget", "扫描达到时间预算，结果可能不完整");
            break;
        }
        if visited >= budget.entries {
            response.warn("entryBudget", "扫描达到条目预算，结果可能不完整");
            break;
        }
        let (rd, depth) = stack.last_mut().unwrap();
        let depth = *depth;
        let next = rd.next();
        let Some(next) = next else {
            stack.pop();
            continue;
        };
        visited += 1;
        let entry = match next {
            Ok(e) => e,
            Err(e) => {
                response.warn("readError", format!("部分目录项无法读取: {e}"));
                continue;
            }
        };
        let path = entry.path();
        if !visible(&path, request.show_hidden) {
            continue;
        }
        let md = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                response.warn("readError", format!("部分目录项无法读取: {e}"));
                continue;
            }
        };
        if (content && md.file_type().is_symlink())
            || (!md.is_file() && !md.is_dir() && !md.file_type().is_symlink())
        {
            continue;
        }
        if format_ok(&path, md.is_dir(), &request.format) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let ext = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if content {
                if md.is_file() && query_accepts(filters.as_ref().unwrap(), &path, &md) {
                    if let Some((lines, hits)) = scan_file(
                        &path,
                        line_matcher.as_ref().unwrap(),
                        cancel,
                        budget,
                        start,
                        &mut response,
                    )? {
                        if admit(
                            &mut response,
                            item(&path, &md, Some(lines), Some(hits)),
                            request.limit,
                        ) {
                            break;
                        }
                    }
                }
            } else if matcher(&name, &ext)
                && admit(&mut response, item(&path, &md, None, None), request.limit)
            {
                break;
            }
        }
        if md.is_dir() {
            if depth >= budget.depth {
                response.warn("depthBudget", "部分目录超过扫描深度上限");
            } else {
                match fs::read_dir(&path) {
                    Ok(rd) => stack.push((rd, depth + 1)),
                    Err(e) => response.warn("readError", format!("部分子目录无法读取: {e}")),
                }
            }
        }
    }
    cancelled(cancel)?;
    Ok(response)
}

const CANDIDATE_BUDGET: usize = 10000;
fn eligible(path: &Path, roots: &[PathBuf], request: &Request) -> bool {
    if !visible(path, request.show_hidden) {
        return false;
    }
    let Ok(real) = fs::canonicalize(path) else {
        return false;
    };
    visible(&real, request.show_hidden)
        && (roots.is_empty()
            || roots
                .iter()
                .any(|root| path.starts_with(root) && real.starts_with(root)))
}
fn apply_format(query: &mut fsearch::Query, format: &str) -> bool {
    if format == "folder" {
        if query
            .kind
            .is_some_and(|kind| kind != fsearch::walk::KIND_DIR)
        {
            return false;
        }
        query.kind = Some(fsearch::walk::KIND_DIR);
    } else if let Some(extensions) = format_extensions(format) {
        if query.exts.is_empty() {
            query.exts = extensions.iter().map(|s| s.as_bytes().to_vec()).collect();
        } else {
            query
                .exts
                .retain(|ext| extensions.iter().any(|s| s.as_bytes() == ext));
            if query.exts.is_empty() {
                return false;
            }
        }
    }
    true
}
fn indexed(
    request: &Request,
    roots: &[PathBuf],
    cancel: &AtomicBool,
    remaining: &mut usize,
    response: &mut SearchResponse,
) -> Result<()> {
    let eng =
        fsearch_engine().ok_or_else(|| SearchError::new("unavailable", "搜索索引引擎无法启动"))?;
    let content = request.mode == "content";
    let original = parse_query(&request.query, content)?;
    let scopes: Vec<Option<&PathBuf>> = if roots.is_empty() {
        vec![None]
    } else {
        roots.iter().map(Some).collect()
    };
    let start = Instant::now();
    let mut source_remaining = if content { *remaining } else { *remaining / 2 };
    for scope in scopes {
        cancelled(cancel)?;
        if start.elapsed() >= Duration::from_secs(2) {
            response.warn("timeBudget", "索引达到本轮时间预算");
            break;
        }
        if *remaining == 0 || source_remaining == 0 {
            response.warn("sourceBudget", "搜索源达到候选预算，结果可能不完整");
            break;
        }
        let mut query = original.clone();
        if !apply_format(&mut query, &request.format) {
            return Ok(());
        }
        if let Some(scope) = scope {
            query.scope = if scope == Path::new("/") {
                None
            } else {
                Some(scope.as_os_str().as_bytes().to_vec())
            };
        }
        // Reserve half of the single request budget for the complementary system source.
        query.limit = (*remaining).min(source_remaining);
        if content {
            let pattern = content_pattern(&request.query);
            if pattern.is_empty() {
                return Err(SearchError::new("invalidQuery", "请输入内容关键词"));
            }
            query.grep = Some(pattern.clone());
            let mut grep = fsearch::Grep::new(&pattern, fsearch::GrepMode::Literal)
                .map_err(|e| SearchError::new("invalidQuery", e))?;
            grep.max_per_file = 20;
            grep.budget = Some(Duration::from_secs(2));
            let (found, _) = eng.grep(&query, &grep).map_err(|e| {
                SearchError::new("unavailable", format!("内容搜索索引尚不可用: {e}"))
            })?;
            cancelled(cancel)?;
            if !found.complete || found.next.is_some() {
                response.warn("sourceBudget", "内容索引尚有未扫描候选项");
            }
            for hit in found.files {
                cancelled(cancel)?;
                if *remaining == 0 {
                    response.warn("sourceBudget", "搜索源达到候选预算，结果可能不完整");
                    break;
                }
                *remaining -= 1;
                source_remaining -= 1;
                let path = PathBuf::from(std::ffi::OsStr::from_bytes(&hit.path));
                if !eligible(&path, roots, request) || !format_ok(&path, false, &request.format) {
                    continue;
                }
                let Ok(md) = fs::metadata(&path) else {
                    response.warn("readError", "部分索引结果已不可读取");
                    continue;
                };
                if !query_accepts(&original, &path, &md) {
                    continue;
                }
                let lines = hit
                    .lines
                    .iter()
                    .take(3)
                    .map(|(no, text)| ContentLine {
                        no: *no as f64,
                        text: text.chars().take(200).collect(),
                    })
                    .collect();
                if admit(
                    response,
                    item(&path, &md, Some(lines), Some(hit.lines.len().min(20))),
                    request.limit,
                ) {
                    return Ok(());
                }
            }
        } else {
            let found = eng
                .search(&query)
                .map_err(|e| SearchError::new("unavailable", format!("名称索引尚不可用: {e}")))?;
            cancelled(cancel)?;
            if found.len() >= query.limit {
                response.warn("sourceBudget", "名称索引达到候选上限");
            }
            for hit in found {
                cancelled(cancel)?;
                if *remaining == 0 {
                    response.warn("sourceBudget", "搜索源达到候选预算，结果可能不完整");
                    break;
                }
                *remaining -= 1;
                source_remaining -= 1;
                let path = hit.path;
                let is_dir = (hit.kind & 0b11) == fsearch::walk::KIND_DIR;
                if !eligible(&path, roots, request) || !format_ok(&path, is_dir, &request.format) {
                    continue;
                }
                let Ok(md) = fs::metadata(&path) else {
                    response.warn("readError", "部分索引结果已不可读取");
                    continue;
                };
                // Keep explicit user filters when the configured scope supplied Query.scope.
                if original.scope.is_some() && !query_accepts(&original, &path, &md) {
                    continue;
                }
                if admit(response, item(&path, &md, None, None), request.limit) {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}
// Kill and reap even on read error/cancellation. No detached subprocess or reader thread.
struct Child(std::process::Child);
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn spotlight(
    request: &Request,
    roots: &[PathBuf],
    cancel: &AtomicBool,
    remaining: &mut usize,
    response: &mut SearchResponse,
) -> Result<()> {
    use std::process::{Command, Stdio};
    let query = parse_query(&request.query, false)?;
    let scopes: Vec<Option<&PathBuf>> = if roots.is_empty() {
        vec![None]
    } else {
        roots.iter().map(Some).collect()
    };
    let start = Instant::now();
    for root in scopes {
        cancelled(cancel)?;
        if *remaining == 0 {
            response.warn("sourceBudget", "系统索引达到共享候选预算");
            break;
        }
        let mut cmd = Command::new("mdfind");
        cmd.arg("-0");
        if let Some(root) = root {
            cmd.arg("-onlyin").arg(root);
        }
        // Spotlight is a candidate source; the parsed query determines accepted matches.
        let hint = request
            .query
            .split_whitespace()
            .find(|word| !word.contains(':') && !word.starts_with('.'));
        if let Some(hint) = hint {
            cmd.arg("-name").arg(hint);
        } else {
            cmd.arg("kMDItemFSName == \"*\"");
        }
        let mut child = Child(
            cmd.stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| SearchError::new("unavailable", format!("系统索引无法启动: {e}")))?,
        );
        let mut stdout = child.0.stdout.take().unwrap();
        use std::os::fd::AsRawFd;
        let fd = stdout.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(SearchError::new("io", "无法读取系统索引输出"));
        }
        let mut chunk = [0u8; 8192];
        let mut path = Vec::new();
        let mut oversized = false;
        loop {
            cancelled(cancel)?;
            if start.elapsed() >= Duration::from_secs(2) {
                response.warn("timeBudget", "系统索引达到时间预算");
                return Ok(());
            }
            let n = match stdout.read(&mut chunk) {
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(e) => return Err(SearchError::new("io", format!("系统索引读取失败: {e}"))),
            };
            if n == 0 {
                let Some(status) = child
                    .0
                    .try_wait()
                    .map_err(|e| SearchError::new("io", e.to_string()))?
                else {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                };
                if !status.success() {
                    return Err(SearchError::new(
                        "unavailable",
                        format!("系统索引失败 ({status})"),
                    ));
                }
                break;
            }
            for &byte in &chunk[..n] {
                if byte == 0 {
                    *remaining = remaining.saturating_sub(1);
                    if !oversized {
                        let p = Path::new(std::ffi::OsStr::from_bytes(&path));
                        if eligible(p, roots, request) {
                            match fs::metadata(p) {
                                Ok(md) => {
                                    if format_ok(p, md.is_dir(), &request.format)
                                        && query_accepts(&query, p, &md)
                                        && admit(response, item(p, &md, None, None), request.limit)
                                    {
                                        return Ok(());
                                    }
                                }
                                Err(_) => response.warn("readError", "部分系统索引结果已不可读取"),
                            }
                        }
                    }
                    path.clear();
                    oversized = false;
                    if *remaining == 0 {
                        response.warn("sourceBudget", "系统索引达到共享候选预算");
                        return Ok(());
                    }
                } else if path.len() < 16384 && !oversized {
                    path.push(byte);
                } else {
                    oversized = true;
                    path.clear();
                    response.warn("pathBudget", "系统索引包含过长路径，已略过");
                }
            }
        }
    }
    Ok(())
}
fn global_search(request: &Request, cancel: &AtomicBool) -> Result<SearchResponse> {
    let roots = request
        .roots
        .iter()
        .map(|root| directory(root))
        .collect::<Result<Vec<_>>>()?;
    let mut response = SearchResponse::new("fsearch");
    response.warn("indexCoverage", "索引覆盖范围有限，结果可能不完整");
    let mut remaining = CANDIDATE_BUDGET;
    let primary = indexed(request, &roots, cancel, &mut remaining, &mut response);
    if let Err(error) = &primary {
        if error.code == "cancelled" {
            return primary.map(|_| response);
        }
        response.warn("engineUnavailable", error.message.clone());
    }
    if request.mode == "content" {
        if response.items.is_empty() {
            primary?;
        }
        return Ok(response);
    }
    if !response.truncated {
        match spotlight(request, &roots, cancel, &mut remaining, &mut response) {
            Ok(()) => {
                response.source = if primary.is_ok() {
                    "fsearch+spotlight"
                } else {
                    "spotlight"
                }
                .into()
            }
            Err(error) => {
                if error.code == "cancelled" {
                    return Err(error);
                }
                if primary.is_err() && response.items.is_empty() {
                    return Err(SearchError::new(
                        "unavailable",
                        format!("{}；{}", primary.unwrap_err().message, error.message),
                    ));
                }
                response.warn("systemUnavailable", error.message);
            }
        }
    }
    cancelled(cancel)?;
    Ok(response)
}

#[derive(Default)]
struct Registry {
    active: HashMap<String, Arc<AtomicBool>>,
    cancelled: VecDeque<String>,
}
fn registry() -> &'static Mutex<Registry> {
    static REG: OnceLock<Mutex<Registry>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(Registry::default()))
}
fn valid_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Err(SearchError::new("invalidRequest", "无效搜索请求标识"))
    } else {
        Ok(())
    }
}
struct Active {
    id: String,
    cancel: Arc<AtomicBool>,
}
impl Active {
    fn new(id: String) -> Result<Self> {
        valid_id(&id)?;
        let mut r = registry().lock().unwrap_or_else(|e| e.into_inner());
        if r.active.len() >= 8 || r.active.contains_key(&id) {
            return Err(SearchError::new("busy", "搜索请求过多，请稍后重试"));
        }
        let cancel = Arc::new(AtomicBool::new(r.cancelled.contains(&id)));
        r.active.insert(id.clone(), cancel.clone());
        Ok(Self { id, cancel })
    }
}
impl Drop for Active {
    fn drop(&mut self) {
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active
            .remove(&self.id);
    }
}
#[derive(Default)]
struct Gate {
    running: bool,
    pending: Option<(String, Arc<AtomicBool>)>,
}
fn gate() -> &'static (Mutex<Gate>, Condvar) {
    static GATE: OnceLock<(Mutex<Gate>, Condvar)> = OnceLock::new();
    GATE.get_or_init(|| (Mutex::new(Gate::default()), Condvar::new()))
}
struct GlobalSlot;
impl GlobalSlot {
    fn acquire(active: &Active) -> Result<Self> {
        let (lock, wake) = gate();
        let mut g = lock.lock().unwrap_or_else(|e| e.into_inner());
        cancelled(&active.cancel)?;
        if g.running || g.pending.is_some() {
            if let Some((_, old)) = g
                .pending
                .replace((active.id.clone(), active.cancel.clone()))
            {
                old.store(true, Ordering::Relaxed);
            }
            wake.notify_all();
            while g.running {
                if active.cancel.load(Ordering::Relaxed) {
                    if g.pending.as_ref().is_some_and(|(id, _)| id == &active.id) {
                        g.pending = None;
                    }
                    return Err(SearchError::new("cancelled", "搜索已被更新的请求取代"));
                }
                g = wake
                    .wait_timeout(g, Duration::from_millis(25))
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
            cancelled(&active.cancel)?;
            g.pending = None;
        }
        g.running = true;
        Ok(Self)
    }
}
impl Drop for GlobalSlot {
    fn drop(&mut self) {
        let (lock, wake) = gate();
        lock.lock().unwrap_or_else(|e| e.into_inner()).running = false;
        wake.notify_all();
    }
}
#[tauri::command]
pub fn cancel_search(request_id: String) -> Result<()> {
    valid_id(&request_id)?;
    let mut r = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cancel) = r.active.get(&request_id) {
        cancel.store(true, Ordering::Relaxed);
    }
    if !r.cancelled.contains(&request_id) {
        r.cancelled.push_back(request_id);
        if r.cancelled.len() > 128 {
            r.cancelled.pop_front();
        }
    }
    gate().1.notify_all();
    Ok(())
}
fn local_root(request: &Request, home: &str) -> Result<PathBuf> {
    let raw = if request.scope == "home" {
        home
    } else {
        request
            .root
            .as_deref()
            .ok_or_else(|| SearchError::new("invalidRoot", "当前文件夹搜索需要目录路径"))?
    };
    directory(raw)
}
#[tauri::command]
pub async fn search_query(
    query: String,
    scope: String,
    root: Option<String>,
    show_hidden: bool,
    limit: Option<usize>,
    roots: Option<Vec<String>>,
    mode: Option<String>,
    request_id: String,
    format: Option<String>,
) -> Result<SearchResponse> {
    let active = Active::new(request_id)?;
    let request = Request {
        query: query.trim().into(),
        scope,
        root,
        show_hidden,
        roots: roots.unwrap_or_default(),
        mode: mode.unwrap_or_else(|| "name".into()),
        format: format.unwrap_or_else(|| "all".into()),
        limit: limit.unwrap_or(200).clamp(1, 1000),
    };
    tauri::async_runtime::spawn_blocking(move || {
        cancelled(&active.cancel)?;
        if !["pane", "home", "global"].contains(&request.scope.as_str())
            || !["name", "content"].contains(&request.mode.as_str())
            || ![
                "all",
                "folder",
                "image",
                "document",
                "spreadsheet",
                "presentation",
                "video",
                "archive",
            ]
            .contains(&request.format.as_str())
            || request.roots.len() > 64
            || request.query.len() > 16384
        {
            return Err(SearchError::new("invalidRequest", "无效搜索参数"));
        }
        if request.scope == "global" || request.mode == "content" {
            parse_query(&request.query, request.mode == "content")?;
        } else {
            // Local names use the existing literal/glob grammar, including literal brackets.
            let _ =
                build_matcher(&request.query).map_err(|e| SearchError::new("invalidQuery", e))?;
        }
        if request.query.is_empty() {
            return Ok(SearchResponse::new(if request.scope == "global" {
                "fsearch"
            } else {
                "local"
            }));
        }
        if request.scope == "global" {
            let _slot = GlobalSlot::acquire(&active)?;
            global_search(&request, &active.cancel)
        } else {
            let root = local_root(&request, &std::env::var("HOME").unwrap_or_default())?;
            local_scan(&request, &root, &active.cancel, &Budget::default())
        }
    })
    .await
    .map_err(|e| SearchError::new("io", e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    static NEXT: AtomicU64 = AtomicU64::new(1);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "bento-search-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn file(&self, name: &str, data: impl AsRef<[u8]>) -> PathBuf {
            let p = self.0.join(name);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, data).unwrap();
            p
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn req() -> Request {
        Request {
            query: "needle".into(),
            scope: "pane".into(),
            root: None,
            roots: vec![],
            show_hidden: false,
            mode: "content".into(),
            format: "all".into(),
            limit: 200,
        }
    }
    fn run(f: &Fixture, r: &Request, b: &Budget) -> SearchResponse {
        local_scan(r, &f.0, &AtomicBool::new(false), b).unwrap()
    }
    #[test]
    fn current_content_finds_unindexed_files_and_honors_smart_case() {
        let f = Fixture::new();
        f.file("fresh.txt", "NEEDLE\nneedle\n");
        let r = run(&f, &req(), &Budget::default());
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].matches, Some(2));
        assert!(!r.incomplete);
        let mut q = req();
        q.query = "Needle".into();
        assert!(run(&f, &q, &Budget::default()).items.is_empty());
    }
    #[test]
    fn visibility_internal_symlinks_and_format_before_limit() {
        let f = Fixture::new();
        f.file(".hidden/secret.txt", "needle");
        let private = f
            .file(".owned/secret.txt", "needle")
            .parent()
            .unwrap()
            .to_path_buf();
        bento_fswatch::register_internal(&private).unwrap();
        f.file(".owned-user/ok.txt", "needle");
        f.file("wrong.png", "needle");
        f.file("right.txt", "needle");
        std::os::unix::fs::symlink(&private, f.0.join("alias")).unwrap();
        std::os::unix::fs::symlink(private.join("secret.txt"), f.0.join("alias.txt")).unwrap();
        let mut q = req();
        q.format = "document".into();
        q.limit = 1;
        let r = run(&f, &q, &Budget::default());
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].name, "right.txt");
        assert!(!r.truncated);
        q.show_hidden = true;
        let r = run(&f, &q, &Budget::default());
        assert_eq!(r.items.len(), 1);
        assert!(r.truncated);
        assert!(r.items.iter().all(|i| !i.path.contains("/.owned/")));
        bento_fswatch::unregister_internal(&private);
    }
    #[test]
    fn budgets_report_partial_without_giant_allocations() {
        let f = Fixture::new();
        f.file("huge.txt", vec![b'x'; 1024]);
        f.file("binary.txt", b"needle\0bad");
        f.file("good.txt", b"needle\n");
        let mut b = Budget::default();
        b.line_bytes = 16;
        let r = run(&f, &req(), &b);
        assert!(r.incomplete);
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].name, "good.txt");
        b.file_bytes = 4;
        assert!(run(&f, &req(), &b).incomplete);
        b.entries = 0;
        assert!(run(&f, &req(), &b).incomplete);
        b.duration = Duration::ZERO;
        assert!(run(&f, &req(), &b).incomplete);
    }
    #[test]
    fn invalid_root_regex_and_cancel_are_errors() {
        let f = Fixture::new();
        let mut r = req();
        let no = f.0.join("missing");
        assert!(local_scan(&r, &no, &AtomicBool::new(false), &Budget::default()).is_err());
        r.query = "needle re:[".into();
        assert!(local_scan(&r, &f.0, &AtomicBool::new(false), &Budget::default()).is_err());
        r.query = "needle".into();
        let err = local_scan(&r, &f.0, &AtomicBool::new(true), &Budget::default())
            .err()
            .unwrap();
        assert_eq!(err.code, "cancelled");
    }
    #[test]
    fn depth_budget_and_snippet_cap() {
        let f = Fixture::new();
        f.file("deep/a.txt", "needle");
        f.file("many.txt", "needle\n".repeat(30));
        let mut b = Budget::default();
        b.depth = 0;
        let r = run(&f, &req(), &b);
        assert!(r.incomplete);
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].lines.as_ref().unwrap().len(), 3);
        assert_eq!(r.items[0].matches, Some(20));
    }
    #[test]
    fn fifo_is_not_opened() {
        let f = Fixture::new();
        let p = std::ffi::CString::new(f.0.join("pipe").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(p.as_ptr(), 0o600) }, 0);
        assert!(run(&f, &req(), &Budget::default()).items.is_empty());
    }
    #[test]
    fn component_boundaries_spaces_and_global_admission_before_cap() {
        let f = Fixture::new();
        let inside = f.file("report /hit.txt", "needle");
        let outside = f.file("report -archive/hit.txt", "needle");
        let wrong = f.file("report /wrong.png", "needle");
        let root = directory(f.0.join("report ").to_str().unwrap()).unwrap();
        assert!(root.ends_with("report "));
        let inside = fs::canonicalize(inside).unwrap();
        let outside = fs::canonicalize(outside).unwrap();
        let wrong = fs::canonicalize(wrong).unwrap();
        let mut q = req();
        q.format = "document".into();
        q.limit = 1;
        let roots = vec![root];
        let mut out = SearchResponse::new("fsearch");
        for p in [outside, wrong, inside.clone()] {
            if eligible(&p, &roots, &q) && format_ok(&p, false, &q.format) {
                assert!(!admit(
                    &mut out,
                    item(&p, &fs::metadata(&p).unwrap(), None, None),
                    q.limit
                ));
            }
        }
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].path, inside.to_string_lossy());
        assert!(!out.truncated);
    }
    #[test]
    fn child_permission_is_partial_and_root_permission_is_error() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        f.file("good.txt", "needle");
        let locked = f
            .file("locked/secret.txt", "needle")
            .parent()
            .unwrap()
            .to_path_buf();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0)).unwrap();
        let child = local_scan(&req(), &f.0, &AtomicBool::new(false), &Budget::default());
        let root = local_scan(&req(), &locked, &AtomicBool::new(false), &Budget::default());
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            root.is_err(),
            "fixture must run as ordinary user to exercise real permission denial"
        );
        let child = child.unwrap();
        assert_eq!(child.items.len(), 1);
        assert!(child.incomplete);
        assert!(child.warnings.iter().any(|w| w.code == "readError"));
    }
    #[test]
    fn command_pane_content_ignores_global_roots_preserves_spaces_and_wire() {
        let f = Fixture::new();
        let file = f.file(" spaced /hit.txt", "needle");
        let root = file.parent().unwrap().to_string_lossy().into_owned();
        let r = tauri::async_runtime::block_on(search_query(
            "needle".into(),
            "pane".into(),
            Some(root),
            false,
            Some(1),
            Some(vec!["/does-not-exist".into()]),
            Some("content".into()),
            "command_pane".into(),
            Some("document".into()),
        ))
        .unwrap();
        assert_eq!(r.items.len(), 1);
        let json = serde_json::to_value(r).unwrap();
        assert_eq!(json["source"], "local");
        assert_eq!(json["incomplete"], false);
        assert_eq!(json["truncated"], false);
        assert!(json["items"][0].get("is_dir").is_some());
        let missing = tauri::async_runtime::block_on(search_query(
            "needle".into(),
            "pane".into(),
            None,
            false,
            None,
            None,
            None,
            "missing_pane".into(),
            None,
        ));
        assert_eq!(missing.err().unwrap().code, "invalidRoot");
    }
    #[test]
    fn names_keep_glob_ext_regex_multiword_and_do_not_read_contents() {
        let f = Fixture::new();
        f.file("report 2026.txt", b"\0binary");
        f.file("report 2025.png", b"x");
        let mut q = req();
        q.mode = "name".into();
        for text in ["report 2026", "*2026* ext:txt", "re:^report ext:txt"] {
            q.query = text.into();
            let r = run(&f, &q, &Budget::default());
            assert_eq!(r.items.len(), 1, "{text}");
            assert_eq!(r.items[0].name, "report 2026.txt");
        }
    }
    #[test]
    fn command_local_names_preserve_literal_brackets_and_reject_invalid_regex() {
        let fixture = Fixture::new();
        fixture.file("report [2026-11-01].txt", "fixture");
        fixture.file("report 2026-11-01.txt", "decoy");
        let root = fixture.0.to_string_lossy().into_owned();
        let search = |query: &str, request_id: &str| {
            tauri::async_runtime::block_on(search_query(
                query.into(),
                "pane".into(),
                Some(root.clone()),
                false,
                None,
                None,
                Some("name".into()),
                request_id.into(),
                None,
            ))
        };

        for (query, request_id) in [
            ("report [2026-11-01]", "literal_bracket_name"),
            ("*[2026-11-01]*", "glob_literal_bracket_name"),
        ] {
            let response = search(query, request_id).unwrap();
            assert_eq!(response.items.len(), 1, "{query}");
            assert_eq!(response.items[0].name, "report [2026-11-01].txt");
            assert!(!response.incomplete);
        }
        assert_eq!(
            search("re:[", "invalid_local_name_regex")
                .err()
                .unwrap()
                .code,
            "invalidQuery"
        );
    }

    #[test]
    fn cancellation_before_admission_is_honored_and_ids_are_bounded() {
        cancel_search("cancel_before".into()).unwrap();
        let active = Active::new("cancel_before".into()).unwrap();
        assert_eq!(cancelled(&active.cancel).unwrap_err().code, "cancelled");
        assert!(valid_id("").is_err());
        assert!(valid_id("has space").is_err());
        assert!(valid_id(&"x".repeat(97)).is_err());
        assert!(valid_id("ascii_123-X").is_ok());
        for i in 0..150 {
            cancel_search(format!("finished_{i}")).unwrap();
        }
        assert!(registry().lock().unwrap().cancelled.len() <= 128);
    }
    #[test]
    fn global_slot_coalesces_latest_without_parallel_execution() {
        let first = Active::new("gate_first".into()).unwrap();
        let held = GlobalSlot::acquire(&first).unwrap();
        let spawn = |id: &str| {
            let active = Active::new(id.into()).unwrap();
            let flag = active.cancel.clone();
            let t = std::thread::spawn(move || {
                let slot = GlobalSlot::acquire(&active);
                slot.map(|_| ()).map_err(|e| e.code)
            });
            (t, flag)
        };
        let wait_pending = |id: &str| {
            let (lock, cv) = gate();
            let guard = lock.lock().unwrap();
            let result = cv
                .wait_timeout_while(guard, Duration::from_secs(2), |g| {
                    !g.pending.as_ref().is_some_and(|(v, _)| v == id)
                })
                .unwrap();
            assert!(!result.1.timed_out());
        };
        let (old, old_flag) = spawn("gate_old");
        wait_pending("gate_old");
        let (latest, latest_flag) = spawn("gate_latest");
        wait_pending("gate_latest");
        assert!(old_flag.load(Ordering::Relaxed));
        assert!(!latest_flag.load(Ordering::Relaxed));
        drop(held);
        assert_eq!(old.join().unwrap(), Err("cancelled"));
        assert_eq!(latest.join().unwrap(), Ok(()));
        assert!(!gate().0.lock().unwrap().running);
    }
    #[test]
    fn cancellation_stops_file_io_at_next_fixed_chunk() {
        struct Reader<'a> {
            file: fs::File,
            cancel: &'a AtomicBool,
            reads: usize,
        }
        impl Read for Reader<'_> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.reads += 1;
                let n = self.file.read(buf)?;
                self.cancel.store(true, Ordering::Relaxed);
                Ok(n)
            }
        }
        let f = Fixture::new();
        let p = f.file("many.txt", "needle\n".repeat(5000));
        let flag = AtomicBool::new(false);
        let mut reader = Reader {
            file: fs::File::open(p).unwrap(),
            cancel: &flag,
            reads: 0,
        };
        let result = scan_reader(
            &mut reader,
            35000,
            &LineMatcher::new("needle").unwrap(),
            &flag,
            &Budget::default(),
            Instant::now(),
            &mut SearchResponse::new("local"),
        );
        assert_eq!(result.err().unwrap().code, "cancelled");
        assert_eq!(reader.reads, 1);
    }
    #[test]
    fn home_scope_uses_home_and_ignores_pane_and_configured_roots() {
        let f = Fixture::new();
        let mut q = req();
        q.scope = "home".into();
        q.root = Some("/missing-pane".into());
        q.roots = vec!["/missing-configured-root".into()];
        assert_eq!(
            local_root(&q, f.0.to_str().unwrap()).unwrap(),
            fs::canonicalize(&f.0).unwrap()
        );
    }
    #[test]
    fn protected_alias_preview_is_rejected_and_ordinary_prefix_is_allowed() {
        let f = Fixture::new();
        let private = f
            .file("protected/a.txt", "needle")
            .parent()
            .unwrap()
            .to_path_buf();
        bento_fswatch::register_internal(&private).unwrap();
        let alias = f.0.join("alias.txt");
        std::os::unix::fs::symlink(private.join("a.txt"), &alias).unwrap();
        let ordinary = f.file("protected-user/a.txt", "needle");
        let private_result = super::super::preview_file(alias.to_str().unwrap(), "needle", None);
        let ordinary_result =
            super::super::preview_file(ordinary.to_str().unwrap(), "needle", None);
        bento_fswatch::unregister_internal(&private);
        assert!(private_result.is_err());
        assert_eq!(ordinary_result.unwrap().match_lines, vec![1.0]);
    }
    #[test]
    fn source_format_intersects_user_extension_filter() {
        let mut q = parse_query("report ext:png", false).unwrap();
        assert!(!apply_format(&mut q, "document"));
        let mut q = parse_query("report ext:txt", false).unwrap();
        assert!(apply_format(&mut q, "document"));
        assert_eq!(q.exts, vec![b"txt".to_vec()]);
    }
}
