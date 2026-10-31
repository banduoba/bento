import { createOperationStore, operationId, terminal } from './store.js'

// Only snapshots enter the observable store. Requests (including passwords) stay private.
export function createOperationClient({ api, listen, onOutcomes = () => {}, onSettled = () => {} }) {
  const store = createOperationStore(), records = new Map(), requests = new Map(), unresolved = new Map(), retired = new Set()
  let startup, unlisten, disposed = false, buffer = new Map(), syncing = null, submittingUndo = false
  const safeMessage = value => {
    let message = String(value)
    for (const request of requests.values()) if (request.options?.password) message = message.split(request.options.password).join('[已隐藏]')
    return message
  }
  const error = value => { if (!disposed) store.update({ error: safeMessage(value) }) }
  const pending = () => store.update({ pendingSubmissions: [...unresolved.values()].map(r => ({ requestId: r.requestId, kind: r.kind })) })
  const publish = () => {
    if (!disposed) store.update({ jobs: [...records.values()].map(r => {
      const request = requests.get(r.job.requestId)
      return { ...r.job, sources: request?.items.map(item => item.source).filter(Boolean).slice(0, 3) || [], destination: request?.destination, details: r.details, counts: r.counts, resultsPending: r.offset < r.job.outcomeCount, detailError: r.error }
    }) })
  }
  const drain = record => {
    if (record.draining) return record.draining
    record.draining = (async () => {
      while (!disposed && records.get(record.job.jobId) === record && record.offset < record.job.outcomeCount) {
        const offset = record.offset
        const page = await api.getOperationOutcomes(record.job.jobId, offset, 200)
        if (disposed || store.getState().sessionId !== record.job.sessionId || records.get(record.job.jobId) !== record) return
        if (page.sessionId !== record.job.sessionId || page.jobId !== record.job.jobId || page.offset !== offset
          || !Array.isArray(page.outcomes) || !page.outcomes.length || page.outcomes.length > 200) throw Error('操作结果尚未同步，请重试同步')
        await onOutcomes(record.job, page.outcomes)
        record.offset += page.outcomes.length
        for (const outcome of page.outcomes) {
          record.counts[outcome.status] = (record.counts[outcome.status] || 0) + 1
          // Keep a bounded sample, prioritising errors over ordinary successes.
          if (record.details.length < 50) record.details.push(outcome)
          else if (outcome.error) {
            const index = record.details.findIndex(o => !o.error)
            if (index >= 0) record.details[index] = outcome
          }
          if (outcome.retry === 'retryItem' && ['failed','notStarted','cancelled'].includes(outcome.status)) record.retryItems.add(outcome.itemId)
        }
        record.error = null
        publish()
      }
      if (!disposed && terminal(record.job.state) && !record.settled && record.offset >= record.job.outcomeCount) {
        await onSettled(record.job, { counts: record.counts, details: record.details })
        record.settled = true
        const request = requests.get(record.job.requestId)
        if (request?.options?.password) requests.set(record.job.requestId, { ...request, options: { ...request.options, password: undefined } })
      }
      if (!disposed && record.settled && !record.acked) {
        await api.ackOperationOutcomes(record.job.jobId, record.job.revision, record.job.outcomeCount)
        record.acked = true
        record.error = null
      }
    })().catch(cause => { record.error = safeMessage(cause); error(cause) }).finally(() => {
      record.draining = null
      publish()
      // A newer event can arrive while an empty drain is resolving.
      if (!disposed && records.get(record.job.jobId) === record && !record.error && (record.offset < record.job.outcomeCount || (terminal(record.job.state) && !record.settled))) void drain(record)
    })
    return record.draining
  }
  const merge = job => {
    const state = store.getState()
    if (disposed || retired.has(job.jobId) || job.sessionId !== state.sessionId) return
    let record = records.get(job.jobId)
    if (record && (job.revision <= record.job.revision || terminal(record.job.state))) return
    if (!record) {
      if (records.size >= 512) { error('操作历史已满，请重新启动后继续'); return }
      record = { job, requiresPassword: !!requests.get(job.requestId)?.options?.password, offset: 0, counts: {}, details: [], retryItems: new Set(), draining: null, settled: false, acked: false, error: null }
      records.set(job.jobId, record)
    } else record.job = job
    publish()
    void drain(record)
  }
  const applyQueue = (snapshot, pruneCandidates = new Set()) => {
    if (disposed) return
    let state = store.getState()
    if (state.sessionId !== snapshot.sessionId) {
      // A list reply is the authority for a new native process/session; events never switch sessions.
      records.clear()
      retired.clear()
      store.update({ sessionId: snapshot.sessionId, revision: -1, jobs: [], latestUndoId: null })
      state = store.getState()
    }
    const canPrune = snapshot.revision > state.revision
    if (snapshot.revision >= state.revision) store.update({ revision: snapshot.revision, accepting: snapshot.accepting, latestUndoId: snapshot.latestUndoId })
    for (const job of snapshot.jobs) merge(job)
    const retained = new Set(snapshot.jobs.map(job => job.jobId))
    for (const [id, record] of records) {
      if (canPrune && pruneCandidates.has(id) && !retained.has(id) && record.acked && !unresolved.has(record.job.requestId)) {
        retired.add(id); records.delete(id); requests.delete(record.job.requestId)
      }
    }
    publish()
    const waiting = [...buffer.values()]; buffer.clear()
    waiting.forEach(merge)
    // A previous page fetch may have failed even when its snapshot did not change.
    records.forEach(record => { if (record.error) void drain(record) })
  }
  const resync = () => {
    if (syncing) return syncing
    const pruneCandidates = new Set([...records].filter(([, record]) => record.acked).map(([id]) => id))
    syncing = api.listOperationJobs().then(snapshot => applyQueue(snapshot, pruneCandidates)).finally(() => { syncing = null })
    return syncing
  }
  const refreshRecoveries = async () => {
    const recoveries = await api.listOperationRecoveries()
    if (!disposed) store.update({ recoveries })
  }
  const start = () => {
    if (!startup) startup = (async () => {
      if (!unlisten) unlisten = await listen('operation-changed', event => {
        if (disposed) return
        if (!store.getState().sessionId) {
          const job = event.payload, key = `${job.sessionId}:${job.jobId}`, previous = buffer.get(key)
          if ((!previous && buffer.size < 256) || (previous && !terminal(previous.state) && job.revision > previous.revision)) buffer.set(key, job)
          return
        }
        merge(event.payload)
        if (terminal(event.payload.state) && event.payload.sessionId === store.getState().sessionId) {
          void resync().catch(error)
          void refreshRecoveries().catch(error)
        }
      })
      if (disposed) { unlisten(); return }
      await resync()
      await refreshRecoveries()
    })().catch(cause => { startup = null; error(cause); throw new Error(safeMessage(cause)) })
    return startup
  }
  const admit = async descriptor => {
    await start()
    const { requestId, execute } = descriptor
    if (!unresolved.has(requestId) && unresolved.size >= 256) throw Error('待确认的提交过多，请先同步操作队列')
    unresolved.set(requestId, descriptor); pending()
    try {
      const job = await execute()
      unresolved.delete(requestId); pending(); merge(job)
      store.update({ error: null })
      return records.get(job.jobId)?.job || job
    } catch (cause) {
      try {
        await resync()
        const accepted = [...records.values()].find(r => r.job.requestId === requestId)
        if (accepted) { unresolved.delete(requestId); pending(); return accepted.job }
      } catch { /* Keep the same id and payload for explicit reconciliation/retry. */ }
      error(cause)
      throw new Error(safeMessage(cause))
    }
  }
  const enqueue = request => {
    requests.set(request.requestId, request)
    return admit({ requestId: request.requestId, kind: request.kind, execute: () => api.enqueueOperation(request) })
  }

  return {
    getState: store.getState, subscribe: store.subscribe, start, resync, refreshRecoveries, enqueue,
    async idle() { while ([...records.values()].some(r => r.draining)) await Promise.all([...records.values()].map(r => r.draining)); },
    async cancel(jobId) { merge(await api.cancelOperation(jobId)) },
    async resolve(jobId, conflict, decision, applyToRemaining = false) {
      try { merge(await api.resolveOperationConflict(jobId, conflict.conflictId, conflict.revision, decision, applyToRemaining)) }
      catch (cause) { merge(await api.getOperationJob(jobId)); error(cause) }
    },
    async undo() {
      await start()
      const { busy, latestUndoId } = store.getState()
      if (busy || submittingUndo) throw Error('当前任务结束后可撤销')
      if (!latestUndoId) return
      submittingUndo = true
      try {
        const requestId = operationId()
        await admit({ requestId, kind: 'undo', execute: () => api.undoOperation(latestUndoId, requestId) })
        await resync()
      }
      finally { submittingUndo = false }
    },
    async recover(recoveryId, action) {
      if (store.getState().busy) throw Error('当前任务结束后可恢复')
      const requestId = operationId()
      await admit({ requestId, kind: 'recovery', execute: () => api.recoverOperation(recoveryId, action, requestId) })
      await resync(); await refreshRecoveries()
    },
    async retry(jobId) {
      const record = records.get(jobId), original = record && requests.get(record.job.requestId)
      if (record && (!terminal(record.job.state) || !record.settled)) throw Error('任务结束并同步结果后可重试')
      if (!original || !record.retryItems.size || original.kind === 'zip') throw Error('此任务需要手动处理，请查看错误或恢复记录')
      return enqueue({ ...original, requestId: operationId(), clipRevision: null, items: original.items.filter(item => record.retryItems.has(item.itemId)) })
    },
    canRetry(jobId) { const r = records.get(jobId); return !!(r?.settled && terminal(r.job.state) && r.retryItems.size && requests.has(r.job.requestId)) },
    retryInfo(jobId) {
      const record = records.get(jobId), request = record && requests.get(record.job.requestId)
      if (!record?.settled || !request || !record.retryItems.size) return null
      return { kind: request.kind, ownerTabId: request.ownerTabId, destination: request.destination, options: { ...request.options, password: undefined }, items: request.items.filter(item => record.retryItems.has(item.itemId)), requiresPassword: record.requiresPassword }
    },
    retrySubmission(requestId) { const descriptor = unresolved.get(requestId); if (!descriptor) return resync(); return admit(descriptor) },
    async prepareExit(cancelRemaining) {
      await start()
      const snapshot = await api.prepareOperationExit(cancelRemaining)
      applyQueue(snapshot)
      await this.idle()
      return snapshot
    },
    dispose() { disposed = true; unlisten?.(); records.clear(); requests.clear(); unresolved.clear(); retired.clear(); buffer.clear() },
  }
}
