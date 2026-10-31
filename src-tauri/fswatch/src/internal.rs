//! Exact, identity-owned internal paths shared by all listing/event paths.
use std::os::unix::fs::MetadataExt;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
#[derive(Clone)]
struct Owned {
    path: PathBuf,
    dev: u64,
    ino: u64,
}
fn registry() -> &'static Mutex<Vec<Owned>> {
    static R: OnceLock<Mutex<Vec<Owned>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(vec![]))
}
pub fn register_internal(path: &Path) -> std::io::Result<()> {
    let path = fs::canonicalize(path)?;
    let m = fs::symlink_metadata(&path)?;
    let mut r = registry().lock().unwrap_or_else(|e| e.into_inner());
    r.retain(|v| v.path != path);
    r.push(Owned {
        path,
        dev: m.dev(),
        ino: m.ino(),
    });
    Ok(())
}
pub fn unregister_internal(path: &Path) {
    let p = resolved(path);
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|v| v.path != p);
}
// Resolve the longest existing prefix, including aliases to registered roots.
fn resolved(path: &Path) -> PathBuf {
    if let Ok(p) = fs::canonicalize(path) {
        return p;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => resolved(parent).join(name),
        _ => path.to_path_buf(),
    }
}
pub fn is_internal(path: &Path) -> bool {
    let p = resolved(path);
    let owned = registry().lock().unwrap_or_else(|e| e.into_inner()).clone();
    owned.iter().any(|v| {
        p.starts_with(&v.path)
            && match fs::symlink_metadata(&v.path) {
                Ok(m) => m.dev() == v.dev && m.ino() == v.ino,
                Err(e) => e.kind() == std::io::ErrorKind::NotFound, // suppress delayed deletion events only
            }
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hides_owned_root_and_alias_but_not_similarly_named_user_data() {
        let root = std::env::temp_dir().join(format!("bento-registry-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let private = root.join(".bento-owned");
        std::fs::create_dir(&private).unwrap();
        let user = root.join(".bento-user");
        std::fs::create_dir(&user).unwrap();
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&private, &alias).unwrap();
        register_internal(&private).unwrap();
        assert!(is_internal(&private));
        assert!(is_internal(&alias.join("child")));
        assert!(!is_internal(&user));
        std::fs::remove_dir(&private).unwrap();
        std::fs::create_dir(&private).unwrap();
        assert!(!is_internal(&private));
        unregister_internal(&private);
        std::fs::remove_dir_all(root).unwrap();
    }
}
