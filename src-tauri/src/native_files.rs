//! Supported macOS file operations. Finder/AppKit own ordinary progress and conflicts.
//! Hidden non-startup APFS volumes use Foundation's exact copy/move APIs.
use super::{
    check_identity, file_identity, ExpectedIdentity, FileIdentity, RestoreMove, TransferItem,
    TrashEntry, TrashResult,
};
use objc2::{
    rc::{autoreleasepool, Retained},
    AnyThread, Message,
};
use objc2_app_kit::NSWorkspace;
use objc2_core_services::{
    kAEAlwaysInteract, kAECanSwitchLayer, kAEWaitReply, kNoTimeOut, typeNull, AEDesc,
    AEDisposeDesc, AESendMessage,
};
use objc2_foundation::{
    NSAppleEventDescriptor as Descriptor, NSArray, NSDictionary, NSError, NSFileManager, NSLocale,
    NSString, NSURL,
};
use std::{
    ffi::CString,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Path, PathBuf},
    ptr::NonNull,
    sync::mpsc,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const CORE: u32 = u32::from_be_bytes(*b"core");
const DIRECT: u32 = u32::from_be_bytes(*b"----");
const INSERT_HERE: u32 = u32::from_be_bytes(*b"insh");
const FILE_URL: u32 = u32::from_be_bytes(*b"furl");
const LIST: u32 = u32::from_be_bytes(*b"list");
// AEDataModel.h: request interaction where appropriate, and permit Finder to
// come forward for it. CanInteract alone only says the receiver may try.
// Finder still decides which UI its scripting command supports.
const FINDER_SEND_MODE: i32 = (kAEWaitReply | kAEAlwaysInteract | kAECanSwitchLayer) as i32;

#[derive(Default, Debug)]
struct Completion {
    mappings: Vec<(String, String)>,
    error: Option<String>,
    cancelled: bool,
    unchanged: bool,
}

fn file_url(path: &str) -> Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(path))
}

fn url_path(url: &NSURL) -> Option<String> {
    if !url.isFileURL() {
        return None;
    }
    let path = url.path()?.to_string();
    Path::new(&path).is_absolute().then_some(path)
}

fn finder_event(event_id: u32) -> Retained<Descriptor> {
    let finder =
        Descriptor::descriptorWithBundleIdentifier(&NSString::from_str("com.apple.finder"));
    Descriptor::appleEventWithEventClass_eventID_targetDescriptor_returnID_transactionID(
        CORE,
        event_id,
        Some(&finder),
        -1,
        0,
    )
}

fn transfer_event(source: &str, dest: &str, mode: &str) -> Retained<Descriptor> {
    let event = finder_event(u32::from_be_bytes(if mode == "move" {
        *b"move"
    } else {
        *b"clon"
    }));
    // This transfer loop sends one source per event. Finder's AppleScript
    // `duplicate POSIX file … to POSIX file …` uses a scalar file URL here.
    event.setParamDescriptor_forKeyword(
        &Descriptor::descriptorWithFileURL(&file_url(source)),
        DIRECT,
    );
    event.setParamDescriptor_forKeyword(
        &Descriptor::descriptorWithFileURL(&file_url(dest)),
        INSERT_HERE,
    );
    // Finder.sdef: 'insh' is the destination. Omit 'alrp' (replacing) so Finder owns conflicts.
    event
}

fn error_status(domain: &str, code: isize, description: String) -> Completion {
    let cancelled = (domain == "NSOSStatusErrorDomain" && code == -128)
        || (domain == "NSCocoaErrorDomain" && code == 3072);
    let error = if cancelled {
        None
    } else if domain == "NSOSStatusErrorDomain" && code == -1743 {
        Some(
            "请在系统设置 → 隐私与安全性 → 自动化中允许 Bento 控制 Finder，再执行文件操作。".into(),
        )
    } else {
        Some(format!("{description} ({domain} {code})"))
    };
    Completion {
        error,
        cancelled,
        ..Default::default()
    }
}

fn ns_error(error: &NSError) -> Completion {
    error_status(
        &error.domain().to_string(),
        error.code(),
        error.localizedDescription().to_string(),
    )
}

fn transfer_result(
    source: &str,
    dest_dir: &str,
    completion: &Completion,
    completed: bool,
) -> TransferItem {
    let actual = completion
        .mappings
        .iter()
        .find(|(original, _)| original == source)
        .map(|(_, new)| new.clone());
    let ok = actual.is_some() || completed;
    let identity = actual
        .as_deref()
        .and_then(|path| file_identity(Path::new(path)).ok());
    let mut affected_directories: Vec<String> = Path::new(source)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .into_iter()
        .collect();
    if !affected_directories.iter().any(|p| p == dest_dir) {
        affected_directories.push(dest_dir.into());
    }
    TransferItem {
        source: source.into(),
        dest: actual.unwrap_or_default(),
        ok,
        identity,
        cancelled: !ok && completion.cancelled,
        unchanged: !ok && completion.unchanged,
        error: if ok || completion.cancelled {
            None
        } else {
            Some(
                completion
                    .error
                    .clone()
                    .unwrap_or_else(|| "系统未返回此文件的完成结果，请检查文件位置。".into()),
            )
        },
        affected_directories,
    }
}

fn trash_result(completion: Completion) -> TrashResult {
    TrashResult {
        entries: completion
            .mappings
            .into_iter()
            .map(|(original, trashed)| TrashEntry {
                identity: file_identity(Path::new(&trashed)).ok(),
                original,
                trashed,
            })
            .collect(),
        error: completion.error,
        cancelled: completion.cancelled,
    }
}

/// Own the Apple Event Manager's reply until ownership moves into Foundation.
struct Reply(AEDesc);
impl Reply {
    fn empty() -> Self {
        Self(AEDesc {
            descriptorType: typeNull,
            dataHandle: std::ptr::null_mut(),
        })
    }
    fn into_descriptor(mut self) -> Retained<Descriptor> {
        // initWithAEDescNoCopy takes ownership of the AEDesc's contents, not the stack storage.
        let descriptor = unsafe {
            Descriptor::initWithAEDescNoCopy(Descriptor::alloc(), NonNull::from(&mut self.0))
        };
        self.0 = Self::empty().0;
        descriptor
    }
}
impl Drop for Reply {
    fn drop(&mut self) {
        // A null descriptor is also safe to dispose; error replies are never leaked.
        unsafe {
            AEDisposeDesc(&mut self.0);
        }
    }
}

