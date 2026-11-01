import test from 'node:test'
import assert from 'node:assert/strict'
import { mountSidebar, event, createAppShortcutBoundary } from '../test/SidebarHarness.js'
const e = (name, path = `/home/${name}`, is_symlink = false) => ({ name, path, is_symlink })
test('initial collapse, disclosure and text navigation isolate mouse/keyboard while root callbacks survive', async t => {
  const h = await mountSidebar(t); assert.equal(h.requests.length, 0)
  const arrow = h.disclosure('展开 主目录'); assert.ok(arrow, 'home has accessible disclosure')
  const mouse = event(); await h.run(() => arrow.props.onMouseDown(mouse)); assert.equal(mouse.stopped, true); assert.deepEqual(h.opens, [])
  await h.run(() => arrow.props.onClick(event())); assert.equal(h.disclosure('收起 主目录').props['aria-expanded'], true)
  assert.deepEqual(h.requests[0].args, ['/home', false]); assert.deepEqual(h.opens, [])
  await h.run(() => h.row('/home').props.onMouseDown(event())); assert.deepEqual(h.opens, ['/home'])
  for (const key of ['Enter', ' ']) { const keyEvent = event({ key }); await h.run(() => h.row('/home').props.onKeyDown(keyEvent)); assert.equal(keyEvent.stopped, true); assert.equal(keyEvent.prevented, true) }
  const arrowKey = event({ key: 'Enter' }); await h.run(() => h.disclosure('收起 主目录').props.onKeyDown(arrowKey)); assert.equal(arrowKey.stopped, true)
  assert.equal(h.opens.length, 3)
  await h.run(() => h.row('/docs').props.onContextMenu(event({ clientX: 4, clientY: 5 }))); assert.deepEqual(h.menus[0], [4, 5, 'docs', '/docs', true])
  const drop = event(); await h.run(() => h.row('/docs').props.onDrop(drop)); assert.equal(h.drops[0], drop)
  const ws = h.root.find(n => n.type === 'div' && n.props.className?.includes('ws-item'))
  await h.run(() => ws.props.onMouseDown(event())); assert.deepEqual(h.switched, ['w'])
  await h.run(() => ws.props.onContextMenu(event({ clientX: 1, clientY: 2 }))); assert.deepEqual(h.workspaceMenus[0], [1, 2, 'w', 'Workspace'])
  assert.ok(h.disclosure('展开 FixtureVolume'))
})
test('nested folders load only on arrows, symlinks stay navigable leaves and child icons request no native IO', async t => {
  const h = await mountSidebar(t); await h.run(() => h.disclosure('展开 主目录').props.onClick(event()))
  assert.match(h.text(), /加载/); await h.resolve(0, [e('child'), e('linked', '/home/linked', true)])
  assert.ok(h.disclosure('展开 child')); assert.equal(h.disclosure('展开 linked'), undefined)
  await h.run(() => h.row('/home/linked').props.onMouseDown(event())); assert.deepEqual(h.opens, ['/home/linked'])
  assert.ok(h.icons.flat().every(p => !p.includes('/home/')))
  await h.run(() => h.disclosure('展开 child').props.onClick(event())); assert.deepEqual(h.requests[1].args, ['/home/child', false])
  await h.run(() => h.disclosure('收起 主目录').props.onClick(event())); assert.equal(h.watches.size, 0)
  await h.resolve(1, [e('late', '/home/child/late')]); assert.ok(!h.text().includes('late'))
})
test('failed branches retry with name/reason and truncation opens full folder; ticks do not reload tree', async t => {
  const h = await mountSidebar(t); await h.run(() => h.disclosure('展开 主目录').props.onClick(event())); await h.reject(0, 'permission denied')
  assert.match(h.text(), /主目录/); assert.match(h.text(), /permission denied/)
  const retry = h.root.findAllByType('button').find(b => b.children.join('') === '重试'); await h.run(() => retry.props.onClick(event()))
  await h.resolve(1, [], true)
  const full = h.root.findAllByType('button').find(b => b.children.join('') === '在文件夹中查看全部'); await h.run(() => full.props.onClick(event()))
  assert.deepEqual(h.opens, ['/home']); await h.update({ tick: 2 }); assert.equal(h.requests.length, 2)
  await h.update({ showHidden: true }); assert.deepEqual(h.requests[2].args, ['/home', true])
  await h.resolve(2); await h.update({ autoRefresh: false }); assert.equal(h.watches.size, 0)
  await h.emit(['/home']); assert.equal(h.requests.length, 3)
  await h.update({ autoRefresh: true }); assert.equal(h.requests.length, 4)
  await h.unmount(); assert.equal(h.watches.size, 0); await h.resolve(3, [e('late')])
})

