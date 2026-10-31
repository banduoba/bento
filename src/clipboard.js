// Bento cut is application-local. Copy also writes real file references to the system clipboard.
let clip = null
let revision = 0
const listeners = new Set()
const inFlight = new Set()
export function getClip() { return clip }
function publishClip(next, clipId) {
  const nextRevision = next ? String(++revision) : null
  clip = next ? { ...next, paths: [...next.paths], revision: nextRevision, clipId: clipId || nextRevision } : null
  for (const listener of listeners) listener(clip)
}
export function setClip(next) { publishClip(next) }
export function subscribeClip(listener) { listeners.add(listener); return () => listeners.delete(listener) }
export function clearCut() { if (clip?.mode === 'cut') setClip(null) }
export function retainCut(paths, expectedRevision = clip?.revision) {
  if (clip?.mode !== 'cut' || clip.revision !== expectedRevision) return
  if (!paths.length) setClip(null)
  else publishClip({ mode: 'cut', paths }, clip.clipId)
}
export function reserveCut(expectedRevision) {
  if (clip?.mode !== 'cut' || clip.revision !== expectedRevision || inFlight.has(expectedRevision)) return false
  inFlight.add(expectedRevision)
  return true
}
// Retained subsets keep their original cut identity; a user-created cut always gets a new one.
export function reserveCutRetry(clipId, paths) {
  if (!paths.length || !clipId || clip?.mode !== 'cut' || clip.clipId !== clipId) return null
  const retained = new Set(clip.paths)
  if (paths.some(path => !retained.has(path))) return null
  if (!reserveCut(clip.revision)) throw Error('此剪切任务正在等待完成')
  return clip.revision
}
export function releaseCut(expectedRevision) { inFlight.delete(expectedRevision) }
export function settleCut(expectedRevision, outcomes) {
  releaseCut(expectedRevision)
  if (clip?.mode !== 'cut' || clip.revision !== expectedRevision) return
  // Published-but-not-cleaned sources belong to recovery, never another copy attempt.
  const done = new Set(outcomes.filter(o => ['succeeded','noop'].includes(o.status)
    || o.sourceDisposition === 'cleanupIncomplete' || ['finishSourceCleanup','manualRecovery'].includes(o.retry)).map(o => o.source))
  retainCut(clip.paths.filter(path => !done.has(path)), expectedRevision)
}
