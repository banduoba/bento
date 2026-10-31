import test from 'node:test'
import assert from 'node:assert/strict'
import { createOperationEffects } from './effects.js'
import { getClip, setClip } from '../clipboard.js'
test('one effects consumer refreshes exact directories, removes moved selections, and never sends feedback to a closed owner',async()=>{
  const refresh=[],removed=[],messages=[],renames=[]
  const effects=createOperationEffects({refreshDirectories:p=>refresh.push(...p),removeSelection:p=>removed.push(...p),ownerPath:()=>null,feedback:(...args)=>messages.push(args),beginRename:(...args)=>renames.push(args)})
  const j={jobId:'j1',kind:'create',ownerTabId:'closed',state:'completed'}
  effects.outcomes(j,[{itemId:'i',actualDestination:'/dest/new',status:'succeeded',effectId:'e1',affectedDirectories:['/dest'],sourceDisposition:'unchanged'}])
  await effects.settled(j,{counts:{succeeded:1}})
  assert.deepEqual(refresh,['/dest']);assert.deepEqual(messages,[]);assert.deepEqual(renames,[])
  effects.outcomes({jobId:'move',kind:'move'},[{itemId:'m',source:'/src/a',status:'succeeded',sourceDisposition:'removed',effectId:'e2',affectedDirectories:['/src','/dest']}])
  await effects.settled({jobId:'move',kind:'move',state:'completed'},{counts:{succeeded:1}})
  assert.deepEqual(removed,['/src/a'])
  effects.dispose()
})
test('partial cut settles only its captured revision and partial create cannot show full success',async()=>{
  const feedback=[],rename=[]
  const effects=createOperationEffects({refreshDirectories:()=>{},removeSelection:()=>{},ownerPath:()=>'/dest',feedback:(...a)=>feedback.push(a),beginRename:(...a)=>rename.push(a)})
  setClip({mode:'cut',paths:['/src/a']});const revision=getClip().revision
  const j={jobId:'j2',kind:'move',ownerTabId:'t1',clipRevision:revision,state:'partial'}
  effects.outcomes(j,[{source:'/src/a',status:'partial',sourceDisposition:'cleanupIncomplete',retry:'finishSourceCleanup',actualDestination:'/dest/a',effectId:'e1',affectedDirectories:['/src','/dest']}])
  setClip({mode:'cut',paths:['/src/a']});const newer=getClip()
  await effects.settled(j,{counts:{partial:1}})
  assert.equal(getClip(),newer);assert.equal(feedback.length,0);assert.equal(rename.length,0)
  setClip(null)
  effects.dispose()
})
test('completed new item renames only in its original directory and dedupes repeated delivery',async()=>{
  const renamed=[]
  const effects=createOperationEffects({refreshDirectories:()=>{},removeSelection:()=>{},ownerPath:()=>'/dest',feedback:()=>{},beginRename:(...a)=>renamed.push(a)})
  const j={jobId:'j3',kind:'create',ownerTabId:'t1',state:'completed'}
  const rows=[{itemId:'i',actualDestination:'/dest/new.md',status:'succeeded',sourceDisposition:'unchanged',effectId:'e3',affectedDirectories:['/dest']}]
  effects.outcomes(j,rows);effects.outcomes(j,rows);await effects.settled(j,{counts:{succeeded:1}});await effects.settled(j,{counts:{succeeded:1}})
  assert.deepEqual(renamed,[['t1','/dest/new.md',false]])
  effects.dispose()
})

