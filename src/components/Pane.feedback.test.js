import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react-test-renderer'
import { mountPane, entry } from '../test/PaneHarness.js'
import { rootRefreshKey } from '../paneFeedback.js'

test('mounted Pane does not scan or replace cached rows for unrelated invalidation, including expanded nodes', async t => {
  const h = await mountPane(t)
  await h.batch(h.requests[0], [entry('child', { is_dir: true }), entry('other', { is_dir: true })], true, 2)
  await h.flushFrames()
  await h.resolve(h.requests[0])
  await h.expand('/d/child')
  await h.resolveKids(h.childRequests[0], [entry('old', { path: '/d/child/old' })])
  await h.expand('/d/other')
  await h.resolveKids(h.childRequests[1], [])
  const rows = h.rows
  await h.update({ tick: rootRefreshKey(0, { '/elsewhere': 1 }, '/d'), directoryVersions: { '/elsewhere': 1 } })
  // First root tick changes from numeric 0 in the generic harness to the app's string key.
  const rootReads = h.requests.length
  const childReads = h.childRequests.length
  await h.update({ tick: rootRefreshKey(0, { '/elsewhere': 2 }, '/d'), directoryVersions: { '/elsewhere': 2 } })
  assert.equal(h.requests.length, rootReads)
  assert.equal(h.childRequests.length, childReads)
  assert.equal(h.rows, rows)
  await h.update({ directoryVersions: { '/elsewhere': 2, '/d/child': 1 } })
  assert.equal(h.requests.length, rootReads)
  assert.deepEqual(h.childRequests.slice(childReads).map(r => r.path), ['/d/child'])
})

test('mounted Pane rescans the affected root with automatic refresh disabled', async t => {
  const h = await mountPane(t)
  await h.update({ cfg: { showHidden: false, autoRefresh: false }, tick: '0:0' })
  const baseline = h.requests.length
  await h.update({ tick: rootRefreshKey(0, { '/d': 1 }, '/d'), directoryVersions: { '/d': 1 } })
  assert.equal(h.requests.length, baseline + 1)
  assert.equal(h.requests.at(-1).path, '/d')
})

test('manual refresh epoch rereads only the owning pane even when another pane shares its directory', async t => {
  const h = await mountPane(t)
  await h.update({ tick: rootRefreshKey(0, {}, '/d') })
  const before = h.requests.length
  const siblingTick = rootRefreshKey(0, {}, '/d')
  await h.update({ tick: rootRefreshKey(0, {}, '/d', 1) })
  assert.equal(h.requests.length, before + 1)
  assert.equal(h.requests.at(-1).path, '/d')
  assert.equal(siblingTick, '0:0')
  const afterOwnRefresh = h.requests.length
  await h.update({ tick: rootRefreshKey(0, {}, '/d', 1) })
  assert.equal(h.requests.length, afterOwnRefresh)
})

