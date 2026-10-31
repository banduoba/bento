#!/usr/bin/env node
// 无界面基线：目录扫描 + 删除 3 个小文件。界面首屏和新标签只留手测栏位。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  PRESETS,
  allocatedBytes,
  assertSafeFixturePath,
  benchDir,
  elapsedMs,
  fixtureDir,
  gitInfo,
  hostInfo,
  isOurMarker,
  join,
  parseArgs,
  readMarker,
  rejectUnknown,
  relToRepo,
  renderMarkdown,
  repoRoot,
  reportsDir,
  rustBinaryPath,
  scanDir,
  stampUtc,
  summarize,
  timeTrash3,
  tryDropCaches,
  writeReportFiles,
} from './lib.mjs'

const usage = `用法:
  node scripts/bench/measure.mjs
  node scripts/bench/measure.mjs --preset 10k
  node scripts/bench/measure.mjs --preset 100k --rust
  node scripts/bench/measure.mjs --fixture <夹具目录> --runs 5

默认测量 scripts/bench/fixtures/10k。目录必须带本工具的 .bento-bench.json，
避免误删普通文件夹里的文件。

选项:
  --preset 10k|100k   使用默认夹具路径
  --fixture <目录>    测量指定夹具
  --runs <n>          计入结果的次数，默认 5
  --warmup <n>        不计入结果的预热次数，默认 1
  --rust              编译并运行与 list_dir 对齐的 Rayon 扫描
  --cold              尝试丢掉文件系统缓存（macOS purge / Linux drop_caches，通常要 root）
  --out <文件.json>   报告路径。默认写到 scripts/bench/reports/
`

function fail(message, code = 1) {
  console.error(message)
  process.exit(code)
}

function positiveInt(value, name) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 30) fail(`${name} 需要 1 到 30 的整数`)
  return n
}

function resolveFixture(args) {
  if (args.preset && args.fixture) fail('不要同时传 --preset 和 --fixture')
  if (args.fixture) return { preset: null, dir: resolve(String(args.fixture)) }
  const preset = args.preset ? String(args.preset) : '10k'
  if (!PRESETS[preset]) fail(`未知预设: ${preset}（可用 10k、100k）`)
  return { preset, dir: fixtureDir(preset) }
}

async function timeScan(dir, runs, warmup) {
  for (let i = 0; i < warmup; i++) await scanDir(dir)
  const samples = []
  let last = null
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint()
    last = await scanDir(dir)
    samples.push(elapsedMs(start))
  }
  const jsonSamples = []
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint()
    JSON.stringify({ entries: last })
    jsonSamples.push(elapsedMs(start))
  }
  return {
    engine: 'node',
    note: 'readdir + 并发 stat，并组装与 list_dir 相近的字段。这是便携对照，不能代替 Rust list_dir，也不包含 React 首屏。',
    count: last.length,
    concurrency: 64,
    warmup,
    scan_ms: summarize(samples),
    json_ms: summarize(jsonSamples),
  }
}

function timeDeletes(dir, runs, warmup) {
  for (let i = 0; i < warmup; i++) timeTrash3(dir)
  const samples = []
  let files = null
  for (let i = 0; i < runs; i++) {
    const sample = timeTrash3(dir)
    samples.push(sample.ms)
    files = sample.files
  }
  return {
    method: 'rename-to-sibling-trash-and-back',
    note: '只计把 3 个文件 rename 到同级临时废纸篓的时间，然后立刻移回。与 trash() 在主卷上的快速路径一致（fs::rename），不含界面、IPC 和列表刷新。',
    files,
    warmup,
    ms: summarize(samples),
  }
}

