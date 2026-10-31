//! 可见目录的实时刷新。
//!
//! macOS 上 `notify` 的推荐后端是 FSEvents；Linux 上是 inotify，事件种类是同一套。
//! 前端只登记当前可见窗格的目录（含已展开的子目录）。这里把大约 100ms 内的事件收成一批：
//! 能确定的直接子项按路径增量推送（删旧路径、覆盖或新增条目）；对不上的重命名、
//! 目录自身变化、丢事件，或单批路径太多时，该目录整表重读。

use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

mod stream;
pub use stream::{
    begin_list_request, cancel_list_request, finish_list_request, name_sort_desc, stream_list_dir,
    DirBatch, LIST_BATCH,
};

/// 与 `list_dir` 同一条记录。增量更新直接带上它，前端不用再为单个文件发 IPC。
#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    mtime_ms: f64,
    btime_ms: f64,
    ext: String,
}

pub fn make_entry(p: &Path, name: String) -> Option<Entry> {
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
        btime_ms: md
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0),
        ext,
    })
}

/// 首个事件之后等待这么久再推一批。持续变化时大约每 100ms 一批，而不是等写入完全停下来。
const DEBOUNCE: Duration = Duration::from_millis(100);
/// 超过这个数量就整表重读。一次 IPC 带上几千条 stat 并不比 rayon `list_dir` 便宜。
const INCREMENTAL_LIMIT: usize = 512;

#[derive(Clone, Debug, Serialize)]
pub struct FsChange {
    dir: String,
    reload: bool,
    upserts: Vec<Entry>,
    removes: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Op {
    Remove,
    Upsert,
    Probe,
}

enum Note {
    ReloadAll,
    Reload(PathBuf),
    Child(PathBuf, PathBuf, Op),
}

#[derive(Default)]
struct DirAccum {
    reload: bool,
    ops: Vec<(PathBuf, Op)>,
}

#[derive(Default)]
struct Pending {
    reload_all: bool,
    dirs: HashMap<PathBuf, DirAccum>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ProbeKind {
    /// 这条路径现在就是这个名字。
    Present,
    /// 路径不存在，或者只是大小写不敏感卷上旧名的别名。
    Missing,
}

pub struct FsWatcher {
    watcher: Mutex<RecommendedWatcher>,
    /// canonicalize 后的目录 → 前端登记时的原始路径（可能不止一种写法）。
    watched: Arc<Mutex<HashMap<PathBuf, Vec<String>>>>,
}

impl FsWatcher {
    pub fn new(emit: impl Fn(Vec<FsChange>) + Send + Sync + 'static) -> notify::Result<Self> {
        Self::start(Arc::new(emit))
    }

    fn start(emit: Arc<dyn Fn(Vec<FsChange>) + Send + Sync>) -> notify::Result<Self> {
        let watched: Arc<Mutex<HashMap<PathBuf, Vec<String>>>> = Arc::default();
        let pending: Arc<Mutex<Pending>> = Arc::default();
        let scheduled = Arc::new(AtomicBool::new(false));
        let watcher = {
            let watched = watched.clone();
            let pending = pending.clone();
            let scheduled = scheduled.clone();
            let emit = emit.clone();
            notify::recommended_watcher(move |res| {
                if on_raw_event(&watched, &pending, res) && !scheduled.swap(true, Ordering::SeqCst)
                {
                    spawn_flush(&watched, &pending, &scheduled, &emit);
                }
            })?
        };
        Ok(Self {
            watcher: Mutex::new(watcher),
            watched,
        })
    }

