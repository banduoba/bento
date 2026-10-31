//! 按批列出目录。先收齐名字并排序，再大约每 500 条并行 stat。
//!
//! 名称升序时第一批是列表顶部，降序时是末尾。按大小或日期排序时，第一批仍按
//! 文件名取样，调用方会随后续批次重排。不显示隐藏项时，点文件在 stat 之前丢掉。

use super::{make_entry, Entry};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// 一批大约这么多条。再小会让 IPC 次数变多；再大则第一屏要等更多 stat。
pub const LIST_BATCH: usize = 500;

const FINISHED_CAP: usize = 128;

#[derive(Clone, Serialize)]
pub struct DirBatch {
    pub entries: Vec<Entry>,
    pub index: u32,
    pub done: bool,
    pub total: u32,
}

struct StreamCtl {
    running: HashMap<u64, Arc<AtomicBool>>,
    pending: HashSet<u64>,
    finished: VecDeque<u64>,
}

fn ctl() -> &'static Mutex<StreamCtl> {
    static CTL: OnceLock<Mutex<StreamCtl>> = OnceLock::new();
    CTL.get_or_init(|| {
        Mutex::new(StreamCtl {
            running: HashMap::new(),
            pending: HashSet::new(),
            finished: VecDeque::new(),
        })
    })
}

fn lock_ctl() -> std::sync::MutexGuard<'static, StreamCtl> {
    ctl().lock().unwrap_or_else(|err| err.into_inner())
}

fn remember_finished(g: &mut StreamCtl, id: u64) {
    if g.finished.iter().any(|seen| *seen == id) {
        return;
    }
    if g.finished.len() >= FINISHED_CAP {
        g.finished.pop_front();
    }
    g.finished.push_back(id);
}

fn is_finished(g: &StreamCtl, id: u64) -> bool {
    g.finished.iter().any(|seen| *seen == id)
}

pub fn begin_list_request(id: u64) -> Arc<AtomicBool> {
    let mut g = lock_ctl();
    g.finished.retain(|seen| *seen != id);
    let cancelled = g.pending.remove(&id);
    let flag = Arc::new(AtomicBool::new(cancelled));
    if let Some(old) = g.running.insert(id, flag.clone()) {
        old.store(true, Ordering::Relaxed);
    }
    flag
}

pub fn cancel_list_request(id: u64) {
    let mut g = lock_ctl();
    if is_finished(&g, id) {
        return;
    }
    if let Some(flag) = g.running.get(&id) {
        flag.store(true, Ordering::Relaxed);
        return;
    }
    g.pending.insert(id);
}

pub fn finish_list_request(id: u64) {
    let mut g = lock_ctl();
    if let Some(flag) = g.running.remove(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    g.pending.remove(&id);
    remember_finished(&mut g, id);
}

pub fn name_sort_desc(sort_key: &str, sort_dir: &str) -> bool {
    let key = sort_key.trim();
    (key.is_empty() || key == "name") && sort_dir.trim() == "desc"
}

fn cmp_num(a: &[char], i: &mut usize, b: &[char], j: &mut usize) -> std::cmp::Ordering {
    while *i < a.len() && a[*i] == '0' {
        *i += 1;
    }
    while *j < b.len() && b[*j] == '0' {
        *j += 1;
    }
    let a_sig = *i;
    let b_sig = *j;
    while *i < a.len() && a[*i].is_ascii_digit() {
        *i += 1;
    }
    while *j < b.len() && b[*j].is_ascii_digit() {
        *j += 1;
    }
    let a_len = *i - a_sig;
    let b_len = *j - b_sig;
    match a_len.cmp(&b_len) {
        std::cmp::Ordering::Equal => a[a_sig..*i].cmp(&b[b_sig..*j]),
        other => other,
    }
}

fn cmp_file_name(a: &str, b: &str) -> std::cmp::Ordering {
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();
    let mut i = 0;
    let mut j = 0;
    while i < ac.len() && j < bc.len() {
        if ac[i].is_ascii_digit() && bc[j].is_ascii_digit() {
            let ord = cmp_num(&ac, &mut i, &bc, &mut j);
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
        } else {
            let ord = ac[i].to_ascii_lowercase().cmp(&bc[j].to_ascii_lowercase());
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
            i += 1;
            j += 1;
        }
    }
    match (i == ac.len(), j == bc.len()) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.cmp(b),
    }
}

fn stat_in_order(items: &[(PathBuf, String)]) -> Vec<Entry> {
    let mut indexed: Vec<(usize, Entry)> = items
        .par_iter()
        .enumerate()
        .filter_map(|(i, (path, name))| make_entry(path, name.clone()).map(|entry| (i, entry)))
        .collect();
    indexed.sort_unstable_by_key(|(i, _)| *i);
    indexed.into_iter().map(|(_, entry)| entry).collect()
}

