import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp } from './test/AppHarness.js'

async function mount(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = await mountApp(t, { transfer: async () => [] })
  const tabId = h.panes[0].props.pane.tabs[0].id
  const pane = { dataset: { tabId }, closest: () => pane, classList:{add(){},remove(){},contains:c=>c==='pane'},getBoundingClientRect:()=>({left:0,top:0,width:180,height:300}) }
  const row = {
    dataset: { path: '/home/destination', springFolder: '/home/destination', dir:'1' }, isConnected: true,
    classList: { add() {}, remove() {}, contains: c => c === 'row' },
    getBoundingClientRect: () => ({ left:0,top:30,width:180,height:21 }),
    querySelector: () => ({ textContent:'destination' }),
    closest: selector => selector.includes('.sb-item') ? null : selector.includes('.panes') ? pane : selector.includes('[data-dir]') ? (row.dataset.dir ? row : null) : selector === '.row[data-path]' ? row : null,
  }
  let hit = row
  document.elementFromPoint = () => hit
  document.querySelectorAll = () => [pane]
  const payload = type => ({ type, position:{x:10,y:40},paths:['/source/file.txt'] })
  return { h,row,payload,setHit:value=>{hit=value},advance:ms=>h.run(()=>t.mock.timers.tick(ms)) }
}
test('native repeated over events spring-open only the matching tab after stable delay', async t => {
  const {h,payload,advance} = await mount(t)
  await h.run(()=>h.drop(payload('enter')))
  await advance(400); await h.run(()=>h.drop(payload('over')))
  await advance(249); assert.equal(h.panes[0].props.springOpen, null)
  await advance(1); assert.equal(h.panes[0].props.springOpen.path, '/home/destination')
  assert.equal(h.panes[1].props.springOpen, null)
})
for (const ending of ['leave','cancelled','drop','Escape','blur']) {
  test(`${ending} cancels a pending native spring request`, async t => {
    const {h,payload,advance} = await mount(t)
    await h.run(()=>h.drop(payload('enter')))
    await advance(400)
    await h.run(()=>{
      if(ending==='Escape'){const e=new Event('keydown');Object.defineProperty(e,'key',{value:'Escape'});window.dispatchEvent(e)}
      else if(ending==='blur')window.dispatchEvent(new Event('blur'))
      else return h.drop(payload(ending))
    })
    await advance(1000); assert.equal(h.panes[0].props.springOpen, null)
  })
}
test('native spring rechecks hit target and rejects disconnected or non-expandable rows', async t => {
  const {h,row,payload,advance,setHit} = await mount(t)
  await h.run(()=>h.drop(payload('enter')))
  setHit(null); await advance(650); assert.equal(h.panes[0].props.springOpen,null)
  setHit(row); row.dataset.springFolder=undefined
  await h.run(()=>h.drop(payload('over'))); await advance(650)
  assert.equal(h.panes[0].props.springOpen,null)
})
test('changing drag targets restarts dwell and never opens the previous target', async t => {
 const {h,row,payload,advance}=await mount(t)
 await h.run(()=>h.drop(payload('enter')));await advance(500)
 row.dataset.path='/home/another';row.dataset.springFolder='/home/another'
 await h.run(()=>h.drop(payload('over')));await advance(150)
 assert.equal(h.panes[0].props.springOpen,null)
 await advance(500);assert.equal(h.panes[0].props.springOpen.path,'/home/another')
})
test('tab navigation and invalid self or empty-path drags reject stale spring work', async t=>{
 const {h,payload,advance}=await mount(t)
 await h.run(()=>h.drop(payload('enter')))
 const tab=h.panes[0].props.pane.tabs[0]
 await h.run(()=>h.panes[0].props.onNav(tab.id,'/another-root'))
 await advance(650);assert.equal(h.panes[0].props.springOpen,null)
 await h.run(()=>h.drop({...payload('enter'),paths:['/home']}));await advance(650)
 assert.equal(h.panes[0].props.springOpen,null)
 await h.run(()=>h.drop({...payload('enter'),paths:[]}));await advance(650)
 assert.equal(h.panes[0].props.springOpen,null)
})
test('drop still recomputes the actual child destination instead of using the spring-open folder', async t=>{
 const {h,row,payload,advance}=await mount(t),calls=[]
 h.api.transfer=async(...args)=>{calls.push(args);return []}
 await h.run(()=>h.drop(payload('enter')));await advance(650)
 row.dataset.path='/home/destination/child';row.dataset.springFolder='/home/destination/child'
 await h.run(()=>h.drop(payload('drop')))
 assert.deepEqual(calls,[[['/source/file.txt'],'/home/destination/child','copy']])
 assert.equal(h.panes[0].props.springOpen,null)
})

test('native hover follows ordinary child rows and ends on cancel without reopening', async t => {
 const {h,row,payload,advance}=await mount(t)
 await h.run(()=>h.drop(payload('enter')));await advance(650)
 row.dataset.path='/home/destination/file.txt'
 row.dataset.springFolder=undefined
 row.dataset.dir=undefined
 await h.run(()=>h.drop(payload('over')))
 assert.equal(h.panes[0].props.springHover.path,'/home/destination/file.txt')
 assert.equal(h.panes[1].props.springHover,null)
 await h.run(()=>h.drop(payload('cancelled')))
 assert.equal(h.panes[0].props.springHover,null)
 assert.equal(h.panes[0].props.springOpen,null)
 await advance(1000)
 assert.equal(h.panes[0].props.springOpen,null)
})

test('same-pane source keeps drag-opened ancestry while hovering a file whose pane-root drop would be a no-op', async t => {
 const {h,row,payload,advance}=await mount(t)
 await h.run(()=>h.drop({...payload('enter'),paths:['/home/source.txt']}));await advance(650)
 row.dataset.path='/home/destination/file.txt';row.dataset.dir=undefined;row.dataset.springFolder=undefined
 await h.run(()=>h.drop(payload('over')))
 assert.equal(h.panes[0].props.springHover.path,'/home/destination/file.txt')
})