fn reply_error(reply: &Descriptor) -> Option<Completion> {
    let code = reply
        .paramDescriptorForKeyword(u32::from_be_bytes(*b"errn"))?
        .int32Value();
    if code == 0 {
        return None;
    }
    let description = reply
        .paramDescriptorForKeyword(u32::from_be_bytes(*b"errs"))
        .and_then(|d| d.stringValue())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Finder 文件操作未完成".into());
    Some(error_status(
        "NSOSStatusErrorDomain",
        code as isize,
        description,
    ))
}

fn send(event: &Descriptor) -> Result<Retained<Descriptor>, Completion> {
    let mut reply = Reply::empty();
    // Public CoreServices API. kNoTimeOut is documented in AEDataModel.h; unlike a
    // guessed Foundation seconds timeout this cannot abandon a still-running copy.
    // Called only from Tauri's blocking worker. The main AppKit run loop stays live.
    let status = unsafe {
        AESendMessage(
            event.aeDesc(),
            &mut reply.0,
            FINDER_SEND_MODE,
            kNoTimeOut as _,
        )
    };
    if status != 0 {
        return Err(error_status(
            "NSOSStatusErrorDomain",
            status as isize,
            "无法取得 Finder 的完成结果；请检查 Finder，勿重复执行仍在进行的操作".into(),
        ));
    }
    let reply = reply.into_descriptor();
    if reply.descriptorType() == typeNull {
        return Err(Completion {
            error: Some("Finder 未返回完成确认，请检查 Finder 中的操作状态。".into()),
            ..Default::default()
        });
    }
    if let Some(error) = reply_error(&reply) {
        return Err(error);
    }
    Ok(reply)
}

fn single_result(descriptor: &Descriptor) -> Option<Retained<Descriptor>> {
    if descriptor.descriptorType() == LIST {
        (descriptor.numberOfItems() == 1)
            .then(|| descriptor.descriptorAtIndex(1))
            .flatten()
    } else {
        Some(descriptor.retain())
    }
}

fn direct_path(descriptor: &Descriptor) -> Option<String> {
    let descriptor = single_result(descriptor)?;
    descriptor
        .fileURLValue()
        .or_else(|| descriptor.coerceToDescriptorType(FILE_URL)?.fileURLValue())
        .and_then(|url| url_path(&url))
}

fn resolved_reply_path(reply: &Descriptor) -> Option<String> {
    let result = single_result(&*reply.paramDescriptorForKeyword(DIRECT)?)?;
    if let Some(path) = direct_path(&result) {
        return Some(path);
    }
    // Finder usually returns an object specifier. Ask Finder to resolve that exact
    // object as a file URL, never infer the destination from the original basename.
    let event = finder_event(u32::from_be_bytes(*b"getd"));
    event.setParamDescriptor_forKeyword(&result, DIRECT);
    event.setParamDescriptor_forKeyword(
        &Descriptor::descriptorWithTypeCode(FILE_URL),
        u32::from_be_bytes(*b"rtyp"),
    );
    let resolved = send(&event).ok()?;
    direct_path(&*resolved.paramDescriptorForKeyword(DIRECT)?)
}

fn workspace_completion(
    inputs: &[(String, Retained<NSURL>)],
    mapping: &NSDictionary<NSURL, NSURL>,
    error: Option<&NSError>,
) -> Completion {
    let mut result = error.map(ns_error).unwrap_or_default();
    for (original, original_url) in inputs {
        // Retain the exact key supplied to AppKit: reconstructing a URL after Trash
        // loses directory semantics once the original path no longer exists.
        if let Some(new_url) = mapping.objectForKey(original_url) {
            if let Some(new) = url_path(&new_url) {
                result.mappings.push((original.clone(), new));
            }
        }
    }
    if result.mappings.len() != inputs.len() && result.error.is_none() && !result.cancelled {
        result.error = Some("系统未返回全部文件的完成位置，请检查文件位置。".into());
    }
    result
}

fn workspace(app: &AppHandle, paths: &[String], recycle: bool) -> Result<Completion, String> {
    let (sender, receiver) = mpsc::channel();
    let paths = paths.to_vec();
    app.run_on_main_thread(move || {
        let original_urls: Vec<_> = paths.iter().map(|path| file_url(path)).collect();
        let urls = NSArray::from_retained_slice(&original_urls);
        // The escaping block owns these retained NSURLs and request strings until
        // AppKit finishes, independently of this stack frame and its input array.
        let inputs: Vec<_> = paths.into_iter().zip(original_urls).collect();
        let callback = block2::RcBlock::new(
            move |mapping: NonNull<NSDictionary<NSURL, NSURL>>, error: *mut NSError| {
                // AppKit owns these objects for the duration of this callback. Copy only
                // Rust strings/errors across the channel; no borrowed Objective-C value escapes.
                let mapping = unsafe { mapping.as_ref() };
                let result = workspace_completion(&inputs, mapping, unsafe { error.as_ref() });
                // Receiver may disappear during shutdown; that does not cancel/retry system work.
                let _ = sender.send(result);
            },
        );
        // These APIs call back on their originating dispatch queue. Starting on the
        // main queue avoids a callback stranded on a worker with no active run loop.
        if recycle {
            NSWorkspace::sharedWorkspace().recycleURLs_completionHandler(&urls, Some(&callback));
        } else {
            NSWorkspace::sharedWorkspace().duplicateURLs_completionHandler(&urls, Some(&callback));
        }
    })
    .map_err(|e| e.to_string())?;
    // This function is used only on a blocking worker, never on the AppKit thread.
    receiver
        .recv()
        .map_err(|_| "系统操作的完成回调不可用，请检查文件位置。".into())
}

fn valid_source(source: &str) -> Result<(), String> {
    let path = Path::new(source);
    if !path.is_absolute() || path.file_name().is_none() || source.contains('\0') {
        return Err("文件操作需要完整文件路径".into());
    }
    std::fs::symlink_metadata(path).map_err(|e| format!("无法读取源文件: {e}"))?;
    Ok(())
}

fn same_parent(source: &str, dest: &str) -> Result<bool, String> {
    let parent = Path::new(source)
        .parent()
        .ok_or("文件操作需要完整文件路径")?;
    let parent = std::fs::metadata(parent).map_err(|e| e.to_string())?;
    let dest = std::fs::metadata(dest).map_err(|e| e.to_string())?;
    Ok(parent.dev() == dest.dev() && parent.ino() == dest.ino())
}

