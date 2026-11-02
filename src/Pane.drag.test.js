import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const bridgeKey = '__bentoPaneDragTestBridge'
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./components/Pane.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  define: { 'import.meta.env.DEV': 'false' }, jsx: 'automatic',
  plugins: [{
    name: 'pane-drag-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({ path: require.resolve(path), external: true }))
      builder.onResolve({ filter: /(?:^|\/)api(?:\.js)?$/ }, () => ({ path: 'api', namespace: 'test' }))
      builder.onResolve({ filter: /(?:^|\/)fsWatch$/ }, () => ({ path: 'watch', namespace: 'test' }))
      builder.onResolve({ filter: /(?:^|\/)nativeDrag$/ }, () => ({ path: 'drag', namespace: 'test' }))
      builder.onResolve({ filter: /^@tanstack\/react-virtual$/ }, () => ({ path: 'viewport', namespace: 'test' }))
      builder.onResolve({ filter: /(?:^|\/)FileIcon$/ }, () => ({ path: 'icon', namespace: 'test' }))
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'channel', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({
        contents: path === 'api'
          ? `export const hasTauri = true; export const api = new Proxy({}, { get: (_, key) => (...args) => globalThis.${bridgeKey}.api[key](...args) })`
          : path === 'watch'
            ? 'export const setWatch = () => {}; export const clearWatch = () => {}; export const onFsChange = () => () => {}'
            : path === 'viewport'
              ? 'export const defaultRangeExtractor = () => []; export const useVirtualizer = (opts) => ({ measure: () => {}, resizeItem: () => {}, getTotalSize: () => opts.count * opts.estimateSize(), getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({ index, key: opts.getItemKey(index), start: index * opts.estimateSize(), size: opts.estimateSize() })), scrollToIndex: () => {} })'
              : path === 'icon'
                ? 'export default function FileIcon() { return null }'
                : path === 'channel'
                  ? 'export class Channel {}'
                  : `export const trace = () => {}; export const makeDragPreview = (count) => { const previews = globalThis.${bridgeKey}.previews; previews.push(count); return Promise.resolve('preview-' + previews.length) }; export const fallbackPreview = () => null; export const runNativeDrag = (paths, icon, ended) => { globalThis.${bridgeKey}.sessions.push({ paths, icon, ended }); return Promise.resolve() }`,
        loader: 'js',
      }))
    },
  }],
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports)
const Pane = mod.exports.default

const entry = name => ({ path: `/d/${name}`, name, is_dir: false, size: 1, mtime_ms: 1, btime_ms: 1, ext: '' })
const mouse = (patch = {}) => ({
  button: 0, clientX: 10, clientY: 20, metaKey: false, ctrlKey: false, shiftKey: false,
  target: { closest: () => null }, ...patch,
})

