import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, deferred, key } from './test/AppHarness.js'

const entry = (name, is_dir = false) => ({ name, path: `/home/nested/${name}`, is_dir })
const menuNode = h => h.root.findAll(n => n.props.menu?.items && typeof n.props.onClose === 'function')[0]
const menu = h => menuNode(h)?.props.menu
const find = (items, label) => items.find(item => item.label === label)
const pick = async (h, item) => h.run(async () => { menuNode(h).props.onClose(); await item.action() })
async function show(h, item, selected = [item.path], rows = [item]) {
  const pane = h.panes[0].props, id = pane.pane.tabs[0].id
  await h.run(() => { pane.onRowsCache(id, rows); pane.onSelect(id, new Set(selected)) })
  await h.run(() => h.panes[0].props.onMenu(id, item, 20, 20))
  return id
}

const apps = { defaultApp: '/Apps/Default.app', apps: [
  { path: '/Apps/Other.app', name: 'Other', bundleId: null, version: null },
  { path: '/Apps/Default.app', name: 'Default', bundleId: null, version: null },
] }

test('Open With lists the native default first and uses the captured complete selection', async t => {
  const gate = deferred(), opened = []
  const a = entry('a.txt'), b = entry('b.txt')
  const h = await mountApp(t, { listOpenWith: () => gate.promise, openWith: async (...args) => opened.push(args) })
  const id = await show(h, b, [b.path, a.path], [a, b])
  await h.run(() => gate.resolve(apps))
  const branch = find(menu(h).items, '打开方式')
  assert.equal(branch.children.filter(item => item.action)[0].label, 'Default（默认）')
  await h.run(() => h.panes[0].props.onSelect(id, new Set(['/elsewhere/new.txt'])))
  await pick(h, find(branch.children, 'Default（默认）'))
  assert.deepEqual(opened, [[[a.path, b.path], '/Apps/Default.app']])
})

test('Info, tracked extraction and Open receive every selected archive, and extraction start errors are visible', async t => {
  const calls = [], a = entry('a.ZIP'), b = entry('b.tar.gz')
  const h = await mountApp(t, {
    listOpenWith: async () => apps,
    showGetInfo: async paths => calls.push(['info', paths]),
    startExtraction: async paths => { calls.push(['extract', paths]); return {id:'done',state:'completed',total:paths.length,processed:paths.length,results:[],elapsedMs:0} },
    openPath: async path => calls.push(['open', path]),
  })
  await show(h, b, [a.path, b.path], [a, b])
  await pick(h, find(menu(h).items, '显示简介'))
  await show(h, b, [a.path, b.path], [a, b])
  await pick(h, find(menu(h).items, '解压缩'))
  await show(h, b, [a.path, b.path], [a, b])
  await pick(h, find(menu(h).items, '打开'))
  assert.deepEqual(calls, [['info', [a.path, b.path]], ['extract', [a.path, b.path]], ['open', a.path], ['open', b.path]])
  h.api.startExtraction = async () => { throw new Error('Extraction unavailable') }
  await show(h, a)
  await pick(h, find(menu(h).items, '解压缩'))
  assert.ok(h.root.findAll(n => n.props.role === 'alert').some(n => n.children.join('').includes('Extraction unavailable')))
  await show(h, entry('unsupported.7z'))
  assert.equal(find(menu(h).items, '解压缩'), undefined)
  await show(h, a, [a.path, entry('notes.txt').path], [a, entry('notes.txt')])
  assert.equal(find(menu(h).items, '解压缩'), undefined)
})

test('Quick Look reuses its navigation gallery and Other application cancellation is quiet', async t => {
  const previews = [], chosen = [], a = entry('a.txt'), b = entry('b.txt')
  const h = await mountApp(t, {
    listOpenWith: async () => apps,
    quickLook: async (...args) => previews.push(args),
    chooseApplicationAndOpen: async paths => { chosen.push(paths); return false },
  })
  await show(h, b, [a.path, b.path], [a, b])
  await pick(h, find(menu(h).items, '快速查看'))
  assert.equal(previews[0][0], b.path)
  assert.deepEqual(previews[0][1], [a.path, b.path])
  await show(h, a)
  await pick(h, find(find(menu(h).items, '打开方式').children, '其他…'))
  assert.deepEqual(chosen, [[a.path]])
  assert.deepEqual(h.alerts, [])
})

