import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react-test-renderer'
import { entry, mountPane } from './test/PaneHarness.js'

function renameNodeMock(element) {
  const win = { innerHeight: 500, getComputedStyle: () => ({ lineHeight: '22px' }), addEventListener() {}, removeEventListener() {} }
  const rect = { left: 0, right: 200, width: 160 }
  if (element.type === 'textarea') return {
    style: {}, scrollHeight: 180, ownerDocument: { defaultView: win },
    parentElement: { getBoundingClientRect: () => rect }, getBoundingClientRect: () => rect,
  }
  if (element.type === 'span' && element.props.className === 'rename-measure') return { getBoundingClientRect: () => ({ width: 120 }) }
  return null
}

function withRenameObserver(t) {
  const prior = globalThis.ResizeObserver
  globalThis.ResizeObserver = class { observe() {} disconnect() {} }
  t.after(() => { if (prior === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = prior })
}

test('icon mode renders selectable file tiles and leaves the list header out', async t => {
  const h = await mountPane(t)
  await h.update({ viewMode: 'icons', onSelect: (_, paths) => { h.selected = paths } })
  await h.batch(h.requests[0], [entry('alpha.txt'), entry('Folder', { is_dir: true })], true)
  const icon = h.root.findByProps({ 'data-view-mode': 'icons' })
  const tile = icon.findByProps({ 'data-path': '/d/alpha.txt' })
  await h.update({ onSelect: (_, paths) => { h.selected = paths } })
  await act(async () => h.root.findByProps({ 'data-path': '/d/alpha.txt' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  assert.deepEqual([...h.selected], ['/d/alpha.txt'])
  assert.equal(h.root.findAllByProps({ className: 'cols' }).length, 0)
  assert.ok(tile)
})

test('column mode loads only selected child and ignores a stale child response', async t => {
  const h = await mountPane(t)
  await h.update({ viewMode: 'columns', onSelect: () => {} })
  await h.batch(h.requests[0], [entry('A', { is_dir: true }), entry('B', { is_dir: true })], true)
  assert.equal(h.childRequests.length, 0)
  const a = h.root.findByProps({ 'data-path': '/d/A' })
  await h.update({ onSelect: () => {} })
  await act(async () => h.root.findByProps({ 'data-path': '/d/A' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  assert.equal(h.childRequests.length, 1)
  const b = h.root.findByProps({ 'data-path': '/d/B' })
  await act(async () => b.props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  assert.equal(h.childRequests.length, 2)
  await h.resolveKids(h.childRequests[0], [entry('stale.txt', { path: '/d/A/stale.txt' })])
  assert.equal(h.root.findAllByProps({ 'data-path': '/d/A/stale.txt' }).length, 0)
  await h.resolveKids(h.childRequests[1], [entry('fresh.txt', { path: '/d/B/fresh.txt' })])
  assert.equal(h.root.findAllByProps({ 'data-path': '/d/B/fresh.txt' }).length, 1)
  assert.ok(a)
})

test('column indicates pending and empty child folders without listing descendants eagerly', async t => {
  const h = await mountPane(t)
  await h.update({ viewMode: 'columns', onSelect: () => {} })
  await h.batch(h.requests[0], [entry('A', { is_dir: true })], true)
  await act(async () => h.root.findByProps({ 'data-path': '/d/A' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  const child = h.root.findByProps({ 'data-column-path': '/d/A' })
  assert.ok(child.findAllByProps({ className: 'column-status' }).some(node => node.children.includes('载入中…')))
  await h.resolveKids(h.childRequests[0], [])
  assert.ok(h.root.findByProps({ 'data-column-path': '/d/A' }).findAllByProps({ className: 'column-status' }).some(node => node.children.includes('文件夹为空')))
})

test('column arrows move selection within a level and left collapses to its parent', async t => {
  const h = await mountPane(t)
  let selected = new Set()
  const select = (_, paths) => { selected = paths }
  await h.update({ viewMode: 'columns', onSelect: select })
  await h.batch(h.requests[0], [entry('A', { is_dir: true }), entry('B', { is_dir: true })], true)
  await act(async () => h.root.findByProps({ 'data-path': '/d/A' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  await h.resolveKids(h.childRequests[0], [entry('inside.txt', { path: '/d/A/inside.txt' })])
  await h.update({ selection: new Set(['/d/A']) })
  const view = h.root.findByProps({ 'data-view-mode': 'columns' })
  await act(async () => view.props.onKeyDown({ key: 'ArrowRight', metaKey: false, ctrlKey: false, altKey: false, preventDefault() {}, stopPropagation() {} }))
  assert.deepEqual([...selected], ['/d/A/inside.txt'])
  await h.update({ selection: selected })
  await act(async () => view.props.onKeyDown({ key: 'ArrowLeft', metaKey: false, ctrlKey: false, altKey: false, preventDefault() {}, stopPropagation() {} }))
  assert.deepEqual([...selected], ['/d/A'])
})

test('icon reveal scrolls by grid row rather than list row', async t => {
  const h = await mountPane(t)
  await h.update({ viewMode: 'icons', onSelect: () => {}, onRevealDone: () => {} })
  await h.batch(h.requests[0], [entry('first'), entry('target')], true)
  await h.update({ reveal: { tabId: 'a', path: '/d/target', nonce: 1 } })
  assert.ok(h.scrollCalls.some(call => call.size === 108 && call.index === 1))
})

test('column rename mounts one editor for the targeted entry across visible columns', async t => {
  const h = await mountPane(t)
  await h.update({ viewMode: 'columns', onSelect: () => {} })
  await h.batch(h.requests[0], [entry('A', { is_dir: true }), entry('B', { is_dir: true })], true)
  await act(async () => h.root.findByProps({ 'data-path': '/d/A' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  await h.resolveKids(h.childRequests[0], [entry('one', { path: '/d/A/one' }), entry('two', { path: '/d/A/two' })])
  await h.update({ renaming: { tabId: 'a', path: '/d/A/two', value: 'two' } })
  assert.equal(h.root.findAllByProps({ className: 'rename-input' }).length, 1)
})

test('column commands see only the active level and multi-selection stays visible', async t => {
  const h = await mountPane(t)
  let selected = new Set(), working = null
  const select = (_, paths) => { selected = paths }
  await h.update({ viewMode: 'columns', onSelect: select, onActiveDirectory: (_, root, dir) => { working = [root, dir] } })
  await h.batch(h.requests[0], [entry('A', { is_dir: true }), entry('B', { is_dir: true })], true)
  await act(async () => h.root.findByProps({ 'data-path': '/d/A' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  await h.update({ selection: selected })
  await h.resolveKids(h.childRequests[0], [entry('one', { path: '/d/A/one' }), entry('two', { path: '/d/A/two' })])
  assert.deepEqual(working, ['/d', '/d/A'])
  assert.deepEqual(h.rows.map(row => row.path), ['/d/A', '/d/B'])
  await act(async () => h.root.findByProps({ 'data-path': '/d/A/one' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  await h.update({ selection: selected })
  assert.deepEqual(working, ['/d', '/d/A'])
  assert.deepEqual(h.rows.map(row => row.path), ['/d/A/one', '/d/A/two'])
  await act(async () => h.root.findByProps({ 'data-path': '/d/A/two' }).props.onClick({ metaKey: true, ctrlKey: false, shiftKey: false }))
  await h.update({ selection: selected })
  assert.deepEqual([...selected].sort(), ['/d/A/one', '/d/A/two'])
  assert.ok(h.root.findByProps({ 'data-path': '/d/A/one' }).props.className.includes('selected'))
  assert.ok(h.root.findByProps({ 'data-path': '/d/A/two' }).props.className.includes('selected'))
  assert.ok(!h.root.findByProps({ 'data-path': '/d/A' }).props.className.includes('selected'))
})

test('first child click establishes the range anchor for the next Shift-click', async t => {
  const h = await mountPane(t)
  let selected = new Set()
  await h.update({ viewMode: 'columns', onSelect: (_, paths) => { selected = paths } })
  await h.batch(h.requests[0], [entry('A', { is_dir: true })], true)
  await act(async () => h.root.findByProps({ 'data-path': '/d/A' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  await h.resolveKids(h.childRequests[0], ['a', 'b', 'c'].map(name => entry(name, { path: `/d/A/${name}` })))
  await act(async () => h.root.findByProps({ 'data-path': '/d/A/a' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  await h.update({ selection: selected })
  await act(async () => h.root.findByProps({ 'data-path': '/d/A/c' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: true }))
  assert.deepEqual([...selected].sort(), ['/d/A/a', '/d/A/b', '/d/A/c'])
})

test('column trail survives sorting and hidden-file toggle clears selection before child reload', async t => {
  const h = await mountPane(t)
  let selected = new Set()
  await h.update({ viewMode: 'columns', onSelect: (_, paths) => { selected = paths } })
  await h.batch(h.requests[0], [entry('A', { is_dir: true })], true)
  await act(async () => h.root.findByProps({ 'data-path': '/d/A' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  await h.resolveKids(h.childRequests[0], [entry('file', { path: '/d/A/file' })])
  await act(async () => h.root.findByProps({ 'data-path': '/d/A/file' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  await h.update({ selection: selected, pane: { active: 0, tabs: [{ id: 'a', path: '/d', sortKey: 'name', sortDir: 'desc' }] } })
  assert.equal(h.root.findAllByProps({ 'data-column-path': '/d/A' }).length, 1)
  assert.deepEqual([...selected], ['/d/A/file'])
  const sortedRoot = h.requests.at(-1)
  await h.batch(sortedRoot, [entry('A', { is_dir: true })], true)
  assert.equal(h.root.findAllByProps({ 'data-column-path': '/d/A' }).length, 1)
  await h.update({ cfg: { showHidden: true } })
  assert.equal(h.root.findAllByProps({ 'data-column-path': '/d/A' }).length, 1)
  assert.equal(selected.size, 0)
  assert.equal(h.childRequests.at(-1).showHidden, true)
})

test('remounting columns clears a child selection whose trail no longer exists', async t => {
  const h = await mountPane(t)
  let selected = new Set(['/d/A/file'])
  await h.update({ viewMode: 'list', selection: selected, onSelect: (_, paths) => { selected = paths } })
  await h.update({ viewMode: 'columns' })
  assert.equal(selected.size, 0)
})

test('hidden-file refresh retains nested trail while ancestor child listing is pending', async t => {
  const h = await mountPane(t)
  await h.update({ viewMode: 'columns', onSelect: () => {} })
  await h.batch(h.requests[0], [entry('A', { is_dir: true })], true)
  await act(async () => h.root.findByProps({ 'data-path': '/d/A' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  await h.resolveKids(h.childRequests[0], [entry('B', { path: '/d/A/B', is_dir: true })])
  await act(async () => h.root.findByProps({ 'data-path': '/d/A/B' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  await h.resolveKids(h.childRequests[1], [entry('file', { path: '/d/A/B/file' })])
  await h.update({ cfg: { showHidden: true } })
  assert.equal(h.root.findAllByProps({ 'data-column-path': '/d/A/B' }).length, 1)
  assert.equal(h.childRequests.filter(request => request.showHidden).length, 2)
})

test('child column refresh follows manual tick and directory invalidation', async t => {
  const h = await mountPane(t)
  await h.update({ viewMode: 'columns', onSelect: () => {} })
  await h.batch(h.requests[0], [entry('A', { is_dir: true })], true)
  await act(async () => h.root.findByProps({ 'data-path': '/d/A' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  await h.resolveKids(h.childRequests[0], [entry('before', { path: '/d/A/before' })])
  await h.update({ tick: 1 })
  assert.equal(h.childRequests.length, 2)
  await h.resolveKids(h.childRequests[1], [entry('after', { path: '/d/A/after' })])
  assert.equal(h.root.findAllByProps({ 'data-path': '/d/A/after' }).length, 1)
  await h.update({ directoryVersions: { '/d/A': 1 }, directoryKeyFor: path => path })
  assert.equal(h.childRequests.length, 3)
  await h.resolveKids(h.childRequests[2], [entry('mutated', { path: '/d/A/mutated' })])
  assert.equal(h.root.findAllByProps({ 'data-path': '/d/A/mutated' }).length, 1)
  await h.change({ dir: '/d/A', upserts: [entry('external', { path: '/d/A/external' })] })
  assert.equal(h.root.findAllByProps({ 'data-path': '/d/A/external' }).length, 1)
})

test('column arrows scroll the virtual row selected beyond the visible viewport', async t => {
  const h = await mountPane(t)
  h.setVirtualLimit(10)
  let selected = new Set(['/d/A/file28'])
  await h.update({ viewMode: 'columns', selection: selected, onSelect: (_, paths) => { selected = paths } })
  await h.batch(h.requests[0], [entry('A', { is_dir: true })], true)
  await act(async () => h.root.findByProps({ 'data-path': '/d/A' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  const files = Array.from({ length: 40 }, (_, i) => entry(`file${i}`, { path: `/d/A/file${i}` }))
  await h.resolveKids(h.childRequests[0], files)
  await h.update({ selection: new Set(['/d/A/file28']) })
  assert.equal(h.root.findAllByProps({ 'data-path': '/d/A/file29' }).length, 0)
  const view = h.root.findByProps({ 'data-view-mode': 'columns' })
  await act(async () => view.props.onKeyDown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} }))
  assert.deepEqual([...selected], ['/d/A/file29'])
  assert.ok(h.scrollCalls.some(call => call.size === 24 && call.index === 29))
})

test('HTML blank drop into a child column uses that column directory', async t => {
  const h = await mountPane(t)
  const drops = []
  await h.update({ viewMode: 'columns', onDropTransfer: (...args) => drops.push(args) })
  const pane = h.root.findByType('section')
  await act(async () => pane.props.onDrop({ preventDefault() {}, stopPropagation() {}, target: { closest: () => ({ dataset: { columnPath: '/d/A' } }) }, dataTransfer: { getData: () => JSON.stringify({ paths: ['/src/file'] }) }, altKey: false }))
  assert.equal(drops[0]?.[0], '/d/A')
})

test('icon arrows move through the displayed grid and scroll the target row', async t => {
  const prior = globalThis.ResizeObserver
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback } observe() { this.callback([{ contentRect: { width: 360 } }]) } disconnect() {} }
  t.after(() => { if (prior === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = prior })
  const h = await mountPane(t, { createNodeMock: element => element.type === 'section' ? { style: { setProperty() {} } } : null })
  let selected = new Set(['/d/a'])
  await h.update({ viewMode: 'icons', selection: selected, onSelect: (_, paths) => { selected = paths } })
  await h.batch(h.requests[0], ['a', 'b', 'c', 'd', 'e', 'f'].map(name => entry(name)), true)
  const view = h.root.findByProps({ 'data-view-mode': 'icons' })
  await act(async () => view.props.onKeyDown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} }))
  assert.deepEqual([...selected], ['/d/d'])
  assert.ok(h.scrollCalls.some(call => call.size === 108 && call.index === 1))
})

test('initial long icon rename measurement survives passive effects', async t => {
  withRenameObserver(t)
  const h = await mountPane(t, { createNodeMock: renameNodeMock })
  await h.update({ viewMode: 'icons' })
  await h.batch(h.requests[0], [entry('long name')], true)
  const before = h.virtualEvents.length
  await h.update({ renaming: { tabId: 'a', path: '/d/long name', value: 'long name' } })
  const events = h.virtualEvents.slice(before).filter(event => event.estimate === 108)
  assert.ok(events.some(event => event.type === 'resize' && event.size >= 180))
  assert.equal(events.at(-1)?.type, 'resize')
})

test('initial long column rename measurement survives passive effects', async t => {
  withRenameObserver(t)
  const h = await mountPane(t, { createNodeMock: renameNodeMock })
  await h.update({ viewMode: 'columns' })
  await h.batch(h.requests[0], [entry('long name')], true)
  const before = h.virtualEvents.length
  await h.update({ renaming: { tabId: 'a', path: '/d/long name', value: 'long name' } })
  const events = h.virtualEvents.slice(before).filter(event => event.estimate === 24)
  assert.ok(events.some(event => event.type === 'resize' && event.size >= 180))
  assert.equal(events.at(-1)?.type, 'resize')
})

test('column parent request collapses the opened child without changing tab root', async t => {
  const h = await mountPane(t)
  let working = null
  await h.update({ viewMode: 'columns', onSelect: () => {}, onActiveDirectory: (_, root, dir) => { working = dir } })
  await h.batch(h.requests[0], [entry('A', { is_dir: true })], true)
  await act(async () => h.root.findByProps({ 'data-path': '/d/A' }).props.onClick({ metaKey: false, ctrlKey: false, shiftKey: false }))
  assert.equal(working, '/d/A')
  await h.update({ columnNavigate: { target: '/d', nonce: 1 } })
  assert.equal(working, '/d')
  assert.equal(h.root.findAllByProps({ 'data-column-path': '/d/A' }).length, 0)
})
