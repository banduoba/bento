import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react-test-renderer'
import { mountPane, entry } from '../test/PaneHarness.js'

async function renamePane(t) {
  const previous=globalThis.document
  globalThis.document={activeElement:null}
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous})
  const input={value:'a.txt',focus(){document.activeElement=this},setSelectionRange(){}}
  let h,value='a.txt',commits=0,cancels=0
  h=await mountPane(t,{createNodeMock:element=>element.props.className==='rename-input'?input:null})
  await h.batch(h.requests[0],[entry('a.txt')],true,1)
  await h.resolve(h.requests[0])
  await h.update({renaming:{tabId:'a',path:'/d/a.txt',value},onRenameChange:v=>{value=v},onRenameCommit:()=>{commits++},onRenameCancel:()=>{cancels++}})
  return {h,input,get value(){return value},get commits(){return commits},get cancels(){return cancels}}
}

test('actual inline rename forwards Undo/Redo combinations without consuming or committing them',async t=>{
  const r=await renamePane(t),rename=r.h.root.findByProps({className:'rename-input'})
  for(const extra of [{key:'z',metaKey:true},{key:'Z',metaKey:true,shiftKey:true}]) {
    let stopped=false,prevented=false
    await act(async()=>rename.props.onKeyDown({...extra,stopPropagation(){stopped=true},preventDefault(){prevented=true}}))
    assert.equal(stopped,false);assert.equal(prevented,false)
  }
  assert.equal(r.commits,0);assert.equal(r.cancels,0)
})

test('inline rename retains its editor identity and focus across controlled value updates',async t=>{
  const r=await renamePane(t),rename=r.h.root.findByProps({className:'rename-input'})
  await act(async()=>rename.props.onChange({target:{value:'xy.txt'}}))
  assert.equal(r.value,'xy.txt')
  await r.h.update({renaming:{tabId:'a',path:'/d/a.txt',value:r.value}})
  assert.equal(r.h.root.findByProps({className:'rename-input'}),rename)
  assert.equal(document.activeElement,r.input)
  assert.equal(r.commits,0)
})
