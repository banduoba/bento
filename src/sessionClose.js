// A quit request upgrades a pending window close, sharing its flush and prompt.
export function createSessionClose({ flush, close, reply, confirmDiscard, operations }) {
  let pending = null, exitId = null, lastRequestId = 0, drainedId = 0
  let signalDrain = null
  const run = () => {
    if (pending) return pending
    pending = (async () => {
      do {
        let allow = true
        if (operations) {
          // Native repeated quit can drain while the frontend choice is still open.
          if (await operations.busy() && !(exitId != null && drainedId === exitId)) {
            const drained = new Promise(resolve => { signalDrain = resolve })
            try { allow = await Promise.race([operations.choose(), drained]) }
            finally { signalDrain = null }
          }
          // Even idle close seals admission before persistence begins.
          await operations.prepare(allow)
        }
        if (allow) {
          try { await flush() } catch (error) {
            allow = await confirmDiscard(error)
            if (!allow && operations) await operations.prepare(false)
          }
        }
        // Claim only this reply. A request received while its IPC is pending
        // remains queued and needs a fresh flush and cancellation decision.
        const requestId = exitId
        exitId = null
        if (requestId != null) await reply(requestId, allow)
        else if (allow) await close()
      } while (exitId != null)
    })().finally(() => {
      pending = null
      // A request can also arrive after the loop returns but before cleanup.
      if (exitId != null) return run()
    })
    return pending
  }
  return {
    requestClose: run,
    requestDrained(requestId) {
      if (!Number.isSafeInteger(requestId) || requestId <= 0 || requestId < lastRequestId || (requestId === lastRequestId && (!pending || exitId !== requestId))) return Promise.resolve()
      drainedId = requestId
      operations?.drained?.()
      signalDrain?.(true)
      if (requestId > lastRequestId || !pending) {
        lastRequestId = requestId
        exitId = requestId
        return run()
      }
      return pending
    },
    requestExit(requestId) {
      if (!Number.isSafeInteger(requestId) || requestId <= 0) return Promise.resolve()
      if (requestId <= lastRequestId) return pending || Promise.resolve()
      lastRequestId = requestId
      exitId = requestId
      return run()
    },
  }
}
