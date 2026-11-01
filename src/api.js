import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { LIST_BATCH } from './dirLoad.js'
import { searchApi, demoSearch, searchRequestId } from './search/model.js'

export const hasTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

export const api = hasTauri
  ? {
      ...searchApi(invoke),
      listDir: (path, showHidden) => invoke('list_dir', { path, showHidden }),
      listSubdirectories: (path, showHidden) => invoke('list_subdirectories', { path, showHidden }),
      // 当前目录分批推送。onBatch 是 Tauri Channel；约 500 条一批，最后一批 done=true。
      listDirStream: (path, showHidden, requestId, sortKey, sortDir, onBatch) =>
        invoke('list_dir_stream', {
          path,
          showHidden,
          requestId,
          sortKey: sortKey || 'name',
          sortDir: sortDir || 'asc',
          onBatch,
        }),
      cancelListDir: (requestId) => invoke('cancel_list_dir', { requestId }),
      transfer: (sources, dest, mode) => invoke('transfer', { sources, dest, mode }),
      moveItems: (sources, dest) => invoke('move_items', { sources, dest }),
      restoreMoves: (moves) => invoke('restore_moves', { moves }),
      trash: (paths, expected) => invoke('trash', { paths, expected: expected || null }),
      makeDirWithReceipt: (path) => invoke('make_dir_with_receipt', { path }),
      makeDir: async (path) => (await invoke('make_dir_with_receipt', { path })).path,
      previewRegexRename: (names, pattern, replacement) => invoke('regex_rename_preview', { names, pattern, replacement }),
      renameWithReceipt: (oldPath, newName) => invoke('rename_with_receipt', { oldPath, newName }),
      rename: async (oldPath, newName) => (await invoke('rename_with_receipt', { oldPath, newName })).path,
      openPath: (path) => invoke('open_path', { path }),
      reveal: (path) => invoke('reveal_in_finder', { path }),
      openTerminal: (path) => invoke('open_terminal', { path }),
      zipPathsWithReceipt: (sources, destDir, options) => invoke('zip_paths_with_receipt', { sources, destDir, options: options || null }),
      zipPaths: async (sources, destDir, options) => {
        const result = await invoke('zip_paths_with_receipt', { sources, destDir, options: options || null })
        if (result.error) throw result.error
        return result.entries.map(entry => entry.path)
      },
      quickLook: (path, paths, session = null) =>
        invoke('quick_look', { path, paths: paths && paths.length ? paths : null, session }),
      updateQuickLook: (path, paths, session, revision) =>
        invoke('update_quick_look', { path, paths, session, revision }),
      makeFile: (path) => invoke('make_file', { path }),
      createFileWithReceipt: (dir, kind) => invoke('create_file_with_receipt', { dir, kind }),
      createFile: async (dir, kind) => (await invoke('create_file_with_receipt', { dir, kind })).path,
      listTemplates: () => invoke('list_templates'),
      copyTemplateWithReceipt: (dir, template) => invoke('copy_template_with_receipt', { dir, template }),
      copyTemplate: async (dir, template) => (await invoke('copy_template_with_receipt', { dir, template })).path,
      copyFilesToClipboard: (paths) => invoke('copy_files_to_clipboard', { paths }),
      readTextPreview: (path, query, maxBytes) =>
        invoke('read_text_preview', { path, query, maxBytes: maxBytes || 262144 }),
      openPrivacySettings: () => invoke('open_privacy_settings'),
      fsearchStatus: () => invoke('fsearch_status'),
      dirActivity: (paths) => invoke('dir_activity', { paths }),
      diskSpace: (path) => invoke('disk_space', { path }),
      homeDir: () => invoke('home_dir'),
      resolvePath: (path) => invoke('resolve_path', { path }),
      completePath: (path) => invoke('complete_path', { path }),
      fileIcons: (paths) => invoke('file_icons', { paths }),
      loadSession: () => invoke('load_session'),
      saveSession: (session) => invoke('save_session', { session }),
      sessionExitReply: (requestId, allowExit) => invoke('session_exit_reply', { requestId, allowExit }),
      loadConfig: () => invoke('load_config'),
      saveConfig: (config) => invoke('save_config', { config }),
      loadViewSettings: () => invoke('load_view_settings'),
      saveViewSettings: (viewSettings) => invoke('save_view_settings', { viewSettings }),
    }
  : mockApi()

