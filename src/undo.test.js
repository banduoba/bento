import test from 'node:test'
import assert from 'node:assert/strict'
import { mountApp, key, deferred } from './test/AppHarness.js'
const identity={dev:'12',ino:'9876543210987654321'}
const moved=(source,dest,extra={})=>({source,dest,ok:true,error:null,identity,...extra})
const drop=(h,resultsMode='move')=>h.run(()=>h.panes[1].props.onDropTransfer('/dst',['/src/a'],resultsMode))

test('file Undo restores exact collision-renamed paths with actual source identity and no success UI',async t=>{
  const restores=[],h=await mountApp(t,{transfer:async()=>[moved('/src/a','/dst/a copy')],restoreMoves:async moves=>{restores.push(moves);return moves.map(m=>({...m,ok:true,error:null}))}})
  await drop(h);await key(h,'z',{metaKey:true})
  assert.deepEqual(restores,[[{source:'/dst/a copy',dest:'/src/a',identity}]])
  assert.deepEqual(h.alerts,[]);assert.equal(h.root.findAll(n=>n.props.className==='undo-toast').length,0)
  await key(h,'z',{metaKey:true});assert.equal(restores.length,1)
})

test('copy Undo trashes only identified actual destinations using guarded expected receipts',async t=>{
  const trash=[],h=await mountApp(t,{transfer:async()=>[moved('/src/a','/dst/a 2')],trash:async(paths,expected)=>{trash.push([paths,expected]);return{entries:[{original:paths[0],trashed:'/Trash/a 2',identity}],error:null,cancelled:false}}})
  await drop(h,'copy');await key(h,'z',{metaKey:true})
  assert.deepEqual(trash,[[['/dst/a 2'],[{path:'/dst/a 2',...identity}]]]);assert.deepEqual(h.alerts,[])
})

for(const unknown of ['missing-destination','missing-identity','error','rejected']) {
  test(`unknown native effects (${unknown}) block older unrelated file Undo`,async t=>{
    let calls=0;const restores=[],h=await mountApp(t,{transfer:async()=>{
      if(++calls===1)return[moved('/src/a','/dst/a')]
      if(unknown==='rejected')throw Error('reply unavailable')
      if(unknown==='error')return[{source:'/new/b',dest:'',ok:false,error:'partial native failure'}]
      return[moved('/new/b',unknown==='missing-destination'?'':'/dst/b',{identity:unknown==='missing-identity'?undefined:identity})]
    },restoreMoves:async m=>{restores.push(m);return[]}})
    await drop(h);await drop(h);await key(h,'z',{metaKey:true});assert.deepEqual(restores,[])
  })
}

test('partial Trash preserves known receipts, clears only completed selection and surfaces the real error',async t=>{
  const restores=[],h=await mountApp(t,{trash:async()=>({entries:[{original:'/home/a',trashed:'/Trash/a renamed',identity}],error:'b: denied',cancelled:false}),restoreMoves:async m=>{restores.push(m);return m.map(x=>({...x,ok:true,error:null}))}})
  const id=h.panes[0].props.pane.tabs[0].id
  await h.run(()=>h.panes[0].props.onSelect(id,new Set(['/home/a','/home/b'])))
  await key(h,'Backspace',{metaKey:true})
  assert.deepEqual([...h.panes[0].props.selection],['/home/b']);assert.deepEqual(h.alerts,['b: denied'])
  await key(h,'z',{metaKey:true});assert.deepEqual(restores,[[{source:'/Trash/a renamed',dest:'/home/a',identity}]])
})

test('cancelled Trash stays quiet and preserves the untouched selection',async t=>{
  const h=await mountApp(t,{trash:async()=>({entries:[],error:null,cancelled:true})})
  const id=h.panes[0].props.pane.tabs[0].id;await h.run(()=>h.panes[0].props.onSelect(id,new Set(['/home/a'])))
  await key(h,'Backspace',{metaKey:true});assert.deepEqual([...h.panes[0].props.selection],['/home/a']);assert.deepEqual(h.alerts,[])
})

test('file Undo waits while a native operation has not replied',async t=>{
  let resolve,calls=0;const restores=[]
  const h=await mountApp(t,{transfer:async()=>++calls===1?[moved('/src/a','/dst/a')]:new Promise(r=>{resolve=r}),restoreMoves:async m=>{restores.push(m);return m.map(x=>({...x,ok:true,error:null}))}})
  await drop(h);let pending;await h.run(()=>{pending=h.panes[1].props.onDropTransfer('/dst',['/src/b'],'move')})
  await key(h,'z',{metaKey:true});assert.deepEqual(restores,[])
  await h.run(async()=>{resolve([{source:'/src/b',dest:'',ok:false,error:null,cancelled:true}]);await pending})
  await key(h,'z',{metaKey:true});assert.deepEqual(restores,[])
})

