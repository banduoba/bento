import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, deferred } from './test/AppHarness.js'
import { operationBoundary, outcome, key } from './test/OperationBoundary.js'
import { manualClock } from './test/ManualClock.js'
const id=pane=>pane.props.pane.tabs[pane.props.pane.active].id

test('production App/client coalesces 2500 one-row pages while preserving aliases, unrelated panes, selection and cut settlement',async t=>{
  const clock=manualClock(),b=operationBoundary(),resolved=[],removed=[],pageSizes=[]
  const h=await mountApp(t,{...b.api,getOperationOutcomes:async(...args)=>{const page=await b.api.getOperationOutcomes(...args);pageSizes.push(page.outcomes.length);return page},resolvePath:async path=>{resolved.push(path);return path.replace(/\/$/,'')==='/alias'?'/dest':path.replace(/\/$/,'')||'/'}},clock)
  await key(h,'4',{metaKey:true})
  for(const [index,path] of ['/src','/dest','/unrelated','/alias'].entries())await h.run(()=>h.panes[index].props.onNav(id(h.panes[index]),path))
  const sources=Array.from({length:2500},(_,index)=>`/src/${index}`)
  await h.run(()=>h.panes[0].props.onSelect(id(h.panes[0]),new Set([...sources,'/src/keep'])))
  await h.run(()=>h.panes[2].props.onSelect(id(h.panes[2]),new Set(['/unrelated/keep'])))
  const unrelatedSelection=h.panes[2].props.selection,unrelatedTick=h.panes[2].props.tick,aliasTick=h.panes[3].props.tick
  await h.run(()=>h.clipboard.setClip({mode:'cut',paths:sources}))
  await h.run(()=>h.panes[1].props.onFocus(1));await key(h,'v',{metaKey:true})
  window.addEventListener('bento-moved',event=>removed.push(event.detail.paths))
  resolved.length=0
  const rows=[]
  const emitRows=async(start,end)=>h.run(async()=>{
    for(let index=start;index<end;index++){
      rows.push(outcome({itemId:`i${index}`,effectId:`e${index}`,source:sources[index],actualDestination:`/dest/${index}`,sourceDisposition:'removed',affectedDirectories:['/src','/dest']}))
      await b.emit(h,'j1',{state:'running',phase:'copying'},rows,{withinAct:true})
    }
  })
  await emitRows(0,2490)
  assert.equal(resolved.length,0)
  assert.equal(removed.length,0)
  assert.equal(clock.pending,1)
  await h.run(()=>clock.advance(100))
  assert.equal(resolved.length,2)
  assert.equal(removed.length,1);assert.equal(removed[0].length,2490)
  assert.deepEqual([...h.panes[0].props.selection],sources.slice(2490).concat('/src/keep'))
  assert.equal(h.panes[2].props.selection,unrelatedSelection)
  assert.equal(h.panes[2].props.tick,unrelatedTick)
  assert.notEqual(h.panes[3].props.tick,aliasTick)
  await emitRows(2490,2500)
  await b.emit(h,'j1',{state:'completed',phase:'finished'},rows)
  assert.equal(resolved.length,4)
  assert.equal(pageSizes.length,2500)
  assert.ok(pageSizes.every(size=>size===1))
  assert.equal(removed.length,2);assert.equal(removed[1].length,10)
  assert.deepEqual([...h.panes[0].props.selection],['/src/keep'])
  assert.equal(h.clipboard.getClip(),null)
  assert.equal(b.calls.filter(call=>call[0]==='ack').length,1)
  assert.equal(clock.pending,0)
  t.diagnostic('2500 one-row pages: 2 refresh batches, 4 resolvePath calls, 2 moved-selection events')
})
test('terminal partial/cancelled work flushes affected aliases and removed selections before ACK',async t=>{
  const clock=manualClock(),b=operationBoundary(),gate=deferred(),order=[]
  let hold=false
  const h=await mountApp(t,{...b.api,resolvePath:async path=>{if(hold&&path==='/dest/'){await gate.promise;order.push('alias')}return path.replace(/\/$/,'')||'/'},ackOperationOutcomes:async(...args)=>{order.push('ack');b.calls.push(['ack',...args])}},clock)
  await h.run(()=>h.panes[0].props.onSelect(id(h.panes[0]),new Set(['/src/a','/src/unstarted'])))
  await h.run(()=>h.panes[0].props.onDropTransfer('/dest',['/src/a','/src/unstarted'],'move'))
  window.addEventListener('bento-moved',()=>order.push('selection'))
  hold=true
  await b.emit(h,'j1',{state:'partial',phase:'finished',cancelRequested:true},[
    outcome({sourceDisposition:'removed',affectedDirectories:['/src','/dest']}),
    outcome({itemId:'i1',source:'/src/unstarted',status:'cancelled',actualDestination:null,effectId:null,published:false,affectedDirectories:[]}),
  ])
  assert.deepEqual(order,[])
  assert.equal(b.calls.some(call=>call[0]==='ack'),false)
  await h.run(async()=>{gate.resolve();await new Promise(resolve=>setImmediate(resolve))})
  assert.deepEqual(order,['alias','selection','ack'])
  assert.deepEqual([...h.panes[0].props.selection],['/src/unstarted'])
  assert.equal(h.panes[0].props.operationToast,null)
  assert.equal(clock.pending,0)
})
test('unmount cancels pending coalesced effects without late alias calls or moved events',async t=>{
  const clock=manualClock(),b=operationBoundary(),resolved=[],removed=[]
  const h=await mountApp(t,{...b.api,resolvePath:async path=>{resolved.push(path);return path}},clock)
  await h.run(()=>h.panes[0].props.onDropTransfer('/dest',['/src/a'],'move'))
  window.addEventListener('bento-moved',event=>removed.push(event.detail.paths))
  resolved.length=0
  await b.emit(h,'j1',{state:'running',phase:'copying'},[outcome({sourceDisposition:'removed',affectedDirectories:['/src','/dest']})])
  assert.equal(clock.pending,1)
  await h.unmount();await clock.advance(1000)
  assert.equal(clock.pending,0);assert.deepEqual(resolved,[]);assert.deepEqual(removed,[])
})
test('undo unknown totals are explicit and private executor progress paths are omitted without filtering ordinary user paths',async t=>{
  const b=operationBoundary(),h=await mountApp(t,b.api)
  await h.run(()=>h.panes[0].props.onDropTransfer('/dest',['/src/a'],'copy'))
  b.setUndo('u1');await b.emit(h,'j1',{state:'completed',phase:'finished',undoId:'u1'},[outcome()])
  await key(h,'z',{metaKey:true})
  const undo=[...b.jobs.values()].find(job=>job.kind==='undo'),privatePath='/tmp/.bento-operation-owned/undo'
  await b.emit(h,undo.jobId,{state:'running',phase:'undoing',progress:{...undo.progress,itemsFinished:0,itemsTotal:null,currentPath:privatePath}})
  const row=h.root.findByProps({'data-job-id':undo.jobId})
  const phase=row.findByProps({className:'operation-phase'}).children.join('')
  assert.ok(phase.includes('总数待确定'))
  assert.equal(row.findAllByProps({title:privatePath}).length,0)
  await b.emit(h,undo.jobId,{state:'running',phase:'undoing',progress:{...undo.progress,itemsFinished:0,itemsTotal:0,currentPath:privatePath}})
  assert.ok(h.root.findByProps({'data-job-id':undo.jobId}).findByProps({className:'operation-phase'}).children.join('').includes('总数待确定'))
  await b.emit(h,undo.jobId,{state:'completed',phase:'finished'})
  await h.run(()=>h.panes[0].props.onDropTransfer('/dest',['/src/user'],'copy'))
  const ordinary=b.jobs.get('j2')
  await b.emit(h,'j2',{state:'running',phase:'copying',progress:{...ordinary.progress,currentPath:privatePath}})
  assert.equal(h.root.findByProps({'data-job-id':'j2'}).findAllByProps({title:privatePath}).length,1)
})

