import test from 'node:test'
import assert from 'node:assert/strict'
import { key, mountApp } from './test/AppHarness.js'

test('column working directory routes paste, new folder, duplicate and resets after navigation', async t => {
  const transfers = [], folders = []
  const h = await mountApp(t, {
    transfer: async (...args) => { transfers.push(args); return [] },
    makeDirWithReceipt: async dir => { folders.push(dir); return {} },
    readFileClipboard: async () => ({ changeCount: 1, ownerToken: null, paths: ['/src/item'] }),
  })
  await key(h, '3', { metaKey: true })
  const pane = h.panes[0].props
  const tabId = pane.pane.tabs[0].id
  await h.run(() => pane.onActiveDirectory(tabId, '/home', '/home/A'))
  await key(h, 'v', { metaKey: true })
  assert.equal(transfers[0][1], '/home/A')
  await key(h, 'N', { metaKey: true, shiftKey: true })
  assert.equal(folders[0], '/home/A')
  await h.run(() => h.panes[0].props.onSelect(tabId, new Set(['/home/A'])))
  await key(h, 'd', { metaKey: true })
  assert.equal(transfers[1][1], '/home')
  await h.run(() => h.panes[0].props.onSelect(tabId, new Set(['/home/A/file'])))
  await key(h, 'd', { metaKey: true })
  assert.equal(transfers[2][1], '/home/A')
  await h.run(() => h.panes[0].props.onNav(tabId, '/elsewhere'))
  await h.run(() => pane.onActiveDirectory(tabId, '/home', '/home/A'))
  await key(h, 'N', { metaKey: true, shiftKey: true })
  assert.equal(folders[1], '/elsewhere')
})

test('native blank drop into a child column targets that child directory', async t => {
  const transfers = []
  const h = await mountApp(t, { transfer: async (...args) => { transfers.push(args); return [] } })
  const tabId = h.panes[0].props.pane.tabs[0].id
  const pane = { dataset: { tabId }, closest: selector => selector === '.pane' ? pane : null }
  const column = { dataset: { columnPath: '/home/A' } }
  const hit = { closest: selector => selector.includes('data-column-path') ? column : selector.includes('.panes > .pane') ? pane : null }
  document.elementFromPoint = () => hit
  document.querySelectorAll = () => [pane]
  await h.run(() => h.drop({ type: 'drop', position: { x: 20, y: 20 }, paths: ['/src/file'] }))
  assert.equal(transfers[0]?.[1], '/home/A')
})

test('blank context menu creates in the clicked child column', async t => {
  const folders = []
  const h = await mountApp(t, { makeDirWithReceipt: async dir => { folders.push(dir); return {} } })
  await key(h, '3', { metaKey: true })
  const id = h.panes[0].props.pane.tabs[0].id
  await h.run(() => h.panes[0].props.onBlankMenu(id, 10, 10, '/home/A'))
  await h.run(() => h.root.findByProps({ 'data-label': '新建文件夹' }).props.onClick({ preventDefault() {}, stopPropagation() {} }))
  assert.deepEqual(folders, ['/home/A'])
})

test('new tab inherits the opened child directory in column view', async t => {
  const h = await mountApp(t)
  await key(h, '3', { metaKey: true })
  const pane = h.panes[0].props
  await h.run(() => pane.onActiveDirectory(pane.pane.tabs[0].id, '/home', '/home/A'))
  await key(h, 't', { metaKey: true })
  assert.equal(h.panes[0].props.pane.tabs.at(-1).path, '/home/A')
})

test('Go to Parent collapses the opened column before leaving the tab root', async t => {
  const h = await mountApp(t)
  await key(h, '3', { metaKey: true })
  const pane = h.panes[0].props
  const id = pane.pane.tabs[0].id
  await h.run(() => pane.onActiveDirectory(id, '/home', '/home/A'))
  await h.run(() => h.events.get('bento-menu-command')?.({ payload: 'go-parent' }))
  assert.equal(h.panes[0].props.pane.tabs[0].path, '/home')
  assert.equal(h.panes[0].props.columnNavigate?.target, '/home')
})

test('Backspace collapses the opened column without navigating the tab root', async t => {
  const h = await mountApp(t)
  await key(h, '3', { metaKey: true })
  const pane = h.panes[0].props
  const id = pane.pane.tabs[0].id
  await h.run(() => pane.onActiveDirectory(id, '/home', '/home/A'))
  await key(h, 'Backspace')
  assert.equal(h.panes[0].props.pane.tabs[0].path, '/home')
  assert.equal(h.panes[0].props.columnNavigate?.target, '/home')
})

test('leaving columns clears a selected child that the root view cannot display', async t => {
  const h = await mountApp(t)
  await key(h, '3', { metaKey: true })
  const pane = h.panes[0].props
  const id = pane.pane.tabs[0].id
  await h.run(() => pane.onActiveDirectory(id, '/home', '/home/A'))
  await h.run(() => h.panes[0].props.onSelect(id, new Set(['/home/A/file'])))
  await key(h, '2', { metaKey: true })
  assert.equal(h.panes[0].props.viewMode, 'list')
  assert.equal(h.panes[0].props.selection.size, 0)
})

test('clearing a folder view override also clears a hidden child selection', async t => {
  const h = await mountApp(t)
  await key(h, '3', { metaKey: true })
  const pane = h.panes[0].props
  const id = pane.pane.tabs[0].id
  await h.run(() => pane.onActiveDirectory(id, '/home', '/home/A'))
  await h.run(() => h.panes[0].props.onSelect(id, new Set(['/home/A/file'])))
  await h.run(() => h.panes[0].props.onBlankMenu(id, 0, 0, '/home'))
  await h.run(() => h.root.findByProps({ 'data-label': '此文件夹使用默认视图' }).props.onClick({ preventDefault() {}, stopPropagation() {} }))
  assert.equal(h.panes[0].props.viewMode, 'list')
  assert.equal(h.panes[0].props.selection.size, 0)
})

test('sorting an expanded list keeps its visible nested selection', async t => {
  const h = await mountApp(t)
  const pane = h.panes[0].props
  const id = pane.pane.tabs[0].id
  await h.run(() => pane.onSelect(id, new Set(['/home/A/file'])))
  await h.run(() => h.panes[0].props.onSort(id, 'name', 'desc'))
  assert.deepEqual([...h.panes[0].props.selection], ['/home/A/file'])
})
