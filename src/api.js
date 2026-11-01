import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { LIST_BATCH } from './dirLoad.js'

export const hasTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

export const api = hasTauri
  ? {
      ...operationApi(invoke),
      listDir: (path, showHidden) => invoke('list_dir', { path, showHidden }),
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
      openPath: (path) => invoke('open_path', { path }),
      reveal: (path) => invoke('reveal_in_finder', { path }),
      openTerminal: (path) => invoke('open_terminal', { path }),
      quickLook: (path, paths, session = null) =>
        invoke('quick_look', { path, paths: paths && paths.length ? paths : null, session }),
      updateQuickLook: (path, paths, session, revision) =>
        invoke('update_quick_look', { path, paths, session, revision }),
      listTemplates: () => invoke('list_templates'),
      search: (query, scope, root, showHidden, roots, mode) =>
        invoke('search', { query, scope, root: root || null, showHidden, roots: roots || [], mode: mode || 'name' }),
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
  const E = (name, isDir, size = 0) => ({
    name,
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
        results.push({ source: p, dest: p, ok: true, error: null })
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
      results.push({ source: p, dest: `${dest}/${n}`, ok: true, error: null })
    }
    return Promise.resolve(results)
  }
  const legacy = {
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
    restoreMoves: (moves) => Promise.resolve(moves.map(({ source, dest }) => {
      const split = (p) => { const i = p.lastIndexOf('/'); return [i <= 0 ? '/' : p.slice(0, i), p.slice(i + 1)] }
      const [from, name] = split(source), [to, restoredName] = split(dest)
      const entry = TREE[from]?.find((e) => e.name === name)
      const fail = (error) => ({ source, dest, ok: false, error })
      if (!entry) return fail('源不存在')
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
      for (const p of sources) {
        const parent = p.slice(0, p.lastIndexOf('/'))
        const name = p.slice(p.lastIndexOf('/') + 1)
        const entry = (TREE[parent] || []).find((e) => e.name === name)
        if (!entry) continue
        if (mode === 'move') {
          TREE[parent] = TREE[parent].filter((e) => e.name !== name)
          ;(TREE[dest] = TREE[dest] || []).push(entry)
        } else {
          const list = (TREE[dest] = TREE[dest] || [])
          let n = name
          let i = 2
          const dot = name.lastIndexOf('.')
          while (list.some((e) => e.name === n)) {
            n = dot > 0 ? `${name.slice(0, dot)} ${i++}${name.slice(dot)}` : `${name} ${i++}`
          }
          list.push({ ...entry, name: n, path: `${dest}/${n}` })
        }
      }
      return Promise.resolve(
        sources.map((p) => ({ source: p, dest: `${dest}/${p.slice(p.lastIndexOf('/') + 1)}`, ok: true }))
      )
    },
    trash: (paths) => {
      for (const p of paths || []) {
        const parent = p.slice(0, p.lastIndexOf('/'))
        if (TREE[parent]) TREE[parent] = TREE[parent].filter((e) => `${parent}/${e.name}` !== p)
      }
      return Promise.resolve()
    },
    makeDir: (dir) => {
      const list = (TREE[dir] = TREE[dir] || [])
      const name = uniqueName(list, '未命名文件夹')
      list.push(E(name, true))
      return Promise.resolve(`${dir}/${name}`)
    },
    createFile: (dir, kind) => {
      if (kind !== 'text' && kind !== 'txt' && kind !== 'markdown' && kind !== 'md') {
        return Promise.reject(`不支持的文件类型: ${kind}`)
      }
      const list = (TREE[dir] = TREE[dir] || [])
      const base = kind === 'markdown' || kind === 'md' ? '未命名.md' : '未命名.txt'
      const name = uniqueName(list, base)
      list.push(E(name, false, 0))
      return Promise.resolve(`${dir}/${name}`)
    },
    listTemplates: () => Promise.resolve(TEMPLATES.map((t) => ({ ...t }))),
    copyTemplate: (dir, template) => {
      const list = (TREE[dir] = TREE[dir] || [])
      const known = TEMPLATES.find((t) => t.path === template)
      const base = known?.name || String(template).slice(String(template).lastIndexOf('/') + 1) || '未命名'
      const name = uniqueName(list, base)
      list.push(E(name, false, known ? 120 : 0))
      return Promise.resolve(`${dir}/${name}`)
    },
    rename: (oldPath, newName) => {
      const parent = oldPath.slice(0, oldPath.lastIndexOf('/'))
      const oldName = oldPath.slice(oldPath.lastIndexOf('/') + 1)
      const entry = (TREE[parent] || []).find((e) => e.name === oldName)
      if (entry) {
        entry.name = newName
        entry.ext = newName.includes('.') ? newName.split('.').pop().toLowerCase() : ''
      }
      return Promise.resolve(`${parent}/${newName}`)
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
    quickLook: () => Promise.resolve(),
    updateQuickLook: () => Promise.resolve(),
    search: (q, scope, root, showHidden, roots, mode) => {
      if (mode === 'content') {
        // 模拟内容命中：返回带行号与文本的结果（供两栏内容框验收）
        return Promise.resolve(
          Object.entries(TREE)
            .flatMap(([dir, es]) => fillPath(dir, es))
            .filter((e) => !e.is_dir && e.name.toLowerCase().includes((q || '').toLowerCase()))
            .slice(0, 20)
            .map((e, i) => ({
              ...e,
              dir: e.path.slice(0, e.path.length - e.name.length - 1),
              btime_ms: e.mtime_ms,
              lines: [
                { no: 3 + (i % 5), text: `... 示例内容包含「${q}」的匹配行，用于预览高亮 ...` },
                { no: 4 + (i % 5), text: `    another line mentioning ${q} inside the file body` },
              ],
              matches: 2 + (i % 3),
            }))
        )
      }
      return Promise.resolve(
        Object.entries(TREE)
          .flatMap(([dir, es]) => fillPath(dir, es))
          .filter((e) => e.name.toLowerCase().includes((q || '').toLowerCase()))
          .map((e) => ({ ...e, dir: e.path.slice(0, e.path.length - e.name.length - 1), btime_ms: e.mtime_ms }))
          .slice(0, 100)
      )
    },
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
  return { ...legacy, ...browserOperations(legacy) }
}

export const fileSrc = hasTauri ? convertFileSrc : (p) => ''

// The native API exposes one write admission boundary. No direct mutation commands.
export function operationApi(invoke) {
  return {
    enqueueOperation: request => invoke('enqueue_operation', { request }),
    listOperationJobs: () => invoke('list_operation_jobs', {}),
    getOperationJob: jobId => invoke('get_operation_job', { jobId }),
    getOperationOutcomes: (jobId, offset = 0, limit = 200) => invoke('get_operation_outcomes', { jobId, offset, limit }),
    ackOperationOutcomes: (jobId, revision, outcomeCount) => invoke('ack_operation_outcomes', { jobId, revision, outcomeCount }),
    cancelOperation: jobId => invoke('cancel_operation', { jobId }),
    resolveOperationConflict: (jobId, conflictId, revision, decision, applyToRemaining = false) =>
      invoke('resolve_operation_conflict', { jobId, conflictId, revision, decision, applyToRemaining }),
    undoOperation: (undoId, requestId) => invoke('undo_operation', { undoId, requestId }),
    listOperationRecoveries: () => invoke('list_operation_recoveries', {}),
    recoverOperation: (recoveryId, action, requestId) => invoke('recover_operation', { recoveryId, action, requestId }),
    prepareOperationExit: cancelRemaining => invoke('prepare_operation_exit', { cancelRemaining }),
  }
}

function browserOperations(legacy) {
  const jobs = [], outcomes = new Map()
  let revision = 0, accepting = true
  const snapshot = () => ({ sessionId: 'browser', revision, jobs: [...jobs], busy: false, accepting, latestUndoId: null })
  return {
    listOperationJobs: async () => snapshot(),
    listOperationRecoveries: async () => [],
    getOperationJob: async jobId => jobs.find(j => j.jobId === jobId),
    getOperationOutcomes: async (jobId, offset, limit) => ({ sessionId:'browser', jobId, revision, offset, total:outcomes.get(jobId)?.length || 0, outcomes:(outcomes.get(jobId) || []).slice(offset,offset+limit) }),
    enqueueOperation: async request => {
      const previous = jobs.find(j => j.requestId === request.requestId)
      if (previous) return previous
      if (!accepting) throw Error('正在退出，暂不接受文件操作')
      const submittedAtMs = Date.now()
      const rows = []
      for (const item of request.items) {
        const source = item.source
        let actualDestination = null, failure = null
        try {
          if (request.kind === 'copy' || request.kind === 'move') {
            const result = (await (request.kind === 'move' ? legacy.moveItems([source],request.destination) : legacy.transfer([source],request.destination,'copy')))[0]
            if (!result?.ok) throw Error(result?.error || '操作失败')
            actualDestination = result.dest
          } else if (request.kind === 'trash') await legacy.trash([source])
          else if (request.kind === 'rename') actualDestination = await legacy.rename(source,item.targetName)
          else if (request.kind === 'create') actualDestination = item.createKind === 'directory' ? await legacy.makeDir(request.destination) : item.createKind === 'template' ? await legacy.copyTemplate(request.destination,source) : await legacy.createFile(request.destination,item.createKind)
          else throw Error('浏览器演示不支持此操作，请在 Bento 中使用')
        } catch (error) { failure = { code:'demo', message:String(error), phase:'finished' } }
        const parent = path => path?.slice(0,path.lastIndexOf('/')) || '/'
        rows.push({itemId:item.itemId,source:source || null,requestedDestination:request.destination || null,actualDestination,status:failure?'failed':'succeeded',effectId:null,published:!failure,sourceDisposition:!failure && ['move','trash','rename'].includes(request.kind)?'removed':'unchanged',retry:'none',error:failure,affectedDirectories:failure?[]:[...new Set([actualDestination && parent(actualDestination),source && request.kind!=='copy' && parent(source)].filter(Boolean))]})
      }
      const failed=rows.filter(r=>r.status==='failed').length
      const job={ submittedAtMs, sessionId:'browser', jobId:`browser_${++revision}`, revision:1, requestId:request.requestId, kind:request.kind, state:failed?(failed===rows.length?'failed':'partial'):'completed', phase:'finished', ownerTabId:request.ownerTabId || null, clipRevision:request.clipRevision || null, intent:request.intent || null, cancelRequested:false,cancelability:'immediate',progress:{itemsFinished:rows.length,itemsTotal:rows.length,bytesDone:'0',bytesTotal:null,currentItemId:null,currentPath:null},conflict:null,outcomeCount:rows.length,undoId:null,error:null }
      if(jobs.length>=256) outcomes.delete(jobs.shift().jobId)
      jobs.push(job);outcomes.set(job.jobId,rows);return job
    },
    ackOperationOutcomes: async () => {},
    cancelOperation: async jobId => jobs.find(j=>j.jobId===jobId),
    prepareOperationExit: async cancelRemaining => { accepting=!cancelRemaining;return snapshot() },
    undoOperation: async () => {throw Error('浏览器演示不支持撤销')},
  }
}
