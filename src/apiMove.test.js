import test from 'node:test'
import assert from 'node:assert/strict'
import { api } from './api.js'

test('browser API restores an exact filename and reports conflicts/missing sources per item', async () => {
  const source = '/Users/demo/notes.txt'
  const moved = await api.moveItems([source], '/Users/demo/Downloads')
  assert.equal(moved[0].ok, true)
  const restored = await api.restoreMoves([{ source: moved[0].dest, dest: source }])
  assert.equal(restored[0].dest, source)
  assert.equal(restored[0].ok, true)
  const blocked = await api.restoreMoves([{ source, dest: '/Users/demo/README.md' }, { source: '/missing', dest: '/missing-destination' }])
  assert.deepEqual(blocked.map(r => r.ok), [false, false])
  assert.equal((await api.listDir('/Users/demo', true)).entries.some(e => e.path === source), true)
})
