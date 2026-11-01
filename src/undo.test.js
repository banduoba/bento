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
      [kind+'WithReceipt']:(...args)=>{mutations.push(args);return gate.promise},
    })
    await drop(h);await launchBareMutation(h,kind);assert.equal(mutations.length,1)
    document.execCommand=(...args)=>{commands.push(args);return true}
    document.activeElement={tagName:'INPUT'};await key(h,'z',{metaKey:true})
    assert.deepEqual(commands,[['undo',false,null]])
    document.activeElement=null;await key(h,'z',{metaKey:true});assert.deepEqual(restores,[])
    await h.run(()=>gate.reject(Error('reply failed after possible mutation')))
    await key(h,'z',{metaKey:true});assert.deepEqual(restores,[])
    assert.equal(h.alerts.length,1);assert.match(h.alerts[0],/reply failed after possible mutation/)
    await drop(h);await key(h,'z',{metaKey:true});assert.equal(restores.length,1)
  })
}

test('pending bare-path mutation blocks Undo of a guarded operation completed while it is pending',async t=>{
  const gate=deferred(),restores=[]
  const h=await mountApp(t,{makeDirWithReceipt:()=>gate.promise,transfer:async()=>[moved('/src/a','/dst/a')],restoreMoves:async m=>{restores.push(m);return m.map(x=>({...x,ok:true,error:null}))}})
  await launchBareMutation(h,'makeDir');await drop(h)
  await key(h,'z',{metaKey:true});assert.deepEqual(restores,[])
  await h.run(()=>gate.reject(Error('unknown create result')))
  await key(h,'z',{metaKey:true});assert.equal(restores.length,1)
})

const receipt=path=>({path,identity})
for(const mode of ['copy','move']) test(`${mode} then rename unwinds rename before the older transfer`,async t=>{
  const calls=[],h=await mountApp(t,{
    transfer:async()=>[moved('/src/a','/home/note.txt')],
    renameWithReceipt:async()=>receipt('/home/renamed.txt'),
    restoreMoves:async m=>{calls.push(['restore',m]);return m.map(x=>({...x,ok:true}))},
    trash:async(paths,expected)=>{calls.push(['trash',paths,expected]);return{entries:paths.map(original=>({original})),error:null}},
  })
  await drop(h,mode);await launchBareMutation(h,'rename');await key(h,'z',{metaKey:true});await key(h,'z',{metaKey:true})
  assert.deepEqual(calls[0],['restore',[{source:'/home/renamed.txt',dest:'/home/note.txt',identity}]])
  assert.deepEqual(calls[1],mode==='move'?['restore',[{source:'/home/note.txt',dest:'/src/a',identity}]]:['trash',['/home/note.txt'],[{path:'/home/note.txt',...identity}]])
  assert.deepEqual(h.alerts,[])
})
for(const kind of ['makeDir','createFile','copyTemplate']) test(`${kind} records actual auto-name; committed naming is a separate Undo then guarded Trash`,async t=>{
  const calls=[],h=await mountApp(t,{
    [kind+'WithReceipt']:async()=>receipt('/home/untitled 2.txt'),renameWithReceipt:async()=>receipt('/home/final.txt'),
    listTemplates:async()=>[{name:'fixture.template',path:'/templates/fixture.template'}],
    restoreMoves:async m=>{calls.push(['restore',m]);return m.map(x=>({...x,ok:true}))},
    trash:async(paths,expected)=>{calls.push(['trash',paths,expected]);return{entries:paths.map(original=>({original})),error:null}},
  })
  await launchBareMutation(h,kind);assert.equal(h.panes[0].props.renaming.path,'/home/untitled 2.txt')
  await h.run(()=>h.panes[0].props.onRenameChange('final.txt'));await h.run(()=>h.panes[0].props.onRenameCommit())
  await key(h,'z',{metaKey:true});await key(h,'z',{metaKey:true});await key(h,'z',{metaKey:true})
  assert.deepEqual(calls,[['restore',[{source:'/home/final.txt',dest:'/home/untitled 2.txt',identity}]],['trash',['/home/untitled 2.txt'],[{path:'/home/untitled 2.txt',...identity}]]]);assert.deepEqual(h.alerts,[])
})

test('partial ZIP preserves actual identified archives and reports failure while blocking older Undo',async t=>{
  const calls=[],h=await mountApp(t,{
    transfer:async()=>[moved('/src/a','/dst/a')],loadConfig:async()=>({zipPrefs:{oneClick:true}}),
    zipPathsWithReceipt:async()=>({entries:[receipt('/home/note 2.zip')],error:'second archive failed'}),
    restoreMoves:async m=>{calls.push(['restore',m]);return[]},
    trash:async(paths,expected)=>{calls.push(['trash',paths,expected]);return{entries:paths.map(original=>({original})),error:null}},
  })
  await drop(h);await launchBareMutation(h,'zipPaths');await key(h,'z',{metaKey:true});await key(h,'z',{metaKey:true})
  assert.deepEqual(calls,[['trash',['/home/note 2.zip'],[{path:'/home/note 2.zip',...identity}]]]);assert.deepEqual(h.alerts,['second archive failed'])
})

test('late unknown transfer does not discard a newer identified rename completion',async t=>{
  const gate=deferred(),calls=[],h=await mountApp(t,{transfer:()=>gate.promise,renameWithReceipt:async()=>receipt('/home/renamed.txt'),restoreMoves:async m=>{calls.push(m);return m.map(x=>({...x,ok:true}))}})
  let pending;await h.run(()=>{pending=h.panes[1].props.onDropTransfer('/dst',['/src/a'],'move')})
  await launchBareMutation(h,'rename');await h.run(async()=>{gate.reject(Error('unknown'));await pending})
  await key(h,'z',{metaKey:true});assert.deepEqual(calls,[[{source:'/home/renamed.txt',dest:'/home/note.txt',identity}]])
})

