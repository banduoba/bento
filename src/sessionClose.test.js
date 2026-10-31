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
