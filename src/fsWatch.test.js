import test from 'node:test'
import assert from 'node:assert/strict'
import { watchHarness } from './test/FsWatchHarness.js'

const entry = path => ({ name: path.split('/').pop(), path, is_symlink: false })

test('recovered tree reconciles native registration while another owner retains the failed path', async t => {
  const h = watchHarness(t), pane = Symbol('pane'), tree = h.createTree()
  h.setWatch(pane, ['/gone', '/pane-only'])
  tree.open('gone', '/gone'); tree.open('other', '/other')
  h.tick()
  assert.deepEqual(h.calls, [{ command: 'set_watched', paths: ['/gone', '/other', '/pane-only'] }])
  await h.reject(0); await h.resolve(1, [entry('/other/keep')]); h.tick()
  assert.equal(tree.snapshot().get('gone').status, 'error')
  assert.equal(h.calls.length, 1, 'other owner retains the failed path in the union')

  tree.retry('gone'); await h.resolve(2, [entry('/gone/recovered-child')])
  // An identical update during the debounce must not erase pending reconciliation.
  h.setWatch(pane, ['/gone', '/pane-only'])
  h.tick(79); assert.equal(h.calls.length, 1)
  h.tick(1)
  assert.deepEqual(h.calls[1], { command: 'set_watched', paths: ['/gone', '/other', '/pane-only'] })
  assert.equal(h.calls.length, 2, 'recovery must reach native registration despite unchanged union')
  assert.deepEqual(h.events, [], 'registration must not manufacture a reload/change event')
  assert.deepEqual(h.requests.map(r => r.path), ['/gone', '/other', '/gone'])

  h.emit([{ dir: '/gone', reload: false, removes: [], upserts: [] }])
  await h.resolve(3, [entry('/gone/recovered-child'), entry('/gone/later-child')]); h.tick()
  assert.deepEqual(tree.snapshot().get('gone').entries.map(e => e.name), ['recovered-child', 'later-child'])
  assert.deepEqual(tree.snapshot().get('other').entries.map(e => e.name), ['keep'])
  assert.deepEqual(h.requests.map(r => r.path), ['/gone', '/other', '/gone', '/gone'])
  assert.equal(h.calls.length, 2, 'ordinary refresh keeps identical ownership deduplicated')
  assert.equal(h.events.length, 1, 'only the supplied native event is forwarded')
  tree.stop(); h.tick()
  assert.deepEqual(h.calls.at(-1), { command: 'set_watched', paths: ['/gone', '/pane-only'] }, 'tree release preserves every pane path')
})

test('fast sole-owner error and retry reconciles when removal and re-add share one debounce', async t => {
  const h = watchHarness(t), tree = h.createTree()
  tree.open('gone', '/gone'); h.tick()
  await h.reject(0)
  tree.retry('gone'); await h.resolve(1, [entry('/gone/recovered')])
  h.tick()
  assert.deepEqual(h.calls, [
    { command: 'set_watched', paths: ['/gone'] },
    { command: 'set_watched', paths: ['/gone'] },
  ])
  assert.equal(tree.snapshot().get('gone').status, 'ready')
  assert.deepEqual(h.requests.map(r => r.path), ['/gone', '/gone'])
  assert.deepEqual(h.events, [])
})

test('identical owner path updates deduplicate and queued reconciliation uses the current live union', t => {
  const h = watchHarness(t), pane = Symbol('pane'), transient = Symbol('transient')
  h.setWatch(pane, ['/keep', '/shared']); h.tick()
  h.setWatch(pane, ['/shared', '/keep', '/keep']); h.tick()
  assert.equal(h.calls.length, 1, 'order and duplicate spelling do not add owner paths')
  h.setWatch(transient, ['/shared', '/removed-before-push'])
  h.clearWatch(transient)
  h.setWatch(pane, ['/keep'])
  h.tick()
  assert.deepEqual(h.calls.at(-1), { command: 'set_watched', paths: ['/keep'] })
  assert.equal(h.calls.length, 2, 'coalesced push cannot resurrect removed owner paths')
  h.setWatch(pane, ['/keep']); h.tick()
  assert.equal(h.calls.length, 2, 'consumed force does not leak into subsequent identical updates')
  assert.deepEqual(h.events, [])
  assert.deepEqual(h.requests, [])
})
