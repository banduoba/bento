#!/usr/bin/env node
// 生成 Bento 性能夹具：一个目录里放 N 个 32 字节小文件。
import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  FILE_BYTES,
  LARGE_COUNT,
  MAX_COUNT,
  NAME_WIDTH,
  PAYLOAD,
  PRESETS,
  allocatedBytes,
  assertSafeFixturePath,
  elapsedMs,
  fileName,
  fixtureDir,
  formatBytes,
  hostInfo,
  isOurMarker,
  markerPath,
  parseArgs,
  readMarker,
  rejectUnknown,
  roundMs,
} from './lib.mjs'

const usage = `用法:
  node scripts/bench/generate-fixture.mjs --preset 10k
  node scripts/bench/generate-fixture.mjs --preset 100k
  node scripts/bench/generate-fixture.mjs --count 10000 --out <目录>

预设:
  10k    10000 个小文件
  100k   100000 个小文件（会提示磁盘占用和耗时，可用 --yes 跳过 3 秒等待）

选项:
  --out <目录>   输出目录。默认 scripts/bench/fixtures/<预设名>
  --force        删掉已有的本工具夹具后重建
  --yes          大夹具不等待 3 秒
  --dry-run      只打印计划，不写文件
`

function fail(message) {
  console.error(message)
  process.exit(1)
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function freeBytes(dir) {
  const st = statfsSync(dir)
  return Number(st.bavail) * Number(st.bsize)
}

function estimateBlockBytes(count) {
  return count * 4096
}

function warnLarge(count, { pause }) {
  const logical = count * FILE_BYTES
  const blocks = estimateBlockBytes(count)
  console.error('')
  console.error(`警告：即将创建 ${count} 个 ${FILE_BYTES} 字节小文件。`)
  console.error(`  逻辑体积约 ${formatBytes(logical)}。`)
  console.error(`  磁盘占用通常按每文件一个块估算（APFS / ext4 常见 4 KiB），约 ${formatBytes(blocks)}，目录项还会再占一些。`)
  console.error('  耗时视磁盘而定：较快的 SSD 上可能只要数秒；APFS 上更新一个很大的目录，或机械盘、网络盘，可能要几十秒到几分钟。')
  if (pause) console.error('  3 秒后开始。Ctrl-C 取消；加上 --yes 可跳过等待。')
  console.error('')
}

function dataFileCount(dir) {
  return readdirSync(dir).filter((name) => !name.startsWith('.')).length
}

function planFromArgs(args) {
  if (args.preset && args.count != null) fail('不要同时传 --preset 和 --count')
  let preset = null
  let count
  if (args.preset) {
    if (!PRESETS[args.preset]) fail(`未知预设: ${args.preset}（可用 10k、100k）`)
    preset = String(args.preset)
    count = PRESETS[preset].count
  } else if (args.count != null) {
    count = Number(args.count)
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
      fail(`--count 需要 1 到 ${MAX_COUNT} 的整数`)
    }
  } else {
    fail('请指定 --preset 10k、--preset 100k 或 --count')
  }
  const out = args.out ? String(args.out) : fixtureDir(preset || `n${count}`)
  return { preset, count, out }
}

function writeFiles(dir, count) {
  const step = count >= 5000 ? 5000 : Math.max(1, Math.floor(count / 5))
  const started = process.hrtime.bigint()
  for (let i = 0; i < count; i++) {
    writeFileSync(fileNamePath(dir, i), PAYLOAD)
    if ((i + 1) % step === 0 || i + 1 === count) {
      const sec = (Number(process.hrtime.bigint() - started) / 1e9).toFixed(1)
      console.error(`  ${i + 1}/${count}  ${sec}s`)
    }
  }
  return elapsedMs(started)
}

function fileNamePath(dir, index) {
  return join(dir, fileName(index))
}

