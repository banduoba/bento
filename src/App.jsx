import { useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { api, hasTauri } from './api'
import { IconCheck } from './icons'
import { basename, parentPath, labelOf, copyText, folderTitle } from './format'
import { dragState } from './nativeDrag'
import { normalizeCols, normalizeVis, COL_LABELS } from './columns'
import Sidebar from './components/Sidebar'
import Pane from './components/Pane'
import StatusBar from './components/StatusBar'
import ContextMenu from './components/ContextMenu'
import BatchRenameDialog from './components/BatchRenameDialog'
import ZipDialog, { normalizeZipPrefs, levelOf } from './components/ZipDialog'
import SettingsDialog from './components/SettingsDialog'
import SearchOverlay from './components/SearchOverlay'
import { IconEye, IconEyeOff, IconSearch, IconChevronDown, IconSettings, IconPin } from './icons'

const MIME = 'application/x-bento'

// 调试埋点：写进 dev 日志（stderr）
const trace = (m) => {
  invoke('append_trace_log', { msg: m }).catch(() => {})
  invoke('log_debug', { msg: m }).catch(() => {})
}

// 输入框文本编辑辅助（无系统编辑菜单时 WKWebView 输入框原生 ⌘C/⌘V 失效）
function applyInputValue(el, value, selStart, selEnd) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  requestAnimationFrame(() => {
    try {
      el.setSelectionRange(selStart, selEnd)
    } catch {}
  })
}

async function handleTextShortcut(e, el) {
  if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return
  const key = e.key.toLowerCase()
  const s = el.selectionStart ?? 0
  const t = el.selectionEnd ?? 0
  const sel = el.value.slice(s, t)
  if (key === 'a') {
    e.preventDefault()
    el.select?.()
    return
  }
  if (key === 'c' || key === 'x') {
    if (!sel) return
    e.preventDefault()
    try {
      await writeText(sel)
    } catch {
      try {
        await navigator.clipboard.writeText(sel)
      } catch {}
    }
    if (key === 'x') applyInputValue(el, el.value.slice(0, s) + el.value.slice(t), s, s)
    return
  }
  if (key === 'v') {
    e.preventDefault()
    try {
      const text = await readText()
      if (text) applyInputValue(el, el.value.slice(0, s) + text + el.value.slice(t), s + text.length, s + text.length)
    } catch {}
  }
}

let tabSeq = 1
const freshId = () => `t${tabSeq++}`
const blankTab = (path) => ({ id: freshId(), path, history: [path], hi: 0, sortKey: 'name', sortDir: 'asc' })
const blankPane = (path) => ({ tabs: [blankTab(path)], active: 0 })
const freshWsId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

// ---------- 布局预设（grid-template-areas 定义） ----------
export const LAYOUT_PRESETS = [
  { id: '1', panes: 1, cols: '1fr', rows: '1fr', areas: '"a"', names: ['全屏'] },
  { id: '2c', panes: 2, cols: '1fr 1fr', rows: '1fr', areas: '"a b"', names: ['左', '右'] },
  { id: '2r', panes: 2, cols: '1fr', rows: '1fr 1fr', areas: '"a" "b"', names: ['上', '下'] },
  { id: '4', panes: 4, cols: '1fr 1fr', rows: '1fr 1fr', areas: '"a b" "c d"', names: ['左上', '右上', '左下', '右下'] },
  { id: '3l1r', panes: 3, cols: '1.4fr 1fr', rows: '1fr 1fr', areas: '"a b" "a c"', names: ['左', '右上', '右下'] },
  { id: '3l2r', panes: 3, cols: '1.4fr 1fr', rows: '1fr 1fr', areas: '"a b" "c b"', names: ['左', '右', '左下'] },
  { id: '3t2b', panes: 3, cols: '1fr 1fr', rows: '1.4fr 1fr', areas: '"a a" "b c"', names: ['上', '左下', '右下'] },
  { id: '3t1b2', panes: 3, cols: '1fr 1fr', rows: '1fr 1.4fr', areas: '"a b" "c c"', names: ['左上', '右上', '下'] },
  { id: '3c', panes: 3, cols: '1fr 1fr 1fr', rows: '1fr', areas: '"a b c"', names: ['左', '中', '右'] },
  { id: '3r', panes: 3, cols: '1fr', rows: '1fr 1fr 1fr', areas: '"a" "b" "c"', names: ['上', '中', '下'] },
]
const AREA_LETTERS = ['a', 'b', 'c', 'd']
const getPreset = (id) => LAYOUT_PRESETS.find((p) => p.id === id) || LAYOUT_PRESETS[1]
const paneCount = (layoutId) => getPreset(layoutId).panes
const paneName = (layoutId, i) => getPreset(layoutId).names?.[i] || `窗格 ${i + 1}`
const normalizeLayout = (l) => {
  if (typeof l === 'string' && LAYOUT_PRESETS.some((p) => p.id === l)) return l
  if (typeof l === 'number') return { 1: '1', 2: '2c', 4: '4' }[l] || '2c'
  return '2c'
}

function sanitizePanes(raw, home) {
  return (Array.isArray(raw) ? raw : []).map((p) => {
    // 兼容 v0.1 老格式（pane 直接带 path，无 tabs）
    const rawTabs = Array.isArray(p?.tabs) && p.tabs.length ? p.tabs : [p?.path != null ? p : { path: home }]
    const tabs = rawTabs.map((t) => {
      const path = typeof t?.path === 'string' && t.path.startsWith('/') ? t.path : home
      const history = Array.isArray(t?.history) && t.history.length ? t.history : [path]
      return {
        id: freshId(),
        path,
        history,
        hi: Math.min(Math.max(t?.hi ?? history.length - 1, 0), history.length - 1),
        sortKey: { date: 'mtime' }[t?.sortKey] || (['name', 'size', 'kind', 'mtime', 'btime'].includes(t?.sortKey) ? t.sortKey : 'name'),
        sortDir: t?.sortDir === 'desc' ? 'desc' : 'asc',
      }
    })
    return {
      tabs,
      active: Math.min(Math.max(p?.active ?? 0, 0), tabs.length - 1),
      // 列设置按窗格各自保存；colsVersion<2 的旧值是旧默认（全显示），丢弃以套用新默认（修改日期/大小/种类）
      colWidths: normalizeCols(p?.colsVersion === 2 ? p.colWidths : null),
      colVisible: normalizeVis(p?.colsVersion === 2 ? p.colVisible : null),
      colsVersion: 2,
    }
  })
}

const defaultConfig = (home) => ({
  layout: 2,
  showHidden: false,
  showSidebar: true,
  autoRefresh: true,
  alwaysOnTop: false,
  zipPrefs: normalizeZipPrefs(null),
  focusedIdx: 0,
  searchPrefs: { scope: 'global', sort: 'btime' },
  searchPaths: [],
  favorites: ['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures'].map((n) => ({
    name: n,
    path: `${home}/${n}`,
  })),
  panes: [blankPane(home), blankPane(home)],
  workspaces: [],
  activeWorkspace: null,
})

