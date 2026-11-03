<p align="right">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

# Bento

<p align="center">
  <img src="./assets/readme/banner.png" alt="Bento — Tidy files. Clear focus." width="100%">
</p>

<p align="center">
  <a href="#install"><img alt="Platform" src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%2B%20Intel-0A1530?style=flat-square&logo=apple&logoColor=white"></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-4A9BF7?style=flat-square&labelColor=0A1530"></a>
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8D8?style=flat-square&labelColor=0A1530&logo=tauri&logoColor=white">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-backend-F0A050?style=flat-square&labelColor=0A1530&logo=rust&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-4A9BF7?style=flat-square&labelColor=0A1530&logo=react&logoColor=white">
</p>

<p align="center">
  <img src="./assets/readme/screenshot-main.png" alt="Bento file manager displaying four panes with sample files" width="100%">
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#keyboard-shortcuts">Shortcuts</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#status--limitations">Limitations</a> ·
  <a href="#acknowledgements">Credits</a>
</p>

## Overview

**Bento** is a lightweight multi-pane file manager for macOS. It puts several folders on screen at once — like the compartments of a bento box — so moving, comparing and organising files stops being a game of window juggling.

It is built with a **Rust** backend on **Tauri 2** and a **React 19** interface, keeps the Finder conventions you already know, and adds the things power users miss: split layouts, per-pane tabs, instant search, real drag & drop with other apps, and a QSpace-style archive dialog.

