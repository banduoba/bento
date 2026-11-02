import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, key, deferred } from './test/AppHarness.js'

const select = async (h, paths) => {
  const pane = h.panes[0].props
  await h.run(() => pane.onSelect(pane.pane.tabs[0].id, new Set(paths)))
}

test('⌘V imports external file clipboard items into the destination at the gesture', async t => {
  const gate = deferred(), calls = []
  const h = await mountApp(t, {
    readFileClipboard: () => gate.promise,
    transfer: async (...args) => { calls.push(args); return [] },
  })
  await key(h, 'v', { metaKey: true })
  const pane = h.panes[0].props
  await h.run(() => pane.onNav(pane.pane.tabs[0].id, '/other'))
  await h.run(async () => { gate.resolve({ changeCount: 5, paths: ['/wechat/附件.pdf'] }); await gate.promise })
  assert.deepEqual(calls, [[['/wechat/附件.pdf'], '/home', 'copy']])
})

test('new system clipboard supersedes stale in-app copy and cut', async t => {
  const calls = []
  let state = { changeCount: 1, paths: ['/old'], ownerToken: null }
  const h = await mountApp(t, {
    readFileClipboard: async () => state,
    copyFilesToClipboard: async () => ({ ok: true, changeCount: state.changeCount, ownerToken: 'bento-copy' }),
    transfer: async (...args) => { calls.push(['copy', ...args]); return [] },
    moveItems: async (...args) => { calls.push(['move', ...args]); return [] },
  })
  await select(h, ['/home/selected'])
  await key(h, 'c', { metaKey: true })
  state = { changeCount: 2, paths: ['/wechat/new'], ownerToken: null }
  await key(h, 'v', { metaKey: true })
  await key(h, 'x', { metaKey: true })
  state = { changeCount: 3, paths: ['/wechat/newer'], ownerToken: null }
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(calls, [
    ['copy', ['/wechat/new'], '/home', 'copy'],
    ['copy', ['/wechat/newer'], '/home', 'copy'],
  ])
})

test('internal cut moves while system pasteboard has not changed', async t => {
  const calls = []
  const h = await mountApp(t, {
    readFileClipboard: async () => ({ changeCount: 7, paths: ['/home/selected'], ownerToken: 'cut-owner' }),
    copyFilesToClipboard: async () => ({ ok: true, changeCount: 7, ownerToken: 'cut-owner' }),
    moveItems: async (...args) => { calls.push(args); return [] },
  })
  await select(h, ['/home/selected'])
  await key(h, 'x', { metaKey: true })
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(calls, [[['/home/selected'], '/home']])
})

test('clipboard read failure never pastes stale internal files', async t => {
  const calls = []
  const h = await mountApp(t, {
    readFileClipboard: async () => { throw Error('pasteboard unavailable') },
    transfer: async (...args) => { calls.push(args); return [] },
  })
  await h.run(() => h.clipboard.setClip({ mode: 'copy', paths: ['/old'] }))
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(calls, [])
  assert.ok(h.alerts.some(message => String(message).includes('pasteboard unavailable')))
})

test('typed image paste creates an identified PNG in the gesture-time destination and Undo trashes it', async t => {
  const gate = deferred(), created = [], trashed = []
  const h = await mountApp(t, {
    readFileClipboard: async () => ({ changeCount: 12, paths: [] }),
    pasteImageFromClipboard: async (...args) => { created.push(args); return gate.promise },
    trash: async (...args) => { trashed.push(args); return { entries: [{ original: '/home/粘贴的图片.png' }] } },
  })
  await key(h, 'v', { metaKey: true })
  const pane = h.panes[0].props
  await h.run(() => pane.onNav(pane.pane.tabs[0].id, '/other'))
  await h.run(async () => {
    gate.resolve({ path: '/home/粘贴的图片.png', identity: { dev: '1', ino: '2' } })
    await gate.promise
  })
  assert.deepEqual(created, [['/home', 12]])
  await key(h, 'z', { metaKey: true })
  assert.deepEqual(trashed, [[['/home/粘贴的图片.png'], [{ path: '/home/粘贴的图片.png', dev: '1', ino: '2' }]]])
})

test('image read or write failure leaves no Undo entry and ordinary text is quiet', async t => {
  const trashed = []
  let fail = true
  const h = await mountApp(t, {
    readFileClipboard: async () => ({ changeCount: 13, paths: [] }),
    pasteImageFromClipboard: async () => { if (fail) throw Error('image decode failed'); return null },
    trash: async (...args) => { trashed.push(args); return { entries: [] } },
  })
  await key(h, 'v', { metaKey: true })
  assert.ok(h.alerts.some(message => String(message).includes('image decode failed')))
  await key(h, 'z', { metaKey: true })
  assert.deepEqual(trashed, [])
  fail = false
  const alerts = h.alerts.length
  await key(h, 'v', { metaKey: true })
  assert.equal(h.alerts.length, alerts)
})

test('failed Bento clipboard write does not hide a later external file copy', async t => {
  const copies = []
  let snapshot = { changeCount: 1, paths: [] }
  const h = await mountApp(t, {
    copyFilesToClipboard: async () => ({ ok: false, changeCount: 1, error: 'write denied' }),
    readFileClipboard: async () => snapshot,
    transfer: async (...args) => { copies.push(args); return [] },
  })
  await select(h, ['/home/old'])
  await key(h, 'c', { metaKey: true })
  snapshot = { changeCount: 2, paths: ['/wechat/new'] }
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(copies, [[['/wechat/new'], '/home', 'copy']])
})

