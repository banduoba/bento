import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp } from './test/AppHarness.js'
import { operationBoundary, outcome } from './test/OperationBoundary.js'
const id=p=>p.props.pane.tabs[0].id

test('copy completion invalidates successful destination and binds feedback to the destination tab',async t=>{
  const b=operationBoundary(),h=await mountApp(t,b.api),target=id(h.panes[1])
  await h.run(()=>h.panes[1].props.onNav(target,'/dest'))
  await h.run(()=>h.panes[1].props.onDropTransfer('/dest',['/src/a'],'copy'))
  await b.emit(h,'j1',{state:'completed',phase:'finished'},[outcome()])
  assert.equal(h.panes[0].props.operationToast,null)
  assert.equal(h.panes[1].props.operationToast.tabId,target)
  assert.deepEqual(h.panes[1].props.operationToast.paths,['/dest/a'])
  assert.equal(h.panes[0].props.directoryVersions['/dest'],1)
  assert.equal(h.panes[0].props.directoryVersions['/src'],undefined)
})
test('failed copy creates no directory invalidation or success feedback',async t=>{
  const b=operationBoundary(),h=await mountApp(t,b.api)
  await h.run(()=>h.panes[0].props.onDropTransfer('/dest',['/src/a'],'copy'))
  await b.emit(h,'j1',{state:'failed',phase:'finished'},[outcome({status:'failed',effectId:null,published:false,actualDestination:null,affectedDirectories:[],error:{code:'io',phase:'copying',message:'denied'}})])
  assert.deepEqual(h.panes[0].props.directoryVersions,{})
  assert.equal(h.panes[0].props.operationToast,null)
})
test('move results invalidate only authoritative source and destination directories',async t=>{
  const b=operationBoundary(),h=await mountApp(t,b.api)
  await h.run(()=>h.panes[0].props.onDropTransfer('/dest',['/src/a','/elsewhere/b'],'move'))
  await b.emit(h,'j1',{state:'partial',phase:'finished'},[outcome({sourceDisposition:'removed',affectedDirectories:['/src','/dest']}),outcome({itemId:'i1',source:'/elsewhere/b',status:'failed',effectId:null,published:false,actualDestination:null,affectedDirectories:[]})])
  assert.deepEqual(h.panes[0].props.directoryVersions,{'/src':1,'/dest':1})
})
test('completed feedback is not redirected after the original destination tab closes',async t=>{
  const b=operationBoundary(),h=await mountApp(t,b.api),owner=id(h.panes[0])
  await h.run(()=>h.panes[0].props.onNav(owner,'/dest'))
  await h.run(()=>h.panes[0].props.onNewTab(0))
  await h.run(()=>h.panes[0].props.onSwitchTab(0,0))
  await h.run(()=>h.panes[0].props.onDropTransfer('/dest',['/src/a'],'copy'))
  await h.run(()=>h.panes[0].props.onCloseTab(owner))
  await b.emit(h,'j1',{state:'completed',phase:'finished'},[outcome()])
  assert.equal(h.panes[0].props.operationToast,null)
  assert.equal(h.panes[1].props.operationToast,null)
  assert.equal(h.panes[0].props.directoryVersions['/dest'],1)
})
test('published partial move refreshes both explicit directories and requires recovery instead of success feedback',async t=>{
  const b=operationBoundary(),h=await mountApp(t,b.api)
  await h.run(()=>h.panes[0].props.onDropTransfer('/dest',['/src/a'],'move'))
  await b.emit(h,'j1',{state:'partial',phase:'finished'},[outcome({status:'partial',sourceDisposition:'cleanupIncomplete',retry:'finishSourceCleanup',error:{message:'source removal failed',code:'io',phase:'removingSource'},affectedDirectories:['/src','/dest']})])
  assert.deepEqual(h.panes[0].props.directoryVersions,{'/src':1,'/dest':1})
  assert.equal(h.panes[0].props.operationToast,null)
  assert.equal(b.calls.some(c=>c[0]==='undo'),false)
})
