import test from 'node:test'
import assert from 'node:assert/strict'
import { api as browser } from './api.js'

test('legacy native JS APIs unwrap paths while receipt APIs use the same single mutation commands',async()=>{
  const previous=globalThis.window,calls=[],identity={dev:'7',ino:'9007199254740999'}
  globalThis.window={__TAURI_INTERNALS__:{invoke:async(cmd,args)=>{
    calls.push([cmd,args]);return cmd==='zip_paths_with_receipt'?{entries:[{path:'/actual/archive 2.zip',identity}],error:null}:{path:'/actual/name 2',identity}
  }}}
  try {
    const {api}=await import('./api.js?native-receipts')
    for(const [legacy,receipt,args,command]of [
      ['makeDir','makeDirWithReceipt',['/dir'],'make_dir_with_receipt'],
      ['createFile','createFileWithReceipt',['/dir','text'],'create_file_with_receipt'],
      ['copyTemplate','copyTemplateWithReceipt',['/dir','/template'],'copy_template_with_receipt'],
      ['rename','renameWithReceipt',['/old','name'],'rename_with_receipt'],
    ]) {
      assert.equal(await api[legacy](...args),'/actual/name 2')
      assert.deepEqual(await api[receipt](...args),{path:'/actual/name 2',identity})
      assert.deepEqual(calls.slice(-2).map(x=>x[0]),[command,command])
    }
    assert.deepEqual(await api.zipPaths(['/src'],'/dir'),['/actual/archive 2.zip'])
    assert.deepEqual((await api.zipPathsWithReceipt(['/src'],'/dir')).entries,[{path:'/actual/archive 2.zip',identity}])
    assert.equal(calls.length,10)
  } finally {if(previous===undefined)delete globalThis.window;else globalThis.window=previous}
})

test('browser receipt and legacy APIs retain distinct types and actual rename identity',async()=>{
  const first=await browser.createFile('/Users/demo','text')
  const second=await browser.createFileWithReceipt('/Users/demo','text')
  assert.equal(typeof first,'string');assert.notEqual(first,second.path)
  const renamed=await browser.renameWithReceipt(second.path,'receipt-renamed.txt')
  assert.deepEqual(renamed.identity,second.identity)
  assert.equal(renamed.path,'/Users/demo/receipt-renamed.txt')
  assert.equal((await browser.restoreMoves([{source:renamed.path,dest:second.path,identity:second.identity}]))[0].ok,true)
})
