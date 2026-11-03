import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'
const require = createRequire(import.meta.url)
const bundle = await build({ entryPoints: [fileURLToPath(new URL('./SettingsDialog.jsx', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', plugins: [{ name: 'backup-boundaries', setup(b) {
  b.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({ path: require.resolve(path), external: true }))
  b.onResolve({ filter: /(?:^|\/)api(?:\.js)?$/ }, () => ({ path: 'api', namespace: 'test' }))
  b.onResolve({ filter: /(?:^|\/)AboutSection$/ }, () => ({ path: 'about', namespace: 'test' }))
  b.onResolve({ filter: /^@tauri-apps\/plugin-dialog$/ }, () => ({ path: 'dialog', namespace: 'test' }))
  b.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: path === 'api' ? 'export const hasTauri = globalThis.__backup.native; export const api = globalThis.__backup.api' : path === 'dialog' ? 'export const open = o => globalThis.__backup.open(o); export const save = o => globalThis.__backup.save(o)' : 'export default function About(){return null}', loader: 'js' }))
} }] })
async function mount(t, native = true) {
  const prev = { window: globalThis.window, __backup: globalThis.__backup, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  const calls = [], state = { native, file: '/backup.json', fail: null }
  globalThis.window = new EventTarget(); globalThis.IS_REACT_ACT_ENVIRONMENT = true
  state.open = async options => { calls.push(['open', options]); return state.file }
  state.save = async options => { calls.push(['save', options]); return state.file }
  state.api = { fsearchStatus: async () => ({}), readSettingsBackup: async path => { calls.push(['read', path]); if (state.fail) throw state.fail; return 'backup text' }, exportSettingsBackup: async (path, document) => { calls.push(['export', path, document]); if (state.fail) throw state.fail } }
  globalThis.__backup = state
  const mod = { exports: {} }; new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports)
  let renderer
  const error = console.error; console.error = (...a) => { if (!String(a[0]).startsWith('react-test-renderer is deprecated.')) error(...a) }
  try { await act(async () => { renderer = create(React.createElement(mod.exports.default, { open: true, searchPaths: [], onClose() {}, onExportSettings: () => ({ version: 1 }), onImportSettings: async text => { calls.push(['apply', text]); if (state.fail) throw state.fail } })) }) } finally { console.error = error }
  t.after(async () => { await act(async () => renderer.unmount()); for (const [key, value] of Object.entries(prev)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value } })
  const button = label => renderer.root.findAllByType('button').find(n => (n.props['aria-label'] || n.children.join('')) === label)
  return { state, calls, button, text: () => JSON.stringify(renderer.toJSON()), async click(label) { assert.ok(button(label), `${label} exists`); await act(async () => { await button(label).props.onClick() }) } }
}
test('Settings backup describes the scope, uses JSON save/open dialogs and reports success', async t => {
  const h = await mount(t); await h.click('备份')
  for (const phrase of ['密码', '标签页', '工作区', '文件夹视图']) assert.ok(h.text().includes(phrase))
  await h.click('导出设置…')
  assert.equal(h.calls[0][0], 'save'); assert.deepEqual(h.calls[0][1].filters, [{ name: 'JSON', extensions: ['json'] }])
  assert.deepEqual(h.calls[1], ['export', '/backup.json', { version: 1 }]); assert.ok(h.text().includes('设置已导出'))
  await h.click('导入设置…')
  assert.deepEqual(h.calls.at(-2), ['read', '/backup.json']); assert.deepEqual(h.calls.at(-1), ['apply', 'backup text']); assert.ok(h.text().includes('设置已导入'))
})
test('cancelling dialogs does nothing and read/write failures stay visible for retry', async t => {
  const h = await mount(t); await h.click('备份'); h.state.file = null
  await h.click('导出设置…'); await h.click('导入设置…'); assert.equal(h.calls.length, 2)
  h.state.file = '/backup.json'; h.state.fail = Error('permission denied')
  await h.click('导出设置…'); assert.ok(h.text().includes('permission denied'))
  await h.click('导入设置…'); assert.ok(!h.calls.some(c => c[0] === 'apply'))
  h.state.fail = null; await h.click('导入设置…'); assert.ok(h.text().includes('设置已导入'))
})
test('browser preview disables file backup controls', async t => {
  const h = await mount(t, false); await h.click('备份')
  assert.equal(h.button('导出设置…').props.disabled, true); assert.equal(h.button('导入设置…').props.disabled, true)
})
