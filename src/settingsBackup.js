import { MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH } from './sidebarWidth.js'

export const MAX_BACKUP_BYTES = 1024 * 1024
const KEYS = ['showHidden', 'showSidebar', 'sidebarWidth', 'autoRefresh', 'alwaysOnTop', 'enterAction', 'searchPaths', 'searchPrefs', 'favorites']
const invalid = () => { throw new Error('设置备份格式无效，未更改任何设置。') }
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const path = value => typeof value === 'string' && value.startsWith('/') && !value.includes('\0') && value.length <= 4096
const list = value => Array.isArray(value) && value.length <= 256

function validate(document) {
  if (!exact(document, ['format', 'version', 'preferences']) || document.format !== 'bento-preferences') invalid()
  if (document.version !== 1) throw new Error('不支持此设置备份版本，未更改任何设置。')
  const p = document.preferences
  if (!exact(p, KEYS)) invalid()
  if (!['showHidden', 'showSidebar', 'autoRefresh', 'alwaysOnTop'].every(key => typeof p[key] === 'boolean')) invalid()
  if (!Number.isInteger(p.sidebarWidth) || p.sidebarWidth < MIN_SIDEBAR_WIDTH || p.sidebarWidth > MAX_SIDEBAR_WIDTH) invalid()
  if (!['open', 'rename'].includes(p.enterAction)) invalid()
  if (!list(p.searchPaths) || !p.searchPaths.every(path)) invalid()
  if (!exact(p.searchPrefs, ['scope', 'sort', 'mode']) || !['pane', 'home', 'global'].includes(p.searchPrefs.scope)
    || !['btime', 'mtime', 'size', 'name', 'score'].includes(p.searchPrefs.sort) || !['name', 'content'].includes(p.searchPrefs.mode)) invalid()
  if (!list(p.favorites) || !p.favorites.every(f => exact(f, ['name', 'path']) && typeof f.name === 'string'
    && f.name.trim().length > 0 && f.name.length <= 256 && !f.name.includes('\0') && path(f.path))) invalid()
  return p
}

export function parseSettingsBackup(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) invalid()
  let document
  try { document = JSON.parse(text) } catch { invalid() }
  return validate(document)
}

export function createSettingsBackup(config) {
  const document = { format: 'bento-preferences', version: 1, preferences: Object.fromEntries(KEYS.map(key => [key, config[key]])) }
  // Copy the snapshot so ongoing React updates cannot alter a selected export.
  return { ...document, preferences: parseSettingsBackup(JSON.stringify(document)) }
}
