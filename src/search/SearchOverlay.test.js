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
              ? 'export const fmtDate=value=>`date:${value}`; export const fmtSize=value=>`${value} B`; export const copyText=path=>globalThis.__searchTest.copyText(path)'
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
    '__searchTest', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
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

  let next = 0, now = 0
  const timers = new Map()
  globalThis.setTimeout = (fn, delay = 0) => { timers.set(++next, { fn, due: now + delay }); return next }
  globalThis.clearTimeout = id => timers.delete(id)
  globalThis.setInterval = (fn, delay) => { timers.set(++next, { fn, due: now + delay, interval: delay }); return next }
  globalThis.clearInterval = id => timers.delete(id)
  const advance = async ms => act(async () => {
    const target = now + ms
    while (true) {
      const entry = [...timers].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due)[0]
      if (!entry) break
      const [id, timer] = entry
      now = timer.due
      if (timer.interval) timer.due += timer.interval
      else timers.delete(id)
      timer.fn()
      await Promise.resolve()
    }
    now = target
  })
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
    select: label => renderer.root.findAllByType('select').find(n => n.props['aria-label'] === label),
    button: label => renderer.root.findAllByType('button').find(n => n.children.join('') === label),
    async type(q) {
      await run(() => renderer.root.findByType('input').props.onChange({ target: { value: q } }))
    },
    advance,
    pendingTimeouts: () => [...timers.values()].filter(timer => !timer.interval).length,
    flush: () => advance(props.mode === 'name' ? 120 : 250),
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
  assert.deepEqual(h.located, [['/work', '/work/two.txt']])
  assert.deepEqual(h.opened, [])
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

for (const is_dir of [false, true]) {
  test(`single click ${is_dir ? 'opens a folder' : 'locates and selects a file'} result; hover only previews`, async t => {
    const entry = { ...item('报告 [一] '), is_dir }
    const h = await showResults(t, [item('one.txt'), entry])
    await h.run(() => h.rows()[1].props.onMouseEnter())
    assert.ok(h.rows()[1].props.className.endsWith(' on'))
    assert.equal(h.previews.length, 2)
    assert.deepEqual(h.located, [])
    assert.deepEqual(h.closed, [])
    await h.run(() => h.rows()[1].props.onClick(rowEvent()))
    assert.deepEqual(h.located, is_dir ? [] : [[entry.dir, entry.path]])
    assert.equal(h.closed.length, 1)
    assert.deepEqual(h.opened, is_dir ? [entry] : [])
  })
  test(`Enter ${is_dir ? 'opens a folder' : 'locates and selects a file'} result`, async t => {
    const entry = { ...item('报告 [一] '), is_dir }
    const h = await showResults(t, [item('one.txt'), entry], { mode: 'name' })
    await h.run(() => h.input().props.onKeyDown({ key: 'ArrowDown', preventDefault() {} }))
    await h.run(() => h.input().props.onKeyDown({ key: 'Enter', preventDefault() {} }))
    assert.deepEqual(h.located, is_dir ? [] : [[entry.dir, entry.path]])
    assert.equal(h.closed.length, 1)
    assert.deepEqual(h.opened, is_dir ? [entry] : [])
  })
}

test('explicit context Open opens the item and closes without locating', async t => {
  const entry = item()
  const h = await showResults(t, [entry])
  await h.run(() => h.rows()[0].props.onContextMenu({ ...rowEvent(), clientX: 0, clientY: 0 }))
  const menu = h.root.find(n => !!n.props.menu?.items).props.menu
  await h.run(() => menu.items.find(n => n.label === '打开').action())
  assert.deepEqual(h.opened, [entry])
  assert.deepEqual(h.located, [])
  assert.equal(h.closed.length, 1)
})

for (const is_dir of [false, true]) {
  test(`double click ${is_dir ? 'opens a folder' : 'locates and selects a file'} result`, async t => {
    const entry = { ...item('报告 [一] '), is_dir }
    const h = await showResults(t, [entry], { mode: 'name' })
    await h.run(() => h.rows()[0].props.onDoubleClick?.(rowEvent()))
    assert.deepEqual(h.located, is_dir ? [] : [[entry.dir, entry.path]])
    assert.equal(h.closed.length, 1)
    assert.deepEqual(h.opened, is_dir ? [entry] : [])
  })
}