> Bento is inspired by [QSpace](https://qspace.awehunt.com/). It is an independent open-source project and is not affiliated with QSpace.

## Features

| | |
| --- | --- |
| **Multi-pane layouts** | 10 presets — single, side-by-side, stacked, 2×2, and several 3-pane arrangements. Switch with the toolbar or View menu. |
| **Tabs & workspaces** | Every pane has its own Finder-style tabs. Current pane tabs appear below all workspaces; click one to switch to that existing tab. Save whole layouts (panes, tabs, paths) as named workspaces in the sidebar. |
| **Sidebar folder tree** | Expand Home, favorites and volumes one folder level at a time. The tree starts collapsed; only expanded branches are read and watched. Folder names open in the focused pane; failed or limited reads can be retried or opened as a full folder. |
| **Instant search** | Global file-name search backed by the [fsearch](https://github.com/noahdunnagan/fsearch) index — fuzzy matching, `*` / `?` wildcards, `ext:` filters and `re:` regular expressions — plus **content search** with a side preview that highlights matching lines. |
| **Native drag & drop** | Drag files out to Finder or any other app, drop files in from anywhere, or move them between panes. It works even when Bento sits behind other windows, and drop targets are highlighted as you hover. |
| **Real clipboard** | <kbd>⌘C</kbd> puts real file URLs on the system pasteboard, so <kbd>⌘V</kbd> in Finder and other apps pastes the files themselves. Paste files from the clipboard into Bento too; PNG and TIFF images can also be pasted as files. |
| **Native file operations** | Ordinary file operations use macOS Finder/AppKit. For files on hidden, non-startup APFS volumes, Bento uses macOS FileManager with a native Keep Both / Cancel conflict dialog attached to Bento; this route has no Finder progress UI and never replaces an existing item automatically. Basic file-operation undo is available with <kbd>⌘Z</kbd> during the current session; undo receipts are session-only and there is no history or queue UI. |
| **Create Archive** | A QSpace-style dialog: choose location and name, speed / size / custom compression level, optional password, one-click mode and per-item archives. |
| **File context menu** | Open With lists compatible installed apps and offers a system app picker. Get Info opens Finder’s information window; Quick Look previews the selection. Supported archives can be expanded by macOS Archive Utility in their current folder. Creation, view, sort and column controls are also available from the menu. Copy-path buttons float into the existing row margin on hover, without reserving an empty column. |
| **Batch rename** | Replace (including regex captures such as $1), add, format (with counters and dates) and change case, with a live before/after preview. |
| **New file** | Right-click empty space in a pane and choose **新建**: Text (`未命名.txt`), Markdown (`未命名.md`), or any file you drop in `~/Library/Application Support/com.bento.app/templates/` (for example a `.docx`). The new item is renamed immediately. A clash becomes `未命名 2.txt` and never overwrites. |
| **Compact rows** | File rows use a compact 24px height. |
| **Flexible columns** | Name · Modified · Created · Size · Kind. Drag column borders to resize and right-click the header to choose columns. View settings have global defaults with per-folder overrides. The default name column is 260px; long names keep their extension visible and wider columns can scroll horizontally. |
| **Live folders** | FSEvents updates panes and expanded sub-folders as files change. File operations refresh only affected directories, even with automatic refresh disabled. Interrupted reads retain available rows and offer Retry. |
| **Keyboard-first** | Editable address bar (<kbd>⌘L</kbd>, <kbd>Tab</kbd> completes while editing), copy paths (<kbd>⌥⌘C</kbd>), <kbd>Tab</kbd> switches panes, <kbd>F5</kbd> / <kbd>F6</kbd> copy or move to the other pane, arrow-key navigation, inline folder expansion, Quick Look on <kbd>Space</kbd>, always-on-top pin (<kbd>⌥⌘T</kbd>). |
| **Remembers everything** | Window frame, layout, tabs, paths, sort order, column widths and preferences are restored on launch. Follows the system light / dark appearance. |
| **Settings backup** | Settings → Backup manually exports or imports a versioned JSON file with general/sidebar preferences, search preferences/ranges and favorites. Archive settings/passwords, sessions, tabs, workspaces, layouts and folder views are excluded. Imports replace the included preferences only after successful validation and saving. |

Name and content search both support Current Folder, Home and Global. Click a result or press Enter to open its containing folder and locate/select it in the focused pane. Hover or use the arrow keys to select or preview; the context menu’s Open action opens the item itself. Current Folder/Home scan only when you submit a search, include new unindexed files, skip directory links, and apply scope, visibility and format filters before the result cap (200 by default). Large or inaccessible trees show partial-result notices; errors offer Retry. Local scans have a 2-second soft budget, 100,000 entries, depth 64, 16 MiB per file and 64 KiB per line. Global results use the existing index/system sources and disclose uncertain coverage. Replacing a search cancels local work; an opaque index call may finish in the background while only the latest replacement waits. Dropping a downloaded attachment or pasting supported file URLs from another app imports a copy into the focused folder.

The sidebar starts at 220px wide (drag range 180–520px; double-click its divider to reset). Bento remembers the width. Inline rename grows to fit the name, wraps within the 260px default name column and visible pane, and uses an 18px line height; Enter confirms, while Escape cancels. The compact copy-path button copies the path of the item on that row. Top-bar back and forward follow the current pane's history. Settings can show a Full Disk Access shortcut when search lacks access to protected locations. About can check the latest version and open its download page; it does not silently install updates.

## Install

### Download

Choose the matching asset from the **[latest Releases page](https://github.com/banduoba/bento/releases/latest)**: `Bento_0.3.1_macOS_AppleSilicon_arm64.dmg` or `.app.zip` for Apple Silicon, and `Bento_0.3.1_macOS_Intel_x86_64.dmg` or `.app.zip` for Intel. `SHA256SUMS` lists checksums. Open the `.dmg` and drag **Bento** into `/Applications`. Intel Macs do not need Rosetta. The Intel build is cross-compiled; native Intel hardware testing is pending.

The build is not notarized by Apple, so macOS may block the first launch. Either *right-click → Open*, or clear the download quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/Bento.app
```

### Build from source

Prefer to build it yourself? It takes a few minutes the first time.

**Requirements**

- macOS on Apple Silicon (the tested target)
- [Node.js](https://nodejs.org/) 18 or newer
- [Rust](https://rustup.rs/) (stable) and the Xcode Command Line Tools (`xcode-select --install`)

**Build**

```bash
git clone https://github.com/banduoba/bento.git
cd bento
npm install
npm run build
```

The app and a disk image are written to `src-tauri/target/release/bundle/` (`macos/Bento.app` and `dmg/`). Drag `Bento.app` into `/Applications`.

**Develop**

```bash
npm run dev        # Tauri dev mode with hot reload
```

**First launch**

- The app is ad-hoc signed, so macOS may ask you to confirm the first launch (*right-click → Open*).
- Grant **Full Disk Access** in *System Settings → Privacy & Security* if you want global and content search to cover protected locations. Bento shows a hint in Settings when it is missing.
- After replacing the app with a new build, macOS may drop that permission — remove and re-add Bento in the list.

## Keyboard shortcuts

The native macOS menu bar includes Bento, File, Edit, View, Go, Window and Help menus. <kbd>⌘1</kbd>, <kbd>⌘2</kbd> and <kbd>⌘3</kbd> switch the focused pane between icon, list and column views; layout switching is available from the toolbar or View menu. Native menu labels default to the macOS system language (English, Simplified Chinese or Traditional Chinese); the React interface is currently Chinese only.

<details open>
<summary><b>Common shortcuts</b></summary>

| Shortcut | Action |
| --- | --- |
| <kbd>⌘1</kbd> · <kbd>⌘2</kbd> · <kbd>⌘3</kbd> | Icon · list · column view in the focused pane |
| <kbd>⌘T</kbd> · <kbd>⌘W</kbd> · <kbd>⌃Tab</kbd> | New tab · close tab · next tab |
| <kbd>⌘K</kbd> or <kbd>⌥⌘F</kbd> | Open search |
| <kbd>⌘L</kbd> or <kbd>⇧⌘G</kbd> | Edit the path |
| <kbd>Tab</kbd> · <kbd>⇧Tab</kbd> | Move focus between visible panes (no switch in single-pane). While the address bar is editing, Tab still completes the path |
| <kbd>F5</kbd> · <kbd>F6</kbd> | Copy / move the selection into the other pane's current folder (no-op in single-pane) |
| <kbd>⌥⌘C</kbd> | Copy the full path of the selection (one path per line) |
| <kbd>⌘[</kbd> · <kbd>⌘]</kbd> | Back · forward |
| <kbd>⌘C</kbd> · <kbd>⌘X</kbd> · <kbd>⌘V</kbd> · <kbd>⌘D</kbd> | Copy · cut · paste · duplicate |
| <kbd>⌘⌫</kbd> · <kbd>⌘Z</kbd> | Move to Trash · undo |
| <kbd>⇧⌘N</kbd> | New folder |
| <kbd>↩</kbd> | Open or rename (Settings → General → Return key; rename by default) |
| <kbd>F2</kbd> | Rename |
| <kbd>⌘↓</kbd> | Open the selection |
| <kbd>Space</kbd> | Quick Look; for one selected file, ↑ / ↓ follow the opening pane’s current file order |
| <kbd>↑</kbd> <kbd>↓</kbd> · <kbd>Home</kbd> <kbd>End</kbd> · <kbd>PgUp</kbd> <kbd>PgDn</kbd> | Move the selection |
| <kbd>→</kbd> <kbd>←</kbd> | Enter a folder / go to the parent |
| <kbd>⌫</kbd> | Go to parent folder |
| <kbd>⌘A</kbd> · <kbd>Esc</kbd> | Select all · clear selection |
| <kbd>⌘R</kbd> | Refresh |
| <kbd>⇧⌘.</kbd> | Show / hide hidden files |
| <kbd>⌥⌘S</kbd> | Toggle sidebar |
| <kbd>⌥⌘T</kbd> | Keep window on top |
| <kbd>⌘,</kbd> | Settings |

Move and Trash undo restore the original full filename. If restoration fails, the undo stays available for retry; already restored items are skipped.

</details>

## Architecture

```mermaid
flowchart LR
    UI["React 19 UI<br/>panes · tabs · dialogs"] -- "Tauri IPC" --> CMD["Rust commands<br/>src-tauri/src/lib.rs"]
    CMD --> FS["File operations<br/>Finder / AppKit · APFS fallback · zip · trash"]
    CMD --> IDX["fsearch index<br/>name + content search"]
    CMD --> WATCH["FSEvents watcher<br/>live folder refresh"]
    CMD --> MAC["AppKit bridge<br/>NSPasteboard · native drag · undo receipts"]
```

- **Frontend** — React 19, Vite 7, [@tanstack/react-virtual](https://tanstack.com/virtual). Opening a folder streams entries in batches of about 500 over a Tauri channel, and the list mounts only the visible rows, keyed by path.
- **Backend** — Rust on Tauri 2: parallel directory scans (rayon), native macOS file operations, the fsearch engine, `notify` (FSEvents) for live updates, and `objc2` for the native pasteboard and window behaviour.
- **macOS integration** — native menus, clipboard file URLs, drag and drop, downloaded attachment imports, image paste and session-scoped file-operation undo receipts.
- **Drag & drop** — a native `NSDraggingSession` via [tauri-plugin-drag](https://github.com/crabnebula-dev/drag-rs) for dragging out, and Tauri's window drag-drop events for dragging in.

```text
src/                     React UI (App, Pane, dialogs, column and drag helpers)
src-tauri/src/lib.rs     Rust commands: files, search, clipboard, watcher, archive
src-tauri/tauri.conf.json  Window and bundle configuration
```


## Status & limitations

Bento is young software (`0.3.1`). Know before you use it:

- The application interface is currently **Simplified Chinese only**; native menu labels follow the macOS preferred language (English, Simplified Chinese or Traditional Chinese).
- Select the architecture-specific release asset (`AppleSilicon_arm64` or `Intel_x86_64`). The Intel build is cross-compiled; native Intel hardware testing is pending. Intel Macs do not need Rosetta.
- Local files only — there is no SFTP / SMB / cloud connection support.
- Archive passwords use traditional ZipCrypto (readable by macOS and `unzip`, but a weak cipher), and they are passed to `zip` on the command line while compressing. The *Keep* option stores the password in plain text in the config file.

## Performance baseline

Fixture generators and a headless bench live in [`scripts/bench/README.md`](./scripts/bench/README.md) (简体中文). The scripts build 10k- and 100k-file folders and measure a directory-scan plus rename/restore proxy; they do not measure native Finder file operations or React first paint. Cold-open first paint and new-tab timing are manual steps recorded into the same JSON report. The scripts do not change how the app lists, watches, or draws files.

## Contributing

Issues and pull requests are welcome. Please run `npm run build` and, for Rust changes, `cargo test` in `src-tauri/` before submitting. For UI changes, a screenshot or short clip helps a lot.

## Acknowledgements

- [QSpace](https://qspace.awehunt.com/) for the interaction design that inspired this project
- [fsearch](https://github.com/noahdunnagan/fsearch) — the indexing and content-search engine
- [Tauri](https://tauri.app/), [tauri-plugin-drag](https://github.com/crabnebula-dev/drag-rs), [notify](https://github.com/notify-rs/notify), [rayon](https://github.com/rayon-rs/rayon), [objc2](https://github.com/madsmtm/objc2)
- [React](https://react.dev/), [Vite](https://vite.dev/) and [TanStack Virtual](https://tanstack.com/virtual)

## License

[MIT](./LICENSE) © banduoba
