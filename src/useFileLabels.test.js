import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const bundle = await build({ entryPoints: [fileURLToPath(new URL('./useFileLabels.js', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'labels-boundary', setup(b) {
  b.onResolve({ filter: /^react$/ }, ({ path }) => ({ path: require.resolve(path), external: true }))
  b.onResolve({ filter: /(?:^|\/)api(?:\.js)?$/ }, () => ({ path: 'api', namespace: 'test' }))
  b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ loader: 'js', contents: 'export const api = new Proxy({}, {get:(_,key)=>(...args)=>globalThis.__labelsTest[key](...args)})' }))
  b.onLoad({ filter: /\/useFileLabels\.js$/ }, async ({ path }) => ({ loader: 'js', contents: await readFile(path, 'utf8') + "\nexport { applyFileLabel, FILE_LABEL_EVENT } from './fileLabels';" }))
} }] })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

async function mount(t, paths, overrides = {}) {
  const saved = Object.fromEntries(['window', '__labelsTest', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]))
  globalThis.window = new EventTarget()
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const requests = [], writes = []
  globalThis.__labelsTest = {
    getFileLabels: paths => { const request = { ...deferred(), paths }; requests.push(request); return request.promise },
    setFileLabel: async (paths, color) => { writes.push([paths, color]); return paths.map(path => ({ path, color })) },
    ...overrides,
  }
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports)
  const Probe = props => React.createElement('labels-probe', { labels: mod.exports.default(props.paths, props.revision) })
  const props = { paths, revision: 0 }
  let renderer, live = true
  const run = callback => act(async () => { await callback() })
  const err = console.error
  try {
    console.error = (...args) => { if (!String(args[0]).startsWith('react-test-renderer is deprecated.')) err(...args) }
    await run(() => { renderer = create(React.createElement(Probe, props)) })
  } finally { console.error = err }
  const unmount = async () => { if (live) { live = false; await run(() => renderer.unmount()) } }
  t.after(async () => { await unmount(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value } })
  return {
    requests, writes, run, unmount,
    get labels() { return renderer.root.findByType('labels-probe').props.labels },
    apply: (paths, color) => mod.exports.applyFileLabel(paths, color),
    async update(patch) { Object.assign(props, patch); await run(() => renderer.update(React.createElement(Probe, props))) },
    resolve: (index, values) => run(() => requests[index].resolve(values)),
  }
}

test('metadata reads use bounded batches and replace queued navigation with the newest view', async t => {
  const h = await mount(t, Array.from({ length: 300 }, (_, i) => `/old/${i}`))
  assert.equal(h.requests[0].paths.length, 128)
  await h.update({ paths: ['/b'] })
  await h.update({ paths: ['/c'] })
  await h.update({ paths: ['/latest'] })
  assert.equal(h.requests.length, 1, 'only one uninterruptible native read may be active per view')
  await h.resolve(0, [{ path: '/old/0', color: 6 }])
  assert.deepEqual(h.requests[1].paths, ['/latest'])
  assert.deepEqual(h.labels, {})
  await h.resolve(1, [{ path: '/latest', color: 4 }])
  assert.deepEqual(h.labels, { '/latest': 4 })
})

test('a successful write updates mounted views and an older read cannot revert the color', async t => {
  const h = await mount(t, ['/a'])
  await h.resolve(0, [{ path: '/a', color: 6 }])
  await h.update({ revision: 1 })
  await h.run(() => h.apply(['/a'], 4))
  assert.equal(h.labels['/a'], 4)
  await h.resolve(1, [{ path: '/a', color: 6 }])
  assert.equal(h.labels['/a'], 4)
  assert.equal(h.requests.length, 3)
  await h.resolve(2, [{ path: '/a', color: 4 }])
  await h.run(() => h.apply(['/a'], 0))
  assert.equal(h.labels['/a'], 0)
  await h.resolve(3, [{ path: '/a', color: 0 }])
})

test('focus refreshes Finder changes and failed metadata never hides or clears known files', async t => {
  const h = await mount(t, ['/a'])
  await h.resolve(0, [{ path: '/a', color: 6 }])
  await h.run(() => window.dispatchEvent(new Event('focus')))
  await h.run(() => h.requests[1].reject(new Error('Metadata unavailable')))
  assert.equal(h.labels['/a'], 6)
  await h.run(() => window.dispatchEvent(new Event('focus')))
  await h.resolve(2, [{ path: '/a', color: 0 }])
  assert.equal(h.labels['/a'], 0)
})

test('unmount cancels remaining batches of an active metadata read', async t => {
  const h = await mount(t, Array.from({ length: 300 }, (_, i) => `/dir/${i}`))
  await h.unmount()
  await h.resolve(0, [{ path: '/dir/0', color: 6 }])
  assert.equal(h.requests.length, 1)
})

test('incomplete write receipts are reported as errors and do not poison later writes', async t => {
  let bad = true
  const h = await mount(t, ['/a'], {
    setFileLabel: async (paths, color) => bad ? [] : paths.map(path => ({ path, color })),
  })
  await h.run(async () => { await assert.rejects(h.apply(['/a'], 2), /无法确认/) })
  assert.notEqual(h.labels['/a'], 2)
  bad = false
  await h.run(() => h.apply(['/a'], 2))
  assert.equal(h.labels['/a'], 2)
  await h.resolve(0, [{ path: '/a', color: 0 }])
  assert.equal(h.labels['/a'], 2)
  await h.resolve(1, [{ path: '/a', color: 2 }])
})
