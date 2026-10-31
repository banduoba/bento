let sequence = 0

/** Session ownership remains tied to the opening tab even when native Quick Look becomes key. */
export function createQuickLookNavigation(deps) {
  let current = null
  const filesFor = (tabId, directory) => (deps.getRows(tabId, directory) || []).filter(row => !row.is_dir && !row.isPseudo)
  const update = state => {
    const { path, session, revision } = state
    // Presentation can still be in flight. Only the newest pending item may follow it.
    state.ready.then(() => {
      if (current !== state || state.revision !== revision) return
      return deps.update(path, [path], session, revision)
    }).catch(() => {})
  }
  return {
    open(tabId, directory, path, selectedPaths = []) {
      const files = filesFor(tabId, directory)
      if (!files.some(row => row.path === path)) return
      const selected = new Set(selectedPaths)
      const gallery = files.filter(row => selected.has(row.path)).map(row => row.path)
      if (gallery.length > 1) {
        current = null
        Promise.resolve(deps.present(path, gallery, null)).catch(() => {})
        return
      }
      const session = `preview-${Date.now()}-${++sequence}`
      const state = { tabId, directory, path, session, revision: 0 }
      current = state
      // Native receives just the displayed file; list order lives here, avoiding a main-thread stat of a large directory.
      state.ready = Promise.resolve(deps.present(path, [path], session)).catch(() => {
        if (current === state) current = null
      })
    },
    navigate({ session, direction }) {
      if (!current || current.session !== session || ![-1, 1].includes(direction)) return
      const files = filesFor(current.tabId, current.directory).map(row => row.path)
      if (!files.length) return
      const index = files.indexOf(current.path)
      const next = index < 0 ? (direction > 0 ? 0 : files.length - 1)
        : Math.max(0, Math.min(files.length - 1, index + direction))
      current.path = files[next]
      ++current.revision
      deps.select(current.tabId, current.path)
      deps.reveal(current.tabId, current.path)
      // Completion never writes selection: stale IPC responses cannot roll it back.
      update(current)
    },
    selectionChanged(tabId, path) {
      if (!current || current.tabId !== tabId || current.path === path || !filesFor(tabId, current.directory).some(row => row.path === path)) return
      current.path = path
      ++current.revision
      update(current)
    },
    closed({ session }) {
      if (current?.session === session) current = null
    },
  }
}
