//! Compression produces complete, identified ZIP files before publishing them.
use super::{
    extraction::{self, Job, Outcome, Snapshot},
    ZipOptions,
};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
struct Stage {
    path: PathBuf,
    identity: super::FileIdentity,
}
impl Stage {
    fn create(parent: &Path) -> Result<Self, String> {
        for n in 0..100 {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos();
            let path = parent.join(format!(".bento-zip-{}-{nanos}-{n}", std::process::id()));
            let mut b = fs::DirBuilder::new();
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
            match b.create(&path) {
                Ok(()) => {
                    let identity = super::file_identity(&path).map_err(|e| e.to_string())?;
                    return Ok(Self { path, identity });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("无法准备压缩目录：{e}")),
            }
        }
        Err("无法准备压缩目录".into())
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        if super::file_identity(&self.path).ok().as_ref() == Some(&self.identity) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
#[cfg(target_os = "macos")]
fn publish(source: &Path, dest: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let from = CString::new(source.as_os_str().as_bytes())?;
    let to = CString::new(dest.as_os_str().as_bytes())?;
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
#[cfg(not(target_os = "macos"))]
fn publish(source: &Path, dest: &Path) -> io::Result<()> {
    fs::hard_link(source, dest)?;
    fs::remove_file(source)
}
fn publish_unique(
    source: &Path,
    dir: &Path,
    name: &str,
    cancel: &AtomicBool,
) -> Result<PathBuf, String> {
    let stem = name
        .strip_suffix(".zip")
        .or_else(|| name.strip_suffix(".ZIP"))
        .unwrap_or(name);
    for n in 1..10000 {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".into());
        }
        let dest = dir.join(if n == 1 {
            name.to_string()
        } else {
            format!("{stem} {n}.zip")
        });
        match publish(source, &dest) {
            Ok(()) => return Ok(dest),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("无法保存压缩包：{e}")),
        }
    }
    Err("同名压缩包过多".into())
}
// Info-ZIP writes zi* temporary files and only renames the result at exit.
// This directory is private and contains no source files at its top level.
fn staged_bytes(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .take(32)
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| entry.metadata().ok())
        .fold(0u64, |total, metadata| total.saturating_add(metadata.len()))
}
fn compress_group(
    sources: &[String],
    dir: &Path,
    name: &str,
    options: &ZipOptions,
    cancel: &AtomicBool,
    mut tick: impl FnMut(u64),
) -> Outcome {
    let mut result = Outcome {
        source: sources.first().cloned().unwrap_or_default(),
        output: None,
        state: "failed".into(),
        error: None,
        identity: None,
    };
    let work = (|| -> Result<PathBuf, String> {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".into());
        }
        let stage = Stage::create(dir)?;
        let archive = stage.path.join("archive.zip");
        let mut command = Command::new("/usr/bin/zip");
        command
            .args(["-r", "-q"])
            .arg(format!("-{}", options.level.unwrap_or(1).min(9)));
        if let Some(password) = options.password.as_ref().filter(|p| !p.is_empty()) {
            command.arg("-P").arg(password);
        }
        let first = Path::new(&sources[0]).parent();
        let same = first.is_some() && sources.iter().all(|p| Path::new(p).parent() == first);
        let mut names = Vec::new();
        if same {
            command.arg("-y").current_dir(first.unwrap());
            for source in sources {
                let base = Path::new(source)
                    .file_name()
                    .ok_or("源名称无效")?
                    .to_string_lossy();
                names.push(format!("./{base}"));
            }
        } else {
            let links = stage.path.join("sources");
            fs::create_dir(&links).map_err(|e| e.to_string())?;
            for source in sources {
                let base = Path::new(source)
                    .file_name()
                    .ok_or("源名称无效")?
                    .to_string_lossy();
                let link = super::unique_path(&links, &base);
                std::os::unix::fs::symlink(source, &link).map_err(|e| e.to_string())?;
                names.push(format!("./{}", link.file_name().unwrap().to_string_lossy()));
            }
            command.current_dir(&links);
        }
        command
            .arg("-b")
            .arg(&stage.path)
            .arg(&archive)
            .args(names)
            .args(["-x", "*.DS_Store"]);
        let mut written = 0;
        extraction::run_child_observed(
            command,
            cancel,
            |_| {},
            || {
                written = written.max(staged_bytes(&stage.path));
                tick(written)
            },
        )?;
        tick(fs::metadata(&archive).map(|m| m.len()).unwrap_or(0));
        publish_unique(&archive, dir, name, cancel)
    })();
    match work {
        Ok(path) => {
            result.identity = super::file_identity(&path).ok();
            result.output = Some(path.to_string_lossy().into());
            result.state = "completed".into()
        }
        Err(e) if e == "cancelled" => result.state = "cancelled".into(),
        Err(e) => result.error = Some(e),
    }
    result
}
fn validate(sources: &[String], dest: &Path) -> Result<(), String> {
    if sources.is_empty() || sources.len() > 1000 {
        return Err("请选择 1 到 1000 个项目".into());
    }
    if !dest.is_absolute() || !dest.is_dir() {
        return Err("目标不是有效的文件夹".into());
    }
    let dest = fs::canonicalize(dest).map_err(|e| e.to_string())?;
    for source in sources {
        let p = Path::new(source);
        if !p.is_absolute() || source.contains('\0') || p.file_name().is_none() {
            return Err(format!("无效的源路径：{source}"));
        }
        let m = fs::symlink_metadata(p).map_err(|e| format!("无法读取 {source}：{e}"))?;
        if (m.is_dir() || (m.is_symlink() && fs::metadata(p).is_ok_and(|target| target.is_dir())))
            && dest.starts_with(fs::canonicalize(p).map_err(|e| e.to_string())?)
        {
            return Err("输出目录不能放在待压缩文件夹内部".into());
        }
    }
    Ok(())
}
fn start(sources: Vec<String>, dir: PathBuf, options: ZipOptions) -> Result<Snapshot, String> {
    let generation = extraction::generation();
    validate(&sources, &dir)?;
    if options.password.as_ref().is_some_and(|p| p.contains('\0')) {
        return Err("密码不能包含空字符".into());
    }
    let base = |s: &str| {
        Path::new(s)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    };
    let groups: Vec<(Vec<String>, String)> =
        if options.separate.unwrap_or(false) && sources.len() > 1 {
            sources
                .into_iter()
                .map(|s| {
                    let name = format!("{}.zip", base(&s));
                    (vec![s], name)
                })
                .collect()
        } else {
            let name = options
                .name
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if sources.len() == 1 {
                        format!("{}.zip", base(&sources[0]))
                    } else {
                        "归档.zip".into()
                    }
                });
            if name.contains('\0') || name == "." || name == ".." {
                return Err("压缩包名称无效".into());
            }
            let name = name.replace('/', "_");
            let name = if name.to_lowercase().ends_with(".zip") {
                name
            } else {
                format!("{name}.zip")
            };
            vec![(sources, name)]
        };
    extraction::begin_compression(groups.len(), generation, move |job| {
        run_batch(job, groups, dir, options)
    })
}
fn run_batch(
    job: &Arc<Job>,
    groups: Vec<(Vec<String>, String)>,
    dir: PathBuf,
    options: ZipOptions,
) {
    let mut produced = 0;
    for (sources, name) in groups {
        if job.cancel.load(Ordering::Acquire) {
            break;
        }
        {
            let mut s = job.status.lock().unwrap_or_else(|e| e.into_inner());
            s.source = Some(name.clone());
            s.current_entry = None;
        }
        let out = compress_group(&sources, &dir, &name, &options, &job.cancel, |bytes| {
            job.status
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .output_bytes = produced + bytes;
        });
        if let Some(path) = &out.output {
            produced += fs::metadata(path).map(|m| m.len()).unwrap_or(0)
        }
        let cancelled = out.state == "cancelled";
        let mut s = job.status.lock().unwrap_or_else(|e| e.into_inner());
        s.results.push(out);
        s.processed += 1;
        s.output_bytes = produced;
        drop(s);
        if cancelled {
            break;
        }
    }
}
#[tauri::command]
pub async fn start_compression(
    sources: Vec<String>,
    dest_dir: String,
    options: Option<ZipOptions>,
) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        start(
            sources,
            PathBuf::from(dest_dir),
            options.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
#[path = "compression_tests.rs"]
mod tests;
