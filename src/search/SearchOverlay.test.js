import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../components/SearchOverlay.jsx', import.meta.url))],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  plugins: [{
    name: 'search-boundary',
    setup(b) {
      b.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({
        path: require.resolve(path), external: true,
      }))
      b.onResolve({ filter: /(?:^|\/)api(?:\.js)?$/ }, () => ({
        path: 'api', namespace: 'test',
      }))
      b.onResolve({ filter: /(?:FileIcon|ContextMenu|nativeDrag|format)$/ }, ({ path }) => ({
        path, namespace: 'test',
      }))
      b.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({
        loader: 'js',
        contents: path === 'api'
          ? 'export const api=new Proxy({}, {get:(_,k)=>(...a)=>globalThis.__searchTest[k](...a)}); export const hasTauri=false; export const fileSrc=x=>x'
          : path.endsWith('nativeDrag')
            ? 'export const makeDragPreview=async()=>""; export const runNativeDrag=(...args)=>globalThis.__searchTest.drag(...args)'
            : path.endsWith('format')
              ? 'export const fmtDate=()=>""; export const fmtSize=()=>""; export const copyText=path=>globalThis.__searchTest.copyText(path)'
            : 'export default function Stub(){return null}',
      }))
    },
  }],
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports)
const Overlay = mod.exports.default

const deferred = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const item = (name = 'hit.txt') => ({
  name,
  path: `/work/${name}`,
  dir: '/work',
  is_dir: false,
  size: 2,
  lines: [{ no: 1, text: 'needle' }],
  matches: 1,
})
const result = (items = [], extra = {}) => ({
  items,
  truncated: false,
  incomplete: false,
  warnings: [],
  source: 'local',
  ...extra,
})

async function mount(t, extra = {}) {
  const keys = [
    'window', 'requestAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
    '__searchTest', 'setTimeout', 'clearTimeout',
  ]
  const prev = Object.fromEntries(keys.map(k => [k, globalThis[k]]))
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  globalThis.window = new EventTarget()
  globalThis.requestAnimationFrame = () => 0
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {} },
  })

  let next = 0
  const timers = new Map()
  globalThis.setTimeout = fn => { timers.set(++next, fn); return next }
  globalThis.clearTimeout = id => timers.delete(id)
  const requests = [], cancels = [], previews = [], opened = []
  const located = [], revealed = [], copied = [], drags = [], closed = []
  const drag = deferred()
  globalThis.__searchTest = {
    searchQuery: (...args) => {
      const d = deferred()
      requests.push({ ...d, args })
      return d.promise
    },
    cancelSearch: async id => cancels.push(id),
    copyText: path => copied.push(path),
    drag: (...args) => { drags.push(args); return drag.promise },
    fsearchStatus: async () => ({ ready: true }),
    readTextPreview: () => {
      const d = deferred()
      previews.push(d)
      return d.promise
    },
  }
  const props = {
    open: true,
    root: '/work',
    showHidden: false,
    searchPaths: [],
    scope: 'pane',
    sortBy: 'score',
    mode: 'content',
    onModeChange() {},
    onScopeChange() {},
    onSortChange() {},
    onClose: () => closed.push(true),
    onOpenEntry: e => opened.push(e),
    onLocate: (...args) => located.push(args),
    onReveal: path => revealed.push(path),
    ...extra,
  }

  let renderer
  const err = console.error
  console.error = (...args) => {
    if (!String(args[0]).startsWith('react-test-renderer is deprecated.')) err(...args)
  }
  try {
    await act(async () => { renderer = create(React.createElement(Overlay, props)) })
  } finally {
    console.error = err
  }
  let live = true
  const unmount = async () => {
    if (live) {
      live = false
      await act(async () => renderer.unmount())
    }
  }
  t.after(async () => {
    await unmount()
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
    else delete globalThis.localStorage
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete globalThis[k]
      else globalThis[k] = v
    }
  })
  const run = async f => act(async () => { f() })
  return {
    requests, cancels, previews, opened, located, revealed, copied, drags, drag, closed, unmount, run,
    rows: () => renderer.root.findAll(n => n.type === 'div' && n.props.className?.split(' ').includes('search-item')),
    get root() { return renderer.root },
    text: () => JSON.stringify(renderer.toJSON()),
    input: () => renderer.root.findByType('input'),
    button: label => renderer.root.findAllByType('button').find(n => n.children.join('') === label),
    async type(q) {
      await run(() => renderer.root.findByType('input').props.onChange({ target: { value: q } }))
    },
    async flush() {
      await run(() => {
        for (const [id, fn] of [...timers]) {
          timers.delete(id)
          fn()
        }
      })
    },
    async update(patch) {
      Object.assign(props, patch)
      await run(() => renderer.update(React.createElement(Overlay, props)))
    },
    async resolve(i, r) {
      await run(() => requests[i].resolve(r))
    },
  }
}

