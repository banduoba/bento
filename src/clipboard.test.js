import test from 'node:test'
import assert from 'node:assert/strict'
import * as clipboard from './clipboard.js'

test('new cuts with identical paths have distinct revisions and old outcomes cannot clear the newer cut', () => {
  clipboard.setClip({mode:'cut',paths:['/src/a']})
  const old = clipboard.getClip()
  clipboard.setClip({mode:'cut',paths:['/src/a']})
  const newer = clipboard.getClip()
  assert.notEqual(old.revision, newer.revision)
  clipboard.retainCut([], old.revision)
  assert.equal(clipboard.getClip(), newer)
  clipboard.setClip(null)
})
test('a cut revision is admitted once until settled and published cleanup failures cannot be pasted again', () => {
  clipboard.setClip({mode:'cut',paths:['/src/a','/src/b']})
  const {revision} = clipboard.getClip()
  assert.equal(clipboard.reserveCut(revision),true)
  assert.equal(clipboard.reserveCut(revision),false)
  clipboard.settleCut(revision,[{source:'/src/a',status:'succeeded'},{source:'/src/b',status:'partial',sourceDisposition:'cleanupIncomplete'}])
  assert.equal(clipboard.getClip(),null)
  clipboard.setClip({mode:'cut',paths:['/src/b']})
  assert.equal(clipboard.reserveCut(clipboard.getClip().revision),true)
  clipboard.releaseCut(clipboard.getClip().revision)
  clipboard.setClip(null)
})
