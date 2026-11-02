import test from 'node:test'
import assert from 'node:assert/strict'
import { entry, mountPane } from './test/PaneHarness.js'

for (const viewMode of ['list', 'icons']) {
  test(`${viewMode} waits for the refreshed old-mtime receipt and scrolls without replaying selection`, async t => {
    const h = await mountPane(t)
    const selections = []
    let done = 0
    await h.update({ viewMode, onSelect: (_, paths) => selections.push([...paths]), onRevealDone: () => { done++ } })
    await h.batch(h.requests[0], [entry('newer', { mtime_ms: 100 })], true, 1)
    await h.update({ tick: 1, selection: new Set(['/d/older', '/d/another']),
      reveal: { tabId: 'a', path: '/d/older', selectionPaths: ['/d/older', '/d/another'], nonce: 1 } })
    assert.equal(done, 0, 'receipt is absent in the old snapshot')
    const request = h.requests.at(-1)
    await h.batch(request, [entry('newer', { mtime_ms: 100 }), entry('older', { mtime_ms: 1 }), entry('another')], true, 3)
    assert.equal(done, 1)
    assert.ok(h.scrollCalls.some(call => call.index === 2), 'scroll reaches the old file in sorted refreshed rows')
    assert.deepEqual(selections, [], 'transfer already selected all receipts; a reveal must not replay selection')
  })
}
