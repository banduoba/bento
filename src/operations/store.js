export const terminal = state => ['completed', 'partial', 'failed', 'cancelled'].includes(state)
export const operationId = () => globalThis.crypto?.randomUUID?.() || `r${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
export function createOperationStore() {
  let state = { sessionId: null, revision: -1, jobs: [], busy: false, accepting: true, latestUndoId: null, recoveries: [], pendingSubmissions: [], error: null }
  const listeners = new Set()
  return {
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    update(patch) {
      state = { ...state, ...patch }
      state.busy = state.jobs.some(job => !terminal(job.state) || job.resultsPending) || state.pendingSubmissions.length > 0
      for (const fn of listeners) fn(state)
    },
  }
}
