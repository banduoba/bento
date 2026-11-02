import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react-test-renderer'
import { mountPane } from './test/PaneHarness.js'

const key = (key, extra = {}) => ({ key, nativeEvent: {}, preventDefault() {}, stopPropagation() {}, ...extra })
const click = { currentTarget: { getBoundingClientRect: () => ({ left: 100, bottom: 40 }) } }
const more = h => h.root.findByProps({ 'aria-label': '路径操作' })
const menuItem = (h, label) => h.root.findByProps({ 'data-label': label })
const input = h => h.root.findByProps({ className: 'path-input' })
async function open(h) { await act(async () => more(h).props.onClick(click)) }
async function edit(h) { await h.update({ editPathSignal: 1 }) }

function nodes() {
  const doc = { activeElement: null, body: {} }
  const crumbs = { scrollLeft: 0, scrollWidth: 300, clientWidth: 300 }
  const field = {
    ownerDocument: doc, value: '', scrollLeft: 0, scrollWidth: 1600, clientWidth: 250,
    selectionStart: 0, selectionEnd: 0, focusCount: 0,
    focus() { doc.activeElement = this; this.focusCount++ },
    select() {
      this.selectionStart = 0; this.selectionEnd = this.value.length
      // WebKit may reveal the beginning after focus/selection has returned.
      requestAnimationFrame(() => { this.scrollLeft = 0 })
    },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end },
  }
  const trigger = { ownerDocument: doc, focus() { doc.activeElement = this }, getBoundingClientRect: click.currentTarget.getBoundingClientRect }
  const firstItem = { disabled: false, focus() { doc.activeElement = this } }
  return { doc, field, trigger, firstItem, createNodeMock(el) {
    if (el.props.className === 'crumbs') return crumbs
    if (el.props.className === 'path-input') { field.value = el.props.value; return field }
    if (el.props['aria-label'] === '路径操作') return trigger
    if (el.props.role === 'menu') return { getBoundingClientRect: () => ({ width: 150, height: 100 }), querySelector: () => firstItem, querySelectorAll: () => [firstItem] }
    return null
  } }
}

// These assertions catch hidden callbacks, stale menu actions and accidental focus restoration.
test('address controls keep only history buttons before the path and expose parent/refresh/edit in the trailing menu', async t => {
  const n = nodes(), calls = []
  const h = await mountPane(t, n)
  await h.update({ onParent: id => calls.push(['parent', id]), onBack: id => calls.push(['back', id]), onForward: id => calls.push(['forward', id]) })
  assert.equal(h.root.findByProps({ className: 'navbtns' }).findAllByType('button').length, 2)
  await open(h)
  await act(async () => menuItem(h, '上级目录').props.onClick())
  assert.deepEqual(calls, [['parent', 'a']])
  await open(h)
  await act(async () => menuItem(h, '刷新').props.onClick())
  assert.deepEqual(h.navigations, [['a', '/d', true]])
  await open(h)
  await act(async () => menuItem(h, '编辑路径').props.onClick())
  assert.equal(input(h).props.value, '/d')
  assert.equal(n.doc.activeElement, n.field)
})

test('menu disables parent at root and Escape restores trigger focus while outside clicks leave other panes alone', async t => {
  const n = nodes(), h = await mountPane(t, n)
  await h.update({ pane: { active: 0, tabs: [{ id: 'a', path: '/' }] } })
  await open(h)
  assert.equal(menuItem(h, '上级目录').props.disabled, true)
  assert.equal(n.doc.activeElement, n.firstItem)
  await act(async () => window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })))
  assert.equal(h.root.findAllByProps({ role: 'menu' }).length, 0)
  assert.equal(n.doc.activeElement, n.trigger)
  await open(h)
  const otherPane = {}; n.doc.activeElement = otherPane
  await act(async () => window.dispatchEvent(new Event('mousedown')))
  assert.equal(h.root.findAllByProps({ role: 'menu' }).length, 0)
  assert.equal(n.doc.activeElement, otherPane)
})

test('editing gives the path the filter and menu space without discarding the filter', async t => {
  const h = await mountPane(t, nodes())
  await h.update({ filter: 'report' })
  await edit(h)
  assert.equal(h.root.findAllByProps({ className: 'filterbox' }).length, 0)
  assert.equal(h.root.findAllByProps({ 'aria-label': '路径操作' }).length, 0)
  await act(async () => input(h).props.onKeyDown(key('Escape')))
  assert.equal(h.root.findByProps({ placeholder: '筛选' }).props.value, 'report')
})

test('long selected paths reveal the tail after deferred focus scrolling and stop forcing scroll afterward', async t => {
  const n = nodes(), h = await mountPane(t, n)
  const path = '/Users/meng/Documents/very-long-project/subfolders/final-folder'
  await h.update({ pane: { active: 0, tabs: [{ id: 'a', path }] } })
  await edit(h)
  assert.deepEqual([n.field.selectionStart, n.field.selectionEnd], [0, path.length])
  await h.flushFrames() // the browser resets scroll after select
  await h.flushFrames() // our post-focus viewport correction
  assert.equal(n.field.scrollLeft, 1350)
  n.field.scrollLeft = 30
  await h.flushFrames()
  assert.equal(n.field.scrollLeft, 30)
  assert.deepEqual([n.field.selectionStart, n.field.selectionEnd], [0, path.length])
})

