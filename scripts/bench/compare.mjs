#!/usr/bin/env node
// Read-only, manually invoked schema-1 headless regression gate.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { summarize } from './lib.mjs'

function requireValue(condition, path, reason = 'missing or invalid') {
  if (!condition) throw new Error(`${path}: ${reason}`)
}
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min
const string = value => typeof value === 'string' && value.trim().length > 0

function validateStats(stats, runs, path) {
  requireValue(stats && Array.isArray(stats.samples) && stats.samples.length === runs, path, 'sample count must equal runs')
  requireValue(stats.samples.every(finite), path, 'samples must be finite nonnegative milliseconds')
  const expected = summarize(stats.samples)
  for (const key of ['min', 'max', 'mean', 'median']) {
    requireValue(finite(stats[key]) && Math.abs(stats[key] - expected[key]) < 0.000001, `${path}.${key}`, 'must agree with samples rounded to 0.001 ms')
  }
}

function validate(report, label) {
  requireValue(report?.schema === 1 && report?.tool === 'bento-bench', label, 'expected bento-bench schema 1')
  const host = report.host, fixture = report.fixture, h = report.headless
  for (const key of ['platform', 'arch', 'release', 'cpu_model', 'node']) requireValue(string(host?.[key]), `${label}.host.${key}`)
  for (const key of ['cpus', 'total_mem_bytes']) requireValue(integer(host?.[key], 1), `${label}.host.${key}`)
  requireValue(fixture && (fixture.preset === null || string(fixture.preset)) && string(fixture.path), `${label}.fixture`)
  for (const key of ['file_count', 'file_bytes', 'logical_bytes']) requireValue(integer(fixture?.[key], 1), `${label}.fixture.${key}`)
  requireValue(fixture.logical_bytes === fixture.file_count * fixture.file_bytes, `${label}.fixture.logical_bytes`, 'must equal file_count * file_bytes')
  requireValue(integer(h?.runs, 1) && h.runs <= 30 && integer(h.warmup) && h.warmup <= 30, `${label}.headless`, 'invalid runs/warmup')
  const cache = h.cache
  requireValue(cache && typeof cache.attempted === 'boolean' && typeof cache.ok === 'boolean'
    && (cache.attempted ? string(cache.method) : cache.method === null && cache.ok === false), `${label}.headless.cache`)
  requireValue(h.warmup === 0 || !cache.ok, `${label}.headless.warmup`, 'successful cold-cache protocol requires zero scan warmup')
  requireValue(Object.hasOwn(h, 'scan_rust') && (h.scan_rust === null || typeof h.scan_rust === 'object'), `${label}.headless.scan_rust`)
  for (const [name, engine] of [['scan_node', 'node'], ['scan_rust', 'rust-rayon']]) {
    const scan = h[name], path = `${label}.headless.${name}`
    if (name === 'scan_rust' && scan === null) continue
    requireValue(scan && !scan.error && !scan.count_mismatch && scan.engine === engine, path, 'missing, failed or unexpected engine')
    requireValue(scan.count === fixture.file_count, `${path}.count`, 'must equal fixture file_count')
    requireValue(scan.warmup === h.warmup, `${path}.warmup`, 'must equal scan protocol warmup')
    if (name === 'scan_node') requireValue(integer(scan.concurrency, 1), `${path}.concurrency`)
    else requireValue(scan.show_hidden === false && string(scan.mirror_of), path, 'expected visible-only Rust mirror')
    validateStats(scan.scan_ms, h.runs, `${path}.scan_ms`)
    validateStats(scan.json_ms, h.runs, `${path}.json_ms`)
  }
  const deletion = h.delete3
  requireValue(deletion?.method === 'rename-to-sibling-trash-and-back', `${label}.headless.delete3.method`)
  requireValue(Array.isArray(deletion.files) && deletion.files.length === 3 && deletion.files.every(string) && new Set(deletion.files).size === 3, `${label}.headless.delete3.files`)
  requireValue(integer(deletion.warmup) && deletion.warmup <= 30, `${label}.headless.delete3.warmup`)
  validateStats(deletion.ms, h.runs, `${label}.headless.delete3.ms`)
}

