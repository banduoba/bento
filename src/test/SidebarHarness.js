import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'
const require = createRequire(import.meta.url)
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../components/Sidebar.jsx', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', loader: { '.png': 'dataurl' },
  plugins: [{ name: 'sidebar-io', setup(b) {
    b.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({ path: require.resolve(path), external: true }))
    b.onResolve({ filter: /(?:^|\/)(api|systemIcons|fsWatch)(?:\.js)?$|^@tauri-apps\/api\/core$/ }, ({ path }) => ({ path, namespace: 'sidebar-io' }))
    b.onLoad({ filter: /.*/, namespace: 'sidebar-io' }, ({ path }) => ({ contents:
      path.includes('systemIcons') ? 'export const getCachedIcon = () => null; export const requestSystemIcons = p => globalThis.__sidebar.icons.push([...p]); export const subscribeSystemIcons = () => () => {}' :
      path.includes('fsWatch') ? 'export const setWatch = (o,p) => globalThis.__sidebar.watches.set(o,p); export const clearWatch = o => globalThis.__sidebar.watches.delete(o); export const onFsChange = cb => { globalThis.__sidebar.change = cb; return () => { globalThis.__sidebar.change = null } }' :
      path.includes('@tauri') ? 'export const invoke = () => Promise.resolve()' :
      'export const api = { listDir: () => Promise.resolve({ entries: [{name:"FixtureVolume", path:"/Volumes/FixtureVolume", is_dir:true}] }), listSubdirectories: (...args) => globalThis.__sidebar.list(...args) }',
    }))
  } }],
})
export async function mountSidebar(t, patch = {}) {
  const previous = { __sidebar: globalThis.__sidebar, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  const requests = [], opens = [], menus = [], drops = [], switched = [], workspaceMenus = [], icons = [], watches = new Map()
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.__sidebar = { icons, watches, list: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })) }
  const mod = { exports: {} }; new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports)
  const props = { home: '/home', favorites: [{ name: 'Docs', path: '/docs' }], focusedPath: '/home', tick: 0, showHidden: false, autoRefresh: true,
    workspaces: [{ id: 'w', name: 'Workspace' }], activeWorkspace: 'w', onSwitchWorkspace: id => switched.push(id), onWorkspaceMenu: (...args) => workspaceMenus.push(args), onCreateWorkspace() {},
    onOpen: p => opens.push(p), onMenu: (...args) => menus.push(args), onDropPin: e => drops.push(e), ...patch }
  let renderer; const oldError = console.error
  try { console.error = (...args) => { if (!String(args[0]).startsWith('react-test-renderer is deprecated.')) oldError(...args) }
    await act(async () => { renderer = create(React.createElement(mod.exports.default, props), { createNodeMock: () => ({ addEventListener() {}, removeEventListener() {}, focus() {}, select() {} }) }) })
  } finally { console.error = oldError }
  let mounted = true
  const unmount = async () => { if (mounted) { await act(async () => renderer.unmount()); mounted = false } }
  t.after(async () => { await unmount(); for (const [k,v] of Object.entries(previous)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v } })
  const h = { requests, opens, menus, drops, switched, workspaceMenus, icons, watches, get root() { return renderer.root }, text: () => JSON.stringify(renderer.toJSON()), unmount,
    row: path => renderer.root.findAll(n => n.type === 'div' && n.props.className?.includes('sb-item') && n.props.title === path)[0],
    disclosure: label => renderer.root.findAllByType('button').find(b => b.props['aria-label'] === label),
    run: fn => act(async () => fn()), resolve: (i, entries = [], truncated = false) => act(async () => requests[i].resolve({ entries, truncated })), reject: (i, e) => act(async () => requests[i].reject(e)),
    update: patch => act(async () => { Object.assign(props, patch); renderer.update(React.createElement(mod.exports.default, props)) }),
    emit: payload => act(async () => globalThis.__sidebar.change?.(payload)),
  }
  return h
}
export const event = (props = {}) => ({ button: 0, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, ...props })
