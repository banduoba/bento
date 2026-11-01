import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import React from 'react'
import { act, create } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const pane = await readFile(new URL('./Pane.jsx', import.meta.url), 'utf8')
const start = pane.indexOf('{isRenaming ? (') + '{isRenaming ? ('.length
const end = pane.indexOf(') : (', start)
assert.ok(start > 20 && end > start, 'actual Pane rename JSX boundary exists')
const componentImport = pane.match(/^import InlineRename .*$/m)?.[0] || ''
const bundle = await build({ stdin: { contents: `${componentImport}
export default function Boundary({renameRef, renamingHere, onRenameChange, onRenameCommit, onRenameCancel, scrollRef, onRenameHeight, tab={id:'t'}, entry={path:'/Report.txt'}}) { return (${pane.slice(start, end)}); }`, resolveDir: new URL('.', import.meta.url).pathname, loader: 'jsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', plugins: [{name: 'react-external', setup(b) { b.onResolve({filter: /^react(?:\/.*)?$/}, ({path}) => ({path: require.resolve(path), external: true})) }}] })
const mod = {exports: {}}; new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports)
const event = patch => ({ preventDefault() {this.prevented = true}, stopPropagation() {this.stopped = true}, ...patch })

async function mount(t, value = 'Report.txt') {
  const keys = ['window','document','ResizeObserver','IS_REACT_ACT_ENVIRONMENT']
  const prev = Object.fromEntries(keys.map(k => [k, globalThis[k]]))
  const listeners = new Set(), observers = [], heights = [], actions = [], changes = []
  const geometry = { available: 300, viewport: 180, glyphs: 70, viewportLeft: 0, viewportWidth: 1000, clientLeft: 0, paddingLeft: 0, paddingRight: 0, scrollLeft: 0 }
  const scrollListeners = new Set()
  const win = { addEventListener(type, fn) {if(type === 'resize') listeners.add(fn)}, removeEventListener(type, fn) {if(type === 'resize') listeners.delete(fn)}, getComputedStyle(node) {if(node === viewport) return {paddingLeft: String(geometry.paddingLeft), paddingRight: String(geometry.paddingRight)};return {paddingLeft:'6px',paddingRight:'6px',paddingTop:'1px',paddingBottom:'1px',borderLeftWidth:'1.5px',borderRightWidth:'1.5px',borderTopWidth:'1.5px',borderBottomWidth:'1.5px',lineHeight:'22px'}} }
  globalThis.window = win
  globalThis.document = {activeElement: null}
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver = class { constructor(cb) {this.cb=cb; this.nodes=new Set(); observers.push(this)} observe(n) {this.nodes.add(n)} disconnect() {this.nodes.clear()} }
  const container = {getBoundingClientRect: () => ({right:100+geometry.available-geometry.scrollLeft}), ownerDocument:{defaultView:win}}
  const input = {style:{}, parentElement:container, ownerDocument:{defaultView:win}, getBoundingClientRect:()=>({left:100-geometry.scrollLeft+(parseFloat(input.style.marginLeft)||0)}), get scrollHeight() {return Math.max(1, Math.ceil(geometry.glyphs / Math.max(1, parseFloat(this.style.width)-15))) * 22 + 2} }
  const mirror = {getBoundingClientRect:()=>({width:geometry.glyphs})}
  const viewport = {get scrollLeft() {return geometry.scrollLeft}, get clientHeight() {return geometry.viewport}, get clientWidth() {return geometry.viewportWidth}, get clientLeft() {return geometry.clientLeft}, getBoundingClientRect:()=>({left:geometry.viewportLeft}), addEventListener(type,fn) {if(type==='scroll')scrollListeners.add(fn)}, removeEventListener(type,fn) {if(type==='scroll')scrollListeners.delete(fn)}}
  const props = {renameRef:{current:null},scrollRef:{current:viewport},renamingHere:{value},onRenameHeight:n=>heights.push(n),onRenameChange:v=>changes.push(v),onRenameCommit:()=>actions.push('commit'),onRenameCancel:()=>actions.push('cancel')}
  let renderer, mounted=true
  const oldError = console.error
  try { console.error=(...args)=>{if(!String(args[0]).startsWith('react-test-renderer is deprecated.')) oldError(...args)}
    await act(async()=>{renderer=create(React.createElement(mod.exports.default,props),{createNodeMock:el=>el.type==='textarea'||el.type==='input'?input:mirror})})
  } finally {console.error=oldError}
  const unmount=async()=>{if(mounted){await act(async()=>renderer.unmount());mounted=false}}
  t.after(async()=>{await unmount(); for(const [k,v] of Object.entries(prev)){if(v===undefined) delete globalThis[k];else globalThis[k]=v}})
  return {input,geometry,props,heights,actions,changes,listeners,observers,scrollListeners,unmount,scroll:()=>act(async()=>{for(const listener of scrollListeners)listener()}),get editor(){return renderer.root.findAll(n=>n.type==='input'||n.type==='textarea')[0]},run:fn=>act(async()=>fn()),update:async v=>{props.renamingHere={value:v}; await act(async()=>renderer.update(React.createElement(mod.exports.default,props)))},resize:()=>act(async()=>{for(const o of observers) if(o.nodes.size) o.cb([])})}
}

