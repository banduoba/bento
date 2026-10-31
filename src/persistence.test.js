import test from 'node:test'
import assert from 'node:assert/strict'
import { createSerialSaver } from './persistence.js'
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return {promise,resolve,reject} }
const turn = () => new Promise(r => setImmediate(r))
test('coalesces snapshots and serializes delayed writes, flush waits for newest', async () => {
  const writes = [], gates = []
  const saver = createSerialSaver(async value => { writes.push(value); const gate = deferred(); gates.push(gate); await gate.promise }, { delay: 10 })
  saver.update({ n: 1 }); saver.update({ n: 2 })
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(writes, [{ n: 2 }])
  saver.update({ n: 3 }); saver.update({ n: 4 })
  let done = false
  const flush = saver.flush().then(() => { done=true })
  await turn(); assert.equal(writes.length, 1); assert.equal(done, false)
  gates[0].resolve(); await turn()
  assert.deepEqual(writes, [{ n: 2 }, { n: 4 }]); assert.equal(done, false)
  gates[1].resolve(); await flush
  saver.update({ n: 4 }); await saver.flush(); assert.equal(writes.length, 2)
  saver.dispose()
})
test('failure stays dirty, is visible and retries the latest snapshot', async () => {
  let fail = true; const written = [], errors = []
  const saver = createSerialSaver(async value => { if (fail) throw Error('disk full'); written.push(value) }, { delay: 1000, onError: e => errors.push(e.message) })
  saver.update({ n: 1 })
  await assert.rejects(saver.flush(), /disk full/)
  assert.deepEqual(errors, ['disk full'])
  saver.update({ n: 2 }); fail = false; await saver.flush()
  assert.deepEqual(written, [{ n: 2 }]); saver.dispose()
})
test('a snapshot that returns to its saved value still replaces an in-flight older change', async () => {
  const writes = [], gate = deferred()
  const saver = createSerialSaver(async value => { writes.push(value); if (value.n === 2) await gate.promise }, { delay: 1000 })
  saver.update({ n: 1 }); await saver.flush()
  saver.update({ n: 2 }); const pending = saver.flush(); await turn()
  saver.update({ n: 1 }); gate.resolve(); await pending
  assert.deepEqual(writes, [{n:1},{n:2},{n:1}]); saver.dispose()
})
test('flush includes a snapshot queued while the previous writer promise settles', async () => {
  const writes=[],gate=deferred()
  const saver=createSerialSaver(value=>{writes.push(value);return writes.length===1?gate.promise:Promise.resolve()}, {delay:1000})
  saver.update({n:1});const pending=saver.flush()
  gate.promise.then(()=>queueMicrotask(()=>saver.update({n:2})))
  gate.resolve();await pending
  assert.deepEqual(writes,[{n:1},{n:2}]);saver.dispose()
})
