import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, lstat, stat } from 'node:fs/promises'
import { cpus, homedir, platform, arch, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const benchDir = here
export const repoRoot = resolve(here, '../..')
export const FILE_BYTES = 32
export const NAME_WIDTH = 6
export const MARKER_NAME = '.bento-bench.json'
export const LARGE_COUNT = 50_000
export const MAX_COUNT = 999_999

export const PAYLOAD = Buffer.alloc(FILE_BYTES, 0x2e)
Buffer.from('bento-bench\n').copy(PAYLOAD)

export const PRESETS = {
  '10k': { count: 10_000 },
  '100k': { count: 100_000 },
}

export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') continue
    if (!token.startsWith('--')) {
      out._.push(token)
      continue
    }
    const key = token.slice(2)
    if (!key) throw new Error('无效参数: --')
    const next = argv[i + 1]
    if (next == null || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

export function rejectUnknown(args, known) {
  const extra = Object.keys(args).filter((k) => k !== '_' && !known.includes(k))
  if (extra.length) {
    throw new Error(`不认识的参数: ${extra.map((k) => '--' + k).join(' ')}`)
  }
  if (args._.length) throw new Error(`多余的参数: ${args._.join(' ')}`)
}

export function fixtureDir(name) {
  return join(benchDir, 'fixtures', name)
}

export function reportsDir() {
  return join(benchDir, 'reports')
}

export function roundMs(n) {
  return Math.round(n * 1000) / 1000
}

export function elapsedMs(startNs) {
  return roundMs(Number(process.hrtime.bigint() - startNs) / 1e6)
}

export function summarize(samples) {
  if (!samples.length) throw new Error('没有样本')
  const xs = samples.map((n) => roundMs(n)).sort((a, b) => a - b)
  const sum = xs.reduce((a, b) => a + b, 0)
  const mid = Math.floor(xs.length / 2)
  const median = xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
  return {
    samples: xs,
    min: xs[0],
    max: xs[xs.length - 1],
    mean: roundMs(sum / xs.length),
    median: roundMs(median),
  }
}

export function parseMsList(value) {
  const parts = String(value)
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((s) => Number(s))
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`无效的毫秒数: ${value}`)
  }
  return parts.map((n) => roundMs(n))
}

export function formatBytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '未知'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Number(n)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const digits = i === 0 ? 0 : v >= 10 ? 1 : 2
  return `${v.toFixed(digits)} ${units[i]}`
}

export function hostInfo() {
  const cpu = cpus()[0]
  return {
    platform: platform(),
    arch: arch(),
    release: release(),
    cpus: cpus().length,
    cpu_model: cpu ? cpu.model : null,
    total_mem_bytes: totalmem(),
    node: process.version,
  }
}

export function gitInfo() {
  const run = (args) => {
    try {
      return execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return null
    }
  }
  const porcelain = run(['status', '--porcelain'])
  return {
    commit: run(['rev-parse', 'HEAD']),
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: porcelain == null ? null : porcelain.length > 0,
  }
}

export function stampUtc(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export function markerPath(dir) {
  return join(dir, MARKER_NAME)
}

export function readMarker(dir) {
  const path = markerPath(dir)
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (!data || typeof data !== 'object') return { generator: null, corrupt: true }
    return data
  } catch {
    return { generator: 'bento-bench', status: 'partial', corrupt: true }
  }
}

export function isOurMarker(marker) {
  return !!marker && marker.generator === 'bento-bench'
}

export function assertSafeFixturePath(dir) {
  const resolved = resolve(dir)
  const home = resolve(homedir())
  const forbidden = new Set(['/', home, repoRoot, resolve(benchDir), resolve(benchDir, 'fixtures')])
  if (forbidden.has(resolved)) {
    throw new Error(`拒绝使用该路径作为夹具目录: ${resolved}`)
  }
  if (repoRoot === resolved || repoRoot.startsWith(resolved + sep)) {
    throw new Error(`夹具路径不能包含仓库本身: ${resolved}`)
  }
  const parts = resolved.split(sep).filter(Boolean)
  if (parts.length < 2) throw new Error(`夹具路径太浅: ${resolved}`)
}

