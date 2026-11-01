import { normalizeFsChanges } from './fsApply.js'

// Native reads cannot be cancelled on unmount. Admission therefore outlives each
// Sidebar controller; old promises keep their slots until they actually settle.
let activeReads = 0
const waitingControllers = new Set()
function admitWaitingReads() {
  for (const pump of [...waitingControllers]) {
    if (activeReads >= 2) break
    pump()
  }
}

// Only expanded branches live here. Outstanding native IO keeps its slot even after close.
export function createFolderTree({ list, setWatch, clearWatch, onFsChange, showHidden = false, autoRefresh = true }) {
  const owner = Symbol('sidebar-tree')
  const nodes = new Map(), listeners = new Set(), queue = new Set()
  let live = false, unsubscribe = null
  const snapshot = () => new Map([...nodes].map(([id, node]) => [id, {
    id, path: node.path, parent: node.parent, entries: node.entries,
    truncated: node.truncated, status: node.status, error: node.error,
  }]))
  const emit = () => { for (const listener of listeners) listener(snapshot()) }
  const watch = () => {
    const paths = [...new Set([...nodes.values()].filter(n => n.status !== 'error').map(n => n.path))]
    if (live && autoRefresh && paths.length) setWatch(owner, paths)
    else clearWatch(owner)
  }
  function pump() {
    waitingControllers.delete(pump)
    if (!live) return
    for (const id of queue) {
      if (activeReads >= 2) break
      const node = nodes.get(id)
      if (!node) { queue.delete(id); continue }
      if (node.running) continue
      queue.delete(id)
      const revision = node.revision, hidden = showHidden
      node.running = true; activeReads++
      // Invocation is immediate; Promise.resolve handles both IPC and synchronous boundary errors.
      let request
      try { request = list(node.path, hidden) } catch (error) { request = Promise.reject(error) }
      Promise.resolve(request).then(result => {
        if (!live || nodes.get(id) !== node || node.revision !== revision) return
        node.entries = result.entries; node.truncated = !!result.truncated
        node.status = 'ready'; node.error = ''
        // A directory removed or changed to a symlink releases its whole old subtree.
        const children = new Set(result.entries.filter(e => !e.is_symlink).map(e => e.path))
        for (const child of [...nodes.values()]) {
          if (child.parent === id && !children.has(child.path)) remove(child.id)
        }
        watch(); emit()
      }, error => {
        if (!live || nodes.get(id) !== node || node.revision !== revision) return
        node.entries = []; node.truncated = false
        node.status = 'error'; node.error = String(error?.message || error)
        for (const child of [...nodes.values()]) if (child.parent === id) remove(child.id)
        watch(); emit()
        // A self-directory removal event may name only this failed branch. Recheck
        // its known expanded parent so a deleted entry can be pruned. Parent
        // success never retries children; failures travel only upward to the root.
        if (node.parent !== null && nodes.has(node.parent)) refresh(node.parent)
      }).finally(() => {
        node.running = false; activeReads--
        admitWaitingReads()
      })
    }
    if (queue.size) waitingControllers.add(pump)
  }
  function refresh(id) {
    const node = nodes.get(id)
    if (!node) return
    node.revision++; node.status = 'loading'; node.error = ''
    queue.add(id); watch(); emit(); pump()
  }
  function remove(id) {
    for (const node of [...nodes.values()]) if (node.parent === id) remove(node.id)
    nodes.delete(id); queue.delete(id)
  }
  return {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    start() {
      if (live) return
      live = true
      unsubscribe = onFsChange(payload => {
        if (!live || !autoRefresh) return
        const changed = new Set(normalizeFsChanges(payload).map(delta => delta.dir))
        for (const node of nodes.values()) if (changed.has(node.path)) refresh(node.id)
      })
      watch(); pump()
    },
    stop() {
      live = false; unsubscribe?.(); unsubscribe = null
      waitingControllers.delete(pump)
      nodes.clear(); queue.clear(); clearWatch(owner); emit()
    },
    open(id, path, parent = null) {
      if (!live || !path) return false
      if (nodes.has(id)) return true
      if (nodes.size >= 64 || (parent !== null && !nodes.has(parent))) return false
      nodes.set(id, { id, path, parent, entries: [], truncated: false, status: 'loading', error: '', revision: 0, running: false })
      queue.add(id); watch(); emit(); pump(); return true
    },
    close(id) { remove(id); watch(); emit(); pump() },
    retry: refresh,
    setOptions(options) {
      const hidden = !!options.showHidden, auto = options.autoRefresh !== false
      const reload = hidden !== showHidden || (auto && !autoRefresh)
      showHidden = hidden; autoRefresh = auto
      watch()
      if (reload) for (const id of nodes.keys()) refresh(id)
    },
    retainRoots(ids) {
      const roots = new Set(ids)
      for (const node of [...nodes.values()]) if (node.parent === null && !roots.has(node.id)) remove(node.id)
      watch(); emit(); pump()
    },
  }
}
