import { parentPath } from '../format.js'
import { settleCut } from '../clipboard.js'

// The only outcome-to-UI consumer. Timers batch already-confirmed effects, never infer completion.
export function createOperationEffects({ refreshDirectories, removeSelection, ownerPath, feedback, beginRename,
  onError = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
  const jobs = new Map(), settled = new Set()
  let disposed = false
  const recordFor = jobId => {
    let record = jobs.get(jobId)
    if (!record) {
      record = { seen: new Set(), destinations: new Set(), cut: [], directories: new Set(), removed: new Set(), timer: null, flushing: null, settling: null }
      jobs.set(jobId, record)
    }
    return record
  }
  const clearTimer = record => {
    if (record.timer != null) cancel(record.timer)
    record.timer = null
  }
  const scheduleFlush = record => {
    if (disposed || record.timer != null || record.flushing || record.settling || (!record.directories.size && !record.removed.size)) return
    record.timer = schedule(() => {
      record.timer = null
      return flush(record).catch(error => { if (!disposed) onError(error) })
    }, 100)
  }
  const flush = record => {
    if (disposed) return Promise.resolve()
    clearTimer(record)
    if (record.flushing) return record.flushing.then(() => flush(record))
    const directories = [...record.directories], removed = [...record.removed]
    if (!directories.length && !removed.length) return Promise.resolve()
    record.directories.clear()
    record.removed.clear()
    let succeeded = false
    record.flushing = (async () => {
      try {
        if (directories.length) await refreshDirectories(directories)
        if (disposed) return
        if (removed.length) await removeSelection(removed)
        succeeded = true
      } catch (error) {
        if (disposed) return
        directories.forEach(path => record.directories.add(path))
        removed.forEach(path => record.removed.add(path))
        throw error
      }
    })().finally(() => {
      record.flushing = null
      if (succeeded) scheduleFlush(record)
    })
    return record.flushing
  }
  return {
    outcomes(job, rows) {
      if (disposed || settled.has(job.jobId)) return
      const record = recordFor(job.jobId)
      for (const outcome of rows) {
        const key = outcome.effectId ? `effect:${outcome.effectId}` : `item:${outcome.itemId}`
        if (record.seen.has(key)) continue
        record.seen.add(key)
        outcome.affectedDirectories?.forEach(path => record.directories.add(path))
        if (outcome.sourceDisposition === 'removed' && outcome.source) record.removed.add(outcome.source)
        if (job.clipRevision) record.cut.push({ source: outcome.source, status: outcome.status, sourceDisposition: outcome.sourceDisposition, retry: outcome.retry })
        if (outcome.status === 'succeeded' && outcome.actualDestination && record.destinations.size < 200) record.destinations.add(outcome.actualDestination)
      }
      scheduleFlush(record)
    },
    settled(job, summary) {
      if (disposed || settled.has(job.jobId)) return Promise.resolve()
      const record = recordFor(job.jobId)
      if (record.settling) return record.settling
      record.settling = (async () => {
        await flush(record)
        if (disposed || settled.has(job.jobId)) return
        settled.add(job.jobId)
        if (settled.size > 256) settled.delete(settled.values().next().value)
        jobs.delete(job.jobId)
        if (job.clipRevision) settleCut(job.clipRevision, record.cut)
        const paths = [...record.destinations]
        const ownerDirectory = ownerPath(job.ownerTabId)
        if (job.state !== 'completed' || !paths.length || !ownerDirectory
          || !paths.every(path => parentPath(path) === ownerDirectory)) return
        if (job.kind === 'create' && paths.length === 1) beginRename(job.ownerTabId, paths[0], job.intent === 'newDirectory')
        else if (['copy', 'zip'].includes(job.kind)) feedback(job.ownerTabId, paths, `${job.kind === 'zip' ? '已压缩' : '已拷贝'} ${summary.counts.succeeded || paths.length} 个项目`)
      })().catch(error => { record.settling = null; throw error })
      return record.settling
    },
    dispose() {
      disposed = true
      for (const record of jobs.values()) clearTimer(record)
      jobs.clear()
      settled.clear()
    },
  }
}
