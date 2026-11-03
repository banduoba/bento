import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpringLoader } from './springFolders.js'

const loader = t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  return createSpringLoader()
}
test('stable repeated hover opens once at 650ms without extending the deadline', t => {
  const spring = loader(t), opened = []
  spring.hover('tab\0/folder', () => true, () => opened.push('/folder'))
  t.mock.timers.tick(400)
  spring.hover('tab\0/folder', () => true, () => opened.push('/folder'))
  t.mock.timers.tick(249); assert.deepEqual(opened, [])
  t.mock.timers.tick(1); assert.deepEqual(opened, ['/folder'])
  spring.hover('tab\0/folder', () => true, () => opened.push('duplicate'))
  t.mock.timers.tick(1000); assert.deepEqual(opened, ['/folder'])
})
test('changing or clearing a target cancels old work; a fresh hover can open again', t => {
  const spring = loader(t), opened = []
  spring.hover('A', () => true, () => opened.push('A'))
  t.mock.timers.tick(500)
  spring.hover('B', () => true, () => opened.push('B'))
  t.mock.timers.tick(200); assert.deepEqual(opened, [])
  spring.cancel(); t.mock.timers.tick(1000); assert.deepEqual(opened, [])
  spring.hover('A', () => true, () => opened.push('A'))
  t.mock.timers.tick(650); assert.deepEqual(opened, ['A'])
})
test('latest validation and callback are used and stale or invalid targets do not open', t => {
  const spring = loader(t), opened = []
  spring.hover('A', () => true, () => opened.push('old'))
  spring.hover('A', () => false, () => opened.push('stale'))
  t.mock.timers.tick(650); assert.deepEqual(opened, [])
  spring.hover(null, () => true, () => opened.push('invalid'))
  t.mock.timers.tick(1000); assert.deepEqual(opened, [])
})
