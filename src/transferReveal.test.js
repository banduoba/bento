import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, key, deferred } from './test/AppHarness.js'

const identity = { dev: '12', ino: '345' }
const receipt = (source, dest, extra = {}) => ({ source, dest, ok: true, identity, ...extra })
const destination = async (h, index = 1, path = '/dst') => {
  const tabId = h.panes[index].props.pane.tabs[0].id
  await h.run(() => h.panes[index].props.onNav(tabId, path))
  return tabId
}
const transfer = (h, paths, mode = 'copy', dest = '/dst', index = 1) =>
  h.panes[index].props.onDropTransfer(dest, paths, mode)

test('copy reveals the exact old-mtime, collision-renamed native result in its destination tab', async t => {
  const h = await mountApp(t, {
    transfer: async () => [receipt('/src/report.pdf', '/dst/report 2.pdf')],
  })
  const tabId = await destination(h)
  await destination(h, 0, '/src')
  const sourceTick = h.panes[0].props.tick
  await h.run(() => transfer(h, ['/src/report.pdf']))
  assert.deepEqual([...h.panes[1].props.selection], ['/dst/report 2.pdf'])
  assert.deepEqual([...h.panes[0].props.selection], [])
  assert.equal(h.panes[1].props.reveal.path, '/dst/report 2.pdf')
  assert.equal(h.panes[1].props.reveal.tabId, tabId)
  assert.equal(h.panes[1].props.focused, false, 'completion does not steal focus')
  assert.equal(h.panes[0].props.tick, sourceTick, 'Copy does not refresh its source pane')
})

test('two distinct transfers replace the selected result and issue distinct reveal requests', async t => {
  let count = 0
  const h = await mountApp(t, {
    transfer: async () => [receipt(`/src/${++count}`, `/dst/renamed ${count}`)],
  })
  await destination(h)
  await h.run(() => transfer(h, ['/src/1']))
  const first = h.panes[1].props.reveal.nonce
  await h.run(() => transfer(h, ['/src/2']))
  assert.deepEqual([...h.panes[1].props.selection], ['/dst/renamed 2'])
  assert.equal(h.panes[1].props.reveal.path, '/dst/renamed 2')
  assert.ok(h.panes[1].props.reveal.nonce > first)
})

test('multi-item transfer keeps every identified result selected after the list reveals one row', async t => {
  const h = await mountApp(t, {
    transfer: async () => [receipt('/src/a', '/dst/a 2'), receipt('/src/b', '/dst/b 2')],
  })
  const tabId = await destination(h)
  await h.run(() => transfer(h, ['/src/a', '/src/b']))
  assert.deepEqual([...h.panes[1].props.selection], ['/dst/a 2', '/dst/b 2'])
  await h.run(() => {
    h.panes[1].props.onRevealDone()
  })
  assert.deepEqual([...h.panes[1].props.selection], ['/dst/a 2', '/dst/b 2'])
})

test('an old reveal completion cannot clear a newer transfer request', async t => {
  let count = 0
  const h = await mountApp(t, {
    transfer: async () => [receipt(`/src/${++count}`, `/dst/${count}`)],
  })
  await destination(h)
  await h.run(() => transfer(h, ['/src/1']))
  const oldDone = h.panes[1].props.onRevealDone
  await h.run(() => transfer(h, ['/src/2']))
  await h.run(oldDone)
  assert.equal(h.panes[1].props.reveal.path, '/dst/2')
  assert.deepEqual([...h.panes[1].props.selection], ['/dst/2'])
})

test('navigation and tab switching while native work is pending leave the new view untouched', async t => {
  const gate = deferred()
  const h = await mountApp(t, { transfer: () => gate.promise })
  const tabId = await destination(h)
  let pending
  await h.run(() => { pending = transfer(h, ['/src/a']) })
  await h.run(() => h.panes[1].props.onNav(tabId, '/other'))
  await h.run(async () => { gate.resolve([receipt('/src/a', '/dst/a')]); await pending })
  assert.deepEqual([...h.panes[1].props.selection], [])
  assert.equal(h.panes[1].props.reveal, null)

  const gate2 = deferred()
  h.api.transfer = () => gate2.promise
  await h.run(() => h.panes[1].props.onNav(tabId, '/dst'))
  await h.run(() => { pending = transfer(h, ['/src/b']) })
  await h.run(() => h.panes[1].props.onNewTab(1))
  await h.run(() => h.panes[1].props.onSwitchTab(1, 0))
  await h.run(async () => { gate2.resolve([receipt('/src/b', '/dst/b')]); await pending })
  assert.equal(h.panes[1].props.reveal, null)
  assert.deepEqual([...h.panes[1].props.selection], [])
})

test('partial or unidentified native receipts select only identified successes', async t => {
  const h = await mountApp(t, {
    transfer: async () => [
      receipt('/src/a', '/dst/a 2'),
      { source: '/src/b', dest: '/dst/b', ok: true },
      { source: '/src/c', dest: '', ok: false, cancelled: true },
    ],
  })
  await destination(h)
  await h.run(() => transfer(h, ['/src/a', '/src/b', '/src/c']))
  assert.deepEqual([...h.panes[1].props.selection], ['/dst/a 2'])
  assert.equal(h.panes[1].props.reveal.path, '/dst/a 2')
})