test('explicit partial Undo retries only identity-guarded unfinished items and overlapping CmdZ runs once',async t=>{
  const restores=[];let release
  const h=await mountApp(t,{transfer:async()=>[moved('/src/a','/dst/a'),moved('/src/b','/dst/b')],restoreMoves:async m=>{
    restores.push(m)
    if(restores.length===1)return new Promise(r=>{release=()=>r([{...m[0],ok:true,error:null},{...m[1],ok:false,error:'occupied'}])})
    return m.map(x=>({...x,ok:true,error:null}))
  }})
  await h.run(()=>h.panes[1].props.onDropTransfer('/dst',['/src/a','/src/b'],'move'))
  await key(h,'z',{metaKey:true});await key(h,'z',{metaKey:true});assert.equal(restores.length,1)
  await h.run(()=>release());assert.equal(h.alerts.length,1)
  await key(h,'z',{metaKey:true})
  assert.deepEqual(restores[1],[{source:'/dst/a',dest:'/src/a',identity}])
  await key(h,'z',{metaKey:true});assert.equal(restores.length,2)
})

test('cancelled native Undo is quiet and leaves guarded items for an explicit subsequent CmdZ',async t=>{
  let calls=0
  const h=await mountApp(t,{transfer:async()=>[moved('/src/a','/dst/a')],restoreMoves:async m=>{calls++;return m.map(x=>({...x,ok:false,error:null,cancelled:true}))}})
  await drop(h);await key(h,'z',{metaKey:true});assert.equal(calls,1);assert.deepEqual(h.alerts,[])
  await key(h,'z',{metaKey:true});assert.equal(calls,2);assert.deepEqual(h.alerts,[])
})

test('native Trash cancellation text is not surfaced as an application error',async t=>{
  const h=await mountApp(t,{trash:async()=>({entries:[],error:'The user canceled the operation.',cancelled:true})})
  const id=h.panes[0].props.pane.tabs[0].id
  await h.run(()=>h.panes[0].props.onSelect(id,new Set(['/home/a'])))
  await key(h,'Backspace',{metaKey:true});assert.deepEqual(h.alerts,[])
})

const menuClick = (h, label) => h.run(() => h.root.findByProps({'data-label':label}).props.onClick({preventDefault(){},stopPropagation(){}}))
async function launchBareMutation(h, kind) {
  const pane=h.panes[0].props,id=pane.pane.tabs[0].id
  if(kind==='makeDir') { await key(h,'N',{metaKey:true,shiftKey:true});return }
  if(kind==='createFile'||kind==='copyTemplate') {
    await h.run(()=>pane.onBlankMenu(id,0,0));await menuClick(h,'新建')
    await menuClick(h,kind==='createFile'?'文本文件':'fixture.template');return
  }
  await h.run(()=>pane.onMenu(id,{path:'/home/note.txt',name:'note.txt',is_dir:false},0,0))
  await menuClick(h,kind==='rename'?'重新命名':'压缩「note.txt」')
  if(kind==='rename') {
    await h.run(()=>h.panes[0].props.onRenameChange('renamed.txt'))
    await h.run(()=>h.panes[0].props.onRenameCommit())
    assert.equal(h.panes[0].props.renaming,null)
  }
}

for(const kind of ['rename','makeDir','createFile','copyTemplate','zipPaths']) {
  test(`${kind} blocks older file Undo before its reply and after unknown-effect rejection; text Undo stays native`,async t=>{
    const gate=deferred(),restores=[],commands=[],mutations=[]
    const h=await mountApp(t,{
      transfer:async()=>[moved('/src/a','/dst/a')],
      restoreMoves:async m=>{restores.push(m);return m.map(x=>({...x,ok:true,error:null}))},
      loadConfig:async()=>({zipPrefs:{oneClick:true}}),
      listTemplates:async()=>[{name:'fixture.template',path:'/templates/fixture.template'}],
      [kind]:(...args)=>{mutations.push(args);return gate.promise},
    })
    await drop(h);await launchBareMutation(h,kind);assert.equal(mutations.length,1)
    document.execCommand=(...args)=>{commands.push(args);return true}
    document.activeElement={tagName:'INPUT'};await key(h,'z',{metaKey:true})
    assert.deepEqual(commands,[['undo',false,null]])
    document.activeElement=null;await key(h,'z',{metaKey:true});assert.deepEqual(restores,[])
    await h.run(()=>gate.reject(Error('reply failed after possible mutation')))
    await key(h,'z',{metaKey:true});assert.deepEqual(restores,[])
    assert.deepEqual(h.alerts,['Error: reply failed after possible mutation'])
    await drop(h);await key(h,'z',{metaKey:true});assert.equal(restores.length,1)
  })
}

test('pending bare-path mutation blocks Undo of a guarded operation completed while it is pending',async t=>{
  const gate=deferred(),restores=[]
  const h=await mountApp(t,{makeDir:()=>gate.promise,transfer:async()=>[moved('/src/a','/dst/a')],restoreMoves:async m=>{restores.push(m);return m.map(x=>({...x,ok:true,error:null}))}})
  await launchBareMutation(h,'makeDir');await drop(h)
  await key(h,'z',{metaKey:true});assert.deepEqual(restores,[])
  await h.run(()=>gate.reject(Error('unknown create result')))
  await key(h,'z',{metaKey:true});assert.equal(restores.length,1)
})
