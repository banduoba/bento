import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareReports } from './compare.mjs'

const stats = (n = 10) => ({ samples: [n, n, n], min: n, max: n, mean: n, median: n })
function report(rust = false) {
  return {
    schema: 1, tool: 'bento-bench',
    host: { platform: 'darwin', arch: 'arm64', release: '25.0', cpus: 10, cpu_model: 'Apple M1', total_mem_bytes: 16000, node: 'v22.1.0' },
    fixture: { preset: '10k', path: '/tmp/fixture', file_count: 10000, file_bytes: 32, logical_bytes: 320000 },
    headless: {
      runs: 3, warmup: 1, cache: { attempted: false, ok: false, method: null },
      scan_node: { engine: 'node', count: 10000, concurrency: 64, warmup: 1, scan_ms: stats(), json_ms: stats() },
      scan_rust: rust ? { engine: 'rust-rayon', mirror_of: 'src-tauri/src/lib.rs list_dir + make_entry', count: 10000, warmup: 1, show_hidden: false, scan_ms: stats(), json_ms: stats() } : null,
      delete3: { method: 'rename-to-sibling-trash-and-back', files: ['f000000.txt', 'f000001.txt', 'f000002.txt'], warmup: 1, ms: stats(0.05) },
    },
    gui: { cold_open_first_paint_ms: null, new_tab_ms: null, new_tab_status: 'placeholder' },
  }
}

test('compares three required medians and leaves GUI unmeasured', () => {
  const result = compareReports(report(), report())
  assert.equal(result.status, 'pass')
  assert.equal(result.metrics.length, 3)
  assert.ok(result.gui.every(metric => metric.status === 'unmeasured'))
})

test('requires both relative threshold and absolute floor to be exceeded', () => {
  const baseline = report(), candidate = report()
  candidate.headless.scan_node.scan_ms = stats(12)
  candidate.headless.delete3.ms = stats(0.09)
  assert.equal(compareReports(baseline, candidate).status, 'pass')
  candidate.headless.scan_node.scan_ms = stats(12.001)
  assert.equal(compareReports(baseline, candidate).status, 'regression')
  assert.equal(compareReports(baseline, candidate, { threshold: 0.3 }).status, 'pass')
  assert.equal(compareReports(baseline, candidate, { threshold: 0, floorMs: 0 }).metrics.filter(m => m.status === 'regression').length, 2)
})

test('fractional relative equality passes but 0.001 ms above it regresses', () => {
  const baseline = report(), candidate = report()
  baseline.headless.scan_node.scan_ms = stats(5.005)
  candidate.headless.scan_node.scan_ms = stats(6.006)
  assert.equal(compareReports(baseline, candidate).status, 'pass')
  candidate.headless.scan_node.scan_ms = stats(6.007)
  assert.equal(compareReports(baseline, candidate).status, 'regression')
})

test('fractional absolute equality passes but 0.001 ms above it regresses', () => {
  const baseline = report(), candidate = report()
  baseline.headless.scan_node.scan_ms = stats(5.005)
  candidate.headless.scan_node.scan_ms = stats(6.006)
  const options = { threshold: 0, floorMs: 1.001 }
  assert.equal(compareReports(baseline, candidate, options).status, 'pass')
  candidate.headless.scan_node.scan_ms = stats(6.007)
  assert.equal(compareReports(baseline, candidate, options).status, 'regression')
})

test('supports zero baselines without nonfinite JSON ratios', () => {
  const baseline = report(), candidate = report()
  baseline.headless.scan_node.json_ms = stats(0)
  candidate.headless.scan_node.json_ms = stats(2)
  const result = compareReports(baseline, candidate)
  assert.equal(result.status, 'regression')
  assert.equal(result.metrics[1].relative_change, null)
})

test('compares Rust only when available in both reports', () => {
  assert.equal(compareReports(report(true), report(true)).metrics.length, 5)
  assert.throws(() => compareReports(report(true), report()), /scan_rust/)
  const failed = report(true)
  failed.headless.scan_rust = { error: 'compiler failed' }
  assert.throws(() => compareReports(failed, failed), /scan_rust/)
})