test('2500 one-row outcomes coalesce exact directories and moved sources in one non-resetting window',async t=>{
  const {manualClock}=await import('../test/ManualClock.js')
  const clock=manualClock(),refresh=[],removed=[]
  const effects=createOperationEffects({refreshDirectories:paths=>refresh.push(paths),removeSelection:paths=>removed.push(paths),ownerPath:()=>null,feedback:()=>{},beginRename:()=>{},...clock})
  t.after(()=>effects.dispose?.())
  const j={jobId:'bulk',kind:'move',state:'running'}
  for(let index=0;index<2500;index++)effects.outcomes(j,[{itemId:`i${index}`,effectId:`e${index}`,source:`/src/${index}`,actualDestination:`/dest/${index}`,status:'succeeded',sourceDisposition:'removed',affectedDirectories:['/src','/dest']}])
  assert.equal(refresh.length,0)
  assert.equal(removed.length,0)
  assert.equal(clock.pending,1)
  await clock.advance(60)
  effects.outcomes(j,[{itemId:'last',effectId:'last',source:'/alias /last',status:'succeeded',sourceDisposition:'removed',affectedDirectories:['/alias ']}])
  await clock.advance(40)
  assert.deepEqual(refresh,[['/src','/dest','/alias ']])
  assert.equal(removed.length,1);assert.equal(removed[0].length,2501)
  assert.equal(clock.pending,0)
  await effects.settled({...j,state:'completed'},{counts:{succeeded:2501}})
  assert.equal(refresh.length,1)
})
test('terminal effects await alias refresh before feedback and retry a failed flush without replay',async t=>{
  const {manualClock}=await import('../test/ManualClock.js')
  const clock=manualClock(),events=[],errors=[]
  let resolve,fail=true
  const gate=new Promise(done=>{resolve=done})
  const effects=createOperationEffects({refreshDirectories:async paths=>{events.push(['refresh',paths]);if(fail)throw Error('refresh unavailable');await gate},removeSelection:()=>{},ownerPath:()=>'/dest',feedback:()=>events.push('feedback'),beginRename:()=>{},onError:error=>errors.push(String(error)),...clock})
  t.after(()=>effects.dispose?.())
  const j={jobId:'copy',kind:'copy',ownerTabId:'owner',state:'running'}
  effects.outcomes(j,[{itemId:'i',effectId:'e',actualDestination:'/dest/new',status:'succeeded',sourceDisposition:'unchanged',affectedDirectories:['/dest']}])
  await clock.advance(100)
  assert.equal(errors.length,1)
  fail=false
  const ending=effects.settled({...j,state:'completed'},{counts:{succeeded:1}})
  await Promise.resolve()
  assert.deepEqual(events,[['refresh',['/dest']],['refresh',['/dest']]])
  resolve();await ending
  await effects.settled({...j,state:'completed'},{counts:{succeeded:1}})
  assert.deepEqual(events,[['refresh',['/dest']],['refresh',['/dest']],'feedback'])
  assert.equal(clock.pending,0)
})
test('disposing pending or in-flight effects cancels timers and prevents late selection or feedback',async()=>{
  const {manualClock}=await import('../test/ManualClock.js')
  const clock=manualClock(),events=[]
  let resolve
  const gate=new Promise(done=>{resolve=done})
  const effects=createOperationEffects({refreshDirectories:()=>gate,removeSelection:()=>events.push('selection'),ownerPath:()=>'/dest',feedback:()=>events.push('feedback'),beginRename:()=>{},...clock})
  const j={jobId:'dispose',kind:'copy',ownerTabId:'owner',state:'running'}
  effects.outcomes(j,[{itemId:'i',effectId:'e',source:'/src/a',actualDestination:'/dest/a',status:'succeeded',sourceDisposition:'removed',affectedDirectories:['/dest']}])
  assert.equal(clock.pending,1)
  const ending=effects.settled({...j,state:'completed'},{counts:{succeeded:1}})
  effects.dispose()
  assert.equal(clock.pending,0)
  resolve();await ending;await clock.advance(1000)
  assert.deepEqual(events,[])
})
test('terminal settlement drains rows that arrived during an in-flight refresh without another timer',async()=>{
  const {manualClock}=await import('../test/ManualClock.js')
  const clock=manualClock(),refresh=[],removed=[]
  let resolve
  const gate=new Promise(done=>{resolve=done})
  const effects=createOperationEffects({refreshDirectories:async paths=>{refresh.push(paths);if(refresh.length===1)await gate},removeSelection:paths=>removed.push(paths),ownerPath:()=>null,feedback:()=>{},beginRename:()=>{},...clock})
  const j={jobId:'overlap',kind:'move',state:'running'}
  effects.outcomes(j,[{itemId:'i1',source:'/a/one',sourceDisposition:'removed',affectedDirectories:['/a']}])
  const ticking=clock.advance(100)
  effects.outcomes(j,[{itemId:'i2',source:'/b/two',sourceDisposition:'removed',affectedDirectories:['/b']}])
  const ending=effects.settled({...j,state:'partial'},{counts:{succeeded:2}})
  assert.equal(clock.pending,0)
  resolve();await Promise.all([ticking,ending])
  assert.deepEqual(refresh,[['/a'],['/b']])
  assert.deepEqual(removed,[['/a/one'],['/b/two']])
  assert.equal(clock.pending,0)
  effects.dispose()
})
test('a refresh rejection after disposal cannot report an error into the closed owner',async()=>{
  const {manualClock}=await import('../test/ManualClock.js')
  const clock=manualClock(),errors=[]
  let reject
  const gate=new Promise((_,fail)=>{reject=fail})
  const effects=createOperationEffects({refreshDirectories:()=>gate,removeSelection:()=>{},ownerPath:()=>null,feedback:()=>{},beginRename:()=>{},onError:error=>errors.push(error),...clock})
  effects.outcomes({jobId:'closed',kind:'copy'},[{itemId:'i',affectedDirectories:['/dest']}])
  const ticking=clock.advance(100)
  reject(Error('late failure'));await Promise.resolve()
  effects.dispose();await ticking
  assert.deepEqual(errors,[])
  assert.equal(clock.pending,0)
})