export function allocatedBytes(dir) {
  try {
    const out = execFileSync('du', ['-sk', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const kb = Number(out.split(/\s+/)[0])
    if (!Number.isFinite(kb)) return null
    return kb * 1024
  } catch {
    return null
  }
}

export async function scanDir(dir, { showHidden = false, concurrency = 64 } = {}) {
  const names = await readdir(dir)
  const visible = showHidden ? names : names.filter((name) => !name.startsWith('.'))
  const entries = new Array(visible.length)
  let cursor = 0
  const workers = Math.max(1, Math.min(concurrency, visible.length || 1))
  async function worker() {
    while (true) {
      const index = cursor++
      if (index >= visible.length) return
      const name = visible[index]
      const path = join(dir, name)
      let md
      try {
        md = await stat(path)
      } catch {
        try {
          md = await lstat(path)
        } catch {
          entries[index] = null
          continue
        }
      }
      const isDir = md.isDirectory()
      entries[index] = {
        name,
        path,
        is_dir: isDir,
        size: isDir ? 0 : md.size,
        mtime_ms: md.mtimeMs,
        btime_ms: md.birthtimeMs || 0,
        ext: extname(name).replace(/^\./, '').toLowerCase(),
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return entries.filter(Boolean)
}

export function timeTrash3(dir) {
  const names = readdirSync(dir)
    .filter((name) => name && !name.startsWith('.'))
    .sort()
  if (names.length < 3) throw new Error(`夹具里不足 3 个可见文件: ${dir}`)
  const picked = names.slice(0, 3)
  const trash = join(dirname(dir), `.bento-bench-trash-${process.pid}`)
  mkdirSync(trash, { recursive: true })
  const moved = []
  try {
    const start = process.hrtime.bigint()
    for (const name of picked) {
      renameSync(join(dir, name), join(trash, name))
      moved.push(name)
    }
    return {
      ms: elapsedMs(start),
      files: picked,
    }
  } finally {
    for (const name of moved) {
      const from = join(trash, name)
      const to = join(dir, name)
      if (existsSync(from) && !existsSync(to)) renameSync(from, to)
    }
    rmSync(trash, { recursive: true, force: true })
  }
}

export function relToRepo(path) {
  const abs = resolve(path)
  const root = repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep
  if (abs.startsWith(root)) return abs.slice(root.length)
  return abs
}

export function renderMarkdown(report) {
  const host = report.host || {}
  const git = report.git || {}
  const fixture = report.fixture || {}
  const headless = report.headless || {}
  const gui = report.gui || {}
  const line = (stat) => {
    if (!stat || stat.median == null) return '—'
    return `${stat.median} ms（min ${stat.min} / mean ${stat.mean} / max ${stat.max}，n=${stat.samples.length}）`
  }
  const guiCell = (value, samples) => {
    if (value == null) return '未测'
    if (Array.isArray(samples) && samples.length > 1) return `${value} ms（样本 ${samples.join(', ')}）`
    return `${value} ms`
  }
  const commit = git.commit ? git.commit.slice(0, 7) : '未知'
  const dirty = git.dirty ? '，工作区有未提交改动' : ''
  const oneLine = (text) => String(text).replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 180)
  const rust = headless.scan_rust
  const rustRow = !rust
    ? '| Rust rayon 扫描（对照 `list_dir`） | 未跑 | 加上 `--rust` |'
    : rust.error
      ? `| Rust rayon 扫描（对照 \`list_dir\`） | 失败 | ${oneLine(rust.error)} |`
      : `| Rust rayon 扫描（对照 \`list_dir\`） | ${line(rust.scan_ms)} | 序列化 ${line(rust.json_ms)} |`

  return `# Bento 性能基线

- 时间: ${report.created_at}
- 机器: ${host.platform || '?'} ${host.arch || '?'} · ${host.cpus ?? '?'} 核 · ${host.cpu_model || '未知 CPU'} · Node ${host.node || '?'}
- 提交: \`${commit}\`（${git.branch || '?'}${dirty}）
- 夹具: ${fixture.preset || '自定义'} · ${fixture.file_count ?? '?'} 个文件 · ${fixture.path || '?'}
- 磁盘占用: ${formatBytes(fixture.allocated_bytes)}（\`du -sk\`）· 逻辑体积 ${formatBytes(fixture.logical_bytes)}

无界面数字可以在没有窗口的情况下复现。界面数字是手填的，空着表示这次还没测。新建标签在自动脚本里保持占位。

## 无界面

| 指标 | 结果 | 备注 |
| --- | --- | --- |
| 目录扫描（Node，readdir + stat） | ${line(headless.scan_node && headless.scan_node.scan_ms)} | 便携对照，不是 Rust \`list_dir\` |
| 扫描结果 JSON 序列化（Node） | ${line(headless.scan_node && headless.scan_node.json_ms)} | 近似 IPC 打包，不含界面 |
${rustRow}
| 删除 3 个小文件（同卷 rename） | ${line(headless.delete3 && headless.delete3.ms)} | 对应废纸篓的快速路径，测完会移回 |

${headless.notes || ''}

## 界面（手测）

| 指标 | 结果 | 状态 |
| --- | --- | --- |
| 冷打开夹具、首屏出现第一行文件名 | ${guiCell(gui.cold_open_first_paint_ms, gui.cold_open_samples_ms)} | ${gui.cold_open_first_paint_ms == null ? '未测' : '已填'} |
| 界面里删除 3 个小文件 | ${guiCell(gui.delete3_ms, gui.delete3_samples_ms)} | ${gui.delete3_ms == null ? '未测' : '已填'} |
| 新建标签到首屏 | ${guiCell(gui.new_tab_ms, gui.new_tab_samples_ms)} | ${gui.new_tab_status === 'placeholder' ? '占位，自动脚本不测' : '已填'} |

${gui.note ? `备注: ${gui.note}\n` : ''}
## 复现

\`\`\`bash
${report.reproduce?.generate || `node scripts/bench/generate-fixture.mjs --preset ${fixture.preset || '10k'}`}
${report.reproduce?.measure || `node scripts/bench/measure.mjs --preset ${fixture.preset || '10k'}`}
\`\`\`

手测步骤见 \`scripts/bench/README.md\`。填入界面数字：

\`\`\`bash
node scripts/bench/record.mjs --cold-open-ms <中位数> --delete3-ms <中位数> --new-tab-ms <中位数>
\`\`\`
`
}

export function writeReportFiles(report, { jsonPath, updateLatest = true }) {
  const mdPath = jsonPath.replace(/\.json$/i, '.md')
  const body = JSON.stringify(report, null, 2) + '\n'
  const md = renderMarkdown(report)
  mkdirSync(dirname(jsonPath), { recursive: true })
  writeFileSync(jsonPath, body)
  writeFileSync(mdPath, md)
  if (updateLatest) {
    const latestJson = join(reportsDir(), 'latest.json')
    const latestMd = join(reportsDir(), 'latest.md')
    if (resolve(jsonPath) !== resolve(latestJson)) {
      writeFileSync(latestJson, body)
      writeFileSync(latestMd, md)
    }
  }
  return { jsonPath, mdPath }
}

export function tryDropCaches() {
  if (process.platform === 'darwin') {
    try {
      execSync('purge', { stdio: 'ignore' })
      return { attempted: true, ok: true, method: 'purge' }
    } catch (error) {
      return { attempted: true, ok: false, method: 'purge', error: error instanceof Error ? error.message : String(error) }
    }
  }
  if (process.platform === 'linux') {
    try {
      execSync('sh -c "sync; echo 3 > /proc/sys/vm/drop_caches"', { stdio: 'ignore' })
      return { attempted: true, ok: true, method: 'drop_caches' }
    } catch (error) {
      return {
        attempted: true,
        ok: false,
        method: 'drop_caches',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  return { attempted: false, ok: false, method: null, error: `不支持的系统: ${process.platform}` }
}

export function fileName(index) {
  return `f${String(index).padStart(NAME_WIDTH, '0')}.txt`
}

export function rustBinaryPath() {
  const name = process.platform === 'win32' ? 'bento-scan-bench.exe' : 'bento-scan-bench'
  return join(benchDir, 'scan-rs', 'target', 'release', name)
}

export { basename, dirname, join, resolve }
