import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, key } from './test/AppHarness.js'

const paths = ['/home/报告 final.xlsx', '/home/folder.with.dot', '/home/.hidden']
const select = async h => {
  const p = h.panes[0].props, id = p.pane.tabs[0].id
  await h.run(() => {
    p.onRowsCache(id, paths.map(path => ({ path, name: path.split('/').at(-1), is_dir: path.endsWith('.dot') })))
    p.onSelect(id, new Set([...paths].reverse()))
  })
  return id
}
const command = (h, id) => h.run(() => h.events.get('bento-menu-command')({ payload: id }))

test('Copy Names shortcut writes full names in displayed order without publishing file references', async t => {
  const text = [], files = []
  const h = await mountApp(t, { copyFilesToClipboard: async value => { files.push(value); return {} } }, { writeText: async value => text.push(value) })
  await select(h)
  const e = await key(h, 'C', { code: 'KeyC', metaKey: true, shiftKey: true })
  assert.equal(e.defaultPrevented, true)
  assert.deepEqual(text, ['报告 final.xlsx\nfolder.with.dot\n.hidden'])
  assert.deepEqual(files, [])
  assert.equal(h.clipboard.getClip(), null)
})

test('Copy Names context action captures the clicked selection even after it changes', async t => {
  const text = [], h = await mountApp(t, {}, { writeText: async value => text.push(value) })
  const id = await select(h)
  await h.run(() => h.panes[0].props.onMenu(id, { path: paths[1], name: 'folder.with.dot', is_dir: true }, 10, 20))
  const node = h.root.findAll(n => n.props.menu?.kind === 'file')[0]
  const item = node.props.menu.items.find(item => item.label === '复制名称')
  assert.ok(item)
  await h.run(() => { node.props.onClose(); h.panes[0].props.onSelect(id, new Set(['/elsewhere/new'])) })
  await h.run(() => item.action())
  assert.deepEqual(text, ['报告 final.xlsx\nfolder.with.dot\n.hidden'])
})

test('native Copy Names uses focused pane and leaves editors, modals and empty selection alone', async t => {
  const text = [], h = await mountApp(t, {}, { writeText: async value => text.push(value) })
  await command(h, 'edit-copy-names')
  await select(h)
  document.activeElement = { tagName: 'INPUT' }
  await key(h, 'C', { code: 'KeyC', metaKey: true, shiftKey: true })
  await command(h, 'edit-copy-names')
  document.activeElement = null
  await h.run(() => h.root.findByProps({ title: '窗口布局' }).props.onClick())
  await key(h, 'C', { code: 'KeyC', metaKey: true, shiftKey: true })
  await command(h, 'edit-copy-names')
  assert.deepEqual(text, [])
  await h.run(() => h.root.findByProps({ title: '窗口布局' }).props.onClick())
  await command(h, 'edit-copy-names')
  assert.deepEqual(text, ['报告 final.xlsx\nfolder.with.dot\n.hidden'])
  await h.run(() => h.panes[1].props.onFocus(1))
  await command(h, 'edit-copy-names')
  assert.equal(text.length, 1)
})

test('file Copy and external paste still use native file references after name and path copies', async t => {
  const text = [], published = [], transfers = []
  let snapshot = { changeCount: 1, paths: [], ownerToken: null }
  const h = await mountApp(t, {
    copyFilesToClipboard: async value => {
      published.push([...value]); snapshot = { changeCount: snapshot.changeCount + 1, paths: [...value], ownerToken: 'native-owner' }
      return { ok: true, ...snapshot }
    },
    readFileClipboard: async () => snapshot,
    transfer: async (...args) => { transfers.push(args); return [] },
  }, { writeText: async value => { text.push(value); snapshot = { changeCount: snapshot.changeCount + 1, paths: [], ownerToken: null } } })
  await select(h)
  await key(h, 'c', { metaKey: true })
  assert.deepEqual(published, [[...paths].reverse()])
  assert.equal(text.length, 0)
  await key(h, 'C', { code: 'KeyC', metaKey: true, shiftKey: true })
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(transfers, []) // text must not revive the old copied files
  await key(h, 'ç', { code: 'KeyC', metaKey: true, altKey: true })
  assert.deepEqual(text, ['报告 final.xlsx\nfolder.with.dot\n.hidden', paths.join('\n')])
  await key(h, 'c', { metaKey: true })
  assert.equal(published.length, 2)
  await key(h, 'v', { metaKey: true })
  snapshot = { changeCount: 99, paths: ['/wechat/附件.docx'], ownerToken: null }
  await key(h, 'v', { metaKey: true })
  assert.deepEqual(transfers, [[[...paths].reverse(), '/home', 'copy'], [['/wechat/附件.docx'], '/home', 'copy']])
})
