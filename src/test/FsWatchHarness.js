import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const bundle = await build({
  stdin: {
    contents: "export * from './fsWatch.js'; export * from './folderTree.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'watch-transport', setup(b) {
    b.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$|^\.\/api$/ }, ({ path }) => ({ path, namespace: 'watch-transport' }))
    b.onLoad({ filter: /.*/, namespace: 'watch-transport' }, ({ path }) => ({ contents:
      path.endsWith('/core') ? 'export const invoke = (...args) => transport.invoke(...args)' :
      path.endsWith('/event') ? 'export const listen = (...args) => transport.listen(...args)' :
      'export const hasTauri = true',
    }))
  } }],
})
const flush = () => new Promise(resolve => setImmediate(resolve))

// The real broker/controller share a module lifetime. Only their native IO and
// clock are replaced; lexical timer injection leaves process timers untouched.
export function watchHarness(t) {
  const calls = [], events = [], requests = [], trees = [], owners = new Set(), unsubscribes = []
  const timers = new Map(), nativeListeners = new Set()
  let now = 0, nextTimer = 0
  const setTimer = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, due: now + delay }); return id }
  const clearTimer = id => timers.delete(id)
  const tick = (ms = 80) => {
    const end = now + ms
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0]
      if (!next) break
      now = next[1].due; timers.delete(next[0]); next[1].fn()
    }
    now = end
  }
  const transport = {
    invoke: (command, args) => { calls.push({ command, paths: [...args.paths] }); return Promise.resolve() },
    listen: (name, cb) => {
      assert.equal(name, 'fs-changed'); nativeListeners.add(cb)
      return Promise.resolve(() => nativeListeners.delete(cb))
    },
  }
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', 'transport', 'setTimeout', 'clearTimeout', bundle.outputFiles[0].text)(require, mod, mod.exports, transport, setTimer, clearTimer)
  const broker = mod.exports
  const setWatch = (owner, paths) => { owners.add(owner); broker.setWatch(owner, paths) }
  const clearWatch = owner => { owners.delete(owner); broker.clearWatch(owner) }
  const createTree = () => {
    const tree = broker.createFolderTree({
      list: (path, hidden) => new Promise((resolve, reject) => requests.push({ path, hidden, resolve, reject })),
      setWatch, clearWatch, onFsChange: broker.onFsChange,
    })
    trees.push(tree); tree.start(); return tree
  }
  unsubscribes.push(broker.onFsChange(payload => events.push(payload)))
  t.after(async () => {
    for (const tree of trees) tree.stop()
    for (const owner of [...owners]) clearWatch(owner)
    for (const unsubscribe of unsubscribes) unsubscribe()
    for (const request of requests) request.resolve({ entries: [], truncated: false })
    await flush(); tick()
    assert.equal(timers.size, 0)
    assert.equal(owners.size, 0)
    if (calls.length) assert.deepEqual(calls.at(-1), { command: 'set_watched', paths: [] })
    nativeListeners.clear()
  })
  return {
    calls, events, requests, setWatch, clearWatch, createTree, tick, flush,
    emit: payload => { for (const cb of nativeListeners) cb({ payload }) },
    resolve: async (i, entries = []) => { requests[i].resolve({ entries, truncated: false }); await flush() },
    reject: async (i, error = 'No such file or directory') => { requests[i].reject(error); await flush() },
  }
}
