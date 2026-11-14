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

test('color labels apply to the captured selection without using the file clipboard', async t => {
  const calls = [], a = entry('a.txt'), b = entry('folder', true)
  const h = await mountApp(t, {
    getFileLabels: async paths => paths.map(path => ({ path, color: 6 })),
    setFileLabel: async (paths, color) => { calls.push([paths, color]); return paths.map(path => ({ path, color })) },
    copyFilesToClipboard: async () => { throw new Error('Color labels must not write the file clipboard') },
  })
  const id = await show(h, b, [b.path, a.path], [a, b])
  const palette = menu(h).items.find(item => item.colors)
  assert.ok(palette, 'the file context menu includes a color palette')
  assert.equal(h.root.findAll(node => node.props.role === 'menuitemcheckbox').length, 7)
  assert.equal(palette.colors.find(item => item.value === 6).checked, true)
  assert.equal(find(menu(h).items, '显示简介').shortcut, '⌘I')
  await h.run(() => h.panes[0].props.onSelect(id, new Set(['/different/selection'])))
  await pick(h, palette.colors.find(item => item.value === 4))
  assert.deepEqual(calls, [[[a.path, b.path], 4]])
  await show(h, a)
  await pick(h, menu(h).items.find(item => item.colors).colors.find(item => item.value === 0))
  assert.deepEqual(calls.at(-1), [[a.path], 0])
  assert.deepEqual(h.alerts, [])
})

for (const { name, initial, checked, expected } of [
  { name: 'single tagged file clears', initial: [6], checked: true, expected: 0 },
  { name: 'uniform file and folder selection clears', initial: [6, 6], checked: true, expected: 0 },
  { name: 'mixed file and folder selection becomes uniform', initial: [6, 4], checked: 'mixed', expected: 6 },
]) {
  test(`clicking the red swatch: ${name}`, async t => {
    const rows = [entry('a.txt'), entry('folder', true)].slice(0, initial.length)
    const colors = new Map(rows.map((row, i) => [row.path, initial[i]])), writes = []
    const h = await mountApp(t, {
      getFileLabels: async paths => paths.map(path => ({ path, color: colors.get(path) })),
      setFileLabel: async (paths, color) => {
        writes.push([paths, color]); paths.forEach(path => colors.set(path, color))
        return paths.map(path => ({ path, color }))
      },
    })
    const paths = rows.map(row => row.path)
    const id = await show(h, rows[0], paths, rows)
    const red = () => h.root.find(n => n.type === 'button' && n.props['aria-label'] === '红色')
    assert.equal(red().props['aria-checked'], checked)
    await h.run(() => h.panes[0].props.onSelect(id, new Set(['/different/selection'])))
    await h.run(() => red().props.onClick())
    assert.deepEqual(writes, [[paths, expected]])
    assert.equal(menu(h), undefined)
    await show(h, rows[0], paths, rows)
    assert.equal(red().props['aria-checked'], expected === 6)
  })
}

test('partial label failures remain visible and late metadata cannot reopen a closed menu', async t => {
  const gate = deferred(), a = entry('a.txt'), b = entry('b.txt')
  const h = await mountApp(t, {
    getFileLabels: () => gate.promise,
    setFileLabel: async () => [{ path: a.path, color: 2 }, { path: b.path, error: 'Read-only volume' }],
  })
  await show(h, a, [a.path, b.path], [a, b])
  const palette = menu(h).items.find(item => item.colors)
  assert.ok(palette)
  await pick(h, palette.colors.find(item => item.value === 2))
  assert.ok(h.alerts.some(message => message.includes('Read-only volume')))
  await h.run(() => gate.resolve([{ path: a.path, color: 6 }]))
  assert.equal(menu(h), undefined)
})

test('closing and replacing a large-selection menu stops old batches and keeps only one metadata read active', async t => {
  const requests = []
  const rows = Array.from({ length: 300 }, (_, i) => entry(`${i}.txt`))
  const h = await mountApp(t, { getFileLabels: paths => { const request = { ...deferred(), paths }; requests.push(request); return request.promise } })
  await show(h, rows[0], rows.map(item => item.path), rows)
  assert.equal(requests[0].paths.length, 128)
  await h.run(() => menuNode(h).props.onClose())
  await h.run(() => requests[0].resolve(requests[0].paths.map(path => ({ path, color: 6 }))))
  assert.equal(requests.length, 1)
  await show(h, rows[0], rows.map(item => item.path), rows)
  await show(h, rows[1])
  await show(h, rows[2])
  assert.equal(requests.length, 2)
  await h.run(() => requests[1].resolve(requests[1].paths.map(path => ({ path, color: 6 }))))
  assert.deepEqual(requests[2].paths, [rows[2].path])
  await h.run(() => requests[2].resolve([{ path: rows[2].path, color: 4 }]))
  assert.equal(menu(h).items.find(item => item.colors).colors.find(item => item.value === 4).checked, true)
})

test('a reopened menu receives successful color writes that started before it opened', async t => {
  let color = 6
  const gate = deferred(), a = entry('a.txt')
  const h = await mountApp(t, {
    getFileLabels: async paths => paths.map(path => ({ path, color })),
    setFileLabel: async paths => { await gate.promise; color = 4; return paths.map(path => ({ path, color })) },
  })
  await show(h, a)
  const blue = menu(h).items.find(item => item.colors).colors.find(item => item.value === 4)
  let operation
  await h.run(() => { menuNode(h).props.onClose(); operation = blue.action() })
  await show(h, a)
  assert.equal(menu(h).items.find(item => item.colors).colors.find(item => item.value === 6).checked, true)
  await h.run(async () => { gate.resolve(); await operation })
  assert.equal(menu(h).items.find(item => item.colors).colors.find(item => item.value === 4).checked, true)
})
