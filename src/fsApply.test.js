import test from 'node:test'
import assert from 'node:assert/strict'
import { applyDirDelta, normalizeFsChanges } from './fsApply.js'

const entry = (name, extra = {}) => ({
  name,
  path: `/d/${name}`,
  is_dir: false,
  size: 1,
  mtime_ms: 1,
  btime_ms: 1,
  ext: '',
  ...extra,
})

test('touch replaces the same path and does not add a second row', () => {
  const list = [entry('a.txt'), entry('b.txt')]
  const next = applyDirDelta(list, { removes: [], upserts: [entry('a.txt', { size: 4, mtime_ms: 9 })] }, false)
  assert.equal(next.length, 2)
  assert.equal(next[0].path, '/d/a.txt')
  assert.equal(next[0].size, 4)
  assert.equal(next[0].mtime_ms, 9)
  assert.equal(next[1], list[1])
})

test('an unchanged stat keeps the same list', () => {
  const list = [entry('a.txt')]
  const next = applyDirDelta(list, { removes: [], upserts: [entry('a.txt')] }, false)
  assert.equal(next, list)
})

test('rm drops the path', () => {
  const list = [entry('a.txt'), entry('b.txt')]
  const next = applyDirDelta(list, { removes: ['/d/a.txt'], upserts: [] }, false)
  assert.deepEqual(next.map((e) => e.name), ['b.txt'])
})

test('rename removes the old name and inserts the new one once', () => {
  const list = [entry('a.txt'), entry('c.txt')]
  const next = applyDirDelta(
    list,
    { removes: ['/d/a.txt'], upserts: [entry('b.txt', { size: 3 })] },
    false,
  )
  assert.deepEqual(next.map((e) => e.name), ['c.txt', 'b.txt'])
  assert.equal(next.filter((e) => e.name === 'a.txt').length, 0)
  assert.equal(next.filter((e) => e.name === 'b.txt').length, 1)
})

test('upsert wins when the same path is also removed', () => {
  const list = [entry('a.txt')]
  const next = applyDirDelta(list, { removes: ['/d/a.txt'], upserts: [entry('a.txt', { size: 8 })] }, false)
  assert.equal(next.length, 1)
  assert.equal(next[0].size, 8)
})

test('hidden names stay out of the list unless showHidden is on', () => {
  const list = [entry('a.txt'), entry('.secret')]
  const hidden = applyDirDelta(list, { removes: [], upserts: [entry('.secret', { size: 9 }), entry('.new')] }, false)
  assert.deepEqual(hidden.map((e) => e.name), ['a.txt'])
  const shown = applyDirDelta(list, { removes: [], upserts: [entry('.new')] }, true)
  assert.deepEqual(shown.map((e) => e.name), ['a.txt', '.secret', '.new'])
})

test('reload is left to the caller', () => {
  const list = [entry('a.txt')]
  const next = applyDirDelta(list, { reload: true, removes: ['/d/a.txt'], upserts: [entry('b.txt')] }, false)
  assert.equal(next, list)
})

test('string payloads are full reloads of that directory', () => {
  assert.deepEqual(normalizeFsChanges(['/tmp/foo', { dir: '/tmp/bar', removes: ['/tmp/bar/a'], upserts: [] }]), [
    { dir: '/tmp/foo', reload: true, upserts: [], removes: [] },
    { dir: '/tmp/bar', reload: false, upserts: [], removes: ['/tmp/bar/a'] },
  ])
  assert.deepEqual(normalizeFsChanges(null), [])
})