test('async app discovery cannot reopen a closed menu or overwrite a replacement for the same file', async t => {
  const requests = [], a = entry('a.txt')
  const h = await mountApp(t, { listOpenWith: () => { const d = deferred(); requests.push(d); return d.promise } })
  await show(h, a)
  await h.run(() => menuNode(h).props.onClose())
  await h.run(() => requests[0].resolve(apps))
  assert.equal(menu(h), undefined)
  await show(h, a)
  await show(h, a)
  await h.run(() => requests[1].resolve(apps))
  assert.ok(!find(menu(h).items, '打开方式').children.some(item => item.label === 'Default（默认）'))
  await h.run(() => requests[2].resolve({ defaultApp: '/Apps/New.app', apps: [{ path: '/Apps/New.app', name: 'New' }] }))
  assert.ok(find(menu(h).items, '打开方式').children.some(item => item.label === 'New（默认）'))
})

test('async templates merge with discovered apps and create in the clicked parent after selection changes', async t => {
  const templates = deferred(), discovered = deferred(), created = []
  const a = entry('a.txt')
  const h = await mountApp(t, { listOpenWith: () => discovered.promise, copyTemplateWithReceipt: async (...args) => { created.push(args); return {} } })
  h.api.listTemplates = () => templates.promise
  const id = await show(h, a)
  await h.run(() => discovered.resolve(apps))
  await h.run(() => templates.resolve([{ name: 'fixture.template', path: '/templates/fixture' }]))
  assert.ok(find(menu(h).items, '打开方式').children.some(item => item.label === 'Default（默认）'))
  await h.run(() => h.panes[0].props.onNav(id, '/elsewhere'))
  await pick(h, find(find(menu(h).items, '新建').children, 'fixture.template'))
  assert.deepEqual(created, [['/home/nested', '/templates/fixture']])
})

test('folder menus group other pane choices and share working creation, View, Sort and Columns controls', async t => {
  const folders = [], a = entry('folder', true)
  const h = await mountApp(t, { makeDirWithReceipt: async path => { folders.push(path); return {} } })
  const id = await show(h, a)
  assert.ok(find(menu(h).items, '在其他窗格打开')?.children.length)
  assert.equal(find(menu(h).items, '打开方式'), undefined)
  await pick(h, find(menu(h).items, '新建文件夹'))
  assert.deepEqual(folders, ['/home/nested'])
  await h.run(() => h.panes[0].props.onNav(id, '/home/nested'))
  await show(h, a)
  await pick(h, find(find(menu(h).items, '显示方式').children, '图标'))
  assert.equal(h.panes[0].props.viewMode, 'icons')
  await show(h, a)
  await pick(h, find(find(menu(h).items, '排序方式').children, '名称'))
  assert.equal(h.panes[0].props.pane.tabs[0].sortKey, 'name')
  await show(h, a)
  await pick(h, find(find(menu(h).items, '显示列').children, '创建日期'))
  assert.equal(h.panes[0].props.cfg.viewSettings.overrides['/home/nested'].columns.visible.btime, true)
})

test('Quick Look native failures reach the user instead of disappearing inside preview navigation', async t => {
  const a = entry('a.txt')
  const h = await mountApp(t, { quickLook: async () => { throw new Error('preview denied') } })
  await show(h, a)
  await pick(h, find(menu(h).items, '快速查看'))
  assert.ok(h.alerts.some(message => message.includes('preview denied')))
})


test('Get Info keyboard shortcut uses the full current selection and respects text/menu focus guards', async t => {
  const infos = [], a = entry('a.txt'), b = entry('b.txt')
  const h = await mountApp(t, { showGetInfo: async paths => infos.push(paths) })
  await show(h, a, [a.path, b.path], [a, b])
  await key(h, 'i', { metaKey: true })
  assert.deepEqual(infos, [])
  await h.run(() => menuNode(h).props.onClose())
  await key(h, 'i', { metaKey: true })
  assert.deepEqual(infos, [[a.path, b.path]])
  document.activeElement = { tagName: 'INPUT' }
  await key(h, 'i', { metaKey: true })
  assert.equal(infos.length, 1)
})

test('application discovery errors stay visible while Other remains available and cannot replace a blank menu', async t => {
  const requests = [], a = entry('a.txt')
  const h = await mountApp(t, { listOpenWith: () => { const d = deferred(); requests.push(d); return d.promise } })
  const id = await show(h, a)
  await h.run(() => requests[0].reject(new Error('applications unavailable')))
  const children = find(menu(h).items, '打开方式').children
  assert.ok(children.some(item => item.disabled && item.label.includes('applications unavailable')))
  assert.ok(find(children, '其他…').action)
  await show(h, a)
  await h.run(() => h.panes[0].props.onBlankMenu(id, 20, 20, '/home'))
  await h.run(() => requests[1].resolve(apps))
  assert.equal(menu(h).kind, 'blank')
  assert.equal(find(menu(h).items, '打开方式'), undefined)
})
