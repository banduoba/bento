import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, key } from './test/AppHarness.js'

test('native View menu and keyboard use one folder mode path without changing pane layout', async t => {
  const h = await mountApp(t)
  const count = h.panes.length
  await h.run(() => h.events.get('bento-menu-command')?.({ payload: 'view-icons' }))
  assert.equal(h.panes[0].props.viewMode, 'icons')
  assert.equal(h.panes.length, count)
  await key(h, '2', { metaKey: true })
  assert.equal(h.panes[0].props.viewMode, 'list')
  assert.equal(h.panes.length, count)
  await h.run(() => h.panes[1].props.onNav(h.panes[1].props.pane.tabs[0].id, '/other'))
  await h.run(() => h.panes[1].props.onFocus(1))
  await key(h, '3', { metaKey: true })
  assert.equal(h.panes[0].props.viewMode, 'list')
  assert.equal(h.panes[1].props.viewMode, 'columns')
})

test('native file menu respects focused text and modal guards', async t => {
  const h = await mountApp(t)
  const pane = h.panes[0].props
  const id = pane.pane.tabs[0].id
  await h.run(() => pane.onSelect(id, new Set(['/home/item'])) )
  let duplicate = 0
  h.api.transfer = async () => { duplicate++; return [] }
  document.activeElement = { tagName: 'INPUT', value: 'selected', selectionStart: 0, selectionEnd: 8 }
  await h.run(() => h.events.get('bento-menu-command')?.({ payload: 'file-duplicate' }))
  assert.equal(duplicate, 0)
  document.activeElement = null
  await h.run(() => h.root.findByProps({ title: '窗口布局' }).props.onClick())
  await h.run(() => h.events.get('bento-menu-command')?.({ payload: 'file-duplicate' }))
  assert.equal(duplicate, 0)
  await h.run(() => h.root.findByProps({ title: '窗口布局' }).props.onClick())
  await h.run(() => h.events.get('bento-menu-command')?.({ payload: 'file-duplicate' }))
  assert.equal(duplicate, 1)
})

test('native Undo item follows the guarded file inverse stack', async t => {
  const identity = { dev: '12', ino: '34' }
  const h = await mountApp(t, {
    transfer: async () => [{ source: '/src/a', dest: '/home/a', ok: true, identity }],
    trash: async paths => ({ entries: [{ original: paths[0], trashed: '/Trash/a', identity }], error: null, cancelled: false }),
  })
  const state = () => h.invocations.filter(([name]) => name === 'sync_menu_state').at(-1)?.[1]
  assert.equal(state().canUndo, false)
  await h.run(() => h.panes[0].props.onDropTransfer('/home', ['/src/a'], 'copy'))
  assert.equal(state().canUndo, true)
  await h.run(() => h.events.get('bento-menu-command')?.({ payload: 'edit-undo' }))
  assert.equal(state().canUndo, false)
})

test('native Undo remains available for focused text history without a file inverse', async t => {
  const h = await mountApp(t)
  const state = () => h.invocations.filter(([name]) => name === 'sync_menu_state').at(-1)?.[1]
  assert.equal(state().canUndo, false)
  document.activeElement = { tagName: 'INPUT' }
  await h.run(() => window.dispatchEvent(new Event('focusin')))
  assert.equal(state().canUndo, true)
  document.activeElement = null
  await h.run(() => window.dispatchEvent(new Event('focusout')))
  assert.equal(state().canUndo, false)
})
