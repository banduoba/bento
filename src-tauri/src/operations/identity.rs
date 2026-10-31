//! Content and filesystem identity guards. Symlinks are never followed.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::os::unix::{
    ffi::OsStrExt,
    fs::{MetadataExt, OpenOptionsExt},
};
use std::{
    fs,
    io::{self, Read},
    path::Path,
};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct Identity {
    pub dev: u64,
    pub ino: u64,
}
impl Identity {
    pub fn read(path: &Path) -> io::Result<Self> {
        let m = fs::symlink_metadata(path)?;
        Ok(Self {
            dev: m.dev(),
            ino: m.ino(),
        })
    }
    pub fn matches(&self, path: &Path) -> bool {
        Self::read(path).is_ok_and(|id| id == *self)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Entry {
    relative: Vec<u8>,
    identity: Identity,
    mode: u32,
    size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
    digest: Vec<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct Manifest {
    entries: Vec<Entry>,
}
impl Manifest {
    pub fn capture(path: &Path, checkpoint: &dyn Fn() -> io::Result<()>) -> io::Result<Self> {
        let mut entries = vec![];
        Self::walk(path, path, &mut entries, checkpoint)?;
        Ok(Self { entries })
    }
    fn walk(
        root: &Path,
        path: &Path,
        entries: &mut Vec<Entry>,
        checkpoint: &dyn Fn() -> io::Result<()>,
    ) -> io::Result<()> {
        checkpoint()?;
        let m = fs::symlink_metadata(path)?;
        let identity = Identity {
            dev: m.dev(),
            ino: m.ino(),
        };
        let mut hasher = Sha256::new();
        if m.is_file() {
            let mut f = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(path)?;
            if f.metadata()?.ino() != m.ino() || f.metadata()?.dev() != m.dev() {
                return Err(changed());
            }
            let mut buf = [0; 1024 * 256];
            loop {
                checkpoint()?;
                let n = f.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
        } else if m.file_type().is_symlink() {
            hasher.update(fs::read_link(path)?.as_os_str().as_bytes());
        } else if !m.is_dir() {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "不支持此类文件"));
        }
        entries.push(Entry {
            relative: path
                .strip_prefix(root)
                .unwrap()
                .as_os_str()
                .as_bytes()
                .to_vec(),
            identity,
            mode: m.mode(),
            size: if m.is_dir() { 0 } else { m.len() },
            mtime: (m.mtime(), m.mtime_nsec()),
            ctime: (m.ctime(), m.ctime_nsec()),
            digest: hasher.finalize().to_vec(),
        });
        if m.is_dir() {
            let mut children = fs::read_dir(path)?.collect::<io::Result<Vec<_>>>()?;
            children.sort_by_key(|e| e.file_name());
            for child in children {
                Self::walk(root, &child.path(), entries, checkpoint)?;
            }
        }
        let after = fs::symlink_metadata(path)?;
        if after.dev() != m.dev()
            || after.ino() != m.ino()
            || after.mtime() != m.mtime()
            || after.mtime_nsec() != m.mtime_nsec()
            || after.ctime() != m.ctime()
            || after.ctime_nsec() != m.ctime_nsec()
        {
            return Err(changed());
        }
        Ok(())
    }
    pub fn identity(&self) -> &Identity {
        &self.entries[0].identity
    }
    pub fn matches(&self, path: &Path) -> bool {
        Self::capture(path, &|| Ok(()))
            .as_ref()
            .is_ok_and(|m| m == self)
    }
    // A rename changes root ctime but does not change the captured object or its descendants.
    pub fn matches_captured(&self, path: &Path) -> bool {
        Self::capture(path, &|| Ok(())).is_ok_and(|mut m| {
            m.entries[0].ctime = self.entries[0].ctime;
            m == *self
        })
    }
    pub fn same_contents(&self, other: &Self) -> bool {
        self.entries.len() == other.entries.len()
            && self.entries.iter().zip(&other.entries).all(|(a, b)| {
                a.relative == b.relative
                    && a.mode == b.mode
                    && a.size == b.size
                    && a.mtime == b.mtime
                    && a.digest == b.digest
            })
    }
}
pub(crate) fn changed() -> io::Error {
    io::Error::new(io::ErrorKind::Other, "文件已被修改或替换，保留数据以供恢复")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_size_content_change_and_added_children_invalidate_manifest() {
        let root = std::env::temp_dir().join(format!("bento-m6-identity-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("file"), b"original").unwrap();
        let original = Manifest::capture(&root, &|| Ok(())).unwrap();
        fs::write(root.join("file"), b"modified").unwrap();
        assert_ne!(original, Manifest::capture(&root, &|| Ok(())).unwrap());
        let modified = Manifest::capture(&root, &|| Ok(())).unwrap();
        fs::write(root.join("new"), b"new").unwrap();
        assert_ne!(modified, Manifest::capture(&root, &|| Ok(())).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
}
