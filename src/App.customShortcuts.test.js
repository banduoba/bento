import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, key } from './test/AppHarness.js'

test('custom name and path keys replace defaults and leave normal file Copy untouched', async t=>{
 const text=[],copied=[]
 const h=await mountApp(t,{
  loadConfig:async()=>({shortcuts:{'edit-copy-names':'Meta+Shift+KeyY','edit-copy-paths':'Meta+Alt+KeyP'}}),
  copyFilesToClipboard:async paths=>{copied.push(paths);return{ok:true,changeCount:1,ownerToken:'file-owner'}},
 },{writeText:async value=>text.push(value)})
 const p=h.panes[0].props,id=p.pane.tabs[0].id
 await h.run(()=>{p.onRowsCache(id,[{path:'/home/测试.txt',name:'测试.txt'}]);p.onSelect(id,new Set(['/home/测试.txt']))})
 await key(h,'C',{code:'KeyC',metaKey:true,shiftKey:true})
 await key(h,'ç',{code:'KeyC',metaKey:true,altKey:true})
 assert.deepEqual(text,[])
 await key(h,'Y',{code:'KeyY',metaKey:true,shiftKey:true})
 await key(h,'π',{code:'KeyP',metaKey:true,altKey:true})
 assert.deepEqual(text,['测试.txt','/home/测试.txt'])
 await key(h,'c',{metaKey:true})
 assert.deepEqual(copied,[['/home/测试.txt']])
})
test('custom views retire old native and JS keys while synchronizing native accelerators',async t=>{
 const h=await mountApp(t,{loadConfig:async()=>({shortcuts:{'view-list':'Meta+Shift+KeyL','view-icons':null}})})
 await h.run(()=>h.events.get('bento-menu-command')({payload:'view-icons'}))
 await key(h,'2',{metaKey:true});assert.equal(h.panes[0].props.viewMode,'icons')
 await key(h,'L',{metaKey:true,shiftKey:true});assert.equal(h.panes[0].props.viewMode,'list')
 assert.deepEqual(h.invocations.filter(([name])=>name==='sync_menu_state').at(-1)[1].viewShortcuts,{'view-icons':null,'view-list':'Super+Shift+L','view-columns':'Super+3'})
})
test('custom file actions respect input, composition, modal and repeat guards',async t=>{
 const copies=[],h=await mountApp(t,{loadConfig:async()=>({shortcuts:{'file-duplicate':'Meta+Shift+KeyU'}}),transfer:async(...a)=>{copies.push(a);return[]}})
 const p=h.panes[0].props,id=p.pane.tabs[0].id
 await h.run(()=>p.onSelect(id,new Set(['/home/a'])))
 document.activeElement={tagName:'INPUT'}
 await key(h,'U',{metaKey:true,shiftKey:true})
 document.activeElement=null
 await key(h,'U',{metaKey:true,shiftKey:true,isComposing:true})
 await key(h,'U',{metaKey:true,shiftKey:true,repeat:true})
 await h.run(()=>h.root.findByProps({title:'窗口布局'}).props.onClick())
 await key(h,'U',{metaKey:true,shiftKey:true});assert.deepEqual(copies,[])
 await h.run(()=>h.root.findByProps({title:'窗口布局'}).props.onClick())
 await key(h,'d',{metaKey:true});assert.deepEqual(copies,[])
 await key(h,'U',{metaKey:true,shiftKey:true});assert.equal(copies.length,1)
})
test('settings changes validate atomically and persist through the existing close flush',async t=>{
 const h=await mountApp(t)
 const settings=()=>h.root.findAll(n=>typeof n.props.onShortcutsChange==='function')[0]
 assert.ok(settings())
 await h.run(()=>settings().props.onShortcutsChange({'file-rename':'Meta+Shift+KeyR'}))
 assert.deepEqual(h.panes[0].props.cfg.shortcuts,{'file-rename':'Meta+Shift+KeyR'})
 await assert.rejects(h.run(()=>settings().props.onShortcutsChange({'file-rename':'Meta+KeyC'})))
 assert.deepEqual(h.panes[0].props.cfg.shortcuts,{'file-rename':'Meta+Shift+KeyR'})
 const close=h.close();await h.run(()=>close.pending)
 assert.deepEqual(h.writes.config.at(-1).shortcuts,{'file-rename':'Meta+Shift+KeyR'})
})

test('opening shortcut settings releases native view key equivalents for the recorder and restores them on close',async t=>{
 const h=await mountApp(t)
 await key(h,',',{metaKey:true})
 const state=()=>h.invocations.filter(([name])=>name==='sync_menu_state').at(-1)[1].viewShortcuts
 assert.deepEqual(state(),{'view-icons':null,'view-list':null,'view-columns':null})
 const settings=h.root.findAll(n=>typeof n.props.onShortcutsChange==='function')[0]
 await h.run(()=>settings.props.onClose())
 assert.deepEqual(state(),{'view-icons':'Super+1','view-list':'Super+2','view-columns':'Super+3'})
})
