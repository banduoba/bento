import test from 'node:test'
import assert from 'node:assert/strict'
import { applyColVars, fitColumns, normalizeCols, normalizeVis } from './columns.js'
import { emptyViewSettings, normalizeViewSettings, viewForPath } from './viewSettings.js'
import { restoreSession, sessionForDisk } from './session.js'
import { mountPane } from './test/PaneHarness.js'

function renderedColumns(widths, paneWidth = 300) {
  const vars = new Map()
  const shown = fitColumns(normalizeVis(null), widths, paneWidth)
  applyColVars(widths, { style: { setProperty: (key, value) => vars.set(key, value) } }, shown)
  return Object.fromEntries(vars)
}

test('missing and invalid name widths produce a fixed compact track without dropping selected columns', () => {
  for (const saved of [null, undefined, {}, { name: undefined }, { name: 'bad' }, { name: NaN }, { name: Infinity }]) {
    assert.deepEqual(renderedColumns(normalizeCols(saved)), {
      '--c-template': '260px 130px 72px 104px', '--list-min': '614px',
    })
  }
})

test('explicit saved auto sizing and manual widths retain their sizing policies', () => {
  assert.deepEqual(renderedColumns(normalizeCols({ name: null })), {
    '--c-template': 'minmax(160px, 1fr)', '--list-min': '184px',
  })
  for (const [name, expected] of [[530, 530], ['530', 530], [529.6, 530], [20, 120], [2000, 1600]]) {
    const vars = renderedColumns(normalizeCols({ name }))
    assert.equal(vars['--c-template'], `${expected}px 130px 72px 104px`)
    assert.equal(vars['--list-min'], `${expected + 354}px`)
  }
})

test('fresh and persisted folder views carry compact defaults while preserving saved auto and manual widths', () => {
  assert.equal(renderedColumns(emptyViewSettings().defaults.columns.widths)['--c-template'], '260px 130px 72px 104px')
  for (const [saved, expected] of [[{}, '260px'], [{ name: 'bad' }, '260px'], [{ name: null }, 'minmax(160px, 1fr)'], [{ name: 530 }, '530px']]) {
    const store = normalizeViewSettings(JSON.parse(JSON.stringify({ defaults: { columns: { widths: saved } } })))
    const widths = viewForPath(store, '/d').columns.widths
    assert.equal(renderedColumns(widths, 1200)['--c-template'], `${expected} 130px 72px 104px`)
  }
})

test('session restoration and serialization retain default, auto and custom name sizing', () => {
  for (const [colWidths, expected] of [[undefined, '260px'], [{ name: 'bad' }, '260px'], [{ name: null }, 'minmax(160px, 1fr)'], [{ name: 530 }, '530px']]) {
    const raw = { version: 1, layout: '1', panes: [{ path: '/d', colsVersion: 2, colWidths }] }
    const session = restoreSession(raw, null, '/home').session
    const roundtrip = restoreSession(JSON.parse(JSON.stringify(sessionForDisk(session))), null, '/home').session
    assert.equal(renderedColumns(roundtrip.panes[0].colWidths, 1200)['--c-template'], `${expected} 130px 72px 104px`)
  }
})

test('double-clicking the real name header resets a custom width to the compact fixed track', async t => {
  const h = await mountPane(t)
  let reset
  await h.update({ pane: { active: 0, tabs: [{ id: 'a', path: '/d' }], colWidths: { name: 530, size: 90 } }, onColWidths: widths => { reset = widths } })
  const handle = h.root.findAllByProps({ className: 'col-resize' })[0]
  handle.props.onDoubleClick({ stopPropagation() {} })
  assert.deepEqual(renderedColumns(reset), { '--c-template': '260px 130px 90px 104px', '--list-min': '632px' })
})