test('mounted Pane anchors operation feedback using only its own row, with a pane-local fallback', async t => {
  const previous = globalThis.ResizeObserver
  globalThis.ResizeObserver = class { observe() {} disconnect() {} }
  t.after(() => { if (previous === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = previous })
  const pane = { left: 1000, right: 1200, top: 80, bottom: 400, width: 200, height: 320 }
  let visibleRows = [{ dataset: { path: '/d/same' }, getBoundingClientRect: () => ({ left: 1010, right: 1190, top: 150, height: 30 }) }]
  const node = { style: { setProperty() {} }, getBoundingClientRect: () => pane, querySelectorAll: () => visibleRows }
  const h = await mountPane(t, { createNodeMock: element => element.type === 'section' ? node : null })
  await h.update({ operationToast: { tabId: 'a', paths: ['/d/same'], text: 'copied' } })
  let toast = h.root.findByProps({ className: 'copy-toast row-toast' })
  assert.equal(toast.props.style.top, 85)
  assert.ok(toast.props.style.left >= 0)
  assert.ok(toast.props.style.left + toast.props.style.maxWidth <= 200)
  visibleRows = []
  await h.update({ operationToast: { tabId: 'a', paths: ['/d/not-visible'], text: 'copied' } })
  toast = h.root.findByProps({ className: 'copy-toast row-toast' })
  assert.equal(toast.props.style.top, 48)
  assert.ok(toast.props.style.left + toast.props.style.maxWidth <= 200)
})

test('an expanded symlink directory updates when a different pane writes through its physical path', async t => {
  const h = await mountPane(t, undefined, { resolvePath: path => Promise.resolve(path === '/d/link/' ? '/physical' : path) })
  await h.batch(h.requests[0], [entry('link', { is_dir: true })], true, 1)
  await h.flushFrames()
  await h.resolve(h.requests[0])
  await h.expand('/d/link')
  await h.resolveKids(h.childRequests[0], [])
  const rootReads = h.requests.length
  await h.update({ directoryVersions: { '/physical': 1 } })
  assert.equal(h.requests.length, rootReads)
  assert.deepEqual(h.childRequests.map(r => r.path), ['/d/link', '/d/link'])
})

test('expanded-directory identity resolution preserves a real terminal space', async t => {
  const h = await mountPane(t, undefined, { resolvePath: path => Promise.resolve(path === '/d/link /' ? '/physical space' : path) })
  await h.batch(h.requests[0], [entry('link ', { is_dir: true })], true, 1)
  await h.flushFrames()
  await h.resolve(h.requests[0])
  await h.expand('/d/link ')
  await h.resolveKids(h.childRequests[0], [])
  await h.update({ directoryVersions: { '/physical space': 1 } })
  assert.deepEqual(h.childRequests.map(r => r.path), ['/d/link ', '/d/link '])
})

test('expanded alias keeps a pending physical invalidation across an unrelated version update', async t => {
  let resolveIdentity
  const h = await mountPane(t, undefined, { resolvePath: () => new Promise(resolve => { resolveIdentity = resolve }) })
  await h.batch(h.requests[0], [entry('link', { is_dir: true })], true, 1)
  await h.flushFrames()
  await h.resolve(h.requests[0])
  await h.expand('/d/link')
  await h.resolveKids(h.childRequests[0], [])
  const rootReads = h.requests.length
  await h.update({ directoryVersions: { '/physical': 1 } })
  await h.update({ directoryVersions: { '/physical': 1, '/unrelated': 1 } })
  resolveIdentity('/physical')
  await h.flushFrames()
  assert.equal(h.requests.length, rootReads)
  assert.deepEqual(h.childRequests.map(r => r.path), ['/d/link', '/d/link'])
  await h.update({ directoryVersions: { '/physical': 1, '/unrelated': 2 } })
  assert.equal(h.childRequests.length, 2)
})

test('failed alias identity lookup does not consume a pending physical invalidation', async t => {
  let lookups = 0
  const h = await mountPane(t, undefined, { resolvePath: () => ++lookups === 1 ? Promise.reject(new Error('temporarily unavailable')) : Promise.resolve('/physical') })
  await h.update({ directoryVersions: {} })
  await h.batch(h.requests[0], [entry('link', { is_dir: true })], true, 1)
  await h.flushFrames()
  await h.resolve(h.requests[0])
  await h.expand('/d/link')
  await h.resolveKids(h.childRequests[0], [])
  await h.update({ directoryVersions: { '/physical': 1 } })
  assert.equal(h.childRequests.length, 1)
  await h.update({ directoryVersions: { '/physical': 1, '/unrelated': 1 } })
  assert.deepEqual(h.childRequests.map(r => r.path), ['/d/link', '/d/link'])
})

test('an unrelated cut-move event preserves rows and performs no directory-activity scan', async t => {
  let activityReads = 0
  const h = await mountPane(t, undefined, { dirActivity: async () => { activityReads++; return [] } })
  await h.batch(h.requests[0], [entry('unrelated-folder', { is_dir: true })], true, 1)
  await h.flushFrames()
  await h.resolve(h.requests[0])
  const rows = h.rows
  const rootReads = h.requests.length
  const initialActivityReads = activityReads
  assert.equal(initialActivityReads, 1)
  await act(async () => window.dispatchEvent(new CustomEvent('bento-moved', { detail: { paths: ['/elsewhere/moved-file'] } })))
  assert.equal(h.requests.length, rootReads)
  assert.equal(activityReads, initialActivityReads)
  assert.equal(h.rows, rows)
})

test('a cut-move event immediately removes its source from an affected pane without a root reread', async t => {
  const h = await mountPane(t)
  await h.batch(h.requests[0], [entry('moved-file'), entry('retained-file')], true, 2)
  await h.flushFrames()
  await h.resolve(h.requests[0])
  const rootReads = h.requests.length
  await act(async () => window.dispatchEvent(new CustomEvent('bento-moved', { detail: { paths: ['/d/moved-file'] } })))
  assert.deepEqual(h.rows.map(row => row.path), ['/d/retained-file'])
  assert.equal(h.requests.length, rootReads)
})
