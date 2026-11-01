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
/// lstat-only guard for conflict choices that do not read or mutate the target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConflictIdentity {
    identity: Identity,
    mode: u32,
    size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}
impl ConflictIdentity {
    pub fn read(path: &Path) -> io::Result<Self> {
        let m = fs::symlink_metadata(path)?;
        Ok(Self {
            identity: Identity {
                dev: m.dev(),
                ino: m.ino(),
            },
            mode: m.mode(),
            size: m.len(),
            mtime: (m.mtime(), m.mtime_nsec()),
            ctime: (m.ctime(), m.ctime_nsec()),
        })
    }
    pub fn matches(&self, path: &Path) -> bool {
        Self::read(path).is_ok_and(|m| m == *self)
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
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Manifest {
    entries: Vec<Entry>,
    // Only fresh source/staging comparisons need this. Persisted identity guards
    // keep their original schema and digest, including every extended attribute.
    #[serde(skip)]
    copy_digests: Vec<Vec<u8>>,
    // macOS rebinds the root's MACL when it is renamed into Trash. This cache is
    // usable only across that controlled rename, never as a persisted guard.
    #[serde(skip)]
    trash_root_digest: Option<Vec<u8>>,
}
impl PartialEq for Manifest {
    fn eq(&self, other: &Self) -> bool {
        self.entries == other.entries
    }
}
impl Eq for Manifest {}
impl Manifest {
    pub fn capture(path: &Path, checkpoint: &dyn Fn() -> io::Result<()>) -> io::Result<Self> {
        let mut entries = vec![];
        let mut copy_digests = vec![];
        let mut trash_root_digest = None;
        Self::walk(
            path,
            path,
            &mut entries,
            &mut copy_digests,
            &mut trash_root_digest,
            checkpoint,
        )?;
        Ok(Self {
            entries,
            copy_digests,
            trash_root_digest,
        })
    }
    fn walk(
        root: &Path,
        path: &Path,
        entries: &mut Vec<Entry>,
        copy_digests: &mut Vec<Vec<u8>>,
        trash_root_digest: &mut Option<Vec<u8>>,
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
            let mut buf = vec![0; 1024 * 256];
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
        let mut copy_hasher = hasher.clone();
        let mut trash_hasher = hasher.clone();
        metadata_digest(path, &mut hasher, &mut copy_hasher, &mut trash_hasher)?;
        if path == root {
            *trash_root_digest = Some(trash_hasher.finalize().to_vec());
        }
        copy_digests.push(copy_hasher.finalize().to_vec());
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
                Self::walk(
                    root,
                    &child.path(),
                    entries,
                    copy_digests,
                    trash_root_digest,
                    checkpoint,
                )?;
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
    pub fn remaining_agrees(&self, current: &Self) -> bool {
        current.entries.iter().all(|entry| {
            self.entries
                .iter()
                .find(|original| original.relative == entry.relative)
                .is_some_and(|original| {
                    let mut candidate = entry.clone();
                    if candidate.mode & libc::S_IFMT as u32 == libc::S_IFDIR as u32 {
                        candidate.mtime = original.mtime;
                        candidate.ctime = original.ctime;
                    }
                    if candidate.relative.is_empty() {
                        candidate.ctime = original.ctime;
                    }
                    candidate == *original
                })
        })
    }
    pub fn same_captured_manifest(&self, other: &Self) -> bool {
        let mut other = other.clone();
        other.entries[0].ctime = self.entries[0].ctime;
        other == *self
    }
    /// Only for a successful rename of a freshly verified captured object into
    /// Trash. Preserve inode, contents, mode, mtime, ACL and every other xattr;
    /// descendants remain entirely strict. Source/Undo-entry/recovery guards
    /// must continue using the full captured comparison above.
    pub fn same_trashed_root(&self, other: &Self) -> bool {
        let mut other = other.clone();
        other.entries[0].ctime = self.entries[0].ctime;
        if self
            .trash_root_digest
            .as_ref()
            .zip(other.trash_root_digest.as_ref())
            .is_some_and(|(before, after)| before == after)
        {
            other.entries[0].digest = self.entries[0].digest.clone();
        }
        other == *self
    }
    /// The first metadata read in Trash can itself lazily bind MACL and invalidate
    /// its scan. Retry that specific unstable-snapshot error once, then prove the
    /// final object against the pre-rename guard. Never retry permission/IO errors
    /// or accept other metadata/content changes, and never use this before rename.
    pub fn capture_trashed_root(&self, path: &Path) -> io::Result<Self> {
        let actual = Self::capture(path, &|| Ok(())).or_else(|err| {
            if err.get_ref().is_some_and(|inner| inner.is::<FileChanged>()) {
                Self::capture(path, &|| Ok(()))
            } else {
                Err(err)
            }
        })?;
        if !self.same_trashed_root(&actual) {
            return Err(changed());
        }
        Ok(actual)
    }
    /// Apply only proven subtree changes and their ancestor directory timestamps.
    /// Every other entry (including content, ACLs, and unrelated timestamps) must match.
    pub fn amended(
        &self,
        root: &Path,
        removals: &[(std::path::PathBuf, Manifest)],
        additions: &[(std::path::PathBuf, Manifest)],
        touches: &[std::path::PathBuf],
        actual: &Self,
    ) -> Option<Self> {
        fn within(entry: &[u8], prefix: &[u8]) -> bool {
            entry == prefix || (entry.starts_with(prefix) && entry.get(prefix.len()) == Some(&b'/'))
        }
        fn subtree(entries: &[Entry], prefix: &[u8]) -> Manifest {
            Manifest {
                copy_digests: vec![],
                trash_root_digest: None,
                entries: entries
                    .iter()
                    .filter(|e| within(&e.relative, prefix))
                    .cloned()
                    .map(|mut e| {
                        e.relative = if e.relative.len() == prefix.len() {
                            vec![]
                        } else {
                            e.relative[prefix.len() + 1..].to_vec()
                        };
                        e
                    })
                    .collect(),
            }
        }
        let mut candidate = self.clone();
        let mut affected = touches.to_vec();
        for (path, guard) in removals {
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let prefix = relative.as_os_str().as_bytes();
            if prefix.is_empty() {
                return None;
            }
            let removed = subtree(&candidate.entries, prefix);
            if removed.entries.is_empty() || !guard.same_captured_manifest(&removed) {
                return None;
            }
            candidate.entries.retain(|e| !within(&e.relative, prefix));
            affected.push(path.clone());
        }
        for (path, guard) in additions {
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let prefix = relative.as_os_str().as_bytes();
            if prefix.is_empty() {
                return None;
            }
            if candidate
                .entries
                .iter()
                .any(|e| within(&e.relative, prefix))
            {
                return None;
            }
            let added = subtree(&actual.entries, prefix);
            if added.entries.is_empty() || !guard.same_captured_manifest(&added) {
                return None;
            }
            for mut entry in added.entries {
                entry.relative = if entry.relative.is_empty() {
                    prefix.to_vec()
                } else {
                    [prefix, b"/", &entry.relative].concat()
                };
                candidate.entries.push(entry);
            }
            affected.push(path.clone());
        }
        for path in affected {
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            for parent in relative.ancestors().skip(1) {
                let name = parent.as_os_str().as_bytes();
                let Some(expected) = candidate.entries.iter_mut().find(|e| e.relative == name)
                else {
                    continue;
                };
                let observed = actual.entries.iter().find(|e| e.relative == name)?;
                if expected.mode & libc::S_IFMT as u32 != libc::S_IFDIR as u32 {
                    return None;
                }
                expected.mtime = observed.mtime;
                expected.ctime = observed.ctime;
            }
        }
        candidate
            .entries
            .sort_by(|a, b| a.relative.cmp(&b.relative));
        let mut compared = actual.clone();
        compared.entries.sort_by(|a, b| a.relative.cmp(&b.relative));
        if candidate == compared {
            Some(actual.clone())
        } else {
            None
        }
    }
    pub fn same_contents(&self, other: &Self) -> bool {
        self.entries.len() == other.entries.len()
            && self
                .entries
                .iter()
                .zip(&other.entries)
                .enumerate()
                .all(|(i, (a, b))| {
                    a.relative == b.relative
                        && a.mode == b.mode
                        && a.size == b.size
                        && a.mtime == b.mtime
                        && match self.copy_digests.get(i).zip(other.copy_digests.get(i)) {
                            Some((a, b)) => a == b,
                            // Journal guards have no ephemeral copy digest. Never
                            // relax a comparison against a persisted fingerprint.
                            None => a.digest == b.digest,
                        }
                })
    }
}
#[derive(Debug)]
struct FileChanged;
impl std::fmt::Display for FileChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("文件已被修改或替换，保留数据以供恢复")
    }
}
impl std::error::Error for FileChanged {}
pub(crate) fn changed() -> io::Error {
    io::Error::other(FileChanged)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_equivalence_allows_only_provenance_changes_and_keeps_identity_strict() {
        // Kernel-managed provenance cannot be assigned arbitrary values on macOS.
        // Supply two creator values at the xattr-hashing boundary; exercise the
        // same manifest comparisons used by preparation and persisted guards.
        fn snapshot(name: &[u8], value: &[u8]) -> Manifest {
            let mut full = Sha256::new();
            full.update(b"unchanged file bytes");
            let mut portable = full.clone();
            let mut trash = full.clone();
            hash_xattr(&mut full, &mut portable, &mut trash, name, value);
            Manifest {
                entries: vec![Entry {
                    relative: vec![],
                    identity: Identity { dev: 1, ino: 2 },
                    mode: 0o100644,
                    size: 20,
                    mtime: (100, 42),
                    ctime: (101, 43),
                    digest: full.finalize().to_vec(),
                }],
                copy_digests: vec![portable.finalize().to_vec()],
                trash_root_digest: Some(trash.finalize().to_vec()),
            }
        }
        for name in [
            b"com.apple.provenance".as_slice(),
            b"com.apple.macl",
            b"com.apple.lastuseddate#PS",
            b"com.apple.ResourceFork",
            b"com.apple.quarantine",
            b"com.example.user",
        ] {
            let before = snapshot(name, b"first");
            let after = snapshot(name, b"other");
            assert_eq!(
                before.same_contents(&after),
                name == b"com.apple.provenance"
            );
            assert_ne!(before, after);
            assert!(!before.same_captured_manifest(&after));
            assert!(!before.remaining_agrees(&after));
            assert_eq!(before.same_trashed_root(&after), name == b"com.apple.macl");
            let mut replaced = after.clone();
            replaced.entries[0].identity.ino += 1;
            assert!(!before.same_trashed_root(&replaced));
            let mut with_child = before.clone();
            let mut child = before.entries[0].clone();
            child.relative = b"child".to_vec();
            with_child.entries.push(child);
            let mut changed_child = with_child.clone();
            changed_child.entries[1].digest = after.entries[0].digest.clone();
            assert!(!with_child.same_trashed_root(&changed_child));

            let stored = serde_json::to_value(&before).unwrap();
            assert_eq!(stored.as_object().unwrap().len(), 1);
            let restored: Manifest = serde_json::from_value(stored).unwrap();
            assert_eq!(restored, before);
            assert!(restored.same_trashed_root(&before));
            assert!(restored.same_contents(&before));
            assert!(!restored.same_contents(&after));
            assert!(!restored.same_captured_manifest(&after));
            assert!(!restored.same_trashed_root(&after));
        }
    }

    #[test]
    fn persisted_manifest_retains_full_filesystem_guard_without_copy_cache() {
        let root = std::env::temp_dir().join(format!("bento-m6-roundtrip-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("file");
        fs::write(&path, b"original").unwrap();
        let captured = Manifest::capture(&path, &|| Ok(())).unwrap();
        let restored: Manifest =
            serde_json::from_slice(&serde_json::to_vec(&captured).unwrap()).unwrap();
        assert!(restored.copy_digests.is_empty());
        assert!(restored.matches(&path));
        assert!(restored.matches_captured(&path));
        fs::write(&path, b"modified").unwrap();
        assert!(!restored.matches(&path));
        assert!(!restored.matches_captured(&path));
        fs::remove_dir_all(root).unwrap();
    }

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

#[cfg(all(test, target_os = "macos"))]
mod metadata_tests {
    use super::*;
    #[test]
    fn captured_guard_detects_xattr_edit_despite_root_rename_ctime_normalization() {
        let root = std::env::temp_dir().join(format!("bento-m6-attrs-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let p = root.join("file");
        fs::write(&p, b"same bytes").unwrap();
        let before = Manifest::capture(&p, &|| Ok(())).unwrap();
        assert!(std::process::Command::new("xattr")
            .args(["-w", "com.bento.test", "changed"])
            .arg(&p)
            .status()
            .unwrap()
            .success());
        assert!(!before.matches_captured(&p));
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(target_os = "macos")]
fn metadata_digest(
    path: &Path,
    hasher: &mut Sha256,
    copy_hasher: &mut Sha256,
    trash_hasher: &mut Sha256,
) -> io::Result<()> {
    use std::ffi::CString;
    let path = CString::new(path.as_os_str().as_bytes())?;
    let length =
        unsafe { libc::listxattr(path.as_ptr(), std::ptr::null_mut(), 0, libc::XATTR_NOFOLLOW) };
    if length < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut names = vec![0u8; length as usize];
    if length > 0
        && unsafe {
            libc::listxattr(
                path.as_ptr(),
                names.as_mut_ptr().cast(),
                names.len(),
                libc::XATTR_NOFOLLOW,
            )
        } != length
    {
        return Err(changed());
    }
    let mut attrs = names
        .split(|c| *c == 0)
        .filter(|n| !n.is_empty())
        .collect::<Vec<_>>();
    attrs.sort();
    for name in attrs {
        let name_c = CString::new(name)?;
        let len = unsafe {
            libc::getxattr(
                path.as_ptr(),
                name_c.as_ptr(),
                std::ptr::null_mut(),
                0,
                0,
                libc::XATTR_NOFOLLOW,
            )
        };
        if len < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut value = vec![0u8; len as usize];
        if len > 0
            && unsafe {
                libc::getxattr(
                    path.as_ptr(),
                    name_c.as_ptr(),
                    value.as_mut_ptr().cast(),
                    value.len(),
                    0,
                    libc::XATTR_NOFOLLOW,
                )
            } != len
        {
            return Err(changed());
        }
        hash_xattr(hasher, copy_hasher, trash_hasher, name, &value);
    }
    unsafe extern "C" {
        fn acl_get_link_np(path: *const libc::c_char, kind: libc::c_int) -> *mut libc::c_void;
        fn acl_size(acl: *mut libc::c_void) -> libc::ssize_t;
        fn acl_copy_ext(
            buf: *mut libc::c_void,
            acl: *mut libc::c_void,
            size: libc::ssize_t,
        ) -> libc::ssize_t;
        fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
    }
    let acl = unsafe { acl_get_link_np(path.as_ptr(), 0x100) };
    if acl.is_null() {
        let e = io::Error::last_os_error();
        // Darwin represents an absent extended ACL as ENOENT, even for an existing inode.
        if e.raw_os_error() == Some(libc::ENOENT) {
            hasher.update(b"no extended acl");
            copy_hasher.update(b"no extended acl");
            trash_hasher.update(b"no extended acl");
            return Ok(());
        }
        return Err(e);
    }
    let size = unsafe { acl_size(acl) };
    if size < 0 {
        unsafe { acl_free(acl) };
        return Err(io::Error::last_os_error());
    }
    let mut data = vec![0u8; size as usize];
    let copied = unsafe { acl_copy_ext(data.as_mut_ptr().cast(), acl, size) };
    unsafe { acl_free(acl) };
    if copied < 0 {
        return Err(io::Error::last_os_error());
    }
    hasher.update(&data[..copied as usize]);
    copy_hasher.update(&data[..copied as usize]);
    trash_hasher.update(&data[..copied as usize]);
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn metadata_digest(
    _path: &Path,
    _hasher: &mut Sha256,
    _copy_hasher: &mut Sha256,
    _trash_hasher: &mut Sha256,
) -> io::Result<()> {
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn hash_xattr(
    hasher: &mut Sha256,
    copy_hasher: &mut Sha256,
    trash_hasher: &mut Sha256,
    name: &[u8],
    value: &[u8],
) {
    // macOS assigns provenance for the creating process; copyfile can succeed
    // without transferring this kernel-owned value. Exclude it only from copy
    // equivalence; same-object source/Undo/recovery checks still fingerprint it.
    for digest in [
        Some(hasher),
        (name != b"com.apple.provenance").then_some(copy_hasher),
        (name != b"com.apple.macl").then_some(trash_hasher),
    ]
    .into_iter()
    .flatten()
    {
        digest.update((name.len() as u64).to_le_bytes());
        digest.update(name);
        digest.update((value.len() as u64).to_le_bytes());
        digest.update(value);
    }
}