function sanitizeConfig(saved, home) {
  const base = defaultConfig(home)
  if (!saved || !Array.isArray(saved.panes) || saved.panes.length === 0) {
    return {
      ...base,
      workspaces: [{ id: 'w-default', name: '默认', panes: base.panes, layout: base.layout, focusedIdx: 0 }],
      activeWorkspace: 'w-default',
    }
  }
  const panes = sanitizePanes(saved.panes, home)
  const layout = normalizeLayout(saved.layout)
  const focusedIdx = Number.isInteger(saved.focusedIdx) ? Math.max(saved.focusedIdx, 0) : 0

  let workspaces
  let activeWorkspace
  if (Array.isArray(saved.workspaces) && saved.workspaces.length) {
    workspaces = saved.workspaces.map((w) => {
      const wsPanes = sanitizePanes(w?.panes, home)
      return {
        id: typeof w?.id === 'string' && w.id ? w.id : freshWsId(),
        name: typeof w?.name === 'string' && w.name ? w.name : '工作区',
        panes: wsPanes.length ? wsPanes : [blankPane(home)],
        layout: normalizeLayout(w?.layout),
        focusedIdx: Math.max(w?.focusedIdx || 0, 0),
      }
    })
    activeWorkspace = workspaces.some((w) => w.id === saved.activeWorkspace)
      ? saved.activeWorkspace
      : workspaces[0].id
  } else {
    workspaces = [{ id: 'w-default', name: '默认', panes, layout, focusedIdx }]
    activeWorkspace = 'w-default'
  }

  return {
    layout,
    showHidden: !!saved.showHidden,
    showSidebar: saved.showSidebar !== false,
    autoRefresh: saved.autoRefresh !== false,
    alwaysOnTop: saved.alwaysOnTop === true,
    zipPrefs: normalizeZipPrefs(saved.zipPrefs),
    focusedIdx,
    searchPrefs: {
      scope: ['pane', 'home', 'global'].includes(saved.searchPrefs?.scope) ? saved.searchPrefs.scope : 'global',
      sort: ['btime', 'mtime', 'size', 'name', 'score'].includes(saved.searchPrefs?.sort) ? saved.searchPrefs.sort : 'btime',
      mode: ['name', 'content'].includes(saved.searchPrefs?.mode) ? saved.searchPrefs.mode : 'name',
    },
    searchPaths: Array.isArray(saved.searchPaths)
      ? saved.searchPaths.filter((p) => typeof p === 'string' && p.startsWith('/'))
      : [],
    favorites: Array.isArray(saved.favorites) ? saved.favorites : base.favorites,
    panes,
    workspaces,
    activeWorkspace,
  }
}

// 保存前把当前实时状态镜像进活动工作区快照
function withActiveSnapshot(c) {
  return {
    ...c,
    workspaces: (c.workspaces || []).map((w) =>
      w.id === c.activeWorkspace
        ? { ...w, panes: c.panes, layout: c.layout, focusedIdx: c.focusedIdx }
        : w
    ),
  }
}

function MiniGrid({ preset }) {
  return (
    <span
      className="mini-grid"
      style={{
        gridTemplateColumns: preset.cols,
        gridTemplateRows: preset.rows,
        gridTemplateAreas: preset.areas,
      }}
    >
      {Array.from({ length: preset.panes }, (_, i) => (
        <span key={i} style={{ gridArea: AREA_LETTERS[i] }} />
      ))}
    </span>
  )
}