fn directory_contains_destination(source: &Path, dest: &Path) -> Result<bool, String> {
    let source_metadata = std::fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if !source_metadata.is_dir() {
        return Ok(false);
    }
    // canonicalize resolves symlinks to a deeper child; lexical ancestors
    // preserve the APFS firmlink spelling. Check identities along both paths.
    let canonical = dest.canonicalize().map_err(|e| e.to_string())?;
    for path in [dest, canonical.as_path()] {
        for ancestor in path.ancestors() {
            let metadata = std::fs::metadata(ancestor).map_err(|e| e.to_string())?;
            if metadata.dev() == source_metadata.dev() && metadata.ino() == source_metadata.ino() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[derive(Clone, Copy, Debug)]
struct MountFacts {
    apfs: bool,
    hidden: bool,
    writable: bool,
    device: u64,
}

// A hidden startup Data volume is ordinary Finder territory. A hidden APFS
// volume on another device needs FileManager because Finder's AE transfer can
// reject it even while Finder's own Paste succeeds.
fn needs_native_transfer(mount: MountFacts, home_device: u64) -> bool {
    mount.apfs && mount.hidden && mount.writable && mount.device != home_device
}

fn c_field(bytes: &[libc::c_char]) -> &[u8] {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast::<u8>(), end) }
}

fn facts_from_stat(stat: &libc::statfs, device: u64) -> MountFacts {
    MountFacts {
        apfs: c_field(&stat.f_fstypename) == b"apfs",
        hidden: stat.f_flags & libc::MNT_DONTBROWSE as u32 != 0,
        writable: stat.f_flags & libc::MNT_RDONLY as u32 == 0,
        device,
    }
}

fn physical_mount(device: u64) -> Option<MountFacts> {
    const MAX_MOUNTS: usize = 4096;
    let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    if count <= 0 {
        return None;
    }
    let mut capacity = (count as usize).checked_add(8)?;
    for _ in 0..3 {
        if capacity > MAX_MOUNTS {
            return None;
        }
        // getfsstat fills this caller-owned buffer. No borrowed slice can be
        // invalidated by another transfer querying the mount table.
        let mut buffer = Vec::with_capacity(capacity);
        buffer.resize_with(capacity, std::mem::MaybeUninit::<libc::statfs>::uninit);
        let bytes = capacity.checked_mul(std::mem::size_of::<libc::statfs>())?;
        let bytes: libc::c_int = bytes.try_into().ok()?;
        let written = unsafe {
            libc::getfsstat(
                buffer.as_mut_ptr().cast::<libc::statfs>(),
                bytes,
                libc::MNT_NOWAIT,
            )
        };
        if written < 0 {
            return None;
        }
        if written as usize >= capacity {
            capacity = capacity.checked_mul(2)?;
            continue;
        }
        let entries = unsafe {
            std::slice::from_raw_parts(buffer.as_ptr().cast::<libc::statfs>(), written as usize)
        };
        return entries.iter().find_map(|entry| {
            // Only APFS mounts can satisfy the route. This avoids probing
            // unrelated network mounts while looking for the actual device.
            if c_field(&entry.f_fstypename) != b"apfs" {
                return None;
            }
            let mountpoint = std::ffi::OsStr::from_bytes(c_field(&entry.f_mntonname));
            let mounted_device = std::fs::metadata(Path::new(mountpoint)).ok()?.dev();
            (mounted_device == device).then(|| facts_from_stat(entry, device))
        });
    }
    None
}

fn mount_facts(path: &Path) -> Option<MountFacts> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    // statfs follows a symlink. Classify the link's directory instead, since
    // FileManager copies the link itself and it belongs to that filesystem.
    let stat_path = if metadata.file_type().is_symlink() {
        path.parent()?
    } else {
        path
    };
    let c_path = CString::new(stat_path.as_os_str().as_bytes()).ok()?;
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::statfs(c_path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return None;
    }
    let stat = unsafe { stat.assume_init() };
    let mountpoint = std::ffi::OsStr::from_bytes(c_field(&stat.f_mntonname));
    let reported_device = std::fs::metadata(Path::new(mountpoint)).ok()?.dev();
    if reported_device != metadata.dev() {
        // APFS firmlinks can make lexical statfs report the read-only System
        // mount while the entry lives on a separate writable Data volume.
        // Resolve by device against the actual mount table, not by path name.
        physical_mount(metadata.dev())
    } else {
        Some(facts_from_stat(&stat, metadata.dev()))
    }
}

fn route_native(source: &Path, dest: &Path) -> bool {
    let Some(home) = std::env::home_dir() else {
        return false;
    };
    let Some(home_device) = std::fs::metadata(home).ok().map(|m| m.dev()) else {
        return false;
    };
    // A failed classification leaves the established Finder path in charge.
    // Source symlinks are transferred as entries on their parent filesystem.
    // Destination directory symlinks are followed by FileManager, so resolve
    // that directory before classifying the mount that will receive bytes.
    let Some(resolved_dest) = dest.canonicalize().ok() else {
        return false;
    };
    let (Some(source_mount), Some(dest_mount)) = (mount_facts(source), mount_facts(&resolved_dest))
    else {
        return false;
    };
    needs_native_transfer(source_mount, home_device)
        || needs_native_transfer(dest_mount, home_device)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CollisionChoice {
    KeepBoth,
    Cancel,
}

fn collision_choice(app: &AppHandle, path: &Path) -> CollisionChoice {
    let language = NSLocale::preferredLanguages()
        .firstObject()
        .map(|value| value.to_string().to_ascii_lowercase())
        .unwrap_or_default();
    let (message, keep, cancel) = if language.starts_with("zh-hant")
        || language.starts_with("zh-tw")
        || language.starts_with("zh-hk")
    {
        (
            format!(
                "「{}」已存在。要保留兩個檔案嗎？",
                path.file_name().unwrap_or_default().to_string_lossy()
            ),
            "保留兩者",
            "取消",
        )
    } else if language.starts_with("zh") {
        (
            format!(
                "“{}”已存在。要保留两个文件吗？",
                path.file_name().unwrap_or_default().to_string_lossy()
            ),
            "保留两者",
            "取消",
        )
    } else {
        (
            format!(
                "“{}” already exists. Keep both items?",
                path.file_name().unwrap_or_default().to_string_lossy()
            ),
            "Keep Both",
            "Cancel",
        )
    };
    let (sender, receiver) = mpsc::channel();
    let app_for_dialog = app.clone();
    if app
        .run_on_main_thread(move || {
            let Some(window) = app_for_dialog.get_webview_window("main") else {
                let _ = sender.send(CollisionChoice::Cancel);
                return;
            };
            app_for_dialog
                .dialog()
                .message(message)
                .parent(&window)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    keep.into(),
                    cancel.into(),
                ))
                .show(move |keep_both| {
                    let _ = sender.send(if keep_both {
                        CollisionChoice::KeepBoth
                    } else {
                        CollisionChoice::Cancel
                    });
                });
        })
        .is_err()
    {
        return CollisionChoice::Cancel;
    }
    receiver.recv().unwrap_or(CollisionChoice::Cancel)
}

