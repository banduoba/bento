use tauri::menu::{
    AboutMetadataBuilder, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem,
    SubmenuBuilder,
};
use tauri::{App, AppHandle, Emitter, Manager};

#[derive(Clone, Copy, PartialEq, Eq)]
enum MenuLanguage {
    SimplifiedChinese,
    TraditionalChinese,
    English,
}

#[cfg(target_os = "macos")]
fn menu_language() -> MenuLanguage {
    use objc2_foundation::NSLocale;

    let languages = NSLocale::preferredLanguages();
    if languages.count() > 0 {
        let language = languages.objectAtIndex(0).to_string();
        let language = language.to_ascii_lowercase();
        if language.starts_with("zh-hant")
            || language.starts_with("zh-tw")
            || language.starts_with("zh-hk")
        {
            return MenuLanguage::TraditionalChinese;
        }
        if language.starts_with("zh") {
            return MenuLanguage::SimplifiedChinese;
        }
    }
    MenuLanguage::English
}

#[cfg(not(target_os = "macos"))]
fn menu_language() -> MenuLanguage {
    MenuLanguage::English
}

fn label(
    language: MenuLanguage,
    english: &'static str,
    simplified: &'static str,
    traditional: &'static str,
) -> &'static str {
    match language {
        MenuLanguage::SimplifiedChinese => simplified,
        MenuLanguage::TraditionalChinese => traditional,
        MenuLanguage::English => english,
    }
}

