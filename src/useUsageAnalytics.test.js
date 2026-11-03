import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'
const require = createRequire(import.meta.url)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function mount(t, { native = true, production = true, mode = 'production', endpoint = 'https://counter.example/v1/events', optedOut = false, renderAbout = false } = {}) {
  const keys = ['__usageHook', 'fetch', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT']
  const previous = Object.fromEntries(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  const version = deferred(), requests = [], values = new Map()
  if (optedOut) values.set('bento-usage-analytics-enabled', 'false')
  let versionCalls = 0, current
  let failWrites = false
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (failWrites) throw Error('quota exceeded'); values.set(key, value) } }
  const bridge = { native, getVersion() { versionCalls++; return version.promise } }
  const fakeFetch = (url, init) => { requests.push({ url, init }); return new Promise(() => {}) }
  for (const [key, value] of Object.entries({ __usageHook: bridge, fetch: fakeFetch, localStorage: storage, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const bundle = await build({ stdin: { contents: "export {default} from './useUsageAnalytics'; export {default as AboutSection} from './components/AboutSection'", resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'js' }, jsx: 'automatic', bundle: true, write: false, format: 'cjs', platform: 'node',
    define: { 'import.meta.env': JSON.stringify({ PROD: production, MODE: mode, VITE_BENTO_ANALYTICS_URL: endpoint }), __BENTO_BUILD_ARCH__: '"aarch64"' },
    plugins: [{ name: 'hook-boundaries', setup(b) {
      b.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({ path: require.resolve(path), external: true }))
      b.onResolve({ filter: /^@tauri-apps\/api\/app$|(?:^|\/)api$/ }, ({ path }) => ({ path, namespace: 'native' }))
      b.onLoad({ filter: /.*/, namespace: 'native' }, ({ path }) => ({ contents: path.endsWith('/api') ? 'export const hasTauri = globalThis.__usageHook.native; export const api = {}' : 'export const getVersion = () => globalThis.__usageHook.getVersion()' }))
    } }],
  })
  const mod = { exports: {} }; new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports)
  function Harness() { current = mod.exports.default(); return renderAbout ? React.createElement(mod.exports.AboutSection, { analyticsEnabled: current[0], onAnalyticsEnabledChange: current[1], analyticsPersistenceError: current[2] }) : null }
  let renderer
  const error = console.error
  try { console.error = (...a) => { if (!String(a[0]).startsWith('react-test-renderer is deprecated.')) error(...a) }; await act(async () => { renderer = create(React.createElement(Harness)) }) }
  finally { console.error = error }
  t.after(async () => { await act(async () => renderer.unmount()); for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
  return { requests, values, version, setFailWrites: value => { failWrites = value }, text: () => JSON.stringify(renderer.toJSON()), get root() { return renderer.root }, get persistenceError() { return current[2] }, get versionCalls() { return versionCalls }, get enabled() { return current[0] }, change: value => current[1](value),
    async resolveVersion(value = '0.3.1') { await act(async () => version.resolve(value)) } }
}

test('root lifecycle uses native version and target architecture, and immediately aborts and persists opt-out', async t => {
  const h = await mount(t); await h.resolveVersion()
  assert.equal(h.requests.length, 1)
  assert.equal(JSON.parse(h.requests[0].init.body).arch, 'arm64')
  await act(async () => { h.change(false); assert.equal(h.requests[0].init.signal.aborted, true) })
  assert.equal(h.enabled, false)
  assert.equal(h.values.get('bento-usage-analytics-enabled'), 'false')
})

test('opting out before pending runtime metadata resolves cannot start a stale request', async t => {
  const h = await mount(t)
  await act(async () => { h.change(false); h.version.resolve('0.3.1'); await Promise.resolve() })
  assert.equal(h.requests.length, 0)
})

test('root lifecycle skips browser demos, development, test mode, missing endpoint and persisted opt-out', async t => {
  for (const options of [{ native: false }, { production: false }, { mode: 'test' }, { endpoint: '' }, { optedOut: true }]) {
    await t.test(JSON.stringify(options), async t => {
      const h = await mount(t, options)
      await h.resolveVersion()
      assert.equal(h.versionCalls, 0)
      assert.equal(h.requests.length, 0)
    })
  }
})


test('failed opt-out save still cancels immediately and About warns until retry saves the choice', async t => {
  const h = await mount(t, { renderAbout: true }); await h.resolveVersion()
  assert.equal(h.requests.length, 1)
  h.setFailWrites(true)
  await act(async () => { h.change(false); assert.equal(h.requests[0].init.signal.aborted, true) })
  assert.equal(h.enabled, false)
  assert.equal(h.persistenceError, true)
  assert.equal(h.values.has('bento-usage-analytics-enabled'), false)
  const warning = h.root.findByProps({ role: 'alert' }).children.join('')
  assert.match(warning, /stopped for this session/)
  assert.match(warning, /next launch/)
  const retry = () => h.root.findAllByType('button').find(node => node.children.join('') === 'Retry saving')
  assert.ok(retry())
  h.setFailWrites(false)
  await act(async () => retry().props.onClick())
  assert.equal(h.persistenceError, false)
  assert.equal(h.values.get('bento-usage-analytics-enabled'), 'false')
  assert.equal(h.root.findAllByProps({ role: 'alert' }).length, 0)
  assert.equal(h.requests.length, 1)
})
