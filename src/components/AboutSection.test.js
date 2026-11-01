import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const packageVersion = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./SettingsDialog.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  plugins: [{ name: 'about-native-boundary', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({ path: require.resolve(path), external: true }))
    builder.onResolve({ filter: /(?:^|\/)api(?:\.js)?$/ }, () => ({ path: 'api', namespace: 'test' }))
    builder.onResolve({ filter: /^@tauri-apps\/api\/app$/ }, () => ({ path: 'version', namespace: 'test' }))
    builder.onResolve({ filter: /^@tauri-apps\/plugin-dialog$/ }, () => ({ path: 'dialog', namespace: 'test' }))
    builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: path === 'api'
      ? 'export const hasTauri = globalThis.__aboutTest.native; export const api = { fsearchStatus: async () => ({}), openPath: url => globalThis.__aboutTest.openPath(url) }'
      : path === 'version' ? 'export const getVersion = () => globalThis.__aboutTest.getVersion()'
        : 'export const open = async () => null', loader: 'js' }))
  } }],
})
function loadDialog() {
  const result = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, result, result.exports)
  return result.exports.default
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const response = (tag_name = 'v0.3.0', status = 200, html_url = 'https://github.com/banduoba/bento/releases/tag/v0.3.0') => ({
  ok: status === 200, status, json: async () => ({ tag_name, html_url, draft: false, prerelease: false }),
})

async function mount(t, { native = true, getVersion = async () => '0.2.1', fetchImpl } = {}) {
  const keys = ['window', 'fetch', '__aboutTest', 'IS_REACT_ACT_ENVIRONMENT']
  const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]))
  const requests = []
  const opened = []
  let openError = null
  globalThis.__aboutTest = { native, getVersion, openPath: async url => { if (openError) throw openError; opened.push(url) } }
  globalThis.window = new EventTarget()
  window.open = (...args) => { opened.push(args); return {} }
  globalThis.fetch = (url, options) => {
    const pending = deferred()
    requests.push({ url, options, ...pending })
    return fetchImpl ? fetchImpl(url, options) : pending.promise
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const Dialog = loadDialog()
  let closed = 0
  const props = { open: true, searchPaths: [], onClose: () => { closed++ } }
  let renderer
  const originalError = console.error
  try {
    console.error = (...args) => { if (!String(args[0]).startsWith('react-test-renderer is deprecated.')) originalError(...args) }
    await act(async () => { renderer = create(React.createElement(Dialog, props)) })
  } finally { console.error = originalError }
  let mounted = true
  const unmount = async () => { if (mounted) { await act(async () => renderer.unmount()); mounted = false } }
  t.after(async () => { await unmount(); for (const key of keys) { if (previous[key] === undefined) delete globalThis[key]; else globalThis[key] = previous[key] } })
  const text = () => JSON.stringify(renderer.toJSON())
  const button = label => renderer.root.findAllByType('button').find(node => node.children.join('') === label)
  const click = async label => { assert.ok(button(label), `button ${label} exists`); await act(async () => { button(label).props.onClick() }) }
  return { requests, opened, button, click, text, unmount,
    get closed() { return closed }, setOpenError(value) { openError = value },
    async update(patch) { Object.assign(props, patch); await act(async () => renderer.update(React.createElement(Dialog, props))) },
    async resolve(index, value) { await act(async () => requests[index].resolve(value)) },
  }
}

test('settings About shows runtime metadata without networking and opens project/download/issue in the default browser', async t => {
  const h = await mount(t, { getVersion: async () => '1.2.3+running' })
  await h.click('关于')
  for (const text of ['Bento', '1.2.3+running', 'MIT', 'banduoba', '轻量多窗格文件管理器']) assert.ok(h.text().includes(text), text)
  assert.equal(h.requests.length, 0)
  await h.click('项目主页')
  await h.click('下载页面')
  await h.click('反馈问题')
  assert.deepEqual(h.opened, ['https://github.com/banduoba/bento', 'https://github.com/banduoba/bento/releases/latest', 'https://github.com/banduoba/bento/issues'])
  const escape = new Event('keydown', { cancelable: true }); Object.defineProperty(escape, 'key', { value: 'Escape' })
  window.dispatchEvent(escape)
  assert.equal(h.closed, 1)
})

