import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import React from 'react'
import { act, create } from 'react-test-renderer'
const require = createRequire(import.meta.url)
const bundle = await build({entryPoints:[new URL('./Pane.jsx',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',plugins:[{name:'pane-io',setup(b){
  b.onResolve({filter:/^react(?:\/.*)?$/},({path})=>({path:require.resolve(path),external:true}))
  b.onResolve({filter:/(?:^|\/)(api|nativeDrag|fsWatch|FileIcon)(?:\.jsx?)?$|^@tauri-apps\/api\/core$/},({path})=>({path,namespace:'pane-io'}))
  b.onLoad({filter:/.*/,namespace:'pane-io'},({path})=>({contents:
    path.includes('nativeDrag')?'export const trace=()=>{}; export const makeDragPreview=(...args)=>(globalThis.__renamePane.drags.push(args),Promise.resolve(null)); export const fallbackPreview=()=>null; export const runNativeDrag=()=>{}':
    path.includes('FileIcon')?'export default ()=>null':
    path.includes('fsWatch')?'export const setWatch=()=>{}; export const clearWatch=()=>{}; export const onFsChange=()=>()=>{}':
    path.includes('@tauri')?'export class Channel {}':
    'export const hasTauri=false; export const api={listDirStream:async (...args)=>args.at(-1).onmessage({entries:globalThis.__renamePane.entries,done:true,total:globalThis.__renamePane.entries.length}),cancelListDir:async()=>{},dirActivity:async()=>[]}'
  }))
}}]})
async function mount(t, renameIndex=0) {
  const keys=['window','document','ResizeObserver','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT','__renamePane']
  const previous=Object.fromEntries(keys.map(k=>[k,globalThis[k]])), observers=[], nodes=new Map(), frames=new Map(), actions=[], selected=[]
  let frameId=0
  const geometry={glyphs:200,available:85,viewport:180}
  const listeners=new Map()
  const target=()=>({addEventListener(type,fn){if(!listeners.has(this))listeners.set(this,new Map());const map=listeners.get(this);if(!map.has(type))map.set(type,new Set());map.get(type).add(fn)},removeEventListener(type,fn){listeners.get(this)?.get(type)?.delete(fn)}})
  const win={...target(),innerHeight:800,requestAnimationFrame:fn=>{frames.set(++frameId,fn);return frameId},cancelAnimationFrame:id=>frames.delete(id),setTimeout,clearTimeout,getComputedStyle:()=>({paddingLeft:'6px',paddingRight:'6px',paddingTop:'1px',paddingBottom:'1px',borderLeftWidth:'1.5px',borderRightWidth:'1.5px',borderTopWidth:'1.5px',borderBottomWidth:'1.5px',lineHeight:'22px'})}
  const doc={defaultView:win,activeElement:null,body:{classList:{add(){},remove(){}}}}
  const entries=Array.from({length:100},(_,n)=>({name:`file${String(n).padStart(3,'0')}.txt`,path:`/fixture/file${String(n).padStart(3,'0')}.txt`,is_dir:false,size:3,mtime_ms:0}))
  globalThis.__renamePane={entries,drags:[]};globalThis.window=win;globalThis.document=doc;globalThis.IS_REACT_ACT_ENVIRONMENT=true
  globalThis.requestAnimationFrame=win.requestAnimationFrame;globalThis.cancelAnimationFrame=win.cancelAnimationFrame
  globalThis.ResizeObserver=win.ResizeObserver=class {constructor(cb){this.cb=cb;this.nodes=new Set();observers.push(this)}observe(n){this.nodes.add(n)}unobserve(n){this.nodes.delete(n)}disconnect(){this.nodes.clear()}}
  const tab={id:'t',path:'/fixture',history:['/fixture'],hi:0,sortKey:'name',sortDir:'asc'}
  const props={index:0,pane:{tabs:[tab],active:0},cfg:{showHidden:false,autoRefresh:false},focused:true,selection:new Set(),filter:'',tick:0,cutSet:new Set(),home:'/fixture',renaming:{tabId:'t',path:entries[renameIndex].path,value:entries[renameIndex].name},onRowsCache(){},onStats(){},onFocus(){},onRenameChange(){},onRenameCommit:()=>actions.push('commit'),onRenameCancel:()=>actions.push('cancel'),onSelect:(...a)=>selected.push(a),onOpen:()=>actions.push('open')}
  const nodeFor=el=>{
    const name=el.type==='textarea'?'textarea':el.props.className
    if(nodes.has(name))return nodes.get(name)
    const node={...target(),tagName:el.type.toUpperCase(),value:el.props.value||'',style:{setProperty(){}},ownerDocument:doc,scrollTop:0,scrollLeft:0,clientLeft:0,scrollWidth:600,clientWidth:600,scrollHeight:3000,isConnected:true,get clientHeight(){return geometry.viewport},getBoundingClientRect:()=>({left:100,right:100+geometry.available,top:0,width:name==='rename-measure'?geometry.glyphs:600,height:180}),focus(){doc.activeElement=this;this.focusCount=(this.focusCount||0)+1},setSelectionRange(a,b){this.selection=[a,b]},scrollTo({top}){this.scrollTop=top}}
    if(name==='textarea'){node.parentElement=nodeFor({type:'div',props:{className:'row-name'}});Object.defineProperty(node,'scrollHeight',{get:()=>Math.ceil(geometry.glyphs/Math.max(1,parseFloat(node.style.width)-15))*22+2})}
    nodes.set(name,node);return node
  }
  let renderer,mounted=true
  const mod={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(require,mod,mod.exports)
  const oldError=console.error
  try{console.error=(...args)=>{if(!String(args[0]).startsWith('react-test-renderer is deprecated.'))oldError(...args)};await act(async()=>{renderer=create(React.createElement(mod.exports.default,props),{createNodeMock:nodeFor})})}finally{console.error=oldError}
  const unmount=async()=>{if(mounted){await act(async()=>renderer.unmount());mounted=false}}
  t.after(async()=>{await unmount();for(const[k,v]of Object.entries(previous)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}})
  return {nodes,geometry,observers,listeners,frames,actions,selected,props,unmount,get root(){return renderer.root},get drags(){return globalThis.__renamePane.drags},get rows(){return renderer.root.findAll(n=>n.type==='div'&&n.props['data-path'])},update:patch=>act(async()=>{Object.assign(props,patch);renderer.update(React.createElement(mod.exports.default,props))}),run:fn=>act(async()=>fn()),scroll:offset=>act(async()=>{const scroll=nodes.get('rows');scroll.scrollTop=offset;for(const fn of listeners.get(scroll)?.get('scroll')||[])fn()}),resize:()=>act(async()=>{for(const o of observers)if(o.nodes.size)o.cb([{contentRect:{width:600}}])})}
}
const event=patch=>({button:0,clientX:100,clientY:20,preventDefault(){this.prevented=true},stopPropagation(){this.stopped=true},...patch})

test('one wrapped editing row shifts its virtual neighbors and restores ordinary height on finish',async t=>{
  const h=await mount(t)
  assert.ok(h.rows.length>2,'real virtualizer renders a viewport')
  assert.equal(h.rows[0].props.style.height,95)
  assert.equal(h.rows[1].props.style.transform,'translateY(95px)')
  assert.equal(h.nodes.get('textarea').focusCount,1)
  assert.deepEqual(h.nodes.get('textarea').selection,[0,7])
  await h.update({renaming:null})
  assert.equal(h.rows[0].props.style.height,30)
  assert.equal(h.rows[1].props.style.transform,'translateY(30px)')
})

test('virtual scroll keeps the active editor mounted without focus/selection churn and cleanup releases measurements',async t=>{
  const h=await mount(t,80)
  assert.ok(h.rows.some(n=>n.props['data-path']==='/fixture/file080.txt'))
  const editor=h.nodes.get('textarea');assert.deepEqual(editor.selection,[0,7]);assert.equal(editor.focusCount,1)
  await h.scroll(0)
  assert.ok(h.rows.some(n=>n.props['data-path']==='/fixture/file080.txt'))
  assert.ok(h.rows.length<50,'only viewport plus one editor is mounted')
  assert.equal(h.nodes.get('textarea'),editor);assert.equal(editor.focusCount,1)
  await h.update({renaming:{...h.props.renaming,value:'changed.txt'}})
  assert.equal(editor.focusCount,1)
  await h.unmount();assert.ok(h.observers.every(o=>o.nodes.size===0));assert.equal(h.frames.size,0)
  assert.ok([...h.listeners.values()].every(map=>[...map.values()].every(set=>set.size===0)))
})

test('editor gestures do not reach row drag/open/selection and blank marquee is disabled while editing',async t=>{
  const h=await mount(t)
  const input=h.root.findAllByType('textarea')[0];assert.ok(input,'rename editor is multiline')
  for(const name of ['onMouseDown','onClick','onDoubleClick']){
    const e=event({target:h.nodes.get('textarea')})
    await h.run(()=>{for(let n=input;n&&!e.stopped;n=n.parent)if(typeof n.type==='string')n.props[name]?.(e)})
  }
  assert.deepEqual(h.drags,[]);assert.deepEqual(h.selected,[]);assert.deepEqual(h.actions,[])
  const rows=h.root.findByProps({className:'rows'}),blank=event({target:h.nodes.get('rows')})
  await h.run(()=>rows.props.onMouseDown(blank))
  assert.equal(h.listeners.get(globalThis.window)?.get('mousemove')?.size,1,'only native row drag listener remains, no marquee listener')
})

test('active row height follows value and viewport changes, and tab switch drops editor measurements',async t=>{
  const h=await mount(t)
  h.geometry.glyphs=20;await h.update({renaming:{...h.props.renaming,value:'x.txt'}})
  assert.equal(h.rows[0].props.style.height,30);assert.equal(h.rows[1].props.style.transform,'translateY(30px)')
  h.geometry.glyphs=600;h.geometry.viewport=100;await h.resize()
  assert.equal(h.rows[0].props.style.height,94);assert.equal(h.nodes.get('textarea').style.overflowY,'auto')
  await h.update({pane:{tabs:[{id:'other',path:'/other',history:['/other'],hi:0,sortKey:'name',sortDir:'asc'}],active:0}})
  assert.equal(h.root.findAllByType('textarea').length,0)
  assert.ok(h.rows.every(row=>row.props.style.height===30))
  assert.equal([...h.observers].filter(o=>[...o.nodes].some(n=>n===h.nodes.get('row-name'))).length,0)
})

test('selectAll rename selects extension too and cancel restores virtual neighbor positions',async t=>{
  const h=await mount(t)
  await h.update({renaming:null})
  // The DOM node fake is reused intentionally; real focus leaves it on unmount.
  globalThis.document.activeElement=null
  await h.update({renaming:{tabId:'t',path:'/fixture/file000.txt',value:'file000.txt',selectAll:true}})
  assert.deepEqual(h.nodes.get('textarea').selection,[0,11])
  await h.run(()=>h.root.findByType('textarea').props.onKeyDown(event({key:'Escape'})))
  assert.deepEqual(h.actions,['cancel'])
  await h.update({renaming:null})
  assert.equal(h.rows[1].props.style.transform,'translateY(30px)')
})

test('starting rename during a marquee releases fixed-row selection listeners without clearing selection',async t=>{
  const h=await mount(t),renaming=h.props.renaming
  await h.update({renaming:null})
  await h.run(()=>h.root.findByProps({className:'rows'}).props.onMouseDown(event({target:h.nodes.get('rows')})))
  assert.equal(h.listeners.get(globalThis.window).get('mousemove').size,2)
  await h.update({renaming})
  assert.equal(h.listeners.get(globalThis.window).get('mousemove').size,1)
  assert.deepEqual(h.selected,[])
})
