import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeCols, normalizeVis } from './columns.js'
import {
  VIEW_SETTINGS_VERSION,
  applyToAllFolders,
  canonicalPathKey,
  clearFolderOverride,
  emptyViewSettings,
  hasFolderOverride,
  normalizeViewSettings,
  rekeyOverride,
  resolveViewKey,
  seedViewSettings,
  sortFromSavedTab,
  syncPaneViews,
  viewForPath,
  withFolderPatch,
} from './viewSettings.js'

const downloads = '/Users/me/Downloads'
const documents = '/Users/me/Documents'

test('real folders with terminal spaces retain separate overrides after save and canonical resolution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bento-view-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = [join(root, 'report'), join(root, 'report '), join(root, '资料 é ')]
  await Promise.all(paths.map((path) => mkdir(path)))
  assert.notEqual((await stat(paths[0])).ino, (await stat(paths[1])).ino)
  const plain = await resolveViewKey(paths[0], realpath)
  const spaced = await resolveViewKey(paths[1], realpath)
  const unicode = await resolveViewKey(paths[2], realpath)
  assert.notEqual(spaced, plain)
  assert.ok(spaced.endsWith('/report '))
  assert.ok(unicode.endsWith('/资料 é '))
  // The shared address-input resolver trims outer whitespace before realpath.
  assert.equal(await resolveViewKey(paths[1], (path) => realpath(path.trim())), spaced)
  let store = withFolderPatch(emptyViewSettings(), plain, { sort: { key: 'name', dir: 'asc' } })
  store = withFolderPatch(store, spaced, { sort: { key: 'size', dir: 'asc' } })
  store = withFolderPatch(store, unicode, { sort: { key: 'kind', dir: 'desc' } })
  const saved = normalizeViewSettings(JSON.parse(JSON.stringify(store)))
  assert.equal(viewForPath(saved, plain).sort.key, 'name')
  assert.equal(viewForPath(saved, spaced).sort.key, 'size')
  assert.equal(viewForPath(saved, unicode).sort.key, 'kind')
  const alias = join(root, 'alias')
  await symlink(paths[1], alias)
  assert.equal(await resolveViewKey(alias, realpath), spaced)
  const moved = rekeyOverride(withFolderPatch(saved, alias, { iconSize: 24 }), alias, spaced)
  assert.equal(viewForPath(moved, spaced).iconSize, 24)
  assert.equal(viewForPath(moved, plain).sort.key, 'name')
})

test('canonical keys preserve component spaces and reject whitespace before an absolute path', () => {
  assert.equal(canonicalPathKey('/report '), '/report ')
  assert.equal(canonicalPathKey('/parent / report /'), '/parent / report ')
  assert.equal(canonicalPathKey('/é/资料 '), '/é/资料 ')
  assert.equal(canonicalPathKey(' /report'), null)
})

test('canonical path keys collapse dots, parent segments and trailing slashes', () => {
  assert.equal(canonicalPathKey('/Users/me/Downloads/'), downloads)
  assert.equal(canonicalPathKey('/Users/me/foo/../Downloads'), downloads)
  assert.equal(canonicalPathKey('/Users/me/./Downloads//'), downloads)
  assert.equal(canonicalPathKey('/'), '/')
  assert.equal(canonicalPathKey('/../Users'), '/Users')
  assert.equal(canonicalPathKey('Downloads'), null)
  assert.equal(canonicalPathKey('~/Downloads'), null)
  assert.equal(canonicalPathKey(''), null)
  assert.equal(canonicalPathKey(null), null)
})

test('fresh settings are versioned defaults with sort, columns and iconSize', () => {
  const store = emptyViewSettings()
  assert.equal(store.version, VIEW_SETTINGS_VERSION)
  assert.equal(store.defaults.sort.key, 'mtime')
  assert.equal(store.defaults.sort.dir, 'desc')
  assert.equal(store.defaults.iconSize, null)
  assert.equal(store.defaults.columns.visible.mtime, true)
  assert.equal(store.defaults.columns.visible.btime, false)
  assert.deepEqual(store.overrides, {})
  const again = normalizeViewSettings(JSON.parse(JSON.stringify(store)))
  assert.equal(again.version, 1)
  assert.equal(again.defaults.sort.key, 'mtime')
  assert.equal(again.defaults.sort.dir, 'desc')
  assert.equal(again.defaults.columns.widths.size, normalizeCols(null).size)
})

