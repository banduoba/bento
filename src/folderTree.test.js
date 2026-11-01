import test from 'node:test'
import assert from 'node:assert/strict'
import { createFolderTree } from './folderTree.js'
const flush = () => new Promise(resolve => setImmediate(resolve))
const entry = (path, is_symlink = false) => ({ name: path.split('/').pop(), path, is_symlink })
function harness(t, options = {}) {
  const requests = [], watches = new Map(); let change, listening = 0
  const tree = createFolderTree({
    list: (path, hidden) => new Promise((resolve, reject) => requests.push({ path, hidden, resolve, reject })),
    setWatch: (owner, paths) => watches.set(owner, paths), clearWatch: owner => watches.delete(owner),
    onFsChange: cb => { change = cb; listening++; return () => { listening--; change = null } }, ...options,
  })
  tree.start(); t.after(async () => {
    tree.stop()
    // Admission survives controllers: every owned IO promise must settle between tests.
    for (const request of requests) request.resolve({ entries: [], truncated: false })
    await flush()
  })
  return { tree, requests, watches, emit: p => change?.(p), listening: () => listening, resolve: async (i, entries = [], truncated = false) => { requests[i].resolve({ entries, truncated }); await flush() } }
}

test('inert until expand, close recursively drops state and stale reopen responses', async t => {
  const h = harness(t); assert.equal(h.requests.length, 0)
  h.tree.open('a', '/a'); assert.equal(h.requests.length, 1)
  h.tree.close('a'); h.tree.open('a', '/a')
  await h.resolve(0, [entry('/a/old')]); assert.equal(h.tree.snapshot().get('a').entries.length, 0)
  await h.resolve(1, [entry('/a/child')]);
  h.tree.open('child', '/a/child', 'a'); h.tree.close('a');
  assert.equal(h.tree.snapshot().size, 0); assert.equal(h.watches.size, 0)
  await h.resolve(2, [entry('/a/child/stale')]); assert.equal(h.tree.snapshot().size, 0)
})

test('only exact expanded event dirs refresh and event during read cannot publish stale entries', async t => {
  const h = harness(t); h.tree.open('a', '/a'); h.tree.open('b', '/ab')
  h.emit(['/a/nearby', '/']); assert.equal(h.requests.length, 2)
  h.emit([{ dir: '/a', reload: false, upserts: [], removes: [] }, '/a']);
  await h.resolve(0, [entry('/a/stale')]);
  assert.equal(h.tree.snapshot().get('a').entries.length, 0)
  assert.equal(h.requests.length, 3); assert.equal(h.requests[2].path, '/a')
  await h.resolve(2, [entry('/a/fresh')]); await h.resolve(1, [])
  assert.equal(h.tree.snapshot().get('a').entries[0].name, 'fresh')
  assert.equal(h.requests.length, 3)
})

test('actual enumeration stays within two slots even when running branches collapse', async t => {
  const h = harness(t)
  for (let n = 0; n < 6; n++) h.tree.open(String(n), `/d${n}`)
  assert.equal(h.requests.length, 2)
  h.tree.close('0'); h.tree.close('1'); assert.equal(h.requests.length, 2)
  await h.resolve(0); assert.equal(h.requests.length, 3)
  await h.resolve(1); assert.equal(h.requests.length, 4)
  h.tree.close('4'); h.tree.close('5'); await h.resolve(2); await h.resolve(3)
  assert.equal(h.requests.length, 4)
})

test('open budget rejects 65th branch and reclaimed slots can expand', t => {
  const h = harness(t)
  for (let n = 0; n < 64; n++) assert.equal(h.tree.open(String(n), `/d${n}`), true)
  assert.equal(h.tree.open('overflow', '/overflow'), false); assert.equal(h.tree.snapshot().size, 64)
  h.tree.close('32'); assert.equal(h.tree.open('overflow', '/overflow'), true)
})