test('folder-row drop and wrong target tab never reveal a result in another listing', async t => {
  const h = await mountApp(t, { transfer: async () => [receipt('/src/a', '/dst/folder/a')] })
  await destination(h)
  await h.run(() => transfer(h, ['/src/a'], 'copy', '/dst/folder'))
  assert.equal(h.panes[1].props.reveal, null)
  assert.deepEqual([...h.panes[1].props.selection], [])

  h.api.transfer = async () => [receipt('/src/a', '/dst/a')]
  await h.run(() => transfer(h, ['/src/a'], 'copy', '/dst', 0))
  assert.equal(h.panes[1].props.reveal, null)
  assert.deepEqual([...h.panes[1].props.selection], [])
})

test('same-parent Duplicate and external file Paste reveal actual renamed receipts', async t => {
  const results = [receipt('/home/a', '/home/a copy'), receipt('/external/b', '/home/b 2')]
  const h = await mountApp(t, {
    transfer: async () => [results.shift()],
    readFileClipboard: async () => ({ changeCount: 9, paths: ['/external/b'] }),
  })
  const tabId = h.panes[0].props.pane.tabs[0].id
  await h.run(() => h.panes[0].props.onSelect(tabId, new Set(['/home/a'])))
  await key(h, 'd', { metaKey: true })
  assert.equal(h.panes[0].props.reveal.path, '/home/a copy')
  await key(h, 'v', { metaKey: true })
  assert.deepEqual([...h.panes[0].props.selection], ['/home/b 2'])
  assert.equal(h.panes[0].props.reveal.path, '/home/b 2')
})

test('identified image Paste reveals its actual generated name', async t => {
  const h = await mountApp(t, {
    readFileClipboard: async () => ({ changeCount: 11, paths: [] }),
    pasteImageFromClipboard: async () => ({ path: '/home/image 2.png', identity }),
  })
  await key(h, 'v', { metaKey: true })
  assert.deepEqual([...h.panes[0].props.selection], ['/home/image 2.png'])
  assert.equal(h.panes[0].props.reveal.path, '/home/image 2.png')
})

test('F6 Move reveals the other pane without changing focus', async t => {
  const h = await mountApp(t, {
    moveItems: async () => [receipt('/home/a', '/dst/a 2')],
  })
  await destination(h)
  const sourceTab = h.panes[0].props.pane.tabs[0].id
  await h.run(() => h.panes[0].props.onSelect(sourceTab, new Set(['/home/a'])))
  await key(h, 'F6')
  assert.deepEqual([...h.panes[1].props.selection], ['/dst/a 2'])
  assert.equal(h.panes[1].props.reveal.path, '/dst/a 2')
  assert.equal(h.panes[0].props.focused, true)
  assert.equal(h.panes[1].props.focused, false)
})

test('columns reveal a result in the active child directory', async t => {
  const h = await mountApp(t, {
    readFileClipboard: async () => ({ changeCount: 1, paths: ['/external/a'] }),
    transfer: async () => [receipt('/external/a', '/home/child/a 2')],
  })
  await key(h, '3', { metaKey: true })
  const tabId = h.panes[0].props.pane.tabs[0].id
  await h.run(() => h.panes[0].props.onActiveDirectory(tabId, '/home', '/home/child'))
  await key(h, 'v', { metaKey: true })
  assert.deepEqual([...h.panes[0].props.selection], ['/home/child/a 2'])
  assert.equal(h.panes[0].props.reveal, null)
})

test('icon view sends the exact result to its existing scroll reveal', async t => {
  const h = await mountApp(t, {
    transfer: async () => [receipt('/src/a', '/home/a 2')],
  })
  await key(h, '2', { metaKey: true })
  await h.run(() => transfer(h, ['/src/a'], 'copy', '/home', 0))
  assert.deepEqual([...h.panes[0].props.selection], ['/home/a 2'])
  assert.equal(h.panes[0].props.reveal.path, '/home/a 2')
})

test('Move removes completed source paths without clearing a newer unrelated selection', async t => {
  const gate = deferred()
  const h = await mountApp(t, { transfer: () => gate.promise })
  await destination(h)
  const sourceTab = h.panes[0].props.pane.tabs[0].id
  await h.run(() => h.panes[0].props.onSelect(sourceTab, new Set(['/src/a', '/src/b'])))
  let pending
  await h.run(() => { pending = transfer(h, ['/src/a'], 'move') })
  await h.run(() => h.panes[0].props.onSelect(sourceTab, new Set(['/src/a', '/src/new'])))
  await h.run(async () => { gate.resolve([receipt('/src/a', '/dst/a')]); await pending })
  assert.deepEqual([...h.panes[0].props.selection], ['/src/new'])
  assert.deepEqual([...h.panes[1].props.selection], ['/dst/a'])
})

