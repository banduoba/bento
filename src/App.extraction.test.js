import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, deferred, key } from './test/AppHarness.js'
const job={id:'one',state:'completed',source:'/home/sample.zip',currentEntry:null,elapsedMs:2200,total:1,processed:1,results:[{source:'/home/sample.zip',output:'/home/sample 2',state:'completed',error:null}],error:null}
test('completed extraction refreshes its source directory and Locate selects the output in the current pane',async t=>{
 const h=await mountApp(t,{extractionStatus:async()=>job})
 const before=h.panes[0].props.directoryVersions
 const button=h.root.findAllByType('button').find(b=>b.children.join('')==='定位输出文件夹');assert.ok(button)
 await h.run(()=>button.props.onClick())
 const pane=h.panes[0].props;assert.equal(pane.pane.tabs[pane.pane.active].path,'/home');assert.equal(pane.reveal.path,'/home/sample 2')
 assert.ok(Object.keys(before).length>0)
})
test('failure preserves its output action and offers the unchanged system archive utility fallback',async t=>{
 const calls=[],h=await mountApp(t,{extractionStatus:async()=>({...job,state:'failed',results:[{...job.results[0],state:'failed',error:'damaged archive'}]}),extractArchive:async paths=>calls.push(paths)})
 const buttons=h.root.findAllByType('button');assert.ok(buttons.find(b=>b.children.join('')==='查看部分文件'))
 await h.run(()=>buttons.find(b=>b.children.join('')==='用系统归档工具解压…').props.onClick());assert.deepEqual(calls,[['/home/sample.zip']])
})
test('graceful close drains extraction before destroying the window and feedback focus blocks native file actions',async t=>{
 const gate=deferred(),copies=[],h=await mountApp(t,{stopExtraction:()=>gate.promise,copyFilesToClipboard:async p=>copies.push(p)})
 const pane=h.panes[0].props,id=pane.pane.tabs[0].id;await h.run(()=>pane.onSelect(id,new Set(['/home/a'])))
 document.activeElement={closest:selector=>selector==='[data-extraction-feedback]'?{}:null}
 await h.run(()=>h.events.get('bento-menu-command')({payload:'edit-copy'}));assert.deepEqual(copies,[])
 document.activeElement=null
 const close=h.close();await h.run(()=>Promise.resolve());assert.equal(h.destroyed,0);await h.run(()=>gate.resolve());await h.run(()=>close.pending);assert.equal(h.destroyed,1)
})
test('extraction completion automatically selects all successful sibling folders without requiring Locate click',async t=>{
 const second={source:'/home/second.zip',output:'/home/second',state:'completed',error:null}
 const h=await mountApp(t,{extractionStatus:async()=>({...job,total:3,processed:3,state:'partial',results:[job.results[0],second,{source:'/home/bad.zip',output:'/home/bad',state:'failed',error:'bad'}]})})
 const p=h.panes[0].props;assert.deepEqual([...p.selection],['/home/sample 2','/home/second']);assert.equal(p.reveal.path,'/home/sample 2');assert.deepEqual(p.reveal.selectionPaths,['/home/sample 2','/home/second'])
})
for (const closed of [false,true]) test(`extraction completion ${closed?'does not hijack another tab when origin closes':'returns to the captured origin tab after navigation'}`,async t=>{
 let status=null;const live={...job,id:'live',state:'running',processed:0,results:[]}
 const h=await mountApp(t,{extractionStatus:async()=>status,startExtraction:async()=>live})
 const p=h.panes[0].props,id=p.pane.tabs[0].id,entry={path:'/home/sample.zip',name:'sample.zip',is_dir:false}
 await h.run(()=>p.onMenu(id,entry,1,1));const node=h.root.findAll(n=>n.props.menu?.items&&n.props.onClose)[0],item=node.props.menu.items.find(i=>i.label==='解压缩')
 await h.run(()=>{node.props.onClose();return item.action()})
 if(closed){await h.run(()=>h.panes[0].props.onNewTab(0));await h.run(()=>h.panes[0].props.onCloseTab(id))}
 else await h.run(()=>h.panes[0].props.onNav(id,'/elsewhere'))
 status={...job,id:'live'};await h.run(()=>new Promise(resolve=>setTimeout(resolve,420)))
 const origin=h.panes.flatMap(n=>n.props.pane.tabs).find(t=>t.id===id)
 if(closed){assert.equal(origin,undefined);assert.ok(h.panes.every(n=>!n.props.reveal))}
 else {assert.equal(origin.path,'/home');assert.deepEqual([...h.panes[0].props.selection],['/home/sample 2'])}
})
test('compression completion automatically selects created ZIP files and excludes failed outputs',async t=>{
 const h=await mountApp(t,{extractionStatus:async()=>({...job,operation:'compress',source:'/home/a',total:3,processed:3,state:'partial',results:[{source:'/home/a',output:'/home/a.zip',state:'completed',error:null},{source:'/home/b',output:'/home/b.zip',state:'completed',error:null},{source:'/home/c',output:null,state:'failed',error:'failed'}]})})
 assert.deepEqual([...h.panes[0].props.selection],['/home/a.zip','/home/b.zip']);assert.equal(h.panes[0].props.reveal.path,'/home/a.zip')
})
test('success feedback disappears while automatically selected output stays selected',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=await mountApp(t,{extractionStatus:async()=>({...job,operation:'compress',results:[{source:'/home/a',output:'/home/a.zip',state:'completed',error:null}]})})
 assert.deepEqual([...h.panes[0].props.selection],['/home/a.zip']);await h.run(()=>t.mock.timers.tick(4000));assert.equal(h.root.findAll(n=>n.props['data-extraction-feedback']).length,0);assert.deepEqual([...h.panes[0].props.selection],['/home/a.zip'])
})
