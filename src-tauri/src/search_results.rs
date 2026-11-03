//! Typed, bounded search execution. All scopes share visibility and result admission.
use super::{
    btime_of, build_matcher, content_pattern, fsearch_engine, mtime_of, ContentLine, LineMatcher,
    SearchItem,
};
use serde::Serialize;
use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};
use std::{
    collections::{HashMap, HashSet, VecDeque},
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
#[derive(Clone)]
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
    show_hidden || !hidden(path)
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
    if !root.is_dir() {
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
struct NameLiteral {
    pattern: regex::bytes::Regex,
    negate: bool,
}
struct ParsedQuery {
    engine: fsearch::Query,
    alternate: Option<fsearch::Query>,
    limited_names: bool,
    literals: Vec<NameLiteral>,
    spotlight_terms: Vec<String>,
}
impl ParsedQuery {
    fn engines(&self) -> impl Iterator<Item = &fsearch::Query> {
        std::iter::once(&self.engine).chain(self.alternate.iter())
    }
    fn warn_coverage(&self, response: &mut SearchResponse) {
        if self.limited_names {
            response.warn(
                "queryCoverage",
                "部分名称条件受索引语法限制，候选上限可能导致遗漏",
            );
        }
    }
    fn literal_names_accept(&self, path: &Path) -> bool {
        let name = path.file_name().unwrap_or_default().as_bytes();
        self.literals
            .iter()
            .all(|literal| literal.pattern.is_match(name) != literal.negate)
    }
}
// Match the locked parser's space/quoted-word boundaries; filters retain their original text.
fn query_words(query: &str) -> Vec<String> {
    let (mut words, mut word, mut quoted) = (vec![], String::new(), false);
    for ch in query.chars() {
        match ch {
            '"' => quoted = !quoted,
            ' ' if !quoted => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            }
            _ => word.push(ch),
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}
// macOS stores canonically equivalent names in both NFC and NFD. Keep the
// two source forms bounded; explicit regex/path/filter text is never rewritten.
fn name_forms(name: &str) -> [String; 2] {
    #[cfg(target_os = "macos")]
    if !name.is_ascii() {
        let text = objc2_foundation::NSString::from_str(name);
        return [
            text.precomposedStringWithCanonicalMapping().to_string(),
            text.decomposedStringWithCanonicalMapping().to_string(),
        ];
    }
    [name.into(), name.into()]
}
fn unicode_case(name: &str) -> bool {
    name.chars()
        .any(|ch| !ch.is_ascii() && ch.to_lowercase().ne(ch.to_uppercase()))
}
fn name_pattern(forms: &[String; 2], glob: bool, path: bool) -> String {
    let mut alternatives = vec![];
    for name in forms {
        let body = if glob {
            name.chars()
                .map(|ch| match ch {
                    '*' => {
                        if path {
                            "[^/]*".into()
                        } else {
                            ".*".into()
                        }
                    }
                    '?' => {
                        if path {
                            "[^/]".into()
                        } else {
                            ".".into()
                        }
                    }
                    _ => regex::escape(&ch.to_string()),
                })
                .collect::<String>()
        } else {
            regex::escape(name)
        };
        if !alternatives.contains(&body) {
            alternatives.push(body);
        }
    }
    let body = format!("(?:{})", alternatives.join("|"));
    if path {
        if glob {
            format!("(?:^|/){body}$")
        } else {
            format!("(?:^|/)[^/]*{body}[^/]*$")
        }
    } else if glob {
        format!("^{body}$")
    } else {
        body
    }
}
fn parse_query(query: &str, content: bool) -> Result<ParsedQuery> {
    let home = std::env::var("HOME").unwrap_or_default();
    let invalid = |e| SearchError::new("invalidQuery", e);
    if content {
        return Ok(ParsedQuery {
            engine: fsearch::Query::parse(&content_filters(query), &home).map_err(invalid)?,
            alternate: None,
            limited_names: false,
            literals: vec![],
            spotlight_terms: vec![],
        });
    }
    let compile = |pattern: &str| {
        regex::bytes::RegexBuilder::new(pattern)
            .case_insensitive(true)
            .dot_matches_new_line(true)
            .build()
            .map_err(|e| invalid(e.to_string()))
    };
    let mut filters = fsearch::Query::parse("", &home).map_err(invalid)?;
    let mut candidates = [vec![], vec![]];
    let mut exact = [vec![], vec![]];
    let mut literals = vec![];
    let mut spotlight_terms = vec![];
    let mut source_patterns = vec![];
    for word in query_words(query) {
        let filter = if let Some((key, value)) = word.split_once(':') {
            filters.filter(key, value, &home).map_err(invalid)?
        } else {
            false
        };
        let (negate, name) = word
            .strip_prefix('!')
            .map_or((false, word.as_str()), |s| (true, s));
        // Explicit grammar stays with the locked parser.
        if filter
            || name.contains('/')
            || name.contains(['{', '}'])
            || name.starts_with(['\'', '^'])
            || name.ends_with('$')
            || name.is_empty()
        {
            for form in &mut candidates {
                form.push(word.clone());
            }
            continue;
        }
        let forms = name_forms(name);
        let glob = name.contains(['*', '?']);
        let pattern = compile(&name_pattern(&forms, glob, false))?;
        let adapted = name.contains(['[', ']']) || (!name.is_ascii() && name.contains('?'));
        let case = unicode_case(name);
        let normalization = forms[0] != forms[1];
        if !negate && (adapted || case || normalization) {
            source_patterns.push((pattern.clone(), compile(&name_pattern(&forms, glob, true))?));
        }
        literals.push(NameLiteral { pattern, negate });
        if !negate && !glob {
            spotlight_terms.push(forms[0].clone());
        }
        for (i, form) in forms.iter().enumerate() {
            if adapted || (!negate && (case || normalization)) {
                if !negate {
                    // Star-only globs avoid the upstream UTF-8 ?/[ parser. Broaden
                    // cased Unicode characters too: its literal globs only fold ASCII.
                    let broad: String = form
                        .chars()
                        .map(|ch| {
                            if matches!(ch, '[' | ']')
                                || (!form.is_ascii() && ch == '?')
                                || (!ch.is_ascii()
                                    && (normalization || ch.to_lowercase().ne(ch.to_uppercase())))
                            {
                                '*'
                            } else {
                                ch
                            }
                        })
                        .collect();
                    candidates[i].push(if glob { broad } else { format!("*{broad}*") });
                    // Exact tokens bypass bracket parsing and reject literal decoys
                    // before top-k even when both native regex slots are occupied.
                    // They can inherit ancestors, so unsupported conjunctions warn.
                    for run in form
                        .split(['*', '?'])
                        .filter(|run| run.contains(['[', ']']))
                    {
                        if !unicode_case(run) {
                            exact[i].push((source_patterns.len() - 1, format!("'{run}")));
                        }
                    }
                }
            } else if negate || glob {
                candidates[i].push(if negate {
                    format!("!{form}")
                } else {
                    form.clone()
                });
            } else {
                // Every ordinary term is required in the basename before top-k.
                candidates[i].push(format!("*{form}*"));
            }
        }
    }
    let inputs = candidates.map(|words| {
        words
            .into_iter()
            .map(|word| format!("\"{word}\""))
            .collect::<Vec<_>>()
            .join(" ")
    });
    let mut engines = vec![];
    let mut limited_names = false;
    for i in 0..2 {
        if i == 1 && inputs[0] == inputs[1] && exact[0] == exact[1] {
            break;
        }
        let mut engine = fsearch::Query::parse(&inputs[i], &home).map_err(invalid)?;
        let mut assigned = 0;
        for (name, path) in &source_patterns {
            if engine.name_re.is_none() {
                engine.name_re = Some(name.clone());
            } else if engine.path_re.is_none() {
                engine.path_re = Some(path.clone());
            } else {
                break;
            }
            assigned += 1;
        }
        for (pattern, token) in &exact[i] {
            // Native basename regexes already enforce these conditions. The locked
            // parser evicts its first positive token beyond eight: an internal
            // fallback guard must never replace an explicit user constraint.
            if *pattern < assigned
                || engine.tokens.iter().filter(|t| !t.negate).count() >= 8
                || engine
                    .alt
                    .as_ref()
                    .is_some_and(|alt| alt.iter().filter(|t| !t.negate).count() >= 8)
            {
                continue;
            }
            engine.push_token(token);
            // Query.alt replaces only tokens; retain appended fallback guards too.
            if let Some(alt) = &mut engine.alt {
                let mut other = fsearch::Query::default();
                other.tokens = std::mem::take(alt);
                other.push_token(token);
                *alt = other.tokens;
            }
        }
        limited_names |= assigned < source_patterns.len();
        engines.push(engine);
    }
    let engine = engines.remove(0);
    Ok(ParsedQuery {
        engine,
        alternate: engines.pop(),
        limited_names,
        literals,
        spotlight_terms,
    })
}

fn query_accepts(query: &ParsedQuery, path: &Path, md: &fs::Metadata) -> bool {
    if !query.literal_names_accept(path) {
        return false;
    }
    let kind = if md.is_dir() {
        fsearch::walk::KIND_DIR
    } else {
        fsearch::walk::KIND_FILE
    };
    query.engines().any(|engine| {
        engine
            .match_path(
                path.as_os_str().as_bytes(),
                kind,
                md.len(),
                (mtime_of(md) / 1000.0) as u32,
            )
            .is_some()
    })
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

// One persistent worker contains opaque upstream calls. There is no pending
// request queue: while busy, newer searches use the complementary system source.
struct IndexWorker {
    sender: std::sync::mpsc::SyncSender<Box<dyn FnOnce() + Send>>,
    busy: Arc<AtomicBool>,
}
impl Default for IndexWorker {
    fn default() -> Self {
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Box<dyn FnOnce() + Send>>(1);
        let busy = Arc::new(AtomicBool::new(false));
        let running = busy.clone();
        let _ = std::thread::Builder::new()
            .name("bento-name-index".into())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                    running.store(false, Ordering::Release);
                }
            });
        Self { sender, busy }
    }
}
impl IndexWorker {
    fn run<T: Send + 'static>(
        &self,
        cancel: &AtomicBool,
        deadline: Duration,
        job: impl FnOnce(Arc<AtomicBool>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        use std::sync::mpsc::{RecvTimeoutError, TrySendError};
        cancelled(cancel)?;
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(SearchError::new(
                "indexBusy",
                "名称索引仍在处理上次查询，已使用其他搜索源",
            ));
        }
        let start = Instant::now();
        let job_cancel = Arc::new(AtomicBool::new(false));
        let stop = job_cancel.clone();
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let task = Box::new(move || {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            let result = job(stop.clone());
            // A deadline/cancelled request never publishes late output.
            if !stop.load(Ordering::Relaxed) {
                let _ = send.send(result);
            }
        });
        if let Err(error) = self.sender.try_send(task) {
            self.busy.store(false, Ordering::Release);
            return Err(SearchError::new(
                "unavailable",
                match error {
                    TrySendError::Full(_) => "索引工作通道繁忙",
                    TrySendError::Disconnected(_) => "索引工作通道不可用",
                },
            ));
        }
        loop {
            if let Err(error) = cancelled(cancel) {
                job_cancel.store(true, Ordering::Relaxed);
                return Err(error);
            }
            let Some(left) = deadline.checked_sub(start.elapsed()) else {
                job_cancel.store(true, Ordering::Relaxed);
                return Err(SearchError::new(
                    "indexTimeout",
                    "索引查询达到时间预算，已使用其他搜索源",
                ));
            };
            match receive.recv_timeout(left.min(Duration::from_millis(10))) {
                Ok(result) => {
                    cancelled(cancel)?;
                    if start.elapsed() >= deadline {
                        job_cancel.store(true, Ordering::Relaxed);
                        return Err(SearchError::new(
                            "indexTimeout",
                            "索引查询达到时间预算，已使用其他搜索源",
                        ));
                    }
                    return result;
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(SearchError::new("unavailable", "索引查询工作通道已关闭"))
                }
            }
        }
    }
}
fn index_worker() -> &'static IndexWorker {
    static WORKER: OnceLock<IndexWorker> = OnceLock::new();
    WORKER.get_or_init(IndexWorker::default)
}
struct IndexReply {
    response: SearchResponse,
    remaining: usize,
    result: Result<()>,
}
fn merge_index_reply(
    reply: IndexReply,
    response: &mut SearchResponse,
    remaining: &mut usize,
    limit: usize,
) -> Result<()> {
    *remaining += reply.remaining;
    response.truncated |= reply.response.truncated;
    response.incomplete |= reply.response.incomplete;
    for warning in reply.response.warnings {
        response.warn(warning.code, warning.message);
    }
    for hit in reply.response.items {
        if admit(response, hit, limit) {
            break;
        }
    }
    reply.result
}
fn reserved_indexed(
    worker: &IndexWorker,
    request: &Request,
    cancel: &AtomicBool,
    remaining: &mut usize,
    response: &mut SearchResponse,
    deadline: Duration,
    job: impl FnOnce(usize, Arc<AtomicBool>) -> Result<IndexReply> + Send + 'static,
) -> Result<()> {
    let reserved = if request.mode == "content" {
        *remaining
    } else {
        *remaining / 2
    };
    *remaining -= reserved;
    match worker.run(cancel, deadline, move |stop| job(reserved, stop)) {
        Ok(reply) => merge_index_reply(reply, response, remaining, request.limit),
        Err(error) => {
            // Busy did not enqueue an operation for this request. A timed-out
            // opaque call keeps its reservation until the request is discarded.
            if error.code == "indexBusy" {
                *remaining += reserved;
            }
            Err(error)
        }
    }
}
fn bounded_indexed(
    request: &Request,
    roots: &[PathBuf],
    cancel: &AtomicBool,
    remaining: &mut usize,
    response: &mut SearchResponse,
) -> Result<()> {
    let owned = request.clone();
    let roots = roots.to_vec();
    reserved_indexed(
        index_worker(),
        request,
        cancel,
        remaining,
        response,
        Duration::from_secs(2),
        move |reserved, stop| {
            let mut response = SearchResponse::new("fsearch");
            let mut remaining = reserved;
            let result = indexed(&owned, &roots, &stop, &mut remaining, &mut response);
            Ok(IndexReply {
                response,
                remaining,
                result,
            })
        },
    )
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
    let mut source_remaining = *remaining;
    original.warn_coverage(response);
    let plans: Vec<_> = scopes
        .into_iter()
        .flat_map(|scope| original.engines().map(move |engine| (scope, engine)))
        .collect();
    let mut seen = HashSet::new();
    for (scope, engine) in plans {
        cancelled(cancel)?;
        if start.elapsed() >= Duration::from_secs(2) {
            response.warn("timeBudget", "索引达到本轮时间预算");
            break;
        }
        if *remaining == 0 || source_remaining == 0 {
            response.warn("sourceBudget", "搜索源达到候选预算，结果可能不完整");
            break;
        }
        let mut query = engine.clone();
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
        // The bounded worker owns only this request's reserved source budget.
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
            super::FSEARCH_READY.store(true, Ordering::Relaxed);
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
            super::FSEARCH_READY.store(true, Ordering::Relaxed);
            cancelled(cancel)?;
            if found.len() >= query.limit {
                response.warn("sourceBudget", "名称索引达到候选上限");
            }
            for hit in found {
                cancelled(cancel)?;
                if !seen.insert(hit.path.clone()) {
                    continue;
                }
                if *remaining == 0 {
                    response.warn("sourceBudget", "搜索源达到候选预算，结果可能不完整");
                    break;
                }
                *remaining -= 1;
                source_remaining -= 1;
                let path = hit.path;
                let is_dir = (hit.kind & 0b11) == fsearch::walk::KIND_DIR;
                if !eligible(&path, roots, request)
                    || !original.literal_names_accept(&path)
                    || !format_ok(&path, is_dir, &request.format)
                {
                    continue;
                }
                let Ok(md) = fs::metadata(&path) else {
                    response.warn("readError", "部分索引结果已不可读取");
                    continue;
                };
                // Keep explicit user filters when the configured scope supplied Query.scope.
                if original.engine.scope.is_some() && !query_accepts(&original, &path, &md) {
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
// Only positive ordinary filename substrings can safely narrow this filename source.
// Explicit path/regex/glob queries retain a broad fallback and full admission below.
fn spotlight_predicate(query: &ParsedQuery) -> String {
    let terms: Vec<_> = query
        .spotlight_terms
        .iter()
        .filter_map(|term| {
            // Control characters have no portable metadata-query literal spelling.
            if term.chars().any(char::is_control) {
                return None;
            }
            let escaped = term.replace('\\', "\\\\").replace('"', "\\\"");
            Some(format!("kMDItemFSName == \"*{escaped}*\"cd"))
        })
        .collect();
    if terms.is_empty() {
        "kMDItemFSName == \"*\"".into()
    } else {
        terms.join(" && ")
    }
}
fn spotlight_command(root: Option<&Path>, query: &ParsedQuery) -> std::process::Command {
    let mut cmd = std::process::Command::new("mdfind");
    cmd.arg("-0");
    if let Some(root) = root {
        cmd.arg("-onlyin").arg(root);
    }
    cmd.arg(spotlight_predicate(query));
    cmd
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
    use std::process::Stdio;
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
        let mut cmd = spotlight_command(root.map(PathBuf::as_path), &query);
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
            if start.elapsed() >= Duration::from_secs(4) {
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
                                    if query_accepts(&query, p, &md)
                                        && format_ok(p, md.is_dir(), &request.format)
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
// Verify only siblings of already admitted hits. This never descends into children,
// follows an entry symlink, or reads file contents; network filesystem time is soft.
fn verify_siblings(
    request: &Request,
    roots: &[PathBuf],
    cancel: &AtomicBool,
    remaining: &mut usize,
    response: &mut SearchResponse,
    budget: &Budget,
) -> Result<()> {
    cancelled(cancel)?;
    let query = parse_query(&request.query, false)?;
    if request.mode != "name" || query.spotlight_terms.is_empty() || response.truncated {
        return Ok(());
    }
    let start = Instant::now();
    let mut parents = vec![];
    let mut seen = HashSet::new();
    let mut seen_paths = HashSet::new();
    let mut parent_overflow = false;
    for hit in &response.items {
        cancelled(cancel)?;
        if start.elapsed() >= budget.duration {
            response.warn("siblingBudget", "同级目录核验达到扫描预算，结果可能不完整");
            return Ok(());
        }
        let Some(parent) = Path::new(&hit.path).parent() else {
            continue;
        };
        if !seen_paths.insert(parent.to_path_buf()) || !eligible(parent, roots, request) {
            continue;
        }
        let Ok(parent) = fs::canonicalize(parent) else {
            continue;
        };
        if query
            .engine
            .scope
            .as_ref()
            .is_some_and(|scope| !parent.starts_with(Path::new(std::ffi::OsStr::from_bytes(scope))))
        {
            continue;
        }
        if seen.insert(parent.clone()) {
            if parents.len() == 32 {
                parent_overflow = true;
                break;
            }
            parents.push(parent);
        }
    }
    if parent_overflow {
        response.warn("siblingBudget", "同级目录核验达到目录预算，结果可能不完整");
    }
    let mut visited = 0;
    for parent in parents {
        cancelled(cancel)?;
        if start.elapsed() >= budget.duration || visited >= budget.entries {
            response.warn("siblingBudget", "同级目录核验达到扫描预算，结果可能不完整");
            return Ok(());
        }
        let entries = match fs::read_dir(&parent) {
            Ok(entries) => entries,
            Err(e) => {
                response.warn("readError", format!("部分同级目录无法读取: {e}"));
                continue;
            }
        };
        for entry in entries {
            cancelled(cancel)?;
            if start.elapsed() >= budget.duration || visited >= budget.entries {
                response.warn("siblingBudget", "同级目录核验达到扫描预算，结果可能不完整");
                return Ok(());
            }
            visited += 1;
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    response.warn("readError", format!("部分同级目录项无法读取: {e}"));
                    continue;
                }
            };
            let path = entry.path();
            // Cheap name/visibility/dedup gates precede metadata and canonicalization.
            if !visible(&path, request.show_hidden)
                || !query.literal_names_accept(&path)
                || response
                    .items
                    .iter()
                    .any(|hit| Path::new(&hit.path) == path)
            {
                continue;
            }
            if *remaining == 0 {
                response.warn("sourceBudget", "同级目录核验达到共享候选预算");
                return Ok(());
            }
            *remaining -= 1;
            let md = match fs::symlink_metadata(&path) {
                Ok(md) => md,
                Err(e) => {
                    response.warn("readError", format!("部分同级目录项无法读取: {e}"));
                    continue;
                }
            };
            if (!md.is_file() && !md.is_dir())
                || !eligible(&path, roots, request)
                || !format_ok(&path, md.is_dir(), &request.format)
                || !query_accepts(&query, &path, &md)
            {
                continue;
            }
            if admit(response, item(&path, &md, None, None), request.limit) {
                return Ok(());
            }
        }
    }
    cancelled(cancel)
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
    let primary = bounded_indexed(request, &roots, cancel, &mut remaining, &mut response);
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
    verify_siblings(
        request,
        &roots,
        cancel,
        &mut remaining,
        &mut response,
        &Budget {
            entries: 20_000,
            duration: Duration::from_millis(180),
            ..Budget::default()
        },
    )?;
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
    static GATE_TEST_LOCK: Mutex<()> = Mutex::new(());
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
    fn opaque_index_deadline_returns_while_provider_is_still_blocked() {
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let caller = std::thread::spawn(move || {
            let worker = IndexWorker::default();
            let result = worker.run(
                &AtomicBool::new(false),
                Duration::from_millis(20),
                move |_| {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(7)
                },
            );
            done_tx.send(result.map_err(|error| error.code)).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let timed = done_rx.recv_timeout(Duration::from_millis(100));
        // Always release the controlled provider before asserting, including red.
        release_tx.send(()).unwrap();
        caller.join().unwrap();
        assert_eq!(timed.unwrap(), Err("indexTimeout"));
    }

    fn wait_worker_idle(worker: &IndexWorker) {
        let start = Instant::now();
        while worker.busy.load(Ordering::Acquire) && start.elapsed() < Duration::from_secs(1) {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(!worker.busy.load(Ordering::Acquire));
    }
    #[test]
    fn opaque_worker_busy_cancel_and_status_never_wait_for_blocked_provider() {
        let worker = Arc::new(IndexWorker::default());
        let stop = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let calls = Arc::new(AtomicU64::new(0));
        let owned = worker.clone();
        let cancel = stop.clone();
        let counter = calls.clone();
        let caller = std::thread::spawn(move || {
            let result = owned.run(&cancel, Duration::from_secs(1), move |_| {
                counter.fetch_add(1, Ordering::Relaxed);
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(7)
            });
            done_tx.send(result.map_err(|error| error.code)).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        // The real app status command probes FDA off-thread but never initializes
        // the engine or enters its opaque name/content locks.
        let initialized = super::super::FSEARCH.get().is_some();
        let status_start = Instant::now();
        for _ in 0..10 {
            let snapshot = tauri::async_runtime::block_on(super::super::fsearch_status()).unwrap();
            assert_eq!(snapshot.entries, 0);
        }
        let status_elapsed = status_start.elapsed();
        let busy = worker.run(&AtomicBool::new(false), Duration::from_secs(1), |_| Ok(99));
        stop.store(true, Ordering::Relaxed);
        let cancelled_result = done_rx.recv_timeout(Duration::from_millis(250));
        release_tx.send(()).unwrap();
        caller.join().unwrap();
        wait_worker_idle(&worker);
        assert_eq!(busy.unwrap_err().code, "indexBusy");
        assert_eq!(cancelled_result.unwrap(), Err("cancelled"));
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert_eq!(super::super::FSEARCH.get().is_some(), initialized);
        assert!(status_elapsed < Duration::from_secs(1));
        assert_eq!(
            worker
                .run(&AtomicBool::new(false), Duration::from_secs(1), |_| Ok(11))
                .unwrap(),
            11
        );
        wait_worker_idle(&worker);
    }
    #[test]
    fn opaque_deadline_releases_global_slot_and_keeps_candidate_reservation() {
        let _serial = GATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let worker = Arc::new(IndexWorker::default());
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let owned = worker.clone();
        let caller = std::thread::spawn(move || {
            let active = Active::new("opaque_slot_deadline".into()).unwrap();
            let slot = GlobalSlot::acquire(&active).unwrap();
            let mut request = req();
            request.mode = "name".into();
            let mut remaining = CANDIDATE_BUDGET;
            let mut response = SearchResponse::new("fsearch");
            let result = reserved_indexed(
                &owned,
                &request,
                &active.cancel,
                &mut remaining,
                &mut response,
                Duration::from_millis(20),
                move |reserved, _| {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(IndexReply {
                        remaining: reserved,
                        response: SearchResponse::new("fsearch"),
                        result: Ok(()),
                    })
                },
            );
            drop(slot);
            done_tx
                .send((result.map_err(|error| error.code), remaining))
                .unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let result = done_rx.recv_timeout(Duration::from_millis(250));
        let successor = Active::new("opaque_slot_successor".into()).unwrap();
        let slot = if result.is_ok() {
            Some(GlobalSlot::acquire(&successor).unwrap())
        } else {
            None
        };
        release_tx.send(()).unwrap();
        caller.join().unwrap();
        wait_worker_idle(&worker);
        assert_eq!(result.unwrap(), (Err("indexTimeout"), CANDIDATE_BUDGET / 2));
        assert!(slot.is_some());
        drop(slot);
    }
    #[test]
    fn completed_index_reply_refunds_unused_candidates_and_merges_bounded_results() {
        let f = Fixture::new();
        let path = f.file("needle.txt", "value");
        let mut request = req();
        request.mode = "name".into();
        request.limit = 1;
        let worker = IndexWorker::default();
        let mut remaining = CANDIDATE_BUDGET;
        let mut response = SearchResponse::new("fsearch");
        reserved_indexed(
            &worker,
            &request,
            &AtomicBool::new(false),
            &mut remaining,
            &mut response,
            Duration::from_secs(1),
            move |reserved, _| {
                let mut response = SearchResponse::new("fsearch");
                response.warn("sourceBudget", "partial source");
                let md = fs::metadata(&path).unwrap();
                response.items.push(item(&path, &md, None, None));
                Ok(IndexReply {
                    remaining: reserved - 3,
                    response,
                    result: Ok(()),
                })
            },
        )
        .unwrap();
        wait_worker_idle(&worker);
        assert_eq!(remaining, CANDIDATE_BUDGET - 3);
        assert_eq!(response.items.len(), 1);
        assert!(response.incomplete);
        assert!(response
            .warnings
            .iter()
            .any(|warning| warning.code == "sourceBudget"));
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
    fn visibility_symlinks_and_format_before_limit() {
        let f = Fixture::new();
        f.file(".hidden/secret.txt", "needle");
        let private = f
            .file(".owned/secret.txt", "needle")
            .parent()
            .unwrap()
            .to_path_buf();
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
        assert!(r.items.iter().all(|i| !i.path.ends_with("/alias.txt")));
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
    fn configured_roots_form_a_union_with_component_boundaries_and_unicode() {
        let f = Fixture::new();
        let first = f.file("报告 [一] /fresh.txt", "needle");
        let second = f.file("second/fresh.txt", "needle");
        let sibling = f.file("second-copy/fresh.txt", "needle");
        let roots = vec![
            directory(first.parent().unwrap().to_str().unwrap()).unwrap(),
            directory(second.parent().unwrap().to_str().unwrap()).unwrap(),
        ];
        let first = fs::canonicalize(first).unwrap();
        let second = fs::canonicalize(second).unwrap();
        let sibling = fs::canonicalize(sibling).unwrap();
        let q = req();
        assert!(eligible(&first, &roots, &q));
        assert!(eligible(&second, &roots, &q));
        assert!(!eligible(&sibling, &roots, &q));
        let mut names = req();
        names.mode = "name".into();
        names.query = "报告 [一]".into();
        let response = run(&f, &names, &Budget::default());
        assert_eq!(response.items.len(), 1);
        assert_eq!(response.items[0].name, "报告 [一] ");
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
    fn global_plain_names_reject_subsequences_typos_and_ancestor_only_terms() {
        for (text, path, wanted) in [
            ("id1234567890", "/reports/ID1234567890 copy.txt", true),
            (
                "id1234567890",
                "/reports/abid1c2d3e4f5a6b7c8d9e0.txt",
                false,
            ),
            ("report", "/reports/reprot.txt", false),
            ("reports invoice", "/reports/invoice.pdf", false),
            ("reports invoice", "/elsewhere/Invoice REPORTS.pdf", true),
            ("\"project report\"", "/elsewhere/project report.txt", true),
            (
                "\"project report\"",
                "/elsewhere/project other report.txt",
                false,
            ),
        ] {
            let parsed = parse_query(text, false).unwrap();
            // Exercise the source query before top-k, independently of final admission.
            assert_eq!(
                parsed
                    .engine
                    .match_path(path.as_bytes(), fsearch::walk::KIND_FILE, 1, 0)
                    .is_some(),
                wanted,
                "source candidate {text}: {path}"
            );
            assert_eq!(
                parsed.literal_names_accept(Path::new(path)),
                wanted,
                "literal admission {text}: {path}"
            );
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn global_unicode_names_preserve_canonical_equivalence_and_case() {
        let f = Fixture::new();
        for text in ["café", "cafe\u{301}"] {
            let parsed = parse_query(text, false).unwrap();
            for name in ["café.txt", "cafe\u{301}.txt", "CAFÉ.txt", "CAFE\u{301}.txt"] {
                let path = f.file(name, "wanted");
                assert!(
                    parsed.engines().any(|engine| engine
                        .match_path(path.as_os_str().as_bytes(), fsearch::walk::KIND_FILE, 1, 0)
                        .is_some()),
                    "source {text}: {name}"
                );
                assert!(
                    query_accepts(&parsed, &path, &fs::metadata(&path).unwrap()),
                    "{text}: {name}"
                );
            }
            let decoy = f.file("cafe-other.txt", "decoy");
            assert!(!query_accepts(
                &parsed,
                &decoy,
                &fs::metadata(&decoy).unwrap()
            ));
        }
    }
    #[test]
    fn global_adapted_literals_reject_pre_top_k_decoys_with_multiple_or_explicit_regex() {
        for (text, wanted, decoy) in [
            (
                "[2026] [final]",
                "/review/[2026] [final].txt",
                "/review/[2026] final-0001.txt",
            ),
            (
                "re:report [2026]",
                "/review/report [2026].txt",
                "/review/report2026-0001.txt",
            ),
        ] {
            let parsed = parse_query(text, false).unwrap();
            assert!(parsed
                .engine
                .match_path(wanted.as_bytes(), fsearch::walk::KIND_FILE, 1, 0)
                .is_some());
            assert!(
                !parsed
                    .engine
                    .match_path(decoy.as_bytes(), fsearch::walk::KIND_FILE, 1, 0)
                    .is_some(),
                "source decoy {text}: {decoy}"
            );
        }
    }

    #[test]
    fn global_added_literal_guards_never_evict_explicit_user_tokens() {
        for (conditions, limited) in [("[2026]", false), ("[2026] [final] [copy]", true)] {
            let parsed = parse_query(
                &format!(
                    "'first 'second 'third 'fourth 'fifth 'sixth 'seventh 'eighth {conditions}"
                ),
                false,
            )
            .unwrap();
            let wanted = format!(
                "/review/first second third fourth fifth sixth seventh eighth {conditions}.txt"
            );
            let missing_first =
                format!("/review/second third fourth fifth sixth seventh eighth {conditions}.txt");
            assert!(parsed
                .engine
                .match_path(wanted.as_bytes(), fsearch::walk::KIND_FILE, 1, 0)
                .is_some());
            assert!(!parsed
                .engine
                .match_path(missing_first.as_bytes(), fsearch::walk::KIND_FILE, 1, 0)
                .is_some());
            assert_eq!(parsed.limited_names, limited);
        }
    }

    #[test]
    fn global_extra_adapted_conjunction_warns_and_keeps_exact_source_tokens() {
        let parsed = parse_query("[2026] [final] [copy]", false).unwrap();
        let mut response = SearchResponse::new("fsearch");
        parsed.warn_coverage(&mut response);
        assert!(response.incomplete);
        assert!(response
            .warnings
            .iter()
            .any(|warning| warning.code == "queryCoverage"));
        for n in 0..=CANDIDATE_BUDGET {
            let path = format!("/review/[2026] [final] copy-{n}.txt");
            assert!(!parsed.engines().any(|engine| engine
                .match_path(path.as_bytes(), fsearch::walk::KIND_FILE, 1, 0)
                .is_some()));
        }
        // Native exact tokens may inherit a matching ancestor. Final basename
        // admission rejects that case; the specific warning keeps this limit visible.
        let inherited = Path::new("/[copy]/[2026] [final] copy.txt");
        assert!(!parsed.literal_names_accept(inherited));
        let supported = parse_query("[2026] [final]", false).unwrap();
        let mut supported_response = SearchResponse::new("fsearch");
        supported.warn_coverage(&mut supported_response);
        assert!(!supported_response.incomplete);
    }

    #[test]
    fn global_unicode_plain_bracket_and_glob_names_do_not_panic_or_match_decoys() {
        let f = Fixture::new();
        for (text, wanted_name, decoy_name) in [
            ("报告", "报告一.txt", "报其他告.txt"),
            ("\"报告 [2026]\"", "报告 [2026].txt", "报告 x2026x.txt"),
            ("*报告?.txt", "报告一.txt", "报告.txt"),
            ("报告 !*草稿?*", "报告定稿.txt", "报告草稿一.txt"),
        ] {
            let wanted = f.file(wanted_name, "wanted");
            let decoy = f.file(decoy_name, "decoy");
            let parsed = parse_query(text, false).unwrap();
            assert!(
                query_accepts(&parsed, &wanted, &fs::metadata(&wanted).unwrap()),
                "{text}"
            );
            assert!(
                !query_accepts(&parsed, &decoy, &fs::metadata(&decoy).unwrap()),
                "{text}"
            );
        }
    }

    #[test]
    fn global_literal_adapter_preserves_explicit_modifiers_paths_and_filters() {
        for (text, path, size, wanted) in [
            ("^report", "/review/report.txt", 3, true),
            ("^report", "/review/other-report.txt", 3, false),
            ("txt$", "/review/report.txt", 3, true),
            ("txt$", "/review/report.txt.bak", 3, false),
            ("'report", "/review/report.txt", 3, true),
            ("!draft *.pdf", "/review/report.pdf", 3, true),
            ("!draft *.pdf", "/draft/report.pdf", 3, false),
            ("reports/invoice", "/review/reports/invoice.pdf", 3, true),
            (
                "report ext:txt kind:file size:>=2",
                "/review/report.txt",
                3,
                true,
            ),
            (
                "report ext:txt kind:file size:>=2",
                "/review/report.txt",
                1,
                false,
            ),
            ("report type:doc", "/review/report.pdf", 3, true),
            ("report type:doc", "/review/report.png", 3, false),
            (
                "report path:archive in:/review",
                "/review/archive/report.txt",
                3,
                true,
            ),
            (
                "report path:archive in:/review",
                "/elsewhere/archive/report.txt",
                3,
                false,
            ),
            ("report mtime:<7d", "/review/report.txt", 3, false),
        ] {
            let parsed = parse_query(text, false).unwrap();
            assert_eq!(
                parsed
                    .engine
                    .match_path(path.as_bytes(), fsearch::walk::KIND_FILE, size, 0)
                    .is_some(),
                wanted,
                "{text}: {path}"
            );
        }
        assert_eq!(
            parse_query("report limit:4", false).unwrap().engine.limit,
            4
        );
        let content = parse_query("report invoice ext:txt", true).unwrap();
        assert!(content.engine.tokens.is_empty());
        assert!(content.literals.is_empty());
        assert!(content.spotlight_terms.is_empty());
        assert_eq!(content.engine.exts, [b"txt".to_vec()]);
    }

    #[test]
    fn global_name_parser_keeps_date_and_wildcard_brackets_literal() {
        let f = Fixture::new();
        let literal = f.file("report [2026-11-01].txt", "fixture");
        let decoy = f.file("report 2026-11-01.txt", "decoy");
        let class_literal = f.file("report [abc].txt", "fixture");
        let class_decoy = f.file("report xabcx.txt", "decoy");
        for (text, wanted, unwanted) in [
            ("report [2026-11-01]", &literal, &decoy),
            ("*[2026-11-01]*", &literal, &decoy),
            ("*[abc]*", &class_literal, &class_decoy),
            ("report [abc]", &class_literal, &class_decoy),
        ] {
            // Same real fsearch parser and final matching path used by both global sources.
            let parsed = parse_query(text, false).unwrap();
            assert!(
                query_accepts(&parsed, wanted, &fs::metadata(wanted).unwrap()),
                "{text}"
            );
            assert!(
                !query_accepts(&parsed, unwanted, &fs::metadata(unwanted).unwrap()),
                "{text}"
            );
        }
    }
    #[test]
    fn global_name_parser_keeps_explicit_regex_and_extension_filters() {
        let f = Fixture::new();
        let regex_hit = f.file("report a.txt", "fixture");
        let bracket_hit = f.file("report [abc].txt", "fixture");
        let wrong_ext = f.file("report [abc].png", "decoy");
        let regex = parse_query("re:^report.[a-c]\\.txt$ ext:txt", false).unwrap();
        assert!(query_accepts(
            &regex,
            &regex_hit,
            &fs::metadata(&regex_hit).unwrap()
        ));
        assert!(!query_accepts(
            &regex,
            &bracket_hit,
            &fs::metadata(&bracket_hit).unwrap()
        ));
        let mixed = parse_query("*[abc]* re:txt$ ext:txt", false).unwrap();
        assert!(query_accepts(
            &mixed,
            &bracket_hit,
            &fs::metadata(&bracket_hit).unwrap()
        ));
        assert!(!query_accepts(
            &mixed,
            &regex_hit,
            &fs::metadata(&regex_hit).unwrap()
        ));
        assert!(!query_accepts(
            &mixed,
            &wrong_ext,
            &fs::metadata(&wrong_ext).unwrap()
        ));
        assert_eq!(
            parse_query("re:[", false).err().unwrap().code,
            "invalidQuery"
        );
    }

    #[test]
    fn spotlight_predicate_narrows_all_plain_terms_and_preserves_root_argument() {
        let query = parse_query("report id1234567890 ext:txt", false).unwrap();
        let command = spotlight_command(Some(Path::new("/review roots/[2026]")), &query);
        assert_eq!(command.get_program(), "mdfind");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "-0",
                "-onlyin",
                "/review roots/[2026]",
                "kMDItemFSName == \"*report*\"cd && kMDItemFSName == \"*id1234567890*\"cd",
            ]
        );
        // Narrowing happens at the producer, so unrelated names cannot exhaust its
        // shared candidate budget before the first matching name is delivered.
        assert_ne!(spotlight_predicate(&query), "kMDItemFSName == \"*\"");
    }
    #[test]
    fn spotlight_predicate_escapes_literals_and_does_not_narrow_explicit_grammar() {
        for (text, expected) in [
            ("\"报告 [2026]\"", "kMDItemFSName == \"*报告 [2026]*\"cd"),
            (r"report\copy", r#"kMDItemFSName == "*report\\copy*"cd"#),
            ("!draft *.pdf", "kMDItemFSName == \"*\""),
            ("^report", "kMDItemFSName == \"*\""),
            ("report$", "kMDItemFSName == \"*\""),
            ("re:report path:archive", "kMDItemFSName == \"*\""),
            ("reports/invoice", "kMDItemFSName == \"*\""),
            ("*report*", "kMDItemFSName == \"*\""),
        ] {
            assert_eq!(
                spotlight_predicate(&parse_query(text, false).unwrap()),
                expected,
                "{text}"
            );
        }
        // Quotes have the same grouping semantics as the locked query parser.
        let mut parsed = parse_query("report", false).unwrap();
        parsed.spotlight_terms = vec!["a\"b\\c".into()];
        assert_eq!(
            spotlight_predicate(&parsed),
            r#"kMDItemFSName == "*a\"b\\c*"cd"#
        );
    }

    fn sibling_request(f: &Fixture) -> (Request, Vec<PathBuf>, SearchResponse) {
        let hit = f.file("inside/id1234567890.txt", "seed");
        let hit = fs::canonicalize(hit).unwrap();
        let mut request = req();
        request.query = "id1234567890".into();
        request.scope = "global".into();
        request.mode = "name".into();
        let root = fs::canonicalize(f.0.join("inside")).unwrap();
        let mut response = SearchResponse::new("fsearch+spotlight");
        admit(
            &mut response,
            item(&hit, &fs::metadata(&hit).unwrap(), None, None),
            request.limit,
        );
        (request, vec![root], response)
    }
    #[test]
    fn sibling_verification_finds_unindexed_copies_without_recursion_or_symlinks() {
        let f = Fixture::new();
        let (request, roots, mut response) = sibling_request(&f);
        f.file("inside/id1234567890 copy 2.txt", "copy");
        f.file("inside/subdir/id1234567890 nested.txt", "nested");
        f.file("outside/id1234567890 outside.txt", "outside");
        f.file("inside/.id1234567890.txt", "hidden");
        std::os::unix::fs::symlink(
            &roots[0].join("id1234567890.txt"),
            roots[0].join("id1234567890 alias.txt"),
        )
        .unwrap();
        let mut remaining = 100;
        verify_siblings(
            &request,
            &roots,
            &AtomicBool::new(false),
            &mut remaining,
            &mut response,
            &Budget::default(),
        )
        .unwrap();
        let mut names: Vec<_> = response.items.iter().map(|hit| hit.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["id1234567890 copy 2.txt", "id1234567890.txt"]);
        assert!(!response.incomplete);
        let entries = fs::read_dir(&roots[0]).unwrap().count();
        verify_siblings(
            &request,
            &roots,
            &AtomicBool::new(false),
            &mut remaining,
            &mut response,
            &Budget {
                entries,
                ..Budget::default()
            },
        )
        .unwrap();
        assert_eq!(response.items.len(), 2);
        assert!(
            !response.incomplete,
            "one shared parent is scanned only once"
        );
    }
    #[test]
    fn sibling_verification_honors_explicit_scope_format_hidden_and_result_limit() {
        let f = Fixture::new();
        let (mut request, roots, seed) = sibling_request(&f);
        f.file("inside/id1234567890.png", "wrong format");
        f.file("inside/.id1234567890.txt", "hidden");
        f.file("inside/id1234567890 copy.txt", "copy");
        request.format = "document".into();
        request.limit = 1;
        let mut response = seed;
        verify_siblings(
            &request,
            &roots,
            &AtomicBool::new(false),
            &mut 100,
            &mut response,
            &Budget::default(),
        )
        .unwrap();
        assert_eq!(response.items.len(), 1);
        assert!(response.truncated);
        response.truncated = false;
        request.limit = 200;
        request.show_hidden = true;
        verify_siblings(
            &request,
            &roots,
            &AtomicBool::new(false),
            &mut 100,
            &mut response,
            &Budget::default(),
        )
        .unwrap();
        assert_eq!(response.items.len(), 3);
        assert!(response.items.iter().all(|hit| !hit.path.ends_with(".png")));
        let excluded = f.0.join("other");
        fs::create_dir(&excluded).unwrap();
        request.query = format!("id1234567890 in:{}", excluded.display());
        let before = response.items.len();
        f.file("inside/id1234567890 new copy.txt", "new copy");
        verify_siblings(
            &request,
            &roots,
            &AtomicBool::new(false),
            &mut 100,
            &mut response,
            &Budget::default(),
        )
        .unwrap();
        assert_eq!(response.items.len(), before);
    }
    #[test]
    fn sibling_verification_bounds_parents_and_rejects_out_of_scope_seed_parents() {
        let f = Fixture::new();
        let mut request = req();
        request.query = "id1234567890".into();
        request.mode = "name".into();
        let mut response = SearchResponse::new("fsearch");
        for n in 0..34 {
            let seed = f.file(&format!("inside/{n}/id1234567890.txt"), "seed");
            let seed = fs::canonicalize(seed).unwrap();
            f.file(&format!("inside/{n}/id1234567890 copy.txt"), "copy");
            admit(
                &mut response,
                item(&seed, &fs::metadata(&seed).unwrap(), None, None),
                200,
            );
        }
        let outside = f.file("outside/id1234567890.txt", "seed");
        let outside = fs::canonicalize(outside).unwrap();
        f.file("outside/id1234567890 copy.txt", "copy");
        // A stale/out-of-scope source hit must never authorize scanning its parent.
        response.items.insert(
            0,
            item(&outside, &fs::metadata(&outside).unwrap(), None, None),
        );
        let roots = vec![fs::canonicalize(f.0.join("inside")).unwrap()];
        verify_siblings(
            &request,
            &roots,
            &AtomicBool::new(false),
            &mut 200,
            &mut response,
            &Budget::default(),
        )
        .unwrap();
        assert_eq!(response.items.len(), 35 + 32);
        assert!(response.warnings.iter().any(|w| w.code == "siblingBudget"));
        assert!(!response
            .items
            .iter()
            .any(|hit| hit.path.ends_with("outside/id1234567890 copy.txt")));
    }

    #[test]
    fn sibling_verification_honors_cancellation_and_budgets() {
        let f = Fixture::new();
        let (request, roots, seed) = sibling_request(&f);
        f.file("inside/id1234567890 copy.txt", "copy");
        let mut response = seed;
        let error = verify_siblings(
            &request,
            &roots,
            &AtomicBool::new(true),
            &mut 100,
            &mut response,
            &Budget::default(),
        )
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
        for (entries, duration, remaining, warning) in [
            (0, Duration::from_secs(2), 100, "siblingBudget"),
            (100, Duration::ZERO, 100, "siblingBudget"),
            (100, Duration::from_secs(2), 0, "sourceBudget"),
        ] {
            response.warnings.clear();
            verify_siblings(
                &request,
                &roots,
                &AtomicBool::new(false),
                &mut { remaining },
                &mut response,
                &Budget {
                    entries,
                    duration,
                    ..Budget::default()
                },
            )
            .unwrap();
            assert_eq!(response.items.len(), 1);
            assert!(response.warnings.iter().any(|w| w.code == warning));
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "manual system index probe; set BENTO_QA_SEARCH and optionally BENTO_QA_ROOTS"]
    fn manual_global_name_search_probe() {
        let mut request = req();
        request.query = std::env::var("BENTO_QA_SEARCH").expect("set BENTO_QA_SEARCH");
        request.scope = "global".into();
        request.mode = "name".into();
        request.limit = 1000;
        request.roots = std::env::var_os("BENTO_QA_ROOTS")
            .map(|roots| {
                std::env::split_paths(&roots)
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        let response = global_search(&request, &AtomicBool::new(false)).unwrap();
        println!(
            "BENTO_QA_RESPONSE={}",
            serde_json::to_string(&response).unwrap()
        );
    }

    #[test]
    fn global_command_rejects_malformed_explicit_regex_before_sources() {
        let result = tauri::async_runtime::block_on(search_query(
            "re:[".into(),
            "global".into(),
            None,
            false,
            None,
            None,
            Some("name".into()),
            "global_invalid_explicit_regex".into(),
            None,
        ));
        assert_eq!(result.err().unwrap().code, "invalidQuery");
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
        let _serial = GATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
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
    fn symlink_preview_is_rejected_and_regular_file_is_allowed() {
        let f = Fixture::new();
        let private = f
            .file("protected/a.txt", "needle")
            .parent()
            .unwrap()
            .to_path_buf();
        let alias = f.0.join("alias.txt");
        std::os::unix::fs::symlink(private.join("a.txt"), &alias).unwrap();
        let ordinary = f.file("protected-user/a.txt", "needle");
        let private_result = super::super::preview_file(alias.to_str().unwrap(), "needle", None);
        let ordinary_result =
            super::super::preview_file(ordinary.to_str().unwrap(), "needle", None);
        assert!(private_result.is_err());
        assert_eq!(ordinary_result.unwrap().match_lines, vec![1.0]);
    }
    #[test]
    fn source_format_intersects_user_extension_filter() {
        let mut q = parse_query("report ext:png", false).unwrap();
        assert!(!apply_format(&mut q.engine, "document"));
        let mut q = parse_query("report ext:txt", false).unwrap();
        assert!(apply_format(&mut q.engine, "document"));
        assert_eq!(q.engine.exts, vec![b"txt".to_vec()]);
    }
}
