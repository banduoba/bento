//! A single observable extraction batch; no file-operation queue or archive index.
use serde::Serialize;
use std::{
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
const MARKER: &str = ".bento-incomplete";
const MAX_DIAGNOSTIC: usize = 8192;
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) identity: Option<super::FileIdentity>,
    pub source: String,
    pub output: Option<String>,
    pub state: String,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub operation: String,
    pub output_bytes: u64,
    pub state: String,
    pub source: Option<String>,
    pub current_entry: Option<String>,
    pub elapsed_ms: u64,
    pub total: usize,
    pub processed: usize,
    pub results: Vec<Outcome>,
    pub error: Option<String>,
}
fn active(state: &str) -> bool {
    matches!(state, "running" | "cancelling")
}
pub(super) struct Job {
    pub(super) status: Mutex<Snapshot>,
    pub(super) cancel: AtomicBool,
    started: Instant,
}
impl Job {
    fn snapshot(&self) -> Snapshot {
        let mut s = lock(&self.status).clone();
        if active(&s.state) {
            s.elapsed_ms = self.started.elapsed().as_millis() as u64;
        }
        s
    }
}
#[derive(Default)]
struct Manager {
    current: Mutex<Option<Arc<Job>>>,
    generation: AtomicU64,
    closing: AtomicBool,
}
impl Manager {
    fn status(&self) -> Option<Snapshot> {
        lock(&self.current).as_ref().map(|job| job.snapshot())
    }
    fn start(&self, sources: Vec<String>) -> Result<Snapshot, String> {
        let generation = self.generation.load(Ordering::Acquire);
        if sources.is_empty() || sources.len() > 64 {
            return Err("请选择 1 到 64 个压缩包".into());
        }
        let mut paths = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for source in sources {
            let p = PathBuf::from(&source);
            if !p.is_absolute() || source.contains('\0') {
                return Err(format!("无效的压缩包路径：{source}"));
            }
            let metadata = fs::metadata(&p).map_err(|e| format!("无法读取 {source}：{e}"))?;
            let ext = p
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_ascii_lowercase();
            if !metadata.is_file()
                || ![
                    "zip", "tar", "tgz", "gz", "tbz", "tbz2", "bz2", "txz", "xz", "cpio",
                ]
                .contains(&ext.as_str())
            {
                return Err(format!("不支持此压缩包，请使用其他打开方式：{source}"));
            }
            if seen.insert(p.clone()) {
                paths.push(p)
            }
        }
        self.begin("extract", paths.len(), generation, move |job| {
            run_batch(job, paths)
        })
    }
    fn begin(
        &self,
        operation: &str,
        total: usize,
        generation: u64,
        run: impl FnOnce(&Arc<Job>) + Send + 'static,
    ) -> Result<Snapshot, String> {
        let mut slot = lock(&self.current);
        if self.closing.load(Ordering::Acquire)
            || generation != self.generation.load(Ordering::Acquire)
        {
            return Err("归档任务启动已取消".into());
        }
        if slot.as_ref().is_some_and(|j| active(&j.snapshot().state)) {
            return Err("已有压缩或解压任务正在进行，请先等待完成或取消".into());
        }
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let job = Arc::new(Job {
            status: Mutex::new(Snapshot {
                id: format!("archive-{}", NEXT.fetch_add(1, Ordering::Relaxed)),
                operation: operation.into(),
                output_bytes: 0,
                state: "running".into(),
                source: None,
                current_entry: None,
                elapsed_ms: 0,
                total,
                processed: 0,
                results: vec![],
                error: None,
            }),
            cancel: AtomicBool::new(false),
            started: Instant::now(),
        });
        *slot = Some(job.clone());
        let worker = job.clone();
        if let Err(e) = thread::Builder::new()
            .name("bento-archive".into())
            .spawn(move || {
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run(&worker);
                    finish_batch(&worker)
                }))
                .is_err()
                {
                    let mut s = lock(&worker.status);
                    s.state = "failed".into();
                    s.error = Some("归档任务意外停止；请检查输出目录".into());
                }
            })
        {
            let mut s = lock(&job.status);
            s.state = "failed".into();
            s.error = Some(e.to_string());
        }
        Ok(job.snapshot())
    }
    fn cancel(&self, id: &str) -> Result<Snapshot, String> {
        let job = lock(&self.current)
            .clone()
            .ok_or("没有正在进行的解压任务")?;
        let mut s = lock(&job.status);
        if s.id != id {
            return Err("解压任务已改变，请刷新状态".into());
        }
        if active(&s.state) {
            job.cancel.store(true, Ordering::Release);
            s.state = "cancelling".into();
        }
        drop(s);
        Ok(job.snapshot())
    }
    fn stop(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        let Some(job) = lock(&self.current).clone() else {
            return;
        };
        job.cancel.store(true, Ordering::Release);
        while active(&job.snapshot().state) {
            thread::sleep(Duration::from_millis(20))
        }
    }
}
fn run_batch(job: &Arc<Job>, paths: Vec<PathBuf>) {
    for p in paths {
        if job.cancel.load(Ordering::Acquire) {
            break;
        }
        {
            let mut s = lock(&job.status);
            s.source = Some(p.to_string_lossy().into());
            s.current_entry = None;
        }
        let updates = job.clone();
        let outcome = extract_one(&p, &job.cancel, move |entry| {
            lock(&updates.status).current_entry = Some(entry)
        });
        let cancelled = outcome.state == "cancelled";
        let mut s = lock(&job.status);
        s.results.push(outcome);
        s.processed += 1;
        drop(s);
        if cancelled {
            break;
        }
    }
}
fn finish_batch(job: &Arc<Job>) {
    let mut s = lock(&job.status);
    let complete = s.results.iter().filter(|r| r.state == "completed").count();
    s.state = if job.cancel.load(Ordering::Acquire) && complete < s.total {
        "cancelled"
    } else if complete == s.total {
        "completed"
    } else if complete > 0 {
        "partial"
    } else {
        "failed"
    }
    .into();
    s.current_entry = None;
    s.elapsed_ms = job.started.elapsed().as_millis() as u64;
}
fn output_dir(source: &Path) -> Result<PathBuf, String> {
    let name = source.file_name().ok_or("无效文件名")?.to_string_lossy();
    let lower = name.to_ascii_lowercase();
    let suffix = [
        ".tar.gz", ".tar.bz2", ".tar.xz", ".zip", ".tar", ".tgz", ".tbz2", ".tbz", ".txz", ".cpio",
        ".gz", ".bz2", ".xz",
    ]
    .iter()
    .find(|s| lower.ends_with(**s));
    let base = suffix.map_or(name.as_ref(), |s| &name[..name.len() - s.len()]);
    let base = if base.is_empty() || base == "." || base == ".." {
        "Archive"
    } else {
        base
    };
    let parent = source.parent().ok_or("无法找到压缩包所在目录")?;
    for n in 1..=10000 {
        let p = parent.join(if n == 1 {
            base.to_string()
        } else {
            format!("{base} {n}")
        });
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&p) {
            Ok(()) => return Ok(p),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("无法创建输出目录 {}：{e}", p.display())),
        }
    }
    Err("同名输出目录过多，请先整理后重试".into())
}
// Drop also reaps the owned process on an unexpected unwind.
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn read_diagnostic(mut pipe: impl Read, entry: impl Fn(String)) -> String {
    let mut buf = [0u8; 1024];
    let mut tail = std::collections::VecDeque::with_capacity(MAX_DIAGNOSTIC);
    let mut line = Vec::new();
    let mut updated = Instant::now() - Duration::from_secs(1);
    loop {
        let n = match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        for &b in &buf[..n] {
            if tail.len() == MAX_DIAGNOSTIC {
                tail.pop_front();
            }
            tail.push_back(b);
            if b == b'\n' {
                line.clear()
            } else if line.len() < 2048 {
                line.push(b)
            }
        }
        if updated.elapsed() >= Duration::from_millis(200) {
            let text = String::from_utf8_lossy(&line);
            if let Some(name) = text.strip_prefix("x ") {
                entry(
                    name.chars()
                        .take(400)
                        .map(|c| if c.is_control() { ' ' } else { c })
                        .collect(),
                );
                updated = Instant::now();
            }
        }
    }
    String::from_utf8_lossy(&tail.into_iter().collect::<Vec<_>>()).into_owned()
}
fn run_child(
    command: Command,
    cancel: &AtomicBool,
    entry: impl Fn(String) + Send + 'static,
) -> Result<(), String> {
    run_child_observed(command, cancel, entry, || {})
}
pub(super) fn run_child_observed(
    mut command: Command,
    cancel: &AtomicBool,
    entry: impl Fn(String) + Send + 'static,
    mut tick: impl FnMut(),
) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        return Err("cancelled".into());
    }
    let mut child = OwnedChild(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("无法启动系统归档程序：{e}"))?,
    );
    let stderr = child.0.stderr.take().ok_or("无法读取归档反馈")?;
    let stdout = child.0.stdout.take().ok_or("无法读取归档反馈")?;
    let errors = thread::spawn(move || read_diagnostic(stderr, entry));
    let output = thread::spawn(move || read_diagnostic(stdout, |_| {}));
    let outcome = loop {
        tick();
        if cancel.load(Ordering::Acquire) {
            let _ = child.0.kill();
            let _ = child.0.wait();
            break Err("cancelled".into());
        }
        match child.0.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(format!("归档程序退出状态：{status}"))
                }
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(e) => {
                let _ = child.0.kill();
                let _ = child.0.wait();
                break Err(e.to_string());
            }
        }
    };
    let diagnostic = errors.join().unwrap_or_default();
    let stdout = output.join().unwrap_or_default();
    outcome.map_err(|e| {
        if e == "cancelled" {
            e
        } else {
            format!("{e}\n{}\n{}", diagnostic.trim(), stdout.trim())
        }
    })
}
pub(super) fn generation() -> u64 {
    manager().generation.load(Ordering::Acquire)
}
pub(super) fn begin_compression(
    total: usize,
    generation: u64,
    run: impl FnOnce(&Arc<Job>) + Send + 'static,
) -> Result<Snapshot, String> {
    manager().begin("compress", total, generation, run)
}
#[cfg(target_os = "macos")]
fn quarantine(source: &Path) -> Result<Option<Vec<u8>>, String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let path = CString::new(source.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let name = c"com.apple.quarantine";
    let n = unsafe { libc::getxattr(path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0, 0, 0) };
    if n < 0 {
        let error = std::io::Error::last_os_error();
        return if matches!(
            error.raw_os_error(),
            Some(libc::ENOATTR) | Some(libc::ENOTSUP)
        ) {
            Ok(None)
        } else {
            Err(format!("无法读取下载安全标记：{error}"))
        };
    }
    if n > 4096 {
        return Err("下载安全标记过长，请使用系统归档工具".into());
    }
    let mut value = vec![0u8; n as usize];
    let read = unsafe {
        libc::getxattr(
            path.as_ptr(),
            name.as_ptr(),
            value.as_mut_ptr().cast(),
            value.len(),
            0,
            0,
        )
    };
    if read < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    value.truncate(read as usize);
    Ok(Some(value))
}
#[cfg(not(target_os = "macos"))]
fn quarantine(_: &Path) -> Result<Option<Vec<u8>>, String> {
    Ok(None)
}
#[cfg(target_os = "macos")]
fn apply_quarantine(root: &Path, value: &[u8]) -> Result<(), String> {
    use std::{
        ffi::CString,
        os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    };
    enum Work {
        Visit(PathBuf),
        Read(fs::ReadDir),
        Restore(PathBuf, fs::Permissions),
    }
    fn note(errors: &mut Vec<String>, message: String) {
        if errors.len() < 16 {
            errors.push(message.chars().take(500).collect())
        }
    }
    let mut work = vec![Work::Visit(root.into())];
    let mut errors = Vec::new();
    while let Some(task) = work.pop() {
        match task {
            Work::Restore(path, permissions) => {
                if let Err(e) = fs::set_permissions(&path, permissions) {
                    note(&mut errors, format!("无法恢复权限 {}：{e}", path.display()))
                }
            }
            Work::Read(mut directory) => match directory.next() {
                Some(Ok(item)) => {
                    work.push(Work::Read(directory));
                    work.push(Work::Visit(item.path()))
                }
                Some(Err(e)) => note(&mut errors, format!("无法读取输出目录：{e}")),
                None => {}
            },
            Work::Visit(path) => {
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(m) => m,
                    Err(e) => {
                        note(&mut errors, format!("无法读取 {}：{e}", path.display()));
                        continue;
                    }
                };
                if metadata.file_type().is_symlink() {
                    continue;
                }
                // Files belong to the extracting user. Temporarily grant only
                // owner access needed for metadata, then restore archive modes.
                let original = metadata.permissions();
                let needed = if metadata.is_dir() { 0o700 } else { 0o200 };
                let mut restore = None;
                if original.mode() & needed != needed {
                    match fs::set_permissions(
                        &path,
                        fs::Permissions::from_mode(original.mode() | needed),
                    ) {
                        Ok(()) => restore = Some(original),
                        Err(e) => note(
                            &mut errors,
                            format!("无法准备文件安全标记 {}：{e}", path.display()),
                        ),
                    }
                }
                let marked = CString::new(path.as_os_str().as_bytes())
                    .map_err(|e| e.to_string())
                    .and_then(|p| {
                        if unsafe {
                            libc::setxattr(
                                p.as_ptr(),
                                c"com.apple.quarantine".as_ptr(),
                                value.as_ptr().cast(),
                                value.len(),
                                0,
                                libc::XATTR_NOFOLLOW,
                            )
                        } == 0
                        {
                            Ok(())
                        } else {
                            Err(std::io::Error::last_os_error().to_string())
                        }
                    });
                if let Err(e) = marked {
                    note(
                        &mut errors,
                        format!("无法保留文件安全标记 {}：{e}", path.display()),
                    )
                }
                if let Some(permissions) = restore {
                    work.push(Work::Restore(path.clone(), permissions))
                }
                if metadata.is_dir() {
                    match fs::read_dir(&path) {
                        Ok(read) => work.push(Work::Read(read)),
                        Err(e) => note(
                            &mut errors,
                            format!("无法读取输出目录 {}：{e}", path.display()),
                        ),
                    }
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}
#[cfg(not(target_os = "macos"))]
fn apply_quarantine(_: &Path, _: &[u8]) -> Result<(), String> {
    Ok(())
}
fn extract_one(
    source: &Path,
    cancel: &AtomicBool,
    entry: impl Fn(String) + Send + 'static,
) -> Outcome {
    let mut result = Outcome {
        identity: None,
        source: source.to_string_lossy().into(),
        output: None,
        state: "failed".into(),
        error: None,
    };
    if cancel.load(Ordering::Acquire) {
        result.state = "cancelled".into();
        return result;
    }
    let quarantine = match quarantine(source) {
        Ok(v) => v,
        Err(e) => {
            result.error = Some(e);
            return result;
        }
    };
    let dest = match output_dir(source) {
        Ok(p) => p,
        Err(e) => {
            result.error = Some(e);
            return result;
        }
    };
    result.output = Some(dest.to_string_lossy().into());
    if let Err(e) = fs::write(
        dest.join(MARKER),
        b"Extraction incomplete. Partial files are retained after cancellation or failure.\n",
    ) {
        result.error = Some(e.to_string());
        return result;
    }
    // Supplying a non-secret placeholder disables bsdtar's /dev/tty password callback.
    // Encrypted archives use the explicit Archive Utility fallback instead.
    let mut command = Command::new("/usr/bin/tar");
    command
        .args(["-xvkf"])
        .arg(source)
        .arg("-C")
        .arg(&dest)
        .args([
            "--passphrase",
            "Bento-no-interactive-password",
            "--no-same-owner",
            "--no-same-permissions",
            "--no-acls",
            "--no-fflags",
            "--no-xattrs",
            "--no-mac-metadata",
            "--safe-writes",
        ])
        .env("LC_ALL", "C");
    let extracted = run_child(command, cancel, entry);
    // Cancel stops and reaps tar first. Finishing download safety metadata also
    // covers retained partial files and must not itself be skipped by cancel.
    let secured = match quarantine {
        Some(value) => apply_quarantine(&dest, &value),
        None => Ok(()),
    };
    let was_cancelled = cancel.load(Ordering::Acquire)
        || extracted.as_ref().err().is_some_and(|e| e == "cancelled");
    let mut errors = Vec::new();
    if let Err(e) = extracted {
        if e != "cancelled" {
            errors.push(e)
        }
    }
    if let Err(e) = secured {
        errors.push(e)
    }
    if !errors.is_empty() {
        result.error = Some(errors.join("\n"))
    }
    if was_cancelled {
        result.state = "cancelled".into()
    } else if result.error.is_none() {
        match fs::remove_file(dest.join(MARKER)) {
            Ok(()) => result.state = "completed".into(),
            Err(e) => result.error = Some(format!("解压完成，但无法移除未完成标记：{e}")),
        }
    }

    result
}
fn manager() -> &'static Manager {
    static M: OnceLock<Manager> = OnceLock::new();
    M.get_or_init(Manager::default)
}
#[tauri::command]
pub async fn start_extraction(paths: Vec<String>) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || manager().start(paths))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn extraction_status() -> Option<Snapshot> {
    manager().status()
}
#[tauri::command]
pub fn cancel_extraction(id: String) -> Result<Snapshot, String> {
    manager().cancel(&id)
}
#[tauri::command]
pub async fn stop_extraction() {
    let _ = tauri::async_runtime::spawn_blocking(|| manager().stop()).await;
}
pub fn shutdown() {
    manager().closing.store(true, Ordering::Release);
    manager().stop()
}
#[cfg(test)]
#[path = "extraction_tests.rs"]
mod tests;
