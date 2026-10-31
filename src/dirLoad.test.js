import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LIST_BATCH,
  isCurrentLoad,
  listCountLabel,
  shouldRestartLoad,
  mergeByPath,
  nextLoadRequestId,
  noteDelta,
  reduceLoadBatches,
} from './dirLoad.js'

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

test('batch size stays aligned with the rust stream', () => {
  assert.equal(LIST_BATCH, 500)
})

test('request ids are unique and a stale id is not current', () => {
  const a = nextLoadRequestId()
  const b = nextLoadRequestId()
  assert.notEqual(a, b)
  const session = { id: b, cancelled: false, done: false }
  assert.equal(isCurrentLoad(session, a), false)
  assert.equal(isCurrentLoad(session, b), true)
  assert.equal(isCurrentLoad({ ...session, cancelled: true }, b), false)
  assert.equal(isCurrentLoad({ ...session, done: true }, b), false)
})

test('merge keeps one row per path and the same object when nothing changed', () => {
  const a = entry('a.txt')
  const b = entry('b.txt')
  const list = [a, b]
  const again = mergeByPath(list, [entry('a.txt'), entry('b.txt')])
  assert.equal(again, list)
  assert.equal(again[0], a)
  assert.equal(again[1], b)
  const updated = entry('a.txt', { size: 4, mtime_ms: 9 })
  const next = mergeByPath([a, b], [updated])
  assert.equal(next.length, 2)
  assert.equal(next[0], updated)
  assert.equal(next[1], b)
  assert.equal(next.filter((item) => item.path === '/d/a.txt').length, 1)
})

test('later batches append and a repeated path does not duplicate the row', () => {
  const first = [entry('a.txt'), entry('b.txt')]
  const second = reduceLoadBatches(first, [{ entries: [entry('b.txt', { size: 3 }), entry('c.txt')] }], null, false)
  assert.deepEqual(second.map((item) => item.name), ['a.txt', 'b.txt', 'c.txt'])
  assert.equal(second[0], first[0])
  assert.equal(second[1].size, 3)
})

test('a remove noted during the load is not resurrected by a later batch', () => {
  const b = entry('b.txt')
  const overlay = noteDelta(
    { removes: new Set(), upserts: new Map() },
    { removes: ['/d/a.txt'], upserts: [] },
  )
  const next = reduceLoadBatches([b], [{ entries: [entry('a.txt'), b] }], overlay, false)
  assert.deepEqual(next.map((item) => item.name), ['b.txt'])
  assert.equal(next[0], b)
})

test('an upsert during the load wins over the stale scanned entry', () => {
  const fresh = entry('a.txt', { size: 9, mtime_ms: 3 })
  const overlay = noteDelta({ removes: new Set(), upserts: new Map() }, { removes: [], upserts: [fresh] })
  const next = reduceLoadBatches([], [{ entries: [entry('a.txt', { size: 1 })] }], overlay, false)
  assert.equal(next.length, 1)
  assert.equal(next[0], fresh)
})

test('hidden names in a batch stay out unless showHidden is on', () => {
  const hidden = reduceLoadBatches(
    [],
    [{ entries: [entry('a.txt'), entry('.secret')] }],
    null,
    false,
  )
  assert.deepEqual(hidden.map((item) => item.name), ['a.txt'])
  const shown = reduceLoadBatches([], [{ entries: [entry('.secret')] }], null, true)
  assert.deepEqual(shown.map((item) => item.name), ['.secret'])
})

test('ten thousand paths arrive in batches without duplicate keys', () => {
  const all = []
  for (let i = 0; i < 10000; i++) {
    const name = `f${String(i).padStart(6, '0')}.txt`
    all.push(entry(name, { path: `/big/${name}`, size: 32 }))
  }
  let loaded = []
  let seenDone = false
  for (let offset = 0; offset < all.length; offset += LIST_BATCH) {
    const entries = all.slice(offset, offset + LIST_BATCH)
    const done = offset + LIST_BATCH >= all.length
    loaded = reduceLoadBatches(loaded, [{ entries, done, total: all.length }], null, false)
    if (offset === 0) {
      assert.equal(loaded.length, LIST_BATCH)
      assert.equal(loaded[0].name, 'f000000.txt')
      assert.equal(seenDone, false)
    }
    seenDone = done
  }
  assert.equal(loaded.length, 10000)
  assert.equal(new Set(loaded.map((item) => item.path)).size, 10000)
  assert.equal(loaded[0], all[0])
  assert.equal(seenDone, true)
})

test('status label shows the live fraction and a quiet refresh', () => {
  assert.equal(listCountLabel({ count: 0 }), '0 个项目')
  assert.equal(listCountLabel({ count: 0, listing: true, listingLive: true, total: null }), '正在读取…')
  const n = (value) => value.toLocaleString('zh-CN')
  assert.equal(
    listCountLabel({ count: 500, total: 10000, listing: true, listingLive: true }),
    `${n(500)} / ${n(10000)} 个项目`,
  )
  assert.equal(listCountLabel({ count: 10000, total: 10000, listing: true, listingLive: true }), `${n(10000)} 个项目`)
  assert.equal(listCountLabel({ count: 10000, listing: true, listingLive: false }), `${n(10000)} 个项目 · 正在读取`)
})

test('a partial failure cannot label its count as a complete directory', () => {
  assert.equal(listCountLabel({ count: 1, incomplete: true }), '1 个项目 · 读取未完成')
})

test('a sort correction restarts only an in-flight load', () => {
  assert.equal(shouldRestartLoad({ folderChanged: true, tickChanged: false, hasEntries: true, inFlight: false }), true)
  assert.equal(shouldRestartLoad({ folderChanged: false, tickChanged: true, hasEntries: true, inFlight: false }), true)
  assert.equal(shouldRestartLoad({ folderChanged: false, tickChanged: false, hasEntries: false, inFlight: false }), true)
  assert.equal(shouldRestartLoad({ folderChanged: false, tickChanged: false, hasEntries: true, inFlight: true }), true)
  assert.equal(shouldRestartLoad({ folderChanged: false, tickChanged: false, hasEntries: true, inFlight: false }), false)
})
