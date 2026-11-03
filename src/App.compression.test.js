import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, key } from './test/AppHarness.js'
test('compression keeps Undo pending after native acceptance, preserves dialog options, and later trashes only its identified archive',async t=>{
 const identity={dev:'1',ino:'123'},calls=[],trash=[];let status=null
 const running={id:'zip-1',operation:'compress',state:'running',total:1,processed:0,elapsedMs:0,outputBytes:42,results:[]}
 const h=await mountApp(t,{startCompression:async(...args)=>{calls.push(args);status=running;return running},extractionStatus:async()=>status,trash:async(paths,expected)=>{trash.push([paths,expected]);return{entries:paths.map(original=>({original})),error:null}}})
 const p=h.panes[0].props,id=p.pane.tabs[0].id,entry={name:'a.txt',path:'/home/a.txt',is_dir:false}
 await h.run(()=>p.onMenu(id,entry,1,1));const menu=h.root.findAll(n=>n.props.menu?.items&&n.props.onClose)[0]
 await h.run(()=>{menu.props.onClose();menu.props.menu.items.find(i=>i.label==='压缩…').action()})
 const dialog=h.root.findAll(n=>typeof n.type==='function'&&n.type.name==='ZipDialog')[0]
 await h.run(()=>dialog.props.onSubmit({dir:'/home',name:'custom.zip',level:9,password:'test-password',separate:false},{mode:'small',level:9,oneClick:false,separate:false,password:'',keepPassword:false}))
 assert.deepEqual(calls,[[['/home/a.txt'],'/home',{name:'custom.zip',level:9,password:'test-password',separate:false}]])
 await key(h,'z',{metaKey:true});assert.deepEqual(trash,[])
 status={...running,state:'completed',processed:1,results:[{source:'/home/a.txt',output:'/home/custom 2.zip',state:'completed',error:null,identity}]}
 await h.run(()=>new Promise(resolve=>setTimeout(resolve,420)));await key(h,'z',{metaKey:true})
 assert.deepEqual(trash,[[['/home/custom 2.zip'],[{path:'/home/custom 2.zip',...identity}]]]);assert.deepEqual(h.alerts,[])
})