test('a saved default and a folder override both beat the builtin sort', () => {
  const store = normalizeViewSettings({
    version: 1,
    defaults: { sort: { key: 'name', dir: 'asc' } },
    overrides: { [downloads]: { sort: { key: 'size', dir: 'desc' } } },
  })
  assert.equal(viewForPath(store, documents).sort.key, 'name')
  assert.equal(viewForPath(store, documents).sort.dir, 'asc')
  assert.equal(viewForPath(store, downloads).sort.key, 'size')
  assert.equal(viewForPath(store, downloads).sort.dir, 'desc')
  const cleared = clearFolderOverride(store, downloads)
  assert.equal(viewForPath(cleared, downloads).sort.key, 'name')
  assert.equal(viewForPath(cleared, downloads).sort.dir, 'asc')
})

test('a folder override does not change other folders', () => {
  const store = withFolderPatch(emptyViewSettings(), `${downloads}/`, {
    sort: { key: 'name', dir: 'asc' },
  })
  assert.equal(Object.keys(store.overrides).join(','), downloads)
  assert.equal(viewForPath(store, downloads).sort.key, 'name')
  assert.equal(viewForPath(store, downloads).sort.dir, 'asc')
  assert.equal(viewForPath(store, documents).sort.key, 'mtime')
  assert.equal(viewForPath(store, documents).sort.dir, 'desc')
  assert.equal(viewForPath(store, `${downloads}/extra/..`).sort.key, 'name')
  assert.equal(hasFolderOverride(store, documents), false)
  assert.equal(hasFolderOverride(store, downloads), true)
})

test('column and iconSize overrides stay on that folder', () => {
  const widths = { ...normalizeCols(null), size: 120 }
  const visible = { ...normalizeVis(null), btime: true }
  let store = withFolderPatch(emptyViewSettings(), downloads, {
    columns: { widths, visible },
  })
  store = withFolderPatch(store, '/Users/me/Pictures', { iconSize: 32 })
  assert.equal(viewForPath(store, downloads).columns.widths.size, 120)
  assert.equal(viewForPath(store, downloads).columns.visible.btime, true)
  assert.equal(viewForPath(store, downloads).iconSize, null)
  assert.equal(viewForPath(store, documents).columns.widths.size, normalizeCols(null).size)
  assert.equal(viewForPath(store, documents).columns.visible.btime, false)
  assert.equal(viewForPath(store, '/Users/me/Pictures').iconSize, 32)
  assert.equal(store.defaults.iconSize, null)
})

test('matching the defaults again drops the override', () => {
  let store = withFolderPatch(emptyViewSettings(), downloads, { sort: { key: 'size', dir: 'asc' } })
  assert.equal(hasFolderOverride(store, downloads), true)
  store = withFolderPatch(store, downloads, { sort: { key: 'mtime', dir: 'desc' } })
  assert.deepEqual(store.overrides, {})
  assert.equal(store, withFolderPatch(store, downloads, { sort: { key: 'mtime', dir: 'desc' } }))
})

test('apply to all folders clears overrides and uses that view everywhere', () => {
  let store = withFolderPatch(emptyViewSettings(), downloads, { sort: { key: 'mtime', dir: 'desc' } })
  store = withFolderPatch(store, documents, { sort: { key: 'size', dir: 'asc' }, iconSize: 20 })
  const next = applyToAllFolders(store, viewForPath(store, downloads))
  assert.equal(next.version, 1)
  assert.deepEqual(next.overrides, {})
  assert.equal(next.defaults.sort.key, 'mtime')
  assert.equal(next.defaults.sort.dir, 'desc')
  assert.equal(viewForPath(next, documents).sort.key, 'mtime')
  assert.equal(viewForPath(next, '/Users/me/Movies').sort.key, 'mtime')
  assert.equal(next, applyToAllFolders(next, next.defaults))
})

