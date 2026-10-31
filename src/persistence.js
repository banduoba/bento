// Every document has one writer. An in-flight write never races a newer snapshot.
export function createSerialSaver(write, { delay = 300, onError = () => {} } = {}) {
  let latest, saved, running, timer
  const flush = () => {
    clearTimeout(timer)
    if (!running) running = (async () => {
      while (latest !== undefined && latest !== saved) {
        const value = latest
        await write(JSON.parse(value))
        saved = value
      }
    })().catch(error => { onError(error); throw error }).finally(() => { running = null })
    // A new update can land between the drain's final iteration and finally.
    return running.then(() => { if (latest !== saved) return flush() })
  }
  return {
    update(value) {
      const next = JSON.stringify(value)
      if (next === latest) return
      latest = next
      clearTimeout(timer)
      timer = setTimeout(() => { flush().catch(() => {}) }, delay)
    },
    flush,
    dispose() { clearTimeout(timer) },
  }
}
