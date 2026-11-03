import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const bundles = await Promise.all(['SettingsDialog', 'ZipDialog', 'BatchRenameDialog'].map(async name => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(`./${name}.jsx`, import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', plugins: [{ name: 'dialog-boundaries', setup(b) {
    b.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({ path: require.resolve(path), external: true }))
    b.onResolve({ filter: /(?:^|\/)api(?:\.js)?$/ }, () => ({ path: 'api', namespace: 'test' }))
    b.onResolve({ filter: /(?:^|\/)AboutSection$/ }, () => ({ path: 'about', namespace: 'test' }))
    b.onResolve({ filter: /^@tauri-apps\/plugin-dialog$/ }, () => ({ path: 'picker', namespace: 'test' }))
    b.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: path === 'api' ? 'export const hasTauri = false; export const api = { fsearchStatus: async () => ({}) }' : path === 'picker' ? 'export const open = async () => null; export const save = open' : 'export default function About(){return null}' }))
  } }] })
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports)
  return [name, mod.exports.default]
}))
const components = Object.fromEntries(bundles)

// The existing renderer has no DOM. Model only its focus/event boundary; the
// mounted components and their lifecycle/key handlers remain the real code.
async function mount(t, name, { strict = false } = {}) {
  const previous = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(k => [k, globalThis[k]]))
  const win = new EventTarget(), doc = new EventTarget()
  doc.defaultView = win
  let focused = true
  doc.hasFocus = () => focused
  win.getComputedStyle = () => ({ visibility: 'visible' })
  const node = (tagName = 'BUTTON', props = {}) => ({
    tagName, type: props.type || '', name: props.name || '', checked: !!props.checked,
    tabIndex: 0, disabled: !!props.disabled, isConnected: true, ownerDocument: doc,
    getClientRects() { return this.hidden ? [] : [{}] },
    matches(selector) { return selector === ':disabled' ? this.disabled : false },
    closest() { return null },
    focus() { doc.activeElement = this; const e = new Event('focusin'); Object.defineProperty(e, 'target', { value: this }); doc.dispatchEvent(e) },
    setSelectionRange(start, end) { this.selection = [start, end] },
  })
  doc.body = node('BODY'); doc.body.tabIndex = -1
  const trigger = node(), fallback = node('DIV'), first = node(), input = node('INPUT'), last = node()
  let controls = [first, input, last]
  const root = node('DIV'); root.tabIndex = -1
  root.contains = target => target === root || controls.includes(target)
  root.querySelectorAll = () => controls
  root.querySelector = selector => controls.find(n => n.autoFocus) || null
  let otherModal = null
  doc.querySelectorAll = () => [root, otherModal].filter(n => n?.isConnected)
  doc.querySelector = () => fallback
  doc.activeElement = trigger
  globalThis.window = win; globalThis.document = doc; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let cancelled = 0, submitted = 0
  const props = name === 'SettingsDialog' ? { open: true, searchPaths: [], onClose: () => cancelled++ } : name === 'ZipDialog' ? { count: 1, dir: '/fixture', defaultName: 'example.zip', prefs: { mode: 'fast', level: 6, password: '' }, onCancel: () => cancelled++, onSubmit: () => submitted++ } : { items: [{ name: 'file.txt', path: '/fixture/file.txt' }], onCancel: () => cancelled++, onApply: () => submitted++ }
  let renderer
  const render = () => {
    const dialog = React.createElement(components[name], props)
    return strict ? React.createElement(React.StrictMode, null, dialog) : dialog
  }
  const oldError = console.error
  console.error = (...args) => { if (!String(args[0]).startsWith('react-test-renderer is deprecated.')) oldError(...args) }
  try { await act(async () => { renderer = create(render(), { createNodeMock: n => n.props.role === 'dialog' ? root : input }) }) }
  finally { console.error = oldError }
  let mounted = true
  const close = async (destination = doc.body) => {
    if (!mounted) return
    root.isConnected = false; controls.forEach(n => { n.isConnected = false }); doc.activeElement = destination
    await act(async () => renderer.unmount()); mounted = false
  }
  t.after(async () => { await close(); for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v } })
  const key = async (key, target = doc.activeElement, extra = {}) => {
    const e = new Event('keydown', { cancelable: true })
    for (const [k, v] of Object.entries({ key, target, ...extra })) Object.defineProperty(e, k, { value: v })
    await act(async () => {
      win.dispatchEvent(e)
      if (!e.cancelBubble) renderer.root.find(n => n.props.role === 'dialog').props.onKeyDown?.(e)
    })
    return e
  }
  return { doc, root, trigger, fallback, first, input, last, key, close,
    get cancelled() { return cancelled }, get submitted() { return submitted },
    setControls(value) { controls = value }, node,
    blur() { focused = false }, focusWindow() { focused = true },
    addModal() { otherModal = node('DIV'); return otherModal },
    async visible(open) { props.open = open; root.isConnected = open; if (!open) doc.activeElement = doc.body; await act(async () => renderer.update(render())) },
  }
}