fn free_copy_name(dest_dir: &Path, name: &str, directory: bool) -> Option<PathBuf> {
    let (stem, ext) = if directory {
        (name, "")
    } else {
        match name.rfind('.') {
            Some(index) if index > 0 => (&name[..index], &name[index..]),
            _ => (name, ""),
        }
    };
    let base = if let Some(index) = stem.rfind(" copy") {
        let rest = &stem[index + 5..];
        if rest.is_empty()
            || rest.strip_prefix(' ').is_some_and(|digits| {
                !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
            })
        {
            &stem[..index]
        } else {
            stem
        }
    } else {
        stem
    };
    for number in 0..10000 {
        let suffix = if number == 0 {
            String::new()
        } else {
            format!(" {number}")
        };
        let path = dest_dir.join(format!("{base} copy{suffix}{ext}"));
        if super::entry_available(&path) {
            return Some(path);
        }
    }
    None
}

fn native_transfer_with_choice(
    source: &str,
    dest_dir: &str,
    mode: &str,
    choose: impl FnOnce(&Path) -> CollisionChoice,
) -> Completion {
    let source_path = Path::new(source);
    let name = match source_path.file_name().and_then(|name| name.to_str()) {
        Some(name) => name,
        None => {
            return Completion {
                error: Some("无法读取文件名".into()),
                ..Default::default()
            }
        }
    };
    let mut target = Path::new(dest_dir).join(name);
    match std::fs::symlink_metadata(&target) {
        Ok(_) => {
            if choose(&target) == CollisionChoice::Cancel {
                return Completion {
                    cancelled: true,
                    unchanged: true,
                    ..Default::default()
                };
            }
            let directory = std::fs::symlink_metadata(source_path)
                .map(|m| m.is_dir())
                .unwrap_or(false);
            target = match free_copy_name(Path::new(dest_dir), name, directory) {
                Some(path) => path,
                None => {
                    return Completion {
                        error: Some("无法找到可用的副本名称".into()),
                        ..Default::default()
                    }
                }
            };
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Completion {
                error: Some(error.to_string()),
                ..Default::default()
            }
        }
    }
    let target_string = target.to_string_lossy().into_owned();
    let manager = NSFileManager::new();
    let result = if mode == "move" {
        manager.moveItemAtURL_toURL_error(&file_url(source), &file_url(&target_string))
    } else {
        manager.copyItemAtURL_toURL_error(&file_url(source), &file_url(&target_string))
    };
    match result {
        Ok(()) => Completion {
            mappings: vec![(source.into(), target_string)],
            ..Default::default()
        },
        Err(error) => ns_error(&error),
    }
}

pub(super) fn transfer(
    app: &AppHandle,
    sources: &[String],
    dest: &str,
    mode: &str,
) -> Result<Vec<TransferItem>, String> {
    if !matches!(mode, "copy" | "move") {
        return Err("不支持的文件操作".into());
    }
    if !Path::new(dest).is_absolute() || !Path::new(dest).is_dir() || dest.contains('\0') {
        return Err(format!("目标不是完整的文件夹路径: {dest}"));
    }
    let mut output = Vec::with_capacity(sources.len());
    let mut cancelled = false;
    for source in sources {
        if cancelled {
            output.push(transfer_result(
                source,
                dest,
                &Completion {
                    cancelled: true,
                    unchanged: true,
                    ..Default::default()
                },
                false,
            ));
            continue;
        }
        let result = autoreleasepool(|_| -> Result<TransferItem, String> {
            valid_source(source)?;
            let same_parent = same_parent(source, dest)?;
            if same_parent && mode == "move" {
                return Ok(transfer_result(
                    source,
                    dest,
                    &Completion {
                        mappings: vec![(source.clone(), source.clone())],
                        ..Default::default()
                    },
                    true,
                ));
            }
            if directory_contains_destination(Path::new(source), Path::new(dest))? {
                return Err("不能将文件夹复制或移动到其自身内部".into());
            }
            if same_parent {
                let completion = workspace(app, std::slice::from_ref(source), false)?;
                cancelled = completion.cancelled;
                return Ok(transfer_result(source, dest, &completion, false));
            }
            if route_native(Path::new(source), Path::new(dest)) {
                let completion = native_transfer_with_choice(source, dest, mode, |path| {
                    collision_choice(app, path)
                });
                cancelled = completion.cancelled;
                return Ok(transfer_result(source, dest, &completion, false));
            }
            match send(&transfer_event(source, dest, mode)) {
                Ok(reply) => {
                    let mappings = resolved_reply_path(&reply)
                        .map(|path| vec![(source.clone(), path)])
                        .unwrap_or_default();
                    // Successful completion with an unresolved receipt is still success;
                    // refresh and release cut state, but do not register a guessed Undo.
                    Ok(transfer_result(
                        source,
                        dest,
                        &Completion {
                            mappings,
                            ..Default::default()
                        },
                        true,
                    ))
                }
                Err(completion) => {
                    cancelled = completion.cancelled;
                    Ok(transfer_result(source, dest, &completion, false))
                }
            }
        });
        output.push(result.unwrap_or_else(|error| {
            transfer_result(
                source,
                dest,
                &Completion {
                    error: Some(error),
                    ..Default::default()
                },
                false,
            )
        }));
    }
    Ok(output)
}

