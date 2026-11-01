import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FORMATS, matchesFormat, searchApi, demoSearch } from './model.js'
import { api } from '../api.js'
test('native adapter preserves actual scope and whitespace paths; legacy array wraps same typed command',async()=>{
  const calls=[];const a=searchApi(async(command,args)=>{calls.push([command,args]);return{items:[{path:'/report /a'}]}})
  await a.searchQuery('needle','pane','/report ',true,['/global '],'content','q_1','document')
  assert.deepEqual(calls[0],['search_query',{query:'needle',scope:'pane',root:'/report ',showHidden:true,roots:['/global '],mode:'content',requestId:'q_1',format:'document'}])
  assert.deepEqual(await a.search('q','home',null,false,[],'name'),[{path:'/report /a'}]);assert.equal(calls[1][0],'search_query')
  await a.cancelSearch('q_1');assert.deepEqual(calls[2],['cancel_search',{requestId:'q_1'}])
})
test('Rust format map and frontend toolbar stay identical',()=>{
  const source=readFileSync(new URL('../../src-tauri/src/search_results.rs',import.meta.url),'utf8')
  for(const {id,extensions} of FORMATS){if(!extensions)continue;const match=source.match(new RegExp(`"${id}" => &\\[([^\\]]+)\\]`));assert.ok(match,id);assert.deepEqual([...match[1].matchAll(/"([^"]+)"/g)].map(m=>m[1]),extensions)}
  assert.equal(matchesFormat({name:'report.TXT',is_dir:false},'document'),true)
})
test('demo scope and format filter before result cap; sibling prefixes and hidden ancestors excluded',()=>{
  const row=path=>({name:path.split('/').pop(),path,is_dir:false})
  const items=[...Array.from({length:220},(_,i)=>row(`/report-archive/${i}.txt`)),...Array.from({length:220},(_,i)=>row(`/report/${i}.png`)),row('/report/.hidden/a.txt'),row('/report/hit.txt')]
  const r=demoSearch(items,'','pane','/report',false,['/report-archive'],'name','document')
  assert.deepEqual(r.items.map(i=>i.path),['/report/hit.txt']);assert.equal(r.truncated,false)
  assert.deepEqual(demoSearch(items,'hit','global',null,false,['/report'],'content').items.map(i=>i.path),['/report/hit.txt'])
})
test('browser api uses typed response and rejects missing pane directory and bad regex',async()=>{
  const r=await api.searchQuery('示例','pane','/Users/demo/Documents',false,[],'content','demo_1','document');assert.equal(r.source,'demo');assert.ok(r.items.every(i=>i.path.startsWith('/Users/demo/Documents/')))
  const legacy = await api.search('示例','pane','/Users/demo/Documents',false,[],'content')
  const typed = await api.searchQuery('示例','pane','/Users/demo/Documents',false,[],'content','demo_legacy')
  assert.deepEqual(legacy,typed.items)
  await assert.rejects(api.searchQuery('x','pane','/missing',false,[],'name','demo_2'),e=>e.code==='invalidRoot')
  await assert.rejects(api.searchQuery('re:[','global',null,false,[],'name','demo_3'),e=>e.code==='invalidQuery')
})
