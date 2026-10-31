import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react-test-renderer'
import { entry, mountPane } from './test/PaneHarness.js'

test('invoke completion before Channel delivery keeps loading and replays watcher changes', async (t) => {
  const pane = await mountPane(t)
  const request = pane.requests[0]
  await pane.resolve(request)
  assert.equal(pane.stats.listing, true)
  assert.equal(pane.root.findByProps({ 'aria-label': '文件列表' }).props['aria-busy'], 'true')
  await pane.change({ removes: ['/d/deleted'], upserts: [entry('new'), entry('updated', { size: 9 })] })
  await pane.batch(request, [entry('deleted'), entry('updated'), entry('old')], true, 3)
  assert.deepEqual(pane.rows.map(({ name, size }) => [name, size]), [['new', 1], ['old', 1], ['updated', 9]])
  assert.equal(pane.stats.listing, false)
})

test('a final Channel batch completes before invoke and later deltas survive invoke resolution', async (t) => {
  const pane = await mountPane(t)
  const request = pane.requests[0]
  await pane.batch(request, [entry('old')], true, 1)
  assert.equal(pane.stats.listing, false)
  await pane.change({ upserts: [entry('new')] })
  await pane.resolve(request)
  assert.deepEqual(pane.rows.map((item) => item.name), ['new', 'old'])
})

test('watcher reload buffers the snapshot and replays add, remove and modify deltas', async (t) => {
  const pane = await mountPane(t)
  await pane.batch(pane.requests[0], [entry('old'), entry('deleted'), entry('updated')], true, 3)
  await pane.change({ reload: true })
  const request = pane.requests[1]
  await pane.resolve(request)
  await pane.change({ removes: ['/d/deleted'], upserts: [entry('new'), entry('updated', { size: 9 })] })
  await pane.batch(request, [entry('deleted'), entry('old')])
  await pane.batch(request, [entry('updated')], true, 3)
  assert.deepEqual(pane.rows.map(({ name, size }) => [name, size]), [['new', 1], ['old', 1], ['updated', 9]])
  assert.equal(pane.stats.listing, false)
})

for (const refresh of [false, true]) {
  test(`${refresh ? 'silent refresh' : 'first load'} failure keeps partial rows with an incomplete warning and retry`, async (t) => {
    const pane = await mountPane(t)
    if (refresh) {
      await pane.batch(pane.requests[0], [entry('previous')], true, 1)
      await pane.change({ reload: true })
    }
    const request = pane.requests.at(-1)
    await pane.batch(request, [entry('partial')], false, 1000)
    await pane.reject(request)
    assert.deepEqual(pane.rows.map((item) => item.name), ['partial'])
    assert.equal(pane.stats.listing, false)
    assert.equal(pane.stats.incomplete, true)
    const warning = pane.root.findByProps({ role: 'alert' })
    assert.match(warning.children.filter((child) => typeof child === 'string').join(''), /未完成/)
    const retry = warning.findByType('button')
    await act(async () => retry.props.onClick())
    assert.deepEqual(pane.navigations, [['a', '/d', true]])
  })
}

test('failure before a first batch remains visible and retryable', async (t) => {
  const pane = await mountPane(t)
  await pane.reject(pane.requests[0], 'Permission denied')
  assert.equal(pane.rows.length, 0)
  const warning = pane.root.findByProps({ role: 'alert' })
  assert.match(warning.children.filter((child) => typeof child === 'string').join(''), /Permission denied/)
  assert.equal(warning.findByType('button').children.join(''), '重试')
})

test('a Channel interrupted without its terminal batch stays busy and offers retry after invoke finishes', async (t) => {
  const pane = await mountPane(t)
  const request = pane.requests[0]
  await pane.batch(request, [entry('partial')], false, 1000)
  await pane.resolve(request)
  assert.equal(pane.stats.listing, true)
  assert.equal(pane.stats.total, 1000)
  const waiting = pane.root.findByProps({ role: 'status' })
  await act(async () => waiting.findByType('button').props.onClick())
  assert.deepEqual(pane.navigations, [['a', '/d', true]])
  await pane.update({ tick: 1 })
  assert.ok(pane.cancelled.includes(request.id))
  const retry = pane.requests[1]
  await pane.batch(request, [entry('stale')], true)
  await pane.batch(retry, [entry('complete')], true, 1)
  assert.equal(pane.stats.listing, false)
  assert.equal(pane.stats.incomplete, false)
  assert.deepEqual(pane.rows.map((item) => item.name), ['complete'])
})

