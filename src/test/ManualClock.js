// Deterministic scheduling boundary for production effects; no effect logic lives here.
export function manualClock() {
  let now = 0, nextId = 1
  const tasks = new Map()
  return {
    schedule(fn, delay) { const id = nextId++; tasks.set(id, { fn, at: now + delay }); return id },
    cancel(id) { tasks.delete(id) },
    async advance(ms) {
      now += ms
      let due
      while ((due = [...tasks].find(([, task]) => task.at <= now))) {
        tasks.delete(due[0])
        await due[1].fn()
      }
    },
    get pending() { return tasks.size },
  }
}