async function mount(t) {
  const old = Object.fromEntries(['window', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT', bridgeKey].map(key => [key, globalThis[key]]))
  globalThis.window = new EventTarget()
  globalThis.ResizeObserver = class { observe() {} disconnect() {} }
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const sessions = [], previews = [], requests = [], selections = []
  globalThis[bridgeKey] = {
    sessions, previews,
    api: {
      listDirStream: (_path, _hidden, _id, _sort, _dir, channel) => new Promise(resolve => requests.push({ channel, resolve })),
      cancelListDir: () => Promise.resolve(),
      dirActivity: () => Promise.resolve([]),
    },
  }
  const props = {
    index: 0, area: 'a', home: '/d', focused: true,
    pane: { active: 0, tabs: [{ id: 'a', path: '/d', history: ['/d'], hi: 0, sortKey: 'name', sortDir: 'asc' }] },
    cfg: { showHidden: false }, selection: new Set(), cutSet: new Set(), tick: 0,
    onRowsCache: () => {}, onStats: () => {}, onFocus: () => {},
    onSelect: (_tab, paths) => selections.push(paths),
  }
  let renderer
  const error = console.error
  try {
    console.error = (...args) => {
      if (!String(args[0]).startsWith('react-test-renderer is deprecated.')) error(...args)
    }
    await act(async () => { renderer = create(React.createElement(Pane, props)) })
    await act(async () => requests[0].channel.onmessage({ entries: ['alpha', 'beta', 'gamma'].map(entry), done: true, total: 3 }))
  } finally { console.error = error }
  t.after(async () => {
    await act(async () => renderer?.unmount())
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  })
  const row = name => renderer.root.findByProps({ 'data-path': `/d/${name}` })
  const update = patch => act(async () => { Object.assign(props, patch); renderer.update(React.createElement(Pane, props)) })
  const press = (name, patch) => act(async () => row(name).props.onMouseDown(mouse(patch)))
  const click = (name, patch) => act(async () => row(name).props.onClick(mouse(patch)))
  const move = (x = 16) => act(async () => { const e = new Event('mousemove'); e.clientX = x; e.clientY = 20; window.dispatchEvent(e) })
  const up = () => act(async () => window.dispatchEvent(new Event('mouseup')))
  return { sessions, previews, selections, row, update, press, click, move, up }
}

test('a new press starts the newly pressed file while an older native end is missing or late', async t => {
  const h = await mount(t)
  await h.press('alpha')
  await h.move()
  assert.deepEqual(h.sessions.map(session => session.paths), [['/d/alpha']])

  await h.up() // Native session is still pending: no ended callback yet.
  await h.press('beta')
  assert.deepEqual([...h.selections.at(-1)], ['/d/beta'])
  await h.update({ selection: h.selections.at(-1) })
  assert.match(h.row('beta').props.className, /selected/)
  await h.move()
  assert.deepEqual(h.sessions.map(session => session.paths), [['/d/alpha'], ['/d/beta']])
  assert.deepEqual(h.previews, [1, 1])
  assert.deepEqual(h.sessions.map(session => session.icon), ['preview-1', 'preview-2'])
  assert.match(h.row('beta').props.className, /dragging/)

  await act(async () => h.sessions[0].ended())
  assert.match(h.row('beta').props.className, /dragging/, 'old end must not clear the new session')
  await act(async () => h.sessions[1].ended())
  assert.doesNotMatch(h.row('beta').props.className, /dragging/)
})

test('pressing a selected member still drags the entire selection', async t => {
  const h = await mount(t)
  await h.update({ selection: new Set(['/d/alpha', '/d/beta']) })
  await h.press('alpha')
  assert.equal(h.selections.length, 0, 'press must preserve the selection')
  await h.move()
  assert.deepEqual(h.sessions[0].paths, ['/d/alpha', '/d/beta'])
  assert.equal(h.sessions[0].icon, 'preview-1')
  await h.click('alpha')
  assert.equal(h.selections.length, 0, 'drag click must not collapse the selection')
})

test('plain press selects its row immediately; Command and Shift keep click selection rules', async t => {
  const h = await mount(t)
  await h.update({ selection: new Set(['/d/alpha']) })
  await h.press('beta')
  assert.deepEqual([...h.selections.at(-1)], ['/d/beta'])
  await h.update({ selection: h.selections.at(-1) })
  await h.click('beta')
  assert.deepEqual([...h.selections.at(-1)], ['/d/beta'])

  await h.up()
  const beforeCommand = h.selections.length
  await h.press('alpha', { metaKey: true })
  assert.equal(h.selections.length, beforeCommand)
  await h.click('alpha', { metaKey: true })
  assert.deepEqual([...h.selections.at(-1)].sort(), ['/d/alpha', '/d/beta'])
  await h.update({ selection: h.selections.at(-1) })

  await h.up()
  const beforeShift = h.selections.length
  await h.press('gamma', { shiftKey: true })
  assert.equal(h.selections.length, beforeShift)
  await h.click('gamma', { shiftKey: true })
  assert.deepEqual([...h.selections.at(-1)].sort(), ['/d/alpha', '/d/beta', '/d/gamma'])
})
