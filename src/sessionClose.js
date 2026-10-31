// A quit request upgrades a pending window close, sharing its flush and prompt.
export function createSessionClose({ flush, close, reply, confirmDiscard }) {
  let pending = null, exitId = null, lastRequestId = 0
  const run = () => {
    if (pending) return pending
    pending = (async () => {
      do {
        let allow = true
        try { await flush() } catch (error) { allow = await confirmDiscard(error) }
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
    requestExit(requestId) {
      if (!Number.isSafeInteger(requestId) || requestId <= 0) return Promise.resolve()
      if (requestId <= lastRequestId) return pending || Promise.resolve()
      lastRequestId = requestId
      exitId = requestId
      return run()
    },
  }
}
