import test from 'node:test'
import assert from 'node:assert/strict'
import * as updates from './updateCheck.js'

const release = (tag_name = 'v1.10.0', html_url = 'https://github.com/banduoba/bento/releases/tag/v1.10.0') => ({
  tag_name, html_url, draft: false, prerelease: false,
})
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data })

test('SemVer comparison respects numeric segments, prerelease precedence, and ignored build metadata', () => {
  for (const [a, b, want] of [
    ['v1.10.0', '1.9.0', 1], ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0-alpha.2', '1.0.0-alpha.10', -1], ['1.0.0-1', '1.0.0-alpha', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1], ['1.0.0+build.3', 'v1.0.0+other', 0],
    ['9007199254740993.0.0', '9007199254740992.0.0', 1],
  ]) assert.equal(updates.compareVersions(a, b), want, `${a} versus ${b}`)
})

test('invalid SemVer cannot be treated as a current release', () => {
  for (const value of ['1.0', '01.2.3', '1.0.0-01', 'release-1.0.0', '', null, '1.0.0+', '1.0.0\n', ' 1.0.0', '1.0.0 ']) {
    assert.equal(updates.compareVersions(value, '1.0.0'), null, String(value))
    assert.equal(updates.compareVersions('1.0.0', value), null, String(value))
  }
})

test('latest release check requests only the public official endpoint and derives available/current/ahead', async () => {
  const requests = []
  const fetchImpl = async (...args) => { requests.push(args); return response(release()) }
  assert.deepEqual(await updates.fetchLatestRelease('1.9.0', { fetchImpl }), {
    status: 'available', version: 'v1.10.0', url: 'https://github.com/banduoba/bento/releases/tag/v1.10.0',
  })
  assert.equal((await updates.fetchLatestRelease('1.10.0', { fetchImpl })).status, 'current')
  assert.equal((await updates.fetchLatestRelease('2.0.0', { fetchImpl })).status, 'ahead')
  assert.equal(requests[0][0], 'https://api.github.com/repos/banduoba/bento/releases/latest')
  assert.equal(requests[0][1].credentials, 'omit')
})

test('a current prerelease is behind a stable release with the same numeric version', async () => {
  const result = await updates.fetchLatestRelease('1.10.0-rc.1', { fetchImpl: async () => response(release()) })
  assert.equal(result.status, 'available')
})

test('untrusted remote URLs never become a browser target', async () => {
  for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'https://evil.example/banduoba/bento/releases/tag/a',
    'https://github.com/other/bento/releases/tag/a', 'https://github.com/banduoba/bento/releases/tag/a?next=file:x']) {
    const result = await updates.fetchLatestRelease('1.0.0', { fetchImpl: async () => response(release('v1.10.0', url)) })
    assert.equal(result.url, 'https://github.com/banduoba/bento/releases/latest')
  }
})

test('404 is a no-release result; HTTP, network, malformed and invalid tags are retryable errors', async () => {
  assert.equal((await updates.fetchLatestRelease('1.0.0', { fetchImpl: async () => response({}, 404) })).status, 'not-found')
  for (const [fetchImpl, code] of [
    [async () => response({}, 403), 'rate-limit'], [async () => response({}, 429), 'rate-limit'],
    [async () => response({}, 500), 'http'], [async () => { throw new TypeError('offline') }, 'network'],
    [async () => response(release('garbage')), 'invalid'], [async () => response(null), 'invalid'],
    [async () => response({ ...release(), draft: true }), 'invalid'],
    [async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } }), 'invalid'],
  ]) await assert.rejects(updates.fetchLatestRelease('1.0.0', { fetchImpl }), error => error.code === code)
})

test('abort and timeout settle even when fetch ignores its signal and do not accept a late result', async () => {
  let finish
  const fetchImpl = () => new Promise(resolve => { finish = resolve })
  const controller = new AbortController()
  const pending = updates.fetchLatestRelease('1.0.0', { fetchImpl, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  finish(response(release()))
  await assert.rejects(updates.fetchLatestRelease('1.0.0', { fetchImpl, timeoutMs: 5 }), error => error.code === 'timeout')
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(updates.fetchLatestRelease('1.0.0', { fetchImpl, signal: cancelled.signal }), { name: 'AbortError' })
})
