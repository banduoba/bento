export const extractionActive = job => !!job && ['running', 'cancelling'].includes(job.state)

// Native work survives UI remounts. Polls are serialized and replies are scoped
// to the current start generation, so an old completion cannot hide a new job.
export function createExtractionTask({ api, onChange, onTerminal, onStarted = () => {}, schedule = cb => setTimeout(cb, 350), unschedule = clearTimeout }) {
 let state = { operation: 'extract', job: null, starting: false, cancelling: false, error: null }
 let live = true, timer = null, starting = false, cancellation = null
 let terminalId = null, epoch = 0, polling = false, statusUnknown = true, operationError = null
 const completions = new Map()
 const publish = patch => {
  if (!live) return
  state = { ...state, ...patch }; onChange(state)
  if (state.job && !extractionActive(state.job)) { completions.get(state.job.id)?.(state.job); completions.delete(state.job.id) }
  if (state.job && !extractionActive(state.job) && terminalId !== state.job.id) {
   terminalId = state.job.id; onTerminal(state.job)
  }
 }
 const clear = () => { if (timer !== null) unschedule(timer); timer = null }
 const later = () => {
  clear()
  if (live && !polling && !starting && (statusUnknown || extractionActive(state.job))) timer = schedule(poll)
 }
 async function poll() {
  if (!live || polling) return
  timer = null; polling = true
  const generation = epoch
  try {
   const job = await api.extractionStatus()
   if (generation === epoch) {
    statusUnknown = false
    if (extractionActive(job) && job.id !== state.job?.id) operationError = null
    const previousResult = operationError && !state.job && job?.id === terminalId && !extractionActive(job)
    publish({ job: previousResult ? null : job, error: operationError })
   }
  } catch (error) {
   if (generation === epoch) { statusUnknown = true; publish({ error: `无法读取归档任务状态，将自动重试：${error}` }) }
  } finally { polling = false; later() }
 }
 const ready = poll()
 async function start(paths, compression, context) {
  if (!live || starting) return null
  starting = true
  try {
   await ready
   if (!live || statusUnknown || extractionActive(state.job)) return null
   epoch++; const generation = epoch; cancellation = null; operationError = null
   clear(); publish({ job: null, operation: compression ? 'compress' : 'extract', starting: true, cancelling: false, error: null })
   const job = compression ? await api.startCompression(paths, compression.dir, compression.options) : await api.startExtraction(paths)
   if (!live || generation !== epoch) return null
   if (!job || typeof job.id !== 'string' || !Array.isArray(job.results)) throw new Error('无法确认归档任务结果，请检查输出目录')
   let completion
   if (compression) completion = new Promise(resolve => completions.set(job.id, resolve))
   onStarted(job, context)
   publish({ job, error: null })
   return compression ? { job, completion } : job
  } catch (error) {
   operationError = String(error); statusUnknown = true; publish({ error: operationError }); return null
  } finally { starting = false; publish({ starting: false }); later() }
 }
 return {
  ready,
  get snapshot() { return state },
  start: (paths, context) => start(paths, null, context),
  async compress(paths, dir, options, context) {
   const accepted = await start(paths, { dir, options }, context)
   if (!accepted) return state.error ? { entries: [], error: state.error } : null
   const job = await accepted.completion
   if (!job) return null
   const entries = job.results.filter(r => r.state === 'completed' && r.output).map(r => ({ path: r.output, identity: r.identity }))
   const errors = job.results.map(r => r.error).filter(Boolean).join('\n')
   return { entries, error: job.state === 'completed' ? null : job.error || errors || (job.state === 'cancelled' ? '已取消压缩' : '压缩未完成'), cancelled: job.state === 'cancelled' }
  },
  async cancel() {
   if (!live || cancellation || !extractionActive(state.job)) return
   const ticket = { epoch, id: state.job.id }; cancellation = ticket; operationError = null
   publish({ cancelling: true, error: null })
   try {
    const job = await api.cancelExtraction(ticket.id)
    if (ticket.epoch === epoch && state.job?.id === ticket.id) publish({ job, error: null })
   } catch (error) {
    if (ticket.epoch === epoch) { operationError = String(error); publish({ error: operationError }) }
   } finally {
    if (cancellation === ticket) { cancellation = null; publish({ cancelling: false }) }
    later()
   }
  },
  dismiss() {
   if (!extractionActive(state.job) && !starting) {
    operationError = null
    if (!statusUnknown) clear()
    publish({ job: null, error: null })
   }
  },
  dispose() { live = false; epoch++; clear(); for (const resolve of completions.values()) resolve(null); completions.clear() },
 }
}
