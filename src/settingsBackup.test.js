import test from 'node:test'
import assert from 'node:assert/strict'
import * as backup from './settingsBackup.js'
const prefs = () => ({ showHidden: true, showSidebar: false, sidebarWidth: 250, autoRefresh: false, alwaysOnTop: false, enterAction: 'rename', searchPaths: ['/资料/ 空 格 '], searchPrefs: { scope: 'home', sort: 'score', mode: 'content' }, favorites: [{ name: '资料', path: '/资料/ 空 格 ' }] })
test('backup exports the explicit preference allowlist, excluding passwords and all session/view fields', () => {
  assert.equal(typeof backup.createSettingsBackup, 'function')
  const document = backup.createSettingsBackup({ ...prefs(), zipPrefs: { password: 'secret' }, panes: [], layout: '4', workspaces: [], viewSettings: {}, extra: 'ignored' })
  assert.deepEqual(document, { format: 'bento-preferences', version: 1, preferences: prefs() })
  assert.deepEqual(backup.parseSettingsBackup(JSON.stringify(document)), prefs())
})
test('backup rejects unsupported versions, extra keys, wrong types and malformed or excessive input without partial normalization', () => {
  assert.equal(typeof backup.parseSettingsBackup, 'function')
  const doc = () => ({ format: 'bento-preferences', version: 1, preferences: prefs() })
  const invalid = [null, [], { ...doc(), version: 2 }, { ...doc(), zipPrefs: {} }, { ...doc(), preferences: { ...prefs(), zipPrefs: {} } }]
  for (const patch of [{ showHidden: 'true' }, { sidebarWidth: 179 }, { sidebarWidth: 250.1 }, { sidebarWidth: 521 }, { enterAction: 'delete' }, { searchPaths: ['relative'] }, { searchPaths: ['/bad\0path'] }, { searchPaths: Array(257).fill('/A') }, { favorites: [{ name: '', path: '/A' }] }, { favorites: [{ name: 'A', path: 'A' }] }, { searchPrefs: { scope: 'home', sort: 'bad', mode: 'name' } }]) invalid.push({ ...doc(), preferences: { ...prefs(), ...patch } })
  for (const value of invalid) assert.throws(() => backup.parseSettingsBackup(JSON.stringify(value)))
  assert.throws(() => backup.parseSettingsBackup('{broken'))
  assert.throws(() => backup.parseSettingsBackup(' '.repeat(1024 * 1024 + 1)))
  assert.throws(() => backup.parseSettingsBackup('界'.repeat(400000)))
})
