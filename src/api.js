import { invoke, convertFileSrc } from '@tauri-apps/api/core'

export const hasTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

export const api = hasTauri
  ? {
      listDir: (path, showHidden) => invoke('list_dir', { path, showHidden }),
      transfer: (sources, dest, mode) => invoke('transfer', { sources, dest, mode }),
      trash: (paths) => invoke('trash', { paths }),
      makeDir: (path) => invoke('make_dir', { path }),
      rename: (oldPath, newName) => invoke('rename', { oldPath, newName }),
      openPath: (path) => invoke('open_path', { path }),
      reveal: (path) => invoke('reveal_in_finder', { path }),
      openTerminal: (path) => invoke('open_terminal', { path }),
      zipPaths: (sources, destDir, options) => invoke('zip_paths', { sources, destDir, options: options || null }),
      quickLook: (path, paths) =>
        invoke('quick_look', { path, paths: paths && paths.length ? paths : null }),
      makeFile: (path) => invoke('make_file', { path }),
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
      fileIcons: (paths) => invoke('file_icons', { paths }),
      loadConfig: () => invoke('load_config'),
      saveConfig: (config) => invoke('save_config', { config }),
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
    '/Users/demo/Downloads': [E('示例安装包.dmg', false, 500e6), E('示例数据.csv', false, 20e3)],
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
  const fillPath = (dir, entries) => entries.map((e) => ({ ...e, path: `${dir}/${e.name}` }))
  return {
    listDir: (path) => {
      const entries = TREE[path]
      if (!entries) return Promise.reject(new Error(`无法读取目录 ${path}`))
      return Promise.resolve({ entries: fillPath(path, entries) })
    },
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
      const names = new Set(list.map((e) => e.name))
      let name = '未命名文件夹'
      let i = 2
      while (names.has(name)) name = `未命名文件夹 ${i++}`
      list.push(E(name, true))
      return Promise.resolve(`${dir}/${name}`)
    },
    makeFile: (dir) => {
      const list = (TREE[dir] = TREE[dir] || [])
      const names = new Set(list.map((e) => e.name))
      let name = '未命名.txt'
      let i = 2
      while (names.has(name)) name = `未命名 ${i++}.txt`
      list.push(E(name, false, 0))
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
    openPath: () => Promise.resolve(),
    reveal: () => Promise.resolve(),
    openTerminal: () => Promise.resolve(),
    zipPaths: () => Promise.resolve([]),
    quickLook: () => Promise.resolve(),
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
    fileIcons: (paths) =>
      Promise.resolve((paths || []).map((path) => ({ path, icon: null, template: false }))),
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
  }
}

export const fileSrc = hasTauri ? convertFileSrc : (p) => ''
