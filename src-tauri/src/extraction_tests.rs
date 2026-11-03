use super::*;
use std::{
    fs,
    process::Command,
    sync::{atomic::Ordering, Arc},
    time::{SystemTime, UNIX_EPOCH},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "bento-extract-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn archive(&self, name: &str, zip: bool) -> PathBuf {
        let input = self.0.join("input");
        fs::create_dir_all(input.join("子目录")).unwrap();
        fs::write(input.join("子目录/测试 文件.txt"), b"original content").unwrap();
        let output = self.0.join(name);
        let status = if zip {
            Command::new("/usr/bin/zip")
                .current_dir(&input)
                .args(["-qr"])
                .arg(&output)
                .arg(".")
                .status()
                .unwrap()
        } else {
            Command::new("/usr/bin/tar")
                .args(["-cf"])
                .arg(&output)
                .arg("-C")
                .arg(&input)
                .arg(".")
                .status()
                .unwrap()
        };
        assert!(status.success());
        output
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn real_zip_and_tar_finish_only_after_files_exist_and_do_not_overwrite_siblings() {
    for (name, zip) in [("sample.zip", true), ("sample.tar", false)] {
        let f = Fixture::new();
        let source = f.archive(name, zip);
        fs::create_dir(f.0.join("sample")).unwrap();
        fs::write(f.0.join("sample/keep"), b"keep").unwrap();
        let out = extract_one(&source, &AtomicBool::new(false), |_| {});
        assert_eq!(out.state, "completed", "{out:?}");
        let dest = PathBuf::from(out.output.unwrap());
        assert_ne!(dest, f.0.join("sample"));
        assert_eq!(
            fs::read(dest.join("子目录/测试 文件.txt")).unwrap(),
            b"original content"
        );
        assert_eq!(fs::read(f.0.join("sample/keep")).unwrap(), b"keep");
        assert!(!dest.join(".bento-incomplete").exists());
        assert!(source.exists());
    }
}
#[test]
fn corrupt_archive_reports_source_error_and_retains_marked_partial_output() {
    let f = Fixture::new();
    let p = f.0.join("broken.zip");
    fs::write(&p, b"not a zip").unwrap();
    let out = extract_one(&p, &AtomicBool::new(false), |_| {});
    assert_eq!(out.state, "failed");
    assert_eq!(out.source, p.to_string_lossy());
    assert!(!out.error.unwrap().is_empty());
    let dest = PathBuf::from(out.output.unwrap());
    assert!(dest.join(".bento-incomplete").exists());
}
#[test]
fn cancel_before_launch_creates_no_output() {
    let f = Fixture::new();
    let p = f.archive("cancel.zip", true);
    let out = extract_one(&p, &AtomicBool::new(true), |_| {});
    assert_eq!(out.state, "cancelled");
    assert!(out.output.is_none());
    assert!(!f.0.join("cancel").exists());
}
#[test]
fn encrypted_zip_fails_without_interactive_password_hang() {
    let f = Fixture::new();
    fs::write(f.0.join("secret.txt"), b"secret").unwrap();
    let p = f.0.join("encrypted.zip");
    assert!(Command::new("/usr/bin/zip")
        .current_dir(&f.0)
        .args(["-q", "-P", "test-only-password"])
        .arg(&p)
        .arg("secret.txt")
        .status()
        .unwrap()
        .success());
    let out = extract_one(&p, &AtomicBool::new(false), |_| {});
    assert_eq!(out.state, "failed", "{out:?}");
    assert!(out.error.unwrap().to_lowercase().contains("passphrase"));
}

fn terminal(manager: &Manager) -> Snapshot {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let s = manager.status().unwrap();
        if !active(&s.state) {
            return s;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "task did not finish: {s:?}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
#[test]
fn batch_reports_partial_failure_and_rejects_second_start_without_touching_other_paths() {
    let f = Fixture::new();
    let good = f.archive("good.zip", true);
    let bad = f.0.join("bad.zip");
    fs::write(&bad, b"bad").unwrap();
    let m = Manager::default();
    let started = m
        .start(vec![
            good.to_string_lossy().into(),
            bad.to_string_lossy().into(),
        ])
        .unwrap();
    assert!(m.start(vec![good.to_string_lossy().into()]).is_err());
    assert!(m.cancel("wrong-id").is_err());
    let end = terminal(&m);
    assert_eq!(end.id, started.id);
    assert_eq!(end.state, "partial");
    assert_eq!(end.processed, 2);
    assert_eq!(end.results[0].state, "completed");
    assert_eq!(end.results[1].state, "failed");
    let next = m.start(vec![good.to_string_lossy().into()]).unwrap();
    assert_ne!(next.id, end.id);
    assert_eq!(terminal(&m).state, "completed");
}
#[test]
fn all_sources_are_validated_before_any_output_is_created() {
    let f = Fixture::new();
    let p = f.archive("valid.zip", true);
    let m = Manager::default();
    assert!(m
        .start(vec![
            p.to_string_lossy().into(),
            f.0.join("missing.zip").to_string_lossy().into()
        ])
        .is_err());
    assert!(m.status().is_none());
    assert!(!f.0.join("valid").exists());
    assert!(m.start(vec![]).is_err());
    assert!(m.start(vec!["relative.zip".into()]).is_err());
}
#[test]
fn cancellation_kills_and_reaps_the_owned_process_and_bounds_error_output() {
    use std::time::{Duration, Instant};
    let f = Fixture::new();
    let pid_file = f.0.join("pid");
    let child_file = pid_file.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let worker = cancel.clone();
    let join = std::thread::spawn(move || {
        let mut c = Command::new("/bin/sh");
        c.args([
            "-c",
            "echo $$ > \"$BENTO_TEST_PID_FILE\"; exec /bin/sleep 30",
        ])
        .env("BENTO_TEST_PID_FILE", child_file);
        run_child(c, &worker, |_| {})
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    while !pid_file.exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let pid: i32 = fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let start = Instant::now();
    cancel.store(true, Ordering::Release);
    assert_eq!(join.join().unwrap().unwrap_err(), "cancelled");
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    let mut c = Command::new("/bin/sh");
    c.args([
        "-c",
        "i=0; while [ $i -lt 5000 ]; do echo diagnostic-line >&2; i=$((i+1)); done; exit 9",
    ]);
    let error = run_child(c, &AtomicBool::new(false), |_| {}).unwrap_err();
    assert!(error.len() < 9000);
    assert!(error.contains("diagnostic-line"));
}

fn tar_entry(out: &mut Vec<u8>, name: &str, kind: u8, link: &str, data: &[u8]) {
    let mut h = [0u8; 512];
    h[..name.len()].copy_from_slice(name.as_bytes());
    h[100..108].copy_from_slice(b"0000644\0");
    h[108..116].copy_from_slice(b"0000000\0");
    h[116..124].copy_from_slice(b"0000000\0");
    h[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
    h[136..148].copy_from_slice(b"00000000000\0");
    h[148..156].fill(b' ');
    h[156] = kind;
    h[157..157 + link.len()].copy_from_slice(link.as_bytes());
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    let sum: u32 = h.iter().map(|&b| b as u32).sum();
    h[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    out.extend(h);
    out.extend(data);
    out.resize(out.len().div_ceil(512) * 512, 0);
}
#[test]
fn traversal_and_symlink_members_cannot_write_outside_the_new_output_directory() {
    let f = Fixture::new();
    let victim = f.0.join("victim");
    fs::write(&victim, b"keep").unwrap();
    let mut data = vec![];
    tar_entry(&mut data, "../victim", b'0', "", b"changed");
    tar_entry(&mut data, "link", b'2', f.0.to_str().unwrap(), b"");
    tar_entry(&mut data, "link/escaped", b'0', "", b"escape");
    data.extend([0u8; 1024]);
    let p = f.0.join("hostile.tar");
    fs::write(&p, data).unwrap();
    let out = extract_one(&p, &AtomicBool::new(false), |_| {});
    assert_eq!(out.state, "failed", "{out:?}");
    assert_eq!(fs::read(&victim).unwrap(), b"keep");
    assert!(!f.0.join("escaped").exists());
}
#[cfg(target_os = "macos")]
#[test]
fn quarantine_is_preserved_on_extracted_files_without_following_output_symlinks() {
    let f = Fixture::new();
    let outside = f.0.join("outside.txt");
    fs::write(&outside, b"outside").unwrap();
    let outside_value = "0081;12345678;Outside;";
    assert!(Command::new("/usr/bin/xattr")
        .args(["-w", "com.apple.quarantine", outside_value])
        .arg(&outside)
        .status()
        .unwrap()
        .success());
    fs::create_dir(f.0.join("input")).unwrap();
    std::os::unix::fs::symlink(&outside, f.0.join("input/outside-link")).unwrap();
    let p = f.archive("download.tar", false);
    let value = "0081;12345678;Bento-Test;";
    assert!(Command::new("/usr/bin/xattr")
        .args(["-w", "com.apple.quarantine", value])
        .arg(&p)
        .status()
        .unwrap()
        .success());
    let out = extract_one(&p, &AtomicBool::new(false), |_| {});
    assert_eq!(out.state, "completed", "{out:?}");
    let dest = PathBuf::from(out.output.unwrap());
    let attr = Command::new("/usr/bin/xattr")
        .args(["-p", "com.apple.quarantine"])
        .arg(dest.join("子目录/测试 文件.txt"))
        .output()
        .unwrap();
    assert!(attr.status.success());
    assert_eq!(String::from_utf8(attr.stdout).unwrap().trim(), value);
    assert!(fs::symlink_metadata(dest.join("outside-link"))
        .unwrap()
        .file_type()
        .is_symlink());
    let outside_attr = Command::new("/usr/bin/xattr")
        .args(["-p", "com.apple.quarantine"])
        .arg(outside)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(outside_attr.stdout).unwrap().trim(),
        outside_value
    );
}
#[test]
fn cancellation_and_stop_finish_the_batch_and_do_not_cancel_later_jobs() {
    let f = Fixture::new();
    let p = f.archive("stop.zip", true);
    let m = Manager::default();
    let first = m.start(vec![p.to_string_lossy().into()]).unwrap();
    let c = m.cancel(&first.id).unwrap();
    assert_eq!(c.state, "cancelling");
    m.stop();
    assert_eq!(m.status().unwrap().state, "cancelled");
    m.start(vec![p.to_string_lossy().into()]).unwrap();
    assert_eq!(terminal(&m).state, "completed");
    m.closing.store(true, Ordering::Release);
    assert!(m.start(vec![p.to_string_lossy().into()]).is_err());
}
#[cfg(target_os = "macos")]
#[test]
fn failed_partial_files_keep_the_source_quarantine_before_becoming_visible_as_finished() {
    let f = Fixture::new();
    let mut data = vec![];
    tar_entry(
        &mut data,
        "valid-script.sh",
        b'0',
        "",
        b"#!/bin/sh\necho test\n",
    );
    tar_entry(&mut data, "../unsafe", b'0', "", b"bad");
    data.extend([0u8; 1024]);
    let p = f.0.join("partial.tar");
    fs::write(&p, data).unwrap();
    let value = "0081;12345678;Bento-Partial;";
    assert!(Command::new("/usr/bin/xattr")
        .args(["-w", "com.apple.quarantine", value])
        .arg(&p)
        .status()
        .unwrap()
        .success());
    let out = extract_one(&p, &AtomicBool::new(false), |_| {});
    assert_eq!(out.state, "failed");
    let dest = PathBuf::from(out.output.unwrap());
    let attr = Command::new("/usr/bin/xattr")
        .args(["-p", "com.apple.quarantine"])
        .arg(dest.join("valid-script.sh"))
        .output()
        .unwrap();
    assert!(attr.status.success());
    assert_eq!(String::from_utf8(attr.stdout).unwrap().trim(), value);
}
#[cfg(target_os = "macos")]
#[test]
fn quarantine_handles_unreadable_directories_and_restores_modes_without_skipping_siblings() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let d = f.0.join("000-private");
    fs::create_dir(&d).unwrap();
    fs::write(d.join("nested.sh"), b"test").unwrap();
    fs::write(f.0.join("z-script.sh"), b"test").unwrap();
    fs::set_permissions(&d, fs::Permissions::from_mode(0o000)).unwrap();
    let result = apply_quarantine(&f.0, b"0081;12345678;Mode-Test;");
    // Restore only after observing production's mode restoration, including on test failure.
    let mode = fs::metadata(&d).unwrap().permissions().mode() & 0o777;
    fs::set_permissions(&d, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(mode, 0);
    for file in [d.join("nested.sh"), f.0.join("z-script.sh")] {
        let attr = Command::new("/usr/bin/xattr")
            .args(["-p", "com.apple.quarantine"])
            .arg(file)
            .output()
            .unwrap();
        assert!(attr.status.success());
        assert_eq!(
            String::from_utf8(attr.stdout).unwrap().trim(),
            "0081;12345678;Mode-Test;"
        );
    }
}
