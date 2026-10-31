import test from 'node:test'
import assert from 'node:assert/strict'
import { blankTab, freshId, navigateTab, restoreSession, sessionForDisk, preferencesForDisk } from './session.js'

const pane = (path, extra = {}) => ({ active: 0, tabs: [{ id: 't1', path, history: [path], hi: 0 }], ...extra })
test('navigation truncates a forward branch, ignores same path and keeps tabs independent', () => {
  const a = blankTab('/A'), other = blankTab('/other')
  let t = navigateTab(navigateTab(a, { path: '/B' }), { path: '/C' })
  t = navigateTab(t, { step: -1 })
  assert.equal(t.path, '/B')
  t = navigateTab(t, { path: '/D' })
  assert.deepEqual(t.history, ['/A', '/B', '/D'])
  assert.equal(navigateTab(t, { path: '/D' }), t)
  assert.equal(navigateTab(t, { step: 1 }), t)
  assert.deepEqual(other.history, ['/other'])
})
test('session roundtrip keeps hidden panes, every workspace, spaces and active live snapshot', () => {
  const cfg = { layout: '1', focusedIdx: 0, panes: [pane('/一 '), pane('/offline/盘 '), pane('/3'), pane('/4')], workspaces: [{ id: 'a', name: 'A', layout: '4', panes: [pane('/stale')] }, { id: 'b', name: 'B', layout: '2c', focusedIdx: 1, panes: [pane('/b'), pane('/bb')] }], activeWorkspace: 'a', autoRefresh: true }
  const disk = sessionForDisk(cfg)
  assert.equal(disk.version, 1)
  assert.equal(disk.workspaces[0].panes[0].tabs[0].path, '/一 ')
  assert.equal('id' in disk.panes[0].tabs[0], false)
  const r = restoreSession(disk, null, '/home').session
  assert.deepEqual(r.panes.map(p => p.tabs[0].path), ['/一 ', '/offline/盘 ', '/3', '/4'])
  assert.equal(r.workspaces[1].focusedIdx, 1)
  assert.equal(r.activeWorkspace, 'a')
  const ids = [...r.panes, ...r.workspaces.flatMap(w => w.panes)].flatMap(p => p.tabs.map(t => t.id))
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.includes(freshId()), false)
  assert.deepEqual(sessionForDisk({ ...cfg, autoRefresh: false, stats: {} }), disk)
  assert.deepEqual(preferencesForDisk({ ...cfg, showHidden: true, viewSettings: {} }), { autoRefresh: true, showHidden: true })
})
test('repair malformed histories and indices without dropping an unreachable path', () => {
  const raw = { version: 1, layout: '4', focusedIdx: Infinity, panes: [pane('/missing ', { active: NaN, tabs: [{ path: '/missing ', history: [null, '/A', 12, 'relative', '/missing '], hi: 99 }, { path: '/B', history: ['/X', '/Y'], hi: 0 }, { path: '/C', history: ['/A', '/C'], hi: 0.5 }] })], workspaces: [] }
  const r = restoreSession(raw, null, '/home').session
  assert.equal(r.panes.length, 4)
  assert.equal(r.focusedIdx, 0)
  assert.equal(r.panes[0].active, 0)
  assert.deepEqual(r.panes[0].tabs[0].history, ['/A', '/missing '])
  assert.equal(r.panes[0].tabs[0].hi, 1)
  assert.deepEqual(r.panes[0].tabs[1].history, ['/B'])
  assert.equal(r.panes[0].tabs[2].hi, 1)
})
test('legacy migration is one fallback and valid session always wins', () => {
  const legacy = { layout: 1, panes: [{ path: '/legacy' }], focusedIdx: 0 }
  assert.equal(restoreSession(null, legacy, '/home').session.panes[0].tabs[0].path, '/legacy')
  const current = { version: 1, layout: '1', panes: [pane('/session')], workspaces: [] }
  assert.equal(restoreSession(current, legacy, '/home').session.panes[0].tabs[0].path, '/session')
  for (const bad of [{ version: 2 }, {}, [], 'bad']) {
    const r = restoreSession(bad, legacy, '/home')
    assert.match(r.warning, /恢复/)
    assert.equal(r.session.panes[0].tabs[0].path, '/legacy')
  }
})
test('unrecognized prototype names cannot become layout IDs', () => {
  const restored=restoreSession({version:1,layout:'toString',panes:[],focusedIdx:3},null,'/home').session
  assert.equal(restored.layout,'2c')
  assert.equal(restored.panes.length,2)
  assert.equal(restored.focusedIdx,1)
})
test('disk focus matches visible layout even while a hidden pane still owns the old focus', () => {
  const disk=sessionForDisk({layout:'1',focusedIdx:3,panes:[pane('/A'),pane('/B'),pane('/C'),pane('/D')],workspaces:[{id:'w',name:'W',layout:'4',focusedIdx:3,panes:[pane('/old')]}],activeWorkspace:'w'})
  assert.equal(disk.focusedIdx,0)
  assert.equal(disk.workspaces[0].focusedIdx,0)
})
