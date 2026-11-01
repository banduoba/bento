import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'
const require = createRequire(import.meta.url)
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../components/SidebarLayout.jsx', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  plugins: [{ name: 'react-external', setup(b) { b.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({ path: require.resolve(path), external: true })) } }],
})
export async function mountLayout(t, width = 260, viewport = 1200) {
  const previous = { window: globalThis.window, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  const listeners = new Map(), commits = []
  const win = { innerWidth: viewport, addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) }, removeEventListener(type, fn) { listeners.get(type)?.delete(fn) } }
  globalThis.window = win; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let captured = null, focused = false, renders = 0, mounts = 0, unmounts = 0
  const node = { focus() { focused = true }, setPointerCapture(id) { captured = id }, hasPointerCapture(id) { return captured === id }, releasePointerCapture(id) { if (captured === id) captured = null } }
  function Child() { renders++; React.useEffect(() => { mounts++; return () => { unmounts++ } }, []); return React.createElement('nav', null, 'tree') }
  const child = React.createElement(Child)
  const mod = { exports: {} }; new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports)
  const props = { width, onWidthCommit: n => commits.push(n), children: child }
  let renderer, mounted = true
  const oldError = console.error
  try { console.error = (...args) => { if (!String(args[0]).startsWith('react-test-renderer is deprecated.')) oldError(...args) }
    await act(async () => { renderer = create(React.createElement(mod.exports.default, props), { createNodeMock: () => node }) })
  } finally { console.error = oldError }
  const unmount = async () => { if (mounted) { await act(async () => renderer.unmount()); mounted = false } }
  t.after(async () => { await unmount(); for (const [k,v] of Object.entries(previous)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v } })
  return {
    commits, listeners, node, unmount, get focused() { return focused }, get captured() { return captured }, get renders() { return renders }, get mounts() { return mounts }, get unmounts() { return unmounts },
    get separator() { return renderer.root.findByProps({ role: 'separator' }) },
    get value() { return this.separator.props['aria-valuenow'] },
    run: fn => act(async () => fn()),
    async send(handler, patch = {}) { const e = { button: 0, pointerId: 7, clientX: 260, currentTarget: node, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, ...patch }; await act(async () => this.separator.props[handler]?.(e)); return e },
    async emit(type) { await act(async () => { for (const fn of listeners.get(type) || []) fn() }) },
    async resize(n) { win.innerWidth = n; await this.emit('resize') },
    async update(n) { props.width = n; await act(async () => renderer.update(React.createElement(mod.exports.default, props))) },
  }
}