for (const mode of ['name', 'content']) for (const is_dir of [false, true]) {
  test(`${mode} copy and reveal keep ${is_dir ? 'folder' : 'file'} actions without activation or drag`, async t => {
  const entry = { ...item(), is_dir }
  const h = await showResults(t, [entry], { mode })
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
}

for (const is_dir of [false, true]) {
  test(`native drag suppresses ${is_dir ? 'folder opening' : 'file location'} until a later gesture`, async t => {
  const entry = { ...item(), is_dir }
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
  assert.deepEqual(h.located, is_dir ? [] : [[entry.dir, entry.path]])
  assert.deepEqual(h.opened, is_dir ? [entry] : [])
})
}

test('direct scope and format controls keep every choice one click away', async t => {
  const scopes = [], modes = [], sorts = []
  const h = await mount(t, {
    mode: 'name',
    onScopeChange: value => scopes.push(value),
    onModeChange: value => modes.push(value),
    onSortChange: value => sorts.push(value),
  })
  const group = label => h.root.find(n => n.props.role === 'group' && n.props['aria-label'] === label)
  assert.deepEqual(group('搜索范围').findAllByType('button').map(n => n.children.join('')), ['全局', '当前文件夹', '主目录'])
  for (const label of ['全局', '当前文件夹', '主目录']) await h.run(() => h.button(label).props.onClick())
  assert.deepEqual(scopes, ['global', 'pane', 'home'])
  for (const label of ['内容', '名称']) await h.run(() => h.button(label).props.onClick())
  assert.deepEqual(modes, ['content', 'name'])
  assert.deepEqual(h.select('结果排序').findAllByType('option').map(n => n.props.value), ['btime', 'mtime', 'size', 'name', 'score'])
  for (const value of ['btime', 'mtime', 'size', 'name', 'score']) await h.run(() => h.select('结果排序').props.onChange({ target: { value } }))
  assert.deepEqual(sorts, ['btime', 'mtime', 'size', 'name', 'score'])
  assert.deepEqual(group('结果格式过滤').findAllByType('button').map(n => n.children.join('')), ['全部', '文件夹', '图片', '文档', '表格', '演示', '视频', '压缩包'])
  await h.type('needle')
  await h.flush()
  for (const [label, id] of [['文件夹', 'folder'], ['图片', 'image'], ['文档', 'document'], ['表格', 'spreadsheet'], ['演示', 'presentation'], ['视频', 'video'], ['压缩包', 'archive'], ['全部', 'all']]) {
    await h.resolve(h.requests.length - 1, result([item('one.txt'), item('two.txt')]))
    await h.run(() => h.input().props.onKeyDown({ key: 'ArrowDown', preventDefault() {} }))
    await h.run(() => h.rows()[1].props.onContextMenu({ ...rowEvent(), clientX: 0, clientY: 0 }))
    await h.run(() => h.button(label).props.onClick())
    assert.equal(h.root.findAll(n => !!n.props.menu?.items).length, 0)
    await h.flush()
    assert.equal(h.requests.at(-1).args[7], id)
    await h.resolve(h.requests.length - 1, result([item('one.txt'), item('two.txt')]))
    assert.ok(h.rows()[0].props.className.endsWith(' on'))
    assert.ok(!h.rows()[1].props.className.endsWith(' on'))
    assert.equal(h.button(label).props['aria-pressed'], true)
  }
})

test('scope buttons issue the selected scope and clear selection and stale context actions', async t => {
  const scopes = []
  const h = await showResults(t, [item('one.txt'), item('two.txt')], {
    mode: 'name', onScopeChange: scope => scopes.push(scope),
  })
  for (const [label, scope] of [['主目录', 'home'], ['全局', 'global'], ['当前文件夹', 'pane']]) {
    await h.run(() => h.rows()[1].props.onContextMenu({ ...rowEvent(), clientX: 0, clientY: 0 }))
    await h.run(() => h.button(label).props.onClick())
    assert.equal(h.root.findAll(n => !!n.props.menu?.items).length, 0)
    await h.update({ scope })
    await h.flush()
    assert.equal(h.requests.at(-1).args[1], scope)
    assert.equal(h.requests.at(-1).args[2], scope === 'pane' ? '/work' : null)
    await h.resolve(h.requests.length - 1, result([item('one.txt'), item('two.txt')]))
    assert.ok(h.rows()[0].props.className.endsWith(' on'))
    assert.ok(!h.rows()[1].props.className.endsWith(' on'))
  }
  assert.deepEqual(scopes, ['home', 'global', 'pane'])
})

test('name table date heading and values follow the selected date sort', async t => {
  const h = await showResults(t, [{ ...item(), btime_ms: 101, mtime_ms: 202 }], { mode: 'name', sortBy: 'btime' })
  const dateHeading = () => h.root.find(n => n.props.className === 'search-column-date').children.join('')
  const dateValue = () => h.rows()[0].find(n => n.props.className === 'search-date').children.join('')
  assert.equal(dateHeading(), '创建日期')
  assert.equal(dateValue(), 'date:101')
  for (const sortBy of ['mtime', 'size', 'name', 'score']) {
    await h.update({ sortBy })
    assert.equal(dateHeading(), '修改日期')
    assert.equal(dateValue(), 'date:202')
  }
})

test('coverage disclosure preserves full warnings without repeating the summary in separate rows', async t => {
  const h = await mount(t, { mode: 'name' })
  await h.type('needle')
  await h.flush()
  await h.resolve(0, result([item()], {
    incomplete: true,
    truncated: true,
    warnings: [{ code: 'coverage', message: '索引覆盖范围有限，结果可能不完整' }],
  }))
  const notices = h.root.findAllByType('details').filter(n => n.props.className === 'search-coverage')
  assert.equal(notices.length, 1)
  assert.ok(notices[0].findByType('summary').children.join('').includes('截断'))
  assert.equal(h.root.findAll(n => n.type === 'div' && n.children.join('') === '索引覆盖范围有限，结果可能不完整').length, 1)
})


test('Full Disk Access settings action stays directly available outside collapsed coverage details', async t => {
  const h = await mount(t, { mode: 'name' })
  let settingsOpened = 0
  globalThis.__searchTest.fsearchStatus = async () => ({ ready: true, full_disk_access: false })
  globalThis.__searchTest.openPrivacySettings = async () => { settingsOpened++ }
  await h.update({ scope: 'global' })
  await h.type('needle')
  await h.flush()
  await h.resolve(0, result([item()], { incomplete: true }))
  const settings = h.button('打开系统设置')
  assert.ok(settings)
  assert.ok(!settings.props.disabled)
  for (let node = settings.parent; node; node = node.parent) assert.notEqual(node.type, 'details')
  await h.run(() => settings.props.onClick())
  assert.equal(settingsOpened, 1)
  assert.deepEqual(h.located, [])
})


test('an unresolved search times out at eight seconds, cancels once and ignores its late result after retry', async t => {
  const h = await mount(t, { mode: 'name' })
  await h.type('needle')
  await h.flush()
  const firstId = h.requests[0].args[6]
  await h.advance(7999)
  assert.ok(h.text().includes('搜索中'))
  assert.deepEqual(h.cancels, [])
  await h.advance(1)
  assert.ok(h.text().includes('搜索超时'))
  assert.ok(!h.text().includes('搜索中'))
  assert.deepEqual(h.cancels, [firstId])
  await h.run(() => h.button('重试').props.onClick())
  await h.flush()
  assert.equal(h.requests.length, 2)
  assert.ok(h.text().includes('搜索中'))
  await h.resolve(0, result([item('late.txt')]))
  assert.ok(!h.text().includes('late.txt'))
  assert.ok(h.text().includes('搜索中'))
  await h.resolve(1, result([item('retried.txt')]))
  assert.equal(h.pendingTimeouts(), 0)
  assert.ok(h.text().includes('retried.txt'))
  await h.advance(8000)
  assert.ok(!h.text().includes('搜索超时'))
  assert.deepEqual(h.cancels, [firstId])
})

test('superseding and closing searches clear their watchdogs', async t => {
  const h = await mount(t, { mode: 'name' })
  await h.type('old')
  await h.flush()
  await h.advance(4000)
  await h.type('new')
  assert.equal(h.pendingTimeouts(), 1)
  await h.flush()
  assert.equal(h.pendingTimeouts(), 1)
  await h.advance(3750)
  assert.ok(h.text().includes('搜索中'))
  assert.ok(!h.text().includes('搜索超时'))
  await h.update({ open: false })
  assert.equal(h.pendingTimeouts(), 0)
  await h.advance(8000)
  assert.ok(!h.text().includes('搜索超时'))
  assert.deepEqual(h.cancels, h.requests.map(r => r.args[6]))
})

test('status polling stays single flight across intervals and reopen, and stale status cannot publish', async t => {
  const h = await mount(t, { mode: 'name' })
  const statuses = []
  globalThis.__searchTest.fsearchStatus = () => {
    const d = deferred()
    statuses.push(d)
    return d.promise
  }
  await h.update({ scope: 'global' })
  assert.equal(statuses.length, 1)
  await h.advance(6000)
  assert.equal(statuses.length, 1)
  await h.update({ open: false })
  await h.update({ open: true })
  assert.equal(statuses.length, 1)
  await h.run(() => statuses[0].resolve({ ready: false, entries: 99 }))
  assert.ok(!h.text().includes('99'))
  await h.advance(1500)
  assert.equal(statuses.length, 2)
  await h.advance(3000)
  assert.equal(statuses.length, 2)
  await h.run(() => statuses[1].reject(new Error('status unavailable')))
  await h.advance(1500)
  assert.equal(statuses.length, 3)
  await h.update({ open: false })
  await h.advance(6000)
  assert.equal(statuses.length, 3)
})

test('pending index status shows unknown coverage honestly and retains Full Disk Access action', async t => {
  const h = await mount(t, { mode: 'name' })
  globalThis.__searchTest.fsearchStatus = async () => ({ ready: false, entries: 0, full_disk_access: false })
  await h.update({ scope: 'global' })
  assert.ok(h.button('打开系统设置'))
  assert.ok(h.text().includes('名称索引'))
  assert.ok(!h.text().includes('已收录 0'))
  await h.type('needle')
  await h.flush()
  await h.resolve(0, result([item()], { source: 'local+spotlight' }))
  assert.ok(h.text().includes('已显示可用结果'))
  assert.ok(!h.text().includes('当前结果来自系统索引'))
})


for (const is_dir of [false, true]) {
  test(`selected ${is_dir ? 'folder' : 'file'} action hint matches activation and explicit context focus action stays separate`, async t => {
    const entry = { ...item('target'), is_dir }
    const h = await showResults(t, [entry], { mode: 'name' })
    const hint = h.root.find(n => n.props.className === 'search-hint')
    assert.ok(hint.children.join('').includes(is_dir ? '打开文件夹' : '定位'))
    await h.run(() => h.rows()[0].props.onContextMenu({ ...rowEvent(), clientX: 0, clientY: 0 }))
    const menu = h.root.find(n => !!n.props.menu?.items).props.menu
    await h.run(() => menu.items.find(n => n.label === (is_dir ? '在聚焦窗格中打开' : '在聚焦窗格中显示')).action())
    assert.deepEqual(h.located, [[is_dir ? entry.path : entry.dir, is_dir ? null : entry.path]])
    assert.deepEqual(h.opened, [])
    assert.equal(h.closed.length, 1)
  })
}


test('name input submits after 120ms and Chinese composition waits for commit', async t => {
  const h = await mount(t, { mode: 'name' })
  await h.type('RCS')
  await h.advance(119)
  assert.equal(h.requests.length, 0)
  await h.advance(1)
  assert.equal(h.requests.length, 1)
  await h.run(() => h.input().props.onCompositionStart())
  await h.type('RCS曲')
  await h.advance(1000)
  assert.equal(h.requests.length, 1)
  await h.type('RCS曲线')
  await h.run(() => h.input().props.onCompositionEnd())
  await h.advance(120)
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1].args[0], 'RCS曲线')
})