test('Cut cannot claim an external Copy that completes before its native reply', async t => {
  const staleRead = deferred(), nativeWrite = deferred(), copies = [], moves = []
  let reads = 0
  const external = { changeCount: 9, paths: ['/wechat/B'], ownerToken: null }
  const h = await mountApp(t, {
    readFileClipboard: () => ++reads === 1 ? staleRead.promise : Promise.resolve(external),
    copyFilesToClipboard: () => nativeWrite.promise,
    transfer: async (...args) => { copies.push(args); return [] },
    moveItems: async (...args) => { moves.push(args); return [] },
  })
  await select(h, ['/home/A'])
  await key(h, 'x', { metaKey: true })
  await h.run(async () => {
    staleRead.resolve(external)
    nativeWrite.resolve({ ok: true, changeCount: 8, ownerToken: 'cut-token' })
    await Promise.all([staleRead.promise, nativeWrite.promise])
  })
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(moves, [])
  assert.deepEqual(copies, [[['/wechat/B'], '/home', 'copy']])
})

test('failed Copy blocks an older unrelated file until the pasteboard demonstrably changes', async t => {
  const copies = []
  let snapshot = { changeCount: 5, paths: ['/older/B'], ownerToken: null }
  const h = await mountApp(t, {
    copyFilesToClipboard: async () => ({ ok: false, changeCount: 5, error: 'write denied' }),
    readFileClipboard: async () => snapshot,
    transfer: async (...args) => { copies.push(args); return [] },
  })
  await select(h, ['/home/A'])
  await key(h, 'c', { metaKey: true })
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(copies, [])
  assert.ok(h.alerts.some(message => String(message).includes('write denied')))
  snapshot = { changeCount: 6, paths: ['/wechat/C'], ownerToken: null }
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(copies, [[['/wechat/C'], '/home', 'copy']])
})

test('opaque clipboard IPC failure requires an explicit second paste', async t => {
  const copies = []
  const h = await mountApp(t, {
    copyFilesToClipboard: async () => { throw Error('IPC unavailable') },
    readFileClipboard: async () => ({ changeCount: 5, paths: ['/older/B'], ownerToken: null }),
    transfer: async (...args) => { copies.push(args); return [] },
  })
  await select(h, ['/home/A'])
  await key(h, 'c', { metaKey: true })
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(copies, [])
  assert.ok(h.alerts.some(message => String(message).includes('IPC unavailable')))
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(copies, [[['/older/B'], '/home', 'copy']])
})

test('partially completed Cut retries only remaining paths as a move', async t => {
  const moves = [], copies = []
  const snapshot = { changeCount: 20, paths: ['/home/A', '/home/B'], ownerToken: 'cut-two' }
  const h = await mountApp(t, {
    copyFilesToClipboard: async () => ({ ok: true, changeCount: 20, ownerToken: 'cut-two' }),
    readFileClipboard: async () => snapshot,
    moveItems: async (paths, dest) => {
      moves.push([paths, dest])
      return moves.length === 1
        ? [
          { source: '/home/A', dest: '/target/A', ok: true, identity: { dev: '1', ino: '2' } },
          { source: '/home/B', dest: '', ok: false, cancelled: true },
        ]
        : [{ source: '/home/B', dest: '/target/B', ok: true, identity: { dev: '1', ino: '3' } }]
    },
    transfer: async (...args) => { copies.push(args); return [] },
  })
  await select(h, ['/home/A', '/home/B'])
  await key(h, 'x', { metaKey: true })
  const pane = h.panes[0].props
  await h.run(() => pane.onNav(pane.pane.tabs[0].id, '/target'))
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(h.clipboard.getClip().paths, ['/home/B'])
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(moves, [[['/home/A', '/home/B'], '/target'], [['/home/B'], '/target']])
  assert.deepEqual(copies, [])
})

test('consumed Cut is a quiet no-op until a different clipboard transaction arrives', async t => {
  const moves = [], copies = []
  let snapshot = { changeCount: 30, paths: ['/home/A'], ownerToken: 'cut-one' }
  const h = await mountApp(t, {
    copyFilesToClipboard: async () => ({ ok: true, changeCount: 30, ownerToken: 'cut-one' }),
    readFileClipboard: async () => snapshot,
    moveItems: async (...args) => {
      moves.push(args)
      return [{ source: '/home/A', dest: '/target/A', ok: true, identity: { dev: '1', ino: '2' } }]
    },
    transfer: async (...args) => { copies.push(args); return [] },
  })
  await select(h, ['/home/A'])
  await key(h, 'x', { metaKey: true })
  const pane = h.panes[0].props
  await h.run(() => pane.onNav(pane.pane.tabs[0].id, '/target'))
  await key(h, 'v', { metaKey: true })
  assert.equal(h.clipboard.getClip(), null)
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(moves, [[['/home/A'], '/target']])
  assert.deepEqual(copies, [])
  snapshot = { changeCount: 31, paths: ['/wechat/C'], ownerToken: null }
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(copies, [[['/wechat/C'], '/target', 'copy']])
})
