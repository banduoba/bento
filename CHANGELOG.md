# Changelog

## Unreleased

- Added Copy Names in selection and Edit menus, with Shift-Command-C for newline-separated names; native file copy/paste and Option-Command-C path copying remain unchanged.

## 0.4.0 — 2026-11-03

- Improved global name matching and coverage; name and system indexes now run in parallel and stream initial results without waiting for every source. File results locate and select their file; folder results open directly.
- Added native Open With app icons and application selection, Finder Get Info, Quick Look, and Archive Utility extraction to the context menu, alongside creation, view, sort and column controls.
- Reduced file row height to 21px, refined the path bar and row corners, and kept copy-path controls in a fixed icon slot to avoid hover movement.
- Switched standard sidebar locations to macOS sidebar glyphs and improved dialog keyboard focus and accessibility.
- Added versioned manual settings backup/import and headless benchmark regression checks.
- Added privacy-conscious usage counts with an immediate opt-out in Settings → About. Reports contain only a random installation ID, app version, macOS and architecture; the owner dashboard is private.
- Updated English and Chinese documentation and separate Apple Silicon / Intel downloads.

## 0.3.1 — 2026-11-02

- Added native macOS views and menus, including focused-pane icon, list and column views. File rows now have a compact 24px height.
- Improved real file clipboard support, downloaded-file imports and PNG/TIFF image paste.
- Made file transfers more reliable, including files on hidden, non-startup APFS volumes, conflict handling, reveal-in-folder and session undo.
- Refreshed the app branding and bilingual documentation.
- Release downloads include architecture-specific Apple Silicon (`arm64`) and Intel (`x86_64`) assets. The Intel build is cross-compiled; native Intel hardware testing is pending.
