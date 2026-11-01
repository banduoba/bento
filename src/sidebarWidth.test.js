import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { preferencesForDisk } from './session.js'
import { normalizeEnterAction } from './shortcuts.js'
import { normalizeSidebarWidth } from './sidebarWidth.js'

// Execute App's actual config whitelist; unrelated ZIP defaults are loaded from
// its real source without importing the dialog's native platform dependencies.
const app = await readFile(new URL('./App.jsx', import.meta.url), 'utf8')
const zip = await readFile(new URL('./components/ZipDialog.jsx', import.meta.url), 'utf8')
const zipCode = zip.slice(zip.indexOf('export const DEFAULT_ZIP_PREFS'), zip.indexOf('export const levelOf')).replaceAll('export ', '')
const normalizeZipPrefs = new Function(`${zipCode}; return normalizeZipPrefs`)()
const configCode = app.slice(app.indexOf('const defaultFavorites ='), app.indexOf('\nfunction MiniGrid('))
const sanitizeConfig = new Function('normalizeSidebarWidth', 'normalizeEnterAction', 'normalizeZipPrefs', `${configCode}; return sanitizeConfig`)(normalizeSidebarWidth, normalizeEnterAction, normalizeZipPrefs)

test('App config supplies a usable default and rejects malformed persisted widths', () => {
  for (const input of [undefined, null, NaN, Infinity, -Infinity, '300', {}, [], true]) {
    assert.equal(sanitizeConfig({ sidebarWidth: input }, '/home').sidebarWidth, 220)
  }
  assert.equal(sanitizeConfig(null, '/home').sidebarWidth, 220)
})
test('App config bounds and rounds finite widths, and real preference serialization preserves them', () => {
  for (const [input, expected] of [[0, 180], [-5, 180], [900, 520], [300.6, 301], [260, 260]]) {
    const cfg = sanitizeConfig({ sidebarWidth: input }, '/home')
    assert.equal(cfg.sidebarWidth, expected)
    const disk = JSON.parse(JSON.stringify(preferencesForDisk({ ...cfg, panes: [], layout: '4' })))
    assert.equal(sanitizeConfig(disk, '/home').sidebarWidth, expected)
    assert.equal(disk.panes, undefined)
  }
})
