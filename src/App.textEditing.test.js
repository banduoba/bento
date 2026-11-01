import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp } from './test/AppHarness.js'
import { operationBoundary, key } from './test/OperationBoundary.js'

// This boundary deliberately records commands only: it does not fake an undo stack.
// Real controlled-input/history behavior is covered by the macOS build acceptance.
test('App sends focused text Undo/Redo to the editor without dispatching file operations', async t => {
  const b = operationBoundary(), h = await mountApp(t, b.api), commands = []
  document.execCommand = (...args) => { commands.push(args); return true }
  for (const element of [{tagName:'INPUT'}, {tagName:'TEXTAREA'}, {tagName:'DIV',isContentEditable:true}]) {
    document.activeElement = element
    assert.equal((await key(h, 'z', {metaKey:true})).defaultPrevented, true)
    assert.equal((await key(h, 'Z', {metaKey:true,shiftKey:true})).defaultPrevented, true)
  }
  assert.deepEqual(commands.map(c => c[0]), ['undo','redo','undo','redo','undo','redo'])
  assert.equal(b.calls.some(c => c[0] === 'undo'), false)
  document.activeElement = null
  const count = commands.length
  await key(h, 'Z', {metaKey:true,shiftKey:true})
  assert.equal(commands.length, count)
})

test('contenteditable copy and file shortcuts remain in the text editing context', async t => {
  const b = operationBoundary(), h = await mountApp(t, b.api), commands = []
  document.activeElement = {tagName:'DIV',isContentEditable:true}
  document.execCommand = (...args) => { commands.push(args); return true }
  await key(h, 'a', {metaKey:true})
  await key(h, 'Backspace', {metaKey:true})
  assert.deepEqual(commands.map(c => c[0]), ['selectAll'])
  assert.equal(b.requests.length, 0)
})

function inputFixture(h, value = 'before SELECT after', start = 7, end = 13) {
  const events = new EventTarget(), commands = []
  document.addEventListener = events.addEventListener.bind(events)
  document.removeEventListener = events.removeEventListener.bind(events)
  document.dispatchEvent = events.dispatchEvent.bind(events)
  const el = {tagName:'INPUT',value,selectionStart:start,selectionEnd:end,isConnected:true}
  window.HTMLInputElement = class {}
  Object.defineProperty(window.HTMLInputElement.prototype, 'value', {set(value) {this.value=value}})
  el.dispatchEvent = () => true
  document.activeElement = el
  document.execCommand = (...args) => { commands.push(args); return true }
  return {el,commands,emit(type) {const e=new Event(type); Object.defineProperty(e,'target',{value:el});document.dispatchEvent(e)}}
}

test('paste replaces the native selection through the browser history command, without assigning controlled values', async t => {
  const h = await mountApp(t, {}, undefined, {readText:async()=> 'pasted'})
  const {el,commands} = inputFixture(h)
  await key(h, 'v', {metaKey:true})
  assert.deepEqual(commands, [['insertText',false,'pasted']])
  assert.equal(el.value, 'before SELECT after') // only the browser may mutate a controlled field
})

test('cut writes the selected text before requesting an undoable native deletion', async t => {
  const writes=[],h=await mountApp(t,{},undefined,{writeText:async text=>writes.push(text)})
  const {el,commands}=inputFixture(h)
  await key(h,'x',{metaKey:true})
  assert.deepEqual(writes,['SELECT'])
  assert.deepEqual(commands,[['delete',false,null]])
  assert.equal(el.value,'before SELECT after')
})

for (const invalidation of ['focus','selection','input','blur-return','detach','unmount']) {
  test(`pending paste cannot edit after ${invalidation}`, async t => {
    let resolve
    const gate=new Promise(r=>{resolve=r})
    const h=await mountApp(t,{},undefined,{readText:()=>gate})
    const {el,commands,emit}=inputFixture(h)
    await key(h,'v',{metaKey:true})
    if(invalidation==='focus') document.activeElement={tagName:'INPUT'}
    if(invalidation==='selection') el.selectionStart=0
    if(invalidation==='input') emit('input')
    if(invalidation==='blur-return') {emit('focusout');document.activeElement=el}
    if(invalidation==='detach') el.isConnected=false
    if(invalidation==='unmount') await h.unmount()
    await h.run(async()=>{resolve('late');await gate})
    assert.deepEqual(commands,[])
    assert.equal(el.value,'before SELECT after')
  })
}

test('pending paste cannot edit after the document loses application focus', async t => {
  let resolve
  const gate=new Promise(r=>{resolve=r}),h=await mountApp(t,{},undefined,{readText:()=>gate})
  const {commands}=inputFixture(h)
  document.hasFocus=()=>true
  await key(h,'v',{metaKey:true})
  document.hasFocus=()=>false
  await h.run(async()=>{resolve('late');await gate})
  assert.deepEqual(commands,[])
})

test('textarea replacement and contenteditable selection use the same native editing path', async t => {
  const writes=[],h=await mountApp(t,{},undefined,{readText:async()=> 'new',writeText:async text=>writes.push(text)})
  const {el,commands}=inputFixture(h)
  el.tagName='TEXTAREA'
  await key(h,'v',{metaKey:true})
  el.tagName='DIV';el.isContentEditable=true;el.textContent='old selected'
  const node={}
  document.getSelection=()=>({rangeCount:1,getRangeAt:()=>({startContainer:node,startOffset:4,endContainer:node,endOffset:12}),toString:()=> 'selected'})
  await key(h,'x',{metaKey:true})
  await key(h,'v',{metaKey:true})
  assert.deepEqual(writes,['selected'])
  assert.deepEqual(commands,[['insertText',false,'new'],['delete',false,null],['insertText',false,'new']])
})