pub fn install(app: &App) -> tauri::Result<()> {
    let language = menu_language();
    let about_meta = AboutMetadataBuilder::new()
        .name(Some("Bento"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .copyright(Some(
            "Copyright © 2026 banduoba. Released under the MIT License.",
        ))
        .comments(Some(label(
            language,
            "A lightweight multi-pane file manager for macOS.",
            "轻量级 macOS 多窗格文件管理器。",
            "輕量級 macOS 多窗格檔案管理器。",
        )))
        .website(Some("https://github.com/banduoba/bento"))
        .build();
    let about = PredefinedMenuItem::about(
        app,
        Some(label(language, "About Bento", "关于 Bento", "關於 Bento")),
        Some(about_meta),
    )?;
    let settings = MenuItemBuilder::with_id(
        "app-settings",
        label(language, "Settings…", "设置…", "設定…"),
    )
    .build(app)?;
    let hide = PredefinedMenuItem::hide(
        app,
        Some(label(language, "Hide Bento", "隐藏 Bento", "隱藏 Bento")),
    )?;
    let hide_others = PredefinedMenuItem::hide_others(
        app,
        Some(label(language, "Hide Others", "隐藏其他窗口", "隱藏其他視窗")),
    )?;
    let show_all = PredefinedMenuItem::show_all(
        app,
        Some(label(language, "Show All", "显示全部", "顯示全部")),
    )?;
    let quit = PredefinedMenuItem::quit(
        app,
        Some(label(language, "Quit Bento", "退出 Bento", "結束 Bento")),
    )?;
    let app_menu = SubmenuBuilder::new(app, "Bento")
        .item(&about)
        .separator()
        .item(&settings)
        .separator()
        .item(&hide)
        .item(&hide_others)
        .item(&show_all)
        .separator()
        .item(&quit)
        .build()?;

    let new_tab = MenuItemBuilder::with_id(
        "file-new-tab",
        label(language, "New Tab", "新建标签页", "新增標籤頁"),
    )
    .build(app)?;
    let close_tab = MenuItemBuilder::with_id(
        "file-close-tab",
        label(language, "Close Tab", "关闭标签页", "關閉標籤頁"),
    )
    .build(app)?;
    let new_folder = MenuItemBuilder::with_id(
        "file-new-folder",
        label(language, "New Folder", "新建文件夹", "新增資料夾"),
    )
    .build(app)?;
    let rename = MenuItemBuilder::with_id(
        "file-rename",
        label(language, "Rename", "重命名", "重新命名"),
    )
    .build(app)?;
    let duplicate = MenuItemBuilder::with_id(
        "file-duplicate",
        label(language, "Duplicate", "创建副本", "製作副本"),
    )
    .build(app)?;
    let trash = MenuItemBuilder::with_id(
        "file-trash",
        label(language, "Move to Trash", "移到废纸篓", "移至垃圾桶"),
    )
    .build(app)?;
    let file_menu =
        SubmenuBuilder::with_id(app, "menu-file", label(language, "File", "文件", "檔案"))
            .item(&new_tab)
            .item(&close_tab)
            .separator()
            .item(&new_folder)
            .separator()
            .item(&rename)
            .item(&duplicate)
            .item(&trash)
            .build()?;

    // Clipboard accelerators remain in WebKit so native text editors and IME keep their normal key path.
    let undo = MenuItemBuilder::with_id("edit-undo", label(language, "Undo", "撤销", "復原"))
        .enabled(false)
        .accelerator("CmdOrCtrl+Z")
        .build(app)?;
    let cut =
        MenuItemBuilder::with_id("edit-cut", label(language, "Cut", "剪切", "剪下")).build(app)?;
    let copy = MenuItemBuilder::with_id("edit-copy", label(language, "Copy", "复制", "拷貝"))
        .build(app)?;
    let copy_names = MenuItemBuilder::with_id(
        "edit-copy-names",
        label(language, "Copy Names", "复制名称", "拷貝名稱"),
    )
    .enabled(false)
    .build(app)?;
    let paste = MenuItemBuilder::with_id("edit-paste", label(language, "Paste", "粘贴", "貼上"))
        .build(app)?;
    let select_all = MenuItemBuilder::with_id(
        "edit-select-all",
        label(language, "Select All", "全选", "全選"),
    )
    .build(app)?;
    let edit_menu =
        SubmenuBuilder::with_id(app, "menu-edit", label(language, "Edit", "编辑", "編輯"))
            .item(&undo)
            .separator()
            .item(&cut)
            .item(&copy)
            .item(&paste)
            .separator()
            .item(&copy_names)
            .item(&select_all)
            .build()?;

    let icons = CheckMenuItemBuilder::with_id(
        "view-icons",
        label(language, "as Icons", "为图标", "為圖像"),
    )
    .checked(false)
    .accelerator("CmdOrCtrl+1")
    .build(app)?;
    let list =
        CheckMenuItemBuilder::with_id("view-list", label(language, "as List", "为列表", "為列表"))
            .checked(true)
            .accelerator("CmdOrCtrl+2")
            .build(app)?;
    let columns = CheckMenuItemBuilder::with_id(
        "view-columns",
        label(language, "as Columns", "为分栏", "為欄位"),
    )
    .checked(false)
    .accelerator("CmdOrCtrl+3")
    .build(app)?;
    let refresh = MenuItemBuilder::with_id(
        "view-refresh",
        label(language, "Refresh", "刷新", "重新整理"),
    )
    .build(app)?;
    let show_hidden = CheckMenuItemBuilder::with_id(
        "view-show-hidden",
        label(
            language,
            "Show Hidden Files",
            "显示隐藏文件",
            "顯示隱藏檔案",
        ),
    )
    .checked(false)
    .build(app)?;
    let one = MenuItemBuilder::with_id(
        "view-layout-one",
        label(language, "One Pane", "单窗格", "單一窗格"),
    )
    .build(app)?;
    let two = MenuItemBuilder::with_id(
        "view-layout-two",
        label(language, "Two Panes", "双窗格", "雙窗格"),
    )
    .build(app)?;
    let four = MenuItemBuilder::with_id(
        "view-layout-four",
        label(language, "Four Panes", "四窗格", "四窗格"),
    )
    .build(app)?;
    let layout = SubmenuBuilder::new(app, label(language, "Pane Layout", "窗格布局", "窗格配置"))
        .item(&one)
        .item(&two)
        .item(&four)
        .build()?;
    let view_menu =
        SubmenuBuilder::with_id(app, "menu-view", label(language, "View", "显示", "顯示"))
            .item(&icons)
            .item(&list)
            .item(&columns)
            .separator()
            .item(&refresh)
            .item(&show_hidden)
            .separator()
            .item(&layout)
            .build()?;

    let back =
        MenuItemBuilder::with_id("go-back", label(language, "Back", "后退", "返回")).build(app)?;
    let forward =
        MenuItemBuilder::with_id("go-forward", label(language, "Forward", "前进", "前進"))
            .build(app)?;
    let parent = MenuItemBuilder::with_id(
        "go-parent",
        label(language, "Enclosing Folder", "上级文件夹", "上層資料夾"),
    )
    .build(app)?;
    let home = MenuItemBuilder::with_id("go-home", label(language, "Home", "主目录", "主目錄"))
        .build(app)?;
    let downloads = MenuItemBuilder::with_id(
        "go-downloads",
        label(language, "Downloads", "下载", "下載項目"),
    )
    .build(app)?;
    let address = MenuItemBuilder::with_id(
        "go-address",
        label(language, "Go to Folder…", "前往文件夹…", "前往資料夾…"),
    )
    .build(app)?;
    let go_menu = SubmenuBuilder::with_id(app, "menu-go", label(language, "Go", "前往", "前往"))
        .item(&back)
        .item(&forward)
        .item(&parent)
        .separator()
        .item(&home)
        .item(&downloads)
        .separator()
        .item(&address)
        .build()?;

    let minimize = PredefinedMenuItem::minimize(
        app,
        Some(label(language, "Minimize", "最小化", "最小化")),
    )?;
    let zoom = PredefinedMenuItem::maximize(app, Some(label(language, "Zoom", "缩放", "縮放")))?;
    let window_menu = SubmenuBuilder::new(app, label(language, "Window", "窗口", "視窗"))
        .item(&minimize)
        .item(&zoom)
        .build()?;

    let project = MenuItemBuilder::with_id(
        "help-project",
        label(
            language,
            "Bento on GitHub",
            "Bento GitHub 页面",
            "Bento GitHub 頁面",
        ),
    )
    .build(app)?;
    let releases = MenuItemBuilder::with_id(
        "help-downloads",
        label(language, "Downloads", "下载", "下載項目"),
    )
    .build(app)?;
    let help_menu = SubmenuBuilder::new(app, label(language, "Help", "帮助", "說明"))
        .item(&project)
        .item(&releases)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &go_menu,
            &window_menu,
            &help_menu,
        ])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn dispatch(app: &AppHandle, id: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("bento-menu-command", id);
    }
}