export default function App() {
  const [cfg, setCfg] = useState(null)
  const [home, setHome] = useState('/')
  const [focused, setFocused] = useState(0)
  const [sel, setSel] = useState({}) // tabId -> Set(paths)
  const [filters, setFilters] = useState({}) // tabId -> string
  const [clip, setClip] = useState(null) // { mode, paths }
  const [menu, setMenu] = useState(null) // { x, y, items }
  const [renaming, setRenaming] = useState(null) // { tabId, path, value }
  const [batchRename, setBatchRename] = useState(null) // { tabId, items }
  const [zipDlg, setZipDlg] = useState(null) // { id, paths, dir, name } 「创建归档」对话框
  const [searchOpen, setSearchOpen] = useState(false)
  const [pathEditTick, setPathEditTick] = useState(0) // ⌘⇧G 让聚焦窗格进入路径编辑
  const [flashPane, setFlashPane] = useState(-1)
  const [wsRenaming, setWsRenaming] = useState(null) // { id, value }
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [revealReq, setRevealReq] = useState(null) // { tabId, path, nonce } 搜索定位后选中文件
  const [hoverTip, setHoverTip] = useState(null) // { x, y, text } 原生拖拽目标提示
  const [undoToast, setUndoToast] = useState(null) // { label, fn } 可撤销操作提示
  const [rowToast, setRowToast] = useState(null) // { x, y, text, placeLeft } 贴在文件行旁边的提示
  const rowToastTimer = useRef(null)
  const undoStackRef = useRef([]) // { label, undo: () => Promise }
  const flashTimer = useRef(null)

  // 闪烁提示：让用户一眼看到导航发生在哪个窗格
  const triggerFlash = (idx) => {
    clearTimeout(flashTimer.current)
    setFlashPane(-1)
    requestAnimationFrame(() => {
      setFlashPane(idx)
      flashTimer.current = setTimeout(() => setFlashPane(-1), 900)
    })
  }
  const [stats, setStats] = useState({}) // tabId -> { count, selCount, selSize }
  const [tick, setTick] = useState(0)
  const [progress, setProgress] = useState(null)

  const rowsCache = useRef({}) // tabId -> 当前排序后的条目数组
  const modeRef = useRef('copy')
  const progTimer = useRef(null)
  const toastTimer = useRef(null)
  const cfgRef = useRef(null)
  cfgRef.current = cfg
  // 窗口置顶：配置变化（含启动恢复）时同步给原生窗口
  useEffect(() => {
    if (!hasTauri || !cfg) return
    getCurrentWindow().setAlwaysOnTop(!!cfg.alwaysOnTop).catch((e) => trace(`setAlwaysOnTop failed: ${e}`))
  }, [cfg?.alwaysOnTop])

  // ---------- 启动 ----------
  useEffect(() => {
    ;(async () => {
      const h = await api.homeDir()
      setHome(h)
      const saved = await api.loadConfig().catch(() => null)
      const c = sanitizeConfig(saved, h)
      setCfg(c)
      // 恢复上次工作的聚焦窗格（否则每次重启都回到左侧，侧边栏点击就会“没反应”）
      setFocused(Math.min(c.focusedIdx || 0, paneCount(c.layout) - 1))
      trace(`boot: focusedIdx=${c.focusedIdx} layout=${c.layout} panes=${c.panes.length} ws=${c.workspaces.length}`)
    })()
  }, [])

  // ---------- 配置持久化：每次变化立即写盘（去防抖：关窗太快也不会丢状态） ----------
  useEffect(() => {
    if (!cfg) return
    api.saveConfig(withActiveSnapshot(cfg)).catch(() => {})
  }, [cfg])

  // 关窗兜底保存
  useEffect(() => {
    const h = () => {
      if (cfgRef.current) api.saveConfig(withActiveSnapshot(cfgRef.current)).catch(() => {})
    }
    window.addEventListener('beforeunload', h)
    window.addEventListener('pagehide', h)
    return () => {
      window.removeEventListener('beforeunload', h)
      window.removeEventListener('pagehide', h)
    }
  }, [])

  // 聚焦窗格变化时持久化
  useEffect(() => {
    if (!cfg) return
    setCfg((c) => {
      const clamped = Math.min(focused, paneCount(c.layout) - 1)
      if (c.focusedIdx === clamped) return c
      return { ...c, focusedIdx: clamped }
    })
  }, [focused])

  // ---------- 传输进度 ----------
  useEffect(() => {
    if (!hasTauri) return
    const un = listen('transfer-progress', (e) => {
      setProgress({ ...e.payload, mode: modeRef.current })
      clearTimeout(progTimer.current)
      progTimer.current = setTimeout(() => setProgress(null), 1500)
    })
    return () => {
      un.then((f) => f())
    }
  }, [])

  // ---------- 拦截外部文件拖放（WebView 默认行为会导航离开） ----------
  useEffect(() => {
    const stop = (e) => {
      const types = [...(e.dataTransfer?.types || [])]
      if (!types.includes(MIME)) e.preventDefault()
    }
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  const visibleCount = cfg ? paneCount(cfg.layout) : 1
  const focusIdx = cfg ? Math.min(focused, visibleCount - 1) : 0
  const refresh = () => setTick((t) => t + 1)

  // ---------- 窗口拖动（标题栏空白处按下即拖，双击最大化） ----------
  const titlebarMouseDown = (e) => {
    if (e.button !== 0) return
    if (e.target.closest('button, input, .seg')) return
    const win = getCurrentWindow()
    if (e.detail >= 2) win.toggleMaximize().catch(() => {})
    else win.startDragging().catch(() => {})
  }

  // ---------- 配置/标签操作 ----------
  const activeTabOf = (pi) => {
    const p = cfg?.panes[pi]
    if (!p) return null
    return p.tabs[p.active] || p.tabs[0]
  }

  // 聚焦窗格当前路径的文件夹名；切换窗格或导航时更新
  const windowTitle = folderTitle(activeTabOf(focusIdx)?.path, home)
  useEffect(() => {
    if (!hasTauri || !cfg) return
    getCurrentWindow().setTitle(windowTitle).catch((e) => trace(`setTitle failed: ${e}`))
  }, [cfg, windowTitle])

  const updateTab = (tabId, fn) =>
    setCfg((c) => ({
      ...c,
      panes: c.panes.map((p) => {
        const ti = p.tabs.findIndex((t) => t.id === tabId)
        if (ti === -1) return p
        return { ...p, tabs: p.tabs.map((t, k) => (k === ti ? fn(t) : t)) }
      }),
    }))

  const locateTab = (tabId) => {
    for (const p of cfg.panes) {
      const t = p.tabs.find((x) => x.id === tabId)
      if (t) return t
    }
    return null
  }

  const paneIndexOf = (tabId) => cfg.panes.findIndex((p) => p.tabs.some((t) => t.id === tabId))

  const nav = (tabId, path, isRefresh) => {
    if (isRefresh || !path) {
      refresh()
      return
    }
    trace(`nav tab=${tabId} -> ${path}`)
    updateTab(tabId, (t) => {
      if (t.path === path) return t
      const history = [...t.history.slice(0, t.hi + 1), path]
      return { ...t, path, history, hi: history.length - 1 }
    })
    setSel((s) => ({ ...s, [tabId]: new Set() }))
  }

  const navBack = (tabId) => updateTab(tabId, (t) => (t.hi > 0 ? { ...t, hi: t.hi - 1, path: t.history[t.hi - 1] } : t))
  const navForward = (tabId) =>
    updateTab(tabId, (t) => (t.hi < t.history.length - 1 ? { ...t, hi: t.hi + 1, path: t.history[t.hi + 1] } : t))

  const openEntry = (tabId, entry) => {
    if (entry.is_dir) nav(tabId, entry.path)
    else api.openPath(entry.path).catch((e) => alert(`无法打开: ${e}`))
  }

  const newTab = (pi) =>
    setCfg((c) => ({
      ...c,
      panes: c.panes.map((p, i) => {
        if (i !== pi) return p
        const cur = p.tabs[p.active] || p.tabs[0]
        const tabs = [...p.tabs, blankTab(cur.path)]
        return { ...p, tabs, active: tabs.length - 1 }
      }),
    }))

  const switchTab = (pi, ti) =>
    setCfg((c) => ({
      ...c,
      panes: c.panes.map((p, i) => (i === pi ? { ...p, active: ti } : p)),
    }))

  const closeTabOf = (tabId) =>
    setCfg((c) => {
      const pi = c.panes.findIndex((p) => p.tabs.some((t) => t.id === tabId))
      if (pi === -1) return c
      const pane = c.panes[pi]
      const ti = pane.tabs.findIndex((t) => t.id === tabId)
      if (pane.tabs.length > 1) {
        const tabs = pane.tabs.filter((_, k) => k !== ti)
        const active = Math.max(0, Math.min(pane.active > ti ? pane.active - 1 : pane.active, tabs.length - 1))
        return { ...c, panes: c.panes.map((p, i) => (i === pi ? { ...p, tabs, active } : p)) }
      }
      // 该窗格只剩一个标签：多窗格时移除整个窗格
      if (c.panes.length <= 1) return c
      const panes = c.panes.filter((_, i) => i !== pi)
      const layout = panes.length >= 4 ? 4 : panes.length >= 2 ? 2 : 1
      return { ...c, panes, layout }
    })

  const closeOtherTabs = (tabId) =>
    setCfg((c) => ({
      ...c,
      panes: c.panes.map((p) => {
        const keep = p.tabs.find((t) => t.id === tabId)
        if (!keep) return p
        return { ...p, tabs: [keep], active: 0 }
      }),
    }))

  const setLayout = (presetId) => {
    const preset = getPreset(presetId)
    setCfg((c) => {
      const panes = [...c.panes]
      while (panes.length < preset.panes) panes.push(blankPane(panes[0]?.tabs[0]?.path || home))
      return { ...c, layout: presetId, panes }
    })
    setLayoutPickerOpen(false)
  }

  const [layoutPickerOpen, setLayoutPickerOpen] = useState(false)
  const layoutPreset = getPreset(cfg?.layout)

  // 原生拖拽：接收来自其他软件/本应用（搜索结果、文件行）的拖放
  useEffect(() => {
    if (!hasTauri) return
    let highlightedRow = null
    let live = true
    const doneTimers = new Map()
    const paneDestination = (el) => {
      const paneEl = el.closest('.pane')
      if (!paneEl) return null
      const idx = [...document.querySelectorAll('.panes > .pane')].indexOf(paneEl)
      const pane = cfgRef.current?.panes[idx]
      return pane?.tabs[pane.active]?.path
    }
    const transferMode = (dest, paths) => {
      const volOf = (p) => p.match(/^\/Volumes\/[^/]+/)?.[0] || '/'
      return paths.every((p) => volOf(p) === volOf(dest)) ? 'move' : 'copy'
    }
    const flashDone = (row) => {
      if (!live || !row?.isConnected) return
      clearTimeout(doneTimers.get(row))
      row.classList.remove('drop-done')
      // 连续投放到同一行时，重新开始确认动画。
      void row.offsetWidth
      row.classList.add('drop-done')
      doneTimers.set(row, setTimeout(() => {
        row.classList.remove('drop-done')
        doneTimers.delete(row)
      }, 300))
    }
    const dirOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/'
    const descOf = (el) => (el ? `${el.tagName}.${String(el.className).slice(0, 40)}` : 'null')
    // 命中计划：侧边栏书签 / 文件夹行 / 窗格空白（= 当前目录）。
    // 坐标：macOS 上 wry 的 draggingLocation 是窗口内的逻辑点（= CSS px），Tauri 虽把它标成
    // PhysicalPosition，但不会再乘缩放比（实测 ratio=2 时 drop 坐标与鼠标 CSS 位置 1:1，
    // innerWidth=2056 内可达 2056）。所以直接 elementFromPoint，不要再乘/除 devicePixelRatio。
    const planDrop = (position, paths) => {
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null
      const hit = document.elementFromPoint(position.x, position.y)
      if (!hit) return null
      const sb = hit.closest('.sb-item:not(.ws-item)')
      if (sb) {
        const name = sb.querySelector('span')?.textContent || sb.textContent
        return { kind: 'bookmark', el: sb, text: `添加到「${name}」`, hit }
      }
      const paneEl = hit.closest('.panes > .pane')
      if (!paneEl) return null
      const base = paneDestination(paneEl)
      if (!base) return null
      const row = hit.closest('.row[data-dir]')
      const dest = row ? row.dataset.path : base
      const label = row ? row.querySelector('.name')?.textContent || basename(dest) : basename(base) || base
      if (paths?.length) {
        // 不能拖进自己/自己的子目录；全部本来就在目标目录里则无事可做
        if (paths.some((p) => dest === p || dest.startsWith(p + '/'))) return null
        if (paths.every((p) => dirOf(p) === dest)) return null
      }
      const mode = !paths?.length || !dragState.internal ? 'copy' : transferMode(dest, paths)
      const verb = mode === 'move' ? '移动' : '复制'
      return {
        kind: row ? 'folder' : 'pane',
        el: row || paneEl,
        dest,
        mode,
        text: `${verb}到「${label}」`,
        hit,
      }
    }
    const highlightRow = (el, text) => {
      if (el === highlightedRow) return
      highlightedRow?.classList.remove('native-drop-target')
      highlightedRow = el
      highlightedRow?.classList.add('native-drop-target')
      if (el) {
        const rect = el.getBoundingClientRect()
        const isPane = el.classList.contains('pane')
        setHoverTip({
          x: rect.left + rect.width / 2,
          y: isPane ? rect.top + 40 : rect.top - 8,
          text,
        })
      } else {
        setHoverTip(null)
      }
    }
    let dragPaths = []
    let lastDrop = { sig: '', t: 0 }
    const un = getCurrentWindow().onDragDropEvent(async (ev) => {
      if (!live) return
      const { type, position, paths } = ev.payload
      if (type !== 'over') {
        const plan = position ? planDrop(position, paths?.length ? paths : dragPaths) : null
        trace(
          `dde ${type} pos=${position ? `${Math.round(position.x)}x${Math.round(position.y)}` : '-'} ratio=${window.devicePixelRatio} inner=${window.innerWidth}x${window.innerHeight} internal=${dragState.internal} paths=${paths?.length ?? '-'} first=${paths?.[0] ?? '-'} hit=${descOf(plan?.hit)} plan=${plan ? `${plan.kind}:${plan.mode || ''}:${plan.dest || plan.text}` : 'none'}`
        )
      }
      if (type === 'leave' || type === 'cancelled') {
        highlightRow(null)
        return
      }
      if (type === 'enter') dragPaths = paths || []
      if (type === 'enter' || type === 'over') {
        const plan = planDrop(position, dragPaths)
        highlightRow(plan?.el || null, plan?.text)
        return
      }
      if (type !== 'drop') return
      highlightRow(null)
      const dropped = paths?.length ? paths : dragPaths
      dragPaths = []
      if (!dropped.length) return
      // wry 偶尔把同一事件投递两次，2 次 transfer 会产生重复副本
      const sig = `${dropped.join('|')}@${Math.round(position.x)}x${Math.round(position.y)}`
      const now = Date.now()
      if (sig === lastDrop.sig && now - lastDrop.t < 800) return
      lastDrop = { sig, t: now }
      const plan = planDrop(position, dropped)
      if (!plan) return
      // 命中侧边栏条目 → 添加书签
      if (plan.kind === 'bookmark') {
        setCfg((c) => {
          if (c.favorites.some((f) => f.path === dropped[0])) return c
          return { ...c, favorites: [...c.favorites, { name: basename(dropped[0]), path: dropped[0] }] }
        })
        flashDone(plan.el)
        return
      }
      // 命中窗格/文件夹行 → 传入。本应用内拖拽：同卷移动、跨卷复制；外部（Finder/微信）一律复制，不动对方的源文件
      const target = plan.kind === 'folder' ? plan.el : null
      transferInto(plan.dest, dropped, plan.mode, () => {
        if (target?.isConnected) flashDone(target)
      })
    })
    return () => {
      live = false
      highlightRow(null)
      for (const [row, timer] of doneTimers) {
        clearTimeout(timer)
        row.classList.remove('drop-done')
      }
      doneTimers.clear()
      un.then((f) => f()).catch(() => {})
    }
  }, [])

  // 窗口大小/位置变化后防抖保存（配合 window-state 插件，重启原样恢复）
  useEffect(() => {
    if (!hasTauri) return
    const win = getCurrentWindow()
    let t = null
    const save = () => {
      clearTimeout(t)
      t = setTimeout(() => invoke('save_window_state').catch(() => {}), 400)
    }
    const un1 = win.onResized(save)
    const un2 = win.onMoved(save)
    return () => {
      clearTimeout(t)
      un1.then((f) => f()).catch(() => {})
      un2.then((f) => f()).catch(() => {})
    }
  }, [])

  // ---------- 工作区 ----------
  const resetTransientState = () => {
    setSel({})
    setFilters({})
    rowsCache.current = {}
    setRenaming(null)
  }

  // 载入某个工作区快照到实时状态（tab 全部重新分配 id，避免与现存 tab 冲突）
  const loadWorkspaceState = (ws) => {
    const clamped = Math.min(ws.focusedIdx || 0, paneCount(ws.layout) - 1)
    setCfg((c) => ({
      ...c,
      // 离开前把实时状态镜像进原活动工作区
      workspaces: c.workspaces.map((w) =>
        w.id === c.activeWorkspace
          ? { ...w, panes: c.panes, layout: c.layout, focusedIdx: c.focusedIdx }
          : w
      ),
      activeWorkspace: ws.id,
      panes: ws.panes.map((p) => ({ ...p, tabs: p.tabs.map((t) => ({ ...t, id: freshId() })) })),
      layout: ws.layout,
      focusedIdx: clamped,
    }))
    setFocused(clamped)
    resetTransientState()
  }

  const switchWorkspace = (id) => {
    if (!cfg || id === cfg.activeWorkspace) return
    const target = cfg.workspaces.find((w) => w.id === id)
    if (!target) return
    trace(`ws-switch -> ${target.name} (${target.panes.length} panes)`)
    loadWorkspaceState(target)
  }

  const createWorkspace = () => {
    if (!cfg) return
    const cur = cfg.panes[0]?.tabs[0]?.path || home
    const ws = {
      id: freshWsId(),
      name: `工作区 ${cfg.workspaces.length + 1}`,
      panes: [blankPane(cur), blankPane(cur)],
      layout: 2,
      focusedIdx: 0,
    }
    setCfg((c) => ({
      ...c,
      workspaces: [
        ...c.workspaces.map((w) =>
          w.id === c.activeWorkspace
            ? { ...w, panes: c.panes, layout: c.layout, focusedIdx: c.focusedIdx }
            : w
        ),
        ws,
      ],
      activeWorkspace: ws.id,
      panes: ws.panes,
      layout: ws.layout,
      focusedIdx: 0,
    }))
    setFocused(0)
    resetTransientState()
    trace(`ws-create ${ws.name}`)
  }

  const deleteWorkspace = (id) => {
    if (!cfg || cfg.workspaces.length <= 1) return
    if (id === cfg.activeWorkspace) {
      const next = cfg.workspaces.find((w) => w.id !== id)
      loadWorkspaceState(next)
    }
    setCfg((c) => ({ ...c, workspaces: c.workspaces.filter((w) => w.id !== id) }))
    trace(`ws-delete ${id}`)
  }

  const renameWorkspace = (id, name) => {
    const v = (name || '').trim()
    if (!v) return
    setCfg((c) => ({ ...c, workspaces: c.workspaces.map((w) => (w.id === id ? { ...w, name: v } : w)) }))
  }

  const workspaceMenu = (x, y, id, name) =>
    setMenu({
      x,
      y,
      items: [
        { label: '重命名', action: () => setWsRenaming({ id, value: name }) },
        {
          label: '删除',
          danger: true,
          disabled: cfg.workspaces.length <= 1,
          action: () => deleteWorkspace(id),
        },
      ],
    })

  // ---------- 选择 ----------
  const onSelect = (tabId, next) => setSel((s) => ({ ...s, [tabId]: next }))
  const selArr = (tabId) => Array.from(sel[tabId] || [])

  // ---------- 文件操作 ----------
  const reportErrors = (items) => {
    const bad = (items || []).filter((x) => !x.ok)
    if (bad.length) alert(bad.map((b) => `${basename(b.source)}: ${b.error}`).join('\n'))
  }

  // 贴在文件行旁边的提示（取代屏幕底部的提示条）：锚在文件名右侧，放不下就放左侧
  const showRowToast = (paths, text, tries = 0) => {
    const rows = [...document.querySelectorAll('.row[data-path]')]
    const el = paths.map((p) => rows.find((r) => r.dataset.path === p)).find(Boolean)
    if (!el) {
      // 行还没渲染出来（刚拷贝/刷新中）：短暂重试；始终找不到就放在窗口顶部居中
      if (tries < 10) {
        setTimeout(() => showRowToast(paths, text, tries + 1), 100)
        return
      }
      setRowToast({ x: window.innerWidth / 2, y: 90, text, placeLeft: false, center: true })
    } else {
      const anchor = el.querySelector('.name') || el
      const rect = anchor.getBoundingClientRect()
      const rowRect = el.getBoundingClientRect()
      const placeLeft = rect.right + 300 > window.innerWidth
      setRowToast({
        x: placeLeft ? Math.max(rect.left - 10, 12) : rect.right + 10,
        y: rowRect.top + rowRect.height / 2,
        text,
        placeLeft,
      })
    }
    clearTimeout(rowToastTimer.current)
    rowToastTimer.current = setTimeout(() => setRowToast(null), 2200)
  }

  const transferInto = async (dest, paths, mode, onSuccess) => {
    if (!paths?.length) return
    modeRef.current = mode
    try {
      const results = await api.transfer(paths, dest, mode)
      reportErrors(results)
      // 记录成功的操作供 ⌘Z 撤销
      const ok = (results || []).filter((r) => r.ok)
      if (ok.length === paths.length) onSuccess?.()
      if (mode === 'move' && ok.length) {
        const moves = ok
        pushUndo(
          moves.length === 1 ? `移动：${basename(moves[0].dest)}` : `移动 ${moves.length} 个项目`,
          async () => {
            for (const m of moves) {
              await api.transfer([m.dest], m.source.slice(0, m.source.lastIndexOf('/')), 'move')
            }
          }
        )
      }
      if (mode === 'copy' && ok.length) {
        const copies = ok.map((r) => r.dest)
        pushUndo(
          copies.length === 1 ? `拷贝：${basename(copies[0])}` : `拷贝 ${copies.length} 个项目`,
          async () => {
            await api.trash(copies)
          },
          { silent: true }
        )
        // 提示贴在刚拷贝出来的文件旁边（列表刷新后才出现该行，showRowToast 会等待）
        showRowToast(copies, copies.length === 1 ? `已拷贝：${basename(copies[0])}` : `已拷贝 ${copies.length} 个项目`)
      }
    } catch (e) {
      alert(`操作失败: ${e}`)
    }
    if (mode === 'move') setClip(null)
    refresh()
  }

  // 统一记录可撤销操作并提示（4 秒）
  const pushUndo = (label, undo, opts = {}) => {
    undoStackRef.current.push({ label, undo })
    if (undoStackRef.current.length > 30) undoStackRef.current.shift()
    if (opts.silent) return
    setUndoToast({ label })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setUndoToast(null), 4000)
  }

  // ⌘Z：撤销最近一次移动
  const undoLast = async () => {
    const op = undoStackRef.current.pop()
    if (!op) return
    try {
      await op.undo()
      setUndoToast({ label: op.label, undone: true })
      setTimeout(() => setUndoToast(null), 2500)
      refresh()
    } catch (e) {
      alert(`撤销失败: ${e}`)
      refresh()
    }
  }

  const doTrash = (tabId, paths) => {
    const list = paths?.length ? paths : selArr(tabId)
    if (!list.length) return
    api
      .trash(list)
      .then((entries) => {
        if (entries?.length) {
          pushUndo(
            entries.length === 1
              ? `废纸篓：${basename(entries[0].original)}`
              : `废纸篓 ${entries.length} 个项目`,
            async () => {
              for (const e of entries) {
                await api.transfer([e.trashed], e.original.slice(0, e.original.lastIndexOf('/')), 'move')
              }
            }
          )
        }
      })
      .catch((e) => alert(String(e)))
      .finally(() => {
        setSel((s) => ({ ...s, [tabId]: new Set() }))
        refresh()
      })
  }

  // 描述一组条目：单个 →「文件「a.txt」/文件夹「b」」，多个 →「N 个项目（x 个文件、y 个文件夹）」
  const describeItems = (tabId, paths) => {
    const byPath = new Map((rowsCache.current[tabId] || []).map((r) => [r.path, r]))
    const dirs = paths.filter((p) => byPath.get(p)?.is_dir).length
    const files = paths.length - dirs
    if (paths.length === 1) return `${dirs ? '文件夹' : '文件'}「${basename(paths[0])}」`
    const parts = [files && `${files} 个文件`, dirs && `${dirs} 个文件夹`].filter(Boolean)
    return `${paths.length} 个项目（${parts.join('、')}）`
  }

  const doCopyCut = (tabId, mode) => {
    const paths = selArr(tabId)
    if (paths.length) {
      setClip({ mode, paths })
      // 提示贴在被复制的文件旁边，而不是屏幕底部
      showRowToast(paths, `${mode === 'copy' ? '已复制' : '已剪切'}${describeItems(tabId, paths)}`)
      // 文件引用写进系统剪贴板：其他软件 ⌘V 可直接粘贴文件本体
      if (mode === 'copy') {
        api
          .copyFilesToClipboard(paths)
          .then(() => trace(`clipboard ok ${paths.length} paths`))
          .catch((e) => trace(`clipboard FAILED ${e}`))
      }
    }
  }

  const doPaste = (tabId) => {
    if (!clip) return
    const dest = locateTab(tabId)?.path
    if (dest) transferInto(dest, clip.paths, clip.mode)
  }

  // 收藏常用目录（书签）：去重
  const addFavorite = (path) => {
    if (!path) return
    setCfg((c) => {
      if (c.favorites.some((f) => f.path === path)) return c
      return { ...c, favorites: [...c.favorites, { name: basename(path), path }] }
    })
  }

  // ---------- 压缩（QSpace 风格「创建归档」）----------
  const runZip = (paths, dir, o) => {
    clearTimeout(rowToastTimer.current)
    setRowToast({ x: window.innerWidth / 2, y: 90, text: '正在压缩…', center: true })
    api
      .zipPaths(paths, dir, {
        name: o.name,
        level: o.level,
        password: o.password || undefined,
        separate: o.separate,
      })
      .then((created) => {
        refresh()
        if (!created?.length) {
          setRowToast(null)
          return
        }
        pushUndo(
          created.length === 1 ? `压缩：${basename(created[0])}` : `压缩 ${created.length} 个`,
          async () => {
            await api.trash(created)
          },
          { silent: true }
        )
        showRowToast(created, created.length === 1 ? `已压缩：${basename(created[0])}` : `已压缩为 ${created.length} 个文件`)
      })
      .catch((e) => {
        setRowToast(null)
        alert(String(e))
      })
  }
  // 默认文件名：单个项目 = 该项目名.zip；多个项目 = 当前文件夹名.zip
  const zipDefaultName = (paths, dir) =>
    paths.length === 1 ? `${basename(paths[0])}.zip` : `${basename(dir) || '归档'}.zip`
  const zipMenuItems = (paths, dir, entry) => {
    const p = normalizeZipPrefs(cfg.zipPrefs)
    const name = zipDefaultName(paths, dir)
    const openDlg = () => setZipDlg({ id: Date.now(), paths, dir, name })
    const what = paths.length > 1 ? `${paths.length} 项` : `「${entry.name}」`
    if (!p.oneClick) return [{ label: `压缩${what}…`, action: openDlg }]
    return [
      {
        label: `压缩${what}`,
        action: () =>
          runZip(paths, dir, { name, level: levelOf(p), password: p.password, separate: p.separate && paths.length > 1 }),
      },
      { label: '压缩选项…', action: openDlg },
    ]
  }

  const doDuplicate = (tabId, paths) => {
    const list = paths?.length ? paths : selArr(tabId)
    const dest = locateTab(tabId)?.path
    if (list.length && dest) transferInto(dest, list, 'copy')
  }

  const newFolder = (tabId) => {
    const dest = locateTab(tabId)?.path
    if (!dest) return
    api
      .makeDir(dest)
      .then((created) => {
        refresh()
        setSel((s) => ({ ...s, [tabId]: new Set([created]) }))
        setRenaming({ tabId, path: created, value: basename(created), selectAll: true })
        pushUndo(`新建文件夹：${basename(created)}`, async () => {
          await api.trash([created])
        })
      })
      .catch((e) => alert(String(e)))
  }

  const newFile = (tabId) => {
    const dest = locateTab(tabId)?.path
    if (!dest) return
    api
      .makeFile(dest)
      .then((created) => {
        refresh()
        setSel((s) => ({ ...s, [tabId]: new Set([created]) }))
        setRenaming({ tabId, path: created, value: basename(created), selectAll: true })
        pushUndo(`新建文件：${basename(created)}`, async () => {
          await api.trash([created])
        })
      })
      .catch((e) => alert(String(e)))
  }

  const openSearchResult = (item) => {
    const tab = activeTabOf(focusIdx) || cfg?.panes[0]?.tabs[0]
    if (item.is_dir && tab) {
      nav(tab.id, item.path)
      setFocused(focusIdx)
    } else {
      api.openPath(item.path).catch((e) => alert(`无法打开: ${e}`))
    }
  }

  const startRename = (tabId, path, name) => setRenaming({ tabId, path, value: name })

  // 多选批量重命名：按当前列表排序取条目
  const openBatchRename = (tabId, paths) => {
    const inSel = new Set(paths)
    const items = (rowsCache.current[tabId] || []).filter((r) => inSel.has(r.path))
    if (items.length > 1) setBatchRename({ tabId, items })
  }

  const commitRename = () => {
    if (!renaming) return
    const { tabId, path, value } = renaming
    setRenaming(null)
    const current = basename(path)
    if (!value || value.trim() === current) return
    api
      .rename(path, value)
      .then((newPath) => {
        pushUndo(`重命名：${current} → ${value}`, async () => {
          await api.rename(newPath, current)
        })
      })
      .catch((e) => alert(String(e)))
      .finally(() => {
        setSel((s) => ({ ...s, [tabId]: new Set() }))
        refresh()
      })
  }

  // ---------- 右键菜单 ----------
  const fileMenu = (tabId, entry, x, y) => {
    const paths = sel[tabId]?.has(entry.path) && sel[tabId].size > 1 ? selArr(tabId) : [entry.path]
    const pi = paneIndexOf(tabId)
    const parentDir = parentPath(entry.path)
    const termDir = entry.is_dir ? entry.path : parentDir
    // 文件夹可打开到除当前窗格外的所有窗格（按位置命名）
    const paneOpenItems = entry.is_dir
      ? cfg.panes
          .slice(0, visibleCount)
          .map((p, j) => ({ p, j }))
          .filter(({ j }) => j !== pi)
          .map(({ p, j }) => {
            const t = p.tabs[p.active] || p.tabs[0]
            return t
              ? {
                  label: `在${paneName(cfg.layout, j)}窗格打开`,
                  action: () => {
                    nav(t.id, entry.path)
                    setFocused(j)
                    triggerFlash(j)
                  },
                }
              : null
          })
          .filter(Boolean)
      : []
    const items = [
      { label: '打开', action: () => openEntry(tabId, entry) },
      ...paneOpenItems,
      paneOpenItems.length ? { sep: true } : null,
      { label: '拷贝', shortcut: '⌘C', action: () => doCopyCut(tabId, 'copy') },
      { label: '剪切', shortcut: '⌘X', action: () => doCopyCut(tabId, 'move') },
      { sep: true },
      {
        label: paths.length > 1 ? `重新命名 ${paths.length} 个项目…` : '重新命名',
        shortcut: '↩',
        action: () =>
          paths.length > 1
            ? openBatchRename(tabId, paths)
            : startRename(tabId, entry.path, entry.name),
      },
      { label: '拷贝副本', shortcut: '⌘D', action: () => doDuplicate(tabId, paths) },
      ...zipMenuItems(paths, parentDir, entry),
      { label: '移到废纸篓', danger: true, shortcut: '⌘⌫', action: () => doTrash(tabId, paths) },
      { sep: true },
      {
        label: entry.is_dir ? '添加到书签' : '将所在文件夹添加到书签',
        action: () => addFavorite(entry.is_dir ? entry.path : parentDir),
      },
      { label: '在终端打开', action: () => termDir && api.openTerminal(termDir).catch((e) => alert(String(e))) },
      { label: '拷贝路径', action: () => copyText(paths.join('\n')) },
      { label: '在访达中显示', action: () => api.reveal(entry.path).catch(() => {}) },
    ].filter(Boolean)
    setMenu({ x, y, items })
  }

  // 每个窗格各自的列设置（宽度 / 显示哪些列）
  const patchPane = (i, patch) =>
    setCfg((c) => ({ ...c, panes: c.panes.map((pp, j) => (j === i ? { ...pp, ...patch, colsVersion: 2 } : pp)) }))
  const colMenu = (i, x, y) => {
    const vis = normalizeVis(cfg.panes[i]?.colVisible)
    setMenu({
      x,
      y,
      items: [
        ...COL_LABELS.map(([key, label]) => ({
          label,
          checked: !!vis[key],
          action: () => patchPane(i, { colVisible: { ...vis, [key]: !vis[key] } }),
        })),
        { sep: true },
        {
          label: '恢复到默认',
          action: () => patchPane(i, { colWidths: normalizeCols(null), colVisible: normalizeVis(null) }),
        },
      ],
    })
  }

  const blankMenu = (tabId, x, y) =>
    setMenu({
      x,
      y,
      items: [
        { label: '新建文件夹', shortcut: '⇧⌘N', action: () => newFolder(tabId) },
        { label: '新建文本文档', action: () => newFile(tabId) },
        {
          label: '将当前文件夹添加到书签',
          action: () => addFavorite(locateTab(tabId)?.path),
        },
        { label: '粘贴项目', shortcut: '⌘V', disabled: !clip, action: () => doPaste(tabId) },
        { sep: true },
        {
          label: cfg.showHidden ? '隐藏隐藏文件' : '显示隐藏文件',
          shortcut: '⇧⌘.',
          action: () => setCfg((c) => ({ ...c, showHidden: !c.showHidden })),
        },
        { label: '刷新', shortcut: '⌘R', action: refresh },
        { sep: true },
        { label: '在访达中显示', action: () => api.reveal(locateTab(tabId)?.path || '/').catch(() => {}) },
      ],
    })

  const tabMenu = (tabId, x, y) =>
    setMenu({
      x,
      y,
      items: [
        { label: '新建标签', shortcut: '⌘T', action: () => newTab(paneIndexOf(tabId)) },
        { label: '关闭标签', shortcut: '⌘W', action: () => closeTabOf(tabId) },
        { label: '关闭其他标签', action: () => closeOtherTabs(tabId) },
      ],
    })

  const sidebarMenu = (x, y, label, path, removable) =>
    setMenu({
      x,
      y,
      items: [
        ...cfg.panes.slice(0, visibleCount).map((p, i) => ({
          label: `在${paneName(cfg.layout, i)}窗格打开`,
          action: () => {
            const t = p.tabs[p.active] || p.tabs[0]
            if (!t) return
            setFocused(i)
            nav(t.id, path)
            triggerFlash(i)
          },
        })),
        { sep: true },
        removable && {
          label: '移除收藏',
          danger: true,
          action: () => setCfg((c) => ({ ...c, favorites: c.favorites.filter((f) => f.path !== path) })),
        },
        { label: '在访达中显示', action: () => api.reveal(path).catch(() => {}) },
      ].filter(Boolean),
    })

  const pinFavorite = (e) => {
    try {
      const { paths } = JSON.parse(e.dataTransfer.getData(MIME))
      const p = paths?.[0]
      if (!p) return
      setCfg((c) => {
        if (c.favorites.some((f) => f.path === p)) return c
        return { ...c, favorites: [...c.favorites, { name: basename(p), path: p }] }
      })
    } catch {}
  }

  // ---------- 全局快捷键 ----------
  const keyRef = useRef(null)
  keyRef.current = (e) => {
    // ⌘,：输入框聚焦时也可打开设置
    if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.key === ',') {
      e.preventDefault()
      setSearchOpen(false)
      setMenu(null)
      setLayoutPickerOpen(false)
      setSettingsOpen(true)
      return
    }
    // ⌘Z：撤销最近一次移动
    if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      undoLast()
      return
    }
    // ⌘K：打开/聚焦搜索面板（浏览器习惯）
    if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      setSearchOpen(true)
      return
    }
    // ⌘L / ⌘⇧G：即使焦点在输入框里也能跳到地址栏编辑（浏览器习惯）
    if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault()
      setPathEditTick((t) => t + 1)
      return
    }
    if (e.metaKey && !e.altKey && !e.ctrlKey && e.shiftKey && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault()
      setPathEditTick((t) => t + 1)
      return
    }
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      handleTextShortcut(e, document.activeElement)
      return
    }
    const meta = e.metaKey
    const tab = activeTabOf(focusIdx)
    if (!tab) return
    const tid = tab.id
    const paths = selArr(tid)
    const paneRows = rowsCache.current[tid] || []
    const firstEntry = () => paneRows.find((x) => x.path === paths[0])

    if (!searchOpen && !settingsOpen && !batchRename && !menu && !e.altKey && !e.ctrlKey && !e.shiftKey) {
      if (!meta && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        const rows = paneRows.filter((r) => !r.isPseudo)
        if (!rows.length) return
        const current = rows.findIndex((r) => r.path === paths[0])
        const down = e.key === 'ArrowDown'
        const next = current === -1
          ? (down ? 0 : rows.length - 1)
          : Math.max(0, Math.min(rows.length - 1, current + (down ? 1 : -1)))
        const path = rows[next].path
        onSelect(tid, new Set([path]))
        requestAnimationFrame(() => {
          const pane = document.querySelectorAll('.panes > .pane')[focusIdx]
          const row = pane?.querySelector('.row.selected')
          if (row) row.scrollIntoView({ block: 'nearest' })
          else {
            const scroller = pane?.querySelector('.rows')
            if (scroller) setRevealReq({ tabId: tid, path, nonce: Date.now(), scrollTop: scroller.scrollTop })
          }
        })
        return
      }
      if ((!meta && e.key === 'ArrowRight') || (meta && e.key === 'ArrowDown')) {
        e.preventDefault()
        const entry = firstEntry()
        if (entry?.is_dir && !entry.isPseudo) openEntry(tid, entry)
        return
      }
      if ((!meta && e.key === 'ArrowLeft') || (meta && e.key === 'ArrowUp')) {
        e.preventDefault()
        nav(tid, parentPath(tab.path))
        return
      }
    }

    if (meta && !e.shiftKey && e.key === 'c') { e.preventDefault(); doCopyCut(tid, 'copy'); return }
    if (meta && !e.shiftKey && e.key === 'x') { e.preventDefault(); doCopyCut(tid, 'move'); return }
    if (meta && !e.shiftKey && e.key === 'v') { e.preventDefault(); doPaste(tid); return }
    if (meta && !e.shiftKey && e.key === 'a') {
      e.preventDefault()
      onSelect(tid, new Set(paneRows.map((r) => r.path)))
      return
    }
    if (meta && !e.shiftKey && e.key === 'd') { e.preventDefault(); doDuplicate(tid); return }
    if (meta && e.key === 'Backspace') { e.preventDefault(); doTrash(tid); return }
    if (meta && !e.shiftKey && e.key === 't') { e.preventDefault(); newTab(focusIdx); return }
    if (meta && !e.shiftKey && e.key === 'w') { e.preventDefault(); closeTabOf(tid); return }
    if (meta && e.shiftKey && (e.key === 'N' || e.key === 'n')) { e.preventDefault(); newFolder(tid); return }
    if (meta && e.shiftKey && e.key === '.') {
      e.preventDefault()
      setCfg((c) => ({ ...c, showHidden: !c.showHidden }))
      return
    }
    if (meta && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); refresh(); return }
    if (meta && e.altKey && e.code === 'KeyT') {
      // ⌥⌘T：窗口置顶（macOS 上 ⌥T 的 key 是 †，所以用 code）
      e.preventDefault()
      setCfg((c) => ({ ...c, alwaysOnTop: !c.alwaysOnTop }))
      return
    }
    if (meta && (e.key === 'f' || e.key === 'F') && e.altKey) {
      e.preventDefault()
      setSearchOpen(true)
      return
    }
    if (meta && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault()
      document.querySelector(`.panes .pane:nth-child(${focusIdx + 1}) .filterbox input`)?.focus()
      return
    }
    if (meta && e.shiftKey && (e.key === 'G' || e.key === 'g')) {
      e.preventDefault()
      setPathEditTick((t) => t + 1)
      return
    }
    if (meta && e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      setCfg((c) => ({ ...c, showSidebar: !c.showSidebar }))
      return
    }
    if (e.key === ' ' && paths.length >= 1) {
      e.preventDefault()
      const entry = firstEntry()
      if (entry && !entry.is_dir) api.quickLook(entry.path).catch(() => {})
      return
    }
    if (meta && e.key === '[') { e.preventDefault(); navBack(tid); return }
    if (meta && e.key === ']') { e.preventDefault(); navForward(tid); return }
    if (meta && (e.key === '1' || e.key === '2' || e.key === '4')) {
      e.preventDefault()
      setLayout({ 1: '1', 2: '2c', 4: '4' }[e.key])
      return
    }
    if (meta && e.key === 'o') {
      e.preventDefault()
      const entry = firstEntry()
      if (entry) openEntry(tid, entry)
      return
    }
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault()
      const pane = cfg.panes[focusIdx]
      const n = pane.tabs.length
      switchTab(focusIdx, (pane.active + (e.shiftKey ? n - 1 : 1)) % n)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (paths.length > 1) {
        openBatchRename(tid, paths)
      } else if (paths.length === 1) {
        const path = paths[0]
        if (paneRows.some((r) => r.path === path)) startRename(tid, path, basename(path))
      }
      return
    }
    if (e.key === 'F2' && paths.length === 1) {
      e.preventDefault()
      startRename(tid, paths[0], basename(paths[0]))
      return
    }
    if (e.key === 'Backspace') { e.preventDefault(); nav(tid, parentPath(tab.path)); return }
    if (e.key === 'Escape') { onSelect(tid, new Set()); return }
  }

  useEffect(() => {
    const h = (e) => keyRef.current?.(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const cutSet = useMemo(() => new Set(clip?.mode === 'move' ? clip.paths : []), [clip])

  if (!cfg) return <div className="boot">Bento 启动中…</div>

  const focusedTab = activeTabOf(focusIdx)

  return (
    <div className="app">
      <div className="titlebar" onMouseDown={titlebarMouseDown}>
        <div className="tb-title" title={windowTitle}>{windowTitle}</div>
        <div className="tb-center">
          <div className="layout-pick-wrap">
            <button className="layout-btn" title="窗口布局" onClick={() => setLayoutPickerOpen((o) => !o)}>
              <MiniGrid preset={layoutPreset} />
              <IconChevronDown size={13} />
            </button>
            {layoutPickerOpen && (
              <>
                <div className="popover-backdrop" onMouseDown={() => setLayoutPickerOpen(false)} />
                <div className="layout-popover">
                  {LAYOUT_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      className={`lp-item${cfg.layout === p.id ? ' on' : ''}`}
                      title={`${p.panes} 窗格`}
                      onClick={() => setLayout(p.id)}
                    >
                      <MiniGrid preset={p} />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="tb-right">
          <button
            className={`iconbtn${cfg.alwaysOnTop ? ' on' : ''}`}
            title={cfg.alwaysOnTop ? '取消窗口置顶 (⌥⌘T)' : '窗口置顶 (⌥⌘T)'}
            aria-pressed={!!cfg.alwaysOnTop}
            onClick={() => setCfg((c) => ({ ...c, alwaysOnTop: !c.alwaysOnTop }))}
          >
            <IconPin size={15} filled={!!cfg.alwaysOnTop} />
          </button>
          <button
            className="iconbtn"
            title="聚焦搜索 (⌥⌘F)"
            onClick={() => setSearchOpen(true)}
          >
            <IconSearch size={15} />
          </button>
          <button
            className="iconbtn"
            title={cfg.showHidden ? '隐藏隐藏文件 (⇧⌘.)' : '显示隐藏文件 (⇧⌘.)'}
            onClick={() => setCfg((c) => ({ ...c, showHidden: !c.showHidden }))}
          >
            {cfg.showHidden ? <IconEye size={15} /> : <IconEyeOff size={15} />}
          </button>
          <button
            className="iconbtn"
            title="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <IconSettings size={15} />
          </button>
        </div>
      </div>

      <div className="main">
        {cfg.showSidebar && (
          <Sidebar
            home={home}
            favorites={cfg.favorites}
            focusedPath={focusedTab?.path}
            tick={tick}
            workspaces={cfg.workspaces}
            activeWorkspace={cfg.activeWorkspace}
            wsRenaming={wsRenaming}
            onSwitchWorkspace={switchWorkspace}
            onCreateWorkspace={createWorkspace}
            onWorkspaceMenu={workspaceMenu}
            onWsRenameChange={(v) => setWsRenaming((r) => (r ? { ...r, value: v } : r))}
            onWsRenameCommit={() => {
              if (wsRenaming) renameWorkspace(wsRenaming.id, wsRenaming.value)
              setWsRenaming(null)
            }}
            onWsRenameCancel={() => setWsRenaming(null)}
            onOpen={(path) => {
              // 聚焦窗格的当前标签；异常时回退到第一个窗格第一个标签
              const t = activeTabOf(focusIdx) || cfg.panes[0]?.tabs[0]
              if (!t) return
              trace(
                `sb-open focusIdx=${focusIdx} tab=${t.id} -> ${path} | actives=[${cfg.panes
                  .map((p) => p.tabs[p.active]?.path || '?')
                  .join(' | ')}]`
              )
              setFocused(focusIdx)
              nav(t.id, path)
              triggerFlash(focusIdx)
            }}
            onMenu={sidebarMenu}
            onDropPin={pinFavorite}
          />
        )}
        <div
          className="panes"
          style={{
            gridTemplateColumns: layoutPreset.cols,
            gridTemplateRows: layoutPreset.rows,
            gridTemplateAreas: layoutPreset.areas,
          }}
        >
          {cfg.panes.slice(0, visibleCount).map((p, i) => (
            <Pane
              key={i}
              index={i}
              area={AREA_LETTERS[i]}
              pane={p}
              home={home}
              cfg={cfg}
              focused={i === focusIdx}
              selection={sel[p.tabs[p.active]?.id] || new Set()}
              filter={filters[p.tabs[p.active]?.id] || ''}
              renaming={renaming}
              tick={tick}
              onColWidths={(w) => patchPane(i, { colWidths: normalizeCols(w) })}
              onColMenu={(x, y) => colMenu(i, x, y)}
              cutSet={cutSet}
              editPathSignal={i === focusIdx ? pathEditTick : 0}
              flash={i === flashPane}
              reveal={revealReq && revealReq.tabId === p.tabs[p.active]?.id ? revealReq : null}
              onRevealDone={() => {
                // 虚拟行先由 Pane 挂载，再从原滚动位置按 nearest 对齐。
                if (revealReq?.scrollTop != null) {
                  const scrollTop = revealReq.scrollTop
                  requestAnimationFrame(() => {
                    const scroller = document.querySelectorAll('.panes > .pane')[i]?.querySelector('.rows')
                    const row = scroller?.querySelector('.row.selected')
                    if (row) {
                      scroller.scrollTop = scrollTop
                      row.scrollIntoView({ block: 'nearest' })
                    }
                  })
                }
                setRevealReq(null)
              }}
              onFocus={setFocused}
              onNav={nav}
              onBack={navBack}
              onForward={navForward}
              onOpen={openEntry}
              onSelect={onSelect}
              onMenu={fileMenu}
              onBlankMenu={blankMenu}
              onTabMenu={tabMenu}
              onNewTab={newTab}
              onCloseTab={closeTabOf}
              onSwitchTab={switchTab}
              onDropTransfer={transferInto}
              onFilter={(tid, v) => setFilters((f) => ({ ...f, [tid]: v }))}
              onSort={(tid, key, dir) =>
                updateTab(tid, (t) => ({ ...t, sortKey: key, sortDir: dir }))
              }
              onStats={(tid, st) => setStats((s) => ({ ...s, [tid]: st }))}
              onRowsCache={(tid, rows) => {
                rowsCache.current[tid] = rows
              }}
              onRenameChange={(v) => setRenaming((r) => (r ? { ...r, value: v } : r))}
              onRenameCommit={commitRename}
              onRenameCancel={() => setRenaming(null)}
            />
          ))}
        </div>
      </div>

      <StatusBar path={focusedTab?.path || '/'} stats={stats[focusedTab?.id]} progress={progress} />
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {hoverTip && (
        <div className="drag-tip" style={{ left: hoverTip.x, top: hoverTip.y }}>
          {hoverTip.text}
        </div>
      )}
      {rowToast && (
        <div
          className={`copy-toast row-toast${rowToast.placeLeft ? ' place-left' : ''}${rowToast.center ? ' center' : ''}`}
          style={{ left: rowToast.x, top: rowToast.y }}
        >
          <IconCheck size={13} />
          <span className="copy-toast-text">{rowToast.text}</span>
        </div>
      )}
      {undoToast && (
        <div className="undo-toast">
          <span>
            {undoToast.undone && '已撤销：'}
            <b>{undoToast.label}</b>
          </span>
          {!undoToast.undone && (
            <button
              className="undo-btn"
              onClick={() => {
                setUndoToast(null)
                undoLast()
              }}
            >
              撤销
            </button>
          )}
        </div>
      )}
      <SearchOverlay
        open={searchOpen}
        root={focusedTab?.path || home}
        showHidden={cfg.showHidden}
          scope={cfg.searchPrefs?.scope || 'global'}
          sortBy={cfg.searchPrefs?.sort || 'btime'}
          mode={cfg.searchPrefs?.mode || 'name'}
          onModeChange={(v) => setCfg((c) => ({ ...c, searchPrefs: { ...c.searchPrefs, mode: v } }))}
          searchPaths={cfg.searchPaths || []}
          onScopeChange={(v) => setCfg((c) => ({ ...c, searchPrefs: { ...c.searchPrefs, scope: v } }))}
          onSortChange={(v) => setCfg((c) => ({ ...c, searchPrefs: { ...c.searchPrefs, sort: v } }))}
          onClose={() => setSearchOpen(false)}
        onOpenEntry={openSearchResult}
        onLocate={(dir, file) => {
          const t = activeTabOf(focusIdx) || cfg.panes[0]?.tabs[0]
          if (!t) return
          setFocused(focusIdx)
          nav(t.id, dir)
          if (file) {
            setRevealReq({ tabId: t.id, path: file, nonce: Date.now() })
          } else {
            setRevealReq(null)
          }
        }}
        onReveal={(p) => api.reveal(p).catch(() => {})}
      />
      <SettingsDialog
        open={settingsOpen}
        searchPaths={cfg.searchPaths}
        onChange={(paths) => setCfg((c) => ({ ...c, searchPaths: paths }))}
        showHidden={cfg.showHidden}
        onShowHiddenChange={(showHidden) => setCfg((c) => ({ ...c, showHidden }))}
        autoRefresh={cfg.autoRefresh !== false}
        onAutoRefreshChange={(autoRefresh) => {
          setCfg((c) => ({ ...c, autoRefresh }))
          if (autoRefresh) refresh() // 重新打开时立刻同步一次关闭期间错过的变化
        }}
        layout={normalizeLayout(cfg.layout)}
        onLayoutChange={setLayout}
        onClose={() => setSettingsOpen(false)}
      />
      {zipDlg && (
        <ZipDialog
          key={zipDlg.id}
          count={zipDlg.paths.length}
          dir={zipDlg.dir}
          defaultName={zipDlg.name}
          prefs={normalizeZipPrefs(cfg.zipPrefs)}
          onCancel={() => setZipDlg(null)}
          onSubmit={(o, saved) => {
            const d = zipDlg
            setZipDlg(null)
            setCfg((c) => ({ ...c, zipPrefs: saved })) // 记住上次的压缩设置
            runZip(d.paths, o.dir, o)
          }}
        />
      )}
      {batchRename && (
        <BatchRenameDialog
          items={batchRename.items}
          onCancel={() => setBatchRename(null)}
          onApply={(errors) => {
            const tid = batchRename.tabId
            setBatchRename(null)
            setSel((s) => ({ ...s, [tid]: new Set() }))
            refresh()
            if (errors.length) alert(`部分重命名失败：\n${errors.join('\n')}`)
          }}
        />
      )}
    </div>
  )
}
