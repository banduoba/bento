import test from 'node:test'
import assert from 'node:assert/strict'
import { menuPosition, submenuPosition } from './contextMenuPosition.js'

test('root menus clamp both edges and keep oversized scrollable menus at the viewport margin', () => {
  assert.deepEqual(menuPosition(350, 230, 320, 200, 360, 240), { left: 32, top: 32 })
  assert.deepEqual(menuPosition(-100, -20, 200, 100, 360, 240), { left: 8, top: 8 })
  assert.deepEqual(menuPosition(40, 200, 320, 700, 360, 240), { left: 32, top: 8 })
})

test('submenus prefer the available side and stay within a small viewport', () => {
  assert.deepEqual(submenuPosition({ left: 280, right: 335, top: 210 }, 180, 100, 360, 240), { left: 104, top: 132 })
  assert.deepEqual(submenuPosition({ left: 10, right: 55, top: 20 }, 180, 100, 360, 240), { left: 51, top: 16 })
  assert.deepEqual(submenuPosition({ left: 10, right: 55, top: 5 }, 340, 220, 360, 240), { left: 8, top: 8 })
})