function runRust(dir, runs, warmup) {
  const manifest = join(benchDir, 'scan-rs', 'Cargo.toml')
  console.error('编译 Rayon 扫描对照（首次会下载依赖）…')
  execFileSync('cargo', ['build', '--release', '--manifest-path', manifest], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  const bin = rustBinaryPath()
  if (!existsSync(bin)) fail(`找不到 ${bin}`)
  const stdout = execFileSync(bin, [dir, '--runs', String(runs), '--warmup', String(warmup)], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) {
    console.log(usage)
    return
  }
  rejectUnknown(args, ['preset', 'fixture', 'runs', 'warmup', 'rust', 'cold', 'out', 'help', 'h'])

  const { preset, dir } = resolveFixture(args)
  assertSafeFixturePath(dir)
  if (!existsSync(dir)) {
    fail(
      `找不到夹具: ${dir}\n先生成：node scripts/bench/generate-fixture.mjs --preset ${preset || '10k'}`,
      2
    )
  }
  const marker = readMarker(dir)
  if (!isOurMarker(marker) || marker.status !== 'complete') {
    fail(`拒绝测量：${dir} 不是已完成的 bento-bench 夹具（缺少 ${dir}/.bento-bench.json）。`)
  }

  const runs = args.runs != null ? positiveInt(args.runs, '--runs') : 5
  const warmup = args.warmup != null ? positiveInt(args.warmup, '--warmup') : 1
  let cache = { attempted: false, ok: false, method: null }
  if (args.cold) {
    console.error('尝试丢弃文件系统缓存…')
    cache = tryDropCaches()
    if (!cache.ok) console.error(`未能丢弃缓存（${cache.error || '未知原因'}）。接下来的数字是热缓存。`)
  }

  console.error(`扫描 ${dir} …`)
  const scan = await timeScan(dir, runs, args.cold && cache.ok ? 0 : warmup)
  if (scan.count !== marker.count) {
    console.error(`注意：扫到 ${scan.count} 个可见条目，夹具标记是 ${marker.count}。`)
  }

  let scanRust = null
  if (args.rust) {
    try {
      scanRust = runRust(dir, runs, args.cold && cache.ok ? 0 : warmup)
      if (scanRust.count !== scan.count) {
        scanRust.count_mismatch = { node: scan.count, rust: scanRust.count }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      scanRust = { error: message }
      console.error(`Rust 对照失败: ${message}`)
    }
  }

  console.error('测量删除 3 个小文件…')
  const delete3 = timeDeletes(dir, runs, warmup)

  const created = new Date()
  const stamp = stampUtc(created)
  const jsonPath = args.out
    ? resolve(String(args.out))
    : join(reportsDir(), `baseline-${stamp}.json`)
  const fixturePreset = preset || marker.preset || null
  const report = {
    schema: 1,
    tool: 'bento-bench',
    created_at: created.toISOString(),
    host: hostInfo(),
    git: gitInfo(),
    fixture: {
      preset: fixturePreset,
      path: dir,
      file_count: marker.count,
      file_bytes: marker.file_bytes,
      logical_bytes: marker.logical_bytes,
      allocated_bytes: allocatedBytes(dir),
      generated_elapsed_ms: marker.elapsed_ms ?? null,
    },
    headless: {
      cache,
      warmup: args.cold && cache.ok ? 0 : warmup,
      runs,
      scan_node: scan,
      scan_rust: scanRust,
      delete3,
      notes:
        '冷打开首屏和新标签需要图形界面，这里不测。scan_node 是文件系统对照；scan_rust 才与 src-tauri/src/lib.rs 的 list_dir 使用同一套 read_dir + rayon metadata。' +
      (scanRust && scanRust.count_mismatch
        ? ` Node 扫到 ${scanRust.count_mismatch.node} 项，Rust 扫到 ${scanRust.count_mismatch.rust} 项。`
        : ''),
    },
    reproduce: {
      generate: preset
        ? `node scripts/bench/generate-fixture.mjs --preset ${preset}`
        : `node scripts/bench/generate-fixture.mjs --count ${marker.count} --out ${dir}`,
      measure: preset
        ? `node scripts/bench/measure.mjs --preset ${preset}${args.rust ? ' --rust' : ''}`
        : `node scripts/bench/measure.mjs --fixture ${dir}${args.rust ? ' --rust' : ''}`,
    },
    gui: {
      cold_open_first_paint_ms: null,
      cold_open_samples_ms: null,
      delete3_ms: null,
      delete3_samples_ms: null,
      new_tab_ms: null,
      new_tab_samples_ms: null,
      new_tab_status: 'placeholder',
      note: null,
      recorded_at: null,
    },
    files: null,
  }
  report.files = {
    json: relToRepo(jsonPath),
    md: relToRepo(jsonPath.replace(/\.json$/i, '.md')),
  }

  const written = writeReportFiles(report, { jsonPath, updateLatest: !args.out })
  console.log(renderMarkdown(report))
  console.log(`JSON: ${written.jsonPath}`)
  console.log(`Markdown: ${written.mdPath}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
