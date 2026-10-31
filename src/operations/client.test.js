import test from 'node:test'
import assert from 'node:assert/strict'
import { createOperationClient } from './client.js'
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
export const job=(extra={})=>({sessionId:'s1',jobId:'j1',revision:1,requestId:'r1',kind:'copy',state:'queued',phase:'preparing',ownerTabId:'t1',clipRevision:null,intent:'paste',cancelRequested:false,cancelability:'checkpoint',progress:{itemsFinished:0,itemsTotal:1,bytesDone:'0',bytesTotal:null,currentItemId:null,currentPath:null},conflict:null,outcomeCount:0,undoId:null,error:null,...extra})
const queue=(jobs=[],extra={})=>({sessionId:'s1',revision:1,jobs,busy:jobs.some(j=>!['completed','failed','partial','cancelled'].includes(j.state)),accepting:true,latestUndoId:null,...extra})
const outcome=(n)=>({itemId:`i${n}`,source:`/src/${n}`,requestedDestination:'/dst',actualDestination:`/dst/${n}`,status:'succeeded',effectId:`e${n}`,published:true,sourceDisposition:'unchanged',retry:'none',error:null,affectedDirectories:['/dst']})
const request={requestId:'r1',kind:'copy',items:[{itemId:'i1',source:'/src/ spaced '}],destination:'/dst',options:{},intent:'paste',ownerTabId:'t1'}
function harness(overrides={},callbacks={}){
  let emit;const calls=[]
  const api={ackOperationOutcomes:async()=>{},listOperationJobs:async()=>{calls.push('list');return queue()},listOperationRecoveries:async()=>[],getOperationOutcomes:async(jobId,offset)=>({sessionId:'s1',jobId,revision:4,offset,total:1,outcomes:[outcome(1)]}),enqueueOperation:async()=>job(),...overrides}
  const client=createOperationClient({api,listen:async(name,fn)=>{calls.push(name);emit=payload=>fn({payload});return()=>{emit=null}},...callbacks})
  return{client,api,calls,emit:async payload=>{await emit(payload);await client.idle()}}
}
test('listen precedes snapshot; buffered newer events win and terminal jobs cannot revive',async()=>{
  const gate=deferred(),h=harness({listOperationJobs:()=>gate.promise})
  const starting=h.client.start();await Promise.resolve()
  await h.emit(job({revision:4,state:'completed',phase:'finished'}))
  gate.resolve(queue([job({revision:2,state:'running'})]));await starting;await h.client.idle()
  assert.equal(h.calls[0],'operation-changed')
  assert.equal(h.client.getState().jobs[0].state,'completed')
  await h.emit(job({revision:9,state:'running'}))
  await h.emit(job({sessionId:'old',revision:10,state:'failed'}))
  assert.equal(h.client.getState().jobs[0].state,'completed')
  h.client.dispose()
})
test('event before enqueue reply is retained and outcomes are paginated once with bounded details',async()=>{
  const gate=deferred(),pages=[],received=[],settled=[]
  const h=harness({enqueueOperation:()=>gate.promise,getOperationOutcomes:async(jobId,offset,limit)=>{pages.push([offset,limit]);return{sessionId:'s1',jobId,revision:4,offset,total:450,outcomes:Array.from({length:Math.min(limit,450-offset)},(_,i)=>outcome(offset+i))}}},{onOutcomes:(j,rows)=>received.push(...rows),onSettled:(j,summary)=>settled.push([j.state,summary.counts.succeeded])})
  await h.client.start();const submitting=h.client.enqueue(request);await Promise.resolve()
  await h.emit(job({revision:4,state:'partial',phase:'finished',outcomeCount:450}))
  gate.resolve(job());await submitting;await h.client.idle()
  await h.emit(job({revision:4,state:'partial',phase:'finished',outcomeCount:450}))
  assert.equal(h.client.getState().jobs[0].state,'partial')
  assert.deepEqual(pages,[[0,200],[200,200],[400,200]])
  assert.equal(received.length,450);assert.deepEqual(settled,[['partial',450]])
  assert.ok(h.client.getState().jobs[0].details.length<=50)
  h.client.dispose()
})
test('lost enqueue reply reconciles the accepted request without a second write',async()=>{
  let enqueues=0,lists=0
  const h=harness({enqueueOperation:async r=>{assert.equal(r.items[0].source,'/src/ spaced ');enqueues++;throw Error('lost reply')},listOperationJobs:async()=>queue(++lists>1?[job({state:'running'})]:[])})
  await h.client.start();const accepted=await h.client.enqueue(request)
  assert.equal(accepted.jobId,'j1');assert.equal(enqueues,1)
  h.client.dispose()
})
test('stale conflict answer refreshes current prompt and cancellation is per job',async()=>{
  const conflict={conflictId:'c2',revision:3,jobId:'j1',itemId:'i1',source:'/src/a',destination:'/dst/a',sourceKind:'file',destinationKind:'file',reason:'exists',allowedDecisions:['skip','keepBoth','cancel']}
  let answer,cancelled
  const h=harness({getOperationJob:async()=>job({revision:3,state:'waitingConflict',conflict}),resolveOperationConflict:async(...args)=>{answer=args;throw Error('stale conflict')},cancelOperation:async id=>{cancelled=id;return job({revision:4,state:'cancelled',phase:'finished'})}})
  await h.client.start()
  await h.client.resolve('j1',{...conflict,conflictId:'old',revision:2},'skip',true)
  assert.deepEqual(answer,['j1','old',2,'skip',true]);assert.equal(h.client.getState().jobs[0].conflict.conflictId,'c2')
  await h.client.cancel('j1');assert.equal(cancelled,'j1');assert.equal(h.client.getState().jobs[0].state,'cancelled')
  h.client.dispose()
})
test('undo uses only the backend top id, blocks while busy, and retains partial undo for retry',async()=>{
  let latest='u1',jobs=[],requests=[]
  const h=harness({listOperationJobs:async()=>queue(jobs,{revision:requests.length+1,latestUndoId:latest}),undoOperation:async(id,requestId)=>{requests.push([id,requestId]);return job({jobId:`undo${requests.length}`,requestId,kind:'undo',state:'queued'})}})
  await h.client.start();await h.client.undo()
  await assert.rejects(h.client.undo(),/任务/)
  jobs=[job({jobId:'undo1',kind:'undo',state:'partial',phase:'finished',revision:2})]
  await h.client.resync();await h.client.undo()
  assert.equal(requests.length,2);assert.equal(requests[1][0],'u1');assert.notEqual(requests[0][1],requests[1][1])
  h.client.dispose()
})
test('terminal outcomes are acknowledged only after consumer handling, and retry after failed ACK never replays effects',async()=>{
  const gate=deferred(),calls=[];let fail=true
  const h=harness({ackOperationOutcomes:async(...args)=>{calls.push(['ack',...args]);if(fail)throw Error('lost ACK')}},{onOutcomes:async()=>{calls.push('effects');await gate.promise},onSettled:()=>calls.push('settled')})
  await h.client.start()
  const emitting=h.emit(job({revision:5,state:'completed',phase:'finished',outcomeCount:1}))
  await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['effects'])
  gate.resolve();await emitting
  assert.deepEqual(calls,['effects','settled',['ack','j1',5,1]])
  fail=false;await h.client.resync();await h.client.idle()
  assert.deepEqual(calls,['effects','settled',['ack','j1',5,1],['ack','j1',5,1]])
  h.client.dispose()
})
test('a terminal event arriving during a zero-outcome drain still consumes its new outcomes',async()=>{
  const rows=[];const h=harness({}, {onOutcomes:(j,items)=>rows.push(...items)})
  await h.client.start()
  // Same JS turn: queued accept starts an empty drain, immediately followed by terminal event.
  h.api.enqueueOperation=async()=>job()
  const submitting=h.client.enqueue(request)
  await Promise.resolve()
  const first=h.emit(job({revision:2,state:'running'}))
  const second=h.emit(job({revision:3,state:'completed',phase:'finished',outcomeCount:1}))
  await Promise.all([submitting,first,second]);await h.client.idle()
  assert.equal(rows.length,1)
  h.client.dispose()
})
test('large pre-snapshot event bursts retain the latest snapshot for each job',async()=>{
  const gate=deferred(),h=harness({listOperationJobs:()=>gate.promise})
  const starting=h.client.start();await Promise.resolve()
  for(let revision=1;revision<=300;revision++)await h.emit(job({revision,state:'running'}))
  await h.emit(job({revision:301,state:'cancelled',phase:'finished'}))
  gate.resolve(queue([job()]));await starting;await h.client.idle()
  assert.equal(h.client.getState().jobs[0].state,'cancelled')
  h.client.dispose()
})
test('ZIP passwords stay out of observable requests, errors and rejected submission messages',async()=>{
  const h=harness({enqueueOperation:async()=>{throw Error('failed running zip secret-password')}})
  await h.client.start()
  await assert.rejects(h.client.enqueue({...request,kind:'zip',options:{password:'secret-password'}}),error=>!String(error).includes('secret-password'))
  assert.equal(JSON.stringify(h.client.getState()).includes('secret-password'),false)
  h.client.dispose()
})
test('undo waits until terminal outcomes have reached effects even though native execution is idle',async()=>{
  const gate=deferred(),h=harness({getOperationOutcomes:()=>gate.promise,listOperationJobs:async()=>queue([],{latestUndoId:'u1'})})
  await h.client.start()
  const emitting=h.emit(job({revision:4,state:'completed',phase:'finished',outcomeCount:1}))
  await new Promise(r=>setImmediate(r))
  await assert.rejects(h.client.undo(),/任务/)
  gate.resolve({sessionId:'s1',jobId:'j1',revision:4,offset:0,total:1,outcomes:[outcome(1)]});await emitting
  h.client.dispose()
})
test('lost undo reply reconciles the accepted job using its original request id',async()=>{
  let accepted=null,attempts=0
  const h=harness({listOperationJobs:async()=>queue(accepted?[accepted]:[],{revision:accepted?2:1,latestUndoId:'u1'}),undoOperation:async(undoId,requestId)=>{attempts++;accepted=job({jobId:'undo1',kind:'undo',requestId,state:'running'});throw Error('lost reply')}})
  await h.client.start();await h.client.undo()
  assert.equal(attempts,1);assert.equal(h.client.getState().jobs[0].kind,'undo')
  assert.deepEqual(h.client.getState().pendingSubmissions,[])
  h.client.dispose()
})
test('a new native session discards old in-flight pages and never restarts their fetch loop',async()=>{
  const gate=deferred();let reads=0
  const h=harness({getOperationOutcomes:()=>{reads++;return reads===1?gate.promise:Promise.reject(Error('unexpected old page retry'))}})
  await h.client.start()
  const emitting=h.emit(job({revision:2,state:'running',outcomeCount:1}))
  await Promise.resolve()
  h.api.listOperationJobs=async()=>queue([],{sessionId:'s2',revision:1})
  await h.client.resync()
  gate.resolve({sessionId:'s1',jobId:'j1',revision:2,offset:0,total:1,outcomes:[outcome(1)]})
  await emitting;await new Promise(r=>setImmediate(r))
  assert.equal(reads,1);assert.equal(h.client.getState().sessionId,'s2');assert.deepEqual(h.client.getState().jobs,[])
  h.client.dispose()
})
test('retry waits for a settled terminal job and includes only safe retryItem outcomes',async()=>{
  const h=harness({getOperationOutcomes:async(jobId,offset)=>({sessionId:'s1',jobId,revision:5,offset,total:3,outcomes:[outcome(1),{...outcome(2),status:'failed',effectId:null,published:false,retry:'retryItem'},{...outcome(3),status:'partial',sourceDisposition:'cleanupIncomplete',retry:'finishSourceCleanup'}]})})
  const submitted=[];h.api.enqueueOperation=async r=>{submitted.push(r);return job({requestId:r.requestId,jobId:`j${submitted.length}`})}
  await h.client.start();await h.client.enqueue({...request,items:[1,2,3].map(n=>({itemId:`i${n}`,source:`/src/${n}`}))})
  await h.emit(job({revision:2,state:'running',outcomeCount:3}))
  await assert.rejects(h.client.retry('j1'),/任务/)
  await h.emit(job({revision:5,state:'partial',phase:'finished',outcomeCount:3}))
  await h.client.retry('j1')
  assert.deepEqual(submitted.at(-1).items,[{itemId:'i2',source:'/src/2'}])
  h.client.dispose()
})
test('definitive admission rejection retires enqueue, undo and recovery descriptors without poisoning idle state',async()=>{
  for(const kind of ['copy','undo','recovery']){
    const rejection={code:'admissionRejected',message:`invalid ${kind}`,phase:'preparing'}
    const h=harness({listOperationJobs:async()=>queue([],{latestUndoId:'u1'}),enqueueOperation:async()=>{throw rejection},undoOperation:async()=>{throw rejection},recoverOperation:async()=>{throw rejection}})
    await h.client.start()
    const submitting=kind==='copy'?h.client.enqueue(request):kind==='undo'?h.client.undo():h.client.recover('safe1','restoreBackup')
    await assert.rejects(submitting,error=>error.code==='admissionRejected'&&error.message===`invalid ${kind}`)
    assert.deepEqual(h.client.getState().pendingSubmissions,[])
    assert.equal(h.client.getState().busy,false)
    assert.equal(h.client.getState().error,`invalid ${kind}`)
    h.client.dispose()
  }
})
test('an empty snapshot after unknown transport rejection preserves the same uncertain request for retry',async()=>{
  const seen=[];let fail=true
  const h=harness({enqueueOperation:async r=>{seen.push(r);if(fail)throw Error('transport unavailable');return job({requestId:r.requestId})}})
  await h.client.start();await assert.rejects(h.client.enqueue(request),/transport/)
  assert.equal(h.client.getState().busy,true)
  assert.deepEqual(h.client.getState().pendingSubmissions,[{requestId:'r1',kind:'copy'}])
  fail=false;await h.client.retrySubmission('r1')
  assert.equal(seen[0],seen[1]);assert.equal(seen[1].requestId,'r1')
  h.client.dispose()
})
test('a terminal event during an older queue-summary request schedules a trailing fresh summary',async()=>{
  const gate=deferred();let lists=0
  const h=harness({listOperationJobs:async()=>{
    lists++
    if(lists===1)return queue()
    if(lists===2)return gate.promise
    return queue([job({revision:3,state:'completed',phase:'finished',undoId:'u1'})],{revision:3,latestUndoId:'u1',accepting:false})
  }})
  await h.client.start();await h.client.enqueue(request)
  const stale=h.client.resync()
  await h.emit(job({revision:3,state:'completed',phase:'finished',undoId:'u1'}))
  gate.resolve(queue([job({revision:2,state:'running'})],{revision:2,latestUndoId:null,accepting:true}))
  await stale
  assert.equal(lists,3)
  assert.equal(h.client.getState().jobs[0].state,'completed')
  assert.equal(h.client.getState().latestUndoId,'u1')
  assert.equal(h.client.getState().accepting,false)
  h.client.dispose()
})
