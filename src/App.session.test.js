import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, deferred } from './test/AppHarness.js'
const tab=path=>({id:'t1',path,history:[path],hi:0})
const pane=path=>({active:0,tabs:[tab(path)]})
const session={version:1,layout:'4',focusedIdx:2,panes:[pane('/A'),pane('/B'),pane('/盘 '),pane('/D')],workspaces:[{id:'one',name:'One',layout:'4',focusedIdx:0,panes:[pane('/old')]},{id:'two',name:'Two',layout:'1',focusedIdx:0,panes:[pane('/two')]}],activeWorkspace:'one'}
test('App back and forward clear old selection, refresh and repeated path do not change history',async t=>{
  const h=await mountApp(t)
  let p=h.panes[0].props, id=p.pane.tabs[0].id
  await h.run(()=>p.onNav(id,'/B')); await h.run(()=>h.panes[0].props.onNav(id,'/C'))
  await h.run(()=>h.panes[0].props.onSelect(id,new Set(['/C/file'])))
  await h.run(()=>h.panes[0].props.onBack(id))
  assert.equal(h.panes[0].props.selection.size,0)
  assert.equal(h.panes[0].props.pane.tabs[0].path,'/B')
  await h.run(()=>h.panes[0].props.onSelect(id,new Set(['/B/file'])))
  await h.run(()=>h.panes[0].props.onForward(id)); assert.equal(h.panes[0].props.selection.size,0)
  await h.run(()=>h.panes[0].props.onBack(id)); await h.run(()=>h.panes[0].props.onNav(id,'/D'))
  await h.run(()=>h.panes[0].props.onNav(id,'/D')); await h.run(()=>h.panes[0].props.onNav(id,null,true))
  assert.deepEqual(h.panes[0].props.pane.tabs[0].history,['/home','/B','/D'])
  assert.deepEqual(h.panes[1].props.pane.tabs[0].history,['/home'])
})
test('App session wins over legacy, preserves hidden panes and active workspace through close and restart',async t=>{
  const h=await mountApp(t,{loadSession:async()=>session,loadConfig:async()=>({showHidden:true,autoRefresh:false,panes:[pane('/legacy')]})})
  assert.equal(h.panes.length,4);assert.equal(h.panes[2].props.pane.tabs[0].path,'/盘 ')
  await h.run(()=>{const e=new Event('keydown');Object.assign(e,{metaKey:true,key:'1'});window.dispatchEvent(e)})
  assert.equal(h.panes.length,1)
  const {pending,prevented}=h.close();assert.equal(prevented,true);await h.run(()=>pending)
  assert.equal(h.closes,1);assert.equal(h.destroyed,1);const disk=h.writes.session.at(-1)
  assert.equal(disk.panes.length,4);assert.equal(disk.layout,'1');assert.equal(disk.workspaces[0].panes[0].tabs[0].path,'/A')
  assert.equal(disk.activeWorkspace,'one');assert.equal(h.writes.config.at(-1).showHidden,true);assert.equal('panes'in h.writes.config.at(-1),false)
})
test('App waits for hydration and delayed writes on app quit, never writes startup defaults',async t=>{
  const startup=deferred(),write=deferred();const values=[]
  const h=await mountApp(t,{loadSession:()=>startup.promise,saveSession:async value=>{values.push(value);await write.promise}})
  assert.deepEqual(values,[])
  let quitting
  await h.run(()=>{quitting=h.exit(7)})
  assert.deepEqual(h.replies,[])
  await h.run(()=>startup.resolve(session));assert.equal(values.length,1);assert.equal(values[0].panes[0].tabs[0].path,'/A')
  assert.deepEqual(h.replies,[])
  await h.run(async()=>{write.resolve();await quitting})
  assert.deepEqual(h.replies,[[7,true]])
})
test('preferences-only config survives, unknown session shows visible recovery message',async t=>{
  const h=await mountApp(t,{loadConfig:async()=>({showHidden:true,autoRefresh:false,favorites:[{name:'Custom',path:'/custom '}]}),loadSession:async()=>({version:99})})
  assert.equal(h.panes[0].props.cfg.showHidden,true)
  assert.equal(h.panes[0].props.cfg.autoRefresh,false)
  assert.equal(h.sidebar.props.favorites[0].path,'/custom ')
  assert.ok(h.root.findAll(n=>n.props.role==='alert').length)
})
test('App does not erase legacy session fields before the first session save succeeds',async t=>{
  const h=await mountApp(t,{loadConfig:async()=>({panes:[pane('/legacy')]}),saveSession:async()=>{throw Error('read only')}})
  await h.run(()=>new Promise(r=>setTimeout(r,20)))
  assert.deepEqual(h.writes.config,[])
  let close
  await h.run(()=>{close=h.close()});await h.run(()=>close.pending)
  assert.equal(h.closes,0);assert.deepEqual(h.writes.config,[])
})
test('App each tab keeps its history and workspace switch saves the outgoing live state',async t=>{
  const h=await mountApp(t,{loadSession:async()=>session})
  const id=h.panes[0].props.pane.tabs[0].id
  await h.run(()=>h.panes[0].props.onNav(id,'/One edit'))
  await h.run(()=>h.panes[0].props.onNewTab(0))
  const second=h.panes[0].props.pane.tabs[1].id
  await h.run(()=>h.panes[0].props.onNav(second,'/Other tab'))
  assert.deepEqual(h.panes[0].props.pane.tabs[0].history,['/A','/One edit'])
  await h.run(()=>h.sidebar.props.onSwitchWorkspace('two'))
  assert.equal(h.panes[0].props.pane.tabs[0].path,'/two')
  await h.run(()=>h.panes[0].props.onNav(h.panes[0].props.pane.tabs[0].id,'/Two edit'))
  await h.run(()=>h.sidebar.props.onSwitchWorkspace('one'))
  assert.equal(h.panes[0].props.pane.tabs[1].path,'/Other tab')
  assert.notEqual(h.panes[0].props.pane.tabs[0].id,id)
  const close=h.close();await h.run(()=>close.pending)
  const disk=h.writes.session.at(-1)
  assert.equal(disk.activeWorkspace,'one')
  assert.equal(disk.workspaces[1].panes[0].tabs[0].path,'/Two edit')
  assert.equal(disk.workspaces[0].panes[0].tabs[1].path,'/Other tab')
})
test('App only real session fields cause a new session write; IPC load failures are visible and recoverable',async t=>{
  const h=await mountApp(t,{loadSession:async()=>{throw Error('invalid JSON')},loadConfig:async()=>({panes:[pane('/legacy')]})})
  assert.equal(h.panes[0].props.pane.tabs[0].path,'/legacy')
  assert.ok(h.root.findAll(n=>n.props.role==='alert').some(n=>n.children.filter(c=>typeof c==='string').join('').includes('invalid JSON')))
  await h.run(()=>new Promise(r=>setTimeout(r,330)))
  const baseline=h.writes.session.length
  const p=h.panes[0].props,id=p.pane.tabs[0].id
  await h.run(()=>p.onStats(id,{count:1,total:1,selCount:0,selSize:0}))
  await h.run(()=>p.onNav(id,null,true))
  await h.run(()=>h.root.findByProps({title:'显示隐藏文件 (⇧⌘.)'}).props.onClick())
  const close=h.close();await h.run(()=>close.pending)
  assert.equal(h.writes.session.length,baseline)
  assert.equal(h.writes.config.at(-1).showHidden,true)
})
test('App flush waits for ordered final preference and view snapshots as well as session',async t=>{
  const prefs=[],views=[],prefGate=deferred(),viewGate=deferred()
  let pendingPref=false,pendingView=false
  const h=await mountApp(t,{
    saveConfig:async value=>{assert.equal(pendingPref,false);pendingPref=true;prefs.push(value);if(prefs.length===1)await prefGate.promise;pendingPref=false},
    saveViewSettings:async value=>{assert.equal(pendingView,false);pendingView=true;views.push(value);if(views.length===1)await viewGate.promise;pendingView=false},
  })
  await h.run(()=>new Promise(r=>setTimeout(r,320)))
  assert.equal(prefs.length,1);assert.equal(views.length,1)
  await h.run(()=>h.root.findByProps({title:'显示隐藏文件 (⇧⌘.)'}).props.onClick())
  const p=h.panes[0].props
  await h.run(()=>p.onSort(p.pane.tabs[0].id,'size','asc'))
  let quitting;await h.run(()=>{quitting=h.exit(12)})
  assert.deepEqual(h.replies,[])
  await h.run(()=>prefGate.resolve());assert.deepEqual(h.replies,[])
  await h.run(async()=>{viewGate.resolve();await quitting})
  assert.equal(prefs.at(-1).showHidden,true)
  assert.equal(views.at(-1).overrides['/home'].sort.key,'size')
  assert.deepEqual(h.replies,[[12,true]])
})
test('App rehydrates a single layout session without losing the four hidden-pane histories',async t=>{
  const disk={...session,layout:'1',focusedIdx:0,panes:session.panes.map((p,i)=>i===3?{...p,tabs:[{path:'/D2 ',history:['/D','/D2 '],hi:1}]}:p)}
  const h=await mountApp(t,{loadSession:async()=>disk})
  assert.equal(h.panes.length,1)
  await h.run(()=>{const e=new Event('keydown');Object.assign(e,{metaKey:true,key:'4'});window.dispatchEvent(e)})
  assert.equal(h.panes.length,4)
  assert.deepEqual(h.panes[3].props.pane.tabs[0].history,['/D','/D2 '])
  assert.equal(h.panes[3].props.pane.tabs[0].path,'/D2 ')
})
test('App save failure cancels native quit visibly, then retries the newest snapshot',async t=>{
  let fail=true;const saved=[]
  const h=await mountApp(t,{saveSession:async value=>{if(fail)throw Error('disk full');saved.push(value)}})
  let quitting;await h.run(()=>{quitting=h.exit(21)});await h.run(()=>quitting)
  assert.deepEqual(h.replies,[[21,false]])
  assert.equal(h.dialogs.length,1)
  assert.equal(h.dialogs[0][1].cancelLabel,'取消退出')
  assert.ok(h.root.findAll(n=>n.props.role==='alert').length)
  const p=h.panes[0].props
  await h.run(()=>p.onNav(p.pane.tabs[0].id,'/latest '))
  fail=false
  await h.run(async()=>{quitting=h.exit(22);await quitting})
  assert.equal(saved.at(-1).panes[0].tabs[0].path,'/latest ')
  assert.deepEqual(h.replies,[[21,false],[22,true]])
})
test('App can explicitly discard after failed window close without replying to app quit',async t=>{
  const h=await mountApp(t,{saveSession:async()=>{throw Error('disk full')}})
  h.setDiscard(true)
  const closing=h.close();assert.equal(closing.prevented,true)
  await h.run(()=>closing.pending)
  assert.equal(h.closes,1);assert.deepEqual(h.replies,[])
})