for (const name of Object.keys(components)) {
  test(`${name} wraps Tab and Shift Tab inside the mounted dialog and restores its trigger`, async t => {
    const h = await mount(t, name)
    h.last.focus()
    assert.equal((await h.key('Tab')).defaultPrevented, true)
    assert.equal(h.doc.activeElement, h.first)
    await h.key('Tab', h.first, { shiftKey: true })
    assert.equal(h.doc.activeElement, h.last)
    await h.close()
    assert.equal(h.doc.activeElement, h.trigger)
  })
  test(`${name} ignores composing Enter and Escape`, async t => {
    const h = await mount(t, name)
    await h.key('Enter', h.input, { isComposing: true })
    await h.key('Escape', h.input, { isComposing: true })
    await h.key('Enter', h.input, { keyCode: 229 })
    assert.equal(h.cancelled, 0)
    assert.equal(h.submitted, 0)
    await h.key('Escape', h.input)
    assert.equal(h.cancelled, 1)
  })
}

test('Settings open false cleans up, then reopens with a fresh trigger', async t => {
  const h = await mount(t, 'SettingsDialog')
  await h.visible(false)
  assert.equal(h.doc.activeElement, h.trigger)
  const fresh = h.node(); fresh.focus()
  await h.visible(true); await h.visible(false)
  assert.equal(h.doc.activeElement, fresh)
})

test('ZIP keeps filename stem selection, filters disabled/hidden controls and treats radio group as one Tab stop', async t => {
  const h = await mount(t, 'ZipDialog')
  assert.deepEqual(h.input.selection, [0, 7])
  const disabled = h.node(), hidden = h.node(), radioA = h.node('INPUT', { type: 'radio', name: 'zip-mode' }), radioB = h.node('INPUT', { type: 'radio', name: 'zip-mode', checked: true })
  disabled.disabled = true; hidden.hidden = true
  h.setControls([h.first, disabled, hidden, radioA, radioB, h.last])
  h.first.focus(); await h.key('Tab')
  assert.equal(h.doc.activeElement, radioB)
  radioB.disabled = true; h.first.focus(); await h.key('Tab')
  assert.equal(h.doc.activeElement, radioA)
})

test('focus containment respects window blur, modified Tab, and another modal', async t => {
  const h = await mount(t, 'ZipDialog')
  h.blur(); h.trigger.focus()
  assert.equal(h.doc.activeElement, h.trigger)
  assert.equal((await h.key('Tab')).defaultPrevented, false)
  h.focusWindow(); h.first.focus()
  for (const extra of [{ metaKey: true }, { altKey: true }, { ctrlKey: true }, { isComposing: true }]) assert.equal((await h.key('Tab', h.first, extra)).defaultPrevented, false)
  h.addModal(); h.trigger.focus()
  assert.equal(h.doc.activeElement, h.trigger)
  await h.close()
  assert.equal(h.doc.activeElement, h.doc.body)
})

test('removed context menu trigger returns focus to the active pane', async t => {
  const h = await mount(t, 'ZipDialog')
  h.trigger.isConnected = false
  await h.close()
  assert.equal(h.doc.activeElement, h.fallback)
})

test('closing does not override an intentional focus destination', async t => {
  const h = await mount(t, 'ZipDialog'), destination = h.node()
  await h.close(destination)
  assert.equal(h.doc.activeElement, destination)
})

test('ZIP editing shortcuts bubble to the application text delegate', async t => {
  const h = await mount(t, 'ZipDialog')
  for (const key of ['a', 'c', 'x', 'v']) {
    const event = await h.key(key, h.input, { metaKey: true })
    assert.equal(event.cancelBubble, false)
    assert.equal(event.defaultPrevented, false)
  }
  assert.equal((await h.key('r', h.input, { metaKey: true })).cancelBubble, true)
})

test('StrictMode effect replay keeps containment active and preserves the original trigger', async t => {
  const h = await mount(t, 'SettingsDialog', { strict: true })
  assert.equal(h.doc.activeElement, h.first)
  h.trigger.focus()
  assert.equal(h.doc.activeElement, h.first)
  h.last.focus(); await h.key('Tab')
  assert.equal(h.doc.activeElement, h.first)
  await h.close()
  assert.equal(h.doc.activeElement, h.trigger)
})

test('a dialog without enabled controls retains keyboard focus on the dialog itself', async t => {
  const h = await mount(t, 'ZipDialog')
  h.setControls([])
  await h.key('Tab')
  assert.equal(h.doc.activeElement, h.root)
})

test('closing while a native picker owns window focus does not focus the trigger', async t => {
  const h = await mount(t, 'ZipDialog')
  h.blur(); await h.close()
  assert.equal(h.doc.activeElement, h.doc.body)
})
