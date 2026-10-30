export function fmtSize(n) {
  if (n == null || n <= 0) return '--'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

export function fmtDate(ms) {
  if (!ms) return '--'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'avif'])
export const isImage = (ext) => IMG.has(ext)

export function extColor(ext) {
  if (!ext) return '#8e8e93'
  if (['js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'java', 'kt', 'sh', 'rb', 'php', 'swift', 'vue', 'html', 'css', 'json', 'yaml', 'yml', 'toml', 'lock'].includes(ext)) return '#a377ff'
  if (['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'lzma', 'dmg', 'pkg'].includes(ext)) return '#f5a623'
  if (['mp3', 'wav', 'aac', 'flac', 'm4a'].includes(ext)) return '#ff375f'
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return '#bf5af2'
  if (ext === 'pdf') return '#ff453a'
  if (['doc', 'docx', 'txt', 'md', 'rtf', 'pages'].includes(ext)) return '#0a84ff'
  if (['xls', 'xlsx', 'numbers', 'csv'].includes(ext)) return '#30d158'
  if (['key', 'ppt', 'pptx'].includes(ext)) return '#ff9f0a'
  if (IMG.has(ext)) return '#64d2ff'
  return '#8e8e93'
}

export const basename = (p) => p.split('/').filter(Boolean).pop() || p

export function parentPath(p) {
  if (!p || p === '/') return null
  const parts = p.split('/').filter(Boolean)
  parts.pop()
  return '/' + parts.join('/')
}

const ZH_NAMES = {
  Desktop: '桌面',
  Documents: '文稿',
  Downloads: '下载',
  Movies: '影片',
  Music: '音乐',
  Pictures: '照片',
  Public: '公共',
  Applications: '应用程序',
}

export function labelOf(path, home) {
  if (path === '/') return 'Macintosh HD'
  if (path === home) return '主目录'
  const name = basename(path)
  return ZH_NAMES[name] || name
}

export async function copyText(s) {
  try {
    await navigator.clipboard.writeText(s)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = s
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

/**
 * 筛选/搜索匹配器（对文件名，多词 AND）：
 * 纯文本 = 包含；`*`/`?` = 通配符；`ext:jpg` = 后缀；`re:正则` = 正则
 * 例：`*测试*.jpg` = 名字含"测试"的 jpg 文件
 */
export function makeMatcher(q) {
  const kw = (q || '').trim()
  if (!kw) return null
  const subs = []
  const regexes = []
  const globs = []
  const exts = []
  for (const term of kw.split(/\s+/)) {
    const lower = term.toLowerCase()
    if (lower.startsWith('re:')) {
      try {
        regexes.push(new RegExp(term.slice(3), 'i'))
      } catch {
        return null
      }
    } else if (lower.startsWith('ext:')) {
      const e = lower.slice(4).replace(/^\./, '')
      if (e) exts.push(e)
    } else if (term.includes('*') || term.includes('?')) {
      const src =
        '^' +
        lower
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$'
      try {
        globs.push(new RegExp(src, 'i'))
      } catch {}
    } else {
      subs.push(lower)
    }
  }
  return (name) => {
    const ln = name.toLowerCase()
    const dot = ln.lastIndexOf('.')
    const ext = dot > 0 ? ln.slice(dot + 1) : ''
    return (
      subs.every((s) => ln.includes(s)) &&
      regexes.every((re) => re.test(name)) &&
      globs.every((re) => re.test(ln)) &&
      (exts.length === 0 || exts.some((e) => ext === e))
    )
  }
}