export function compareReports(baseline, candidate, { threshold = 0.2, floorMs = 1 } = {}) {
  requireValue(finite(threshold) && finite(floorMs), 'options', 'threshold and floorMs must be finite nonnegative numbers')
  validate(baseline, 'baseline'); validate(candidate, 'candidate')
  const same = (a, b, path) => requireValue(isDeepStrictEqual(a, b), path, 'incompatible baseline and candidate')
  for (const key of ['platform', 'arch', 'release', 'cpus', 'cpu_model', 'total_mem_bytes', 'node']) same(baseline.host[key], candidate.host[key], `host.${key}`)
  for (const key of ['preset', 'file_count', 'file_bytes', 'logical_bytes']) same(baseline.fixture[key], candidate.fixture[key], `fixture.${key}`)
  const a = baseline.headless, b = candidate.headless
  for (const key of ['runs', 'warmup']) same(a[key], b[key], `headless.${key}`)
  for (const key of ['attempted', 'ok', 'method']) same(a.cache[key], b.cache[key], `headless.cache.${key}`)
  same(a.scan_node.concurrency, b.scan_node.concurrency, 'headless.scan_node.concurrency')
  same(a.scan_rust === null, b.scan_rust === null, 'headless.scan_rust')
  if (a.scan_rust) same(a.scan_rust.mirror_of, b.scan_rust.mirror_of, 'headless.scan_rust.mirror_of')
  for (const key of ['warmup', 'files']) same(a.delete3[key], b.delete3[key], `headless.delete3.${key}`)
  const metrics = []
  const add = (name, before, after, kind) => {
    const delta = after.median - before.median
    const limit = Math.max(before.median * threshold, floorMs)
    // Absorb subtraction/multiplication roundoff at an exact boundary, never
    // the report's 0.001 ms resolution. The cap also bounds very large inputs.
    const roundoff = Math.min(0.0000001, Number.EPSILON * 4 * Math.max(1, before.median, after.median, limit))
    metrics.push({ name, kind, baseline_ms: before.median, candidate_ms: after.median, delta_ms: delta,
      relative_change: before.median === 0 ? (delta === 0 ? 0 : null) : delta / before.median,
      status: delta - limit > roundoff ? 'regression' : 'pass' })
  }
  for (const name of ['scan_node', 'scan_rust']) {
    if (!a[name]) continue
    for (const key of ['scan_ms', 'json_ms']) add(`${name}.${key}`, a[name][key], b[name][key], name === 'scan_node' ? 'Node filesystem/serialization proxy' : 'Rust standalone list_dir mirror')
  }
  add('delete3.ms', a.delete3.ms, b.delete3.ms, 'same-volume rename proxy; excludes native trash UI/IPC')
  const gui = ['cold_open_first_paint_ms', 'delete3_ms', 'new_tab_ms'].map(name => ({ name, status:
    baseline.gui?.[name] == null && candidate.gui?.[name] == null ? 'unmeasured' : 'manual-excluded' }))
  return { schema: 1, scope: 'headless-only', status: metrics.some(m => m.status === 'regression') ? 'regression' : 'pass', threshold, floor_ms: floorMs, metrics, gui,
    limitations: ['GUI timings are excluded from this gate; empty values remain unmeasured.', 'Schema 1 cannot verify volume, filesystem, load, Rust compiler or mirror freshness. Confirm these manually.', 'Node and rename proxies do not measure native application or first-paint performance.'] }
}

const usage = `Usage: npm run bench:compare -- --baseline before.json --candidate after.json [--threshold 0.2] [--floor-ms 1] [--json]
Compare headless medians; regression requires delta > max(baseline * threshold, floor-ms).
Exit codes: 0 headless pass, 1 regression, 2 invalid/incompatible input. GUI is never gated.`

function main(argv) {
  const json = argv.includes('--json')
  try {
    const args = {}
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i]
      requireValue(['--baseline', '--candidate', '--threshold', '--floor-ms', '--json', '--help'].includes(flag), 'arguments', `unknown argument ${flag}`)
      requireValue(!Object.hasOwn(args, flag), 'arguments', `duplicate ${flag}`)
      if (flag === '--json' || flag === '--help') args[flag] = true
      else {
        requireValue(i + 1 < argv.length && argv[i + 1].trim().length > 0 && !argv[i + 1].startsWith('--'), 'arguments', `${flag} requires a value`)
        args[flag] = argv[++i]
      }
    }
    if (args['--help']) { console.log(usage); return }
    requireValue(string(args['--baseline']) && string(args['--candidate']), 'arguments', usage)
    const options = {}
    if (args['--threshold'] !== undefined) options.threshold = Number(args['--threshold'])
    if (args['--floor-ms'] !== undefined) options.floorMs = Number(args['--floor-ms'])
    const result = compareReports(JSON.parse(readFileSync(args['--baseline'], 'utf8')), JSON.parse(readFileSync(args['--candidate'], 'utf8')), options)
    if (json) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`Headless gate: ${result.status.toUpperCase()} (threshold ${result.threshold * 100}%, floor ${result.floor_ms} ms)`)
      for (const metric of result.metrics) console.log(`${metric.status.toUpperCase()} ${metric.name}: ${metric.baseline_ms} → ${metric.candidate_ms} ms (${metric.kind})`)
      for (const metric of result.gui) console.log(`GUI ${metric.name}: ${metric.status}; excluded from gate`)
      for (const note of result.limitations) console.log(note)
    }
    process.exitCode = result.status === 'regression' ? 1 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (json) console.log(JSON.stringify({ schema: 1, scope: 'headless-only', status: 'invalid', error: message }))
    else console.error(`Invalid comparison: ${message}`)
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
