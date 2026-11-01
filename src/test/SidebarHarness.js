import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { basename } from '../format.js'
import { isTextEditingElement } from '../textEditing.js'
import { resolveListKey, resolvePaneKey } from '../shortcuts.js'
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
    buttonKey: async (button, key, app) => {
      const event = new Event('keydown', { bubbles: true, cancelable: true })
      Object.defineProperties(event, { key: { value: key }, target: { value: button.instance } })
      await act(async () => {
        // Renderer has no DOM propagation/default actions: walk the real host ancestors,
        // then App's unchanged window callback, then the uncancelled button default.
        for (let node = button; node && !event.cancelBubble; node = node.parent) {
          if (typeof node.type === 'string') node.props.onKeyDown?.(event)
        }
        if (!event.cancelBubble) app.handle(event)
        if (!event.defaultPrevented && (key === 'Enter' || key === ' ')) button.props.onClick?.(event)
      })
      return event
    },
  }
  return h
}
export const event = (props = {}) => ({ button: 0, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, ...props })

// Keep the real App shortcut callback and real key resolvers. Only its selected-pane
// state and operation boundaries are fixtures; no duplicate Enter/Space dispatch logic.
const appSource = await readFile(new URL('../App.jsx', import.meta.url), 'utf8')
const handlerStart = appSource.indexOf('  keyRef.current = (e) => {')
const handlerEnd = appSource.indexOf('\n\n  useEffect(() => {\n    const editor = createTextEditing', handlerStart)
if (handlerStart < 0 || handlerEnd < 0) throw new Error('App shortcut callback extraction boundary changed')
const handlerSource = appSource.slice(handlerStart, handlerEnd).replace('  keyRef.current = ', '')
export function createAppShortcutBoundary() {
  const actions = [], selected = { path: '/pane/selected.txt', name: 'selected.txt', is_dir: false }
  const doc = { activeElement: { tagName: 'BUTTON' } }
  const state = {
    document: doc, isTextEditingElement, resolveListKey, resolvePaneKey, basename,
    activeTabOf: () => ({ id: 'pane-tab', path: '/pane' }), focusIdx: 0,
    selArr: () => [selected.path], rowsCache: { current: { 'pane-tab': [selected] } },
    searchOpen: false, settingsOpen: false, batchRename: false, menu: null, zipDlg: null, layoutPickerOpen: false,
    renaming: null, visibleCount: 1, cfg: { enterAction: 'rename' },
    startRename: (...args) => actions.push(['rename', ...args]),
    previewNavigation: { current: { open: (...args) => actions.push(['preview', ...args]) } },
  }
  const handler = new Function(...Object.keys(state), `return (${handlerSource})`)(...Object.values(state))
  return { actions, handle: event => { doc.activeElement = event.target || { tagName: 'BUTTON' }; handler(event) } }
}
