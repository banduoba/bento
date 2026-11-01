//! Supported macOS file operations. Finder/AppKit own progress and conflict UI.
//! No file-operation journal, staging directory, retry, or custom copy engine.
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
    kAEAlwaysInteract, kAECanSwitchLayer, kAEWaitReply, kNoTimeOut, typeNull, AEDesc, AEDisposeDesc,
    AESendMessage,
};
use objc2_foundation::{
    NSAppleEventDescriptor as Descriptor, NSArray, NSDictionary, NSError, NSFileManager, NSString,
    NSURL,
};
use std::{path::Path, ptr::NonNull, sync::mpsc};
use tauri::AppHandle;

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
    let list = Descriptor::listDescriptor();
    list.insertDescriptor_atIndex(&Descriptor::descriptorWithFileURL(&file_url(source)), 1);
    event.setParamDescriptor_forKeyword(&list, DIRECT);
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
    let parent = parent.canonicalize().map_err(|e| e.to_string())?;
    let dest = Path::new(dest).canonicalize().map_err(|e| e.to_string())?;
    Ok(parent == dest)
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
            if std::fs::symlink_metadata(source)
                .map_err(|e| e.to_string())?
                .is_dir()
                && Path::new(dest)
                    .canonicalize()
                    .map_err(|e| e.to_string())?
                    .starts_with(
                        Path::new(source)
                            .canonicalize()
                            .map_err(|e| e.to_string())?,
                    )
            {
                return Err("不能将文件夹复制或移动到其自身内部".into());
            }
            if same_parent {
                let completion = workspace(app, std::slice::from_ref(source), false)?;
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

    #[test]
    fn finder_send_allows_foreground_interaction_and_waits_for_completion() {
        use objc2_core_services::{kAECanInteract, kAENeverInteract};

        // Interaction is an enum field, not independent flags. Request appropriate
        // interaction as well as permission to bring Finder forward for it.
        let interaction_mask = (kAENeverInteract | kAECanInteract) as i32;
        assert_eq!(FINDER_SEND_MODE & interaction_mask, kAEAlwaysInteract as i32);
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
        assert_eq!(direct.numberOfItems(), 1);
        assert_eq!(
            direct
                .descriptorAtIndex(1)
                .unwrap()
                .fileURLValue()
                .unwrap()
                .path()
                .unwrap()
                .to_string(),
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
            error: None,
        };
        let done = transfer_result("/src/a", "/dst", &completion, false);
        assert!(done.ok);
        assert_eq!(done.dest, "/dst/a renamed");
        let cancelled = transfer_result("/src/b", "/dst", &completion, false);
        assert!(!cancelled.ok);
        assert!(cancelled.cancelled);
        assert!(cancelled.dest.is_empty());
        assert!(cancelled.error.is_none());
        let unknown = transfer_result("/src/c", "/dst", &Completion::default(), true);
        assert!(unknown.ok);
        assert!(unknown.dest.is_empty());
        assert!(unknown.identity.is_none());
        assert_eq!(unknown.affected_directories, vec!["/src", "/dst"]);
    }
}
