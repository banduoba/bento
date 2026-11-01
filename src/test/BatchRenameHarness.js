import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'
const require = createRequire(import.meta.url)
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../components/BatchRenameDialog.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  plugins: [{ name: 'regex-ipc', setup(b) {
    b.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({ path: require.resolve(path), external: true }))
    b.onResolve({ filter: /(?:^|\/)api(?:\.js)?$/ }, () => ({ path: 'api', namespace: 'test' }))
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const api = { previewRegexRename: (...args) => globalThis.__batchIPC(...args) }' }))
  } }],
})
export const item = (name, is_dir = false) => ({ name, is_dir, path: `/fixture/${name}`, size: 0, mtime_ms: new Date(2024, 0, 2).getTime(), btime_ms: 0, ext: '' })
export async function mountBatch(t, items = [item('sample_1.txt'), item('sample_2.md')]) {
  const previous = Object.fromEntries(['window', '__batchIPC', 'IS_REACT_ACT_ENVIRONMENT'].map(k => [k, globalThis[k]]))
  const requests = [], applied = []
  globalThis.window = new EventTarget()
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.__batchIPC = (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject }))
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports)
  const props = { items, onCancel() {}, onApply: async rows => applied.push(rows) }
  let renderer
  let commitProbe
  // A parent layout effect runs after the dialog commits, before passive effects.
  // This exposes native event listeners that still retain the previous render.
  function CommitProbe({ dialogProps }) {
    React.useLayoutEffect(() => { commitProbe?.() })
    return React.createElement(mod.exports.default, dialogProps)
  }
  const oldError = console.error
  try {
    console.error = (...args) => { if (!String(args[0]).startsWith('react-test-renderer is deprecated.')) oldError(...args) }
    await act(async () => { renderer = create(React.createElement(CommitProbe, { dialogProps: props })) })
  } finally { console.error = oldError }
  let mounted = true
  const unmount = async () => { if (mounted) { await act(async () => renderer.unmount()); mounted = false } }
  t.after(async () => { await unmount(); for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v } })
  const button = text => renderer.root.findAllByType('button').find(b => b.children.join('') === text)
  const inputs = () => renderer.root.findAllByType('input')
  const change = async (index, value) => act(async () => inputs()[index].props.onChange({ target: { value } }))
  const regex = async (checked = true) => {
    const box = inputs().find(n => n.props.type === 'checkbox')
    if (!box) throw new Error('regex checkbox missing')
    await act(async () => box.props.onChange({ target: { checked } }))
  }
  return { requests, applied, button, inputs, change, regex, unmount, get root() { return renderer.root },
    text: () => JSON.stringify(renderer.toJSON()),
    click: async text => act(async () => button(text).props.onClick()),
    resolve: async (i, value) => act(async () => requests[i].resolve(value)),
    reject: async (i, value) => act(async () => requests[i].reject(value)),
    update: async (patch, duringCommit) => {
      Object.assign(props, patch)
      commitProbe = duringCommit
      try { await act(async () => renderer.update(React.createElement(CommitProbe, { dialogProps: props }))) }
      finally { commitProbe = null }
    },
    enter: async () => { const e = new Event('keydown'); Object.defineProperty(e, 'key', { value: 'Enter' }); await act(async () => window.dispatchEvent(e)) },
  }
}
