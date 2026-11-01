import test from 'node:test'
import assert from 'node:assert/strict'
import { createTextEditing } from '../textEditing.js'
import { mountBatch, item } from '../test/BatchRenameHarness.js'

test('literal replace defaults off, replaces every literal occurrence and keeps original apply contract', async t => {
  const h = await mountBatch(t, [item('a.a.txt'), item('keep.md')])
  const box = h.inputs().find(n => n.props.type === 'checkbox')
  assert.equal(box?.props.checked, false)
  await h.change(0, '.'); await h.change(1, '_')
  assert.equal(h.requests.length, 0)
  await h.click('重命名')
  assert.deepEqual(h.applied, [[{ ...item('a.a.txt'), newBase: 'a_a', newName: 'a_a.txt' }]])
})

test('regex waits, sends stems/full directory names, attaches file extensions and applies changed rows', async t => {
  const h = await mountBatch(t, [item('sample_1.txt'), item('sample_2.dir', true), item('keep.md')])
  await h.change(0, '^sample_(\\d+)'); await h.change(1, 'case_$1'); await h.regex()
  assert.deepEqual(h.requests.at(-1).args, [['sample_1', 'sample_2.dir', 'keep'], '^sample_(\\d+)', 'case_$1'])
  assert.equal(h.button('重命名').props.disabled, true)
  await h.enter(); await h.click('重命名'); assert.equal(h.applied.length, 0)
  await h.resolve(h.requests.length - 1, ['case_1', 'case_2.dir', 'keep'])
  assert.ok(h.text().includes('case_1.txt')); assert.ok(h.text().includes('case_2.dir'))
  await h.click('重命名')
  assert.deepEqual(h.applied[0].map(r => [r.path, r.newName]), [['/fixture/sample_1.txt', 'case_1.txt'], ['/fixture/sample_2.dir', 'case_2.dir']])
})

test('late responses/errors cannot replace newest preview or leak across modes/items/unmount', async t => {
  const h = await mountBatch(t)
  await h.change(0, 'sample'); await h.regex(); await h.change(1, 'new')
  await h.resolve(1, ['new_1', 'new_2']); await h.reject(0, 'stale error')
  assert.ok(h.text().includes('new_1.txt')); assert.ok(!h.text().includes('stale error'))
  await h.change(1, 'latest'); assert.equal(h.button('重命名').props.disabled, true)
  await h.regex(false); await h.resolve(2, ['stale', 'stale'])
  assert.ok(h.text().includes('latest_1.txt')); assert.ok(!h.text().includes('stale.txt'))
  await h.regex(); const n = h.requests.length - 1
  await h.update({ items: [item('other.txt')] }); await h.resolve(n, ['old', 'old'])
  assert.equal(h.button('重命名').props.disabled, true)
  await h.click('转换大小写'); await h.resolve(h.requests.length - 1, ['wrong'])
  assert.ok(h.text().includes('OTHER.txt')); assert.equal(h.button('重命名').props.disabled, false)
  await h.click('替换文本'); const pending = h.requests.length - 1
  await h.unmount(); await h.resolve(pending, ['gone'])
})

test('regex errors and malformed response fail closed and remain visible', async t => {
  const h = await mountBatch(t)
  await h.change(0, '['); await h.regex(); await h.reject(0, '正则表达式无效')
  assert.ok(h.text().includes('正则表达式无效')); assert.equal(h.button('重命名').props.disabled, true)
  await h.enter(); assert.equal(h.applied.length, 0)
  for (const malformed of [[], ['one', 2], Array(2), null, 'name']) {
    await h.change(1, String(h.requests.length)); await h.resolve(h.requests.length - 1, malformed)
    assert.ok(h.text().includes('预览结果无效')); assert.equal(h.button('重命名').props.disabled, true)
  }
})

test('duplicate/invalid names are red and cannot be submitted, including dotfiles and directory dots', async t => {
  const h = await mountBatch(t, [item('.hidden'), item('folder.ext', true)])
  await h.change(0, '.*'); await h.regex()
  assert.deepEqual(h.requests[0].args[0], ['.hidden', 'folder.ext'])
  for (const names of [['same', 'SAME'], ['', 'fine'], ['/', 'fine'], ['nul\0', 'fine'], ['.', 'fine'], ['..', 'fine'], ['  ', 'fine']]) {
    if (h.requests.length > 1 || names[0] !== 'same') await h.change(1, String(h.requests.length))
    await h.resolve(h.requests.length - 1, names)
    assert.equal(h.button('重命名').props.disabled, true)
    assert.ok(h.root.findAll(n => typeof n.props.className === 'string' && n.props.className.includes('invalid')).length > 0)
    await h.enter(); assert.equal(h.applied.length, 0)
  }
})

test('existing add/date, number/date and case controls remain usable without regex IPC', async t => {
  const h = await mountBatch(t, [item('sample_1.txt')])
  await h.click('添加文本'); await h.change(0, 'pre_')
  await h.regex(); assert.ok(h.text().includes('20240102_pre_sample_1.txt'))
  await h.click('格式化名称'); assert.ok(h.text().includes('文件01_20240102.txt'))
  await h.click('转换大小写'); assert.ok(h.text().includes('SAMPLE_1.txt'))
  assert.equal(h.requests.length, 0)
})

