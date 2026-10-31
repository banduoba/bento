import test from 'node:test'
import assert from 'node:assert/strict'
import { api } from './api.js'

test('mock stream shows the first batch before the folder is finished', async () => {
  const batches = []
  const channel = { onmessage: (batch) => batches.push(batch) }
  const pending = api.listDirStream('/Users/demo/Downloads/大量文件', false, 42, 'name', 'asc', channel)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(batches.length, 1)
  assert.equal(batches[0].entries.length, 500)
  assert.equal(batches[0].entries[0].name, 'f000000.txt')
  assert.equal(batches[0].done, false)
  assert.equal(batches[0].total, 10000)
  await api.cancelListDir(42)
  await pending
  assert.equal(batches.length, 1)
})

test('mock stream of a small folder finishes in one batch', async () => {
  const batches = []
  const channel = { onmessage: (batch) => batches.push(batch) }
  await api.listDirStream('/Users/demo/Desktop', false, 7, 'name', 'asc', channel)
  assert.equal(batches.length, 1)
  assert.equal(batches[0].done, true)
  assert.ok(batches[0].entries.length > 0)
  assert.equal(batches[0].total, batches[0].entries.length)
})

test('cancelling before the first tick drops the mock stream', async () => {
  const batches = []
  const channel = { onmessage: (batch) => batches.push(batch) }
  const pending = api.listDirStream('/Users/demo/Downloads/大量文件', false, 99, 'name', 'asc', channel)
  await api.cancelListDir(99)
  await pending
  assert.equal(batches.length, 0)
})
