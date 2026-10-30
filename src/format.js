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

// 与 QSpace 一致：今天/昨天只显示时间，其余「2026/9/25 00:07」（月日不补零）
export function fmtDate(ms) {
  if (!ms) return '--'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const now = new Date()
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86400000)
  if (diff === 0) return `今天 ${hm}`
  if (diff === 1) return `昨天 ${hm}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`
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

// 「种类」列：扩展名 → 中文种类名（找不到时用「XXX 文件」）
const KINDS = {
  pdf: 'PDF 文档', txt: '文本', md: 'Markdown 文本', markdown: 'Markdown 文本', rtf: 'RTF 文档',
  csv: '逗号分隔的值', tsv: '制表符分隔的值', json: 'JSON 文件', xml: 'XML 文档', yaml: 'YAML 文件', yml: 'YAML 文件',
  toml: 'TOML 文件', ini: '配置文件', log: '日志', html: 'HTML 文档', htm: 'HTML 文档', css: 'CSS 样式表',
  js: 'JavaScript 脚本', jsx: 'JSX 源码', ts: 'TypeScript 源码', tsx: 'TSX 源码', py: 'Python 脚本', r: 'R 脚本',
  rmd: 'R Markdown', sh: 'Shell 脚本', rs: 'Rust 源码', go: 'Go 源码', c: 'C 源码', h: 'C 头文件', cpp: 'C++ 源码',
  java: 'Java 源码', ipynb: 'Jupyter 笔记本', lock: '锁文件',
  png: 'PNG 图像', jpg: 'JPEG 图像', jpeg: 'JPEG 图像', gif: 'GIF 图像', webp: 'WebP 图像', bmp: 'BMP 图像',
  svg: 'SVG 图像', ico: '图标', tiff: 'TIFF 图像', heic: 'HEIC 图像', avif: 'AVIF 图像',
  doc: 'Word 文档', docx: 'Word 文档', xls: 'Excel 工作簿', xlsx: 'Excel 工作簿', ppt: 'PowerPoint 演示文稿',
  pptx: 'PowerPoint 演示文稿', pages: 'Pages 文稿', numbers: 'Numbers 表格', key: 'Keynote 演示文稿',
  zip: 'ZIP 归档', gz: 'gzip 归档', tar: 'TAR 归档', bz2: 'bzip2 归档', xz: 'xz 归档', '7z': '7-Zip 归档', rar: 'RAR 归档',
  dmg: '磁盘映像', pkg: '安装包', app: '应用程序', iso: '光盘映像',
  mp3: 'MP3 音频', wav: 'WAV 音频', aac: 'AAC 音频', flac: 'FLAC 音频', m4a: 'M4A 音频',
  mp4: 'MPEG-4 影片', mov: 'QuickTime 影片', avi: 'AVI 影片', mkv: 'Matroska 影片', webm: 'WebM 影片',
  ttf: '字体', otf: '字体', epub: 'EPUB 图书',
}
export function kindOf(entry) {
  if (entry.isPseudo) return ''
  if (entry.is_dir) return entry.ext === 'app' ? '应用程序' : '文件夹'
  return KINDS[entry.ext] || (entry.ext ? `${entry.ext.toUpperCase()} 文件` : '文件')
}

// 文件名拆成「前段 + 末段」，过长时只缩短前段，形成「前面…后面」的中间省略（funnel_pl…ot.pdf）。
// 末段至少含扩展名并多带几个字符，让后缀和名字结尾都可见；短名字不拆。
export function splitName(name, isDir) {
  const chars = Array.from(name) // 按字符而非 UTF-16 单元，避免劈开 emoji/生僻字
  if (chars.length <= 14) return [name, '']
  const dot = name.lastIndexOf('.')
  const extLen = !isDir && dot > 0 && name.length - dot <= 10 ? Array.from(name.slice(dot)).length : 0
  const tail = Math.min(Math.max(extLen + 5, 8, Math.round(chars.length * 0.3)), chars.length - 4)
  return [chars.slice(0, chars.length - tail).join(''), chars.slice(chars.length - tail).join('')]
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