// 浏览器直开（无 Tauri）时的假后端：用于 UI 自动化测试
function mockApi() {
  const now = Date.now()
  let nextInode = 1
  const newIdentity = () => ({ dev: '1', ino: String(nextInode++) })
  const E = (name, isDir, size = 0) => ({
    name,
    identity: newIdentity(),
    path: '',
    is_dir: isDir,
    size: isDir ? 0 : size,
    mtime_ms: now - Math.random() * 3e9,
    btime_ms: now - Math.random() * 9e9,
    ext: isDir ? '' : (name.split('.').pop() || '').toLowerCase(),
  })
  const TREE = {
    '/Users/demo': [
      E('Desktop', true), E('Documents', true), E('Downloads', true), E('Pictures', true),
      E('Movies', true), E('Music', true), E('项目A_测试', true), E('项目B', true),
      E('README.md', false, 2048), E('notes.txt', false, 512),
    ],
    '/Users/demo/Desktop': [E('截图1.png', false, 1024e3), E('截图2.png', false, 2048e3), E('报告.pdf', false, 300e3)],
    '/Users/demo/Documents': [E('示例文档.docx', false, 120e3), E('示例表格.xlsx', false, 88e3), E('示例文件夹', true)],
    '/Users/demo/Documents/示例文件夹': [E('示例脚本.rs', false, 4e3), E('示例库.rs', false, 9e3)],
    '/Users/demo/Downloads': [E('示例安装包.dmg', false, 500e6), E('示例数据.csv', false, 20e3), E('大量文件', true)],
    // 浏览器里打开这个目录会分批吐出 1 万个文件，用来看虚拟列表。条目不放进 TREE，避免搜索把它们扫进去。
    '/Users/demo/Downloads/大量文件': [],
    '/Users/demo/Pictures': [E('示例图片.jpg', false, 3e6)],
    '/Users/demo/Movies': [], '/Users/demo/Music': [],
    '/Users/demo/项目A_测试': [
      E('测试文件.txt', false, 100), E('说明.md', false, 800),
      E('示例子文件夹一', true),
      E('示例子文件夹二', true),
    ],
    '/Users/demo/项目B': [E('示例脚本.py', false, 2e3)],
    '/Users/demo/项目A_测试/示例子文件夹一': [E('示例文件.txt', false, 100)],
  }
  // 与 Rust resolve_path 同一套规则：展开 ~、拒绝相对路径、目录才算成功。
  const mockResolvePath = (path) => {
    const home = '/Users/demo'
    const raw = (path || '').trim()
    if (!raw) return Promise.reject('请输入路径')
    let expanded
    if (raw === '~') expanded = home
    else if (raw.startsWith('~/')) expanded = home + raw.slice(1)
    else if (raw.startsWith('~')) return Promise.reject('仅支持 ~ 与 ~/ 开头的路径')
    else if (!raw.startsWith('/')) return Promise.reject('请输入绝对路径或以 ~ 开头的路径')
    else expanded = raw
    const parts = []
    for (const seg of expanded.split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    const canonical = `/${parts.join('/')}`
    if (TREE[canonical]) return Promise.resolve(canonical)
    const slash = canonical.lastIndexOf('/')
    const parent = slash <= 0 ? '/' : canonical.slice(0, slash)
    const name = canonical.slice(slash + 1)
    const hit = TREE[parent]?.find((e) => e.name === name)
    if (hit?.is_dir) return Promise.resolve(canonical)
    if (hit) return Promise.reject(`不是文件夹: ${canonical}`)
    return Promise.reject(`路径不存在: ${canonical}`)
  }
  const normalizeDir = (p) => {
    const parts = []
    for (const seg of String(p).split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    return `/${parts.join('/')}`
  }
  const charsEqCi = (a, b) => a === b || a.toLowerCase() === b.toLowerCase()
  const commonPrefixCi = (names) => {
    if (!names.length) return ''
    let chars = [...names[0]]
    for (const name of names.slice(1)) {
      const other = [...name]
      let i = 0
      const n = Math.min(chars.length, other.length)
      while (i < n && charsEqCi(chars[i], other[i])) i++
      chars = chars.slice(0, i)
      if (!chars.length) break
    }
    return chars.join('')
  }
  // 与 Rust complete_path 同一套规则：展开 ~、只读一层、前缀匹配、最多 50 条。
  const mockCompletePath = (path) => {
    const home = '/Users/demo'
    const raw = (path || '').trim()
    if (!raw) return Promise.reject('请输入路径')
    if (raw.startsWith('~') && raw !== '~' && !raw.startsWith('~/')) {
      return Promise.reject('仅支持 ~ 与 ~/ 开头的路径')
    }
    if (!raw.startsWith('~') && !raw.startsWith('/')) {
      return Promise.reject('请输入绝对路径或以 ~ 开头的路径')
    }
    const listChildren = raw === '~' || raw.endsWith('/')
    const base = raw === '~' || raw === '~/' ? '~/' : raw.endsWith('/') ? raw : raw.slice(0, raw.lastIndexOf('/') + 1)
    let expanded
    if (raw === '~') expanded = home
    else if (raw.startsWith('~/')) expanded = home + raw.slice(1)
    else expanded = raw
    expanded = expanded.replace(/\/+$/, '') || '/'
    let dir
    let prefix
    if (listChildren) {
      dir = expanded
      prefix = ''
    } else {
      const slash = expanded.lastIndexOf('/')
      dir = slash <= 0 ? '/' : expanded.slice(0, slash)
      prefix = expanded.slice(slash + 1)
    }
    dir = normalizeDir(dir)
    const entries = TREE[dir]
    if (!entries) return Promise.reject(`路径不存在: ${dir}`)
    const wantHidden = prefix.startsWith('.')
    const pfx = prefix.toLowerCase()
    const matches = entries
      .filter((e) => {
        if (!wantHidden && e.name.startsWith('.')) return false
        if (pfx && !e.name.toLowerCase().startsWith(pfx)) return false
        return true
      })
      .map((e) => ({ name: e.name, is_dir: !!e.is_dir }))
      .sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name)
      })
    let text
    if (!matches.length) text = base + prefix
    else if (matches.length === 1) text = base + matches[0].name + (matches[0].is_dir ? '/' : '')
    else {
      const common = commonPrefixCi(matches.map((m) => m.name))
      text =
        [...common].length >= [...prefix].length && common.toLowerCase().startsWith(pfx)
          ? base + common
          : base + prefix
    }
    return Promise.resolve({ text, base, matches: matches.slice(0, 50) })
  }
  const fillPath = (dir, entries) => entries.map((e) => ({ ...e, path: `${dir}/${e.name}` }))
  const HUGE_PATH = '/Users/demo/Downloads/大量文件'
  const HUGE_COUNT = 10000
  let hugeCache = null
  const hugeEntries = () => {
    if (hugeCache) return hugeCache
    const list = new Array(HUGE_COUNT)
    for (let i = 0; i < HUGE_COUNT; i++) {
      const name = `f${String(i).padStart(6, '0')}.txt`
      list[i] = {
        name,
        path: `${HUGE_PATH}/${name}`,
        is_dir: false,
        size: 32,
        mtime_ms: now,
        btime_ms: now,
        ext: 'txt',
      }
    }
    hugeCache = list
    return list
  }
  const cancelledStreams = new Set()
  const entriesFor = (path, showHidden) => {
    const source = path === HUGE_PATH ? hugeEntries() : fillPath(path, TREE[path] || [])
    if (showHidden) return source
    return source.filter((entry) => !entry.name.startsWith('.'))
  }
  // 与 Rust place_new_file 一致：「名称.ext」已存在时用「名称 2.ext」，不覆盖。
  const uniqueName = (list, name) => {
    const names = new Set(list.map((e) => e.name))
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    let n = name
    let i = 2
    while (names.has(n)) {
      n = `${stem} ${i}${ext}`
      i++
    }
    return n
  }
  const TEMPLATES = [
    {
      name: '示例模板.docx',
      path: '/Users/demo/Library/Application Support/com.bento.app/templates/示例模板.docx',
    },
  ]
  const rekeyMockTree = (oldPath, newPath) => {
    const prefix = `${oldPath}/`
    const moves = []
    for (const key of Object.keys(TREE)) {
      if (key === oldPath || key.startsWith(prefix)) moves.push(key)
    }
    for (const key of moves) {
      const next = newPath + key.slice(oldPath.length)
      TREE[next] = TREE[key]
      delete TREE[key]
    }
  }
  const mockMoveItems = (sources, dest) => {
    if (!TREE[dest]) return Promise.reject(`目标不是文件夹: ${dest}`)
    const results = []
    for (const p of sources) {
      const slash = p.lastIndexOf('/')
      const parent = slash <= 0 ? '/' : p.slice(0, slash)
      const name = p.slice(slash + 1)
      const list = TREE[parent]
      const entry = list?.find((e) => e.name === name)
      if (!entry) {
        results.push({ source: p, dest: '', ok: false, error: '源不存在' })
        continue
      }
      if (parent === dest) {
        results.push({ source: p, dest: p, ok: true, error: null, identity: entry.identity })
        continue
      }
      if (dest === p || dest.startsWith(`${p}/`)) {
        results.push({ source: p, dest: '', ok: false, error: '不能将文件夹移动到其自身内部' })
        continue
      }
      const dot = name.lastIndexOf('.')
      const stem = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      let n = name
      let i = 1
      const taken = () => (TREE[dest] || []).some((e) => e.name === n)
      if (taken()) n = `${stem} copy${ext}`
      while (taken()) n = `${stem} copy ${i++}${ext}`
      TREE[parent] = list.filter((e) => e.name !== name)
      ;(TREE[dest] = TREE[dest] || []).push({ ...entry, name: n })
      if (entry.is_dir) rekeyMockTree(p, `${dest}/${n}`)
      results.push({ source: p, dest: `${dest}/${n}`, ok: true, error: null, identity: entry.identity })
    }
    return Promise.resolve(results)
  }
  const mock = {
    listSubdirectories: async (path, showHidden) => {
      const resolved = await mockResolvePath(path)
      return {
        entries: (TREE[resolved] || []).filter(e => e.is_dir && (showHidden || !e.name.startsWith('.')))
          .map(e => ({ name: e.name, path: `${path.endsWith('/') ? path : path + '/'}${e.name}`, is_symlink: false })),
        truncated: false,
      }
    },
    listDir: (path, showHidden) => {
      if (path !== HUGE_PATH && !TREE[path]) return Promise.reject(new Error(`无法读取目录 ${path}`))
      return Promise.resolve({ entries: entriesFor(path, showHidden) })
    },
    listDirStream: (path, showHidden, requestId, sortKey, sortDir, onBatch) => {
      cancelledStreams.delete(requestId)
      if (path !== HUGE_PATH && !TREE[path]) return Promise.reject(new Error(`无法读取目录 ${path}`))
      let entries = entriesFor(path, showHidden)
      if (path === HUGE_PATH && (sortKey || 'name') === 'name' && sortDir === 'desc') {
        entries = entries.slice().reverse()
      }
      const total = entries.length
      return new Promise((resolve, reject) => {
        let offset = 0
        let index = 0
        const pump = () => {
          if (cancelledStreams.has(requestId)) {
            cancelledStreams.delete(requestId)
            resolve()
            return
          }
          const slice = entries.slice(offset, offset + LIST_BATCH)
          const done = offset + LIST_BATCH >= entries.length
          offset += LIST_BATCH
          try {
            onBatch?.onmessage?.({ entries: slice, index, done, total })
          } catch (err) {
            reject(err)
            return
          }
          index += 1
          if (done) resolve()
          else setTimeout(pump, path === HUGE_PATH ? 16 : 0)
        }
        setTimeout(pump, 0)
      })
    },
    cancelListDir: (requestId) => {
      cancelledStreams.add(requestId)
      return Promise.resolve()
    },
    restoreMoves: (moves) => Promise.resolve(moves.map(({ source, dest, identity }) => {
      const split = (p) => { const i = p.lastIndexOf('/'); return [i <= 0 ? '/' : p.slice(0, i), p.slice(i + 1)] }
      const [from, name] = split(source), [to, restoredName] = split(dest)
      const entry = TREE[from]?.find((e) => e.name === name)
      const fail = (error) => ({ source, dest, ok: false, error })
      if (!entry) return fail('源不存在')
      if (identity && (entry.identity?.dev !== identity.dev || entry.identity?.ino !== identity.ino)) return fail('项目已被替换')
      if (source === dest) return { source, dest, ok: true, error: null }
      if (!TREE[to]) return fail('目标不是文件夹')
      if (TREE[to].some((e) => e.name === restoredName)) return fail('原路径已被占用')
      if (dest.startsWith(`${source}/`)) return fail('不能恢复到自身内部')
      TREE[from] = TREE[from].filter((e) => e !== entry)
      TREE[to].push({ ...entry, name: restoredName })
      if (entry.is_dir) rekeyMockTree(source, dest)
      return { source, dest, ok: true, error: null }
    })),
    moveItems: (sources, dest) => mockMoveItems(sources, dest),
    transfer: (sources, dest, mode) => {
      if (mode === 'move') return mockMoveItems(sources, dest)
      if (!TREE[dest]) return Promise.reject(`目标不是文件夹: ${dest}`)
      return Promise.resolve(sources.map(source => {
        const slash = source.lastIndexOf('/')
        const parent = slash <= 0 ? '/' : source.slice(0, slash)
        const name = source.slice(slash + 1)
        const entry = TREE[parent]?.find(e => e.name === name)
        if (!entry) return { source, dest: '', ok: false, error: '源不存在' }
        if (dest === source || dest.startsWith(`${source}/`)) return { source, dest: '', ok: false, error: '不能拷贝到自身内部' }
        const copiedName = uniqueName(TREE[dest], name)
        const actual = `${dest}/${copiedName}`
        const identity = newIdentity()
        TREE[dest].push({ ...entry, name: copiedName, identity })
        if (entry.is_dir) {
          for (const dir of Object.keys(TREE).filter(p => p === source || p.startsWith(`${source}/`))) {
            TREE[actual + dir.slice(source.length)] = TREE[dir].map(e => ({ ...e, identity: newIdentity() }))
          }
        }
        return { source, dest: actual, ok: true, error: null, identity }
      }))
    },
    trash: (paths, expected) => {
      const entries = [], errors = []
      const trashDir = '/.mock-system-trash'
      TREE[trashDir] ||= []
      for (const original of paths || []) {
        const slash = original.lastIndexOf('/')
        const parent = slash <= 0 ? '/' : original.slice(0, slash)
        const name = original.slice(slash + 1)
        const entry = TREE[parent]?.find(e => e.name === name)
        const guard = expected?.find(e => e.path === original)
        if (!entry) { errors.push(`${name}: 源不存在`); continue }
        if (expected && (!guard || guard.dev !== entry.identity?.dev || guard.ino !== entry.identity?.ino)) {
          errors.push(`${name}: 项目已被替换`); continue
        }
        const trashedName = uniqueName(TREE[trashDir], name)
        const trashed = `${trashDir}/${trashedName}`
        TREE[parent] = TREE[parent].filter(e => e !== entry)
        TREE[trashDir].push({ ...entry, name: trashedName })
        if (entry.is_dir) rekeyMockTree(original, trashed)
        entries.push({ original, trashed, identity: entry.identity })
      }
      return Promise.resolve({ entries, error: errors.length ? errors.join('\n') : null, cancelled: false })
    },
    makeDir: (dir) => {
      const list = (TREE[dir] = TREE[dir] || [])
      const name = uniqueName(list, '未命名文件夹')
      const entry = E(name, true)
      list.push(entry)
      TREE[`${dir}/${name}`] = []
      return Promise.resolve({ path: `${dir}/${name}`, identity: entry.identity })
    },
    createFile: (dir, kind) => {
      if (kind !== 'text' && kind !== 'txt' && kind !== 'markdown' && kind !== 'md') {
        return Promise.reject(`不支持的文件类型: ${kind}`)
      }
      const list = (TREE[dir] = TREE[dir] || [])
      const base = kind === 'markdown' || kind === 'md' ? '未命名.md' : '未命名.txt'
      const name = uniqueName(list, base)
      const entry = E(name, false, 0)
      list.push(entry)
      return Promise.resolve({ path: `${dir}/${name}`, identity: entry.identity })
    },
    listTemplates: () => Promise.resolve(TEMPLATES.map((t) => ({ ...t }))),
    copyTemplate: (dir, template) => {
      const list = (TREE[dir] = TREE[dir] || [])
      const known = TEMPLATES.find((t) => t.path === template)
      const base = known?.name || String(template).slice(String(template).lastIndexOf('/') + 1) || '未命名'
      const name = uniqueName(list, base)
      const entry = E(name, false, known ? 120 : 0)
      list.push(entry)
      return Promise.resolve({ path: `${dir}/${name}`, identity: entry.identity })
    },
    rename: (oldPath, newName) => {
      const parent = oldPath.slice(0, oldPath.lastIndexOf('/'))
      const oldName = oldPath.slice(oldPath.lastIndexOf('/') + 1)
      const entry = (TREE[parent] || []).find((e) => e.name === oldName)
      if (!entry) return Promise.reject('源不存在')
      newName = newName.trim()
      if (!newName || newName.includes('/') || newName === '.' || newName === '..') return Promise.reject('名称不合法')
      if (newName !== oldName && TREE[parent].some(e => e.name === newName)) return Promise.reject('名称已存在')
      const path = `${parent}/${newName}`
      entry.name = newName
      entry.ext = newName.includes('.') ? newName.split('.').pop().toLowerCase() : ''
      if (entry.is_dir) rekeyMockTree(oldPath, path)
      return Promise.resolve({ path, identity: entry.identity })
    },
    readTextPreview: (path, query) => {
      const name = path.slice(path.lastIndexOf('/') + 1)
      const q = (query || '示例').trim()
      const lines = []
      for (let i = 1; i <= 60; i++) {
        if (i % 7 === 3) lines.push(`      第 ${i} 行：这里包含关键词「${q}」的匹配内容，用于预览高亮演示。`)
        else if (i % 7 === 5) lines.push(`      第 ${i} 行：another line mentioning ${q} inside the demo body text`)
        else lines.push(`      第 ${i} 行：普通内容行 ${name} demo line ${i}`)
      }
      return Promise.resolve({ kind: 'text', text: lines.join('\n'), truncated: false, matchLines: [3, 10, 17, 24] })
    },
    copyFilesToClipboard: () => Promise.resolve(),
    openPath: () => Promise.resolve(),
    reveal: () => Promise.resolve(),
    openTerminal: () => Promise.resolve(),
    zipPaths: (sources, dir, options = {}) => {
      if (!TREE[dir]) return Promise.reject('目标不是文件夹')
      const names = options?.separate && sources.length > 1
        ? sources.map(path => path.slice(path.lastIndexOf('/') + 1) + '.zip')
        : [options?.name || (sources.length === 1 ? sources[0].slice(sources[0].lastIndexOf('/') + 1) + '.zip' : '归档.zip')]
      const entries = names.map(name => {
        const actual = uniqueName(TREE[dir], name.toLowerCase().endsWith('.zip') ? name : name + '.zip')
        const entry = E(actual, false)
        TREE[dir].push(entry)
        return { path: `${dir}/${actual}`, identity: entry.identity }
      })
      return Promise.resolve({ entries, error: null })
    },
    quickLook: () => Promise.resolve(),
    updateQuickLook: () => Promise.resolve(),
    searchQuery: async (q, scope, root, showHidden, roots, mode, requestId, format = 'all') => {
      if (scope === 'pane' && !TREE[root]) throw {code:'invalidRoot',message:`无法读取目录 ${root}`}
      return demoSearch(Object.entries(TREE).flatMap(([dir, es]) => fillPath(dir, es)), q, scope, root, showHidden, roots, mode, format)
    },
    cancelSearch: async () => {},
    search: async (...args) => (await mock.searchQuery(...args, searchRequestId())).items,
    fsearchStatus: () => Promise.resolve({ ready: true, entries: 0, full_disk_access: true }),
    dirActivity: (paths) =>
      Promise.resolve(paths.map((p) => ({ path: p, mtime_ms: Date.now() - Math.random() * 1e8 }))),
    // mock 与真实保持同签名
    diskSpace: () => Promise.resolve(500e9),
    homeDir: () => Promise.resolve('/Users/demo'),
    resolvePath: (path) => mockResolvePath(path),
    completePath: (path) => mockCompletePath(path),
    fileIcons: (paths) =>
      Promise.resolve((paths || []).map((path) => ({ path, icon: null, template: false }))),
    loadSession: () => {
      try { return Promise.resolve(JSON.parse(localStorage.getItem('bento-mock-session') || 'null')) }
      catch (error) { return Promise.reject(error) }
    },
    saveSession: session => {
      try { localStorage.setItem('bento-mock-session', JSON.stringify(session)); return Promise.resolve() }
      catch (error) { return Promise.reject(error) }
    },
    sessionExitReply: () => Promise.resolve(),
    // 浏览器测试视图也用 localStorage 记住工作区/布局，行为与真实 app 一致
    loadConfig: () => {
      try {
        return Promise.resolve(JSON.parse(localStorage.getItem('bento-mock-config') || 'null'))
      } catch {
        return Promise.resolve(null)
      }
    },
    saveConfig: (config) => {
      try {
        localStorage.setItem('bento-mock-config', JSON.stringify(config))
      } catch {}
      return Promise.resolve()
    },
    loadViewSettings: () => {
      try {
        return Promise.resolve(JSON.parse(localStorage.getItem('bento-view-settings') || 'null'))
      } catch {
        return Promise.resolve(null)
      }
    },
    saveViewSettings: (viewSettings) => {
      try {
        localStorage.setItem('bento-view-settings', JSON.stringify(viewSettings))
      } catch {}
      return Promise.resolve()
    },
  }
  for (const name of ['makeDir', 'createFile', 'copyTemplate', 'rename']) {
    const mutate = mock[name]
    mock[name + 'WithReceipt'] = mutate
    mock[name] = async (...args) => (await mutate(...args)).path
  }
  mock.previewRegexRename = () => Promise.reject(new Error('请在Bento中使用正则预览'))
  mock.makeFile = dir => mock.createFile(dir, 'text')
  const zip = mock.zipPaths
  mock.zipPathsWithReceipt = zip
  mock.zipPaths = async (...args) => {
    const result = await zip(...args)
    if (result.error) throw result.error
    return result.entries.map(entry => entry.path)
  }
  return mock
}

export const fileSrc = hasTauri ? convertFileSrc : (p) => ''
