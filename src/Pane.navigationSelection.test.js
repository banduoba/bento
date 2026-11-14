import test from 'node:test'
import assert from 'node:assert/strict'
import { entry, mountPane } from './test/PaneHarness.js'

for (const viewMode of ['list', 'icons', 'columns']) {
  test(`${viewMode} history waits for the terminal listing, skips removed paths and scrolls the surviving selection`, async t => {
    const h = await mountPane(t)
    const ready = [], selections = []
    let done = 0
    const request = { tabId: 'a', root: '/d', kind: 'history', path: '/d/missing', selectionPaths: ['/d/missing', '/d/z', '/d/b'], nonce: 'history-1' }
    await h.update({ viewMode, reveal: request, onHistoryReady: (r, paths) => ready.push([r, paths]), onSelect: (_, paths) => selections.push([...paths]), onRevealDone: () => done++ })
    await h.batch(h.requests[0], [entry('a'), entry('b')])
    assert.deepEqual(ready, [])
    assert.deepEqual(h.scrollCalls, [])
    await h.batch(h.requests[0], [entry('z')], true, 3)
    assert.deepEqual(ready, [[request, ['/d/z', '/d/b']]])
    await h.update({ selection: new Set(['/d/z', '/d/b']), reveal: { ...request, kind: 'history-ready', path: '/d/z', selectionPaths: ['/d/z', '/d/b'] } })
    assert.ok(h.scrollCalls.some(call => call.index === 2))
    assert.equal(done, 1)
    assert.deepEqual(selections, [], 'scrolling must preserve the restored multi-selection')
  })
}

test('all deleted history targets complete with an empty selection and no later scrolling', async t => {
  const h = await mountPane(t)
  const ready = []
  await h.update({ reveal: { tabId: 'a', root: '/d', kind: 'history', path: '/d/gone', selectionPaths: ['/d/gone'], nonce: 'history-2' }, onHistoryReady: (_, paths) => ready.push(paths) })
  await h.batch(h.requests[0], [], true, 0)
  assert.deepEqual(ready, [[]])
  assert.deepEqual(h.scrollCalls, [])
})

test('a history request for another directory never consumes the current or partial rows', async t => {
  const h = await mountPane(t), ready = []
  await h.batch(h.requests[0], [entry('file')], true, 1)
  await h.update({ reveal: { tabId: 'a', root: '/other', kind: 'history', path: '/other/file', selectionPaths: ['/other/file'], nonce: 'history-3' }, onHistoryReady: (_, paths) => ready.push(paths) })
  assert.deepEqual(ready, [])
  assert.deepEqual(h.scrollCalls, [])
})
