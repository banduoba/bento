//! 与 `src-tauri/src/lib.rs` 里的 `list_dir` / `make_entry` 对齐的无界面扫描。
//! 产品代码不引用这个二进制。`list_dir` 的读目录和 stat 方式变了以后，请同步这里。
//!
//! 对照的产品逻辑（保持同一步骤，而不是链接进应用）：
//! 1. `read_dir`，跳过读失败的项，先收齐路径
//! 2. Rayon 并行 `metadata`（失败再 `symlink_metadata`）
//! 3. 默认丢掉点开头的名字
//! 4. 组装 name / path / is_dir / size / mtime_ms / btime_ms / ext
//! 5. 另计一次把 `{ entries }` 序列化成 JSON 的时间（近似 Tauri IPC 打包）

use rayon::prelude::*;
use serde::Serialize;
use std::env;
use std::fs;
use std::hint::black_box;
use std::path::{Path, PathBuf};
use std::process;
use std::time::Instant;

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    mtime_ms: f64,
    btime_ms: f64,
    ext: String,
}

#[derive(Serialize)]
struct ListResult<'a> {
    entries: &'a [Entry],
}

fn btime_ms_of(t: std::time::SystemTime) -> Option<f64> {
    t.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as f64)
}

fn make_entry(p: &Path, name: String) -> Option<Entry> {
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
        btime_ms: md.created().ok().and_then(btime_ms_of).unwrap_or(0.0),
        ext,
    })
}

fn scan(path: &str, show_hidden: bool) -> Result<Vec<Entry>, String> {
    let rd = fs::read_dir(path).map_err(|e| format!("无法读取目录 {path}: {e}"))?;
    let items: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    let entries: Vec<Entry> = items
        .par_iter()
        .filter_map(|p| {
            let name = p.file_name()?.to_string_lossy().into_owned();
            if !show_hidden && name.starts_with('.') {
                return None;
            }
            make_entry(p, name)
        })
        .collect();
    Ok(entries)
}

#[derive(Clone, Copy)]
struct Summary {
    min: f64,
    max: f64,
    mean: f64,
    median: f64,
}

fn round_ms(ms: f64) -> f64 {
    (ms * 1000.0).round() / 1000.0
}

fn summarize(samples: &[f64]) -> Summary {
    let mut xs: Vec<f64> = samples.iter().copied().map(round_ms).collect();
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let sum: f64 = xs.iter().sum();
    let mid = xs.len() / 2;
    let median = if xs.len() % 2 == 1 {
        xs[mid]
    } else {
        (xs[mid - 1] + xs[mid]) / 2.0
    };
    Summary {
        min: xs[0],
        max: xs[xs.len() - 1],
        mean: round_ms(sum / xs.len() as f64),
        median: round_ms(median),
    }
}

fn usage() -> &'static str {
    "用法: bento-scan-bench <目录> [--runs 5] [--warmup 1] [--hidden]\n\
     向 stdout 打印 JSON。这是 list_dir 的对照扫描，不会修改文件。"
}

fn die(message: &str) -> ! {
    eprintln!("{message}");
    process::exit(1);
}

fn main() {
    let mut dir: Option<String> = None;
    let mut runs: u32 = 5;
    let mut warmup: u32 = 1;
    let mut show_hidden = false;
    let args: Vec<String> = env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => {
                println!("{}", usage());
                return;
            }
            "--hidden" => {
                show_hidden = true;
                i += 1;
            }
            "--runs" => {
                runs = args
                    .get(i + 1)
                    .and_then(|s| s.parse().ok())
                    .filter(|n| (1..=30).contains(n))
                    .unwrap_or_else(|| die("--runs 需要 1 到 30 的整数"));
                i += 2;
            }
            "--warmup" => {
                warmup = args
                    .get(i + 1)
                    .and_then(|s| s.parse().ok())
                    .filter(|n| (0..=30).contains(n))
                    .unwrap_or_else(|| die("--warmup 需要 0 到 30 的整数"));
                i += 2;
            }
            flag if flag.starts_with('-') => die(&format!("不认识的参数: {flag}")),
            other => {
                if dir.is_some() {
                    die("只能指定一个目录");
                }
                dir = Some(other.to_string());
                i += 1;
            }
        }
    }
    let dir = dir.unwrap_or_else(|| die(usage()));

    for _ in 0..warmup {
        let entries = scan(&dir, show_hidden).unwrap_or_else(|e| die(&e));
        black_box(entries.len());
    }

    let mut scan_samples = Vec::with_capacity(runs as usize);
    let mut last = Vec::new();
    for _ in 0..runs {
        let start = Instant::now();
        last = scan(&dir, show_hidden).unwrap_or_else(|e| die(&e));
        black_box(&last);
        scan_samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }

    let mut json_samples = Vec::with_capacity(runs as usize);
    for _ in 0..runs {
        let start = Instant::now();
        let bytes = serde_json::to_vec(&ListResult { entries: &last }).unwrap_or_else(|e| die(&e.to_string()));
        black_box(bytes.len());
        json_samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }

    let scan_stats = summarize(&scan_samples);
    let json_stats = summarize(&json_samples);
    let rounded_scan: Vec<f64> = scan_samples.iter().copied().map(round_ms).collect();
    let rounded_json: Vec<f64> = json_samples.iter().copied().map(round_ms).collect();
    let body = serde_json::json!({
        "engine": "rust-rayon",
        "mirror_of": "src-tauri/src/lib.rs list_dir + make_entry",
        "count": last.len(),
        "show_hidden": show_hidden,
        "warmup": warmup,
        "scan_ms": {
            "samples": rounded_scan,
            "min": scan_stats.min,
            "max": scan_stats.max,
            "mean": scan_stats.mean,
            "median": scan_stats.median,
        },
        "json_ms": {
            "samples": rounded_json,
            "min": json_stats.min,
            "max": json_stats.max,
            "mean": json_stats.mean,
            "median": json_stats.median,
        }
    });
    println!("{}", serde_json::to_string_pretty(&body).unwrap_or_else(|e| die(&e.to_string())));
}
