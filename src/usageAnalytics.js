import { compareVersions } from './updateCheck.js'

const PREFERENCE_KEY = 'bento-usage-analytics-enabled'
const STATE_KEY = 'bento-usage-analytics'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DAY_MS = 86400000

// Separate app storage keeps installation identity and this choice out of settings backups.
export function readAnalyticsEnabled(storage) {
  try { return (storage ?? globalThis.localStorage).getItem(PREFERENCE_KEY) !== 'false' }
  catch { return false }
}

export function writeAnalyticsEnabled(enabled, storage) {
  try { (storage ?? globalThis.localStorage).setItem(PREFERENCE_KEY, String(enabled === true)); return true }
  catch { return false }
}

function validEndpoint(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === '/v1/events' ? url.href : null
  } catch { return null }
}

/** Fixed-schema, best-effort daily counts. No file, search, device or user data is accepted. */
export function createUsageAnalytics({
  endpoint, version, arch, native = false, production = false, enabled = true,
  storage, randomUUID = () => globalThis.crypto.randomUUID(), fetchImpl = globalThis.fetch,
  now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
}) {
  const url = validEndpoint(endpoint)
  const noop = () => {}
  if (!enabled || !native || !production || !url || !['arm64', 'x86_64'].includes(arch)
    || typeof version !== 'string' || version.length > 128 || /\s/.test(version) || version.startsWith('v')
    || compareVersions(version, version) !== 0) return noop
  let state
  try {
    storage ??= globalThis.localStorage
    state = JSON.parse(storage.getItem(STATE_KEY) || 'null')
    if (typeof state?.installationId !== 'string' || !UUID_V4.test(state.installationId)) state = { installationId: randomUUID() }
    if (!UUID_V4.test(state.installationId)) return noop
    state = {
      installationId: state.installationId, day: state.day,
      attempts: Number.isInteger(state.attempts) && state.attempts >= 0 && state.attempts <= 3 ? state.attempts : 3,
      sent: state.sent === true,
    }
    storage.setItem(STATE_KEY, JSON.stringify(state))
  } catch { return noop }

  let stopped = false, timer = null, controller = null, requestTimer = null
  const day = () => new Date(now()).toISOString().slice(0, 10)
  const midnightDelay = () => DAY_MS - (now() % DAY_MS)
  const save = () => storage.setItem(STATE_KEY, JSON.stringify(state))
  const schedule = delay => {
    if (!stopped) timer = setTimeoutImpl(tick, delay)
  }
  async function tick() {
    timer = null
    if (stopped) return
    const today = day()
    if (state.day !== today) state = { installationId: state.installationId, day: today, attempts: 0, sent: false }
    if (state.sent || state.attempts >= 3) { schedule(midnightDelay()); return }
    state.attempts++
    // Persist attempts before IO so relaunching cannot create an unbounded retry loop.
    try { save() } catch { return }
    const request = new AbortController()
    controller = request
    let timeout
    const aborted = new Promise((_, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
    })
    timeout = setTimeoutImpl(() => request.abort(), 10000)
    requestTimer = timeout
    let success = false
    try {
      const response = await Promise.race([aborted, fetchImpl(url, {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        signal: request.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: state.installationId, version, platform: 'macos', arch, type: 'launch' }),
      })])
      success = response.ok === true
    } catch { /* Counting must never interrupt app use. */ }
    finally {
      clearTimeoutImpl(timeout)
      if (requestTimer === timeout) requestTimer = null
      if (controller === request) controller = null
    }
    if (stopped) return
    if (day() !== today) { schedule(0); return }
    if (success) {
      state.sent = true
      try { save() } catch { return }
    }
    schedule(state.sent || state.attempts >= 3 ? midnightDelay() : Math.min(state.attempts === 1 ? 60000 : 300000, midnightDelay()))
  }
  void tick()
  return () => {
    stopped = true
    clearTimeoutImpl(timer)
    clearTimeoutImpl(requestTimer)
    controller?.abort()
  }
}
