import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionClose } from './sessionClose.js'
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r}); return {promise,resolve} }
test('normal window close is blocked until final flush completes and repeated close shares work', async () => {
  const gate = deferred(); let flushes=0, closes=0
  const c = createSessionClose({ flush: () => {flushes++;return gate.promise}, close: async () => closes++, reply: async () => {}, confirmDiscard: async () => false })
  const a = c.requestClose(), b = c.requestClose()
  assert.equal(flushes, 1); assert.equal(closes, 0)
  gate.resolve(); await Promise.all([a,b]); assert.equal(closes, 1)
})
test('app quit supersedes pending window close and replies only for latest request after flush', async () => {
  const gate = deferred(); const replies=[]; let closes=0
  const c = createSessionClose({flush: () => gate.promise, close: async () => closes++, reply: async (...a) => replies.push(a), confirmDiscard: async () => false})
  const close = c.requestClose(); const quit = c.requestExit(1); c.requestExit(2)
  gate.resolve(); await Promise.all([close,quit])
  assert.equal(closes,0); assert.deepEqual(replies, [[2,true]])
})
test('failed flush offers cancel or discard and can retry after cancellation', async () => {
  let fail=true, confirmations=0; const replies=[]
  const c = createSessionClose({flush: async () => {if(fail)throw Error('disk')}, close: async () => {}, reply: async (...a) => replies.push(a), confirmDiscard: async e => {assert.match(String(e), /disk/); confirmations++;return false}})
  await c.requestExit(1); assert.deepEqual(replies,[[1,false]]); assert.equal(confirmations,1)
  fail=false; await c.requestExit(2); assert.deepEqual(replies,[[1,false],[2,true]])
  const discard=[]
  const d=createSessionClose({flush: async()=>{throw Error('disk')},close:async()=>{},reply:async(...a)=>discard.push(a),confirmDiscard:async()=>true})
  await d.requestExit(3); assert.deepEqual(discard,[[3,true]])
})
test('an old exit event cannot replace the newest pending request', async () => {
  const gate=deferred(),replies=[]
  const c=createSessionClose({flush:()=>gate.promise,close:async()=>{},reply:async(...args)=>replies.push(args),confirmDiscard:async()=>false})
  const pending=c.requestExit(9);c.requestExit(8);c.requestExit(NaN)
  gate.resolve();await pending
  assert.deepEqual(replies,[[9,true]])
})
test('a new quit during an unsettled cancellation reply gets its own final flush and reply', async () => {
  const replyGate = deferred(), replyStarted = deferred()
  const replies = []
  let flushes = 0
  const coordinator = createSessionClose({
    flush: async () => { if (++flushes === 1) throw Error('disk full') },
    close: async () => assert.fail('app quit must not close just the window'),
    reply: async (id, allow) => {
      replies.push([id, allow])
      if (id === 1) { replyStarted.resolve(); await replyGate.promise }
    },
    confirmDiscard: async () => false,
  })
  const first = coordinator.requestExit(1)
  await replyStarted.promise
  const second = coordinator.requestExit(2)
  assert.equal(flushes, 1)
  assert.deepEqual(replies, [[1, false]])
  replyGate.resolve()
  await Promise.all([first, second])
  assert.equal(flushes, 2)
  assert.deepEqual(replies, [[1, false], [2, true]])
})
test('a quit queued at reply settlement is not cleared by pending cleanup', async () => {
  const replyGate = deferred(), replyStarted = deferred()
  const replies = []
  let flushes = 0, second
  let coordinator
  replyGate.promise.then(() => queueMicrotask(() => { second = coordinator.requestExit(2) }))
  coordinator = createSessionClose({
    flush: async () => { if (++flushes === 1) throw Error('disk full') },
    close: async () => assert.fail('app quit must not close just the window'),
    reply: (id, allow) => {
      replies.push([id, allow])
      if (id === 1) { replyStarted.resolve(); return replyGate.promise }
      return Promise.resolve()
    },
    confirmDiscard: async () => false,
  })
  const first = coordinator.requestExit(1)
  await replyStarted.promise
  replyGate.resolve()
  await first
  await second
  assert.equal(flushes, 2)
  assert.deepEqual(replies, [[1, false], [2, true]])
})
test('busy close Continue reopens admission without flushing or showing save-failure confirmation', async()=>{
  const calls=[]
  const c=createSessionClose({flush:async()=>calls.push('flush'),close:async()=>calls.push('close'),reply:async(...a)=>calls.push(a),confirmDiscard:async()=>assert.fail('Continue is not save failure'),operations:{busy:()=>true,choose:async()=>false,prepare:async cancel=>calls.push(['prepare',cancel])}})
  await c.requestExit(1)
  assert.deepEqual(calls,[['prepare',false],[1,false]])
})
test('cancel remaining waits for native drain before session flush and final exit reply',async()=>{
  const gate=deferred(),calls=[]
  const c=createSessionClose({flush:async()=>calls.push('flush'),close:async()=>{},reply:async(...a)=>calls.push(a),confirmDiscard:async()=>false,operations:{busy:()=>true,choose:async()=>true,prepare:async cancel=>{calls.push(['prepare',cancel]);await gate.promise}}})
  const exiting=c.requestExit(2);await new Promise(r=>setImmediate(r))
  assert.deepEqual(calls,[['prepare',true]])
  gate.resolve();await exiting;assert.deepEqual(calls,[['prepare',true],'flush',[2,true]])
})
test('native repeated quit drained event settles the matching pending operations prompt, ignoring old events',async()=>{
  const calls=[],choice=deferred()
  const c=createSessionClose({flush:async()=>calls.push('flush'),close:async()=>{},reply:async(...a)=>calls.push(a),confirmDiscard:async()=>false,operations:{busy:()=>true,choose:()=>choice.promise,prepare:async cancel=>calls.push(['prepare',cancel]),drained:()=>calls.push('drained')}})
  const exiting=c.requestExit(8)
  c.requestDrained(7);await Promise.resolve();assert.deepEqual(calls,[])
  c.requestDrained(8);await exiting
  assert.deepEqual(calls,['drained',['prepare',true],'flush',[8,true]])
})
test('cancel after persistence failure reopens operations admission',async()=>{
  const prepares=[]
  const c=createSessionClose({flush:async()=>{throw Error('disk')},close:async()=>{},reply:async()=>{},confirmDiscard:async()=>false,operations:{busy:()=>false,choose:async()=>assert.fail(),prepare:async flag=>prepares.push(flag)}})
  await c.requestExit(3);assert.deepEqual(prepares,[true,false])
})
test('duplicate drained event after a completed quit cannot flush and reply twice',async()=>{
  let flushes=0;const replies=[]
  const c=createSessionClose({flush:async()=>{flushes++},close:async()=>{},reply:async(...a)=>replies.push(a),confirmDiscard:async()=>false,operations:{busy:()=>false,choose:async()=>true,prepare:async()=>{}}})
  await c.requestExit(5);await c.requestDrained(5)
  assert.equal(flushes,1);assert.deepEqual(replies,[[5,true]])
})