test('content preserves pane scope/root and scope controls remain enabled', async t => {
  const h = await mount(t)
  await h.type('needle')
  await h.flush()
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.requests[0].args.slice(0, 6), ['needle', 'pane', '/work', false, [], 'content'])
  assert.ok(!h.button('当前文件夹').props.disabled)
})

test('new input, scope and close cancel old request; stale response cannot clear new busy/results', async t => {
  const h = await mount(t)
  await h.type('old')
  await h.flush()
  await h.type('new')
  assert.ok(h.cancels.includes(h.requests[0].args[6]))
  await h.flush()
  await h.resolve(0, result([item('stale.txt')]))
  assert.ok(h.text().includes('搜索中'))
  assert.ok(!h.text().includes('stale.txt'))
  await h.resolve(1, result([item()]))
  await h.update({ scope: 'home' })
  await h.flush()
  await h.update({ open: false })
  assert.ok(h.cancels.includes(h.requests[2].args[6]))
  await h.resolve(2, result([item('late.txt')]))
  assert.ok(!h.text().includes('late.txt'))
})

test('failure is visible and retry resubmits; partial/truncated notices preserve usable hits', async t => {
  const h = await mount(t)
  await h.type('needle')
  await h.flush()
  await h.run(() => h.requests[0].reject({ code: 'io', message: '读取目录失败' }))
  assert.ok(h.text().includes('读取目录失败'))
  assert.ok(!h.text().includes('没有找到匹配'))
  await h.run(() => h.button('重试').props.onClick())
  await h.flush()
  await h.resolve(1, result([item()], {
    incomplete: true,
    truncated: true,
    warnings: [{ code: 'budget', message: '扫描预算已用尽' }],
  }))
  assert.ok(h.text().includes('扫描预算已用尽'))
  assert.ok(h.text().includes('收窄'))
  assert.ok(h.text().includes('hit.txt'))
})

test('format change reissues backend query before limit; keyboard and preview still operate', async t => {
  const h = await mount(t)
  await h.type('needle')
  await h.flush()
  await h.resolve(0, result([item('one.txt'), item('two.txt')]))
  assert.equal(h.previews.length, 1)
  await h.run(() => h.input().props.onKeyDown({ key: 'ArrowDown', preventDefault() {} }))
  assert.equal(h.previews.length, 2)
  await h.run(() => h.previews[0].resolve({ kind: 'text', text: 'OLD', matchLines: [] }))
  assert.ok(!h.text().includes('OLD'))
  await h.run(() => h.previews[1].resolve({ kind: 'text', text: 'CURRENT', matchLines: [1] }))
  assert.ok(h.text().includes('CURRENT'))
  await h.run(() => h.input().props.onKeyDown({ key: 'Enter', preventDefault() {} }))
  assert.equal(h.opened[0].name, 'two.txt')
  await h.run(() => h.button('文档').props.onClick())
  await h.flush()
  assert.equal(h.requests[1].args[7], 'document')
})

test('incomplete zero matches and cancellation do not claim no matches', async t => {
  const h = await mount(t)
  await h.type('needle')
  await h.flush()
  await h.resolve(0, result([], {
    incomplete: true,
    warnings: [{ code: 'budget', message: '尚未完成扫描' }],
  }))
  assert.ok(h.text().includes('尚未完成扫描'))
  assert.ok(!h.text().includes('没有找到匹配'))
  await h.type('again')
  await h.flush()
  await h.run(() => h.requests[1].reject({ code: 'cancelled', message: '搜索已取消' }))
  assert.ok(h.text().includes('搜索已取消'))
  assert.ok(!h.text().includes('没有找到匹配'))
})


