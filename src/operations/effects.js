import { parentPath } from '../format.js'
import { settleCut } from '../clipboard.js'

// This is the only consumer allowed to turn outcomes into UI side effects.
export function createOperationEffects({ refreshDirectories, removeSelection, ownerPath, feedback, beginRename }) {
  const jobs = new Map(), settled = new Set()
  return {
    outcomes(job, rows) {
      if (settled.has(job.jobId)) return
      let record = jobs.get(job.jobId)
      if (!record) { record = { seen: new Set(), destinations: new Set(), cut: [] }; jobs.set(job.jobId, record) }
      const directories = new Set(), removed = []
      for (const outcome of rows) {
        const key = outcome.effectId ? `effect:${outcome.effectId}` : `item:${outcome.itemId}`
        if (record.seen.has(key)) continue
        record.seen.add(key)
        outcome.affectedDirectories?.forEach(path => directories.add(path))
        if (outcome.sourceDisposition === 'removed' && outcome.source) removed.push(outcome.source)
        if (job.clipRevision) record.cut.push({ source: outcome.source, status: outcome.status, sourceDisposition: outcome.sourceDisposition, retry: outcome.retry })
        if (outcome.status === 'succeeded' && outcome.actualDestination && record.destinations.size < 200) record.destinations.add(outcome.actualDestination)
      }
      if (directories.size) refreshDirectories([...directories])
      if (removed.length) removeSelection(removed)
    },
    settled(job, summary) {
      if (settled.has(job.jobId)) return
      settled.add(job.jobId)
      if (settled.size > 256) settled.delete(settled.values().next().value)
      const record = jobs.get(job.jobId)
      jobs.delete(job.jobId)
      if (job.clipRevision) settleCut(job.clipRevision, record?.cut || [])
      const paths = [...(record?.destinations || [])]
      const ownerDirectory = ownerPath(job.ownerTabId)
      if (job.state !== 'completed' || !paths.length || !ownerDirectory
        || !paths.every(path => parentPath(path) === ownerDirectory)) return
      if (job.kind === 'create' && paths.length === 1) beginRename(job.ownerTabId, paths[0], job.intent === 'newDirectory')
      else if (['copy', 'zip'].includes(job.kind)) feedback(job.ownerTabId, paths, `${job.kind === 'zip' ? '已压缩' : '已拷贝'} ${summary.counts.succeeded || paths.length} 个项目`)
    },
  }
}