for (const interaction of ['ArrowLeft', 'Home', 'End', 'composition', 'pointer', 'blur', 'close', 'tab', 'unfocus', 'unmount']) {
  test(`pending path reveal does not override ${interaction}`, async t => {
    const n = nodes(), h = await mountPane(t, n)
    await edit(h)
    await h.flushFrames()
    if (interaction === 'composition') await act(async () => input(h).props.onCompositionStart())
    else if (interaction === 'pointer') await act(async () => input(h).props.onPointerDown())
    else if (interaction === 'blur') { n.doc.activeElement = {}; await act(async () => input(h).props.onBlur({ relatedTarget: null })) }
    else if (interaction === 'close') await act(async () => input(h).props.onKeyDown(key('Escape')))
    else if (interaction === 'tab') await h.update({ pane: { active: 0, tabs: [{ id: 'b', path: '/other' }] } })
    else if (interaction === 'unfocus') await h.update({ focused: false })
    else if (interaction === 'unmount') await h.unmount()
    else await act(async () => input(h).props.onKeyDown(key(interaction)))
    n.field.scrollLeft = 17
    await h.flushFrames()
    assert.equal(n.field.scrollLeft, 17)
  })
}

test('menu keys stay out of global file shortcuts and passive renders do not reclaim focus', async t => {
  const n = nodes(), h = await mountPane(t, n)
  await open(h)
  const menu = h.root.findByProps({ role: 'menu' })
  for (const name of ['Enter', ' ', 'Backspace', 'a']) {
    let stopped = false
    await act(async () => menu.props.onKeyDown(key(name, { stopPropagation() { stopped = true } })))
    assert.equal(stopped, true, name)
  }
  const other = {}; n.doc.activeElement = other
  await h.update({ selection: new Set(['/d/file']) })
  assert.equal(n.doc.activeElement, other)
  await act(async () => h.root.findByProps({ role: 'menu' }).props.onKeyDown(key('Escape')))
  assert.equal(h.root.findAllByProps({ role: 'menu' }).length, 0)
})

test('Enter reports invalid paths without losing text, then resolves a corrected path', async t => {
  const n = nodes(), resolutions = []
  const h = await mountPane(t, n, { resolvePath: async path => {
    resolutions.push(path)
    if (path === '/missing') throw new Error('Folder missing')
    return '/resolved'
  } })
  await edit(h)
  n.field.value = '/missing'
  await act(async () => input(h).props.onChange({ target: n.field }))
  await act(async () => input(h).props.onKeyDown(key('Enter')))
  assert.equal(input(h).props.value, '/missing')
  assert.equal(input(h).props['aria-invalid'], true)
  assert.deepEqual(h.navigations, [])
  n.field.value = '/valid'
  await act(async () => input(h).props.onChange({ target: n.field }))
  await act(async () => input(h).props.onKeyDown(key('Enter')))
  assert.deepEqual(resolutions, ['/missing', '/valid'])
  assert.deepEqual(h.navigations, [['a', '/resolved']])
  assert.equal(h.root.findAllByProps({ className: 'path-input' }).length, 0)
})

test('Tab completes text and moves the caret without navigating; Escape cancels editing', async t => {
  const n = nodes(), h = await mountPane(t, n, { completePath: async path => {
    assert.equal(path, '/d/fo')
    return { base: '/d/', text: '/d/folder/', matches: [{ name: 'folder', is_dir: true }] }
  } })
  await edit(h)
  n.field.value = '/d/fo'
  await act(async () => input(h).props.onChange({ target: n.field }))
  await act(async () => input(h).props.onKeyDown(key('Tab')))
  assert.equal(input(h).props.value, '/d/folder/')
  assert.deepEqual([n.field.selectionStart, n.field.selectionEnd], [10, 10])
  assert.deepEqual(h.navigations, [])
  await act(async () => input(h).props.onKeyDown(key('Escape')))
  assert.equal(h.root.findAllByProps({ className: 'path-input' }).length, 0)
  assert.deepEqual(h.navigations, [])
})

test('clicking the menu trigger again closes it before an outside-click listener can reopen it', async t => {
  const h = await mountPane(t, nodes())
  await open(h)
  let stopped = false
  await act(async () => more(h).props.onMouseDown({ stopPropagation() { stopped = true } }))
  assert.equal(stopped, true)
  await open(h)
  assert.equal(h.root.findAllByProps({ role: 'menu' }).length, 0)
})

for (const className of ['crumbs', 'crumbs-tail']) {
  test(`${className} still enters selected path editing`, async t => {
    const n = nodes(), h = await mountPane(t, n)
    const node = h.root.findByProps({ className })
    await act(async () => node.props.onMouseDown({ target: className === 'crumbs' ? node.instance : {}, preventDefault() {} }))
    assert.equal(input(h).props.value, '/d')
    assert.deepEqual([n.field.selectionStart, n.field.selectionEnd], [0, 2])
  })
}

test('Tab dismisses the path menu from its trigger and menu context clicks stay local', async t => {
  const n = nodes(), h = await mountPane(t, n)
  await open(h)
  const menu = h.root.findByProps({ role: 'menu' })
  let stopped = false
  await act(async () => menu.props.onContextMenu({ preventDefault() {}, stopPropagation() { stopped = true } }))
  assert.equal(stopped, true)
  await act(async () => menu.props.onKeyDown(key('Tab')))
  assert.equal(h.root.findAllByProps({ role: 'menu' }).length, 0)
  assert.equal(n.doc.activeElement, n.trigger)
})