    pub fn set_paths(&self, paths: Vec<String>) {
        let want = collect_watch_map(paths);
        let current: HashSet<PathBuf> = self.watched.lock().unwrap().keys().cloned().collect();
        let want_keys: HashSet<PathBuf> = want.keys().cloned().collect();
        let (unwatch, watch) = plan_watch_changes(&current, &want_keys);
        // 先公布新集合，再动内核监听。回调不会在持有 watcher 锁时跑进来。
        *self.watched.lock().unwrap() = want;
        let mut watcher = self.watcher.lock().unwrap();
        for old in &unwatch {
            let _ = watcher.unwatch(old);
        }
        let mut failed = Vec::new();
        for path in &watch {
            if let Err(err) = watcher.watch(path, RecursiveMode::NonRecursive) {
                eprintln!("[watch] {} failed: {err}", path.display());
                failed.push(path.clone());
            }
        }
        drop(watcher);
        if !failed.is_empty() {
            let mut watched = self.watched.lock().unwrap();
            for path in failed {
                watched.remove(&path);
            }
        }
    }
}

fn spawn_flush(
    watched: &Arc<Mutex<HashMap<PathBuf, Vec<String>>>>,
    pending: &Arc<Mutex<Pending>>,
    scheduled: &Arc<AtomicBool>,
    emit: &Arc<dyn Fn(Vec<FsChange>) + Send + Sync>,
) {
    let watched = watched.clone();
    let pending = pending.clone();
    let scheduled_thread = scheduled.clone();
    let emit = emit.clone();
    let spawned = std::thread::Builder::new()
        .name("bento-fs-debounce".into())
        .spawn(move || {
            std::thread::sleep(DEBOUNCE);
            // 先放开标志再取走队列：睡眠期间进来的事件留在这一批里；
            // 取走之后才到的事件会再开一批。
            scheduled_thread.store(false, Ordering::SeqCst);
            let watched = watched.lock().unwrap().clone();
            let batch = std::mem::take(&mut *pending.lock().unwrap());
            let changes = resolve_pending(&watched, batch, probe_kind, load_entry);
            if !changes.is_empty() {
                emit(changes);
            }
        });
    if spawned.is_err() {
        scheduled.store(false, Ordering::SeqCst);
    }
}

fn on_raw_event(
    watched: &Mutex<HashMap<PathBuf, Vec<String>>>,
    pending: &Mutex<Pending>,
    res: notify::Result<Event>,
) -> bool {
    let ev = match res {
        Ok(ev) => ev,
        Err(_) => {
            pending.lock().unwrap().reload_all = true;
            return true;
        }
    };
    let notes = {
        let map = watched.lock().unwrap();
        classify(&map, &ev)
    };
    if notes.is_empty() {
        return false;
    }
    let mut pending = pending.lock().unwrap();
    for note in notes {
        apply_note(&mut pending, note);
    }
    true
}

fn collect_watch_map(paths: Vec<String>) -> HashMap<PathBuf, Vec<String>> {
    let mut want: HashMap<PathBuf, Vec<String>> = HashMap::new();
    for path in paths {
        if path.is_empty() || path == "/" {
            continue;
        }
        let Ok(canon) = std::fs::canonicalize(&path) else {
            continue;
        };
        // `/`、`/.` 这类写法 canonicalize 之后仍是根目录，监听会收到整盘事件。
        if canon == Path::new("/") {
            continue;
        }
        let list = want.entry(canon).or_default();
        if !list.iter().any(|item| item == &path) {
            list.push(path);
        }
    }
    want
}

fn plan_watch_changes(
    current: &HashSet<PathBuf>,
    want: &HashSet<PathBuf>,
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut unwatch: Vec<PathBuf> = current.difference(want).cloned().collect();
    let mut watch: Vec<PathBuf> = want.difference(current).cloned().collect();
    unwatch.sort();
    watch.sort();
    (unwatch, watch)
}

fn classify(watched: &HashMap<PathBuf, Vec<String>>, ev: &Event) -> Vec<Note> {
    if ev.need_rescan() {
        return vec![Note::ReloadAll];
    }
    let mut notes = Vec::new();
    match ev.kind {
        EventKind::Access(_) => {}
        EventKind::Create(_)
        | EventKind::Modify(ModifyKind::Any)
        | EventKind::Modify(ModifyKind::Data(_))
        | EventKind::Modify(ModifyKind::Metadata(_))
        | EventKind::Modify(ModifyKind::Other) => {
            for path in &ev.paths {
                if let Some(note) = classify_path(watched, path, Op::Upsert) {
                    notes.push(note);
                }
            }
        }
        EventKind::Remove(_) => {
            for path in &ev.paths {
                if let Some(note) = classify_path(watched, path, Op::Remove) {
                    notes.push(note);
                }
            }
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if ev.paths.len() >= 2 => {
            if let Some(note) = classify_path(watched, &ev.paths[0], Op::Remove) {
                notes.push(note);
            }
            if let Some(note) = classify_path(watched, &ev.paths[1], Op::Upsert) {
                notes.push(note);
            }
        }
        EventKind::Modify(ModifyKind::Name(_)) => {
            // FSEvents 无法把旧名和新名配成一对，两边都是 RenameMode::Any。
            // 先记下来，等这一批结束再 stat：旧名消失、新名出现才增量，否则整表重读。
            for path in &ev.paths {
                if let Some(note) = classify_path(watched, path, Op::Probe) {
                    notes.push(note);
                }
            }
        }
        EventKind::Any | EventKind::Other => {
            if ev.paths.is_empty() {
                notes.push(Note::ReloadAll);
            }
            for path in &ev.paths {
                if let Some(note) = classify_ambiguous(watched, path) {
                    notes.push(note);
                }
            }
        }
    }
    notes
}

fn classify_path(watched: &HashMap<PathBuf, Vec<String>>, path: &Path, op: Op) -> Option<Note> {
    if watched.contains_key(path) {
        return Some(Note::Reload(path.to_path_buf()));
    }
    let parent = path.parent()?;
    if watched.contains_key(parent) {
        return Some(Note::Child(parent.to_path_buf(), path.to_path_buf(), op));
    }
    None
}

fn classify_ambiguous(watched: &HashMap<PathBuf, Vec<String>>, path: &Path) -> Option<Note> {
    if watched.contains_key(path) {
        return Some(Note::Reload(path.to_path_buf()));
    }
    let parent = path.parent()?;
    if watched.contains_key(parent) {
        return Some(Note::Reload(parent.to_path_buf()));
    }
    None
}

fn apply_note(pending: &mut Pending, note: Note) {
    match note {
        Note::ReloadAll => pending.reload_all = true,
        Note::Reload(dir) => {
            let acc = pending.dirs.entry(dir).or_default();
            acc.reload = true;
            acc.ops.clear();
        }
        Note::Child(dir, child, op) => {
            let acc = pending.dirs.entry(dir).or_default();
            if acc.reload {
                return;
            }
            acc.ops.push((child, op));
        }
    }
}

fn probe_kind(path: &Path) -> ProbeKind {
    match std::fs::canonicalize(path) {
        Ok(canon) if path.file_name() == canon.file_name() => ProbeKind::Present,
        // 不存在，或 canonicalize 穿过了符号链接 / 大小写不敏感的旧名。
        _ => ProbeKind::Missing,
    }
}

fn load_entry(stat_path: &Path, display_path: &Path) -> Option<Entry> {
    let name = display_path.file_name()?.to_string_lossy().into_owned();
    let mut entry = make_entry(stat_path, name)?;
    entry.path = display_path.to_string_lossy().into_owned();
    entry.ext = display_path
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    Some(entry)
}

fn display_path(original_dir: &str, child: &Path) -> Option<PathBuf> {
    let name = child.file_name()?;
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    Some(Path::new(original_dir).join(name))
}

fn resolve_pending(
    watched: &HashMap<PathBuf, Vec<String>>,
    pending: Pending,
    mut probe: impl FnMut(&Path) -> ProbeKind,
    mut load: impl FnMut(&Path, &Path) -> Option<Entry>,
) -> Vec<FsChange> {
    if pending.reload_all {
        let mut changes: Vec<FsChange> = watched
            .values()
            .flatten()
            .map(|dir| reload_change(dir))
            .collect();
        changes.sort_by(|a, b| a.dir.cmp(&b.dir));
        changes.dedup_by(|a, b| a.dir == b.dir);
        return changes;
    }

    let mut changes = Vec::new();
    for (canon, acc) in pending.dirs {
        let Some(originals) = watched.get(&canon) else {
            continue;
        };
        if acc.reload || unique_paths(&acc.ops) > INCREMENTAL_LIMIT {
            push_reloads(&mut changes, originals);
            continue;
        }
        let folded = fold_ops(acc.ops);
        let mut removes: Vec<PathBuf> = Vec::new();
        let mut upserts: Vec<PathBuf> = Vec::new();
        let mut present = Vec::new();
        let mut missing = Vec::new();
        for (path, op) in folded {
            match op {
                Op::Remove => removes.push(path),
                Op::Upsert => upserts.push(path),
                Op::Probe => match probe(&path) {
                    ProbeKind::Present => present.push(path),
                    ProbeKind::Missing => missing.push(path),
                },
            }
        }
        let had_probe = !present.is_empty() || !missing.is_empty();
        let paired = !present.is_empty() && !missing.is_empty();
        if had_probe && !paired {
            // 只有旧名或只有新名：可能是移入/移出，也可能是另一半落到了下一批。
            // 整表重读才能保证列表里不留旧名、也不缺新名。
            push_reloads(&mut changes, originals);
            continue;
        }
        removes.extend(missing);
        upserts.extend(present);
        for original in originals {
            push_incremental(&mut changes, original, &removes, &upserts, &mut load);
        }
    }
    changes.sort_by(|a, b| a.dir.cmp(&b.dir));
    changes
}

fn unique_paths(ops: &[(PathBuf, Op)]) -> usize {
    ops.iter()
        .map(|(path, _)| path)
        .collect::<HashSet<_>>()
        .len()
}

fn fold_ops(ops: Vec<(PathBuf, Op)>) -> HashMap<PathBuf, Op> {
    let mut folded = HashMap::new();
    for (path, op) in ops {
        folded.insert(path, op);
    }
    folded
}

fn reload_change(dir: &str) -> FsChange {
    FsChange {
        dir: dir.to_string(),
        reload: true,
        upserts: Vec::new(),
        removes: Vec::new(),
    }
}

fn push_reloads(changes: &mut Vec<FsChange>, originals: &[String]) {
    for dir in originals {
        changes.push(reload_change(dir));
    }
}

fn push_incremental(
    changes: &mut Vec<FsChange>,
    original: &str,
    removes: &[PathBuf],
    upserts: &[PathBuf],
    load: &mut impl FnMut(&Path, &Path) -> Option<Entry>,
) {
    let mut removed = BTreeSet::new();
    for path in removes {
        if let Some(display) = display_path(original, path) {
            removed.insert(display.to_string_lossy().into_owned());
        }
    }
    let mut loaded = Vec::new();
    for path in upserts {
        let Some(display) = display_path(original, path) else {
            continue;
        };
        match load(path, &display) {
            Some(entry) => {
                removed.remove(&entry.path);
                loaded.push(entry);
            }
            None => {
                removed.insert(display.to_string_lossy().into_owned());
            }
        }
    }
    if removed.is_empty() && loaded.is_empty() {
        return;
    }
    loaded.sort_by(|a, b| a.path.cmp(&b.path));
    changes.push(FsChange {
        dir: original.to_string(),
        reload: false,
        upserts: loaded,
        removes: removed.into_iter().collect(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, DataChange, Flag, RemoveKind};
    use std::fs;
    use std::sync::mpsc;
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    fn watched(dir: &str) -> HashMap<PathBuf, Vec<String>> {
        let mut map = HashMap::new();
        map.insert(PathBuf::from(dir), vec![dir.to_string()]);
        map
    }

    fn push(map: &HashMap<PathBuf, Vec<String>>, pending: &mut Pending, ev: Event) {
        for note in classify(map, &ev) {
            apply_note(pending, note);
        }
    }

    fn finish(map: &HashMap<PathBuf, Vec<String>>, pending: Pending) -> Vec<FsChange> {
        resolve_pending(map, pending, probe_kind, load_entry)
    }

    fn stub(path: &Path) -> Entry {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        Entry {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir: false,
            size: 1,
            mtime_ms: 1.0,
            btime_ms: 1.0,
            ext: String::new(),
        }
    }

    fn scratch() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("bento-fswatch-{}-{n}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        fs::canonicalize(&path).unwrap()
    }

    #[test]
    fn debounce_is_100ms() {
        assert_eq!(DEBOUNCE.as_millis(), 100);
    }

    #[test]
    fn plan_unwatches_only_the_directory_that_went_away() {
        let old = PathBuf::from("/a");
        let keep = PathBuf::from("/b");
        let new = PathBuf::from("/c");
        let current = HashSet::from([old.clone(), keep.clone()]);
        let want = HashSet::from([keep, new.clone()]);
        let (unwatch, watch) = plan_watch_changes(&current, &want);
        assert_eq!(unwatch, vec![old]);
        assert_eq!(watch, vec![new]);
    }

    #[test]
    fn watch_map_skips_root_missing_and_duplicate_paths() {
        let dir = scratch();
        let map = collect_watch_map(vec![
            "/".into(),
            "/./".into(),
            dir.to_string_lossy().into(),
            dir.to_string_lossy().into(),
            dir.join("missing").to_string_lossy().into(),
        ]);
        assert_eq!(map.len(), 1);
        let originals = map.values().next().unwrap();
        assert_eq!(originals, &vec![dir.to_string_lossy().to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn access_and_nested_paths_do_not_change_the_list() {
        let map = watched("/pane");
        let mut pending = Pending::default();
        push(
            &map,
            &mut pending,
            Event::new(EventKind::Access(AccessKind::Any)).add_path(PathBuf::from("/pane/a.txt")),
        );
        push(
            &map,
            &mut pending,
            Event::new(EventKind::Create(CreateKind::File))
                .add_path(PathBuf::from("/pane/sub/nested.txt")),
        );
        let changes = resolve_pending(
            &map,
            pending,
            |_| panic!("ignored event should not be probed"),
            |_, _| panic!("ignored event should not be stat'd"),
        );
        assert!(changes.is_empty());
    }

    #[test]
    fn create_remove_and_touch_are_incremental() {
        let map = watched("/pane");
        let mut pending = Pending::default();
        push(
            &map,
            &mut pending,
            Event::new(EventKind::Remove(RemoveKind::File))
                .add_path(PathBuf::from("/pane/gone.txt")),
        );
        push(
            &map,
            &mut pending,
            Event::new(EventKind::Create(CreateKind::File))
                .add_path(PathBuf::from("/pane/new.txt")),
        );
        push(
            &map,
            &mut pending,
            Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                .add_path(PathBuf::from("/pane/touched.txt")),
        );
        // 同一路径先删后建，留下的是新建。
        push(
            &map,
            &mut pending,
            Event::new(EventKind::Remove(RemoveKind::File))
                .add_path(PathBuf::from("/pane/replaced.txt")),
        );
        push(
            &map,
            &mut pending,
            Event::new(EventKind::Create(CreateKind::File))
                .add_path(PathBuf::from("/pane/replaced.txt")),
        );
        let mut loads = 0;
        let changes = resolve_pending(
            &map,
            pending,
            |_| panic!("plain edits are not rename probes"),
            |_, display| {
                loads += 1;
                if display.ends_with("touched.txt") {
                    return None;
                }
                Some(stub(display))
            },
        );
        assert_eq!(changes.len(), 1);
        assert!(!changes[0].reload);
        assert_eq!(
            changes[0].removes,
            vec![
                "/pane/gone.txt".to_string(),
                "/pane/touched.txt".to_string(),
            ]
        );
        let paths: Vec<_> = changes[0].upserts.iter().map(|e| e.path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                "/pane/new.txt".to_string(),
                "/pane/replaced.txt".to_string(),
            ]
        );
        assert_eq!(loads, 3);
    }

    #[test]
    fn paired_rename_updates_by_path_without_a_duplicate() {
        let map = watched("/pane");
        let mut pending = Pending::default();
        push(
            &map,
            &mut pending,
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any)))
                .add_path(PathBuf::from("/pane/a.txt")),
        );
        push(
            &map,
            &mut pending,
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any)))
                .add_path(PathBuf::from("/pane/b.txt")),
        );
        let changes = resolve_pending(
            &map,
            pending,
            |path| {
                if path.ends_with("b.txt") {
                    ProbeKind::Present
                } else {
                    ProbeKind::Missing
                }
            },
            |_, display| Some(stub(display)),
        );
        assert_eq!(changes.len(), 1);
        assert!(!changes[0].reload);
        assert_eq!(changes[0].removes, vec!["/pane/a.txt".to_string()]);
        assert_eq!(changes[0].upserts.len(), 1);
        assert_eq!(changes[0].upserts[0].path, "/pane/b.txt");
        assert_eq!(changes[0].upserts[0].name, "b.txt");
    }

