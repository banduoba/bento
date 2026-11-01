use serde::Serialize;
use std::{fs, path::Path, time::{Duration, Instant}};

#[derive(Debug, Serialize)]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    pub is_symlink: bool,
}

#[derive(Debug, Serialize)]
pub struct FolderResult {
    pub entries: Vec<FolderEntry>,
    pub truncated: bool,
}

struct Limits {
    folders: usize,
    examined: usize,
    elapsed: Duration,
}

pub fn list(path: &str, show_hidden: bool) -> Result<FolderResult, String> {
    list_with_limits(path, show_hidden, Limits {
        folders: 200, examined: 100_000, elapsed: Duration::from_millis(2000),
    })
}

fn list_with_limits(path: &str, show_hidden: bool, limits: Limits) -> Result<FolderResult, String> {
    if !Path::new(path).is_absolute() {
        return Err(format!("请输入绝对目录路径: {path}"));
    }
    let error = |e| format!("无法读取目录 {path}: {e}");
    let mut directory = fs::read_dir(path).map_err(error)?;
    let start = Instant::now();
    let mut entries = Vec::new();
    let mut examined = 0;
    let mut truncated = false;
    loop {
        // Limits are deliberately checked before the next OS call: elapsed is a soft budget.
        if examined >= limits.examined || entries.len() >= limits.folders || start.elapsed() >= limits.elapsed {
            truncated = true;
            break;
        }
        let Some(item) = directory.next() else { break };
        let item = item.map_err(error)?;
        examined += 1;
        let name = item.file_name().to_string_lossy().into_owned();
        if !show_hidden && name.starts_with('.') { continue; }
        let kind = item.file_type().map_err(error)?;
        let is_symlink = kind.is_symlink();
        if !kind.is_dir() {
            if !is_symlink { continue; }
            // Dangling/cyclic links cannot be navigated as folders; ordinary files never stat.
            match fs::metadata(item.path()) {
                Ok(target) if target.is_dir() => {},
                _ => continue,
            }
        }
        // Joining the original string preserves /./, repeated separators and symlink spelling.
        let child_path = format!("{}{}{}", path, if path.ends_with('/') { "" } else { "/" }, name);
        entries.push(FolderEntry { name, path: child_path, is_symlink });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
    Ok(FolderResult { entries, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, sync::atomic::{AtomicUsize, Ordering}, time::Duration};
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let p = std::env::temp_dir().join(format!("bento-folder-tree-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&p).unwrap(); Self(p)
        }
        fn path(&self) -> &str { self.0.to_str().unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); } }
    fn limits() -> Limits { Limits { folders: 200, examined: 100000, elapsed: Duration::from_secs(2) } }
    #[test]
    fn only_immediate_folders_hidden_unicode_and_dotted_names() {
        let f = Fixture::new();
        for name in ["目录", "folder.ext", ".hidden", "parent"] { fs::create_dir(f.0.join(name)).unwrap(); }
        fs::create_dir(f.0.join("parent/deep")).unwrap();
        fs::write(f.0.join("file.txt"), b"content must not be read").unwrap();
        let result = list_with_limits(f.path(), false, limits()).unwrap();
        let mut names: Vec<_> = result.entries.iter().map(|e| e.name.as_str()).collect(); names.sort();
        assert_eq!(names, ["folder.ext", "parent", "目录"]); assert!(!result.truncated);
        assert!(result.entries.iter().all(|e| !e.is_symlink && e.path == f.0.join(&e.name).to_str().unwrap()));
        assert_eq!(list_with_limits(f.path(), true, limits()).unwrap().entries.len(), 4);
        let spelling = format!("{}/./", f.path());
        assert!(list_with_limits(&spelling, true, limits()).unwrap().entries.iter().all(|e| e.path.starts_with(&spelling)));
    }
    #[cfg(unix)]
    #[test]
    fn directory_links_are_marked_leaves_dangling_and_cycles_excluded() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new(); fs::create_dir(f.0.join("dir")).unwrap(); fs::write(f.0.join("file"), b"").unwrap();
        symlink("dir", f.0.join("link")).unwrap(); symlink("missing", f.0.join("dangling")).unwrap();
        symlink("cycle", f.0.join("cycle")).unwrap(); symlink(".", f.0.join("parent-link")).unwrap();
        symlink("file", f.0.join("file-link")).unwrap();
        let r = list_with_limits(f.path(), true, limits()).unwrap();
        assert_eq!(r.entries.len(), 3);
        assert!(r.entries.iter().find(|e| e.name == "link").unwrap().is_symlink);
        assert!(r.entries.iter().find(|e| e.name == "parent-link").unwrap().is_symlink);
    }
    #[test]
    fn limits_report_incomplete_reads_and_errors_include_requested_path() {
        let f = Fixture::new(); for n in 0..5 { fs::create_dir(f.0.join(format!("d{n}"))).unwrap(); }
        for l in [Limits { folders: 2, ..limits() }, Limits { examined: 2, ..limits() }, Limits { elapsed: Duration::ZERO, ..limits() }] {
            let r = list_with_limits(f.path(), true, l).unwrap(); assert!(r.truncated); assert!(r.entries.len() <= 2);
        }
        fs::write(f.0.join("file"), b"").unwrap();
        for p in ["relative".to_owned(), f.0.join("file").to_str().unwrap().to_owned(), f.0.join("missing").to_str().unwrap().to_owned()] {
            assert!(list_with_limits(&p, true, limits()).unwrap_err().contains(&p));
        }
    }
}
