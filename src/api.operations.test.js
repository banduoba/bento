import test from 'node:test'
import assert from 'node:assert/strict'
import { api as browserApi, operationApi } from './api.js'
import { createOperationClient } from './operations/client.js'

test('production operation API wires queue lifecycle, ACK and exit drain using canonical native command payloads',async()=>{
  const calls=[],jobs=[]
  const queue=()=>({sessionId:'native',revision:jobs.length+1,jobs:[...jobs],busy:false,accepting:true,latestUndoId:jobs.length?'u1':null})
  const api=operationApi(async(command,args)=>{
    calls.push([command,args])
    if(command==='list_operation_jobs'||command==='prepare_operation_exit')return queue()
    if(command==='list_operation_recoveries')return[]
    if(command==='enqueue_operation'){
      const {request}=args
      const job={sessionId:'native',jobId:'j1',revision:1,requestId:request.requestId,kind:request.kind,state:'completed',phase:'finished',ownerTabId:request.ownerTabId,clipRevision:null,intent:request.intent,cancelRequested:false,cancelability:'immediate',progress:{itemsFinished:1,itemsTotal:1,bytesDone:'0',bytesTotal:null,currentItemId:null,currentPath:null},conflict:null,outcomeCount:1,undoId:'u1',error:null}
      jobs.push(job);return job
    }
    if(command==='get_operation_outcomes')return{sessionId:'native',jobId:'j1',revision:1,offset:0,total:1,outcomes:[{itemId:'i1',source:'/src/ spaced ',requestedDestination:'/dest ',actualDestination:'/dest / spaced ',status:'succeeded',effectId:'e1',published:true,sourceDisposition:'unchanged',retry:'none',error:null,affectedDirectories:['/dest ']}]}
    if(command==='ack_operation_outcomes')return
    assert.fail(`unexpected native command ${command}`)
  })
  const client=createOperationClient({api,listen:async()=>()=>{}})
  const request={requestId:'req1',kind:'copy',items:[{itemId:'i1',source:'/src/ spaced '}],destination:'/dest ',options:{keepBoth:true},ownerTabId:'t1',intent:'duplicate'}
  await client.enqueue(request);await client.idle();await client.prepareExit(true)
  assert.deepEqual(calls.find(([name])=>name==='enqueue_operation'),['enqueue_operation',{request}])
  assert.deepEqual(calls.find(([name])=>name==='ack_operation_outcomes'),['ack_operation_outcomes',{jobId:'j1',revision:1,outcomeCount:1}])
  assert.deepEqual(calls.find(([name])=>name==='get_operation_outcomes'),['get_operation_outcomes',{jobId:'j1',offset:0,limit:200}])
  assert.deepEqual(calls.at(-1),['prepare_operation_exit',{cancelRemaining:true}])
  client.dispose()
})


test('browser operation submission timestamp precedes execution completion and remains stable on replay', async t => {
  let now = 1793453096000
  t.mock.method(Date, 'now', () => now)
  const request = { requestId: 'timestamp-demo', kind: 'copy', items: [{ itemId: 'i1', source: '/Users/demo/notes.txt' }], destination: '/Users/demo/Downloads' }
  const pending = browserApi.enqueueOperation(request)
  now += 60000
  const accepted = await pending
  assert.equal(accepted.submittedAtMs, 1793453096000)
  assert.equal((await browserApi.getOperationJob(accepted.jobId)).submittedAtMs, 1793453096000)
  assert.equal((await browserApi.enqueueOperation(request)).submittedAtMs, 1793453096000)
  assert.equal((await browserApi.listOperationJobs()).jobs[0].submittedAtMs, 1793453096000)
})
