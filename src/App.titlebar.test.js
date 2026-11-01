import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp } from './test/AppHarness.js'

const navigation = h => h.root.findByProps({ 'aria-label': '目录导航' })
const back = h => navigation(h).findByProps({ 'aria-label': '后退' })
const forward = h => navigation(h).findByProps({ 'aria-label': '前进' })
const active = (h, i = 0) => { const p = h.panes[i].props.pane; return p.tabs[p.active] }
const click = async (h, button) => {
  assert.equal(button.props.disabled, false)
  await h.run(() => button.props.onClick())
}
const nav = async (h, i, path) => h.run(() => h.panes[i].props.onNav(active(h, i).id, path))
// React renderer has no DOM event propagation or native default click. Deliver
// the real group handler, then the real App window listener only if it bubbles.
async function navigationKey(h, key, extra = {}) {
  const event = new Event('keydown', { cancelable: true })
  Object.assign(event, { key, ...extra })
  let stopped = false
  event.stopPropagation = () => { stopped = true }
  await h.run(() => {
    navigation(h).props.onKeyDown(event)
    if (!stopped) window.dispatchEvent(event)
  })
  return { stopped, prevented: event.defaultPrevented }
}

// Catches missing bounds and routing through a second, independent history stack.
test('titlebar reuses focused pane history, clears selection, and drops a forward branch', async t => {
  const h = await mountApp(t)
  assert.equal(back(h).props.disabled, true)
  assert.equal(forward(h).props.disabled, true)
  await nav(h, 0, '/B'); await nav(h, 0, '/C')
  const beforeOther = active(h, 1), ticks = h.panes.map(p => p.props.tick)
  await h.run(() => h.panes[0].props.onSelect(active(h).id, new Set(['/C/file'])))
  await click(h, back(h))
  assert.equal(active(h).path, '/B'); assert.equal(h.panes[0].props.selection.size, 0)
  assert.equal(forward(h).props.disabled, false)
  await click(h, back(h))
  assert.equal(active(h).path, '/home'); assert.equal(back(h).props.disabled, true)
  await h.run(() => h.panes[0].props.onSelect(active(h).id, new Set(['/home/file'])))
  await click(h, forward(h)); assert.equal(h.panes[0].props.selection.size, 0)
  await click(h, forward(h))
  assert.equal(active(h).path, '/C'); assert.equal(forward(h).props.disabled, true)
  await click(h, back(h)); await nav(h, 0, '/D')
  assert.deepEqual(active(h).history, ['/home', '/B', '/D'])
  assert.equal(forward(h).props.disabled, true)
  assert.deepEqual(active(h, 1), beforeOther)
  assert.deepEqual(h.panes.map(p => p.props.tick), ticks)
})

// Catches stale closures after focus/tab changes and missing layout clamping.
test('titlebar follows active tabs, focused panes, and the visible pane after layout shrink', async t => {
  const h = await mountApp(t)
  await nav(h, 0, '/Left'); await nav(h, 1, '/Right')
  await h.run(() => h.panes[1].props.onFocus(1))
  await click(h, back(h))
  assert.equal(active(h, 1).path, '/home'); assert.equal(active(h).path, '/Left')
  await h.run(() => h.panes[1].props.onNewTab(1))
  assert.equal(back(h).props.disabled, true); assert.equal(forward(h).props.disabled, true)
  await nav(h, 1, '/Second tab')
  await h.run(() => h.panes[1].props.onSwitchTab(1, 0))
  assert.equal(forward(h).props.disabled, false)
  await click(h, forward(h)); assert.equal(active(h, 1).path, '/Right')
  await navigationKey(h, '1', { metaKey: true })
  assert.equal(h.panes.length, 1)
  await click(h, back(h)); assert.equal(active(h).path, '/home')
  await navigationKey(h, '2', { metaKey: true })
  assert.equal(active(h, 1).path, '/Right')
  assert.deepEqual(h.panes[1].props.pane.tabs[1].history, ['/home', '/Second tab'])
})

test('titlebar switches workspace history and retains the full focused path tooltip', async t => {
  const pane = path => ({ active: 0, tabs: [{ path, history: ['/root', path], hi: 1 }] })
  const h = await mountApp(t, { loadSession: async () => ({ version: 1, layout: '1', focusedIdx: 0,
    panes: [pane('/One/folder')], activeWorkspace: 'one', workspaces: [
      { id: 'one', name: 'One', layout: '1', focusedIdx: 0, panes: [pane('/One/folder')] },
      { id: 'two', name: 'Two', layout: '1', focusedIdx: 0, panes: [pane('/Two/folder')] },
    ] }) })
  assert.equal(h.root.findByProps({ className: 'tb-title' }).props.title, '/One/folder')
  await h.run(() => h.sidebar.props.onSwitchWorkspace('two'))
  assert.equal(h.root.findByProps({ className: 'tb-title' }).props.title, '/Two/folder')
  await click(h, back(h)); assert.equal(active(h).path, '/root')
  await h.run(() => h.sidebar.props.onSwitchWorkspace('one'))
  assert.equal(active(h).path, '/One/folder'); assert.equal(forward(h).props.disabled, true)
})

// Without the group guard Enter starts file rename and Space opens Quick Look.
test('navigation Enter and Space retain native activation without reaching file actions', async t => {
  const previews = [], h = await mountApp(t, { quickLook: async (...args) => previews.push(args) })
  await nav(h, 0, '/B')
  const id = active(h).id, row = { path: '/B/file', name: 'file', is_dir: false }
  await h.run(() => {
    h.panes[0].props.onRowsCache(id, [row])
    h.panes[0].props.onSelect(id, new Set([row.path]))
  })
  for (const key of ['Enter', ' ']) {
    assert.deepEqual(await navigationKey(h, key), { stopped: true, prevented: false })
    assert.equal(h.panes[0].props.renaming, null)
    assert.deepEqual(previews, [])
    assert.equal(active(h).path, '/B')
  }
  // The browser's default click uses the same real button callback.
  await click(h, back(h)); assert.equal(active(h).path, '/home')
})

test('navigation allows global modified shortcuts and existing Tab pane cycling', async t => {
  const h = await mountApp(t)
  await nav(h, 0, '/B')
  assert.deepEqual(await navigationKey(h, '[', { metaKey: true }), { stopped: false, prevented: true })
  assert.equal(active(h).path, '/home')
  assert.deepEqual(await navigationKey(h, ']', { metaKey: true }), { stopped: false, prevented: true })
  assert.equal(active(h).path, '/B')
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) {
    assert.equal((await navigationKey(h, 'Enter', { [modifier]: true })).stopped, false)
  }
  assert.deepEqual(await navigationKey(h, 'Tab'), { stopped: false, prevented: true })
  assert.equal(h.panes[1].props.focused, true)
  assert.equal(back(h).props.disabled, true)
})