test('Pane renders a native soft wrapping rename textarea fitted to actual glyph width', async t=>{
  const h=await mount(t)
  assert.equal(h.editor.type,'textarea')
  assert.equal(h.editor.props.wrap,'soft')
  assert.equal(h.input.style.width,'87px')
  assert.equal(h.input.style.height,'27px')
  assert.deepEqual(h.heights,[30])
  h.geometry.glyphs=140; await h.update('中文文件名.txt')
  assert.equal(h.input.style.width,'157px')
  h.geometry.glyphs=10; await h.update('x')
  assert.equal(h.input.style.width,'48px')
})

test('long names wrap after fixed row controls; width/value shrink restores one line and caps tall editors',async t=>{
  const h=await mount(t,'long name.txt')
  h.geometry.available=85; h.geometry.glyphs=350; await h.resize()
  assert.equal(h.input.style.width,'79px')
  assert.equal(h.input.style.height,'137px')
  assert.equal(h.heights.at(-1),139)
  h.geometry.available=35; await h.resize()
  assert.equal(h.input.style.width,'29px','available width overrides minimum')
  assert.equal(h.input.style.height,'172px')
  assert.equal(h.input.style.overflowY,'auto')
  h.geometry.available=400; h.geometry.glyphs=20; await h.update('a b.txt')
  assert.equal(h.input.style.width,'48px'); assert.equal(h.input.style.height,'27px'); assert.equal(h.heights.at(-1),30)
  const count=h.heights.length; await h.resize(); assert.equal(h.heights.length,count,'unchanged dimensions do not publish another row size')
  assert.equal(h.observers.length,1); assert.equal(h.observers[0].nodes.size,2); assert.equal(h.listeners.size,1)
  await h.unmount(); assert.equal(h.observers[0].nodes.size,0); assert.equal(h.listeners.size,0)
  h.geometry.glyphs=900; const finishedCount=h.heights.length
  await h.run(()=>h.observers[0].cb([])); assert.equal(h.heights.length,finishedCount,'queued measurement after unmount cannot update the row')
})

test('Enter/Escape/blur finish once and composition never finishes; soft wrap leaves filename intact',async t=>{
  const h=await mount(t)
  await h.run(()=>h.editor.props.onCompositionStart?.())
  for(const key of ['Enter','Escape']) {const e=event({key});await h.run(()=>h.editor.props.onKeyDown(e));assert.equal(e.stopped,true)}
  assert.deepEqual(h.actions,[])
  await h.run(()=>h.editor.props.onCompositionEnd?.())
  const native=event({key:'Enter',nativeEvent:{isComposing:true}});await h.run(()=>h.editor.props.onKeyDown(native));assert.deepEqual(h.actions,[])
  const legacy=event({key:'Escape',keyCode:229});await h.run(()=>h.editor.props.onKeyDown(legacy));assert.deepEqual(h.actions,[])
  await h.run(()=>h.editor.props.onChange({target:{value:'中 文\r\nline.txt'}})); assert.deepEqual(h.changes,['中 文line.txt'])
  const enter=event({key:'Enter'}); await h.run(()=>h.editor.props.onKeyDown(enter)); assert.equal(enter.prevented,true); assert.deepEqual(h.actions,['commit'])
  await h.run(()=>h.editor.props.onBlur()); assert.deepEqual(h.actions,['commit'])
})

