#!/usr/bin/env node
// 把手测的首屏、删除、新标签时间写进最近一次（或指定的）基线报告。
import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

import {
  join,
  parseArgs,
  parseMsList,
  rejectUnknown,
  relToRepo,
  renderMarkdown,
  repoRoot,
  reportsDir,
  summarize,
  writeReportFiles,
} from './lib.mjs'

const usage = `用法:
  node scripts/bench/record.mjs --cold-open-ms 850
  node scripts/bench/record.mjs --cold-open-ms 900,840,850 --delete3-ms 40 --new-tab-ms 300
  node scripts/bench/record.mjs --report scripts/bench/reports/baseline-....json --note "M3，每次 sudo purge"

多个数用逗号分开时，报告里的主值取中位数，并保留样本。
未填写的新建标签保持 placeholder。
`

function fail(message) {
  console.error(message)
  process.exit(1)
}

function absFromStored(stored) {
  if (stored.startsWith('/')) return resolve(stored)
  return resolve(repoRoot, stored)
}

function applySamples(report, key, samplesKey, raw) {
  const samples = parseMsList(raw)
  report.gui[samplesKey] = samples
  report.gui[key] = summarize(samples).median
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) {
    console.log(usage)
    return
  }
  rejectUnknown(args, ['report', 'cold-open-ms', 'delete3-ms', 'new-tab-ms', 'note', 'help', 'h'])

  const reportPath = args.report ? resolve(String(args.report)) : join(reportsDir(), 'latest.json')
  if (!existsSync(reportPath)) {
    fail(`找不到报告: ${reportPath}\n先运行：node scripts/bench/measure.mjs`)
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (report.schema !== 1 || !report.gui) fail('报告格式不是 bento-bench schema 1')

  let changed = false
  if (args['cold-open-ms'] != null) {
    applySamples(report, 'cold_open_first_paint_ms', 'cold_open_samples_ms', args['cold-open-ms'])
    changed = true
  }
  if (args['delete3-ms'] != null) {
    applySamples(report, 'delete3_ms', 'delete3_samples_ms', args['delete3-ms'])
    changed = true
  }
  if (args['new-tab-ms'] != null) {
    applySamples(report, 'new_tab_ms', 'new_tab_samples_ms', args['new-tab-ms'])
    changed = true
  }
  if (args.note != null && args.note !== true) {
    report.gui.note = String(args.note)
    changed = true
  }
  if (!changed) fail('请至少传入一个指标，例如 --cold-open-ms 850')

  report.gui.recorded_at = new Date().toISOString()
  report.gui.new_tab_status = report.gui.new_tab_ms == null ? 'placeholder' : 'manual'

  const reportsRoot = resolve(reportsDir())
  const targets = new Set([resolve(reportPath)])
  if (report.files?.json) {
    const canonical = absFromStored(report.files.json)
    if (existsSync(canonical)) targets.add(canonical)
  }
  const touchesReports = [...targets].some((p) => p === reportsRoot || p.startsWith(reportsRoot + sep))
  if (touchesReports) targets.add(join(reportsRoot, 'latest.json'))

  const canonical =
    [...targets].find((p) => p.startsWith('baseline-', p.lastIndexOf(sep) + 1)) || resolve(reportPath)
  report.files = {
    json: relToRepo(canonical),
    md: relToRepo(canonical.replace(/\.json$/i, '.md')),
  }

  for (const jsonPath of targets) {
    writeReportFiles(report, { jsonPath, updateLatest: false })
  }

  console.log(renderMarkdown(report))
  for (const jsonPath of targets) console.log(`已更新: ${jsonPath}`)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