test('overtaken clipboard requests cannot apply in reverse completion order', async t => {
  const resolves=[]
  const h=await mountApp(t,{},undefined,{readText:()=>new Promise(r=>resolves.push(r))})
  const {commands}=inputFixture(h)
  await key(h,'v',{metaKey:true});await key(h,'v',{metaKey:true})
  await h.run(async()=>{resolves[1]('new');await Promise.resolve()})
  await h.run(async()=>{resolves[0]('old');await Promise.resolve()})
  assert.deepEqual(commands,[['insertText',false,'new']])
})

test('failed clipboard writes never delete selected text', async t => {
  const h=await mountApp(t,{},undefined,{writeText:async()=>{throw Error('clipboard denied')}})
  const {el,commands}=inputFixture(h)
  await key(h,'x',{metaKey:true})
  assert.equal(el.value,'before SELECT after')
  assert.deepEqual(commands,[])
})

test('pending cut cannot delete after selection changes, even when it returns to the same range', async t => {
  let resolve
  const gate=new Promise(r=>{resolve=r}),h=await mountApp(t,{},undefined,{writeText:()=>gate})
  const {el,commands,emit}=inputFixture(h)
  await key(h,'x',{metaKey:true})
  el.selectionStart=0;emit('selectionchange');el.selectionStart=7
  await h.run(async()=>{resolve();await gate})
  assert.deepEqual(commands,[])
})

test('IME composition, readonly paste and modified shortcuts do not request native edits', async t => {
  const h=await mountApp(t),{el,commands}=inputFixture(h)
  await key(h,'z',{metaKey:true,isComposing:true})
  await key(h,'z',{metaKey:true,altKey:true})
  el.readOnly=true
  await key(h,'v',{metaKey:true})
  assert.deepEqual(commands,[])
})

test('returning to the application does not revive a pending paste', async t => {
  let resolve
  const gate=new Promise(r=>{resolve=r}),h=await mountApp(t,{},undefined,{readText:()=>gate})
  const {commands}=inputFixture(h)
  document.defaultView=window
  await key(h,'v',{metaKey:true})
  window.dispatchEvent(new Event('blur'))
  await h.run(async()=>{resolve('late');await gate})
  assert.deepEqual(commands,[])
})

for (const [shortcut, inputType] of [['z', 'historyUndo'], ['Z', 'historyRedo']]) {
  test(`${inputType} cancels a native command targeting another editor before mutation`, async t => {
    const h=await mountApp(t),{el}=inputFixture(h),other={tagName:'INPUT'}
    let before
    document.execCommand=()=>{
      before=new Event('beforeinput',{cancelable:true})
      Object.assign(before,{inputType})
      Object.defineProperty(before,'target',{value:other})
      document.dispatchEvent(before)
      return true
    }
    await key(h,shortcut,{metaKey:true,shiftKey:shortcut==='Z'})
    assert.equal(before.defaultPrevented,true)
    assert.equal(document.activeElement,el)
  })
}

test('same-editor history and ordinary editing events remain native, and the temporary history guard is removed', async t => {
  const h=await mountApp(t),{el}=inputFixture(h),events=[]
  const emit=(target,inputType)=>{
    const e=new Event('beforeinput',{cancelable:true})
    Object.assign(e,{inputType});Object.defineProperty(e,'target',{value:target})
    document.dispatchEvent(e);events.push(e)
  }
  document.execCommand=()=>{emit(el,'historyUndo');emit({tagName:'INPUT'},'insertText');return true}
  await key(h,'z',{metaKey:true})
  emit({tagName:'INPUT'},'historyUndo')
  assert.deepEqual(events.map(e=>e.defaultPrevented),[false,false,false])
})

test('textarea history uses its own control as the ownership boundary', async t => {
  const h=await mountApp(t),{el}=inputFixture(h),events=[]
  el.tagName='TEXTAREA'
  document.execCommand=()=>{
    for(const target of [el,{tagName:'TEXTAREA'}]) {
      const e=new Event('beforeinput',{cancelable:true})
      Object.assign(e,{inputType:'historyUndo'});Object.defineProperty(e,'target',{value:target})
      document.dispatchEvent(e);events.push(e)
    }
    return true
  }
  await key(h,'z',{metaKey:true})
  assert.deepEqual(events.map(e=>e.defaultPrevented),[false,true])
})

test('contenteditable history permits its editing host while blocking another host', async t => {
  const h=await mountApp(t),{el}=inputFixture(h),events=[]
  const host={isContentEditable:true,contains:target=>target===el}
  el.tagName='SPAN';el.isContentEditable=true;el.parentElement=host
  document.execCommand=()=>{
    for(const target of [host,el,{isContentEditable:true}]) {
      const e=new Event('beforeinput',{cancelable:true})
      Object.assign(e,{inputType:'historyRedo'});Object.defineProperty(e,'target',{value:target})
      document.dispatchEvent(e);events.push(e)
    }
    return true
  }
  await key(h,'Z',{metaKey:true,shiftKey:true})
  assert.deepEqual(events.map(e=>e.defaultPrevented),[false,false,true])
})