test('unmount after watcher restart cancels the current backend request and scheduled paint', async (t) => {
  const pane = await mountPane(t)
  await pane.batch(pane.requests[0], [entry('initial')], true, 1)
  await pane.change({ reload: true })
  const request = pane.requests[1]
  await pane.batch(request, [entry('first')])
  await pane.batch(request, [entry('pending')])
  assert.equal(pane.frames.size, 1)
  await pane.unmount()
  assert.ok(pane.cancelled.includes(request.id))
  assert.equal(pane.frames.size, 0)
  await pane.batch(request, [entry('late')], true, 3)
  assert.equal(pane.frames.size, 0)
})

test('ordinary unmount cancels an initial unfinished request', async (t) => {
  const pane = await mountPane(t)
  await pane.unmount()
  assert.ok(pane.cancelled.includes(pane.requests[0].id))
})

test('an expanded child snapshot replays deltas received while the first read is pending', async (t) => {
  const pane = await mountPane(t)
  await pane.batch(pane.requests[0], [entry('folder', { is_dir: true })], true, 1)
  await pane.expand('/d/folder')
  const request = pane.childRequests[0]
  await pane.change({ dir: '/d/folder', removes: ['/d/folder/deleted'], upserts: [entry('new', { path: '/d/folder/new' })] })
  await pane.resolveKids(request, [entry('deleted', { path: '/d/folder/deleted' })])
  assert.deepEqual(pane.rows.map((item) => item.path), ['/d/folder', '/d/folder/new'])
})

test('a child refresh replays changes and ignores an older reload response', async (t) => {
  const pane = await mountPane(t)
  await pane.batch(pane.requests[0], [entry('folder', { is_dir: true })], true, 1)
  await pane.expand('/d/folder')
  const oldEntry = entry('old', { path: '/d/folder/old' })
  await pane.resolveKids(pane.childRequests[0], [oldEntry])
  await pane.change({ dir: '/d/folder', reload: true })
  const older = pane.childRequests[1]
  await pane.change({ dir: '/d/folder', reload: true })
  const current = pane.childRequests[2]
  await pane.change({ dir: '/d/folder', upserts: [entry('old', { path: '/d/folder/old', size: 9 }), entry('new', { path: '/d/folder/new' })] })
  await pane.resolveKids(current, [oldEntry])
  await pane.resolveKids(older, [oldEntry])
  assert.deepEqual(pane.rows.map(({ path, size }) => [path, size]), [['/d/folder', 1], ['/d/folder/new', 1], ['/d/folder/old', 9]])
})

test('a child response from the previous tab cannot overwrite a new expansion of the same path', async (t) => {
  const pane = await mountPane(t)
  const folder = entry('folder', { is_dir: true })
  await pane.batch(pane.requests[0], [folder], true, 1)
  await pane.expand(folder.path)
  const old = pane.childRequests[0]
  await pane.update({ pane: { active: 0, tabs: [{ id: 'b', path: '/d', sortKey: 'name', sortDir: 'asc' }] } })
  await pane.batch(pane.requests[1], [folder], true, 1)
  await pane.expand(folder.path)
  await pane.resolveKids(pane.childRequests[1], [entry('fresh', { path: '/d/folder/fresh' })])
  await pane.resolveKids(old, [entry('stale', { path: '/d/folder/stale' })])
  assert.deepEqual(pane.rows.map((item) => item.path), ['/d/folder', '/d/folder/fresh'])
})

test('a rejected child read leaves no permanent loading row', async (t) => {
  const pane = await mountPane(t)
  await pane.batch(pane.requests[0], [entry('folder', { is_dir: true })], true, 1)
  await pane.expand('/d/folder')
  await pane.reject(pane.childRequests[0])
  assert.ok(pane.rows.every((item) => item.name !== '载入中…'))
})

for (const update of [
  { label: 'tab switch', pane: { active: 0, tabs: [{ id: 'b', path: '/other', sortKey: 'name', sortDir: 'asc' }] } },
  { label: 'directory navigation', pane: { active: 0, tabs: [{ id: 'a', path: '/other', sortKey: 'name', sortDir: 'asc' }] } },
  { label: 'sort restart', pane: { active: 0, tabs: [{ id: 'a', path: '/d', sortKey: 'size', sortDir: 'desc' }] } },
]) {
  test(`${update.label} cancels only the superseded load and ignores its late data`, async (t) => {
    const pane = await mountPane(t)
    const old = pane.requests[0]
    await pane.update({ pane: update.pane })
    const current = pane.requests[1]
    assert.ok(pane.cancelled.includes(old.id))
    assert.ok(!pane.cancelled.includes(current.id))
    await pane.batch(old, [entry('stale')], true)
    await pane.batch(current, [entry('fresh')], true, 1)
    assert.deepEqual(pane.rows.map((item) => item.name), ['fresh'])
    assert.equal(pane.stats.listing, false)
  })
}
