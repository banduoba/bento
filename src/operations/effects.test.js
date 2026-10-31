import test from 'node:test'
import assert from 'node:assert/strict'
import { createOperationEffects } from './effects.js'
import { getClip, setClip } from '../clipboard.js'
test('one effects consumer refreshes exact directories, removes moved selections, and never sends feedback to a closed owner',()=>{
  const refresh=[],removed=[],messages=[],renames=[]
  const effects=createOperationEffects({refreshDirectories:p=>refresh.push(...p),removeSelection:p=>removed.push(...p),ownerPath:()=>null,feedback:(...args)=>messages.push(args),beginRename:(...args)=>renames.push(args)})
  const j={jobId:'j1',kind:'create',ownerTabId:'closed',state:'completed'}
  effects.outcomes(j,[{itemId:'i',actualDestination:'/dest/new',status:'succeeded',effectId:'e1',affectedDirectories:['/dest'],sourceDisposition:'unchanged'}])
  effects.settled(j,{counts:{succeeded:1}})
  assert.deepEqual(refresh,['/dest']);assert.deepEqual(messages,[]);assert.deepEqual(renames,[])
  effects.outcomes({jobId:'move',kind:'move'},[{itemId:'m',source:'/src/a',status:'succeeded',sourceDisposition:'removed',effectId:'e2',affectedDirectories:['/src','/dest']}])
  assert.deepEqual(removed,['/src/a'])
})
test('partial cut settles only its captured revision and partial create cannot show full success',()=>{
  const feedback=[],rename=[]
  const effects=createOperationEffects({refreshDirectories:()=>{},removeSelection:()=>{},ownerPath:()=>'/dest',feedback:(...a)=>feedback.push(a),beginRename:(...a)=>rename.push(a)})
  setClip({mode:'cut',paths:['/src/a']});const revision=getClip().revision
  const j={jobId:'j2',kind:'move',ownerTabId:'t1',clipRevision:revision,state:'partial'}
  effects.outcomes(j,[{source:'/src/a',status:'partial',sourceDisposition:'cleanupIncomplete',retry:'finishSourceCleanup',actualDestination:'/dest/a',effectId:'e1',affectedDirectories:['/src','/dest']}])
  setClip({mode:'cut',paths:['/src/a']});const newer=getClip()
  effects.settled(j,{counts:{partial:1}})
  assert.equal(getClip(),newer);assert.equal(feedback.length,0);assert.equal(rename.length,0)
  setClip(null)
})
test('completed new item renames only in its original directory and dedupes repeated delivery',()=>{
  const renamed=[]
  const effects=createOperationEffects({refreshDirectories:()=>{},removeSelection:()=>{},ownerPath:()=>'/dest',feedback:()=>{},beginRename:(...a)=>renamed.push(a)})
  const j={jobId:'j3',kind:'create',ownerTabId:'t1',state:'completed'}
  const rows=[{itemId:'i',actualDestination:'/dest/new.md',status:'succeeded',sourceDisposition:'unchanged',effectId:'e3',affectedDirectories:['/dest']}]
  effects.outcomes(j,rows);effects.outcomes(j,rows);effects.settled(j,{counts:{succeeded:1}});effects.settled(j,{counts:{succeeded:1}})
  assert.deepEqual(renamed,[['t1','/dest/new.md',false]])
})
