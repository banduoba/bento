import { LIST_ROW_HEIGHT } from './shortcuts.js'

// No filesystem traversal: aliases already resolved for pane roots also cover their expanded children.
export function directoryKey(path, aliases = new Map()) {
  if (typeof path !== 'string' || !path.startsWith('/')) return null
  const parts = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  const normalized = '/' + parts.join('/')
  let best = ''
  for (const prefix of aliases.keys()) {
    if ((normalized === prefix || normalized.startsWith(prefix + '/')) && prefix.length > best.length) best = prefix
  }
  return best ? aliases.get(best).replace(/\/$/, '') + normalized.slice(best.length) || '/' : normalized
}

export function marqueePaths(rows, start, end) {
  const first = Math.max(0, Math.floor(Math.min(start, end) / LIST_ROW_HEIGHT))
  const last = Math.min(rows.length - 1, Math.ceil(Math.max(start, end) / LIST_ROW_HEIGHT) - 1)
  return rows.slice(first, Math.max(first, last + 1)).filter(row => !row.isPseudo).map(row => row.path)
}

export function invalidateDirectories(versions, paths) {
  const keys = [...new Set(paths.map(path => directoryKey(path)).filter(Boolean))]
  if (!keys.length) return versions
  const next = { ...versions }
  for (const key of keys) next[key] = (next[key] || 0) + 1
  return next
}

export function bumpManualRefreshTick(ticks, tabId) {
  if (tabId == null) return ticks
  return { ...ticks, [tabId]: (ticks[tabId] || 0) + 1 }
}

export function rootRefreshKey(tick, versions, path, tabTick = 0) {
  const epoch = tabTick ? `${tick}.${tabTick}` : tick
  return `${epoch}:${versions[directoryKey(path)] || 0}`
}

export function changedDirectories(before, after, paths, keyFor = directoryKey) {
  return paths.filter(path => (before[keyFor(path)] || 0) !== (after[keyFor(path)] || 0))
}

// Fixed coordinates, but bounded by the owning pane. A conservative width avoids a first-frame spill.
export function paneToastPosition(pane, anchor) {
  const inset = Math.min(8, pane.width / 2)
  const maxWidth = Math.max(0, Math.min(420, pane.width - inset * 2))
  const preferred = anchor ? anchor.right + 8 : pane.left + inset
  const x = Math.max(pane.left + inset, Math.min(preferred, pane.right - inset - maxWidth))
  const insetY = Math.min(24, pane.height / 2)
  const y = Math.max(pane.top + insetY, Math.min(anchor ? anchor.top + anchor.height / 2 : pane.top + 48, pane.bottom - insetY))
  return { x, y, maxWidth }
}