fn validate_trash(paths: &[String], expected: Option<&[ExpectedIdentity]>) -> Result<(), String> {
    for path in paths {
        valid_source(path)?;
        let identity = match expected {
            Some(expected) => {
                let mut matches = expected.iter().filter(|identity| &identity.path == path);
                let identity = matches.next().ok_or("缺少撤销文件的身份信息")?;
                if matches.next().is_some() {
                    return Err("撤销文件的身份信息重复".into());
                }
                Some(FileIdentity {
                    dev: identity.dev.clone(),
                    ino: identity.ino.clone(),
                })
            }
            None => None,
        };
        check_identity(Path::new(path), identity.as_ref()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn trash(
    app: &AppHandle,
    paths: &[String],
    expected: Option<&[ExpectedIdentity]>,
) -> Result<TrashResult, String> {
    validate_trash(paths, expected)?;
    if paths.is_empty() {
        return Ok(TrashResult::default());
    }
    workspace(app, paths, true).map(trash_result)
}

pub(super) fn restore(moves: &[RestoreMove]) -> Vec<TransferItem> {
    moves
        .iter()
        .map(|request| {
            autoreleasepool(|_| {
                let source = Path::new(&request.source);
                let dest = Path::new(&request.dest);
                let destination_parent = dest
                    .parent()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let result = (|| -> Result<(), Completion> {
                    let invalid = |error: String| Completion {
                        error: Some(error),
                        ..Default::default()
                    };
                    valid_source(&request.source).map_err(invalid)?;
                    if !dest.is_absolute()
                        || dest.file_name().is_none()
                        || request.dest.contains('\0')
                    {
                        return Err(invalid("恢复需要完整文件路径".into()));
                    }
                    check_identity(source, request.identity.as_ref())
                        .map_err(|e| invalid(e.to_string()))?;
                    if source == dest {
                        return Ok(());
                    }
                    // Foundation's exact move fails when the destination already exists.
                    // No name invention, directory creation, replacement, or raw-copy fallback.
                    if !super::entry_available(dest) {
                        return Err(invalid("原位置已有文件，无法安全撤销".into()));
                    }
                    NSFileManager::new()
                        .moveItemAtURL_toURL_error(
                            &file_url(&request.source),
                            &file_url(&request.dest),
                        )
                        .map_err(|e| ns_error(&e))
                })();
                match result {
                    Ok(()) => transfer_result(
                        &request.source,
                        &destination_parent,
                        &Completion {
                            mappings: vec![(request.source.clone(), request.dest.clone())],
                            ..Default::default()
                        },
                        true,
                    ),
                    Err(completion) => {
                        transfer_result(&request.source, &destination_parent, &completion, false)
                    }
                }
            })
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;

    struct TempFixture(PathBuf);
    impl TempFixture {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "bento-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for TempFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn hidden_apfs_policy_excludes_startup_readonly_and_other_filesystems() {
        let base = MountFacts {
            apfs: true,
            hidden: true,
            writable: true,
            device: 42,
        };
        assert!(needs_native_transfer(base, 1));
        assert!(!needs_native_transfer(base, 42));
        assert!(!needs_native_transfer(
            MountFacts {
                hidden: false,
                ..base
            },
            1
        ));
        assert!(!needs_native_transfer(
            MountFacts {
                writable: false,
                ..base
            },
            1
        ));
        assert!(!needs_native_transfer(
            MountFacts {
                apfs: false,
                ..base
            },
            1
        ));
        assert!(!route_native(
            Path::new("/no/such/source"),
            Path::new("/no/such/destination")
        ));
    }

    #[test]
    fn mounted_volume_probe_resolves_firmlink_to_actual_apfs_device() {
        let Some(lexical) = std::env::var_os("BENTO_NATIVE_VOLUME_PROBE") else {
            return;
        };
        let Some(alias) = std::env::var_os("BENTO_NATIVE_VOLUME_PROBE_ALIAS") else {
            return;
        };
        let lexical = PathBuf::from(lexical);
        let alias = PathBuf::from(alias);
        let home = std::env::home_dir().unwrap();
        let home_device = std::fs::metadata(&home).unwrap().dev();
        let lexical_mount = mount_facts(&lexical).unwrap();
        let alias_mount = mount_facts(&alias).unwrap();
        assert_eq!(lexical_mount.device, alias_mount.device);
        assert_eq!(
            file_identity(&lexical).unwrap(),
            file_identity(&alias).unwrap()
        );
        assert!(needs_native_transfer(lexical_mount, home_device));
        assert!(needs_native_transfer(alias_mount, home_device));
        assert!(route_native(&lexical, &home));
        assert!(route_native(&alias, &home));
        assert!(same_parent(
            lexical.join("not-created").to_str().unwrap(),
            alias.to_str().unwrap()
        )
        .unwrap());
        assert!(directory_contains_destination(&lexical, &alias).unwrap());
    }

    #[test]
    #[ignore = "requires BENTO_TEST_VOLUME_ROOT on a writable, non-startup hidden APFS volume"]
    fn mounted_volume_native_transfer_and_undo() {
        use std::os::unix::fs::symlink;
        let volume_root =
            PathBuf::from(std::env::var_os("BENTO_TEST_VOLUME_ROOT").expect(
                "set BENTO_TEST_VOLUME_ROOT to a writable test folder on the mounted volume",
            ));
        assert!(volume_root.is_dir());
        let local = TempFixture::new("native-live-source");
        let output = local.0.join("output");
        std::fs::create_dir(&output).unwrap();
        let live = volume_root.join(format!(
            "bento-native-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // Create exactly one fresh child under the supplied parent. The guard
        // owns only that child, never the parent or any pre-existing item.
        std::fs::create_dir(&live).unwrap();
        let _live_cleanup = TempFixture(live.clone());
        let source = local.0.join("旧文件 ' 汉字.txt");
        std::fs::write(&source, b"original payload").unwrap();
        let old_time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
        std::fs::File::open(&source)
            .unwrap()
            .set_modified(old_time)
            .unwrap();
        assert!(route_native(&source, &live));
        let alias = local.0.join("destination-link");
        symlink(&live, &alias).unwrap();
        assert!(route_native(&source, &alias));

        let copied = native_transfer_with_choice(
            source.to_str().unwrap(),
            live.to_str().unwrap(),
            "copy",
            |_| panic!("unexpected collision"),
        );
        let copy_item = transfer_result(
            source.to_str().unwrap(),
            live.to_str().unwrap(),
            &copied,
            false,
        );
        assert!(copy_item.ok, "{:?}", copy_item.error);
        assert_eq!(
            copy_item.dest,
            live.join(source.file_name().unwrap()).to_str().unwrap()
        );
        assert_eq!(
            copy_item.identity,
            Some(file_identity(Path::new(&copy_item.dest)).unwrap())
        );
        assert_eq!(std::fs::read(&copy_item.dest).unwrap(), b"original payload");
        assert_eq!(
            std::fs::metadata(&copy_item.dest)
                .unwrap()
                .modified()
                .unwrap(),
            old_time
        );
        assert_eq!(std::fs::read(&source).unwrap(), b"original payload");

        let original_identity = file_identity(Path::new(&copy_item.dest)).unwrap();
        let kept = native_transfer_with_choice(
            source.to_str().unwrap(),
            live.to_str().unwrap(),
            "copy",
            |_| CollisionChoice::KeepBoth,
        );
        let keep_item = transfer_result(
            source.to_str().unwrap(),
            live.to_str().unwrap(),
            &kept,
            false,
        );
        assert!(keep_item.ok, "{:?}", keep_item.error);
        assert_eq!(
            keep_item.dest,
            live.join("旧文件 ' 汉字 copy.txt").to_str().unwrap()
        );
        assert_eq!(
            file_identity(Path::new(&copy_item.dest)).unwrap(),
            original_identity
        );
        assert_eq!(std::fs::read(&copy_item.dest).unwrap(), b"original payload");
        let cancelled = native_transfer_with_choice(
            source.to_str().unwrap(),
            live.to_str().unwrap(),
            "copy",
            |_| CollisionChoice::Cancel,
        );
        assert!(cancelled.cancelled && cancelled.mappings.is_empty());
        assert_eq!(
            file_identity(Path::new(&copy_item.dest)).unwrap(),
            original_identity
        );

        let to_move = local.0.join("move.txt");
        std::fs::write(&to_move, b"move payload").unwrap();
        let moved = native_transfer_with_choice(
            to_move.to_str().unwrap(),
            live.to_str().unwrap(),
            "move",
            |_| panic!("unexpected collision"),
        );
        let move_item = transfer_result(
            to_move.to_str().unwrap(),
            live.to_str().unwrap(),
            &moved,
            false,
        );
        assert!(move_item.ok, "{:?}", move_item.error);
        assert!(move_item.identity.is_some() && !to_move.exists());
        assert_eq!(std::fs::read(&move_item.dest).unwrap(), b"move payload");
        let undone = restore(&[RestoreMove {
            source: move_item.dest.clone(),
            dest: to_move.to_str().unwrap().into(),
            identity: move_item.identity.clone(),
        }]);
        assert!(undone[0].ok, "{:?}", undone[0].error);
        assert_eq!(std::fs::read(&to_move).unwrap(), b"move payload");
        assert!(!Path::new(&move_item.dest).exists());

        assert!(route_native(Path::new(&copy_item.dest), &output));
        let copied_out =
            native_transfer_with_choice(&copy_item.dest, output.to_str().unwrap(), "copy", |_| {
                panic!("unexpected collision")
            });
        let out_item = transfer_result(
            &copy_item.dest,
            output.to_str().unwrap(),
            &copied_out,
            false,
        );
        assert!(out_item.ok, "{:?}", out_item.error);
        assert_eq!(
            out_item.identity,
            Some(file_identity(Path::new(&out_item.dest)).unwrap())
        );
        assert_eq!(std::fs::read(&out_item.dest).unwrap(), b"original payload");

        let tree = local.0.join("folder.with.dot");
        std::fs::create_dir(&tree).unwrap();
        std::fs::write(tree.join("child"), b"child payload").unwrap();
        symlink("child", tree.join("link")).unwrap();
        let tree_copy = native_transfer_with_choice(
            tree.to_str().unwrap(),
            live.to_str().unwrap(),
            "copy",
            |_| panic!("unexpected collision"),
        );
        assert!(tree_copy.error.is_none());
        assert_eq!(
            std::fs::read(live.join("folder.with.dot/child")).unwrap(),
            b"child payload"
        );
        assert_eq!(
            std::fs::read_link(live.join("folder.with.dot/link")).unwrap(),
            Path::new("child")
        );
    }

    #[test]
    fn native_copy_move_and_receipt_use_exact_destination_and_identity() {
        let fixture = TempFixture::new("native-transfer");
        let source_dir = fixture.0.join("source");
        let dest_dir = fixture.0.join("target");
        std::fs::create_dir(&source_dir).unwrap();
        std::fs::create_dir(&dest_dir).unwrap();
        let source = source_dir.join("汉字 ' file.txt");
        std::fs::write(&source, b"original").unwrap();
        let source_string = source.to_str().unwrap();
        let dest_string = dest_dir.to_str().unwrap();
        let copied = native_transfer_with_choice(source_string, dest_string, "copy", |_| {
            panic!("no collision")
        });
        let copy_item = transfer_result(source_string, dest_string, &copied, false);
        assert!(copy_item.ok);
        assert_eq!(
            copy_item.dest,
            dest_dir.join("汉字 ' file.txt").to_str().unwrap()
        );
        assert_eq!(
            copy_item.identity,
            Some(file_identity(Path::new(&copy_item.dest)).unwrap())
        );
        assert_eq!(
            copy_item.affected_directories,
            vec![source_dir.to_str().unwrap(), dest_string]
        );
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        let moved_dir = fixture.0.join("moved");
        std::fs::create_dir(&moved_dir).unwrap();
        let moved =
            native_transfer_with_choice(source_string, moved_dir.to_str().unwrap(), "move", |_| {
                panic!("no collision")
            });
        let move_item = transfer_result(source_string, moved_dir.to_str().unwrap(), &moved, false);
        assert!(move_item.ok);
        assert_eq!(
            move_item.identity,
            Some(file_identity(Path::new(&move_item.dest)).unwrap())
        );
        assert!(!source.exists());
        assert_eq!(std::fs::read(&move_item.dest).unwrap(), b"original");
        // Undo's exact move uses this identity and destination path.
        assert!(check_identity(Path::new(&move_item.dest), move_item.identity.as_ref()).is_ok());
    }

    #[test]
    fn native_copy_preserves_directory_tree_and_symlink() {
        use std::os::unix::fs::symlink;
        let fixture = TempFixture::new("native-tree");
        let source_dir = fixture.0.join("source");
        let dest_dir = fixture.0.join("target");
        let tree = source_dir.join("folder.with.dot");
        std::fs::create_dir_all(tree.join("子目录")).unwrap();
        std::fs::create_dir(&dest_dir).unwrap();
        std::fs::write(tree.join("子目录/file"), b"data").unwrap();
        symlink("子目录/file", tree.join("link")).unwrap();
        let result = native_transfer_with_choice(
            tree.to_str().unwrap(),
            dest_dir.to_str().unwrap(),
            "copy",
            |_| panic!("no collision"),
        );
        assert!(result.error.is_none());
        let copied = dest_dir.join("folder.with.dot");
        assert_eq!(std::fs::read(copied.join("子目录/file")).unwrap(), b"data");
        assert_eq!(
            std::fs::read_link(copied.join("link")).unwrap(),
            Path::new("子目录/file")
        );
    }

    #[test]
    fn directory_guard_uses_resolved_ancestor_identity() {
        use std::os::unix::fs::symlink;
        let fixture = TempFixture::new("native-ancestor");
        let source = fixture.0.join("source");
        let child = source.join("child");
        std::fs::create_dir_all(&child).unwrap();
        let alias = fixture.0.join("alias");
        symlink(&source, &alias).unwrap();
        assert!(directory_contains_destination(&source, &alias.join("child")).unwrap());
        let direct_child_alias = fixture.0.join("direct-child");
        symlink(&child, &direct_child_alias).unwrap();
        assert!(directory_contains_destination(&source, &direct_child_alias).unwrap());
        assert!(directory_contains_destination(&source, &source).unwrap());
        assert!(!directory_contains_destination(&child, &fixture.0).unwrap());
        assert!(same_parent(
            source.join("item").to_str().unwrap(),
            alias.to_str().unwrap()
        )
        .unwrap());
    }

    #[test]
    fn collision_and_cancel_preserve_existing_entry_and_source() {
        let fixture = TempFixture::new("native-collision");
        let source_dir = fixture.0.join("source");
        let dest_dir = fixture.0.join("target");
        std::fs::create_dir(&source_dir).unwrap();
        std::fs::create_dir(&dest_dir).unwrap();
        let source = source_dir.join("file.txt");
        let existing = dest_dir.join("file.txt");
        std::fs::write(&source, b"source").unwrap();
        std::fs::write(&existing, b"existing").unwrap();
        let before = file_identity(&existing).unwrap();
        let source_before = file_identity(&source).unwrap();
        let cancelled = native_transfer_with_choice(
            source.to_str().unwrap(),
            dest_dir.to_str().unwrap(),
            "move",
            |_| CollisionChoice::Cancel,
        );
        assert!(cancelled.cancelled);
        assert!(cancelled.unchanged);
        assert!(cancelled.mappings.is_empty());
        assert_eq!(file_identity(&existing).unwrap(), before);
        assert_eq!(file_identity(&source).unwrap(), source_before);
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
        assert_eq!(std::fs::read(&existing).unwrap(), b"existing");
        let item = transfer_result(
            source.to_str().unwrap(),
            dest_dir.to_str().unwrap(),
            &cancelled,
            false,
        );
        assert!(!item.ok && item.cancelled && item.unchanged);
        assert_eq!(serde_json::to_value(&item).unwrap()["unchanged"], true);
        let kept = native_transfer_with_choice(
            source.to_str().unwrap(),
            dest_dir.to_str().unwrap(),
            "copy",
            |_| CollisionChoice::KeepBoth,
        );
        assert!(kept.error.is_none());
        assert_eq!(
            kept.mappings[0].1,
            dest_dir.join("file copy.txt").to_str().unwrap()
        );
        assert_eq!(file_identity(&existing).unwrap(), before);
        assert_eq!(std::fs::read(&existing).unwrap(), b"existing");
        assert_eq!(
            std::fs::read(dest_dir.join("file copy.txt")).unwrap(),
            b"source"
        );
    }

    #[test]
    fn file_manager_refuses_existing_destination_including_dangling_symlink() {
        use std::os::unix::fs::symlink;
        let fixture = TempFixture::new("native-no-overwrite");
        let source = fixture.0.join("source");
        let target = fixture.0.join("target");
        std::fs::write(&source, b"source").unwrap();
        symlink("missing", &target).unwrap();
        let before = file_identity(&target).unwrap();
        let result = NSFileManager::new().copyItemAtURL_toURL_error(
            &file_url(source.to_str().unwrap()),
            &file_url(target.to_str().unwrap()),
        );
        assert!(result.is_err());
        assert_eq!(file_identity(&target).unwrap(), before);
        assert_eq!(std::fs::read_link(&target).unwrap(), Path::new("missing"));
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
    }

    #[test]
    fn keep_both_names_extension_and_dotted_directory_without_overwrite() {
        let fixture = TempFixture::new("native-names");
        std::fs::write(fixture.0.join("report copy.txt"), b"unchanged").unwrap();
        assert_eq!(
            free_copy_name(&fixture.0, "report.txt", false).unwrap(),
            fixture.0.join("report copy 1.txt")
        );
        assert_eq!(
            free_copy_name(&fixture.0, "folder.with.dot", true).unwrap(),
            fixture.0.join("folder.with.dot copy")
        );
        assert_eq!(
            free_copy_name(&fixture.0, ".hidden", false).unwrap(),
            fixture.0.join(".hidden copy")
        );
    }

    #[test]
    fn finder_send_allows_foreground_interaction_and_waits_for_completion() {
        use objc2_core_services::{kAECanInteract, kAENeverInteract};

        // Interaction is an enum field, not independent flags. Request appropriate
        // interaction as well as permission to bring Finder forward for it.
        let interaction_mask = (kAENeverInteract | kAECanInteract) as i32;
        assert_eq!(
            FINDER_SEND_MODE & interaction_mask,
            kAEAlwaysInteract as i32
        );
        assert_ne!(FINDER_SEND_MODE & kAECanSwitchLayer as i32, 0);
        // A queued/no-reply send would lose exact completion and Undo receipts.
        assert_eq!(FINDER_SEND_MODE & 0x3, kAEWaitReply as i32);
    }

    #[test]
    fn owned_reply_adopts_a_descriptor_without_borrowing_the_original_storage() {
        let original = Descriptor::descriptorWithFileURL(&file_url("/tmp/original ' 汉字"));
        let mut reply = Reply::empty();
        assert_eq!(
            unsafe { objc2_core_services::AEDuplicateDesc(original.aeDesc(), &mut reply.0) },
            0
        );
        let adopted = reply.into_descriptor();
        drop(original);
        assert_eq!(
            direct_path(&adopted).as_deref(),
            Some("/tmp/original ' 汉字")
        );
        // Retained/Foundation releases the adopted data; Reply's Drop released only null.
        drop(adopted);
        drop(Reply::empty());
    }

    #[test]
    fn reply_error_and_unambiguous_receipt_are_decoded_without_sending() {
        let reply = finder_event(u32::from_be_bytes(*b"ansr"));
        reply.setParamDescriptor_forKeyword(
            &Descriptor::descriptorWithInt32(-128),
            u32::from_be_bytes(*b"errn"),
        );
        assert!(reply_error(&reply).unwrap().cancelled);
        reply.setParamDescriptor_forKeyword(
            &Descriptor::descriptorWithInt32(0),
            u32::from_be_bytes(*b"errn"),
        );
        assert!(reply_error(&reply).is_none());
        let paths = Descriptor::listDescriptor();
        paths.insertDescriptor_atIndex(
            &Descriptor::descriptorWithFileURL(&file_url("/tmp/renamed copy")),
            1,
        );
        assert_eq!(direct_path(&paths).as_deref(), Some("/tmp/renamed copy"));
        paths.insertDescriptor_atIndex(
            &Descriptor::descriptorWithFileURL(&file_url("/tmp/unexpected extra")),
            2,
        );
        assert!(
            direct_path(&paths).is_none(),
            "never associate an ambiguous list by position"
        );
        assert!(direct_path(&Descriptor::nullDescriptor()).is_none());
    }

    #[test]
    fn guarded_trash_checks_every_path_and_parent_comparison_follows_directory_aliases() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("bento-native-guards-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let source = root.join("a");
        std::fs::write(&source, "original").unwrap();
        symlink(&root, root.join("alias")).unwrap();
        let source = source.to_str().unwrap().to_string();
        let identity = file_identity(Path::new(&source)).unwrap();
        let expected = ExpectedIdentity {
            path: source.clone(),
            dev: identity.dev,
            ino: identity.ino,
        };
        assert!(validate_trash(std::slice::from_ref(&source), Some(&[])).is_err());
        assert!(validate_trash(
            std::slice::from_ref(&source),
            Some(std::slice::from_ref(&expected))
        )
        .is_ok());
        let wrong = ExpectedIdentity {
            path: source.clone(),
            dev: "0".into(),
            ino: "0".into(),
        };
        assert!(validate_trash(std::slice::from_ref(&source), Some(&[wrong])).is_err());
        assert!(same_parent(&source, root.join("alias").to_str().unwrap()).unwrap());
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        assert!(valid_source("relative/path").is_err());
    }

    #[test]
    fn workspace_receipt_survives_source_directory_disappearing_before_callback() {
        let root = std::env::temp_dir().join(format!(
            "bento-native-directory-receipt-{}",
            std::process::id()
        ));
        std::fs::create_dir(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let source = root.join("source");
        let moved = root.join("moved");
        std::fs::create_dir(&source).unwrap();
        let paths = vec![source.to_str().unwrap().to_string()];
        // NSWorkspace keys its completion dictionary by the URL it received while
        // this source was still a directory. Simulate only the filesystem transition.
        let original = file_url(&paths[0]);
        std::fs::rename(&source, &moved).unwrap();
        let new = file_url(moved.to_str().unwrap());
        let mapping = NSDictionary::from_slices(&[&*original], &[&*new]);
        let (sender, receiver) = mpsc::channel();
        let callback = {
            let inputs = vec![(paths[0].clone(), original)];
            block2::RcBlock::new(move |mapping: NonNull<NSDictionary<NSURL, NSURL>>| {
                let result = workspace_completion(&inputs, unsafe { mapping.as_ref() }, None);
                sender.send(result).unwrap();
            })
        };
        // Invoke after the original local binding and source path are gone; only
        // the escaping block retains the input key used for receipt decoding.
        callback.call((NonNull::from(&*mapping),));
        let result = trash_result(receiver.recv().unwrap());
        assert_eq!(
            result.entries.len(),
            1,
            "completed directory receipt must survive source disappearance"
        );
        assert_eq!(result.entries[0].original, paths[0]);
        assert_eq!(result.entries[0].trashed, moved.to_str().unwrap());
        assert!(result.entries[0].identity.is_some());
        assert!(result.error.is_none());
    }

    #[test]
    fn workspace_mapping_preserves_request_spelling_and_partial_success_on_cancel() {
        let paths = vec!["/tmp/source/".to_string(), "/tmp/other".to_string()];
        let inputs: Vec<_> = paths
            .iter()
            .map(|path| (path.clone(), file_url(path)))
            .collect();
        let original = &inputs[0].1;
        let new = file_url("/tmp/actual-trash/source 2");
        let mapping = NSDictionary::from_slices(&[&**original], &[&*new]);
        let error = unsafe {
            NSError::errorWithDomain_code_userInfo(
                &NSString::from_str("NSCocoaErrorDomain"),
                3072,
                None,
            )
        };
        let result = trash_result(workspace_completion(&inputs, &mapping, Some(&error)));
        assert_eq!(result.entries[0].original, "/tmp/source/");
        assert_eq!(result.entries[0].trashed, "/tmp/actual-trash/source 2");
        assert!(result.cancelled);
        assert!(result.error.is_none());
        let missing = workspace_completion(&inputs, &mapping, None);
        assert!(
            missing.error.is_some(),
            "nil NSError cannot invent success for missing mapping"
        );
    }

    // Construction only: never send events, create Workspace, or modify Finder files.
    #[test]
    fn finder_request_preserves_path_characters_and_leaves_conflicts_to_finder() {
        let event = transfer_event("/tmp/汉字 ' $;\nfile.txt", "/tmp/destination", "move");
        assert_eq!(event.eventClass(), u32::from_be_bytes(*b"core"));
        assert_eq!(event.eventID(), u32::from_be_bytes(*b"move"));
        let direct = event
            .paramDescriptorForKeyword(u32::from_be_bytes(*b"----"))
            .unwrap();
        assert_eq!(direct.descriptorType(), FILE_URL);
        assert_eq!(
            direct.fileURLValue().unwrap().path().unwrap().to_string(),
            "/tmp/汉字 ' $;\nfile.txt"
        );
        let dest = event
            .paramDescriptorForKeyword(u32::from_be_bytes(*b"insh"))
            .unwrap();
        assert_eq!(
            dest.fileURLValue().unwrap().path().unwrap().to_string(),
            "/tmp/destination"
        );
        assert!(event
            .paramDescriptorForKeyword(u32::from_be_bytes(*b"alrp"))
            .is_none());
    }

    #[test]
    fn cancellation_is_quiet_but_permission_denial_is_actionable() {
        for (domain, code) in [
            ("NSOSStatusErrorDomain", -128),
            ("NSCocoaErrorDomain", 3072),
        ] {
            let status = error_status(domain, code, "cancel".into());
            assert!(status.cancelled);
            assert!(!status.unchanged);
            assert!(status.error.is_none());
        }
        let denied = error_status("NSOSStatusErrorDomain", -1743, "denied".into());
        assert!(!denied.cancelled);
        assert!(denied.error.unwrap().contains("自动化"));
        assert!(!error_status("OtherDomain", -128, "failure".into()).cancelled);
    }

    #[test]
    fn partial_trash_failure_preserves_successful_native_mapping() {
        let result = trash_result(Completion {
            mappings: vec![("/source/a".into(), "/actual-trash/a 2".into())],
            error: Some("volume unavailable".into()),
            cancelled: false,
            unchanged: false,
        });
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].original, "/source/a");
        assert_eq!(result.entries[0].trashed, "/actual-trash/a 2");
        assert_eq!(result.error.as_deref(), Some("volume unavailable"));
    }

    #[test]
    fn partial_cancellation_keeps_known_receipt_and_never_guesses_missing_destination() {
        let completion = Completion {
            mappings: vec![("/src/a".into(), "/dst/a renamed".into())],
            cancelled: true,
            unchanged: true,
            error: None,
        };
        let done = transfer_result("/src/a", "/dst", &completion, false);
        assert!(done.ok);
        assert!(!done.unchanged);
        assert_eq!(done.dest, "/dst/a renamed");
        let cancelled = transfer_result("/src/b", "/dst", &completion, false);
        assert!(!cancelled.ok);
        assert!(cancelled.cancelled);
        assert!(cancelled.unchanged);
        assert!(cancelled.dest.is_empty());
        assert!(cancelled.error.is_none());
        let unknown = transfer_result("/src/c", "/dst", &Completion::default(), true);
        assert!(unknown.ok);
        assert!(unknown.dest.is_empty());
        assert!(unknown.identity.is_none());
        assert_eq!(unknown.affected_directories, vec!["/src", "/dst"]);
        assert!(!unknown.unchanged);
    }
}
