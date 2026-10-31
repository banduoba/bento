// Bento cut is application-local. Copy also writes real file references to the system clipboard.
let clip = null
let revision = 0
const listeners = new Set()
const inFlight = new Set()
export function getClip() { return clip }
export function setClip(next) {
  clip = next ? { ...next, paths: [...next.paths], revision: String(++revision) } : null
  for (const listener of listeners) listener(clip)
}
export function subscribeClip(listener) { listeners.add(listener); return () => listeners.delete(listener) }
export function clearCut() { if (clip?.mode === 'cut') setClip(null) }
export function retainCut(paths, expectedRevision = clip?.revision) {
  if (clip?.mode !== 'cut' || clip.revision !== expectedRevision) return
  if (!paths.length) setClip(null)
  else setClip({ mode: 'cut', paths })
}
export function reserveCut(expectedRevision) {
  if (clip?.mode !== 'cut' || clip.revision !== expectedRevision || inFlight.has(expectedRevision)) return false
  inFlight.add(expectedRevision)
  return true
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
