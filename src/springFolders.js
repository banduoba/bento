// Only the current, stable native drag target may spring open. Repeated native
// over events update validation without postponing the initial dwell deadline.
export function createSpringLoader({ delay = 650, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let current = null, timer = null
  const cancel = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
    current = null
  }
  return {
    cancel,
    hover(key, valid, open) {
      if (!key) { cancel(); return }
      if (current?.key === key) { current.valid = valid; current.open = open; return }
      cancel()
      const target = current = { key, valid, open }
      timer = setTimer(() => {
        timer = null
        if (current !== target || !target.valid()) return
        target.open()
      }, delay)
    },
  }
}