test('manual destination selection cancels a delayed transfer reveal without replaying old selection', async t => {
  const h = await mountApp(t, { transfer: async () => [receipt('/src/a', '/dst/a')] })
  const tabId = await destination(h)
  await h.run(() => transfer(h, ['/src/a']))
  const oldDone = h.panes[1].props.onRevealDone
  await h.run(() => h.panes[1].props.onSelect(tabId, new Set(['/dst/manual'])))
  assert.equal(h.panes[1].props.reveal, null)
  await h.run(oldDone)
  assert.deepEqual([...h.panes[1].props.selection], ['/dst/manual'])
})

test('filtered and hidden first receipts do not block revealing a later visible result', async t => {
  const h = await mountApp(t, { transfer: async () => [
    receipt('/src/.hidden', '/dst/.hidden'), receipt('/src/excluded', '/dst/excluded'),
    receipt('/src/visible.txt', '/dst/visible.txt'),
  ] })
  const tabId = await destination(h)
  await h.run(() => h.panes[1].props.onFilter(tabId, 'visible'))
  await h.run(() => transfer(h, ['/src/.hidden', '/src/excluded', '/src/visible.txt']))
  assert.deepEqual([...h.panes[1].props.selection], ['/dst/visible.txt'])
  assert.equal(h.panes[1].props.reveal.path, '/dst/visible.txt')
  await h.run(() => h.panes[1].props.onFilter(tabId, 'other'))
  assert.equal(h.panes[1].props.reveal, null)
})

test('a newer destination selection during pending native work takes precedence over transfer reveal', async t => {
  const gate = deferred()
  const h = await mountApp(t, { transfer: () => gate.promise })
  const tabId = await destination(h)
  let pending
  await h.run(() => { pending = transfer(h, ['/src/a']) })
  await h.run(() => h.panes[1].props.onSelect(tabId, new Set(['/dst/manual'])))
  await h.run(async () => { gate.resolve([receipt('/src/a', '/dst/a')]); await pending })
  assert.deepEqual([...h.panes[1].props.selection], ['/dst/manual'])
  assert.equal(h.panes[1].props.reveal, null)
  assert.equal(h.panes[1].props.focused, false)
})

test('cancelling before any filesystem mutation preserves the previous copy Undo and view', async t => {
  const undone = []
  let count = 0
  const h = await mountApp(t, {
    transfer: async () => ++count === 1
      ? [receipt('/src/a', '/dst/a')]
      : [{ source: '/src/b', dest: '', ok: false, cancelled: true, unchanged: true }],
    trash: async (paths) => { undone.push(paths); return { entries: paths.map(original => ({ original })) } },
  })
  await destination(h)
  await h.run(() => transfer(h, ['/src/a']))
  const tick = h.panes[1].props.tick
  await h.run(() => transfer(h, ['/src/b']))
  assert.equal(h.panes[1].props.tick, tick, 'a cancelled no-op does not reload the listing')
  await key(h, 'z', { metaKey: true })
  assert.deepEqual(undone, [['/dst/a']], 'Undo still removes the earlier copy')
})

test('copy Undo clears the removed result selection and a pending scroll request', async t => {
  const h = await mountApp(t, {
    transfer: async () => [receipt('/src/a', '/dst/a')],
    trash: async paths => ({ entries: paths.map(original => ({ original })) }),
  })
  await destination(h)
  await h.run(() => transfer(h, ['/src/a']))
  assert.equal(h.panes[1].props.reveal.path, '/dst/a')
  await key(h, 'z', { metaKey: true })
  assert.deepEqual([...h.panes[1].props.selection], [])
  assert.equal(h.panes[1].props.reveal, null)
})

test('move Undo removes only the restored-away destination from a newer selection', async t => {
  const h = await mountApp(t, {
    transfer: async () => [receipt('/src/a', '/dst/a')],
    restoreMoves: async moves => moves.map(move => ({ ...move, ok: true })),
  })
  const tabId = await destination(h)
  await h.run(() => transfer(h, ['/src/a'], 'move'))
  await h.run(() => h.panes[1].props.onSelect(tabId, new Set(['/dst/a', '/dst/manual'])))
  await key(h, 'z', { metaKey: true })
  assert.deepEqual([...h.panes[1].props.selection], ['/dst/manual'])
})

test('native Undo menu reenables after a no-effect cancellation finishes', async t => {
  const gate = deferred()
  let count = 0
  const h = await mountApp(t, {
    transfer: () => ++count === 1 ? Promise.resolve([receipt('/src/a', '/dst/a')]) : gate.promise,
  })
  await destination(h)
  await h.run(() => transfer(h, ['/src/a']))
  const nativeUndoEnabled = () => h.invocations.filter(([name]) => name === 'sync_menu_state').at(-1)?.[1].canUndo
  assert.equal(nativeUndoEnabled(), true)
  let pending
  await h.run(() => { pending = transfer(h, ['/src/b']) })
  await h.run(() => window.dispatchEvent(new Event('focusout')))
  assert.equal(nativeUndoEnabled(), false)
  await h.run(async () => {
    gate.resolve([{ source: '/src/b', dest: '', ok: false, cancelled: true, unchanged: true }])
    await pending
  })
  assert.equal(nativeUndoEnabled(), true, 'menu must read the settled pending-operation count')
})
