import test from 'node:test'
import assert from 'node:assert/strict'
import * as feedback from './paneFeedback.js'

test('marquee follows visible 30px rows at top, deep and scrolled coordinates and skips pseudo rows', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ path: `/f${i}`, isPseudo: i === 21 }))
  assert.deepEqual(feedback.marqueePaths(rows, 0, 30), ['/f0'])
  assert.deepEqual(feedback.marqueePaths(rows, 600, 629), ['/f20'])
  assert.deepEqual(feedback.marqueePaths(rows, 629, 661), ['/f20', '/f22'])
  assert.deepEqual(feedback.marqueePaths(rows, 749, 800), ['/f24'])
})

test('directory invalidation updates same-directory panes and affected expanded nodes only', () => {
  const before = { '/unrelated': 4 }
  const after = feedback.invalidateDirectories(before, ['/target', '/target', '/tree/child'])
  assert.equal(feedback.rootRefreshKey(1, before, '/unrelated'), feedback.rootRefreshKey(1, after, '/unrelated'))
  assert.notEqual(feedback.rootRefreshKey(1, before, '/target'), feedback.rootRefreshKey(1, after, '/target'))
  assert.deepEqual(feedback.changedDirectories(before, after, ['/tree/child', '/tree/sibling']), ['/tree/child'])
  assert.equal(feedback.invalidateDirectories(after, []), after)
})

test('toast positioning stays inside owning pane even at narrow widths and offscreen anchors', () => {
  const pane = { left: 1000, right: 1200, top: 80, bottom: 400, width: 200, height: 320 }
  for (const anchor of [null, { left: 1010, right: 1195, top: 150, height: 30 }, { left: 10, right: 40, top: 900, height: 30 }]) {
    const pos = feedback.paneToastPosition(pane, anchor)
    assert.ok(pos.x >= 1000)
    assert.ok(pos.x + pos.maxWidth <= 1200)
    assert.ok(pos.y >= 80 && pos.y <= 400)
  }
})
test('resolved pane-root aliases route child invalidation to the same physical directory', () => {
  const aliases = new Map([['/alias', '/physical'], ['/alias/nested', '/other']])
  assert.equal(feedback.directoryKey('/alias/child/', aliases), '/physical/child')
  assert.equal(feedback.directoryKey('/alias/nested/kid', aliases), '/other/kid')
  assert.deepEqual(feedback.changedDirectories({}, { '/physical/child': 1 }, ['/alias/child', '/unrelated'], path => feedback.directoryKey(path, aliases)), ['/alias/child'])
})
