//! Open Finder's real Get Info windows. Paths are data, never script source.
use std::{
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

// Finder's information-window `visible` property is read-only. The supported
// command is `open information window`, with a resolved alias for each item.
const SCRIPT: &str = r#"on run argv
 tell application id "com.apple.finder"
  with timeout of 10 seconds
   repeat with sourcePath in argv
    open information window of (POSIX file (contents of sourcePath) as alias)
   end repeat
   activate
  end timeout
 end tell
end run"#;

fn command(paths: &[PathBuf]) -> Command {
    let mut command = Command::new("/usr/bin/osascript");
    command.arg("-e").arg(SCRIPT).args(paths);
    command
}

fn run(mut command: Command, timeout: Duration) -> Result<(), String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动系统简介：{error}"))?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => format!("读取系统简介结果失败：{error}"),
                    _ => "Finder 响应超时，请稍后再试。".into(),
                });
            }
        }
    };
    if status.success() {
        return Ok(());
    }
    let mut bytes = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        let _ = stderr.take(8192).read_to_end(&mut bytes);
    }
    let detail = String::from_utf8_lossy(&bytes);
    if detail.contains("-1743") {
        return Err(
            "请在系统设置 → 隐私与安全性 → 自动化中允许 Bento 控制 Finder，再显示简介。".into(),
        );
    }
    Err(if detail.trim().is_empty() {
        "Finder 未能打开系统简介，请稍后再试。".into()
    } else {
        format!("无法显示系统简介：{}", detail.trim())
    })
}

pub(crate) fn show(paths: &[PathBuf]) -> Result<(), String> {
    run(command(paths), Duration::from_secs(15))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_arguments_and_cannot_change_the_script() {
        let path = PathBuf::from("/tmp/中文 \" & error \"injection\".txt");
        let command = command(&[path.clone()]);
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(
            args,
            [
                std::ffi::OsStr::new("-e"),
                std::ffi::OsStr::new(SCRIPT),
                path.as_os_str()
            ]
        );
        assert!(!SCRIPT.contains("injection"));
    }

    #[test]
    fn timeout_kills_and_reaps_only_the_owned_child() {
        let mut slow = Command::new("/bin/sleep");
        slow.arg("5");
        let start = Instant::now();
        assert!(run(slow, Duration::from_millis(50))
            .unwrap_err()
            .contains("超时"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn automation_denial_and_failed_exit_are_not_reported_as_success() {
        let mut denied = Command::new("/usr/bin/osascript");
        denied.args(["-e", "error \"fixture denied\" number -1743"]);
        assert!(run(denied, Duration::from_secs(5))
            .unwrap_err()
            .contains("自动化"));
        let failure = Command::new("/usr/bin/false");
        assert!(run(failure, Duration::from_secs(5)).is_err());
    }
    #[test]
    #[ignore = "Opens and closes only temporary Finder Get Info windows; run explicitly for native UI validation"]
    fn opens_real_file_and_folder_info_windows() {
        let folder = std::env::temp_dir().join(format!("bento-info-native-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("中文 \" & error \"not-script.txt");
        let child = folder.join("folder");
        std::fs::write(&file, "Get Info test fixture").unwrap();
        std::fs::create_dir_all(&child).unwrap();
        let paths = vec![file, child];
        struct Cleanup(Vec<PathBuf>, PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = Command::new("/usr/bin/osascript")
                    .args([
                        "-e",
                        r#"on run argv
 tell application id "com.apple.finder"
  with timeout of 5 seconds
   repeat with p in argv
    try
     close information window of (POSIX file (contents of p) as alias)
    end try
   end repeat
  end timeout
 end tell
end run"#,
                    ])
                    .args(&self.0)
                    .output();
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
        let _cleanup = Cleanup(paths.clone(), folder);
        show(&paths).unwrap();
        let query = Command::new("/usr/bin/osascript")
            .args([
                "-e",
                r#"on run argv
 tell application id "com.apple.finder"
  set states to {}
  repeat with p in argv
   set end of states to visible of information window of (POSIX file (contents of p) as alias)
  end repeat
  return states
 end tell
end run"#,
            ])
            .args(&paths)
            .output()
            .unwrap();
        assert!(
            query.status.success(),
            "{}",
            String::from_utf8_lossy(&query.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&query.stdout).trim(), "true, true");
    }
}
