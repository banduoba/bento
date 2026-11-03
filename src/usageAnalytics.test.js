import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageAnalytics, readAnalyticsEnabled, writeAnalyticsEnabled } from './usageAnalytics.js'

const ID = 'a283c819-939b-42cf-b94f-84f2653fa134'
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function fixture(overrides = {}) {
  let time = Date.parse('2026-11-03T12:00:00Z'), next = 1
  const values = new Map(), timers = new Map(), requests = []
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }
  const options = { endpoint: 'https://counter.example/v1/events', version: '0.3.1', arch: 'arm64', native: true, production: true,
    storage, randomUUID: () => ID, now: () => time,
    setTimeoutImpl: (fn, delay) => { const id = next++; timers.set(id, { fn, at: time + delay }); return id },
    clearTimeoutImpl: id => timers.delete(id),
    fetchImpl: (url, init) => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); requests.push({ url, init, resolve, reject }); return promise }, ...overrides }
  return { options, requests, values, storage, timers,
    start: () => createUsageAnalytics(options),
    async advance(ms) { time += ms; const due = [...timers].filter(([, timer]) => timer.at <= time); for (const [id, timer] of due) { if (timers.delete(id)) timer.fn() } await flush() },
    async finish(index = requests.length - 1, ok = true) { requests[index].resolve({ ok }); await flush() },
  }
}

test('default preference is enabled, persists opt-out, and fails closed on inaccessible storage', () => {
  const h = fixture()
  assert.equal(readAnalyticsEnabled(h.storage), true)
  writeAnalyticsEnabled(false, h.storage)
  assert.equal(readAnalyticsEnabled(h.storage), false)
  writeAnalyticsEnabled(true, h.storage)
  assert.equal(readAnalyticsEnabled(h.storage), true)
  assert.equal(readAnalyticsEnabled({ getItem() { throw Error('denied') } }), false)
})

test('sends only the fixed launch schema with persisted random identity and privacy request options', async () => {
  const h = fixture(); const stop = h.start(); await flush()
  assert.equal(h.requests.length, 1)
  const { url, init } = h.requests[0]
  assert.equal(url, h.options.endpoint)
  assert.equal(init.method, 'POST')
  assert.deepEqual(JSON.parse(init.body), { installationId: ID, version: '0.3.1', platform: 'macos', arch: 'arm64', type: 'launch' })
  assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error')
  await h.finish(); stop()
  const stopAgain = h.start(); await flush(); assert.equal(h.requests.length, 1); stopAgain()
})

test('long-running clients send again on the next UTC day, keeping their installation ID', async () => {
  const h = fixture(); const stop = h.start(); await flush(); await h.finish()
  await h.advance(43200000)
  assert.equal(h.requests.length, 2)
  assert.equal(JSON.parse(h.requests[1].init.body).installationId, ID)
  await h.finish(); stop()
  assert.equal(h.timers.size, 0)
})

test('unconfigured, invalid, non-native, development and disabled clients never create identity or send', async () => {
  for (const override of [{ endpoint: '' }, { endpoint: 'http://counter.example/v1/events' }, { endpoint: 'https://counter.example/v1/events?path=private' },
    { endpoint: 'https://user:password@counter.example/v1/events' }, { endpoint: 'https://counter.example/other' }, { native: false }, { production: false },
    { version: 'invalid' }, { version: '0.3.1\n' }, { version: '0.3.1-01' }, { arch: 'unknown' }, { enabled: false }]) {
    const h = fixture(override); const stop = h.start(); await flush()
    assert.equal(h.requests.length, 0, JSON.stringify(override)); assert.equal(h.values.size, 0); assert.equal(h.timers.size, 0); stop()
  }
})

test('HTTP/network failures retry at most three times per day, including across restarts', async () => {
  const h = fixture(); let stop = h.start(); await flush(); await h.finish(0, false)
  await h.advance(60000); h.requests[1].reject(Error('offline')); await flush()
  await h.advance(300000); await h.finish(2, false)
  await h.advance(300000); assert.equal(h.requests.length, 3)
  stop(); stop = h.start(); await flush(); assert.equal(h.requests.length, 3)
  await h.advance(86400000); assert.equal(h.requests.length, 4); stop()
})

test('opt-out aborts pending work, clears retry timers and rejects late success', async () => {
  const h = fixture(); const stop = h.start(); await flush()
  stop(); assert.equal(h.requests[0].init.signal.aborted, true); assert.equal(h.timers.size, 0)
  await h.finish(); assert.equal(h.requests.length, 1)
  // A late success did not mark the original day as sent.
  const resumed = h.start(); await flush(); assert.equal(h.requests.length, 2); resumed()
  await h.advance(86400000); assert.equal(h.requests.length, 2)
  const failed = fixture(); const cancel = failed.start(); await flush(); await failed.finish(0, false); cancel()
  await failed.advance(600000); assert.equal(failed.requests.length, 1); assert.equal(failed.timers.size, 0)
})

test('timeout settles fetch that ignores abort, and late completion cannot cancel a retry', async () => {
  const h = fixture(); const stop = h.start(); await flush()
  await h.advance(10000); assert.equal(h.requests[0].init.signal.aborted, true)
  await h.finish(0); await h.advance(43200000)
  assert.equal(h.requests.length, 2); stop(); assert.equal(h.timers.size, 0)
})

test('failed identity persistence never sends, corrupt identity is replaced with random UUID', async () => {
  const h = fixture({ storage: { getItem: () => null, setItem() { throw Error('full') } } })
  const stop = h.start(); await flush(); assert.equal(h.requests.length, 0); stop()
  const corrupt = fixture(); corrupt.values.set('bento-usage-analytics', '{"installationId":"hardware-id"}')
  const cancel = corrupt.start(); await flush(); assert.equal(JSON.parse(corrupt.requests[0].init.body).installationId, ID); cancel()
})

test('corrupt persisted attempt budgets fail closed for the rest of that UTC day', async () => {
  for (const attempts of [-1, null, '0', 1.5]) {
    const h = fixture()
    h.values.set('bento-usage-analytics', JSON.stringify({ installationId: ID, day: '2026-11-03', attempts, sent: false }))
    const stop = h.start(); await flush()
    assert.equal(h.requests.length, 0)
    await h.advance(43200000)
    assert.equal(h.requests.length, 1)
    stop()
  }
})
