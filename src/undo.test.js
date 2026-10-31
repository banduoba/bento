import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parentPath } from './format.js'
import { directoryKey } from './paneFeedback.js'

// Execute the App's actual operation callbacks against the IPC boundary.
// This catches a wiring regression even if a standalone undo helper stays correct.
function harness(api) {
  const source = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
  const callbacks = source.slice(source.indexOf('  const reportErrors ='), source.indexOf('  // 描述一组条目'))
  const stack = { current: [] }, toasts = [], alerts = [], invalidated = []
  const noop = () => {}
  const build = new Function('api', 'undoStackRef', 'setUndoToast', 'alert', 'refresh', 'basename', 'setTimeout', 'clearTimeout', 'window', 'CustomEvent', 'modeRef', 'setSel', 'getClip', 'setClip', 'retainCut', 'toastTimer', 'rowToastTimer', 'setRowToast', 'cfgRef', 'visibleCount', 'activeTabOf', 'focusIdx', 'directoryKeyFor', 'parentPath', 'refreshDirectories', `${callbacks}; return { moveInto, transferInto, undoLast, doTrash }`)
  const actions = build(api, stack, t => toasts.push(t), e => alerts.push(e), noop, p => p.slice(p.lastIndexOf('/') + 1), noop, noop, { dispatchEvent: noop }, class {}, { current: null }, noop, () => null, noop, noop, {}, {}, noop, { current: { panes: [] } }, 2, noop, 0, directoryKey, parentPath, paths => invalidated.push(...paths))
  return { ...actions, stack, toasts, alerts, invalidated }
}

test('App undo restores complete original pathname after collision, in reverse order', async () => {
  const calls = []
  const moved = [{ source: '/note.txt', dest: '/dest/note copy.txt', ok: true }, { source: '/src/b', dest: '/dest/b', ok: true }]
  const api = { moveItems: async (sources, dest) => { calls.push({ sources, dest }); return moved }, restoreMoves: async moves => { calls.push(moves); return moves.map(m => ({ ...m, ok: true })) } }
  const app = harness(api)
  await app.moveInto('/dest', ['/note.txt', '/src/b'])
  assert.deepEqual(app.alerts, [])
  app.invalidated.length = 0
  await app.undoLast()
  assert.deepEqual(new Set(app.invalidated), new Set(['/', '/src', '/dest']))
  assert.deepEqual(calls[1], [{ source: '/dest/b', dest: '/src/b' }, { source: '/dest/note copy.txt', dest: '/note.txt' }])
  assert.equal(app.stack.current.length, 0)
  assert.equal(app.toasts.at(-1).undone, true)
})

test('App partial undo retains only failed items for retry and never shows full success', async () => {
  const moved = [{ source: '/src/a', dest: '/dst/a', ok: true }, { source: '/src/b', dest: '/dst/b', ok: true }]
  const calls = []
  const api = { moveItems: async () => moved, restoreMoves: async moves => { calls.push(moves); return moves.map(m => ({ ...m, ok: m.source.endsWith('/b') || calls.length > 1, error: 'occupied' })) } }
  const app = harness(api)
  await app.moveInto('/dst', moved.map(m => m.source))
  app.invalidated.length = 0
  await app.undoLast()
  assert.equal(app.stack.current.length, 1)
  assert.notEqual(app.toasts.at(-1)?.undone, true)
  assert.equal(app.alerts.length, 1)
  assert.deepEqual(new Set(app.invalidated), new Set(['/src', '/dst']))
  assert.deepEqual(app.stack.current[0].directories, ['/src', '/dst'])
  app.invalidated.length = 0
  await app.undoLast()
  assert.deepEqual(new Set(app.invalidated), new Set(['/src', '/dst']))
  assert.deepEqual(calls[1], [{ source: '/dst/a', dest: '/src/a' }])
  assert.equal(app.stack.current.length, 0)
})

test('App rejected undo remains retryable; overlapping undo executes once', async () => {
  let release
  let attempts = 0
  const api = { moveItems: async () => [{ source: '/src/a', dest: '/dst/a', ok: true }], restoreMoves: async () => { attempts++; return new Promise((_, reject) => { release = () => reject(new Error('IPC failed')) }) } }
  const app = harness(api)
  await app.moveInto('/dst', ['/src/a'])
  app.invalidated.length = 0
  const pending = app.undoLast()
  await app.undoLast()
  // Legacy implementation never calls restoreMoves; report an assertion, never hang.
  assert.equal(attempts, 1)
  release(); await pending
  assert.deepEqual(new Set(app.invalidated), new Set(['/src', '/dst']))
  assert.equal(app.stack.current.length, 1)
  assert.notEqual(app.toasts.at(-1)?.undone, true)
})

test('legacy transfer move undo also restores exact paths and retains item failures', async () => {
  const moved = [{ source: '/src/original', dest: '/dst/original copy', ok: true }]
  const app = harness({ transfer: async () => moved, restoreMoves: async () => [{ source: '/dst/original copy', dest: '/src/original', ok: false, error: 'missing source' }] })
  await app.transferInto('/dst', ['/src/original'], 'move')
  await app.undoLast()
  assert.equal(app.stack.current.length, 1)
  assert.notEqual(app.toasts.at(-1)?.undone, true)
})

test('missing undo outcomes retain retry data and cannot count as success', async () => {
  const app = harness({ moveItems: async () => [{ source: '/src/a', dest: '/dst/a', ok: true }], restoreMoves: async () => [] })
  await app.moveInto('/dst', ['/src/a'])
  await app.undoLast()
  assert.equal(app.stack.current.length, 1)
  assert.notEqual(app.toasts.at(-1)?.undone, true)
})

test('copy undo retains failed trash items without deleting successful items twice', async () => {
  const calls = [], removed = new Set()
  let failed = false
  const app = harness({
    transfer: async () => [{ source: '/src/a', dest: '/dst/a', ok: true }, { source: '/src/b', dest: '/dst/b', ok: true }],
    trash: async ([path]) => {
      calls.push(path)
      if (path === '/dst/a' && !failed) { failed = true; throw new Error('read only') }
      assert.equal(removed.has(path), false)
      removed.add(path)
    },
  })
  // A DOM row is unnecessary for these undo checks; skip toast rendering.
  globalThis.document = { querySelectorAll: () => [] }
  try {
    await app.transferInto('/dst', ['/src/a', '/src/b'], 'copy')
    await app.undoLast()
    assert.equal(app.stack.current.length, 1)
    await app.undoLast()
    assert.deepEqual(calls, ['/dst/b', '/dst/a', '/dst/a'])
    assert.equal(app.stack.current.length, 0)
  } finally { delete globalThis.document }
})

test('Trash undo restores the full original name and invalidates both original and Trash directories', async () => {
  const restores = []
  const app = harness({
    trash: async () => [{ original: '/note.txt', trashed: '/Trash/note collision.txt' }],
    restoreMoves: async moves => { restores.push(moves); return moves.map(move => ({ ...move, ok: true })) },
  })
  app.doTrash('a', ['/note.txt'])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(app.alerts, [])
  assert.equal(app.stack.current.length, 1)
  app.invalidated.length = 0
  await app.undoLast()
  assert.deepEqual(restores, [[{ source: '/Trash/note collision.txt', dest: '/note.txt' }]])
  assert.deepEqual(new Set(app.invalidated), new Set(['/', '/Trash']))
  assert.equal(app.stack.current.length, 0)
})
