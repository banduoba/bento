import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'
const require = createRequire(import.meta.url)
const bundle = await build({ entryPoints:[fileURLToPath(new URL('../components/SearchOverlay.jsx',import.meta.url))], bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',plugins:[{name:'search-boundary',setup(b){
  b.onResolve({filter:/^react(?:\/.*)?$/},({path})=>({path:require.resolve(path),external:true}))
  b.onResolve({filter:/(?:^|\/)api(?:\.js)?$/},()=>({path:'api',namespace:'test'}))
  b.onResolve({filter:/(?:FileIcon|ContextMenu|nativeDrag)$/},({path})=>({path,namespace:'test'}))
  b.onLoad({filter:/.*/,namespace:'test'},({path})=>({loader:'js',contents:path==='api'?'export const api=new Proxy({}, {get:(_,k)=>(...a)=>globalThis.__searchTest[k](...a)}); export const hasTauri=false; export const fileSrc=x=>x':path.endsWith('nativeDrag')?'export const makeDragPreview=async()=>""; export const runNativeDrag=async()=>{}':'export default function Stub(){return null}'}))
}}]})
const mod={exports:{}}; new Function('require','module','exports',bundle.outputFiles[0].text)(require,mod,mod.exports)
const Overlay=mod.exports.default
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const item=(name='hit.txt')=>({name,path:`/work/${name}`,dir:'/work',is_dir:false,size:2,lines:[{no:1,text:'needle'}],matches:1})
const result=(items=[],extra={})=>({items,truncated:false,incomplete:false,warnings:[],source:'local',...extra})
async function mount(t, extra={}){
  const keys=['window','requestAnimationFrame','IS_REACT_ACT_ENVIRONMENT','__searchTest','setTimeout','clearTimeout'];const prev=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));const storage=Object.getOwnPropertyDescriptor(globalThis,'localStorage')
  globalThis.window=new EventTarget();globalThis.requestAnimationFrame=()=>0;globalThis.IS_REACT_ACT_ENVIRONMENT=true
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>null,setItem:()=>{}}})
  let next=0;const timers=new Map();globalThis.setTimeout=fn=>{timers.set(++next,fn);return next};globalThis.clearTimeout=id=>timers.delete(id)
  const requests=[],cancels=[],previews=[],opened=[]
  globalThis.__searchTest={searchQuery:(...args)=>{const d=deferred();requests.push({...d,args});return d.promise},cancelSearch:async id=>cancels.push(id),fsearchStatus:async()=>({ready:true}),readTextPreview:()=>{const d=deferred();previews.push(d);return d.promise}}
  const props={open:true,root:'/work',showHidden:false,searchPaths:[],scope:'pane',sortBy:'score',mode:'content',onModeChange(){},onScopeChange(){},onSortChange(){},onClose(){},onOpenEntry:e=>opened.push(e),onLocate(){},onReveal(){},...extra}
  let renderer;const err=console.error;console.error=(...args)=>{if(!String(args[0]).startsWith('react-test-renderer is deprecated.'))err(...args)}
  try{await act(async()=>{renderer=create(React.createElement(Overlay,props))})}finally{console.error=err}
  let live=true;const unmount=async()=>{if(live){live=false;await act(async()=>renderer.unmount())}}
  t.after(async()=>{await unmount();if(storage)Object.defineProperty(globalThis,'localStorage',storage);else delete globalThis.localStorage;for(const[k,v]of Object.entries(prev)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}})
  const run=async f=>act(async()=>{f()})
  return{requests,cancels,previews,opened,unmount,run,get root(){return renderer.root},text:()=>JSON.stringify(renderer.toJSON()),input:()=>renderer.root.findByType('input'),button:label=>renderer.root.findAllByType('button').find(n=>n.children.join('')===label),async type(q){await run(()=>renderer.root.findByType('input').props.onChange({target:{value:q}}))},async flush(){await run(()=>{for(const[id,fn]of [...timers]){timers.delete(id);fn()}})},async update(patch){Object.assign(props,patch);await run(()=>renderer.update(React.createElement(Overlay,props)))},async resolve(i,r){await run(()=>requests[i].resolve(r))}}
}
test('content preserves pane scope/root and scope controls remain enabled',async t=>{const h=await mount(t);await h.type('needle');await h.flush();assert.equal(h.requests.length,1);assert.deepEqual(h.requests[0].args.slice(0,6),['needle','pane','/work',false,[],'content']);assert.ok(!h.button('当前文件夹').props.disabled)})
test('new input, scope and close cancel old request; stale response cannot clear new busy/results',async t=>{const h=await mount(t);await h.type('old');await h.flush();await h.type('new');assert.ok(h.cancels.includes(h.requests[0].args[6]));await h.flush();await h.resolve(0,result([item('stale.txt')]));assert.ok(h.text().includes('搜索中'));assert.ok(!h.text().includes('stale.txt'));await h.resolve(1,result([item()]));await h.update({scope:'home'});await h.flush();await h.update({open:false});assert.ok(h.cancels.includes(h.requests[2].args[6]));await h.resolve(2,result([item('late.txt')]));assert.ok(!h.text().includes('late.txt'))})
test('failure is visible and retry resubmits; partial/truncated notices preserve usable hits',async t=>{const h=await mount(t);await h.type('needle');await h.flush();await h.run(()=>h.requests[0].reject({code:'io',message:'读取目录失败'}));assert.ok(h.text().includes('读取目录失败'));assert.ok(!h.text().includes('没有找到匹配'));await h.run(()=>h.button('重试').props.onClick());await h.flush();await h.resolve(1,result([item()],{incomplete:true,truncated:true,warnings:[{code:'budget',message:'扫描预算已用尽'}]}));assert.ok(h.text().includes('扫描预算已用尽'));assert.ok(h.text().includes('收窄'));assert.ok(h.text().includes('hit.txt'))})
test('format change reissues backend query before limit; keyboard and preview still operate',async t=>{const h=await mount(t);await h.type('needle');await h.flush();await h.resolve(0,result([item('one.txt'),item('two.txt')]));assert.equal(h.previews.length,1);await h.run(()=>h.input().props.onKeyDown({key:'ArrowDown',preventDefault(){}}));assert.equal(h.previews.length,2);await h.run(()=>h.previews[0].resolve({kind:'text',text:'OLD',matchLines:[]}));assert.ok(!h.text().includes('OLD'));await h.run(()=>h.previews[1].resolve({kind:'text',text:'CURRENT',matchLines:[1]}));assert.ok(h.text().includes('CURRENT'));await h.run(()=>h.input().props.onKeyDown({key:'Enter',preventDefault(){}}));assert.equal(h.opened[0].name,'two.txt');await h.run(()=>h.button('文档').props.onClick());await h.flush();assert.equal(h.requests[1].args[7],'document')})
test('incomplete zero matches and cancellation do not claim no matches',async t=>{const h=await mount(t);await h.type('needle');await h.flush();await h.resolve(0,result([],{incomplete:true,warnings:[{code:'budget',message:'尚未完成扫描'}]}));assert.ok(h.text().includes('尚未完成扫描'));assert.ok(!h.text().includes('没有找到匹配'));await h.type('again');await h.flush();await h.run(()=>h.requests[1].reject({code:'cancelled',message:'搜索已取消'}));assert.ok(h.text().includes('搜索已取消'));assert.ok(!h.text().includes('没有找到匹配'))})
