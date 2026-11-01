import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, deferred } from './test/AppHarness.js'
import { operationBoundary, outcome, key } from './test/OperationBoundary.js'
const openQueue=async h=>{const toggle=h.root.findAllByType('button').find(n=>n.props['aria-expanded']!==undefined);if(!toggle.props['aria-expanded'])await h.run(()=>toggle.props.onClick())}

async function completedMove(t,extra={}) {
  const b=operationBoundary(),h=await mountApp(t,{...b.api,...extra})
  await h.run(()=>h.panes[0].props.onDropTransfer('/dest',['/src/original'],'move'))
  b.setUndo('u-exact')
  await b.emit(h,'j1',{state:'completed',phase:'finished',undoId:'u-exact'},[outcome({source:'/src/original',actualDestination:'/dest/original copy',sourceDisposition:'removed',affectedDirectories:['/src','/dest']})])
  return {b,h}
}
test('App undo uses backend effect id after a collision and refreshes exact original paths from inverse outcomes',async t=>{
  const {b,h}=await completedMove(t)
  await key(h,'z',{metaKey:true})
  const call=b.calls.find(c=>c[0]==='undo')
  assert.equal(call[1],'u-exact');assert.equal(call.length,3)
  const inverse=[...b.jobs.values()].find(j=>j.kind==='undo')
  b.setUndo(null)
  await b.emit(h,inverse.jobId,{state:'completed',phase:'finished'},[outcome({source:'/dest/original copy',actualDestination:'/src/original',sourceDisposition:'removed',affectedDirectories:['/dest','/src']})])
  assert.deepEqual(h.panes[0].props.directoryVersions,{'/src':2,'/dest':2})
})
test('partial undo retries the same server id without replaying completed inverse outcomes',async t=>{
  const {b,h}=await completedMove(t)
  await key(h,'z',{metaKey:true})
  const first=[...b.jobs.values()].find(j=>j.kind==='undo')
  await b.emit(h,first.jobId,{state:'partial',phase:'finished'},[outcome({itemId:'inverse-b',source:'/dest/b',actualDestination:'/src/b',affectedDirectories:['/src','/dest']}),outcome({itemId:'inverse-a',status:'failed',actualDestination:null,effectId:null,published:false,affectedDirectories:[],error:{code:'occupied',phase:'undoing',message:'occupied'}})])
  assert.equal(h.panes[0].props.directoryVersions['/src'],2)
  await key(h,'z',{metaKey:true})
  const calls=b.calls.filter(c=>c[0]==='undo')
  assert.deepEqual(calls.map(c=>c[1]),['u-exact','u-exact']);assert.notEqual(calls[0][2],calls[1][2])
  const second=[...b.jobs.values()].filter(j=>j.kind==='undo').at(-1)
  await b.emit(h,second.jobId,{state:'completed',phase:'finished'},[outcome({itemId:'inverse-a',source:'/dest/a',actualDestination:'/src/a',effectId:'inverse-a',affectedDirectories:['/src','/dest']})])
  assert.equal(h.panes[0].props.directoryVersions['/src'],3)
  assert.equal(h.panes[0].props.operationToast,null)
})
test('rejected undo remains retryable and overlapping key presses admit one undo',async t=>{
  const gate=deferred(),calls=[]
  const {h}=await completedMove(t,{undoOperation:async(...a)=>{calls.push(a);await gate.promise;throw Error('lost undo reply')}})
  await key(h,'z',{metaKey:true});await key(h,'z',{metaKey:true})
  assert.equal(calls.length,1)
  await h.run(async()=>{gate.resolve();await new Promise(r=>setImmediate(r))})
  await openQueue(h)
  await h.run(()=>h.root.findAllByType('button').find(n=>n.children.join('')==='同步并重试提交').props.onClick())
  assert.equal(calls.length,2)
  assert.deepEqual(calls.map(c=>c[0]),['u-exact','u-exact']);assert.equal(calls[0][1],calls[1][1])
})
test('input, textarea and contenteditable undo use browser commands while file undo is available',async t=>{
  const {b,h}=await completedMove(t)
  const commands=[]
  document.execCommand=(...args)=>{commands.push(args);return true}
  for(const element of [{tagName:'INPUT'},{tagName:'TEXTAREA'},{tagName:'DIV',isContentEditable:true}]){
    document.activeElement=element
    assert.equal((await key(h,'z',{metaKey:true})).defaultPrevented,true)
  }
  assert.deepEqual(commands.map(c=>c[0]),['undo','undo','undo'])
  assert.equal(b.calls.some(c=>c[0]==='undo'),false)
})
test('missing inverse outcome pages do not acknowledge results or announce undo success',async t=>{
  const {b,h}=await completedMove(t)
  await key(h,'z',{metaKey:true})
  const inverse=[...b.jobs.values()].find(j=>j.kind==='undo')
  h.api.getOperationOutcomes=async(id,offset)=>({sessionId:'test',jobId:id,revision:2,offset,total:1,outcomes:[]})
  inverse.outcomeCount=1
  await h.run(()=>h.events.get('operation-changed')({payload:{...inverse,revision:2,state:'partial',phase:'finished',outcomeCount:1}}))
  await h.run(()=>new Promise(r=>setImmediate(r)))
  assert.equal(b.calls.some(c=>c[0]==='ack'&&c[1]===inverse.jobId),false)
  assert.equal(h.panes[0].props.operationToast,null)
  const task=h.root.findAllByType('button').find(n=>n.props['aria-expanded']!==undefined)
  assert.match(task.children.join(''),/操作异常/)
  await openQueue(h)
  assert.ok(h.root.findAll(n=>n.props.role==='alert').length)
})
test('copy undo is a dedicated backend job and never bypasses the queue with direct trash',async t=>{
  const b=operationBoundary(),h=await mountApp(t,{...b.api,trash:()=>assert.fail('direct trash is forbidden'),restoreMoves:()=>assert.fail('frontend must not construct inverse paths')})
  await h.run(()=>h.panes[0].props.onDropTransfer('/dest',['/src/a'],'copy'))
  b.setUndo('copy-effect')
  await b.emit(h,'j1',{state:'completed',phase:'finished',undoId:'copy-effect'},[outcome()])
  await key(h,'z',{metaKey:true})
  assert.equal(b.calls.find(c=>c[0]==='undo')[1],'copy-effect')
})
test('Trash undo delegates exact original-name restoration and consumes both authoritative directories',async t=>{
  const b=operationBoundary(),h=await mountApp(t,b.api),p=h.panes[0].props,id=p.pane.tabs[0].id
  await h.run(()=>p.onSelect(id,new Set(['/note.txt'])))
  await key(h,'Backspace',{metaKey:true})
  assert.equal(b.requests[0].kind,'trash')
  b.setUndo('trash-effect')
  await b.emit(h,'j1',{state:'completed',phase:'finished'},[outcome({source:'/note.txt',actualDestination:'/Trash/note collision.txt',sourceDisposition:'removed',affectedDirectories:['/','/Trash']})])
  await key(h,'z',{metaKey:true})
  assert.equal(b.calls.find(c=>c[0]==='undo')[1],'trash-effect')
  const inverse=[...b.jobs.values()].find(j=>j.kind==='undo')
  await b.emit(h,inverse.jobId,{state:'completed',phase:'finished'},[outcome({source:'/Trash/note collision.txt',actualDestination:'/note.txt',sourceDisposition:'removed',affectedDirectories:['/','/Trash']})])
  assert.deepEqual(h.panes[0].props.directoryVersions,{'/':2,'/Trash':2})
})
test('published partial cut leaves recovery guidance and cannot be automatically pasted a second time',async t=>{
  const b=operationBoundary(),h=await mountApp(t,b.api)
  await h.run(()=>h.clipboard.setClip({mode:'cut',paths:['/src/a']}))
  await key(h,'v',{metaKey:true})
  await b.emit(h,'j1',{state:'partial',phase:'finished'},[outcome({status:'partial',sourceDisposition:'cleanupIncomplete',retry:'finishSourceCleanup',affectedDirectories:['/src','/dest']})])
  assert.equal(h.clipboard.getClip(),null)
  await key(h,'v',{metaKey:true})
  assert.equal(b.requests.length,1)
  assert.equal(h.panes[0].props.operationToast,null)
  assert.deepEqual(h.panes[0].props.directoryVersions,{'/src':1,'/dest':1})
})