test('expanded branch budget shows direct navigation and workspace rename keeps edit keys local', async t => {
  const favorites = Array.from({ length: 64 }, (_, n) => ({ name: `d${n}`, path: `/d${n}` }))
  const h = await mountSidebar(t, { favorites, wsRenaming: { id: 'w', value: 'Renaming' }, onWsRenameChange() {}, onWsRenameCommit() {}, onWsRenameCancel() {} })
  await h.run(() => h.disclosure('展开 主目录').props.onClick(event()))
  for (let n = 0; n < 63; n++) await h.run(() => h.disclosure(`展开 d${n}`).props.onClick(event()))
  await h.run(() => h.disclosure('展开 d63').props.onClick(event()))
  assert.match(h.text(), /64 个文件夹/); assert.equal(h.requests.length, 2)
  const full = h.root.findAllByType('button').find(b => b.children.join('') === '在文件夹中查看全部')
  await h.run(() => full.props.onClick(event())); assert.deepEqual(h.opens, ['/d63'])
  const input = h.root.findByType('input'), key = event({ key: 'Enter' })
  await h.run(() => input.props.onKeyDown(key)); assert.equal(key.stopped, true)
  await h.run(() => h.disclosure('收起 主目录').props.onClick(event()))
  await h.run(() => h.disclosure('展开 d63').props.onClick(event())); assert.ok(h.disclosure('收起 d63'))
})


test('real App boundary would rename/preview a selected file when Enter/Space is unguarded', () => {
  const app = createAppShortcutBoundary()
  for (const key of ['Enter', ' ']) {
    const event = new Event('keydown', { cancelable: true })
    Object.defineProperty(event, 'key', { value: key })
    app.handle(event)
    assert.equal(event.defaultPrevented, true)
  }
  assert.deepEqual(app.actions, [
    ['rename', 'pane-tab', '/pane/selected.txt', 'selected.txt'],
    ['preview', 'pane-tab', '/pane', '/pane/selected.txt', ['/pane/selected.txt']],
  ])
})

test('Retry Enter/Space stays ahead of App file shortcuts and preserves button default activation', async t => {
  const h = await mountSidebar(t), app = createAppShortcutBoundary()
  await h.run(() => h.disclosure('展开 主目录').props.onClick(event()))
  await h.reject(0, 'denied')
  for (const [i, key] of ['Enter', ' '].entries()) {
    const button = h.root.findAllByType('button').find(b => b.children.join('') === '重试')
    const keydown = await h.buttonKey(button, key, app)
    assert.equal(keydown.defaultPrevented, false, 'native activation remains available')
    assert.deepEqual(app.actions, [], 'underlying pane file was not renamed or previewed')
    assert.equal(h.requests.length, i + 2, 'uncancelled activation retries this branch')
    await h.reject(i + 1, 'denied')
  }
})

test('truncated full-folder Enter/Space opens the folder without reaching App selected-file actions', async t => {
  const h = await mountSidebar(t), app = createAppShortcutBoundary()
  await h.run(() => h.disclosure('展开 主目录').props.onClick(event())); await h.resolve(0, [], true)
  for (const key of ['Enter', ' ']) {
    const button = h.root.findAllByType('button').find(b => b.children.join('') === '在文件夹中查看全部')
    assert.equal((await h.buttonKey(button, key, app)).defaultPrevented, false)
    assert.deepEqual(app.actions, [])
  }
  assert.deepEqual(h.opens, ['/home', '/home'])
})

test('open-limit full-folder Enter/Space opens the limited folder without invoking App file actions', async t => {
  const favorites = Array.from({ length: 64 }, (_, n) => ({ name: `d${n}`, path: `/d${n}` }))
  const h = await mountSidebar(t, { favorites }), app = createAppShortcutBoundary()
  await h.run(() => h.disclosure('展开 主目录').props.onClick(event()))
  for (let n = 0; n < 64; n++) await h.run(() => h.disclosure(`展开 d${n}`).props.onClick(event()))
  for (const key of ['Enter', ' ']) {
    const button = h.root.findAllByType('button').find(b => b.children.join('') === '在文件夹中查看全部')
    assert.equal((await h.buttonKey(button, key, app)).defaultPrevented, false)
    assert.deepEqual(app.actions, [])
  }
  assert.deepEqual(h.opens, ['/d63', '/d63'])
})