test('Escape cancels without blur commit; editor mouse selection and native editing shortcuts stay native',async t=>{
  const h=await mount(t)
  for(const handler of ['onMouseDown','onClick','onDoubleClick','onContextMenu']) {const e=event();await h.run(()=>h.editor.props[handler]?.(e));assert.equal(e.stopped,true);assert.equal(e.prevented,undefined)}
  for(const key of ['a','c','v','z']) {const e=event({key,metaKey:true});await h.run(()=>h.editor.props.onKeyDown(e));assert.equal(e.stopped,undefined);assert.equal(e.prevented,undefined)}
  const esc=event({key:'Escape'});await h.run(()=>h.editor.props.onKeyDown(esc)); await h.run(()=>h.editor.props.onBlur()); assert.deepEqual(h.actions,['cancel']);assert.equal(esc.prevented,true)
})

test('ordinary blur commits rename',async t=>{const h=await mount(t);await h.run(()=>h.editor.props.onBlur());assert.deepEqual(h.actions,['commit'])})

// Execute App's actual commit callback to protect the editor's once-only finish
// contract: App closes the editor before its empty-name checks or native result.
const app = await readFile(new URL('../App.jsx',import.meta.url),'utf8')
const commitStart=app.indexOf('  const commitRename = () => {')
const commitEnd=app.indexOf('\n\n  // ---------- 右键菜单',commitStart)
assert.ok(commitStart>=0&&commitEnd>commitStart)
const commitSource=app.slice(commitStart,commitEnd).replace('  const commitRename = ','')
test('actual App commit closes empty, unchanged and rejected renames before native outcome',async()=>{
  for(const value of ['', 'file.txt', 'invalid/name']) {
    const history=[],renaming={tabId:'t',path:'/file.txt',value}
    const callback=new Function('renaming','setRenaming','basename','renameItems','alert','setSel',`return (${commitSource})`)(renaming,v=>history.push(['editor',v]),p=>p.slice(p.lastIndexOf('/')+1),()=>{history.push(['native']);return Promise.resolve(['failed'])},()=>history.push(['error']),()=>history.push(['selection']))
    callback();assert.deepEqual(history[0],['editor',null])
    if(value==='invalid/name'){assert.deepEqual(history[1],['native']);await Promise.resolve();assert.deepEqual(history[2],['error'])}
    else assert.equal(history.length,1)
  }
})


test('saved wide name column wraps within the visible viewport client box and follows horizontal scroll',async t=>{
  const h=await mount(t,'long filename.txt')
  Object.assign(h.geometry,{available:530,glyphs:600,viewportLeft:20,clientLeft:2,viewportWidth:210,paddingLeft:4,paddingRight:6})
  await h.resize()
  // Client box [22,232], usable content [26,226], editor starts at 100.
  assert.equal(h.input.style.width,'126px')
  assert.equal(h.input.style.height,'137px')
  assert.equal(h.scrollListeners.size,1)
  h.geometry.scrollLeft=140;await h.scroll()
  assert.equal(h.input.style.marginLeft,'66px','scrolled-off editor start is brought into the visible intersection')
  assert.equal(h.input.style.width,'200px')
  assert.equal(h.input.style.height,'93px')
  h.geometry.scrollLeft=0;await h.scroll()
  assert.equal(h.input.style.marginLeft,'0px');assert.equal(h.input.style.width,'126px')
  h.geometry.viewportWidth=350;await h.resize()
  assert.equal(h.input.style.width,'266px')
  h.geometry.available=85;await h.resize()
  assert.equal(h.input.style.width,'79px','the original name-column bound still applies')
  await h.unmount()
  assert.equal(h.scrollListeners.size,0);assert.equal(h.listeners.size,0);assert.ok(h.observers.every(observer=>observer.nodes.size===0))
})
