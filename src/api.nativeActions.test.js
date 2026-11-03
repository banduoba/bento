import test from 'node:test'
import assert from 'node:assert/strict'
import { api as browser } from './api.js'

test('native file actions preserve complete path arrays and explicit application paths', async () => {
  const previous = globalThis.window, calls = []
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => { calls.push([command, args]); return command === 'choose_application_and_open' ? false : { defaultApp: null, apps: [] } } } }
  try {
    const { api } = await import('./api.js?native-file-actions')
    const paths = ['/home/a [1].zip', '/home/with spaces /b.zip']
    await api.listOpenWith(paths[0])
    await api.openWith(paths, '/Apps/Custom App.app')
    assert.equal(await api.chooseApplicationAndOpen(paths), false)
    await api.showGetInfo(paths)
    await api.extractArchive(paths)
    assert.deepEqual(calls, [
      ['list_open_with', { path: paths[0] }],
      ['open_with', { paths, appPath: '/Apps/Custom App.app' }],
      ['choose_application_and_open', { paths }],
      ['show_get_info', { paths }],
      ['extract_archive', { paths }],
    ])
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous }
})

test('browser application discovery is deterministic and matches the native response shape', async () => {
  const first = await browser.listOpenWith('/Users/demo/notes.txt')
  assert.deepEqual(await browser.listOpenWith('/Users/demo/notes.txt'), first)
  assert.ok(first.apps.some(app => app.path === first.defaultApp))
  assert.equal(typeof await browser.chooseApplicationAndOpen(['/Users/demo/notes.txt']), 'boolean')
})