test('a missing override key falls back to defaults without throwing', () => {
  const store = withFolderPatch(emptyViewSettings(), downloads, { sort: { key: 'btime', dir: 'desc' } })
  const renamed = '/Users/me/OldDownloads'
  assert.equal(hasFolderOverride(store, renamed), false)
  assert.doesNotThrow(() => viewForPath(store, renamed))
  assert.equal(viewForPath(store, renamed).sort.key, 'mtime')
  assert.equal(viewForPath(store, renamed).sort.dir, 'desc')
  assert.equal(viewForPath(store, null).sort.key, 'mtime')
  assert.equal(viewForPath(store, 'not/absolute').iconSize, null)
  assert.doesNotThrow(() => viewForPath(null, downloads))
  assert.equal(viewForPath(null, downloads).sort.key, 'mtime')
  assert.equal(viewForPath(null, downloads).sort.dir, 'desc')
})

test('corrupt documents and bad override entries normalize instead of throwing', () => {
  for (const raw of [null, undefined, 'nope', 3, [], { version: 'x' }]) {
    const store = normalizeViewSettings(raw)
    assert.equal(store.version, 1)
    assert.equal(store.defaults.sort.key, 'mtime')
    assert.equal(store.defaults.sort.dir, 'desc')
    assert.deepEqual(store.overrides, {})
  }
  const store = normalizeViewSettings({
    version: 99,
    defaults: { sort: { key: 'nope', dir: 'sideways' }, iconSize: 8 },
    overrides: {
      relative: { sort: { key: 'size', dir: 'desc' } },
      [`${downloads}/`]: null,
      [`${documents}/./`]: { sort: { key: 'kind', dir: 'asc' }, iconSize: 'large' },
    },
  })
  assert.equal(store.version, 1)
  assert.equal(store.defaults.sort.key, 'mtime')
  assert.equal(store.defaults.sort.dir, 'desc')
  assert.equal(store.defaults.iconSize, 12)
  assert.equal(store.overrides.relative, undefined)
  assert.equal(store.overrides[downloads], undefined)
  assert.equal(store.overrides[documents].sort.key, 'kind')
  assert.equal(store.overrides[documents].iconSize, null)
  assert.doesNotThrow(() => viewForPath(store, downloads))
})

test('clearing one folder leaves the others and the defaults', () => {
  let store = withFolderPatch(emptyViewSettings(), downloads, { sort: { key: 'name', dir: 'asc' } })
  store = withFolderPatch(store, documents, { sort: { key: 'size', dir: 'asc' } })
  const next = clearFolderOverride(store, `${downloads}/`)
  assert.equal(hasFolderOverride(next, downloads), false)
  assert.equal(viewForPath(next, downloads).sort.key, 'mtime')
  assert.equal(viewForPath(next, downloads).sort.dir, 'desc')
  assert.equal(viewForPath(next, documents).sort.key, 'size')
  assert.equal(clearFolderOverride(next, downloads), next)
})

test('resolveViewKey uses the canonical path and falls back when resolve fails', async () => {
  assert.equal(await resolveViewKey(`${downloads}/`, async () => '/private/Users/me/Downloads'), '/private/Users/me/Downloads')
  assert.equal(
    await resolveViewKey(downloads, async () => {
      throw new Error('路径不存在')
    }),
    downloads,
  )
  assert.equal(await resolveViewKey('Downloads', async () => downloads), null)
  assert.equal(await resolveViewKey(downloads), downloads)
})

test('rekey moves an override when canonicalize disagrees with the lexical path', () => {
  const store = withFolderPatch(emptyViewSettings(), '/tmp/project', { sort: { key: 'size', dir: 'desc' } })
  const moved = rekeyOverride(store, '/tmp/project', '/private/tmp/project')
  assert.equal(hasFolderOverride(moved, '/tmp/project'), false)
  assert.equal(viewForPath(moved, '/private/tmp/project').sort.key, 'size')
  assert.equal(viewForPath(moved, '/private/tmp/project').sort.dir, 'desc')
  assert.equal(rekeyOverride(moved, '/tmp/project', '/private/tmp/project'), moved)
})

