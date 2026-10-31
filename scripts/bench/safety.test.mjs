import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PAYLOAD } from './lib.mjs'

const marker = { generator: 'bento-bench', schema: 1, status: 'partial', count: 2, file_bytes: 32, name_width: 6, started_at: '2026-11-01T00:00:00.000Z' }
const run = (out, ...args) => spawnSync(process.execPath, ['scripts/bench/generate-fixture.mjs', '--count', '2', '--out', out, '--yes', ...args], { encoding: 'utf8' })
for (const [name, body] of [['missing', null], ['bad JSON', '{broken'], ['wrong generator', JSON.stringify({ ...marker, generator: 'other' })], ['missing fields', '{"generator":"bento-bench"}'], ['forged schema', JSON.stringify({ ...marker, schema: 99 })], ['valid marker with foreign content', JSON.stringify(marker)]]) {
  for (const force of [false, true]) test(`generator preserves ${name}, force=${force}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'bento-bench-safety-'))
    try {
      const out = join(root, 'ordinary'); mkdirSync(out)
      writeFileSync(join(out, 'important.txt'), 'preserve me')
      if (body) writeFileSync(join(out, '.bento-bench.json'), body)
      assert.notEqual(run(out, ...(force ? ['--force'] : [])).status, 0)
      assert.equal(readFileSync(join(out, 'important.txt'), 'utf8'), 'preserve me')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
test('verified partial fixture rebuilds and complete fixture reuses or rebuilds', () => {
  const root = mkdtempSync(join(tmpdir(), 'bento-bench-safety-'))
  try {
    const out = join(root, 'partial'); mkdirSync(out)
    writeFileSync(join(out, '.bento-bench.json'), JSON.stringify(marker))
    writeFileSync(join(out, 'f000000.txt'), PAYLOAD)
    assert.equal(run(out).status, 0)
    assert.match(run(out).stdout, /跳过生成/)
    assert.equal(run(out, '--force').status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('fixture directory symlink never authorizes cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'bento-bench-safety-'))
  try {
    const out = join(root, 'real'); mkdirSync(out)
    writeFileSync(join(out, '.bento-bench.json'), JSON.stringify(marker))
    writeFileSync(join(out, 'f000000.txt'), PAYLOAD)
    symlinkSync(out, join(root, 'link'))
    assert.notEqual(run(join(root, 'link'), '--force').status, 0)
    assert.equal(readFileSync(join(out, 'f000000.txt')).equals(PAYLOAD), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
