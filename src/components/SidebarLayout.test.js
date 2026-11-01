import test from 'node:test'
import assert from 'node:assert/strict'
import { mountLayout } from '../test/SidebarLayoutHarness.js'

test('drag previews locally without commit or child render, then commits changed width once', async t => {
  const h = await mountLayout(t)
  assert.equal(h.separator.props['aria-label'], '调整侧边栏宽度')
  assert.equal(h.separator.props['aria-orientation'], 'vertical'); assert.equal(h.separator.props.tabIndex, 0)
  assert.equal(h.separator.props['aria-valuemin'], 180); assert.equal(h.separator.props['aria-valuemax'], 520)
  await h.send('onPointerDown', { button: 2 }); assert.equal(h.captured, null)
  await h.send('onPointerDown'); assert.equal(h.captured, 7); assert.equal(h.focused, true)
  await h.send('onPointerMove', { pointerId: 8, clientX: 400 }); assert.equal(h.value, 260)
  await h.send('onPointerMove', { clientX: 403 }); assert.equal(h.value, 403)
  assert.deepEqual(h.commits, []); assert.equal(h.renders, 1); assert.equal(h.mounts, 1); assert.equal(h.unmounts, 0)
  await h.send('onPointerMove', { clientX: 900 }); assert.equal(h.value, 520)
  await h.send('onPointerUp'); await h.send('onLostPointerCapture'); await h.send('onPointerUp')
  assert.deepEqual(h.commits, [520]); assert.equal(h.captured, null)
})
test('no-op drag does not overwrite a viewport-constrained saved preference', async t => {
  const h = await mountLayout(t, 500, 800)
  assert.equal(h.value, 380)
  await h.send('onPointerDown', { clientX: 380 }); await h.send('onPointerUp')
  assert.deepEqual(h.commits, []); await h.resize(1200); assert.equal(h.value, 500)
})
test('cancel, Escape, lost capture and window blur restore width without saving; unmount releases resources', async t => {
  const h = await mountLayout(t)
  for (const end of ['onPointerCancel', 'escape', 'onLostPointerCapture', 'blur']) {
    await h.send('onPointerDown'); await h.send('onPointerMove', { clientX: 400 }); assert.equal(h.value, 400)
    if (end === 'escape') await h.send('onKeyDown', { key: 'Escape' })
    else if (end === 'blur') await h.emit('blur')
    else await h.send(end)
    assert.equal(h.value, 260); assert.equal(h.captured, null); assert.deepEqual(h.commits, [])
  }
  await h.send('onPointerDown'); await h.send('onPointerMove', { clientX: 400 }); await h.unmount()
  assert.equal(h.captured, null); assert.deepEqual(h.commits, []); assert.equal(h.unmounts, 1)
  assert.ok([...h.listeners.values()].every(set => set.size === 0))
})
test('viewport shrink/restore leaves preferred width intact and safely cancels active drag', async t => {
  const h = await mountLayout(t, 500)
  await h.resize(800); assert.equal(h.value, 380); assert.equal(h.separator.props['aria-valuemax'], 380)
  await h.resize(400); assert.equal(h.value, 180); assert.equal(h.separator.props['aria-valuemax'], 180)
  await h.resize(1200); assert.equal(h.value, 500); assert.deepEqual(h.commits, [])
  await h.send('onPointerDown', { clientX: 500 }); await h.send('onPointerMove', { clientX: 450 })
  await h.resize(800); assert.equal(h.value, 380); assert.equal(h.captured, null)
  await h.resize(1200); assert.equal(h.value, 500); assert.deepEqual(h.commits, [])
})
test('keyboard adjusts effective bounds once per action and isolates file keys while preserving modified shortcuts', async t => {
  const h = await mountLayout(t)
  for (const [key, shiftKey, expected] of [['ArrowRight', false, 268], ['ArrowLeft', true, 236], ['End', false, 520], ['Home', false, 180]]) {
    const before = h.commits.length, e = await h.send('onKeyDown', { key, shiftKey })
    assert.equal(e.stopped, true); assert.equal(e.prevented, true); assert.equal(h.commits.length, before + 1); assert.equal(h.commits.at(-1), expected)
    await h.update(expected)
  }
  await h.send('onKeyDown', { key: 'ArrowLeft' }); assert.equal(h.commits.length, 4)
  for (const key of ['Enter', ' ', 'Tab']) {
    const e = await h.send('onKeyDown', { key }); assert.equal(e.stopped, true)
    if (key === 'Tab') assert.equal(e.prevented, undefined)
  }
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) {
    const e = await h.send('onKeyDown', { key: 'ArrowRight', [modifier]: true }); assert.equal(e.stopped, undefined); assert.equal(e.prevented, undefined)
  }
  assert.equal(h.commits.length, 4)
  await h.send('onDoubleClick'); assert.deepEqual(h.commits, [268, 236, 520, 180, 220])
})
test('narrow viewport keyboard bounds and double-click reset use distinct display and saved widths', async t => {
  const h = await mountLayout(t, 500, 620)
  await h.send('onKeyDown', { key: 'End' }); assert.deepEqual(h.commits, [])
  await h.send('onDoubleClick'); assert.deepEqual(h.commits, [220])
  await h.update(220); assert.equal(h.value, 200)
  await h.resize(1200); assert.equal(h.value, 220)
})
