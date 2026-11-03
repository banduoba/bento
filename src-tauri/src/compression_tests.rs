use super::*;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::Ordering,
    time::{SystemTime, UNIX_EPOCH},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "bento-compress-{}-{}-{sequence}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(p.join("source/目录")).unwrap();
        fs::create_dir(p.join("out")).unwrap();
        fs::write(p.join("source/目录/中文.txt"), b"content").unwrap();
        fs::write(p.join("source/-option.txt"), b"literal").unwrap();
        Self(p)
    }
    fn sources(&self) -> Vec<String> {
        vec![
            self.0.join("source/目录").to_string_lossy().into(),
            self.0.join("source/-option.txt").to_string_lossy().into(),
        ]
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn completed_zip_preserves_unicode_content_dash_names_and_existing_outputs() {
    let f = Fixture::new();
    let dest = f.0.join("out");
    fs::write(dest.join("archive.zip"), b"keep").unwrap();
    let result = compress_group(
        &f.sources(),
        &dest,
        "archive.zip",
        &ZipOptions::default(),
        &AtomicBool::new(false),
        |_| {},
    );
    assert_eq!(result.state, "completed", "{result:?}");
    let path = result.output.unwrap();
    assert_ne!(path, dest.join("archive.zip").to_string_lossy());
    let restored = f.0.join("restored");
    fs::create_dir(&restored).unwrap();
    let extract = Command::new("/usr/bin/tar")
        .args(["-xf", &path, "-C"])
        .arg(&restored)
        .output()
        .unwrap();
    assert!(extract.status.success(), "{:?}", extract.stderr);
    assert_eq!(
        fs::read(restored.join("目录/中文.txt")).unwrap(),
        b"content"
    );
    assert_eq!(fs::read(restored.join("-option.txt")).unwrap(), b"literal");
    assert_eq!(fs::read(dest.join("archive.zip")).unwrap(), b"keep");
    assert!(result.identity.is_some());
    assert!(fs::read_dir(&dest).unwrap().all(|e| !e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".bento-zip-")));
}
#[test]
fn password_and_level_still_create_a_readable_encrypted_zip() {
    let f = Fixture::new();
    let opts = ZipOptions {
        name: None,
        level: Some(9),
        password: Some("test-only-password".into()),
        separate: None,
    };
    let result = compress_group(
        &f.sources(),
        &f.0.join("out"),
        "encrypted.zip",
        &opts,
        &AtomicBool::new(false),
        |_| {},
    );
    assert_eq!(result.state, "completed", "{result:?}");
    let p = result.output.unwrap();
    for (pw, want) in [("wrong", false), ("test-only-password", true)] {
        assert_eq!(
            Command::new("/usr/bin/unzip")
                .args(["-t", "-P", pw, &p])
                .output()
                .unwrap()
                .status
                .success(),
            want
        );
    }
}
#[test]
fn cancellation_after_child_work_begins_never_publishes_an_incomplete_zip() {
    let f = Fixture::new();
    let cancel = AtomicBool::new(false);
    let dest = f.0.join("out");
    let mut ticks = 0;
    let result = compress_group(
        &f.sources(),
        &dest,
        "cancel.zip",
        &ZipOptions::default(),
        &cancel,
        |_| {
            ticks += 1;
            cancel.store(true, Ordering::Release)
        },
    );
    assert_eq!(result.state, "cancelled", "{result:?}");
    assert!(ticks > 0);
    assert!(result.output.is_none());
    assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
}
#[test]
fn batches_preserve_separate_mode_mixed_sources_and_report_generated_bytes() {
    let f = Fixture::new();
    fs::create_dir(f.0.join("other")).unwrap();
    fs::write(f.0.join("other/other.txt"), b"other").unwrap();
    let mut sources = f.sources();
    sources.push(f.0.join("other/other.txt").to_string_lossy().into());
    let mut bytes = Vec::new();
    let single = compress_group(
        &sources,
        &f.0.join("out"),
        "mixed.zip",
        &ZipOptions::default(),
        &AtomicBool::new(false),
        |n| bytes.push(n),
    );
    assert_eq!(single.state, "completed", "{single:?}");
    assert!(bytes.iter().any(|&n| n > 0));
    let extract = f.0.join("restored");
    fs::create_dir(&extract).unwrap();
    assert!(Command::new("/usr/bin/tar")
        .args(["-xf"])
        .arg(single.output.unwrap())
        .arg("-C")
        .arg(&extract)
        .status()
        .unwrap()
        .success());
    assert_eq!(fs::read(extract.join("other.txt")).unwrap(), b"other");
    let result = start(
        f.sources(),
        f.0.join("out"),
        ZipOptions {
            separate: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(result.operation, "compress");
    assert_eq!(result.total, 2);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let done = loop {
        let s = extraction::extraction_status().unwrap();
        if s.state != "running" && s.state != "cancelling" {
            break s;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert_eq!(done.state, "completed", "{done:?}");
    assert_eq!(done.results.len(), 2);
    assert!(done.results.iter().all(|r| r.identity.is_some()));
    assert!(done.output_bytes > 0);
}
#[test]
fn invalid_sources_or_destinations_are_rejected_before_staging_and_self_inclusion_is_blocked() {
    let f = Fixture::new();
    assert!(start(
        vec![f.0.join("missing").to_string_lossy().into()],
        f.0.join("out"),
        ZipOptions::default()
    )
    .is_err());
    assert_eq!(fs::read_dir(f.0.join("out")).unwrap().count(), 0);
    assert!(validate(
        &[f.0.join("source").to_string_lossy().into()],
        &f.0.join("source/目录")
    )
    .is_err());
    assert!(validate(&["relative".into()], &f.0.join("out")).is_err());
}
#[test]
fn mixed_sources_with_a_link_to_output_do_not_recurse_into_private_staging() {
    let f = Fixture::new();
    std::os::unix::fs::symlink(f.0.join("out"), f.0.join("source/目录/output-link")).unwrap();
    fs::write(f.0.join("other.txt"), b"other").unwrap();
    let sources = vec![
        f.0.join("source/目录").to_string_lossy().into(),
        f.0.join("other.txt").to_string_lossy().into(),
    ];
    let cancel = AtomicBool::new(false);
    let start = std::time::Instant::now();
    let result = compress_group(
        &sources,
        &f.0.join("out"),
        "cycle.zip",
        &ZipOptions::default(),
        &cancel,
        |_| {
            if start.elapsed() > std::time::Duration::from_secs(2) {
                cancel.store(true, Ordering::Release)
            }
        },
    );
    assert_eq!(result.state, "completed", "{result:?}");
    let output = result.output.unwrap();
    assert!(fs::metadata(output).unwrap().len() < 100_000);
}
#[test]
fn generated_bytes_increase_while_a_large_zip_is_still_running() {
    use std::io::{Read, Write};
    let f = Fixture::new();
    let input = f.0.join("source/large.bin");
    let mut random = fs::File::open("/dev/urandom").unwrap();
    let mut block = vec![0u8; 1024 * 1024];
    random.read_exact(&mut block).unwrap();
    let mut file = fs::File::create(&input).unwrap();
    for _ in 0..64 {
        file.write_all(&block).unwrap()
    }
    drop(file);
    let cancel = AtomicBool::new(false);
    let mut observed = Vec::new();
    let result = compress_group(
        &[input.to_string_lossy().into()],
        &f.0.join("out"),
        "live.zip",
        &ZipOptions {
            level: Some(9),
            ..Default::default()
        },
        &cancel,
        |bytes| {
            observed.push(bytes);
            if observed
                .windows(2)
                .any(|p| p[0] > 0 && p[1] > p[0] && p[1] < 32 * 1024 * 1024)
            {
                cancel.store(true, Ordering::Release)
            }
        },
    );
    assert_eq!(
        result.state, "cancelled",
        "output size must become positive before completion; samples={observed:?}"
    );
    assert!(observed
        .windows(2)
        .any(|p| p[0] > 0 && p[1] > p[0] && p[1] < 32 * 1024 * 1024));
    assert!(result.output.is_none());
    assert_eq!(fs::read_dir(f.0.join("out")).unwrap().count(), 0);
}