test('settings invalidate pending data, auto refresh releases/resyncs watches and no tick dependence', async t => {
  const h = harness(t); h.tree.open('a', '/a')
  h.tree.setOptions({ showHidden: true, autoRefresh: false }); assert.equal(h.watches.size, 0)
  await h.resolve(0, [entry('/a/old')]); assert.equal(h.requests[1].hidden, true)
  await h.resolve(1, [entry('/a/.hidden')]); assert.equal(h.tree.snapshot().get('a').entries[0].name, '.hidden')
  h.emit(['/a']); assert.equal(h.requests.length, 2)
  h.tree.setOptions({ showHidden: true, autoRefresh: true }); assert.equal(h.requests.length, 3)
  assert.deepEqual([...h.watches.values()], [['/a']])
  h.tree.setOptions({ showHidden: false, autoRefresh: true }); await h.resolve(2, [entry('/a/.late')])
  assert.equal(h.requests[3].hidden, false); await h.resolve(3, [])
  assert.equal(h.tree.snapshot().get('a').entries.length, 0)
})

test('root removal and stop release subscriptions, queued work, descendant cache, and restart safely', async t => {
  const h = harness(t); h.tree.open('a', '/a'); h.tree.open('c', '/a/c', 'a'); h.tree.open('b', '/b')
  h.tree.retainRoots(['b']); assert.deepEqual([...h.tree.snapshot().keys()], ['b'])
  h.tree.stop(); assert.equal(h.listening(), 0); assert.equal(h.watches.size, 0)
  await h.resolve(0); await h.resolve(1); assert.equal(h.requests.length, 2)
  h.tree.start(); h.tree.open('a', '/a'); await h.resolve(2, [entry('/a/new')])
  assert.equal(h.tree.snapshot().get('a').entries[0].name, 'new')
})

test('errors remain retryable and truncated result retained for UI full-folder action', async t => {
  const h = harness(t); h.tree.open('a', '/a'); h.requests[0].reject('denied'); await flush()
  assert.equal(h.tree.snapshot().get('a').status, 'error'); assert.match(h.tree.snapshot().get('a').error, /denied/)
  h.tree.retry('a'); await h.resolve(1, [entry('/a/link', true)], true)
  assert.equal(h.tree.snapshot().get('a').truncated, true)
  assert.equal(h.tree.snapshot().get('a').entries[0].is_symlink, true)
})

test('independent root occurrences share one watched path and removed or symlink children release descendants', async t => {
  const h = harness(t); h.tree.open('home', '/a'); h.tree.open('favorite', '/a')
  await h.resolve(0, [entry('/a/child')]); await h.resolve(1, [entry('/a/child')])
  assert.deepEqual([...h.watches.values()], [['/a']])
  h.tree.open('child', '/a/child', 'home'); await h.resolve(2, [entry('/a/child/deep')])
  h.tree.open('deep', '/a/child/deep', 'child'); await h.resolve(3)
  h.emit(['/a']); await h.resolve(4, [entry('/a/child', true)]); await h.resolve(5, [])
  assert.deepEqual([...h.tree.snapshot().keys()], ['home', 'favorite'])
  h.tree.close('home'); assert.equal(h.tree.snapshot().has('favorite'), true)
  assert.deepEqual([...h.watches.values()], [['/a']])
})

test('setting replacement blocks late errors and coalesces repeated changes while pending', async t => {
  const h = harness(t); h.tree.open('a', '/a');
  h.tree.setOptions({ showHidden: true, autoRefresh: true });
  h.requests[0].reject('stale error'); await flush()
  assert.equal(h.tree.snapshot().get('a').status, 'loading')
  assert.equal(h.tree.snapshot().get('a').error, '')
  for (let n = 0; n < 12; n++) h.emit(['/a'])
  assert.equal(h.requests.length, 2)
  await h.resolve(1, [entry('/a/stale')]); assert.equal(h.requests.length, 3)
  await h.resolve(2, [entry('/a/new')]); assert.equal(h.tree.snapshot().get('a').entries[0].name, 'new')
})


