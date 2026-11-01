import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, deferred } from './test/AppHarness.js'
import { operationBoundary, outcome } from './test/OperationBoundary.js'

const trigger = h => h.root.findAllByType('button').find(n => n.props['aria-expanded'] !== undefined)
const details = h => h.root.findAllByProps({ 'aria-label': '文件操作队列' })
const text = node => node.children.map(child => typeof child === 'string' ? child : text(child)).join('')
const submit = h => h.run(() => h.panes[0].props.onDropTransfer('/dest', ['/src/a'], 'copy'))
const open = h => h.run(() => trigger(h).props.onClick())
const button = (h, label) => h.root.findAllByType('button').find(n => text(n) === label)

test('quiet tasks stay compact in the status bar during normal submission and progress', async t => {
  const b = operationBoundary(), h = await mountApp(t, b.api)
  const bar = h.root.findByProps({ className: 'statusbar' })
  assert.ok(bar.findAllByType('button').includes(trigger(h)), 'task entry belongs in the status bar')
  assert.equal(text(trigger(h)), '任务')
  await submit(h)
  assert.equal(details(h).length, 0)
  assert.equal(trigger(h).props['aria-expanded'], false)
  assert.match(text(trigger(h)), /1/)
  await b.emit(h, 'j1', { state: 'running', phase: 'copying', progress: { ...b.jobs.get('j1').progress, bytesDone: '50', bytesTotal: '100', currentPath: '/private/path' } })
  assert.match(text(trigger(h)), /50%/)
  assert.doesNotMatch(text(bar), /\/src|\/dest|\/private/)
  await open(h)
  assert.equal(details(h).length, 1)
  assert.match(text(details(h)[0]), /源：\/src\/a/)
  await h.run(() => button(h, '取消任务').props.onClick())
  assert.deepEqual(b.calls.find(c => c[0] === 'cancel'), ['cancel', 'j1'])
})

for (const state of ['completed', 'cancelled']) test(`quiet ${state} work collapses only after settlement; manually opened idle history stays open`, async t => {
  const b = operationBoundary(), h = await mountApp(t, b.api)
  await submit(h)
  if (!trigger(h).props['aria-expanded']) await open(h)
  await b.emit(h, 'j1', { state, phase: 'finished' }, state === 'completed' ? [outcome()] : [])
  assert.equal(details(h).length, 0, 'settled work should release browsing space')
  assert.equal(text(trigger(h)), '任务')
  await open(h)
  assert.equal(details(h).length, 1)
  const id = h.panes[0].props.pane.tabs[0].id
  await h.run(() => h.panes[0].props.onNav(id, '/elsewhere'))
  assert.equal(details(h).length, 1, 'idle history was explicitly opened')
})

test('quiet terminal results remain busy and open until outcome synchronization finishes', async t => {
  const b = operationBoundary(), gate = deferred()
  t.after(() => gate.resolve())
  const h = await mountApp(t, { ...b.api, getOperationOutcomes: async (...args) => { await gate.promise; return b.api.getOperationOutcomes(...args) } })
  await submit(h)
  if (!trigger(h).props['aria-expanded']) await open(h)
  await b.emit(h, 'j1', { state: 'completed', phase: 'finished' }, [outcome()])
  assert.equal(details(h).length, 1)
  assert.match(text(trigger(h)), /同步/)
  assert.equal(button(h, '撤销').props.disabled, true)
  await h.run(async () => { gate.resolve(); await new Promise(resolve => setImmediate(resolve)) })
  assert.equal(details(h).length, 0)
})

test('quiet unknown submissions remain discoverable and retryable without opening history automatically', async t => {
  const b = operationBoundary()
  let unknown = true
  const h = await mountApp(t, { ...b.api, enqueueOperation: request => unknown ? Promise.reject(Error('reply unavailable')) : b.api.enqueueOperation(request) })
  await submit(h)
  assert.equal(details(h).length, 0)
  assert.match(text(trigger(h)), /提交待确认/)
  await open(h)
  assert.equal(button(h, '撤销').props.disabled, true)
  unknown = false
  await h.run(() => button(h, '同步并重试提交').props.onClick())
  assert.equal(b.requests.length, 1)
  assert.equal(details(h).length, 1)
})

for (const state of ['failed', 'partial']) test(`quiet ${state} work signals attention and preserves manual retry access`, async t => {
  const b = operationBoundary(), h = await mountApp(t, b.api)
  await submit(h)
  await b.emit(h, 'j1', { state, phase: 'finished' }, [outcome({ status: 'failed', retry: 'retryItem', error: { message: 'denied' }, published: false, effectId: null, affectedDirectories: [] })])
  assert.equal(details(h).length, 0)
  assert.match(text(trigger(h)), /待处理/)
  await open(h)
  await h.run(() => button(h, '重试未完成项目').props.onClick())
  assert.equal(b.requests.length, 2)
  await b.emit(h, 'j2', { state: 'completed', phase: 'finished' }, [outcome()])
  assert.equal(details(h).length, 1, 'unresolved history still needs attention')
})

test('quiet recovery and sync failures remain visible through the compact entry', async t => {
  const b = operationBoundary(), h = await mountApp(t, { ...b.api, listOperationRecoveries: async () => [{ recoveryId: 'r1', description: '原文件待恢复', actions: ['restoreBackup'] }] })
  assert.equal(details(h).length, 0)
  assert.match(text(trigger(h)), /1 项待恢复/)
  await open(h)
  assert.ok(button(h, '恢复受保护的原文件'))
  await h.run(() => button(h, '收起').props.onClick())
  h.api.listOperationJobs = async () => { throw Error('sync unavailable') }
  await open(h)
  await h.run(() => button(h, '同步').props.onClick())
  await h.run(() => button(h, '收起').props.onClick())
  assert.match(text(trigger(h)), /操作异常/)
})
