import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'
const require=createRequire(import.meta.url)
const bundle=await build({entryPoints:[fileURLToPath(new URL('./ShortcutSettings.jsx',import.meta.url))],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',plugins:[{name:'native-boundary',setup(b){
 b.onResolve({filter:/^react(?:\/.*)?$/},({path})=>({path:require.resolve(path),external:true}))
 b.onResolve({filter:/(?:^|\/)api(?:\.js)?$/},()=>({path:'api',namespace:'test'}))
 b.onResolve({filter:/^@tauri-apps\/plugin-dialog$/},()=>({path:'dialog',namespace:'test'}))
 b.onLoad({filter:/.*/,namespace:'test'},({path})=>({loader:'js',contents:path==='api'?'export const hasTauri=true;export const api=globalThis.__keysUI.api':'export const open=()=>globalThis.__keysUI.file;export const save=()=>globalThis.__keysUI.file'}))
}}]})
async function mount(t){
 const prev=globalThis.__keysUI,env=globalThis.IS_REACT_ACT_ENVIRONMENT
 globalThis.IS_REACT_ACT_ENVIRONMENT=true
 const calls=[],state={file:'/keys.json',text:'',api:{readShortcutBackup:async()=>state.text,exportShortcutBackup:async(...a)=>calls.push(a)}}
 globalThis.__keysUI=state
 const mod={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(require,mod,mod.exports)
 let renderer,value={}
 const props=()=>({value,onChange:next=>{value=next;renderer.update(React.createElement(mod.exports.default,props()))}})
 await act(async()=>{renderer=create(React.createElement(mod.exports.default,props()))})
 t.after(async()=>{await act(async()=>renderer.unmount());globalThis.__keysUI=prev;globalThis.IS_REACT_ACT_ENVIRONMENT=env})
 const button=label=>renderer.root.findAllByType('button').find(n=>n.props['aria-label']===label||n.children.join('')===label)
 return{state,calls,button,get value(){return value},text:()=>JSON.stringify(renderer.toJSON()),click:label=>act(async()=>{assert.ok(button(label),label);await button(label).props.onClick()}),record:(label,event)=>act(async()=>button(label).props.onKeyDown({preventDefault(){},stopPropagation(){},...event}))}
}
test('recording rejects conflicts, permits retry, removes/reset bindings and cancels Escape without changes',async t=>{
 const h=await mount(t)
 await h.click('修改复制名称快捷键')
 await h.record('修改复制名称快捷键',{key:'c',metaKey:true});assert.deepEqual(h.value,{})
 assert.match(h.text(),/保留/)
 await h.record('修改复制名称快捷键',{key:'Y',code:'KeyY',metaKey:true,shiftKey:true})
 assert.deepEqual(h.value,{'edit-copy-names':'Meta+Shift+KeyY'})
 await h.click('取消复制名称快捷键');assert.deepEqual(h.value,{'edit-copy-names':null})
 await h.click('恢复复制名称默认快捷键');assert.deepEqual(h.value,{})
 await h.click('修改复制名称快捷键');await h.record('修改复制名称快捷键',{key:'Escape'})
 assert.deepEqual(h.value,{})
})
test('presets, export and atomic import work; invalid files and cancelled dialogs preserve current values',async t=>{
 const h=await mount(t)
 await h.click('Commander');assert.equal(h.value['file-new-folder'],'F7')
 await h.click('导出方案…');assert.equal(h.calls[0][1].format,'bento-shortcuts')
 h.state.text=JSON.stringify({format:'bento-shortcuts',version:1,bindings:{'file-rename':'Meta+Shift+KeyR'}})
 await h.click('导入方案…');assert.deepEqual(h.value,{'file-rename':'Meta+Shift+KeyR'})
 h.state.text=JSON.stringify({format:'bento-shortcuts',version:1,bindings:{'file-rename':'Meta+KeyV'}})
 await h.click('导入方案…');assert.deepEqual(h.value,{'file-rename':'Meta+Shift+KeyR'})
 assert.match(h.text(),/保留/)
 h.state.file=null;await h.click('导入方案…');assert.deepEqual(h.value,{'file-rename':'Meta+Shift+KeyR'})
 await h.click('Finder');assert.deepEqual(h.value,{})
})
