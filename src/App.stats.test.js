import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Execute the callback passed by App to Pane, including its render suppression rule.
const source = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
const start = source.indexOf('onStats={') + 'onStats={'.length
const callback = source.slice(start, source.indexOf('\n              onRowsCache=', start)).trim().slice(0, -1)

test('App propagates incomplete-only stats changes and retains identical stats', () => {
  const complete = { count: 2, total: 2, listing: false, listingLive: false, incomplete: false, selCount: 0, selSize: 0 }
  let state = { a: complete }
  const onStats = new Function('setStats', `return (${callback})`)(update => { state = update(state) })
  const initial = state
  onStats('a', { ...complete })
  assert.equal(state, initial)
  onStats('a', { ...complete, incomplete: true })
  assert.equal(state.a.incomplete, true)
  onStats('a', complete)
  assert.equal(state.a.incomplete, false)
})
