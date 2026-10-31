import test from 'node:test'
import assert from 'node:assert/strict'
import { createQuickLookNavigation } from './quickLookNavigation.js'

test('native-focus navigation follows owning pane current filtered order, skips directories and clamps', async () => {
  let rows = [{ path: '/b' }, { path: '/dir', is_dir: true }, { path: '/pseudo', isPseudo: true }, { path: '/a' }]
  const selected = [], revealed = [], updates = [], opens = []
  const nav = createQuickLookNavigation({ getRows: () => rows, select: (tab, path) => selected.push([tab, path]), reveal: (tab, path) => revealed.push([tab, path]), present: (...args) => opens.push(args), update: (...args) => updates.push(args) })
  nav.open('right', '/root', '/b')
  const session = opens[0][2]
  nav.navigate({ session, direction: 1 })
  await new Promise(resolve => setImmediate(resolve))
  nav.navigate({ session, direction: 1 })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(selected, [['right', '/a'], ['right', '/a']])
  assert.deepEqual(revealed, selected)
  assert.equal(opens.length, 1)
  assert.equal(updates[0][0], '/a')
  assert.equal(updates[1][3], 2)
  rows = [{ path: '/a' }, { path: '/c' }]
  nav.navigate({ session, direction: 1 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(updates.at(-1)[0], '/c')
  nav.closed({ session })
  nav.navigate({ session, direction: -1 })
  assert.equal(updates.length, 3)
})

test('late open failure or close event cannot replace a newer owning session', async () => {
  let rejectOpen
  const opens = [], selected = []
  const nav = createQuickLookNavigation({ getRows: () => [{ path: '/a' }, { path: '/b' }], select: (tab, path) => selected.push([tab, path]), reveal: () => {}, present: (...args) => { opens.push(args); return opens.length === 1 ? new Promise((_, reject) => { rejectOpen = reject }) : Promise.resolve() }, update: () => {} })
  nav.open('old', '/', '/a')
  const old = opens[0][2]
  nav.closed({ session: old })
  nav.open('new', '/', '/a')
  rejectOpen(new Error('late'))
  await new Promise(resolve => setImmediate(resolve))
  nav.closed({ session: old })
  nav.navigate({ session: opens[1][2], direction: 1 })
  assert.deepEqual(selected, [['new', '/b']])
})
test('changing a single selection in the owning pane updates preview without changing another pane', async () => {
  const updates = [], opens = []
  const nav = createQuickLookNavigation({ getRows: () => [{ path: '/a' }, { path: '/b' }, { path: '/dir', is_dir: true }], select() {}, reveal() {}, present: (...args) => opens.push(args), update: (...args) => updates.push(args) })
  nav.open('right', '/', '/a')
  nav.selectionChanged('left', '/b')
  nav.selectionChanged('right', '/dir')
  nav.selectionChanged('right', '/b')
  nav.selectionChanged('right', '/b')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(updates.length, 1)
  assert.equal(updates[0][0], '/b')
  assert.deepEqual(opens[0][1], ['/a'])
  assert.deepEqual(updates[0][1], ['/b'])
})
test('selection updates wait for native presentation and keep only the newest pending item', async () => {
  let finishOpen
  const updates = []
  const nav = createQuickLookNavigation({ getRows: () => [{ path: '/a' }, { path: '/b' }, { path: '/c' }], select() {}, reveal() {}, present: () => new Promise(resolve => { finishOpen = resolve }), update: (...args) => updates.push(args) })
  nav.open('right', '/', '/a')
  nav.selectionChanged('right', '/b')
  nav.selectionChanged('right', '/c')
  assert.deepEqual(updates, [])
  finishOpen()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(updates.length, 1)
  assert.equal(updates[0][0], '/c')
})
test('a new filter excluding the displayed item starts at its eligible edge', async () => {
  let rows = [{ path: '/a' }, { path: '/b' }, { path: '/c' }]
  const selected = [], opens = []
  const nav = createQuickLookNavigation({ getRows: () => rows, select: (_, path) => selected.push(path), reveal() {}, present: (...args) => opens.push(args), update() {} })
  nav.open('right', '/', '/a')
  rows = [{ path: '/b' }, { path: '/c' }]
  nav.navigate({ session: opens[0][2], direction: 1 })
  assert.deepEqual(selected, ['/b'])
})
test('multiple selected files retain the existing native gallery presentation', () => {
  const opens = []
  const nav = createQuickLookNavigation({ getRows: () => [{ path: '/a' }, { path: '/b' }], select() {}, reveal() {}, present: (...args) => opens.push(args), update() {} })
  nav.open('right', '/', '/a', ['/b', '/a'])
  assert.deepEqual(opens[0], ['/a', ['/a', '/b'], null])
})
