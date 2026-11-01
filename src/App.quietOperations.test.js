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

const jobRows = h => h.root.findAllByType('article').filter(n => n.props['data-job-id'])
const clearHistory = h => h.run(() => button(h, '清除已结束记录').props.onClick())

for (const resultState of ['completed', 'cancelled', 'failed', 'partial']) test(`manual clear dismisses settled ${resultState} display history and preserves native Undo and later jobs`, async t => {
  const b = operationBoundary(), h = await mountApp(t, b.api)
  await submit(h)
  b.setUndo('saved-undo')
  await b.emit(h, 'j1', { state: resultState, phase: 'finished' }, [outcome({ status: resultState === 'completed' ? 'succeeded' : resultState })])
  await open(h)
  assert.deepEqual(jobRows(h).map(n => n.props['data-job-id']), ['j1'])
  const clear = button(h, '清除已结束记录')
  assert.ok(clear, 'settled history has an explicit clear control')
  assert.equal(clear.props.disabled, false)
  assert.match(clear.props.title, /不.*删除文件/)
  const calls = [...b.calls]
  await clearHistory(h)
  assert.equal(jobRows(h).length, 0)
  assert.equal(button(h, '清除已结束记录').props.disabled, true)
  assert.doesNotMatch(text(trigger(h)), /待处理/)
  assert.deepEqual(b.calls, calls, 'display clearing must not ACK, cancel or mutate native history')
  assert.equal(b.jobs.size, 1)
  await h.run(() => button(h, '收起').props.onClick())
  await open(h)
  await h.run(() => button(h, '同步').props.onClick())
  assert.equal(jobRows(h).length, 0, 'display choices survive closing and authoritative resync')
  assert.equal(button(h, '撤销').props.disabled, false)
  await h.run(() => button(h, '撤销').props.onClick())
  assert.equal(b.calls.find(c => c[0] === 'undo')[1], 'saved-undo')
  await submit(h)
  assert.ok(jobRows(h).some(n => n.props['data-job-id'] === 'j2'), 'new jobs appear after a clear')
})

test('manual clear preserves active, conflict, syncing and uncertain work, recovery controls and global errors', async t => {
  const b = operationBoundary(), gate = deferred()
  t.after(() => gate.resolve())
  for (const [id, state] of [['done', 'completed'], ['queued', 'queued'], ['running', 'running'], ['conflict', 'waitingConflict'], ['syncing', 'completed']]) {
    const j = await b.api.enqueueOperation({ requestId: id, kind: 'copy', items: [{ itemId: 'i0', source: `/src/${id}` }] })
    b.jobs.set(j.jobId, { ...j, state, phase: state === 'completed' ? 'finished' : 'preparing', outcomeCount: id === 'syncing' ? 1 : 0 })
  }
  const h = await mountApp(t, { ...b.api,
    enqueueOperation: async () => { throw Error('uncertain submission') },
    getOperationOutcomes: async (...args) => { await gate.promise; return b.api.getOperationOutcomes(...args) },
    listOperationRecoveries: async () => [{ recoveryId: 'r1', description: '原文件待恢复', actions: ['restoreBackup'] }],
  })
  await submit(h)
  await open(h)
  await clearHistory(h)
  assert.deepEqual(jobRows(h).map(n => n.props['data-job-id']).sort(), ['j2', 'j3', 'j4', 'j5'])
  assert.ok(button(h, '处理冲突'))
  assert.ok(button(h, '同步并重试提交'))
  assert.ok(button(h, '恢复受保护的原文件'))
  assert.match(text(details(h)[0]), /正在同步结果/)
  assert.match(text(trigger(h)), /提交待确认/)
  assert.match(text(trigger(h)), /待恢复/)
  assert.match(text(trigger(h)), /操作异常/)
  assert.equal(button(h, '清除已结束记录').props.disabled, true)
  // Cleanup must not leave the deliberately gated outcome reader looping.
  await h.unmount()
})

test('pending result synchronization cannot be hidden by history pagination', async t => {
  const b = operationBoundary(), gate = deferred()
  t.after(() => gate.resolve())
  for (let index = 0; index < 25; index++) {
    const j = await b.api.enqueueOperation({ requestId: `r${index}`, kind: 'copy', items: [{ itemId: 'i0', source: '/src/a' }] })
    b.jobs.set(j.jobId, { ...j, state: 'completed', phase: 'finished', outcomeCount: index === 0 ? 1 : 0 })
  }
  const h = await mountApp(t, { ...b.api, getOperationOutcomes: async (...args) => { await gate.promise; return b.api.getOperationOutcomes(...args) } })
  await open(h)
  assert.ok(jobRows(h).some(n => n.props['data-job-id'] === 'j1'), 'old syncing results always remain accessible')
  await clearHistory(h)
  assert.deepEqual(jobRows(h).map(n => n.props['data-job-id']), ['j1'])
  await h.unmount()
})

test('job submission time shows local seconds and full date and stays stable through events and rerenders', async t => {
  const b = operationBoundary(), submittedAtMs = new Date(2026, 9, 31, 13, 24, 56).getTime()
  const h = await mountApp(t, { ...b.api, enqueueOperation: async request => {
    const job = await b.api.enqueueOperation(request)
    const stamped = { ...job, submittedAtMs }
    b.jobs.set(job.jobId, stamped)
    return stamped
  } })
  await submit(h)
  await open(h)
  const stamp = () => jobRows(h)[0].findByType('time')
  assert.match(text(stamp()), /13:24:56/)
  assert.match(stamp().props.title, /2026\/10\/31 13:24:56/)
  assert.equal(stamp().props.dateTime, new Date(submittedAtMs).toISOString())
  const original = text(stamp())
  await b.emit(h, 'j1', { state: 'running', phase: 'copying' })
  await h.run(() => button(h, '同步').props.onClick())
  assert.equal(text(stamp()), original)
  await h.run(() => button(h, '收起').props.onClick())
  await open(h)
  assert.equal(text(stamp()), original)
})

test('older snapshots without a submission timestamp do not invent a current time', async t => {
  const b = operationBoundary(), h = await mountApp(t, b.api)
  await submit(h)
  await open(h)
  assert.equal(jobRows(h)[0].findAllByType('time').length, 0)
  assert.match(text(jobRows(h)[0]), /提交时间未知/)
})

test('a settled job with unresolved outcome acknowledgement stays visible when other history is cleared', async t => {
  const b = operationBoundary()
  for (const id of ['ack-error', 'settled']) {
    const job = await b.api.enqueueOperation({ requestId: id, kind: 'copy', items: [{ itemId: 'i0', source: '/src/a' }] })
    b.jobs.set(job.jobId, { ...job, state: 'completed', phase: 'finished' })
  }
  const h = await mountApp(t, { ...b.api, ackOperationOutcomes: async id => {
    if (id === 'j1') throw Error('acknowledgement unavailable')
  } })
  await open(h)
  await clearHistory(h)
  assert.deepEqual(jobRows(h).map(n => n.props['data-job-id']), ['j1'])
  assert.match(text(jobRows(h)[0]), /acknowledgement unavailable/)
  assert.equal(button(h, '清除已结束记录').props.disabled, true)
  assert.match(text(trigger(h)), /操作异常/)
})
