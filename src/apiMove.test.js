import test from 'node:test'
import assert from 'node:assert/strict'
import { api } from './api.js'

test('browser API restores an exact filename and reports conflicts/missing sources per item', async () => {
  const source = '/Users/demo/notes.txt'
  const moved = await api.moveItems([source], '/Users/demo/Downloads')
  assert.equal(moved[0].ok, true)
  const restored = await api.restoreMoves([{ source: moved[0].dest, dest: source }])
  assert.equal(restored[0].dest, source)
  assert.equal(restored[0].ok, true)
  const blocked = await api.restoreMoves([{ source, dest: '/Users/demo/README.md' }, { source: '/missing', dest: '/missing-destination' }])
  assert.deepEqual(blocked.map(r => r.ok), [false, false])
  assert.equal((await api.listDir('/Users/demo', true)).entries.some(e => e.path === source), true)
})

test('browser copy reports actual conflict name, missing-source failure, and distinct decimal identity',async()=>{
  const first=await api.transfer(['/Users/demo/README.md','/missing/source'],'/Users/demo/Downloads','copy')
  const second=await api.transfer(['/Users/demo/README.md'],'/Users/demo/Downloads','copy')
  assert.deepEqual(first.map(r=>r.ok),[true,false]);assert.equal(first[1].dest,'');assert.ok(first[1].error)
  assert.equal(first[0].dest,'/Users/demo/Downloads/README.md');assert.equal(second[0].dest,'/Users/demo/Downloads/README 2.md')
  assert.match(second[0].identity.dev,/^\d+$/);assert.match(second[0].identity.ino,/^\d+$/)
  assert.notDeepEqual(first[0].identity,second[0].identity)
})

test('browser Trash retains successful entries alongside errors and guards replacement identities',async()=>{
  const [copy]=await api.transfer(['/Users/demo/README.md'],'/Users/demo/Desktop','copy')
  const refused=await api.trash([copy.dest],[{path:copy.dest,dev:copy.identity.dev,ino:'0'}])
  assert.deepEqual(refused.entries,[]);assert.equal(refused.cancelled,false);assert.ok(refused.error)
  const result=await api.trash([copy.dest,'/missing/trash'])
  assert.equal(result.entries.length,1);assert.equal(result.entries[0].original,copy.dest);assert.equal(result.cancelled,false);assert.ok(result.error)
  assert.deepEqual(result.entries[0].identity,copy.identity)
  const [bad]=await api.restoreMoves([{source:result.entries[0].trashed,dest:copy.dest,identity:{dev:'1',ino:'0'}}])
  assert.equal(bad.ok,false)
  const [restored]=await api.restoreMoves([{source:result.entries[0].trashed,dest:copy.dest,identity:copy.identity}])
  assert.equal(restored.ok,true)
})
