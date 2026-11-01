import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react-test-renderer'
import { mountPane } from '../test/PaneHarness.js'

test('Pane reports descendant focus without a mouse event or moving the native editor caret', async t => {
  const h=await mountPane(t),focused=[]
  await h.update({index:2,onFocus:index=>focused.push(index)})
  const section=h.root.findByType('section')
  assert.equal(typeof section.props.onFocusCapture,'function')
  const editor={focus:()=>assert.fail('Pane must retain the browser-restored focus')}
  await act(async()=>section.props.onFocusCapture({target:editor,currentTarget:section}))
  assert.deepEqual(focused,[2])
})