test('actual read slots survive new controller mounts while stopped queues and old results are discarded', async t => {
  const pending = [], trees = [], watches = new Map()
  let running = 0, peak = 0
  const createMount = () => {
    const tree = createFolderTree({
      list: path => {
        running++; peak = Math.max(peak, running)
        return new Promise((resolve, reject) => pending.push({ path, resolve, reject }))
          .finally(() => { running-- })
      },
      setWatch: (owner, paths) => watches.set(owner, paths), clearWatch: owner => watches.delete(owner),
      onFsChange: () => () => {},
    })
    trees.push(tree); tree.start(); return tree
  }
  t.after(async () => {
    for (const tree of trees) tree.stop()
    for (const request of pending) request.resolve({ entries: [], truncated: false })
    await flush()
    assert.equal(running, 0)
  })
  const first = createMount()
  first.open('a', '/a'); first.open('b', '/b'); first.open('queued', '/never-start')
  assert.equal(running, 2)
  first.stop(); assert.equal(watches.size, 0)
  const second = createMount()
  second.open('a', '/a'); second.open('b', '/b')
  assert.equal(running, 2, 'new mount must wait for the old actual IO slots')
  assert.equal(pending.length, 2)
  pending[0].resolve({ entries: [entry('/a/old')], truncated: false }); await flush()
  assert.deepEqual(pending.map(r => r.path), ['/a', '/b', '/a'])
  assert.equal(first.snapshot().size, 0)
  assert.equal(second.snapshot().get('a').entries.length, 0)
  assert.equal(running, 2)
  // Stop another controller while its admitted read remains active; a third mount
  // must still wait, and the second mount's queued /b must never start.
  second.stop(); const third = createMount(); third.open('a', '/a'); third.open('b', '/b')
  assert.equal(pending.length, 3)
  pending[1].reject('old failure'); await flush()
  assert.deepEqual(pending.map(r => r.path), ['/a', '/b', '/a', '/a'])
  pending[2].resolve({ entries: [entry('/a/also-old')], truncated: false }); await flush()
  assert.deepEqual(pending.map(r => r.path), ['/a', '/b', '/a', '/a', '/b'])
  assert.equal(second.snapshot().size, 0)
  assert.equal(third.snapshot().get('a').entries.length, 0)
  assert.equal(third.snapshot().get('b').error, '')
  pending[3].resolve({ entries: [entry('/a/current')], truncated: false })
  pending[4].resolve({ entries: [], truncated: false }); await flush()
  assert.equal(third.snapshot().get('a').entries[0].name, 'current')
  assert.equal(peak, 2)
  assert.equal(running, 0)
})

test('separate stopped controllers release all admission slots for the next fresh controller', async t => {
  const first = harness(t); first.tree.open('a', '/a'); first.tree.open('b', '/b')
  first.tree.stop()
  const waiting = harness(t); waiting.tree.open('c', '/c'); waiting.tree.stop()
  await first.resolve(0); await first.resolve(1)
  assert.equal(waiting.requests.length, 0, 'stopped queued mount must not be revived by old settlement')
  const latest = harness(t); latest.tree.open('d', '/d'); latest.tree.open('e', '/e')
  assert.equal(latest.requests.length, 2, 'all shared slots are reusable after settlement')
  await latest.resolve(0); await latest.resolve(1)
})

test('child-only removal event clears stale descendants and revalidates only the expanded parent', async t => {
  const h = harness(t)
  h.tree.open('root', '/tree'); h.tree.open('other', '/tree-neighbor')
  await h.resolve(0, [entry('/tree/child')]); await h.resolve(1, [entry('/tree-neighbor/keep')])
  h.tree.open('child', '/tree/child', 'root'); await h.resolve(2, [entry('/tree/child/deep')])
  h.tree.open('deep', '/tree/child/deep', 'child') // Still reading when the parent disappears.
  h.emit(['/tree/child']); assert.equal(h.requests[4].path, '/tree/child')
  h.requests[4].reject('No such file or directory'); await flush()
  assert.deepEqual(h.tree.snapshot().get('child').entries, [], 'failed directory cannot retain stale child rows')
  assert.equal(h.tree.snapshot().has('deep'), false)
  assert.equal(h.tree.snapshot().get('child').status, 'error')
  assert.equal(h.requests[5]?.path, '/tree', 'known expanded parent is revalidated after child-only failure')
  assert.deepEqual([...h.watches.values()], [['/tree', '/tree-neighbor', '/tree/child']])
  await h.resolve(5, [])
  assert.deepEqual([...h.tree.snapshot().keys()], ['root', 'other'])
  assert.deepEqual(h.tree.snapshot().get('root').entries, [])
  assert.deepEqual([...h.watches.values()], [['/tree', '/tree-neighbor']])
  await h.resolve(3, [entry('/tree/child/deep/stale')])
  assert.deepEqual([...h.tree.snapshot().keys()], ['root', 'other'])
  assert.deepEqual(h.requests.map(r => r.path), ['/tree', '/tree-neighbor', '/tree/child', '/tree/child/deep', '/tree/child', '/tree'])
})

