import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'

// Compile the real component for Node. Only IPC and the native event boundary
// are replaced. A viewport adapter renders every row without DOM measurements;
// React effects, watcher callbacks and directory load state remain real.
const require = createRequire(import.meta.url)
const bridgeKey = '__bentoPaneTestBridge'
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../components/Pane.jsx', import.meta.url))],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  define: { 'import.meta.env.DEV': 'false' },
  jsx: 'automatic',
  plugins: [{
    name: 'pane-native-boundaries',
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
          ? `export const hasTauri = true; export const fileSrc = (path) => path; export const api = new Proxy({}, { get: (_, key) => (...args) => globalThis.${bridgeKey}.api[key](...args) })`
          : path === 'watch'
            ? `export const setWatch = () => {}; export const clearWatch = () => {}; export const onFsChange = (fn) => globalThis.${bridgeKey}.subscribe(fn)`
            : path === 'viewport'
              ? 'export const useVirtualizer = (opts) => ({ getTotalSize: () => opts.count * opts.estimateSize(), getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({ index, key: opts.getItemKey(index), start: index * opts.estimateSize() })), scrollToIndex: () => {} })'
              : path === 'icon'
                ? 'export default function FileIcon() { return null }'
            : path === 'channel'
              ? 'export class Channel {}'
              : 'export const trace = () => {}; export const makeDragPreview = () => Promise.resolve(null); export const fallbackPreview = () => null; export const runNativeDrag = () => Promise.resolve()',
        loader: 'js',
      }))
    },
  }],
})
const componentModule = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text + '\n//# sourceURL=Pane.test-bundle.cjs')(require, componentModule, componentModule.exports)
const Pane = componentModule.exports.default

export const entry = (name, extra = {}) => ({
  path: `/d/${name}`, name, is_dir: false, size: 1, mtime_ms: 1, btime_ms: 1, ext: '', ...extra,
})

export async function mountPane(t, rendererOptions, apiOverrides = {}) {
  const previous = Object.fromEntries(['window', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT', bridgeKey].map((key) => [key, globalThis[key]]))
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.window = new EventTarget()
  let frameSerial = 0
  const frames = new Map()
  globalThis.requestAnimationFrame = (fn) => { frames.set(++frameSerial, fn); return frameSerial }
  globalThis.cancelAnimationFrame = (id) => frames.delete(id)
  const requests = []
  const childRequests = []
  const cancelled = []
  const subscribers = new Set()
  let rows = []
  let stats
  const navigations = []
  const props = {
    index: 0, area: 'a', home: '/d', focused: true,
    pane: { active: 0, tabs: [{ id: 'a', path: '/d', history: ['/d'], hi: 0, sortKey: 'name', sortDir: 'asc' }] },
    cfg: { showHidden: false }, selection: new Set(), cutSet: new Set(), tick: 0,
    onRowsCache: (_, value) => { rows = value }, onStats: (_, value) => { stats = value },
    onNav: (...args) => navigations.push(args), onFocus: () => {},
  }
  globalThis[bridgeKey] = {
    api: {
      listDirStream(path, showHidden, id, sortKey, sortDir, channel) {
        return new Promise((resolve, reject) => requests.push({ path, showHidden, id, sortKey, sortDir, channel, resolve, reject }))
      },
      cancelListDir(id) { cancelled.push(id); return Promise.resolve() },
      listDir(path, showHidden) { return new Promise((resolve, reject) => childRequests.push({ path, showHidden, resolve, reject })) },
      dirActivity: () => Promise.resolve([]),
      resolvePath: path => Promise.resolve(path),
      ...apiOverrides,
    },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn) },
  }
  let renderer
  let mounted = true
  const error = console.error
  try {
    // React 19 deprecates this renderer, but it still runs real hook lifecycles.
    console.error = (...args) => {
      if (!String(args[0]).startsWith('react-test-renderer is deprecated.')) error(...args)
    }
    await act(async () => { renderer = create(React.createElement(Pane, props), rendererOptions) })
  } finally { console.error = error }
  const unmount = async () => {
    if (!mounted) return
    await act(async () => renderer.unmount())
    mounted = false
  }
  t.after(async () => {
    await unmount()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  })
  return {
    requests, childRequests, cancelled, frames, navigations, unmount,
    get rows() { return rows }, get stats() { return stats },
    get root() { return renderer.root },
    async batch(request, entries, done = false, total = 1000) {
      await act(async () => request.channel.onmessage({ entries, done, total }))
    },
    async resolve(request) { await act(async () => request.resolve()) },
    async reject(request, reason = '读取中断') { await act(async () => request.reject(reason)) },
    async resolveKids(request, entries) { await act(async () => request.resolve({ entries })) },
    async expand(path) {
      const row = renderer.root.findByProps({ 'data-path': path })
      await act(async () => row.findByProps({ title: '展开' }).props.onClick({ stopPropagation() {} }))
    },
    async change(change) { await act(async () => subscribers.forEach((fn) => fn([{ dir: '/d', upserts: [], removes: [], ...change }]))) },
    async update(patch) { if (patch.pane) patch = { ...patch, pane: { ...patch.pane, tabs: patch.pane.tabs.map((tab) => ({ history: [tab.path], hi: 0, ...tab })) } }; Object.assign(props, patch); await act(async () => renderer.update(React.createElement(Pane, props))) },
    async flushFrames() { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()) }) },
  }
}