function printReady(meta, reused) {
  console.log(reused ? '夹具已存在，跳过生成（加 --force 可重建）' : '夹具已就绪')
  console.log(`  路径: ${meta.path}`)
  console.log(`  文件: ${meta.count} × ${meta.file_bytes} B`)
  console.log(`  逻辑体积: ${formatBytes(meta.logical_bytes)}`)
  console.log(`  磁盘占用: ${formatBytes(meta.allocated_bytes)}（du -sk）`)
  if (meta.elapsed_ms != null) console.log(`  生成耗时: ${(meta.elapsed_ms / 1000).toFixed(2)} s`)
  console.log('  标记文件 .bento-bench.json 以点开头，Bento 默认不显示隐藏文件，列表里不会多出这一项。')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) {
    console.log(usage)
    return
  }
  rejectUnknown(args, ['preset', 'count', 'out', 'force', 'yes', 'dry-run', 'help', 'h'])
  const { preset, count, out } = planFromArgs(args)
  assertSafeFixturePath(out)

  const logical = count * FILE_BYTES
  const blocks = estimateBlockBytes(count)
  const large = count >= LARGE_COUNT

  if (args['dry-run']) {
    if (large) warnLarge(count, { pause: false })
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          preset,
          count,
          file_bytes: FILE_BYTES,
          logical_bytes: logical,
          estimated_block_bytes: blocks,
          path: out,
          large,
        },
        null,
        2
      )
    )
    return
  }

  mkdirSync(dirname(out), { recursive: true })
  const marker = readMarker(out)
  if (existsSync(out)) {
    const entries = readdirSync(out)
    if (entries.length && !isOurMarker(marker)) {
      fail(`目录非空，且不是本工具生成的夹具，拒绝写入: ${out}`)
    }
  }

  if (isOurMarker(marker) && marker.status === 'complete' && !args.force) {
    const same =
      marker.count === count &&
      marker.file_bytes === FILE_BYTES &&
      marker.name_width === NAME_WIDTH &&
      dataFileCount(out) === count
    if (same) {
      const allocated = allocatedBytes(out)
      printReady(
        {
          path: out,
          count,
          file_bytes: FILE_BYTES,
          logical_bytes: logical,
          allocated_bytes: allocated,
          elapsed_ms: marker.elapsed_ms ?? null,
        },
        true
      )
      return
    }
  }

  if (large) warnLarge(count, { pause: !args.yes })

  let free = null
  try {
    free = freeBytes(dirname(out))
  } catch {
    free = null
  }
  const need = blocks + 64 * 1024 * 1024
  if (free != null && free < need) {
    fail(`可用空间不足：约 ${formatBytes(free)}，按 4 KiB/文件估算至少需要 ${formatBytes(need)}。`)
  }

  if (large && !args.yes) sleepMs(3000)

  if (existsSync(out)) rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  const startedAt = new Date().toISOString()
  writeFileSync(
    markerPath(out),
    JSON.stringify(
      {
        generator: 'bento-bench',
        schema: 1,
        status: 'partial',
        preset,
        count,
        file_bytes: FILE_BYTES,
        name_width: NAME_WIDTH,
        started_at: startedAt,
      },
      null,
      2
    ) + '\n'
  )

  const elapsed = writeFiles(out, count)
  const allocated = allocatedBytes(out)
  const meta = {
    generator: 'bento-bench',
    schema: 1,
    status: 'complete',
    preset,
    count,
    file_bytes: FILE_BYTES,
    name_width: NAME_WIDTH,
    logical_bytes: logical,
    estimated_block_bytes: blocks,
    allocated_bytes: allocated,
    elapsed_ms: elapsed,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    host: hostInfo(),
  }
  writeFileSync(markerPath(out), JSON.stringify(meta, null, 2) + '\n')
  printReady({ path: out, ...meta }, false)
  if (count >= 10_000) {
    const perFile = allocated && count ? roundMs(allocated / count) : null
    console.log(
      perFile
        ? `  平均每文件磁盘约 ${formatBytes(perFile)}（含目录开销摊到每个文件上的 du 结果）。`
        : '  未能用 du 读到磁盘占用。'
    )
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