pub fn stream_list_dir(
    path: &str,
    show_hidden: bool,
    batch_size: usize,
    name_desc: bool,
    cancel: &AtomicBool,
    mut emit: impl FnMut(DirBatch) -> Result<(), String>,
) -> Result<(), String> {
    let batch_size = batch_size.max(1);
    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }
    let rd = fs::read_dir(path).map_err(|err| format!("无法读取目录 {path}: {err}"))?;
    let mut items = Vec::new();
    for ent in rd {
        let ent = match ent {
            Ok(ent) => ent,
            Err(_) => continue,
        };
        let name = ent.file_name().to_string_lossy().into_owned();
        if super::is_internal(&ent.path()) || (!show_hidden && name.starts_with('.')) {
            continue;
        }
        items.push((ent.path(), name));
    }
    items.sort_by(|a, b| cmp_file_name(&a.1, &b.1));
    if name_desc {
        items.reverse();
    }
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    if items.is_empty() {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        return emit(DirBatch {
            entries: Vec::new(),
            index: 0,
            done: true,
            total: 0,
        });
    }
    let mut offset = 0;
    let mut index = 0u32;
    while offset < items.len() {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let end = (offset + batch_size).min(items.len());
        let entries = stat_in_order(&items[offset..end]);
        let done = end == items.len();
        offset = end;
        if entries.is_empty() && !done {
            continue;
        }
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        emit(DirBatch {
            entries,
            index,
            done,
            total,
        })?;
        index = index.saturating_add(1);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_id() -> u64 {
        static NEXT: AtomicU64 = AtomicU64::new(10_000_000);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let n = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("bento-list-stream-{}-{n}", test_id()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_file(dir: &Path, name: &str) {
        fs::write(dir.join(name), b"hi").unwrap();
    }

    fn names_of(batches: &[DirBatch]) -> Vec<Vec<String>> {
        batches
            .iter()
            .map(|batch| {
                batch
                    .entries
                    .iter()
                    .map(|entry| entry.name.clone())
                    .collect()
            })
            .collect()
    }

    #[test]
    fn natural_order_sorts_numbers_and_ignores_ascii_case() {
        assert_eq!(cmp_file_name("a2.txt", "a10.txt"), std::cmp::Ordering::Less);
        assert_eq!(
            cmp_file_name("a10.txt", "a2.txt"),
            std::cmp::Ordering::Greater
        );
        assert_eq!(cmp_file_name("b", "a10"), std::cmp::Ordering::Greater);
        assert_eq!(cmp_file_name("A.txt", "b.txt"), std::cmp::Ordering::Less);
        assert_eq!(
            cmp_file_name("f000000.txt", "f000001.txt"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            cmp_file_name("f000010.txt", "f000002.txt"),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn batches_are_name_ordered_and_the_last_one_is_done() {
        let dir = Scratch::new();
        for name in ["a10.txt", "a2.txt", "b.txt", ".hidden", "c.txt"] {
            write_file(dir.path(), name);
        }
        let mut batches = Vec::new();
        stream_list_dir(
            dir.path().to_str().unwrap(),
            false,
            2,
            false,
            &AtomicBool::new(false),
            |batch| {
                batches.push(batch);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            names_of(&batches),
            vec![vec!["a2.txt", "a10.txt"], vec!["b.txt", "c.txt"]]
        );
        assert_eq!(batches[0].index, 0);
        assert!(!batches[0].done);
        assert_eq!(batches[0].total, 4);
        assert!(batches[1].done);
        assert_eq!(batches[1].total, 4);
        assert!(batches
            .iter()
            .all(|batch| batch.entries.iter().all(|entry| entry.name != ".hidden")));
    }

    #[test]
    fn name_desc_sends_the_tail_first() {
        let dir = Scratch::new();
        for name in ["a.txt", "b.txt", "c.txt"] {
            write_file(dir.path(), name);
        }
        let mut batches = Vec::new();
        stream_list_dir(
            dir.path().to_str().unwrap(),
            false,
            2,
            true,
            &AtomicBool::new(false),
            |batch| {
                batches.push(batch);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(names_of(&batches)[0], vec!["c.txt", "b.txt"]);
        assert!(batches.last().unwrap().done);
    }

    #[test]
    fn empty_dir_emits_one_done_batch() {
        let dir = Scratch::new();
        let mut batches = Vec::new();
        stream_list_dir(
            dir.path().to_str().unwrap(),
            false,
            500,
            false,
            &AtomicBool::new(false),
            |batch| {
                batches.push(batch);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(batches.len(), 1);
        assert!(batches[0].entries.is_empty());
        assert!(batches[0].done);
        assert_eq!(batches[0].total, 0);
    }

    #[test]
    fn missing_dir_is_an_error_and_emits_nothing() {
        let mut batches = Vec::new();
        let err = stream_list_dir(
            "/no/such/bento-list-stream-dir",
            false,
            500,
            false,
            &AtomicBool::new(false),
            |batch| {
                batches.push(batch);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(err.contains("无法读取目录"));
        assert!(batches.is_empty());
    }

    #[test]
    fn cancel_stops_before_later_batches() {
        let dir = Scratch::new();
        for i in 0..6 {
            write_file(dir.path(), &format!("f{i}.txt"));
        }
        let cancel = AtomicBool::new(false);
        let mut batches = Vec::new();
        stream_list_dir(
            dir.path().to_str().unwrap(),
            false,
            2,
            false,
            &cancel,
            |batch| {
                if batch.index == 0 {
                    cancel.store(true, Ordering::Relaxed);
                }
                batches.push(batch);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(batches.len(), 1);
        assert!(!batches[0].done);
        assert_eq!(batches[0].entries.len(), 2);
    }

    #[test]
    fn cancel_before_start_is_remembered_and_ignored_after_finish() {
        let id = test_id();
        cancel_list_request(id);
        let flag = begin_list_request(id);
        assert!(flag.load(Ordering::Relaxed));
        finish_list_request(id);
        cancel_list_request(id);
        let flag = begin_list_request(id);
        assert!(!flag.load(Ordering::Relaxed));
        finish_list_request(id);
    }

    #[test]
    fn show_hidden_keeps_dotfiles() {
        let dir = Scratch::new();
        write_file(dir.path(), ".secret");
        write_file(dir.path(), "a.txt");
        let mut batches = Vec::new();
        stream_list_dir(
            dir.path().to_str().unwrap(),
            true,
            10,
            false,
            &AtomicBool::new(false),
            |batch| {
                batches.push(batch);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(names_of(&batches), vec![vec![".secret", "a.txt"]]);
    }
}