test('held create alias keeps Undo button and CmdZ blocked until settlement, with no forward rename replay after inverse',async t=>{
  const b=operationBoundary(),clock=manualClock(),gate=deferred()
  t.after(()=>gate.resolve())
  let hold=false
  const h=await mountApp(t,{...b.api,resolvePath:async path=>{if(hold&&path==='/home/')await gate.promise;return path.replace(/\/$/,'')||'/'}},clock)
  await key(h,'N',{metaKey:true,shiftKey:true})
  b.setUndo('u1');hold=true
  await b.emit(h,'j1',{state:'completed',phase:'finished',undoId:'u1'},[outcome({source:null,actualDestination:'/home/new',affectedDirectories:['/home']})])
  const undoButton=()=>h.root.findAllByType('button').find(node=>node.children.join('')==='撤销')
  const disabledWhilePending=undoButton().props.disabled
  await key(h,'z',{metaKey:true})
  assert.equal(disabledWhilePending,true)
  assert.equal(b.calls.some(call=>call[0]==='undo'),false)
  assert.equal(b.calls.some(call=>call[0]==='ack'),false)
  assert.equal(h.panes[0].props.renaming,null)
  await h.run(async()=>{gate.resolve();await new Promise(resolve=>setImmediate(resolve))})
  assert.equal(undoButton().props.disabled,false)
  assert.equal(h.panes[0].props.renaming.path,'/home/new')
  await h.run(()=>h.panes[0].props.onRenameCancel())
  await key(h,'z',{metaKey:true})
  assert.equal(b.calls.filter(call=>call[0]==='undo').length,1)
  const inverse=[...b.jobs.values()].find(job=>job.kind==='undo')
  b.setUndo(null)
  await b.emit(h,inverse.jobId,{state:'completed',phase:'finished'},[outcome({source:'/home/new',actualDestination:'/trash/new',sourceDisposition:'removed',effectId:'inverse',affectedDirectories:['/home','/trash']})])
  await h.run(()=>clock.advance(1000))
  assert.equal(h.panes[0].props.renaming,null)
  assert.equal(h.panes[0].props.selection.has('/home/new'),false)
  assert.equal(b.calls.filter(call=>call[0]==='ack').length,2)
})
test('close waits for a completed job whose terminal UI settlement is still pending',async t=>{
  const b=operationBoundary(),gate=deferred();let hold=false
  t.after(()=>gate.resolve())
  const h=await mountApp(t,{...b.api,resolvePath:async path=>{if(hold&&path==='/home/')await gate.promise;return path.replace(/\/$/,'')||'/'}},manualClock())
  await key(h,'N',{metaKey:true,shiftKey:true})
  hold=true
  await b.emit(h,'j1',{state:'completed',phase:'finished'},[outcome({source:null,actualDestination:'/home/new',affectedDirectories:['/home']})])
  let exiting;await h.run(()=>{exiting=h.exit(41)})
  const cancelThenExit=h.root.findAllByType('button').find(node=>node.children.join('')==='取消剩余操作后退出')
  assert.ok(cancelThenExit)
  await h.run(()=>cancelThenExit.props.onClick())
  assert.deepEqual(h.replies,[])
  await h.run(async()=>{gate.resolve();await exiting})
  assert.deepEqual(h.replies,[[41,true]])
  assert.equal(b.calls.filter(call=>call[0]==='ack').length,1)
  assert.equal(b.calls.some(call=>call[0]==='undo'),false)
})
