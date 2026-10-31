import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('./App.jsx', import.meta.url), 'utf8')
const transferSource = source.slice(source.indexOf('  // Retain only unfinished reverse moves'), source.indexOf('\n  // ⌘V 剪切:') > 0 ? source.indexOf('\n  // ⌘V 剪切:') : source.indexOf('\n  // ⌘V 剪切：'))
function transferHarness(results) {
  const invalidated = [], toasts = [], undo = []
  const deps = { api: { transfer: async () => results }, modeRef: {}, reportErrors() {}, pushUndo: (...args) => undo.push(args), basename: p => p.split('/').at(-1), parentPath: p => p.slice(0, p.lastIndexOf('/')) || '/', showRowToast: (...args) => toasts.push(args), setClip() {}, refresh: () => invalidated.push('GLOBAL'), refreshDirectories: paths => invalidated.push(...paths), alert: error => { throw error }, targetTabFor: () => 'right' }
  const transfer = new Function(...Object.keys(deps), transferSource + '\nreturn transferInto')(...Object.values(deps))
  return { transfer, invalidated, toasts, undo }
}

test('real copy operation invalidates only successful destination and binds toast to destination tab', async () => {
  const h = transferHarness([{ ok: true, source: '/source/a', dest: '/right/a' }, { ok: false, source: '/source/b', error: 'denied' }])
  await h.transfer('/right', ['/source/a', '/source/b'], 'copy', undefined, 'right')
  assert.deepEqual(h.invalidated, ['/right'])
  assert.equal(h.toasts[0][0], 'right')
})
test('real failed operation does not invalidate unrelated panes or create success feedback', async () => {
  const h = transferHarness([{ ok: false, source: '/source/a', error: 'denied' }])
  await h.transfer('/right', ['/source/a'], 'copy', undefined, 'right')
  assert.deepEqual(h.invalidated, [])
  assert.deepEqual(h.toasts, [])
})
test('real move operation invalidates successful source parent and destination only', async () => {
  const h = transferHarness([{ ok: true, source: '/source/a', dest: '/right/a' }, { ok: false, source: '/elsewhere/b', error: 'denied' }])
  await h.transfer('/right', ['/source/a', '/elsewhere/b'], 'move')
  assert.deepEqual(new Set(h.invalidated), new Set(['/source', '/right']))
})
test('copy undo carries only directories changed by the successful operation', async () => {
  const h = transferHarness([{ ok: true, source: '/source/a', dest: '/right/a' }])
  await h.transfer('/right', ['/source/a'], 'copy')
  assert.deepEqual(h.undo[0][2].directories, ['/right'])
})

test('published failed move invalidates its explicit affected directories without undo or success feedback', async () => {
  const h = transferHarness([{ ok: false, source: '/source/a', dest: '/right/a', error: 'source removal failed', affectedDirectories: ['/source', '/right'] }])
  await h.transfer('/right', ['/source/a'], 'move')
  assert.deepEqual(new Set(h.invalidated), new Set(['/source', '/right']))
  assert.deepEqual(h.toasts, [])
  assert.deepEqual(h.undo, [])
})
