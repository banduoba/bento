//! Native Finder color labels. Custom tag names and file data are left intact.
use serde::Serialize;
use std::{collections::HashSet, path::Path};

const MAX_BATCH: usize = 256;

#[derive(Debug, Serialize)]
pub(crate) struct FileLabel {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn paths(paths: Vec<String>, allow_empty: bool) -> Result<Vec<String>, String> {
    if paths.len() > MAX_BATCH || (!allow_empty && paths.is_empty()) {
        return Err(format!("一次请选择 1 到 {MAX_BATCH} 个项目"));
    }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for path in paths {
        if !Path::new(&path).is_absolute() || path.contains('\0') {
            return Err("请选择有效的绝对文件路径".into());
        }
        if seen.insert(path.clone()) {
            result.push(path);
        }
    }
    Ok(result)
}

fn item(path: String, color: Result<u8, String>) -> FileLabel {
    match color {
        Ok(color) => FileLabel {
            path,
            color: Some(color),
            error: None,
        },
        Err(error) => FileLabel {
            path,
            color: None,
            error: Some(error),
        },
    }
}

#[tauri::command]
pub(crate) async fn get_file_labels(paths: Vec<String>) -> Result<Vec<FileLabel>, String> {
    let paths = self::paths(paths, true)?;
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let color = native::read(&path);
                item(path, color)
            })
            .collect()
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn set_file_label(
    paths: Vec<String>,
    color: u8,
) -> Result<Vec<FileLabel>, String> {
    if color > 7 {
        return Err("颜色标签必须在 0 到 7 之间".into());
    }
    let paths = self::paths(paths, false)?;
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let result = native::write(&path, color).map(|_| color);
                item(path, result)
            })
            .collect()
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
mod native {
    use objc2::rc::autoreleasepool;
    use objc2_foundation::{NSNumber, NSString, NSURLLabelNumberKey, NSURL};

    pub(super) fn read(path: &str) -> Result<u8, String> {
        autoreleasepool(|_| {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let mut value = None;
            // Foundation documents this key as an NSNumber resource value.
            unsafe { url.getResourceValue_forKey_error(&mut value, NSURLLabelNumberKey) }
                .map_err(|error| error.localizedDescription().to_string())?;
            Ok(value
                .and_then(|value| value.downcast::<NSNumber>().ok())
                .map(|number| number.unsignedCharValue())
                .filter(|color| *color <= 7)
                .unwrap_or(0))
        })
    }

    pub(super) fn write(path: &str, color: u8) -> Result<(), String> {
        autoreleasepool(|_| {
            // Unlike replacing tagNames, changing only the system label number
            // preserves all existing custom names and their own metadata.
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let number = NSNumber::numberWithUnsignedChar(color);
            unsafe { url.setResourceValue_forKey_error(Some(&number), NSURLLabelNumberKey) }
                .map_err(|error| error.localizedDescription().to_string())?;
            if read(path)? != color {
                return Err("系统未能保存颜色标签，请检查此磁盘是否支持文件标签".into());
            }
            Ok(())
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    pub(super) fn read(_: &str) -> Result<u8, String> {
        Ok(0)
    }
    pub(super) fn write(_: &str, _: u8) -> Result<(), String> {
        Err("此系统不支持 macOS 颜色标签".into())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use objc2::rc::autoreleasepool;
    use objc2_foundation::{NSArray, NSString, NSURLTagNamesKey, NSURL};
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "bento-labels-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn file(&self, name: &str) -> String {
            let path = self.0.join(name);
            fs::write(&path, b"unchanged file data").unwrap();
            path.to_string_lossy().into_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn native_labels_roundtrip_and_clear_preserve_file_data_and_custom_tags() {
        let fixture = Fixture::new();
        let path = fixture.file("中文 'quoted' 文件.txt");
        autoreleasepool(|_| {
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path));
            let names = NSArray::from_retained_slice(&[
                NSString::from_str("Keep Custom"),
                NSString::from_str("研究"),
            ]);
            unsafe { url.setResourceValue_forKey_error(Some(&names), NSURLTagNamesKey) }.unwrap();
            for color in [6, 7, 5, 2, 4, 3, 1, 0] {
                native::write(&path, color).unwrap();
                assert_eq!(native::read(&path).unwrap(), color);
                assert_eq!(fs::read(&path).unwrap(), b"unchanged file data");
                let fresh = NSURL::fileURLWithPath(&NSString::from_str(&path));
                let mut actual = None;
                unsafe { fresh.getResourceValue_forKey_error(&mut actual, NSURLTagNamesKey) }
                    .unwrap();
                let actual = actual.unwrap().downcast::<NSArray>().unwrap();
                assert_eq!(
                    actual
                        .iter()
                        .map(|name| name.downcast_ref::<NSString>().unwrap().to_string())
                        .collect::<Vec<_>>(),
                    ["Keep Custom", "研究"]
                );
            }
        });
    }

    #[test]
    fn folder_labels_and_partial_missing_file_errors_are_reported_per_path() {
        let fixture = Fixture::new();
        let folder = fixture.0.to_string_lossy().into_owned();
        let absent = fixture.0.join("missing.txt").to_string_lossy().into_owned();
        let result =
            tauri::async_runtime::block_on(set_file_label(vec![folder.clone(), absent.clone()], 2))
                .unwrap();
        assert_eq!(result[0].color, Some(2));
        assert!(result[0].error.is_none());
        assert!(result[1].error.is_some());
        assert!(!Path::new(&absent).exists());
        let result = tauri::async_runtime::block_on(get_file_labels(vec![folder, absent])).unwrap();
        assert_eq!(result[0].color, Some(2));
        assert!(result[1].error.is_some());
    }

    #[test]
    fn coloring_a_symlink_does_not_recolor_its_target() {
        let fixture = Fixture::new();
        let target = fixture.file("target.txt");
        let link = fixture.0.join("alias-link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        native::write(&target, 6).unwrap();
        native::write(&link.to_string_lossy(), 4).unwrap();
        assert_eq!(native::read(&link.to_string_lossy()).unwrap(), 4);
        assert_eq!(native::read(&target).unwrap(), 6);
        assert_eq!(fs::read(&target).unwrap(), b"unchanged file data");
    }

    #[test]
    fn invalid_batches_do_not_modify_any_file() {
        let fixture = Fixture::new();
        let path = fixture.file("a.txt");
        native::write(&path, 6).unwrap();
        assert!(tauri::async_runtime::block_on(set_file_label(vec![path.clone()], 8)).is_err());
        assert!(tauri::async_runtime::block_on(set_file_label(
            vec![path.clone(), "relative".into()],
            4
        ))
        .is_err());
        assert!(tauri::async_runtime::block_on(set_file_label(
            vec![path.clone(), "/bad\0path".into()],
            4
        ))
        .is_err());
        assert!(tauri::async_runtime::block_on(set_file_label(vec![], 4)).is_err());
        assert!(
            tauri::async_runtime::block_on(get_file_labels(vec![path.clone(); MAX_BATCH + 1]))
                .is_err()
        );
        assert_eq!(native::read(&path).unwrap(), 6);
        assert_eq!(fs::read(&path).unwrap(), b"unchanged file data");
    }
}
