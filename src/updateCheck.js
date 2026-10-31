export const PROJECT_URL = 'https://github.com/banduoba/bento'
export const DOWNLOAD_URL = `${PROJECT_URL}/releases/latest`
export const ISSUES_URL = `${PROJECT_URL}/issues`
const LATEST_API = 'https://api.github.com/repos/banduoba/bento/releases/latest'

function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value)
  if (!match) return null
  const pre = match[4]?.split('.') ?? []
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null
  return { core: match.slice(1, 4).map(BigInt), pre }
}

// null means that comparison is unsafe; callers must not claim "up to date".
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return null
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

function officialReleaseUrl(value) {
  try {
    const url = new URL(value)
    if (url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash &&
      /^\/banduoba\/bento\/releases\/tag\/[^/]+$/.test(url.pathname)) return url.href
  } catch {}
  return DOWNLOAD_URL
}

function checkError(code, message) {
  return Object.assign(new Error(message), { code })
}

export async function fetchLatestRelease(currentVersion, { fetchImpl = globalThis.fetch, signal, timeoutMs = 10000 } = {}) {
  const controller = new AbortController()
  const cancel = () => controller.abort(new DOMException('已取消检查', 'AbortError'))
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  const timer = setTimeout(() => controller.abort(checkError('timeout', '检查超时，请重试或打开下载页面。')), timeoutMs)
  let rejectAbort
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason) })
  controller.signal.addEventListener('abort', rejectAbort, { once: true })
  if (controller.signal.aborted) rejectAbort()
  try {
    return await Promise.race([aborted, (async () => {
      if (controller.signal.aborted) throw controller.signal.reason
      let response
      try {
        response = await fetchImpl(LATEST_API, {
          signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
          headers: { Accept: 'application/vnd.github+json' },
        })
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason
        throw checkError('network', '无法连接 GitHub，请检查网络后重试。')
      }
      if (response.status === 404) return { status: 'not-found' }
      if (response.status === 403 || response.status === 429) throw checkError('rate-limit', 'GitHub 暂时限制了请求，请稍后重试或打开下载页面。')
      if (!response.ok) throw checkError('http', 'GitHub 暂时无法提供版本信息，请稍后重试。')
      let release
      try { release = await response.json() } catch { throw checkError('invalid', 'GitHub 返回的版本信息无效，请打开下载页面核对。') }
      const comparison = compareVersions(release?.tag_name, currentVersion)
      if (comparison === null || release.draft || release.prerelease) {
        throw checkError('invalid', '无法比较版本信息，请打开下载页面核对。')
      }
      return {
        status: comparison > 0 ? 'available' : comparison < 0 ? 'ahead' : 'current',
        version: release.tag_name, url: officialReleaseUrl(release.html_url),
      }
    })()])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    controller.signal.removeEventListener('abort', rejectAbort)
  }
}