#[tauri::command]
pub fn sync_menu_state(app: AppHandle, mode: String, show_hidden: bool, has_selection: bool, can_back: bool, can_forward: bool, can_undo: bool) {
    let Some(menu) = app.menu() else { return };
    if let Some(view) = menu.get("menu-view").and_then(|item| item.as_submenu().cloned()) {
        for (id, checked) in [
            ("view-icons", mode == "icons"),
            ("view-list", mode == "list"),
            ("view-columns", mode == "columns"),
            ("view-show-hidden", show_hidden),
        ] {
            if let Some(item) = view.get(id).and_then(|item| item.as_check_menuitem().cloned()) {
                let _ = item.set_checked(checked);
            }
        }
    }
    if let Some(file) = menu.get("menu-file").and_then(|item| item.as_submenu().cloned()) {
        for id in ["file-rename", "file-duplicate", "file-trash"] {
            if let Some(item) = file.get(id).and_then(|item| item.as_menuitem().cloned()) {
                let _ = item.set_enabled(has_selection);
            }
        }
    }
    if let Some(edit) = menu.get("menu-edit").and_then(|item| item.as_submenu().cloned()) {
        if let Some(item) = edit.get("edit-copy-names").and_then(|item| item.as_menuitem().cloned()) {
            let _ = item.set_enabled(has_selection);
        }
        if let Some(item) = edit.get("edit-undo").and_then(|item| item.as_menuitem().cloned()) {
            let _ = item.set_enabled(can_undo);
        }
    }
    if let Some(go) = menu.get("menu-go").and_then(|item| item.as_submenu().cloned()) {
        for (id, enabled) in [("go-back", can_back), ("go-forward", can_forward)] {
            if let Some(item) = go.get(id).and_then(|item| item.as_menuitem().cloned()) {
                let _ = item.set_enabled(enabled);
            }
        }
    }
}
