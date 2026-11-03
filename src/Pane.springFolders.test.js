import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react-test-renderer'
import { entry, mountPane } from './test/PaneHarness.js'
const folder=entry('folder',{is_dir:true})
const request=(path='/d/folder')=>({tabId:'a',path,root:'/d',element:{isConnected:true,dataset:{path,springFolder:path}}})
test('a spring request expands one existing folder without navigation, selection or duplicate reads', async t=>{
 const h=await mountPane(t),selected=[]
 await h.update({onSelect:(_,value)=>selected.push(value)})
 await h.batch(h.requests[0],[folder,entry('file.txt')],true,2)
 assert.equal(h.root.findByProps({'data-path':'/d/folder'}).props['data-spring-folder'],'/d/folder')
 assert.equal(h.root.findByProps({'data-path':'/d/file.txt'}).props['data-spring-folder'],undefined)
 const req=request();await h.update({springOpen:req})
 assert.equal(h.root.findByProps({'data-path':'/d/folder'}).props['data-spring-folder'],undefined)
 assert.equal(h.childRequests.length,1);assert.equal(h.childRequests[0].path,'/d/folder')
 await h.update({springOpen:req,tick:1});assert.equal(h.childRequests.length,1)
 await act(async()=>h.childRequests[0].resolve({entries:[entry('nested',{path:'/d/folder/nested',is_dir:true})]}))
 assert.ok(h.rows.some(row=>row.path==='/d/folder/nested'))
 assert.deepEqual(h.navigations,[]);assert.deepEqual(selected,[])
})
for(const reason of ['other-tab','other-root','disconnected','file','symlink','icons','renaming']){
 test(`spring request ignores ${reason}`,async t=>{
  const h=await mountPane(t),req=request()
  const item=reason==='file'?entry('folder'):reason==='symlink'?{...folder,is_symlink:true}:folder
  await h.batch(h.requests[0],[item],true,1)
  if(reason==='other-tab')req.tabId='another'
  if(reason==='other-root')req.root='/stale'
  if(reason==='disconnected')req.element.isConnected=false
  await h.update({springOpen:req,...reason==='icons'?{viewMode:'icons'}:{},...reason==='renaming'?{renaming:{tabId:'a',path:folder.path,value:'folder'}}:{}})
  assert.equal(h.childRequests.length,0)
 })
}