const rowEvent = (button = false) => ({
  target: { closest: () => button ? {} : null },
  preventDefault() {},
  stopPropagation() { this.stopped = true },
})

async function showResults(t, items, props) {
  const h = await mount(t, props)
  await h.type('needle')
  await h.flush()
  await h.resolve(0, result(items))
  return h
}

test('single click selects and previews without opening; Enter and context Open retain explicit activation', async t => {
  const h = await showResults(t, [item('one.txt'), item('two.txt')])
  await h.run(() => h.rows()[1].props.onClick(rowEvent()))
  assert.deepEqual(h.opened, [])
  assert.deepEqual(h.closed, [])
  assert.ok(h.rows()[1].props.className.endsWith(' on'))
  assert.equal(h.previews.length, 2)
  await h.run(() => h.input().props.onKeyDown({ key: 'Enter', preventDefault() {} }))
  assert.equal(h.opened[0].name, 'two.txt')
  assert.equal(h.closed.length, 1)
  await h.run(() => h.rows()[0].props.onContextMenu({ ...rowEvent(), clientX: 0, clientY: 0 }))
  const menu = h.root.find(n => !!n.props.menu?.items).props.menu
  await h.run(() => menu.items.find(n => n.label === '打开').action())
  assert.equal(h.opened[1].name, 'one.txt')
})

for (const is_dir of [false, true]) {
  test(`double click locates the containing directory and selects a ${is_dir ? 'folder' : 'file'} result`, async t => {
    const entry = { ...item('报告 [一] '), is_dir }
    const h = await showResults(t, [entry], { mode: 'name' })
    await h.run(() => h.rows()[0].props.onDoubleClick?.(rowEvent()))
    assert.deepEqual(h.located, [[entry.dir, entry.path]])
    assert.equal(h.closed.length, 1)
    assert.deepEqual(h.opened, [])
  })
}

test('copy and reveal buttons keep their actions without double-click navigation or starting a drag', async t => {
  const entry = item()
  const h = await showResults(t, [entry], { mode: 'name' })
  const row = h.rows()[0]
  for (const button of row.findAllByType('button')) {
    const down = { ...rowEvent(true), button: 0, clientX: 0, clientY: 0 }
    await h.run(() => {
      button.props.onMouseDown?.(down)
      if (!down.stopped) row.props.onMouseDown(down)
      button.props.onClick(rowEvent(true))
      const double = rowEvent(true)
      button.props.onDoubleClick?.(double)
      if (!double.stopped) row.props.onDoubleClick?.(double)
      window.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 20, clientY: 0 }))
    })
  }
  assert.deepEqual(h.copied, [entry.path])
  assert.deepEqual(h.revealed, [entry.path])
  assert.deepEqual(h.located, [])
  assert.deepEqual(h.opened, [])
  assert.deepEqual(h.closed, [])
  assert.deepEqual(h.drags, [])
})

test('native drag suppresses the following click and double click; a later gesture can locate', async t => {
  const entry = item()
  const h = await showResults(t, [entry], { mode: 'name' })
  await h.run(() => {
    h.rows()[0].props.onMouseDown({ button: 0, clientX: 0, clientY: 0 })
    window.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 20, clientY: 0 }))
  })
  assert.deepEqual(h.drags[0][0], [entry.path])
  await h.run(() => h.drag.resolve())
  await h.run(() => {
    h.rows()[0].props.onClick(rowEvent())
    h.rows()[0].props.onDoubleClick?.(rowEvent())
  })
  assert.deepEqual(h.opened, [])
  assert.deepEqual(h.located, [])
  assert.deepEqual(h.closed, [])
  await h.flush()
  await h.run(() => h.rows()[0].props.onDoubleClick?.(rowEvent()))
  assert.deepEqual(h.located, [[entry.dir, entry.path]])
})
