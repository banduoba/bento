import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react-test-renderer'
import { entry, mountPane } from './test/PaneHarness.js'
const folder=entry('folder',{is_dir:true})
const request=(path='/d/folder')=>({tabId:'a',path,root:'/d',element:{isConnected:true,dataset:{path,springFolder:path}}})
const hover = path => ({ tabId: 'a', root: '/d', path })
test('a spring request expands one existing folder without navigation, selection or duplicate reads', async t=>{
 const h=await mountPane(t),selected=[]
 await h.update({onSelect:(_,value)=>selected.push(value)})
 await h.batch(h.requests[0],[folder,entry('file.txt')],true,2)
 assert.equal(h.root.findByProps({'data-path':'/d/folder'}).props['data-spring-folder'],'/d/folder')
 assert.equal(h.root.findByProps({'data-path':'/d/file.txt'}).props['data-spring-folder'],undefined)
 const req=request();await h.update({springOpen:req,springHover:hover(folder.path)})
 assert.equal(h.root.findByProps({'data-path':'/d/folder'}).props['data-spring-folder'],undefined)
 assert.equal(h.childRequests.length,1);assert.equal(h.childRequests[0].path,'/d/folder')
 await h.update({springOpen:req,tick:1});assert.equal(h.childRequests.length,1)
 await act(async()=>h.childRequests[0].resolve({entries:[entry('nested',{path:'/d/folder/nested',is_dir:true})]}))
 assert.ok(h.rows.some(row=>row.path==='/d/folder/nested'))
 assert.deepEqual(h.navigations,[]);assert.deepEqual(selected,[])
})
for(const reason of ['other-tab','other-root','disconnected','file','icons','renaming']){
 test(`spring request ignores ${reason}`,async t=>{
  const h=await mountPane(t),req=request()
  const item=reason==='file'?entry('folder'):folder
  await h.batch(h.requests[0],[item],true,1)
  if(reason==='other-tab')req.tabId='another'
  if(reason==='other-root')req.root='/stale'
  if(reason==='disconnected')req.element.isConnected=false
  await h.update({springOpen:req,...reason==='icons'?{viewMode:'icons'}:{},...reason==='renaming'?{renaming:{tabId:'a',path:folder.path,value:'folder'}}:{}})
  assert.equal(h.childRequests.length,0)
 })
}

test('directory aliases use the existing one-level manual expansion behavior',async t=>{
 const h=await mountPane(t)
 await h.batch(h.requests[0],[{...folder,is_symlink:true}],true,1)
 await h.update({springOpen:request(),springHover:hover(folder.path)})
 assert.equal(h.childRequests.length,1)
 assert.equal(h.childRequests[0].path,'/d/folder')
 assert.deepEqual(h.navigations,[])
})

test('only drag-opened folders close after leaving their subtree; child hover and manual opens persist', async t => {
 t.mock.timers.enable({apis:['setTimeout']})
 const h=await mountPane(t), manual=entry('manual',{is_dir:true})
 await h.batch(h.requests[0],[folder,manual],true,2)
 await h.expand(manual.path)
 await h.update({springOpen:request(),springHover:hover(folder.path)})
 await h.resolveKids(h.childRequests.find(r=>r.path===folder.path),[entry('child',{path:'/d/folder/child',is_dir:true})])
 const child='/d/folder/child'
 await h.update({springOpen:request(child),springHover:hover(child)})
 await h.update({springHover:hover(child+'/file.txt')})
 await act(async()=>t.mock.timers.tick(1000))
 assert.equal(h.root.findByProps({'data-path':folder.path}).findByProps({title:'折叠'}).props.title,'折叠')
 assert.ok(h.rows.some(r=>r.path===child))
 await h.update({springHover:hover(manual.path)})
 await act(async()=>t.mock.timers.tick(249))
 assert.ok(h.rows.some(r=>r.path===child))
 await act(async()=>t.mock.timers.tick(1))
 assert.equal(h.rows.some(r=>r.path===child),false)
 assert.ok(h.root.findByProps({'data-path':manual.path}).findByProps({title:'折叠'}))
 await h.update({springOpen:null,springHover:null})
 assert.ok(h.root.findByProps({'data-path':manual.path}).findByProps({title:'折叠'}))
})

test('returning before close cancels collapse, and ending the drag closes temporary folders with no late reopen', async t => {
 t.mock.timers.enable({apis:['setTimeout']})
 const h=await mountPane(t)
 await h.batch(h.requests[0],[folder],true,1)
 await h.update({springOpen:request(),springHover:hover(folder.path)})
 await h.update({springHover:hover('/d/elsewhere')})
 await act(async()=>t.mock.timers.tick(150))
 await h.update({springHover:hover(folder.path)})
 await act(async()=>t.mock.timers.tick(1000))
 assert.ok(h.root.findByProps({'data-path':folder.path}).findByProps({title:'折叠'}))
 await h.update({springOpen:null,springHover:null})
 assert.ok(h.root.findByProps({'data-path':folder.path}).findByProps({title:'展开'}))
 await h.resolveKids(h.childRequests[0],[entry('late',{path:'/d/folder/late'})])
 assert.equal(h.rows.some(r=>r.path==='/d/folder/late'),false)
})
