export const extractionActive = job => !!job && ['running', 'cancelling'].includes(job.state)

// Native work survives UI remounts. Polls are serialized and replies are scoped
// to the current start generation, so an old completion cannot hide a new job.
export function createExtractionTask({ api, onChange, onTerminal, schedule = cb => setTimeout(cb, 350), unschedule = clearTimeout }) {
 let state = { job: null, starting: false, cancelling: false, error: null }
 let live = true, timer = null, starting = false, cancellation = null
 let terminalId = null, epoch = 0, polling = false, statusUnknown = true, operationError = null
 const publish = patch => {
  if (!live) return
  state = { ...state, ...patch }; onChange(state)
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
   if (generation === epoch) { statusUnknown = true; publish({ error: `无法读取解压状态，将自动重试：${error}` }) }
  } finally { polling = false; later() }
 }
 const ready = poll()
 return {
  ready,
  get snapshot() { return state },
  async start(paths) {
   if (!live || starting) return
   starting = true
   try {
    await ready
    if (!live || statusUnknown || extractionActive(state.job)) return
    epoch++; cancellation = null; operationError = null
    clear(); publish({ job: null, starting: true, cancelling: false, error: null })
    const job = await api.startExtraction(paths)
    publish({ job, error: null })
   } catch (error) {
    operationError = String(error); statusUnknown = true; publish({ error: operationError })
   } finally { starting = false; publish({ starting: false }); later() }
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
  dispose() { live = false; epoch++; clear() },
 }
}
