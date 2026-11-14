import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, key } from './test/AppHarness.js'

const pane = (h, index = 0) => h.panes[index].props
const tab = (h, index = 0) => { const p = pane(h, index).pane; return p.tabs[p.active] }
const select = (h, paths, index = 0) => h.run(() => pane(h, index).onSelect(tab(h, index).id, new Set(paths)))
const nav = (h, path, index = 0) => h.run(() => pane(h, index).onNav(tab(h, index).id, path))
const travel = (h, direction, index = 0) => h.run(() => pane(h, index)[direction](tab(h, index).id))

test('back then forward restores the visit selection only after the directory confirms existing rows', async t => {
  const h = await mountApp(t)
  await nav(h, '/work')
  await select(h, ['/work/report.txt', '/work/gone.txt'])
  await travel(h, 'onBack')
  assert.equal(tab(h).path, '/home')
  await travel(h, 'onForward')
  assert.equal(tab(h).path, '/work')
  assert.equal(pane(h).selection.size, 0)
  const request = pane(h).reveal
  assert.equal(request.kind, 'history')
  assert.deepEqual(request.selectionPaths, ['/work/report.txt', '/work/gone.txt'])
  await h.run(() => pane(h).onHistoryReady(request, ['/work/report.txt']))
  assert.deepEqual([...pane(h).selection], ['/work/report.txt'])
  assert.equal(pane(h).reveal.path, '/work/report.txt')
  assert.notEqual(pane(h).reveal.kind, 'history')
  await h.run(() => pane(h).onRevealDone())
  assert.equal(pane(h).reveal, null)
})

test('history restoration is canceled by a new selection or navigation and cannot steal focus later', async t => {
  const h = await mountApp(t)
  await nav(h, '/work'); await select(h, ['/work/old'])
  await travel(h, 'onBack'); await travel(h, 'onForward')
  const before = pane(h), request = before.reveal
  await select(h, ['/work/new'])
  await h.run(() => before.onHistoryReady(request, ['/work/old']))
  assert.deepEqual([...pane(h).selection], ['/work/new'])
  assert.equal(pane(h).reveal, null)
  await travel(h, 'onBack'); await travel(h, 'onForward')
  const pending = pane(h), abandoned = pending.reveal
  await nav(h, '/elsewhere')
  await h.run(() => pending.onHistoryReady(abandoned, ['/work/new']))
  assert.equal(tab(h).path, '/elsewhere')
  assert.equal(pane(h).selection.size, 0)
  assert.equal(pane(h).reveal, null)
})

test('same path, refresh, and unavailable history steps preserve selection', async t => {
  const h = await mountApp(t)
  await select(h, ['/home/file'])
  await nav(h, '/home')
  await travel(h, 'onBack'); await travel(h, 'onForward')
  await h.run(() => pane(h).onNav(tab(h).id, '/home', true))
  assert.deepEqual([...pane(h).selection], ['/home/file'])
  assert.equal(pane(h).reveal, null)
})

test('two tabs visiting the same folder restore independent selections', async t => {
  const h = await mountApp(t)
  await nav(h, '/work'); await select(h, ['/work/one'])
  await h.run(() => pane(h).onNewTab(0))
  await select(h, ['/work/two'])
  await nav(h, '/other'); await travel(h, 'onBack')
  assert.deepEqual(pane(h).reveal.selectionPaths, ['/work/two'])
  await h.run(() => pane(h).onSwitchTab(0, 0))
  await travel(h, 'onBack'); await travel(h, 'onForward')
  assert.deepEqual(pane(h).reveal.selectionPaths, ['/work/one'])
})

test('rapid keyboard history travel preserves pending selection before rows arrive', async t => {
  const h = await mountApp(t)
  await nav(h, '/work'); await select(h, ['/work/report'])
  await key(h, '[', { metaKey: true })
  await key(h, ']', { metaKey: true })
  assert.deepEqual(pane(h).reveal.selectionPaths, ['/work/report'])
  const old = pane(h), oldRequest = old.reveal
  await key(h, '[', { metaKey: true }); await key(h, ']', { metaKey: true })
  assert.deepEqual(pane(h).reveal.selectionPaths, ['/work/report'])
  const current = pane(h).reveal
  assert.notEqual(current.nonce, oldRequest.nonce)
  await h.run(() => old.onHistoryReady(oldRequest, ['/work/report']))
  assert.equal(pane(h).reveal.nonce, current.nonce)
  assert.equal(pane(h).selection.size, 0)
  await h.run(() => pane(h).onHistoryReady(current, []))
  assert.equal(pane(h).selection.size, 0)
  assert.equal(pane(h).reveal, null)
})