    #[test]
    fn rename_both_does_not_need_a_probe() {
        let map = watched("/pane");
        let mut pending = Pending::default();
        push(
            &map,
            &mut pending,
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                .add_path(PathBuf::from("/pane/a.txt"))
                .add_path(PathBuf::from("/pane/b.txt")),
        );
        let changes = resolve_pending(
            &map,
            pending,
            |_| panic!("RenameMode::Both already names both paths"),
            |_, display| Some(stub(display)),
        );
        assert!(!changes[0].reload);
        assert_eq!(changes[0].removes, vec!["/pane/a.txt".to_string()]);
        assert_eq!(changes[0].upserts[0].name, "b.txt");
    }

    #[test]
    fn one_sided_rename_reloads_the_directory() {
        for path in ["/pane/only-new.txt", "/pane/only-old.txt"] {
            let map = watched("/pane");
            let mut pending = Pending::default();
            push(
                &map,
                &mut pending,
                Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any)))
                    .add_path(PathBuf::from(path)),
            );
            let mut loads = 0;
            let changes = resolve_pending(
                &map,
                pending,
                |probed| {
                    if probed.ends_with("only-new.txt") {
                        ProbeKind::Present
                    } else {
                        ProbeKind::Missing
                    }
                },
                |_, _| {
                    loads += 1;
                    None
                },
            );
            assert!(changes[0].reload, "{path}");
            assert!(changes[0].upserts.is_empty());
            assert!(changes[0].removes.is_empty());
            assert_eq!(loads, 0);
        }
    }

    #[test]
    fn directory_itself_rescan_and_overflow_reload() {
        let mut map = watched("/pane");
        map.insert(PathBuf::from("/other"), vec!["/other".into()]);
        let mut pending = Pending::default();
        push(
            &map,
            &mut pending,
            Event::new(EventKind::Remove(RemoveKind::Folder)).add_path(PathBuf::from("/pane")),
        );
        let changes = finish(&map, pending);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].dir, "/pane");
        assert!(changes[0].reload);

        let mut pending = Pending::default();
        push(
            &map,
            &mut pending,
            Event::new(EventKind::Other)
                .set_flag(Flag::Rescan)
                .add_path(PathBuf::from("/pane/a.txt")),
        );
        let changes = finish(&map, pending);
        assert_eq!(changes.len(), 2);
        assert!(changes.iter().all(|c| c.reload));
        assert_eq!(changes[0].dir, "/other");
        assert_eq!(changes[1].dir, "/pane");
    }

    #[test]
    fn large_batch_falls_back_to_reload_without_statting() {
        let map = watched("/pane");
        let mut pending = Pending::default();
        for i in 0..=INCREMENTAL_LIMIT {
            push(
                &map,
                &mut pending,
                Event::new(EventKind::Create(CreateKind::File))
                    .add_path(PathBuf::from(format!("/pane/{i}.txt"))),
            );
        }
        let mut loads = 0;
        let changes = resolve_pending(
            &map,
            pending,
            |_| panic!("over the limit"),
            |_, _| {
                loads += 1;
                None
            },
        );
        assert!(changes[0].reload);
        assert_eq!(loads, 0);
    }

    #[test]
    fn batch_at_the_limit_stays_incremental() {
        let map = watched("/pane");
        let mut pending = Pending::default();
        for i in 0..INCREMENTAL_LIMIT {
            push(
                &map,
                &mut pending,
                Event::new(EventKind::Create(CreateKind::File))
                    .add_path(PathBuf::from(format!("/pane/{i}.txt"))),
            );
        }
        let changes = resolve_pending(
            &map,
            pending,
            |_| panic!("no probe"),
            |_, display| Some(stub(display)),
        );
        assert!(!changes[0].reload);
        assert_eq!(changes[0].upserts.len(), INCREMENTAL_LIMIT);
    }

    #[test]
    fn events_keep_the_frontend_path_prefix() {
        let mut map = HashMap::new();
        map.insert(
            PathBuf::from("/private/tmp/foo"),
            vec!["/tmp/foo".into(), "/tmp/foo-alias".into()],
        );
        let mut pending = Pending::default();
        push(
            &map,
            &mut pending,
            Event::new(EventKind::Create(CreateKind::File))
                .add_path(PathBuf::from("/private/tmp/foo/a.txt")),
        );
        let mut seen = Vec::new();
        let changes = resolve_pending(
            &map,
            pending,
            |_| panic!("create is not a probe"),
            |stat, display| {
                seen.push((stat.to_path_buf(), display.to_path_buf()));
                Some(stub(display))
            },
        );
        assert_eq!(
            seen,
            vec![
                (
                    PathBuf::from("/private/tmp/foo/a.txt"),
                    PathBuf::from("/tmp/foo/a.txt")
                ),
                (
                    PathBuf::from("/private/tmp/foo/a.txt"),
                    PathBuf::from("/tmp/foo-alias/a.txt")
                ),
            ]
        );
        assert_eq!(changes[0].dir, "/tmp/foo");
        assert_eq!(changes[0].upserts[0].path, "/tmp/foo/a.txt");
        assert_eq!(changes[1].dir, "/tmp/foo-alias");
        assert_eq!(changes[1].upserts[0].path, "/tmp/foo-alias/a.txt");
    }

    #[test]
    fn flush_drops_a_directory_that_is_no_longer_watched() {
        let map = watched("/pane");
        let mut pending = Pending::default();
        let mut gone = HashMap::new();
        gone.insert(PathBuf::from("/gone"), vec!["/gone".into()]);
        push(
            &gone,
            &mut pending,
            Event::new(EventKind::Create(CreateKind::File)).add_path(PathBuf::from("/gone/a.txt")),
        );
        let changes = finish(&map, pending);
        assert!(changes.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn probe_distinguishes_a_real_file_from_a_symlink_or_a_missing_path() {
        let dir = scratch();
        let file = dir.join("target.txt");
        fs::write(&file, b"x").unwrap();
        let link = dir.join("link.txt");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert_eq!(probe_kind(&file), ProbeKind::Present);
        assert_eq!(probe_kind(&dir.join("missing.txt")), ProbeKind::Missing);
        assert_eq!(probe_kind(&link), ProbeKind::Missing);
        let _ = fs::remove_dir_all(&dir);
    }

    fn wait_batches(
        rx: &mpsc::Receiver<Vec<FsChange>>,
        timeout: Duration,
        mut pred: impl FnMut(&[FsChange]) -> bool,
    ) -> Vec<FsChange> {
        let deadline = Instant::now() + timeout;
        let mut all = Vec::new();
        while Instant::now() < deadline {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(batch) => {
                    all.extend(batch);
                    if pred(&all) {
                        return all;
                    }
                }
                Err(_) => break,
            }
        }
        all
    }

    fn settle(rx: &mpsc::Receiver<Vec<FsChange>>) -> Vec<FsChange> {
        let deadline = Instant::now() + Duration::from_millis(400);
        let mut all = Vec::new();
        while Instant::now() < deadline {
            if let Ok(batch) = rx.recv_timeout(Duration::from_millis(40)) {
                all.extend(batch);
            }
        }
        all
    }

    #[test]
    fn live_watcher_updates_touch_remove_rename_and_unwatches_the_old_path() {
        let dir = scratch();
        let dir2 = scratch();
        let _keep = (dir.clone(), dir2.clone());
        let (tx, rx) = mpsc::channel();
        let watcher = match FsWatcher::start(Arc::new(move |changes| {
            let _ = tx.send(changes);
        })) {
            Ok(watcher) => watcher,
            Err(err) => {
                let _ = fs::remove_dir_all(&dir);
                let _ = fs::remove_dir_all(&dir2);
                panic!("watcher failed to start: {err}");
            }
        };
        watcher.set_paths(vec![dir.to_string_lossy().into()]);
        assert_eq!(watcher.watched.lock().unwrap().len(), 1);

        let file = dir.join("a.txt");
        fs::write(&file, b"hi").unwrap();
        let created = wait_batches(&rx, Duration::from_secs(5), |all| {
            all.iter()
                .any(|c| c.upserts.iter().any(|e| e.name == "a.txt") && !c.reload)
        });
        assert!(
            created
                .iter()
                .any(|c| c.upserts.iter().any(|e| e.name == "a.txt")),
            "create did not arrive: {created:?}"
        );
        let first_mtime = created
            .iter()
            .flat_map(|c| c.upserts.iter())
            .find(|e| e.name == "a.txt")
            .unwrap()
            .mtime_ms;
        settle(&rx);

        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_secs(30))
            .unwrap();
        let touched = wait_batches(&rx, Duration::from_secs(5), |all| {
            all.iter().any(|c| {
                c.upserts
                    .iter()
                    .any(|e| e.name == "a.txt" && e.mtime_ms > first_mtime + 1000.0)
                    && !c.reload
            })
        });
        assert!(
            touched
                .iter()
                .any(|c| c.upserts.iter().any(|e| e.name == "a.txt")),
            "touch did not arrive: {touched:?}"
        );
        settle(&rx);

        fs::remove_file(&file).unwrap();
        let removed = wait_batches(&rx, Duration::from_secs(5), |all| {
            all.iter()
                .any(|c| c.removes.iter().any(|p| p.ends_with("a.txt")) && !c.reload)
        });
        assert!(
            removed
                .iter()
                .any(|c| c.removes.iter().any(|p| p.ends_with("a.txt"))),
            "remove did not arrive: {removed:?}"
        );
        settle(&rx);

        let old = dir.join("old.txt");
        let new = dir.join("new.txt");
        fs::write(&old, b"x").unwrap();
        let _ = wait_batches(&rx, Duration::from_secs(5), |all| {
            all.iter()
                .any(|c| c.upserts.iter().any(|e| e.name == "old.txt"))
        });
        settle(&rx);
        fs::rename(&old, &new).unwrap();
        let mut renamed = wait_batches(&rx, Duration::from_secs(5), |all| {
            let removed_old = all
                .iter()
                .any(|c| c.removes.iter().any(|p| p.ends_with("old.txt")));
            let added_new = all
                .iter()
                .any(|c| c.upserts.iter().any(|e| e.name == "new.txt"));
            let reloaded = all.iter().any(|c| c.reload);
            removed_old && added_new || reloaded
        });
        renamed.extend(settle(&rx));
        let stale = renamed.iter().any(|c| {
            !c.reload && c.upserts.iter().any(|e| e.name == "old.txt") && c.removes.is_empty()
        });
        assert!(!stale, "rename left the old name in the batch: {renamed:?}");
        let removed_old = renamed
            .iter()
            .any(|c| c.removes.iter().any(|p| p.ends_with("old.txt")));
        let added_new = renamed
            .iter()
            .any(|c| c.upserts.iter().any(|e| e.name == "new.txt"));
        let reloaded = renamed.iter().any(|c| c.reload);
        assert!(
            reloaded || (removed_old && added_new),
            "rename was neither incremental nor a reload: {renamed:?}"
        );
        settle(&rx);

        watcher.set_paths(vec![dir2.to_string_lossy().into()]);
        let keys: Vec<_> = watcher.watched.lock().unwrap().keys().cloned().collect();
        assert_eq!(keys, vec![dir2.clone()]);
        settle(&rx);
        fs::write(dir.join("missed.txt"), b"no").unwrap();
        fs::write(dir2.join("seen.txt"), b"yes").unwrap();
        let mut switched = wait_batches(&rx, Duration::from_secs(5), |all| {
            all.iter().any(|c| {
                c.dir == dir2.to_string_lossy()
                    && (c.reload || c.upserts.iter().any(|e| e.name == "seen.txt"))
            })
        });
        switched.extend(settle(&rx));
        let leaked = switched.iter().any(|c| {
            c.dir == dir.to_string_lossy()
                || c.removes.iter().any(|p| p.contains("missed.txt"))
                || c.upserts.iter().any(|e| e.name == "missed.txt")
        });
        assert!(
            switched.iter().any(|c| c.dir == dir2.to_string_lossy()),
            "new directory was not watched: {switched:?}"
        );
        assert!(!leaked, "old directory was still watched: {switched:?}");

        drop(watcher);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir2);
    }
}