test('rejects incompatible hosts, fixtures and protocols', () => {
  for (const mutate of [
    r => { r.host.node = 'v22.2.0' }, r => { r.host.cpu_model = 'other' },
    r => { r.host.arch = 'x64' }, r => { r.host.platform = 'linux' },
    r => { r.host.release = '26.0' }, r => { r.host.cpus++ },
    r => { r.fixture.file_count++ }, r => { r.fixture.file_bytes++ },
    r => { r.headless.runs++ }, r => { r.headless.warmup++ },
    r => { r.headless.cache.attempted = true; r.headless.cache.method = 'purge' },
    r => { r.headless.scan_node.concurrency++ }, r => { r.headless.scan_node.engine = 'other' },
    r => { r.headless.delete3.method = 'native-trash' },
  ]) {
    const candidate = report(); mutate(candidate)
    assert.throws(() => compareReports(report(), candidate))
  }
})

test('fails closed on missing, malformed, nonfinite, inconsistent and count-mismatched inputs', () => {
  for (const mutate of [
    r => { delete r.host.arch }, r => { delete r.headless.scan_rust },
    r => { r.schema = 2 }, r => { r.headless.scan_node.count-- },
    r => { r.headless.scan_node.scan_ms.samples[0] = -1 },
    r => { delete r.headless.delete3.ms },
    r => { r.headless.scan_node.scan_ms.samples.pop() },
    r => { r.headless.scan_node.json_ms.median = NaN },
    r => { r.headless.scan_node.scan_ms.samples[0] = Infinity },
    r => { r.headless.scan_node.scan_ms.median = 1 },
    r => { r.headless.delete3.files = ['a', 'a', 'b'] },
    r => { r.headless.cache = { attempted: false, ok: true, method: null } },
  ]) {
    const invalid = report(); mutate(invalid)
    assert.throws(() => compareReports(invalid, invalid))
  }
  for (const options of [{ threshold: -1 }, { floorMs: Infinity }, { threshold: '0.2' }]) {
    assert.throws(() => compareReports(report(), report(), options))
  }
})

test('never gates or counts manually entered GUI numbers as passes', () => {
  const candidate = report()
  candidate.gui = { cold_open_first_paint_ms: 800, delete3_ms: 30, new_tab_ms: 300, new_tab_status: 'manual' }
  const result = compareReports(report(), candidate)
  assert.equal(result.status, 'pass')
  assert.equal(result.metrics.length, 3)
  assert.ok(result.gui.every(metric => metric.status === 'manual-excluded'))
})

test('CLI provides machine output, regression and input exit codes without writing inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'bento-compare-test-'))
  try {
    const base = join(root, 'base.json'), next = join(root, 'next.json')
    writeFileSync(base, JSON.stringify(report()))
    const run = args => spawnSync(process.execPath, ['scripts/bench/compare.mjs', '--baseline', base, '--candidate', next, ...args], { encoding: 'utf8' })
    writeFileSync(next, JSON.stringify(report()))
    const passed = run(['--json'])
    assert.equal(passed.status, 0)
    assert.equal(JSON.parse(passed.stdout).status, 'pass')
    const candidate = report(); candidate.headless.scan_node.scan_ms = stats(50)
    writeFileSync(next, JSON.stringify(candidate))
    const regression = run(['--json'])
    assert.equal(regression.status, 1)
    assert.equal(JSON.parse(regression.stdout).status, 'regression')
    assert.match(run([]).stdout, /rename proxy/)
    for (const args of [['--threshold'], ['--floor-ms', '-1'], ['--threshold', ''], ['--unknown'], ['--json', 'false']]) assert.equal(run(args).status, 2)
    writeFileSync(next, '{}')
    const invalid = run(['--json'])
    assert.equal(invalid.status, 2)
    assert.equal(JSON.parse(invalid.stdout).status, 'invalid')
    assert.equal(readFileSync(base, 'utf8'), JSON.stringify(report()))
    writeFileSync(next, 'not json')
    assert.equal(run([]).status, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
