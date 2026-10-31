//! 窗格打开目录的 Tauri 命令。分批、排序和取消在 `bento-fswatch` 的 `stream` 模块里，
//! 那边不依赖 Tauri，测试不用拉起 WebKit。
//!
//! `list_dir` 仍一次返回全部条目，给侧边栏、展开的子目录，以及 bench 里的整表对照。
//! 大目录走这里：大约每 500 条经 Channel 推一批，第一屏不用等整表 IPC。

use bento_fswatch::{
    begin_list_request, cancel_list_request, finish_list_request, name_sort_desc, stream_list_dir,
    DirBatch, LIST_BATCH,
};
use tauri::ipc::Channel;

struct RequestGuard(u64);

impl Drop for RequestGuard {
    fn drop(&mut self) {
        finish_list_request(self.0);
    }
}

#[tauri::command]
pub async fn list_dir_stream(
    request_id: u64,
    path: String,
    show_hidden: bool,
    sort_key: String,
    sort_dir: String,
    on_batch: Channel<DirBatch>,
) -> Result<(), String> {
    let cancel = begin_list_request(request_id);
    let _guard = RequestGuard(request_id);
    let name_desc = name_sort_desc(&sort_key, &sort_dir);
    tauri::async_runtime::spawn_blocking(move || {
        stream_list_dir(
            &path,
            show_hidden,
            LIST_BATCH,
            name_desc,
            &cancel,
            |batch| on_batch.send(batch).map_err(|err| err.to_string()),
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn cancel_list_dir(request_id: u64) {
    cancel_list_request(request_id);
}