test('standard Edit Undo shares keyboard routing and respects focused text',async t=>{
  const calls=[],commands=[],h=await mountApp(t,{transfer:async()=>[moved('/src/a','/dst/a')],restoreMoves:async m=>{calls.push(m);return m.map(x=>({...x,ok:true}))}})
  await drop(h);document.execCommand=(...a)=>{commands.push(a);return true};document.activeElement={tagName:'INPUT'}
  await h.run(()=>h.events.get('bento-edit-undo')?.({}));assert.deepEqual(commands,[['undo',false,null]]);assert.deepEqual(calls,[])
  document.activeElement=null;await h.run(()=>h.events.get('bento-edit-undo')?.({}));await key(h,'z',{metaKey:true});assert.equal(calls.length,1)
})

for(const partial of [false,true]) test(`batch rename ${partial?'partial completion':'success'} uses one reverse-order guarded Undo`,async t=>{
  const calls=[],h=await mountApp(t,{renameWithReceipt:async(path,name)=>{
    if(partial&&path==='/home/b.txt')throw Error('denied')
    return receipt('/home/'+name)
  },restoreMoves:async m=>{calls.push(m);return m.map(x=>({...x,ok:true}))}})
  const pane=h.panes[0].props,id=pane.pane.tabs[0].id,items=[{path:'/home/a.txt',name:'a.txt'},{path:'/home/b.txt',name:'b.txt'}]
  await h.run(()=>{pane.onRowsCache(id,items);pane.onSelect(id,new Set(items.map(x=>x.path)))})
  await h.run(()=>h.panes[0].props.onMenu(id,items[0],0,0));await menuClick(h,'重新命名 2 个项目…')
  const button=label=>h.root.findAllByType('button').find(b=>b.children.join('')===label)
  await h.run(()=>button('转换大小写').props.onClick());await h.run(()=>button('重命名').props.onClick())
  await key(h,'z',{metaKey:true})
  assert.deepEqual(calls,[partial?[{source:'/home/A.txt',dest:'/home/a.txt',identity}]:[{source:'/home/B.txt',dest:'/home/b.txt',identity},{source:'/home/A.txt',dest:'/home/a.txt',identity}]])
  assert.equal(h.alerts.length,partial?1:0)
})

test('sequential copies and successful ZIP retain older inverses in completion order',async t=>{
  let n=0;const calls=[],h=await mountApp(t,{transfer:async()=>[moved('/src/a',`/home/copy ${++n}`)],loadConfig:async()=>({zipPrefs:{oneClick:true}}),zipPathsWithReceipt:async()=>({entries:[receipt('/home/exact 2.zip')],error:null}),trash:async(paths,expected)=>{calls.push([paths,expected]);return{entries:paths.map(original=>({original})),error:null}}})
  await drop(h,'copy');await drop(h,'copy');await launchBareMutation(h,'zipPaths')
  await key(h,'z',{metaKey:true});await key(h,'z',{metaKey:true});await key(h,'z',{metaKey:true});await key(h,'z',{metaKey:true})
  assert.deepEqual(calls,[[['/home/exact 2.zip'],[{path:'/home/exact 2.zip',...identity}]],[['/home/copy 2'],[{path:'/home/copy 2',...identity}]],[['/home/copy 1'],[{path:'/home/copy 1',...identity}]]])
})

test('unavailable ZIP reply blocks older Undo without guessing an archive path',async t=>{
  const calls=[],h=await mountApp(t,{transfer:async()=>[moved('/src/a','/dst/a')],loadConfig:async()=>({zipPrefs:{oneClick:true}}),zipPathsWithReceipt:async()=>undefined,restoreMoves:async m=>{calls.push(m);return[]}})
  await drop(h);await launchBareMutation(h,'zipPaths');await key(h,'z',{metaKey:true});assert.deepEqual(calls,[])
})

for(const kind of ['makeDir','createFile','copyTemplate','rename'])test(`${kind} completed without identity stays successful but blocks unsafe older Undo`,async t=>{
  const calls=[],h=await mountApp(t,{transfer:async()=>[moved('/src/a','/dst/a')],[kind+'WithReceipt']:async()=>({path:'/home/completed'}),listTemplates:async()=>[{name:'fixture.template',path:'/templates/fixture.template'}],restoreMoves:async m=>{calls.push(m);return[]}})
  await drop(h);await launchBareMutation(h,kind);await key(h,'z',{metaKey:true});assert.deepEqual(calls,[]);assert.deepEqual(h.alerts,[])
  if(kind!=='rename')assert.equal(h.panes[0].props.renaming.path,'/home/completed')
})

test('Duplicate menu registers its exact native copy destination for guarded Undo',async t=>{
  const transfers=[],trash=[],h=await mountApp(t,{transfer:async(...args)=>{transfers.push(args);return[moved('/home/note.txt','/home/note copy.txt')]},trash:async(paths,expected)=>{trash.push([paths,expected]);return{entries:paths.map(original=>({original})),error:null}}})
  const pane=h.panes[0].props,id=pane.pane.tabs[0].id
  await h.run(()=>pane.onMenu(id,{path:'/home/note.txt',name:'note.txt',is_dir:false},0,0));await menuClick(h,'拷贝副本');await key(h,'z',{metaKey:true})
  assert.deepEqual(transfers,[[['/home/note.txt'],'/home','copy']]);assert.deepEqual(trash,[[['/home/note copy.txt'],[{path:'/home/note copy.txt',...identity}]]])
})