test('sync applies the folder view to matching tabs only', () => {
  const widths = { ...normalizeCols(null), size: 90 }
  const visible = { ...normalizeVis(null), btime: true }
  const store = withFolderPatch(emptyViewSettings(), downloads, {
    sort: { key: 'mtime', dir: 'desc' },
    columns: { widths, visible },
  })
  const panes = [
    {
      tabs: [
        { id: 'a', path: downloads, sortKey: 'name', sortDir: 'asc' },
        { id: 'b', path: documents, sortKey: 'size', sortDir: 'desc' },
      ],
      active: 0,
      colWidths: normalizeCols(null),
      colVisible: normalizeVis(null),
      colsVersion: 2,
    },
  ]
  const next = syncPaneViews(panes, store)
  assert.equal(next[0].tabs[0].sortKey, 'mtime')
  assert.equal(next[0].tabs[0].sortDir, 'desc')
  assert.equal(next[0].tabs[1].sortKey, 'mtime')
  assert.equal(next[0].tabs[1].sortDir, 'desc')
  assert.equal(next[0].colWidths.size, 90)
  assert.equal(next[0].colVisible.btime, true)
  assert.equal(syncPaneViews(next, store), next)

  const switched = syncPaneViews([{ ...next[0], active: 1 }], store)
  assert.equal(switched[0].colWidths.size, normalizeCols(null).size)
  assert.equal(switched[0].colVisible.btime, false)
  assert.equal(switched[0].tabs[0].sortKey, 'mtime')
})

test('a renamed folder with no key does not throw while syncing panes', () => {
  const store = withFolderPatch(emptyViewSettings(), downloads, { sort: { key: 'size', dir: 'desc' } })
  const panes = [
    {
      tabs: [{ id: 'a', path: '/Users/me/OldDownloads', sortKey: 'size', sortDir: 'desc' }],
      active: 0,
      colWidths: normalizeCols(null),
      colVisible: normalizeVis(null),
      colsVersion: 2,
    },
  ]
  let next
  assert.doesNotThrow(() => {
    next = syncPaneViews(panes, store)
  })
  assert.equal(next[0].tabs[0].sortKey, 'mtime')
  assert.equal(next[0].tabs[0].sortDir, 'desc')
})

test('a tab without a saved sort opens by modified date, newest first', () => {
  assert.deepEqual(sortFromSavedTab(null), { sortKey: 'mtime', sortDir: 'desc' })
  assert.deepEqual(sortFromSavedTab({}), { sortKey: 'mtime', sortDir: 'desc' })
  assert.deepEqual(sortFromSavedTab({ sortKey: 'nope' }), { sortKey: 'mtime', sortDir: 'desc' })
  assert.deepEqual(sortFromSavedTab({ sortKey: 'date', sortDir: 'desc' }), { sortKey: 'mtime', sortDir: 'desc' })
  assert.deepEqual(sortFromSavedTab({ sortKey: 'name', sortDir: 'asc' }), { sortKey: 'name', sortDir: 'asc' })
  assert.deepEqual(sortFromSavedTab({ sortKey: 'mtime', sortDir: 'asc' }), { sortKey: 'mtime', sortDir: 'asc' })
})

test('seed lifts the focused pane into global defaults', () => {
  const panes = [
    {
      tabs: [{ path: downloads, sortKey: 'name', sortDir: 'asc' }],
      active: 0,
      colWidths: { ...normalizeCols(null), kind: 140 },
      colVisible: { ...normalizeVis(null), kind: false },
      colsVersion: 2,
    },
  ]
  const seeded = seedViewSettings(panes, 0)
  assert.equal(seeded.version, 1)
  assert.equal(seeded.defaults.sort.key, 'name')
  assert.equal(seeded.defaults.sort.dir, 'asc')
  assert.equal(seeded.defaults.columns.widths.kind, 140)
  assert.equal(seeded.defaults.columns.visible.kind, false)
  assert.equal(seeded.defaults.iconSize, null)
  assert.deepEqual(seeded.overrides, {})
})
