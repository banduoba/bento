//! 侧边栏系统图标：macOS 上用 NSWorkspace `iconForFile:` 栅格化成 PNG data URL。
//! 非 macOS（浏览器假后端 / Linux 检查）返回空图标，前端继续用内置模板图或 IconDrive。

use serde::Serialize;
use tauri::AppHandle;

#[cfg(target_os = "macos")]
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::sync::{LazyLock, Mutex};

#[derive(Serialize)]
pub struct FileIcon {
    path: String,
    /// `data:image/png;base64,...`，取不到则为 null
    icon: Option<String>,
    /// 单色模板图标。深色模式只反色这类图，彩色系统图标必须保持原色。
    template: bool,
}

const MAX_PATHS: usize = 64;
/// 侧边栏 CSS 16px；64px 位图在 Retina 上仍超过 2x。
#[cfg(target_os = "macos")]
const ICON_PX: f64 = 64.0;

#[cfg(target_os = "macos")]
static CACHE: LazyLock<Mutex<HashMap<String, (String, bool)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
pub async fn file_icons(paths: Vec<String>, app: AppHandle) -> Result<Vec<FileIcon>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        return Ok(paths
            .into_iter()
            .take(MAX_PATHS)
            .map(|path| FileIcon {
                path,
                icon: None,
                template: false,
            })
            .collect());
    }
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        // 绘图状态是线程局部的，必须在主线程画，和剪贴板写入同一约定。
        app.run_on_main_thread(move || {
            let _ = tx.send(render_all(paths));
        })
        .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())?
    }
}

#[cfg(target_os = "macos")]
fn render_all(paths: Vec<String>) -> Vec<FileIcon> {
    paths
        .into_iter()
        .take(MAX_PATHS)
        .map(|path| {
            if !path.starts_with('/') {
                return FileIcon {
                    path,
                    icon: None,
                    template: false,
                };
            }
            match cached_icon(&path) {
                Some((icon, template)) => FileIcon {
                    path,
                    icon: Some(icon),
                    template,
                },
                None => FileIcon {
                    path,
                    icon: None,
                    template: false,
                },
            }
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn cached_icon(path: &str) -> Option<(String, bool)> {
    if let Some(hit) = CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(path)
        .cloned()
    {
        return Some(hit);
    }
    let rendered = render_icon(path)?;
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_string(), rendered.clone());
    Some(rendered)
}

#[cfg(target_os = "macos")]
fn render_icon(path: &str) -> Option<(String, bool)> {
    use objc2_app_kit::{NSCalibratedRGBColorSpace, NSWorkspace};
    use objc2_foundation::{NSSize, NSString};

    let icon = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path));
    if !icon.isValid() {
        return None;
    }
    let template = icon.isTemplate();
    icon.setSize(NSSize::new(ICON_PX, ICON_PX));
    // 颜色空间名是 AppKit 导出的静态引用，内容由系统保证有效。
    let color_space = unsafe { NSCalibratedRGBColorSpace };
    let bytes = draw_png(&icon, color_space).or_else(|| tiff_png(&icon))?;
    Some((format!("data:image/png;base64,{}", b64(&bytes)), template))
}

#[cfg(target_os = "macos")]
fn draw_png(
    icon: &objc2_app_kit::NSImage,
    color_space: &objc2_foundation::NSString,
) -> Option<Vec<u8>> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageRep, NSCompositingOperation, NSGraphicsContext};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let px = ICON_PX as isize;
    let rep = unsafe {
        // planes 传 null：由 AppKit 分配像素缓冲。
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            px,
            px,
            8,
            4,
            true,
            false,
            color_space,
            0,
            0,
        )
    }?;
    let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
    let _restore = GraphicsStateGuard::push();
    NSGraphicsContext::setCurrentContext(Some(&ctx));
    let dest = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(ICON_PX, ICON_PX));
    // fromRect 为 NSZeroRect 时画出整张图。先清成透明，避免位图缓冲里的脏像素。
    let zero = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
    icon.drawInRect_fromRect_operation_fraction(dest, zero, NSCompositingOperation::Clear, 1.0);
    icon.drawInRect_fromRect_operation_fraction(
        dest,
        zero,
        NSCompositingOperation::SourceOver,
        1.0,
    );
    drop(_restore);
    png_bytes(&rep)
}

#[cfg(target_os = "macos")]
fn tiff_png(icon: &objc2_app_kit::NSImage) -> Option<Vec<u8>> {
    use objc2_app_kit::NSBitmapImageRep;
    let tiff = icon.TIFFRepresentation()?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
    png_bytes(&rep)
}

#[cfg(target_os = "macos")]
fn png_bytes(rep: &objc2_app_kit::NSBitmapImageRep) -> Option<Vec<u8>> {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRepPropertyKey};
    use objc2_foundation::NSDictionary;

    let props = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
    // 空属性字典是 PNG 导出的正确参数。
    let data =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }?;
    let bytes = data.to_vec();
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(bytes)
    } else {
        None
    }
}

/// 配对 +saveGraphicsState / +restoreGraphicsState，绘图中途失败也会还原当前上下文。
#[cfg(target_os = "macos")]
struct GraphicsStateGuard;

#[cfg(target_os = "macos")]
impl GraphicsStateGuard {
    fn push() -> Self {
        objc2_app_kit::NSGraphicsContext::saveGraphicsState_class();
        Self
    }
}

#[cfg(target_os = "macos")]
impl Drop for GraphicsStateGuard {
    fn drop(&mut self) {
        objc2_app_kit::NSGraphicsContext::restoreGraphicsState_class();
    }
}

#[cfg(any(target_os = "macos", test))]
fn b64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut chunks = data.chunks_exact(3);
    for c in chunks.by_ref() {
        let n = ((c[0] as u32) << 16) | ((c[1] as u32) << 8) | (c[2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
    }
    let rem = chunks.remainder();
    if rem.len() == 1 {
        let n = (rem[0] as u32) << 16;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem.len() == 2 {
        let n = ((rem[0] as u32) << 16) | ((rem[1] as u32) << 8);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::b64;

    #[test]
    fn base64_vectors() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(b"hello"), "aGVsbG8=");
    }
}