test('preview API forwards pure names to native IPC and browser demo refuses regex execution', async () => {
  const { api: browser } = await import('../api.js')
  await assert.rejects(browser.previewRegexRename(['sample'], '(a+)+$', '$1'), /请在Bento中使用正则预览/)
  const previous = globalThis.window, calls = []
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => { calls.push([command, args]); return ['case_1'] } } }
  try {
    const { api } = await import('../api.js?batch-regex-native')
    assert.deepEqual(await api.previewRegexRename(['sample_1'], '^sample_(\\d+)$', 'case_$1'), ['case_1'])
    assert.deepEqual(calls, [['regex_rename_preview', { names: ['sample_1'], pattern: '^sample_(\\d+)$', replacement: 'case_$1' }]])
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous }
})

test('regex uses full dotted directory name while existing literal behavior stays unchanged', async t => {
  const h = await mountBatch(t, [item('part.one.folder', true)])
  await h.change(0, '.'); await h.change(1, '_')
  assert.ok(h.text().includes('part_one.folder'))
  await h.regex()
  assert.deepEqual(h.requests[0].args[0], ['part.one.folder'])
  await h.resolve(0, ['part_one_folder'])
  assert.ok(h.text().includes('part_one_folder'))
  await h.regex(false)
  assert.ok(h.text().includes('part_one.folder'))
})


test('native Enter in the commit gap cannot apply a previous selection while the new preview waits', async t => {
  const h = await mountBatch(t, [item('sample_1.txt')])
  await h.change(0, 'sample'); await h.change(1, 'case'); await h.regex()
  await h.resolve(0, ['case_1'])
  assert.equal(h.button('重命名').props.disabled, false)
  let dispatched = 0
  await h.update({ items: [item('other.txt')] }, () => {
    const event = new Event('keydown')
    Object.defineProperty(event, 'key', { value: 'Enter' })
    window.dispatchEvent(event)
    dispatched++
  })
  assert.equal(dispatched, 1, 'Enter dispatched after commit and before passive cleanup')
  assert.equal(h.button('重命名').props.disabled, true)
  assert.deepEqual(h.requests[1].args[0], ['other'])
  assert.deepEqual(h.applied, [], 'no previous-selection rows submitted during pending preview')
  await h.resolve(1, ['current'])
  await h.enter()
  assert.deepEqual(h.applied, [[{ ...item('other.txt'), newBase: 'current', newName: 'current.txt' }]])
})


test('editable field shortcuts reach the existing text delegate without leaking modal file shortcuts', async t => {
  const h = await mountBatch(t)
  await h.change(0, 'sample'); await h.change(1, 'case')
  const commands = [], writes = [], reached = [], keyWindow = window
  const input = h.inputs()[0].instance
  Object.assign(input, { value: 'sample', selectionStart: 0, selectionEnd: 0,
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length },
  })
  const doc = { activeElement: input, defaultView: window, execCommand: (...args) => commands.push(args) }
  const editor = createTextEditing({ doc, readText: async () => 'pasted', writeText: async value => writes.push(value) })
  const delegate = e => { reached.push(e.key); editor.handleKeyDown(e) }
  keyWindow.addEventListener('keydown', delegate)
  t.after(() => { keyWindow.removeEventListener('keydown', delegate); editor.dispose() })

  const selected = await h.key('a', input, { metaKey: true })
  assert.equal(selected.cancelBubble, false, 'CmdA from the real mounted input reaches bubble delegate')
  assert.equal(selected.defaultPrevented, true)
  assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 6])
  for (const key of ['c', 'x', 'v']) {
    const event = await h.key(key, input, { metaKey: true })
    assert.equal(event.cancelBubble, false, `editing shortcut ${key} propagates`)
    assert.equal(event.defaultPrevented, true)
  }
  assert.deepEqual(writes, ['sample', 'sample'])
  assert.deepEqual(commands.map(args => args[0]), ['delete', 'insertText'])
  assert.equal(commands[1][2], 'pasted')

  const count = reached.length
  for (const [key, target, modifiers] of [
    ['r', input, { metaKey: true }], ['c', input, { metaKey: true, altKey: true }],
    ['w', input, { metaKey: true }], ['Backspace', input, { metaKey: true }],
    ['z', input, { metaKey: true }], ['Z', input, { metaKey: true, shiftKey: true }],
    ['F2', input, {}], ['a', input, {}], ['a', input, { ctrlKey: true }],
    ['a', input, { metaKey: true, shiftKey: true }], ['a', input, { metaKey: true, isComposing: true }],
    ['a', h.button('重命名').instance, { metaKey: true }],
  ]) {
    assert.equal((await h.key(key, target, modifiers)).cancelBubble, true, `${key} stays inside the modal`)
  }
  assert.equal(reached.length, count)
  assert.deepEqual(h.applied, [])
})
