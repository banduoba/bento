import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, deferred, key } from './test/AppHarness.js'
const identity={dev:'7',ino:'11'}
const receipt=(source,dest,extra={})=>({source,dest,ok:true,error:null,identity,...extra})
async function paths(h,left='/source',right='/right') {
  for(const [i,path] of [left,right].entries())await h.run(()=>h.panes[i].props.onNav(h.panes[i].props.pane.tabs[0].id,path))
}
const feedback=h=>h.root.findAll(n=>typeof n.props.className==='string' && /(?:undo-toast|row-toast|^prog$)/.test(n.props.className))

test('native completion without a decoded path calls the drop callback once, refreshes destination, and offers no unsafe Undo',async t=>{
  const gate=deferred(),trash=[]
  const h=await mountApp(t,{transfer:()=>gate.promise,trash:async(...a)=>trash.push(a)})
  await paths(h);const before=h.panes.map(p=>p.props.tick);let completed=0,pending
  await h.run(()=>{pending=h.panes[1].props.onDropTransfer('/right',['/source/a'],'copy',()=>completed++)})
  assert.equal(completed,0);assert.deepEqual(h.panes.map(p=>p.props.tick),before)
  await h.run(async()=>{gate.resolve([receipt('/source/a','',{identity:undefined})]);await pending})
  assert.equal(completed,1);assert.equal(h.panes[0].props.tick,before[0]);assert.notEqual(h.panes[1].props.tick,before[1])
  await key(h,'z',{metaKey:true});assert.deepEqual(trash,[]);assert.deepEqual(h.alerts,[]);assert.deepEqual(feedback(h),[])
  assert.equal(h.events.has('transfer-progress'),false)
})

test('partial cancelled move releases only completed cut paths after completion and keeps selection for cancelled paths',async t=>{
  const gate=deferred(),h=await mountApp(t,{moveItems:()=>gate.promise})
  await paths(h);const id=h.panes[0].props.pane.tabs[0].id
  await h.run(()=>h.panes[0].props.onSelect(id,new Set(['/source/a','/source/b'])))
  await key(h,'x',{metaKey:true});assert.deepEqual(h.clipboard.getClip().paths,['/source/a','/source/b'])
  await h.run(()=>h.panes[1].props.onFocus(1));await key(h,'v',{metaKey:true})
  assert.deepEqual(h.clipboard.getClip().paths,['/source/a','/source/b'])
  await h.run(()=>gate.resolve([receipt('/source/a','',{identity:undefined}),{source:'/source/b',dest:'',ok:false,error:null,cancelled:true}]))
  assert.deepEqual(h.clipboard.getClip().paths,['/source/b']);assert.deepEqual([...h.panes[0].props.selection],['/source/b'])
  assert.deepEqual(h.alerts,[]);assert.deepEqual(feedback(h),[])
})

test('partial native error refreshes relevant directories before reporting and never retries the operation',async t=>{
  let calls=0;const h=await mountApp(t,{transfer:async()=>{calls++;return [receipt('/source/a','/right/a'),{source:'/source/b',dest:'',ok:false,error:'permission denied',affectedDirectories:['/source','/right']}]}})
  await paths(h);const before=h.panes.map(p=>p.props.tick)
  await h.run(()=>h.panes[1].props.onDropTransfer('/right',['/source/a','/source/b'],'copy'))
  assert.equal(calls,1);assert.equal(h.alerts.length,1);assert.match(h.alerts[0],/permission denied/)
  assert.notEqual(h.panes[0].props.tick,before[0]);assert.notEqual(h.panes[1].props.tick,before[1]);assert.deepEqual(feedback(h),[])
})

test('a completed move cannot clear a newer cut clipboard',async t=>{
  const gate=deferred(),h=await mountApp(t,{moveItems:()=>gate.promise});await paths(h)
  await h.run(()=>h.clipboard.setClip({mode:'cut',paths:['/source/a']}));await h.run(()=>h.panes[1].props.onFocus(1));await key(h,'v',{metaKey:true})
  await h.run(()=>h.clipboard.setClip({mode:'cut',paths:['/elsewhere/new']}))
  await h.run(()=>gate.resolve([receipt('/source/a','/right/a')]))
  assert.deepEqual(h.clipboard.getClip(),{mode:'cut',paths:['/elsewhere/new']})
})

test('moving into the existing parent clears the completed cut without removing the unchanged row selection',async t=>{
  const h=await mountApp(t,{moveItems:async()=>[receipt('/source/a','/source/a')]});await paths(h,'/source','/source')
  const id=h.panes[0].props.pane.tabs[0].id
  await h.run(()=>h.panes[0].props.onSelect(id,new Set(['/source/a'])))
  await key(h,'x',{metaKey:true});await key(h,'v',{metaKey:true})
  assert.equal(h.clipboard.getClip(),null);assert.deepEqual([...h.panes[0].props.selection],['/source/a'])
})
