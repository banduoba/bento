// 视图设置：全局默认 + 按文件夹覆盖。
// 磁盘上的文档是 { version, defaults, overrides }，键是规范化后的绝对路径。
// 覆盖缺失（文件夹被移动或重命名）时回落到 defaults，不抛错。
// iconSize 随文档保存。界面目前只有一种 16px 图标，未单独调节时为 null。
import { normalizeCols, normalizeVis } from './columns.js'

export const VIEW_SETTINGS_VERSION = 1

const SORT_KEYS = ['name', 'size', 'kind', 'mtime', 'btime']
const WIDTH_KEYS = ['name', 'size', 'kind', 'mtime', 'btime']
const VIS_KEYS = ['mtime', 'btime', 'size', 'kind']

export function canonicalPathKey(path) {
  if (typeof path !== 'string') return null
  const trimmed = path.trim()
  if (!trimmed.startsWith('/')) return null
  const parts = []
  for (const seg of trimmed.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return `/${parts.join('/')}`
}

function builtinView() {
  return {
    sort: { key: 'name', dir: 'asc' },
    columns: { widths: normalizeCols(null), visible: normalizeVis(null) },
    iconSize: null,
  }
}

export function normalizeIconSize(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(64, Math.max(12, Math.round(n)))
}

export function normalizeSort(raw, fallback) {
  const base = fallback || { key: 'name', dir: 'asc' }
  if (!raw || typeof raw !== 'object') return { key: base.key, dir: base.dir }
  const key = raw.key === 'date' ? 'mtime' : raw.key
  return {
    key: SORT_KEYS.includes(key) ? key : base.key,
    dir: raw.dir === 'desc' ? 'desc' : raw.dir === 'asc' ? 'asc' : base.dir,
  }
}

export function normalizeView(raw, fallback) {
  const base = fallback || builtinView()
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  const columnsRaw = src?.columns && typeof src.columns === 'object' ? src.columns : null
  const widthsIn =
    columnsRaw?.widths && typeof columnsRaw.widths === 'object'
      ? columnsRaw.widths
      : base.columns.widths
  const visibleIn =
    columnsRaw?.visible && typeof columnsRaw.visible === 'object'
      ? columnsRaw.visible
      : base.columns.visible
  return {
    sort: normalizeSort(src?.sort, base.sort),
    columns: { widths: normalizeCols(widthsIn), visible: normalizeVis(visibleIn) },
    iconSize: src && Object.prototype.hasOwnProperty.call(src, 'iconSize')
      ? normalizeIconSize(src.iconSize)
      : normalizeIconSize(base.iconSize),
  }
}

export function viewsEqual(a, b) {
  if (!a || !b) return false
  if (a.sort?.key !== b.sort?.key || a.sort?.dir !== b.sort?.dir) return false
  if ((a.iconSize ?? null) !== (b.iconSize ?? null)) return false
  for (const k of WIDTH_KEYS) {
    if ((a.columns?.widths?.[k] ?? null) !== (b.columns?.widths?.[k] ?? null)) return false
  }
  for (const k of VIS_KEYS) {
    if (!!a.columns?.visible?.[k] !== !!b.columns?.visible?.[k]) return false
  }
  return true
}

function isViewSettings(store) {
  return !!(
    store &&
    store.version === VIEW_SETTINGS_VERSION &&
    store.defaults &&
    typeof store.defaults === 'object' &&
    store.defaults.sort &&
    store.defaults.columns &&
    store.overrides &&
    typeof store.overrides === 'object' &&
    !Array.isArray(store.overrides)
  )
}

export function emptyViewSettings() {
  return { version: VIEW_SETTINGS_VERSION, defaults: builtinView(), overrides: {} }
}

export function normalizeViewSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyViewSettings()
  const defaults = normalizeView(raw.defaults, builtinView())
  const overrides = {}
  const table = raw.overrides
  if (table && typeof table === 'object' && !Array.isArray(table)) {
    for (const [path, view] of Object.entries(table)) {
      const key = canonicalPathKey(path)
      if (!key || view == null || typeof view !== 'object' || Array.isArray(view)) continue
      const normalized = normalizeView(view, defaults)
      if (!viewsEqual(normalized, defaults)) overrides[key] = normalized
    }
  }
  return { version: VIEW_SETTINGS_VERSION, defaults, overrides }
}

export function seedViewSettings(panes, focusedIdx = 0) {
  const store = emptyViewSettings()
  const pane = panes?.[focusedIdx] || panes?.[0]
  if (!pane) return store
  const tab = pane.tabs?.[pane.active ?? 0] || pane.tabs?.[0]
  return {
    version: VIEW_SETTINGS_VERSION,
    defaults: normalizeView(
      {
        sort: { key: tab?.sortKey, dir: tab?.sortDir },
        columns: { widths: pane.colWidths, visible: pane.colVisible },
        iconSize: null,
      },
      store.defaults,
    ),
    overrides: {},
  }
}

export function viewForPath(store, pathOrKey) {
  const settings = isViewSettings(store) ? store : normalizeViewSettings(store)
  try {
    const key = canonicalPathKey(pathOrKey)
    if (!key || !Object.prototype.hasOwnProperty.call(settings.overrides, key)) return settings.defaults
    const raw = settings.overrides[key]
    if (raw == null || typeof raw !== 'object') return settings.defaults
    return normalizeView(raw, settings.defaults)
  } catch {
    return settings.defaults
  }
}

