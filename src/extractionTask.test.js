import test from 'node:test'
import assert from 'node:assert/strict'
import { createExtractionTask } from './extractionTask.js'
const running={id:'job-1',state:'running',source:'/a.zip',currentEntry:null,elapsedMs:0,total:1,processed:0,results:[]}
const done={...running,state:'completed',processed:1,results:[{source:'/a.zip',output:'/a',state:'completed',error:null}]}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
function harness(api){const timers=[],changes=[],terminal=[];const task=createExtractionTask({api,onChange:s=>changes.push(s),onTerminal:j=>terminal.push(j),schedule:cb=>(timers.push(cb),cb),unschedule:cb=>{const i=timers.indexOf(cb);if(i>=0)timers.splice(i,1)}});return{task,timers,changes,terminal,async next(){const cb=timers.shift();assert.ok(cb,'poll scheduled');await cb()}}}
test('start waits for reattachment and repeated clicks cannot launch a duplicate job; terminal refresh runs once',async()=>{
 const initial=deferred(),start=deferred(),calls=[]
 let reads=0;const h=harness({extractionStatus:()=>++reads===1?initial.promise:Promise.resolve(done),startExtraction:p=>(calls.push(p),start.promise)})
 const a=h.task.start(['/a.zip']),b=h.task.start(['/b.zip']);assert.equal(calls.length,0)
 initial.resolve(null);await h.task.ready;await Promise.resolve();assert.deepEqual(calls,[['/a.zip']]);start.resolve(running);await Promise.all([a,b]);assert.equal(h.task.snapshot.job.state,'running')
 await h.next();assert.equal(h.task.snapshot.job.state,'completed');assert.equal(h.terminal.length,1);assert.equal(h.timers.length,0);h.task.dismiss();assert.equal(h.task.snapshot.job,null);h.task.dispose()
})
test('transient status error keeps a running job visible and retries; cancel is not mistaken for completion',async()=>{
 let reads=0;const cancel=deferred(),cancelIds=[]
 const h=harness({extractionStatus:async()=>{reads++;if(reads===1)return running;if(reads===2)throw Error('offline');return {...running,state:'cancelled'}},cancelExtraction:id=>(cancelIds.push(id),cancel.promise)})
 await h.task.ready;await h.next();assert.equal(h.task.snapshot.job.state,'running');assert.match(h.task.snapshot.error,/offline/)
 const a=h.task.cancel(),b=h.task.cancel();assert.deepEqual(cancelIds,['job-1']);cancel.resolve({...running,state:'cancelling'});await Promise.all([a,b]);assert.equal(h.task.snapshot.job.state,'cancelling');assert.equal(h.terminal.length,0)
 await h.next();assert.equal(h.task.snapshot.job.state,'cancelled');assert.equal(h.terminal.length,1);h.task.dispose()
})
test('a task already running after remount cannot be replaced or dismissed; disposal stops polling without cancelling native work',async()=>{
 const calls=[];const h=harness({extractionStatus:async()=>running,startExtraction:async()=>calls.push('start'),cancelExtraction:async()=>calls.push('cancel')});await h.task.ready
 await h.task.start(['/new.zip']);h.task.dismiss();assert.equal(h.task.snapshot.job.id,'job-1');assert.deepEqual(calls,[]);h.task.dispose();assert.equal(h.timers.length,0);assert.deepEqual(calls,[])
})
test('late status after disposal cannot repaint or schedule another poll; launch error can be dismissed',async()=>{
 const read=deferred();const h=harness({extractionStatus:()=>read.promise});h.task.dispose();read.resolve(running);await h.task.ready;assert.equal(h.changes.length,0);assert.equal(h.timers.length,0)
 const g=harness({extractionStatus:async()=>null,startExtraction:async()=>{throw Error('permission denied')}});await g.task.ready;await g.task.start(['/a.zip']);assert.match(g.task.snapshot.error,/permission/);g.task.dismiss();assert.equal(g.task.snapshot.error,null);g.task.dispose()
})
test('an initial status outage retries and reconnects before allowing a new task to launch',async()=>{
 let reads=0,starts=0;const h=harness({extractionStatus:async()=>{if(++reads===1)throw Error('initial outage');return running},startExtraction:async()=>{starts++;return running}})
 await h.task.ready;assert.equal(h.timers.length,1);await h.task.start(['/b.zip']);assert.equal(starts,0)
 await h.next();assert.equal(h.task.snapshot.job.id,'job-1');h.task.dispose()
})
test('a delayed old status response cannot replace a newly started job and no parallel polls are scheduled',async()=>{
 let reads=0;const old=deferred(),next={...running,id:'job-2',source:'/b.zip'}
 const h=harness({extractionStatus:()=>++reads===1?Promise.resolve(running):old.promise,cancelExtraction:async()=>({...running,state:'cancelled'}),startExtraction:async()=>next})
 await h.task.ready;const pending=h.next();await h.task.cancel();assert.equal(h.timers.length,0,'pending poll owns the next scheduling decision')
 await h.task.start(['/b.zip']);assert.equal(h.task.snapshot.job.id,'job-2');old.resolve(done);await pending
 assert.equal(h.task.snapshot.job.id,'job-2');assert.equal(h.task.snapshot.job.state,'running');assert.equal(h.timers.length,1);h.task.dispose()
})
test('a delayed cancellation reply cannot replace the next job after terminal status was observed',async()=>{
 let reads=0;const cancel=deferred(),next={...running,id:'job-2'}
 const h=harness({extractionStatus:async()=>++reads===1?running:done,cancelExtraction:()=>cancel.promise,startExtraction:async()=>next})
 await h.task.ready;const pending=h.task.cancel();await h.next();await h.task.start(['/b.zip']);cancel.resolve({...running,state:'cancelled'});await pending
 assert.equal(h.task.snapshot.job.id,'job-2');assert.equal(h.task.snapshot.job.state,'running');h.task.dispose()
})
test('compression waits for actual completion and exposes output identities without resolving on start',async()=>{
 const timers=[],terminal=[],started=[],identity={dev:'1',ino:'2'};let reads=0,complete=false
 const job={...running,id:'zip-1',operation:'compress',outputBytes:128};const finished={...done,id:'zip-1',operation:'compress',results:[{source:'/a',output:'/archive.zip',state:'completed',error:null,identity}]}
 const task=createExtractionTask({api:{extractionStatus:async()=>++reads===1?null:finished,startCompression:async(paths,dir,options)=>{assert.deepEqual([paths,dir,options],[['/a'],'/out',{level:9}]);return job}},onChange(){},onTerminal:j=>terminal.push(j),onStarted:(j,context)=>started.push([j.id,context]),schedule:cb=>(timers.push(cb),cb),unschedule(){}})
 await task.ready;const pending=task.compress(['/a'],'/out',{level:9},{tabId:'origin'}).then(r=>{complete=true;return r});await Promise.resolve();await Promise.resolve()
 assert.equal(complete,false);assert.equal(task.snapshot.operation,'compress');assert.deepEqual(started,[['zip-1',{tabId:'origin'}]])
 await timers.shift()();const result=await pending;assert.deepEqual(result.entries,[{path:'/archive.zip',identity}]);assert.equal(result.error,null);assert.equal(terminal.length,1);task.dispose()
})
test('cancelled separate compression preserves completed receipts and cancellation error for Undo',async()=>{
 const timers=[];let reads=0;const identity={dev:'1',ino:'2'},doneJob={...running,id:'zip-1',operation:'compress',state:'cancelled',total:2,processed:1,results:[{source:'/a',output:'/a.zip',state:'completed',error:null,identity}]}
 const task=createExtractionTask({api:{extractionStatus:async()=>++reads===1?null:doneJob,startCompression:async()=>({...doneJob,state:'running',processed:0,results:[]})},onChange(){},onTerminal(){},schedule:cb=>(timers.push(cb),cb),unschedule(){}})
 await task.ready;const pending=task.compress(['/a','/b'],'/out',{separate:true});await Promise.resolve();await Promise.resolve();await timers.shift()();const result=await pending;assert.equal(result.entries[0].path,'/a.zip');assert.ok(result.error);assert.equal(result.cancelled,true);task.dispose()
})
test('disposal during compression launch never registers a late completion waiter or callback',async()=>{
 const gate=deferred(),started=[];let settled=false,result='pending'
 const task=createExtractionTask({api:{extractionStatus:async()=>null,startCompression:()=>gate.promise},onChange(){},onTerminal(){},onStarted:(...a)=>started.push(a),schedule:()=>{throw Error('poll after dispose')},unschedule(){}})
 await task.ready;const pending=task.compress(['/a'],'/out',{}).then(value=>{settled=true;result=value})
 await Promise.resolve();await Promise.resolve();task.dispose();gate.resolve({...running,operation:'compress'});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,true);assert.equal(result,null);assert.deepEqual(started,[]);await pending
})
