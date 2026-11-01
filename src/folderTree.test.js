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
  tree.start(); t.after(() => tree.stop())
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