export function hasFolderOverride(store, pathOrKey) {
  const settings = isViewSettings(store) ? store : normalizeViewSettings(store)
  const key = canonicalPathKey(pathOrKey)
  if (!key) return false
  return Object.prototype.hasOwnProperty.call(settings.overrides, key)
}

export function withFolderPatch(store, pathOrKey, patch) {
  const settings = isViewSettings(store) ? store : normalizeViewSettings(store)
  const key = canonicalPathKey(pathOrKey)
  if (!key) return settings
  const current = viewForPath(settings, key)
  const src = patch && typeof patch === 'object' ? patch : {}
  const next = normalizeView(
    {
      sort: src.sort ?? current.sort,
      columns: src.columns ?? current.columns,
      iconSize: Object.prototype.hasOwnProperty.call(src, 'iconSize') ? src.iconSize : current.iconSize,
    },
    current,
  )
  const existing = settings.overrides[key]
  if (existing && viewsEqual(existing, next)) return settings
  if (!existing && viewsEqual(next, settings.defaults)) return settings
  const overrides = { ...settings.overrides }
  if (viewsEqual(next, settings.defaults)) delete overrides[key]
  else overrides[key] = next
  return { version: VIEW_SETTINGS_VERSION, defaults: settings.defaults, overrides }
}

export function clearFolderOverride(store, pathOrKey) {
  const settings = isViewSettings(store) ? store : normalizeViewSettings(store)
  const key = canonicalPathKey(pathOrKey)
  if (!key || !Object.prototype.hasOwnProperty.call(settings.overrides, key)) return settings
  const overrides = { ...settings.overrides }
  delete overrides[key]
  return { version: VIEW_SETTINGS_VERSION, defaults: settings.defaults, overrides }
}

export function applyToAllFolders(store, view) {
  const settings = isViewSettings(store) ? store : normalizeViewSettings(store)
  const defaults = normalizeView(view, settings.defaults)
  if (viewsEqual(defaults, settings.defaults) && Object.keys(settings.overrides).length === 0) return settings
  return { version: VIEW_SETTINGS_VERSION, defaults, overrides: {} }
}

export function rekeyOverride(store, fromKey, toKey) {
  if (!isViewSettings(store)) return store
  const from = canonicalPathKey(fromKey)
  const to = canonicalPathKey(toKey)
  if (!from || !to || from === to) return store
  if (!Object.prototype.hasOwnProperty.call(store.overrides, from)) return store
  const overrides = { ...store.overrides }
  const moved = overrides[from]
  delete overrides[from]
  overrides[to] = moved
  return { version: VIEW_SETTINGS_VERSION, defaults: store.defaults, overrides }
}

function sameColumns(pane, columns) {
  const w = pane?.colWidths
  const v = pane?.colVisible
  if (!w || !v) return false
  for (const k of WIDTH_KEYS) {
    if ((w[k] ?? null) !== (columns.widths[k] ?? null)) return false
  }
  for (const k of VIS_KEYS) {
    if (!!v[k] !== !!columns.visible[k]) return false
  }
  return pane.colsVersion === 2
}

// 把有效视图写进窗格：标签记住排序，当前标签的列写在窗格上。已经一致时返回原数组。
export function syncPaneViews(panes, store, keyOf = canonicalPathKey) {
  if (!Array.isArray(panes)) return panes
  const settings = isViewSettings(store) ? store : normalizeViewSettings(store)
  const resolveKey = typeof keyOf === 'function' ? keyOf : canonicalPathKey
  let changed = false
  const next = panes.map((pane) => {
    if (!pane || !Array.isArray(pane.tabs)) return pane
    let tabsChanged = false
    const tabs = pane.tabs.map((tab) => {
      const view = viewForPath(settings, resolveKey(tab?.path))
      if (tab.sortKey === view.sort.key && tab.sortDir === view.sort.dir) return tab
      tabsChanged = true
      return { ...tab, sortKey: view.sort.key, sortDir: view.sort.dir }
    })
    const list = tabsChanged ? tabs : pane.tabs
    const activeIdx = Math.min(Math.max(pane.active ?? 0, 0), Math.max(list.length - 1, 0))
    const active = list[activeIdx]
    const view = active ? viewForPath(settings, resolveKey(active.path)) : settings.defaults
    if (!tabsChanged && sameColumns(pane, view.columns)) return pane
    changed = true
    return {
      ...pane,
      tabs: list,
      colWidths: { ...view.columns.widths },
      colVisible: { ...view.columns.visible },
      colsVersion: 2,
    }
  })
  return changed ? next : panes
}

// resolvePath 失败（目录已移动、不存在）时退回词法键，不把错误抛给界面。
export async function resolveViewKey(path, resolvePath) {
  const lexical = canonicalPathKey(path)
  if (!lexical) return null
  if (typeof resolvePath !== 'function') return lexical
  try {
    const resolved = await resolvePath(path)
    return canonicalPathKey(typeof resolved === 'string' ? resolved : '') || lexical
  } catch {
    return lexical
  }
}
