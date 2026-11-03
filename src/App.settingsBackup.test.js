import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, deferred } from './test/AppHarness.js'
const preferences = { showHidden: true, showSidebar: true, sidebarWidth: 300, autoRefresh: false, alwaysOnTop: false, enterAction: 'rename', searchPaths: ['/Imported'], searchPrefs: { scope: 'home', sort: 'name', mode: 'content' }, favorites: [{ name: 'Imported', path: '/Imported' }] }
const text = JSON.stringify({ format: 'bento-preferences', version: 1, preferences })
const settings = h => h.root.findAll(n => typeof n.type === 'function' && n.type.name === 'SettingsDialog')[0].props
test('settings import waits for old writes, then updates preferences while keeping concurrent navigation and views', async t => {
  const old = deferred(), imported = deferred(), writes = []
  const h = await mountApp(t, { loadConfig: async () => ({ zipPrefs: { keepPassword: true, password: 'secret' } }), saveConfig: async value => { writes.push(value); if (writes.length === 1) await old.promise; if (writes.length === 2) await imported.promise } })
  assert.equal(typeof settings(h).onImportSettings, 'function')
  let pending
  await h.run(() => { pending = settings(h).onImportSettings(text) })
  assert.equal(writes.length, 1)
  await h.run(() => old.resolve())
  assert.equal(writes.length, 2)
  assert.equal(h.panes[0].props.cfg.showHidden, false)
  const pane = h.panes[0].props, id = pane.pane.tabs[0].id
  await h.run(() => pane.onNav(id, '/While importing'))
  await h.run(() => h.panes[0].props.onSort(id, 'size', 'desc'))
  const close = h.close(); assert.equal(close.prevented, true)
  await h.run(() => Promise.resolve()); assert.equal(h.closes, 0)
  await h.run(async () => { imported.resolve(); await pending; await close.pending })
  assert.equal(h.closes, 1)
  assert.equal(h.panes[0].props.cfg.showHidden, true)
  assert.equal(h.panes[0].props.pane.tabs[0].path, '/While importing')
  assert.equal(h.writes.session.at(-1).panes[0].tabs[0].path, '/While importing')
  assert.equal(h.writes.views.at(-1).overrides['/While importing'].sort.key, 'size')
  assert.deepEqual(writes.at(-1).searchPaths, ['/Imported'])
  assert.equal(writes.at(-1).zipPrefs.password, 'secret')
  assert.ok(!('panes' in writes.at(-1)))
})
test('invalid or failed imports leave live preferences unchanged and never retry on autosave or close', async t => {
  let failImport = true; const writes = []
  const h = await mountApp(t, { saveConfig: async value => { if (value.searchPaths.includes('/Imported') && failImport) throw Error('disk full'); writes.push(value) } })
  assert.equal(typeof settings(h).onImportSettings, 'function')
  await assert.rejects(settings(h).onImportSettings('{bad'))
  await h.run(async () => { await assert.rejects(settings(h).onImportSettings(text), /disk full/) })
  assert.equal(h.panes[0].props.cfg.showHidden, false)
  assert.deepEqual(h.sidebar.props.favorites.map(f => f.path).includes('/Imported'), false)
  failImport = false
  await h.run(() => h.root.findByProps({ title: '显示隐藏文件 (⇧⌘.)' }).props.onClick())
  const close = h.close(); await h.run(() => close.pending)
  assert.equal(h.closes, 1)
  assert.equal(writes.at(-1).showHidden, true)
  assert.deepEqual(writes.at(-1).searchPaths, [])
  assert.ok(writes.every(value => !value.searchPaths.includes('/Imported')))
})
test('batched edits immediately after import resume autosave for search paths and other preferences', async t => {
  const gate = deferred(), writes = []
  const h = await mountApp(t, { saveConfig: async value => { writes.push(value); if (value.searchPaths.includes('/Imported')) await gate.promise } })
  let pending
  await h.run(() => { pending = settings(h).onImportSettings(text) })
  await h.run(async () => {
    gate.resolve(); await pending
    settings(h).onChange(['/After import'])
    settings(h).onShowHiddenChange(false)
  })
  const close = h.close(); await h.run(() => close.pending)
  assert.deepEqual(writes.at(-1).searchPaths, ['/After import'])
  assert.equal(writes.at(-1).showHidden, false)
  assert.equal(writes.at(-1).enterAction, 'rename')
  assert.equal(h.closes, 1)
})
test('importing auto refresh from disabled to enabled reconciles visible directories once after a successful save', async t => {
  const h = await mountApp(t, { loadConfig: async () => ({ autoRefresh: false }) })
  const enabled = JSON.stringify({ format: 'bento-preferences', version: 1, preferences: { ...preferences, autoRefresh: true } })
  const before = h.panes.map(p => p.props.tick)
  await h.run(() => settings(h).onImportSettings(enabled))
  const after = h.panes.map(p => p.props.tick)
  assert.ok(after.every((tick, i) => tick !== before[i]))
  assert.equal(h.panes[0].props.cfg.autoRefresh, true)
  await h.run(() => settings(h).onImportSettings(enabled))
  assert.deepEqual(h.panes.map(p => p.props.tick), after)
})
test('close saves unrelated archive preferences changed during import before native destruction', async t => {
  const gate = deferred(), writes = []
  const h = await mountApp(t, {
    saveConfig: async value => { writes.push(value); if (value.searchPaths.includes('/Imported')) await gate.promise },
    startCompression: async () => ({id:'zip',operation:'compress',state:'completed',total:1,processed:1,results:[],elapsedMs:0}),
  })
  const component = name => h.root.findAll(n => typeof n.type === 'function' && n.type.name === name)[0]
  let imported
  await h.run(() => { imported = settings(h).onImportSettings(text) })
  await h.run(() => h.panes[0].props.onMenu(h.panes[0].props.pane.tabs[0].id, { path: '/home/file', name: 'file', is_dir: false }, 1, 1))
  await h.run(() => component('ContextMenu').props.menu.items.find(item => item?.label?.startsWith('压缩')).action())
  const zipPrefs = { mode: 'fast', level: 6, oneClick: true, separate: false, keepPassword: true, password: 'new-secret' }
  await h.run(() => component('ZipDialog').props.onSubmit({ dir: '/home', name: 'a.zip' }, zipPrefs))
  const win = globalThis.__bentoAppTestBridge.win
  const destroy = win.destroy
  let atDestroy
  win.destroy = async () => { atDestroy = structuredClone(writes.at(-1)); await destroy() }
  await h.run(async () => {
    const close = h.close()
    gate.resolve(); await imported; await close.pending
    assert.equal(h.destroyed, 1)
    assert.deepEqual(atDestroy.zipPrefs, zipPrefs)
    assert.deepEqual(atDestroy.searchPaths, ['/Imported'])
  })
})
