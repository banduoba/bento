// IPC fixtures only: tests explicitly choose each native snapshot and its authoritative outcomes.
export function operationBoundary() {
  const jobs = new Map(), outcomes = new Map(), calls = [], requests = []
  let rev = 1, latestUndoId = null
  const snapshot = () => ({sessionId:'test',revision:rev,jobs:[...jobs.values()],busy:[...jobs.values()].some(j=>!['completed','partial','failed','cancelled'].includes(j.state)),accepting:true,latestUndoId})
  const api = {
    listOperationJobs:async()=>snapshot(),listOperationRecoveries:async()=>[],
    ackOperationOutcomes:async(...a)=>calls.push(['ack',...a]),
    enqueueOperation:async request=>{
      requests.push(request)
      const j={sessionId:'test',jobId:`j${requests.length}`,revision:1,requestId:request.requestId,kind:request.kind,state:'queued',phase:'preparing',ownerTabId:request.ownerTabId||null,clipRevision:request.clipRevision||null,intent:request.intent||null,cancelRequested:false,cancelability:'checkpoint',progress:{itemsFinished:0,itemsTotal:request.items.length,bytesDone:'0',bytesTotal:null,currentItemId:null,currentPath:null},conflict:null,outcomeCount:0,undoId:null,error:null}
      jobs.set(j.jobId,j);rev++;return j
    },
    getOperationJob:async id=>jobs.get(id),
    getOperationOutcomes:async(id,offset,limit)=>({sessionId:'test',jobId:id,revision:jobs.get(id).revision,offset,total:(outcomes.get(id)||[]).length,outcomes:(outcomes.get(id)||[]).slice(offset,offset+limit)}),
    cancelOperation:async id=>{calls.push(['cancel',id]);return jobs.get(id)},
    resolveOperationConflict:async(...a)=>{calls.push(['resolve',...a]);return jobs.get(a[0])},
    undoOperation:async(undoId,requestId)=>{calls.push(['undo',undoId,requestId]);const j={...jobs.values().next().value,jobId:`undo${calls.length}`,revision:1,requestId,kind:'undo',state:'queued',phase:'undoing',outcomeCount:0,conflict:null,undoId:null};jobs.set(j.jobId,j);rev++;return j},
    prepareOperationExit:async flag=>{calls.push(['prepare',flag]);return snapshot()},
  }
  return {api,calls,requests,jobs,setUndo(id){latestUndoId=id;rev++},async emit(h,id,patch,rows,{withinAct=false}={}){
    const previous=jobs.get(id)
    if(rows)outcomes.set(id,rows)
    const j={...previous,...patch,revision:previous.revision+1,outcomeCount:outcomes.get(id)?.length||0}
    jobs.set(id,j);rev++
    const publish=async()=>{await h.events.get('operation-changed')?.({payload:j});await new Promise(r=>setImmediate(r))}
    if(withinAct)await publish();else await h.run(publish)
    return j
  }}
}
export const outcome=(extra={})=>({itemId:'i0',source:'/src/a',requestedDestination:'/dest',actualDestination:'/dest/a',status:'succeeded',effectId:'effect1',published:true,sourceDisposition:'unchanged',retry:'none',error:null,affectedDirectories:['/dest'],...extra})
export async function key(h,key,extra={}){const e=new Event('keydown',{cancelable:true});Object.assign(e,{key,...extra});await h.run(()=>window.dispatchEvent(e));return e}