test('partial name results appear before completion and stale progress cannot replace the next query', async t => {
  const h = await mount(t, { mode: 'name' })
  await h.type('RCS')
  await h.flush()
  const progress = h.requests[0].args[8]
  await h.run(() => progress(result([item('RCS-first.txt')])))
  assert.ok(h.text().includes('RCS-first'))
  assert.ok(h.text().includes('补充搜索中'))
  await h.type('next')
  await h.flush()
  await h.run(() => progress(result([item('stale.txt')])))
  assert.ok(!h.text().includes('stale.txt'))
  await h.resolve(1, result([item('next.txt')]))
  assert.ok(h.text().includes('next.txt'))
  assert.ok(!h.text().includes('补充搜索中'))
})

test('late progress after final completion cannot replace final sibling results', async t => {
  const h = await mount(t, { mode:'name' })
  await h.type('RCS'); await h.flush()
  const progress = h.requests[0].args[8]
  await h.resolve(0, result([item('RCS-final.txt'),item('RCS-sibling.txt')]))
  await h.run(() => progress(result([item('RCS-partial.txt')])))
  assert.ok(h.text().includes('RCS-sibling'))
  assert.ok(!h.text().includes('RCS-partial'))
})

test('selected file is preserved by path when later snapshots insert results before it', async t => {
  const h = await mount(t, { mode:'name',sortBy:'name' })
  await h.type('file'); await h.flush()
  await h.run(() => h.requests[0].args[8](result([item('B.txt'),item('C.txt')])))
  await h.run(() => h.input().props.onKeyDown({ key:'ArrowDown',preventDefault(){} }))
  await h.resolve(0, result([item('A.txt'),item('B.txt'),item('C.txt')]))
  await h.run(() => h.input().props.onKeyDown({ key:'Enter',preventDefault(){} }))
  assert.deepEqual(h.located, [['/work','/work/C.txt']])
})
