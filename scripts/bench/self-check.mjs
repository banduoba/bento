#!/usr/bin/env node
// 不启动图形界面，检查夹具生成、扫描、删除 3 个文件和手测回填。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const benchDir = fileURLToPath(new URL('.', import.meta.url))
const node = process.execPath

function run(script, args) {
  const res = spawnSync(node, [join(benchDir, script), ...args], { encoding: 'utf8' })
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function main() {
  const dryOut = join(tmpdir(), `bento-bench-dry-${process.pid}`)
  const dry = run('generate-fixture.mjs', ['--count', '100000', '--out', dryOut, '--dry-run'])
  assert(dry.status === 0, `100k dry-run 应成功:\n${dry.stderr}\n${dry.stdout}`)
  assert(dry.stderr.includes('警告'), '100k 应打印磁盘/耗时警告')
  assert(dry.stdout.includes('"count": 100000'), '100k dry-run 应报出 100000')
  assert(!existsSync(dryOut), 'dry-run 不应创建目录')

  const bad = run('generate-fixture.mjs', ['--count', '0'])
  assert(bad.status === 1, 'count 0 应失败')

  const root = mkdtempSync(join(tmpdir(), 'bento-bench-'))
  const fixture = join(root, 'fixture')
  const report = join(root, 'report.json')
  try {
    const gen = run('generate-fixture.mjs', ['--count', '250', '--out', fixture, '--yes'])
    assert(gen.status === 0, `生成失败:\n${gen.stderr}\n${gen.stdout}`)
    const names = readdirSync(fixture).filter((name) => !name.startsWith('.'))
    assert(names.length === 250, `应有 250 个文件，实际 ${names.length}`)
    assert(existsSync(join(fixture, '.bento-bench.json')), '缺少标记文件')
    assert(existsSync(join(fixture, 'f000000.txt')), '缺少 f000000.txt')
    assert(existsSync(join(fixture, 'f000249.txt')), '缺少最后一个文件')

    const again = run('generate-fixture.mjs', ['--count', '250', '--out', fixture])
    assert(again.status === 0, `第二次生成应跳过:\n${again.stderr}`)
    assert(again.stdout.includes('跳过生成'), '已有夹具应跳过')

    const before = readdirSync(fixture).slice().sort().join('\n')
    const measured = run('measure.mjs', ['--fixture', fixture, '--runs', '2', '--warmup', '1', '--out', report])
    assert(measured.status === 0, `测量失败:\n${measured.stderr}\n${measured.stdout}`)
    const after = readdirSync(fixture).slice().sort().join('\n')
    assert(before === after, '删除计时后夹具内容应原样恢复')

    const body = JSON.parse(readFileSync(report, 'utf8'))
    assert(body.schema === 1, 'schema')
    assert(body.fixture.file_count === 250, 'file_count')
    assert(body.headless.scan_node.count === 250, '扫描应忽略点文件标记')
    assert(body.headless.scan_node.scan_ms.median > 0, '扫描中位数')
    assert(body.headless.delete3.ms.median >= 0, '删除中位数')
    assert(body.headless.delete3.files.length === 3, '删除 3 个文件')
    assert(body.gui.cold_open_first_paint_ms == null, '首屏应为手测空值')
    assert(body.gui.new_tab_ms == null, '新标签应为占位空值')
    assert(body.gui.new_tab_status === 'placeholder', '新标签状态')
    assert(existsSync(report.replace(/\.json$/, '.md')), '应同时写出 markdown')

    const plain = join(root, 'not-a-fixture')
    mkdirSync(plain)
    writeFileSync(join(plain, 'a.txt'), 'a')
    writeFileSync(join(plain, 'b.txt'), 'b')
    writeFileSync(join(plain, 'c.txt'), 'c')
    const refused = run('measure.mjs', ['--fixture', plain, '--runs', '1', '--out', join(root, 'nope.json')])
    assert(refused.status === 1, `普通目录不应被拿来做删除计时:\n${refused.stderr}`)
    assert(!existsSync(join(root, 'nope.json')), '拒绝测量时不应写报告')
    assert(existsSync(join(plain, 'a.txt')), '拒绝测量时不应删文件')

    const recorded = run('record.mjs', [
      '--report',
      report,
      '--cold-open-ms',
      '900,840,850',
      '--delete3-ms',
      '12',
      '--new-tab-ms',
      '300,280',
      '--note',
      'self-check',
    ])
    assert(recorded.status === 0, `回填失败:\n${recorded.stderr}\n${recorded.stdout}`)
    const filled = JSON.parse(readFileSync(report, 'utf8'))
    assert(filled.gui.cold_open_first_paint_ms === 850, `首屏中位数应为 850，实际 ${filled.gui.cold_open_first_paint_ms}`)
    assert(filled.gui.delete3_ms === 12, '删除手测值')
    assert(filled.gui.new_tab_ms === 290, `新标签中位数应为 290，实际 ${filled.gui.new_tab_ms}`)
    assert(filled.gui.new_tab_status === 'manual', '填了新标签后不再是占位')
    assert(filled.gui.note === 'self-check', '备注')
    assert(readFileSync(report.replace(/\.json$/, '.md'), 'utf8').includes('850 ms'), 'markdown 应包含手测数字')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  console.log('self-check ok')
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
}
