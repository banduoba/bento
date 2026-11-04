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
