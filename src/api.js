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
      zipPaths: (sources, destDir) => invoke('zip_paths', { sources, destDir }),
      quickLook: (path) => invoke('quick_look', { path }),
      makeFile: (path) => invoke('make_file', { path }),
      search: (query, scope, root, showHidden) =>
        invoke('search', { query, scope, root: root || null, showHidden }),
      fsearchStatus: () => invoke('fsearch_status'),
      diskSpace: (path) => invoke('disk_space', { path }),
      homeDir: () => invoke('home_dir'),
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
    '/Users/demo/Documents': [E('论文.docx', false, 120e3), E('数据.xlsx', false, 88e3), E('代码', true)],
    '/Users/demo/Documents/代码': [E('main.rs', false, 4e3), E('lib.rs', false, 9e3)],
    '/Users/demo/Downloads': [E('installer.dmg', false, 500e6), E('dataset.csv', false, 20e3)],
    '/Users/demo/Pictures': [E('IMG_001.jpg', false, 3e6)],
    '/Users/demo/Movies': [], '/Users/demo/Music': [],
    '/Users/demo/项目A_测试': [
      E('测试文件.txt', false, 100), E('plan.md', false, 800),
      E('2026-10-29_临时_核磁_质谱_方梦园_2026-10-28_delete_计算_l13346669399', true),
      E('2026-10-28_delete_网络热图_1477806233秀_2026-10-09_delete_应答面_响应面_ l13346669399_overlay_backup', true),
    ],
    '/Users/demo/项目B': [E('app.py', false, 2e3)],
    '/Users/meng/.omp/agent/sessions': [
      E('-Documents-RAnalysisProjects-临时-2026-10-28_delete_计算_l13346669399_overlay', true),
      E('-Users-meng-Documents-RAnalysisProjects-----2026-10-28-delete-----l13346669399_session', true),
    ],
  }
  const fillPath = (dir, entries) => entries.map((e) => ({ ...e, path: `${dir}/${e.name}` }))
  return {
    listDir: (path) => {
      const entries = TREE[path]
      if (!entries) return Promise.reject(new Error(`无法读取目录 ${path}`))
      return Promise.resolve({ entries: fillPath(path, entries) })
    },
    transfer: () => Promise.resolve([]),
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
    openPath: () => Promise.resolve(),
    reveal: () => Promise.resolve(),
    openTerminal: () => Promise.resolve(),
    zipPaths: () => Promise.resolve(''),
    quickLook: () => Promise.resolve(),
    search: (q) =>
      Promise.resolve(
        Object.entries(TREE)
          .flatMap(([dir, es]) => fillPath(dir, es))
          .filter((e) => e.name.toLowerCase().includes((q || '').toLowerCase()))
          .map((e) => ({ ...e, dir: e.path.slice(0, e.path.length - e.name.length - 1), btime_ms: e.mtime_ms }))
          .slice(0, 100)
      ),
    fsearchStatus: () => Promise.resolve({ ready: true, entries: 0 }),
    diskSpace: () => Promise.resolve(500e9),
    homeDir: () => Promise.resolve('/Users/demo'),
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