test('browser demo uses package version and browser links without native IPC', async t => {
  const h = await mount(t, { native: false, getVersion: () => { throw new Error('native IPC forbidden') } })
  await h.click('关于')
  assert.ok(h.text().includes(packageVersion))
  await h.click('下载页面')
  assert.deepEqual(h.opened, [['https://github.com/banduoba/bento/releases/latest', '_blank', 'noopener,noreferrer']])
})

test('manual checking exposes busy and available states and safely opens the release page', async t => {
  const h = await mount(t)
  await h.click('关于')
  await h.click('检查更新')
  assert.ok(h.text().includes('检查中'))
  assert.equal(h.button('检查中…').props.disabled, true)
  assert.equal(h.requests.length, 1)
  await h.resolve(0, response())
  assert.ok(h.text().includes('发现新版本 v0.3.0'))
  await h.click('下载新版本')
  assert.deepEqual(h.opened, ['https://github.com/banduoba/bento/releases/tag/v0.3.0'])
})

test('manual checking displays current, ahead, no-release, rate-limit and network errors with retry', async t => {
  const h = await mount(t)
  await h.click('关于')
  for (const [value, expected] of [
    [response('v0.2.1'), '已是最新版本'], [response('v0.1.0'), '本地版本较新'],
    [response('', 404), '尚无正式发布版本'], [response('', 403), 'GitHub 暂时限制'],
  ]) { await h.click('检查更新'); await h.resolve(h.requests.length - 1, value); assert.ok(h.text().includes(expected), expected) }
  await h.click('检查更新')
  await act(async () => h.requests.at(-1).resolve(Promise.reject(new TypeError('offline'))))
  assert.ok(h.text().includes('无法连接 GitHub'))
  await h.click('检查更新')
  await h.resolve(h.requests.length - 1, response())
  assert.ok(h.text().includes('发现新版本'))
})

test('a new request wins over an older late response and closing aborts in-flight work', async t => {
  const h = await mount(t)
  await h.click('关于')
  await h.click('检查更新')
  // Invoke the handler again to exercise races even if two clicks arrive before disabled rendering.
  await h.click('检查中…')
  assert.equal(h.requests[0].options.signal.aborted, true)
  await h.resolve(1, response('v0.2.1'))
  await h.resolve(0, response('v9.0.0'))
  assert.ok(h.text().includes('已是最新版本'))
  assert.ok(!h.text().includes('v9.0.0'))
  await h.click('检查更新')
  await h.update({ open: false })
  assert.equal(h.requests[2].options.signal.aborted, true)
  await h.resolve(2, response('v8.0.0'))
  await h.update({ open: true })
  assert.ok(!h.text().includes('v8.0.0'))
})

test('leaving About and unmounting cancel requests; link failures remain visible', async t => {
  const h = await mount(t)
  await h.click('关于'); await h.click('检查更新')
  await h.click('通用')
  assert.equal(h.requests[0].options.signal.aborted, true)
  await h.click('关于')
  h.setOpenError(new Error('open failed'))
  await h.click('下载页面')
  assert.ok(h.text().includes('无法打开浏览器'))
  await h.click('检查更新')
  await h.unmount()
  assert.equal(h.requests[1].options.signal.aborted, true)
})

test('runtime version lookup failure disables comparison while retaining manual download access', async t => {
  const h = await mount(t, { getVersion: async () => { throw new Error('version unavailable') } })
  await h.click('关于')
  assert.ok(h.text().includes('无法读取当前应用版本'))
  assert.equal(h.button('检查更新').props.disabled, true)
  await h.click('检查更新')
  assert.equal(h.requests.length, 0)
  await h.click('下载页面')
  assert.deepEqual(h.opened, ['https://github.com/banduoba/bento/releases/latest'])
})
