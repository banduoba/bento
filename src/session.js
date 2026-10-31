import { normalizeCols, normalizeVis } from './columns.js'
import { sortFromSavedTab, DEFAULT_SORT } from './viewSettings.js'

let tabSeq = 1
export const freshId = () => `t${tabSeq++}`
export const blankTab = path => ({ id: freshId(), path, history: [path], hi: 0, sortKey: DEFAULT_SORT.key, sortDir: DEFAULT_SORT.dir })
export const blankPane = path => ({ tabs: [blankTab(path)], active: 0 })
const validPath = p => typeof p === 'string' && p.startsWith('/') && !p.includes('\0')
const counts = { '1': 1, '2c': 2, '2r': 2, '4': 4, '3l1r': 3, '3l2r': 3, '3t2b': 3, '3t1b2': 3, '3c': 3, '3r': 3 }
const layoutOf = l => Object.hasOwn(counts, l) ? String(l) : '2c'
const indexOf = (n, size, fallback = 0) => Number.isInteger(n) ? Math.min(Math.max(n, 0), size - 1) : fallback

export function navigateTab(tab, { path, step } = {}) {
  if (step) {
    const hi = tab.hi + step
    return hi >= 0 && hi < tab.history.length ? { ...tab, hi, path: tab.history[hi] } : tab
  }
  if (!validPath(path) || path === tab.path) return tab
  const history = [...tab.history.slice(0, tab.hi + 1), path]
  return { ...tab, path, history, hi: history.length - 1 }
}

export function sanitizePanes(raw, home) {
  return (Array.isArray(raw) ? raw : []).map(p => {
    const rawTabs = Array.isArray(p?.tabs) && p.tabs.length ? p.tabs : [p?.path != null ? p : { path: home }]
    const tabs = rawTabs.map(t => {
      const path = validPath(t?.path) ? t.path : home
      const input = Array.isArray(t?.history) ? t.history : []
      // Preserve the selected entry when invalid entries before it are removed.
      const originalHi = indexOf(t?.hi, input.length, input.length - 1)
      let history = input.filter(validPath)
      let hi = input.slice(0, originalHi + 1).filter(validPath).length - 1
      if (!history.length || history[hi] !== path) {
        hi = history.lastIndexOf(path)
        if (hi < 0) { history = [path]; hi = 0 }
      }
      return { id: freshId(), path, history, hi, ...sortFromSavedTab(t) }
    })
    return { tabs, active: indexOf(p?.active, tabs.length), colWidths: normalizeCols(p?.colsVersion === 2 ? p.colWidths : null), colVisible: normalizeVis(p?.colsVersion === 2 ? p.colVisible : null), colsVersion: 2 }
  })
}

function snapshot(raw, home) {
  const layout = layoutOf(raw?.layout)
  const panes = sanitizePanes(raw?.panes, home)
  while (panes.length < counts[layout]) panes.push(...sanitizePanes([blankPane(home)], home))
  return { layout, panes, focusedIdx: indexOf(raw?.focusedIdx, counts[layout]) }
}

export function restoreSession(raw, legacy, home) {
  const supported = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.version === 1
  const source = supported ? raw : legacy
  const current = snapshot(source, home)
  const used = new Set()
  const workspaces = (Array.isArray(source?.workspaces) ? source.workspaces : []).map((w, i) => {
    let id = typeof w?.id === 'string' && w.id ? w.id : `w-restored-${i}`
    while (used.has(id)) id += '-copy'
    used.add(id)
    return { id, name: typeof w?.name === 'string' && w.name ? w.name : '工作区', ...snapshot(w, home) }
  })
  if (!workspaces.length) workspaces.push({ id: 'w-default', name: '默认', ...snapshot(current, home) })
  const activeWorkspace = workspaces.some(w => w.id === source?.activeWorkspace) ? source.activeWorkspace : workspaces[0].id
  return { session: { ...current, workspaces, activeWorkspace }, warning: raw != null && !supported ? '会话文档版本无法识别，已从旧配置恢复。原文档将在保存前保留恢复副本。' : null }
}

const diskPanes = panes => panes.map(p => ({ active: p.active, colWidths: p.colWidths, colVisible: p.colVisible, colsVersion: p.colsVersion, tabs: p.tabs.map(({ path, history, hi, sortKey, sortDir }) => ({ path, history, hi, sortKey, sortDir })) }))
export function sessionForDisk(c) {
  const layout = layoutOf(c.layout)
  const live = { layout, focusedIdx: indexOf(c.focusedIdx, counts[layout]), panes: diskPanes(c.panes) }
  return { version: 1, ...live, workspaces: (c.workspaces || []).map(w => ({ id: w.id, name: w.name, ...(w.id === c.activeWorkspace ? live : { layout: layoutOf(w.layout), focusedIdx: indexOf(w.focusedIdx, counts[layoutOf(w.layout)]), panes: diskPanes(w.panes) }) })), activeWorkspace: c.activeWorkspace }
}

export function preferencesForDisk(c) {
  const { layout, focusedIdx, panes, workspaces, activeWorkspace, viewSettings, stats, ...prefs } = c
  return prefs
}