test('parent still containing failed child preserves explicit retry without stale descendants or refresh loops', async t => {
  const h = harness(t); h.tree.open('root', '/tree'); await h.resolve(0, [entry('/tree/child')])
  h.tree.open('child', '/tree/child', 'root'); await h.resolve(1, [entry('/tree/child/deep')], true)
  h.tree.open('deep', '/tree/child/deep', 'child'); await h.resolve(2)
  h.emit(['/tree/child']); h.requests[3].reject('Permission denied'); await flush()
  const failed = h.tree.snapshot().get('child')
  assert.deepEqual(failed.entries, []); assert.equal(failed.truncated, false)
  assert.equal(failed.status, 'error'); assert.match(failed.error, /Permission denied/)
  assert.equal(h.tree.snapshot().has('deep'), false)
  assert.equal(h.requests[4]?.path, '/tree')
  await h.resolve(4, [entry('/tree/child')]); await flush()
  assert.equal(h.tree.snapshot().get('child').status, 'error')
  assert.equal(h.requests.length, 5, 'parent success must not automatically retry its failed child')
  h.tree.retry('child'); assert.equal(h.requests[5].path, '/tree/child')
  await h.resolve(5, [entry('/tree/child/recovered')])
  assert.equal(h.tree.snapshot().get('child').entries[0].name, 'recovered')
  assert.equal(h.requests.length, 6)
})

test('a root read failure keeps its retryable root and clears old data without revalidating unrelated roots', async t => {
  const h = harness(t); h.tree.open('favorite', '/missing-favorite'); h.tree.open('other', '/other')
  await h.resolve(0, [entry('/missing-favorite/old')], true); await h.resolve(1)
  h.tree.open('old', '/missing-favorite/old', 'favorite'); await h.resolve(2)
  h.emit(['/missing-favorite']); h.requests[3].reject('No such file or directory'); await flush()
  assert.deepEqual([...h.tree.snapshot().keys()], ['favorite', 'other'])
  const failed = h.tree.snapshot().get('favorite')
  assert.equal(failed.status, 'error'); assert.match(failed.error, /No such/)
  assert.deepEqual(failed.entries, []); assert.equal(failed.truncated, false)
  assert.equal(h.requests.length, 4)
  h.tree.retry('favorite'); await h.resolve(4, [])
  assert.equal(h.tree.snapshot().get('favorite').status, 'ready')
})

test('failed parent revalidation progresses only upward and stops at the known root', async t => {
  const h = harness(t); h.tree.open('root', '/tree'); await h.resolve(0, [entry('/tree/child')])
  h.tree.open('child', '/tree/child', 'root'); await h.resolve(1, [entry('/tree/child/deep')])
  h.tree.open('deep', '/tree/child/deep', 'child'); await h.resolve(2)
  h.emit(['/tree/child/deep']); h.requests[3].reject('gone'); await flush()
  assert.equal(h.requests[4]?.path, '/tree/child')
  h.requests[4].reject('gone too'); await flush()
  assert.equal(h.requests[5]?.path, '/tree')
  h.requests[5].reject('root unavailable'); await flush(); await flush()
  assert.deepEqual([...h.tree.snapshot().keys()], ['root'])
  assert.equal(h.tree.snapshot().get('root').status, 'error')
  assert.deepEqual(h.tree.snapshot().get('root').entries, [])
  assert.equal(h.requests.length, 6, 'failed root must not create a retry cycle')
})
