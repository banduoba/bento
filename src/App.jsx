import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { confirm } from '@tauri-apps/plugin-dialog'
import { blankTab, blankPane, freshId, navigateTab, restoreSession, sessionForDisk, preferencesForDisk } from './session'
import { createSerialSaver } from './persistence'
import { createSessionClose } from './sessionClose'
import { createTextEditing, isTextEditingElement } from './textEditing'
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { api, hasTauri } from './api'
import { bumpManualRefreshTick, directoryKey, invalidateDirectories, rootRefreshKey } from './paneFeedback'
import { createQuickLookNavigation } from './quickLookNavigation'
import { clearCut, getClip, reserveCut, releaseCut, setClip, subscribeClip } from './clipboard'
import { basename, parentPath, labelOf, copyText, folderTitle } from './format'
import { dragState } from './nativeDrag'
import { normalizeCols, normalizeVis, COL_LABELS } from './columns'
import {
  applyToAllFolders,
  canonicalPathKey,
  clearFolderOverride,
  hasFolderOverride,
  normalizeViewSettings,
  rekeyOverride,
  resolveViewKey,
  seedViewSettings,
  syncPaneViews,
  viewForPath,
  withFolderPatch,
} from './viewSettings'
import Sidebar from './components/Sidebar'
import Pane from './components/Pane'
import StatusBar from './components/StatusBar'
import { createOperationClient } from './operations/client'
import { createOperationEffects } from './operations/effects'
import { operationId } from './operations/store'
import ContextMenu from './components/ContextMenu'
import BatchRenameDialog from './components/BatchRenameDialog'
import ZipDialog, { normalizeZipPrefs, levelOf } from './components/ZipDialog'
import SettingsDialog from './components/SettingsDialog'
import SearchOverlay from './components/SearchOverlay'
import { IconEye, IconEyeOff, IconSearch, IconChevronDown, IconSettings, IconPin } from './icons'
import {
  listIndexAfterKey,
  normalizeEnterAction,
  otherPaneIndex,
  pageStride,
  paneIndexAfterKey,
  resolveListKey,
  resolvePaneKey,
} from './shortcuts'

const OperationQueue = lazy(() => import('./components/OperationQueue'))
const OperationConflict = lazy(() => import('./components/OperationConflict'))

const MIME = 'application/x-bento'
// 没有选中项时各窗格共用同一只空 Set。每次渲染 new Set() 会让统计 effect 的依赖一直变，
// 分批加载时每一批都会把更新深度打满。
const EMPTY_SELECTION = new Set()

// 调试埋点：写进 dev 日志（stderr）
const trace = (m) => {
  invoke('append_trace_log', { msg: m }).catch(() => {})
  invoke('log_debug', { msg: m }).catch(() => {})
}

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
const normalizeLayout = l => {
  if (typeof l === 'string' && LAYOUT_PRESETS.some(p => p.id === l)) return l
  return typeof l === 'number' ? ({ 1: '1', 2: '2c', 4: '4' }[l] || '2c') : '2c'
}

const defaultFavorites = home => ['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures'].map(name => ({
  name,
  path: `${home}/${name}`,
}))

function sanitizeConfig(saved, home) {
  saved = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  return {
    showHidden: !!saved.showHidden,
    showSidebar: saved.showSidebar !== false,
    autoRefresh: saved.autoRefresh !== false,
    alwaysOnTop: saved.alwaysOnTop === true,
    enterAction: normalizeEnterAction(saved.enterAction),
    zipPrefs: normalizeZipPrefs(saved.zipPrefs),
    searchPrefs: {
      scope: ['pane', 'home', 'global'].includes(saved.searchPrefs?.scope) ? saved.searchPrefs.scope : 'global',
      sort: ['btime', 'mtime', 'size', 'name', 'score'].includes(saved.searchPrefs?.sort) ? saved.searchPrefs.sort : 'btime',
      mode: ['name', 'content'].includes(saved.searchPrefs?.mode) ? saved.searchPrefs.mode : 'name',
    },
    searchPaths: Array.isArray(saved.searchPaths)
      ? saved.searchPaths.filter((p) => typeof p === 'string' && p.startsWith('/'))
      : [],
    favorites: Array.isArray(saved.favorites) ? saved.favorites : defaultFavorites(home),
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
  const [recoveryNotice, setRecoveryNotice] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [focused, setFocused] = useState(0)
  const [sel, setSel] = useState({}) // tabId -> Set(paths)
  const [filters, setFilters] = useState({}) // tabId -> string
  const [clip, setClipState] = useState(getClip) // { mode: 'copy' | 'cut', paths }
  const [menu, setMenu] = useState(null) // { x, y, items, kind? }
  const [templates, setTemplates] = useState([]) // 应用支持目录 templates/ 里的文件
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
  const [rowToast, setRowToast] = useState(null) // { tabId, paths, text } feedback owned by one pane
  const rowToastTimer = useRef(null)
  const flashTimer = useRef(null)
  // 活动窗格，以及上一次离开的窗格。多于两个窗格时，F5/F6 送到刚离开的那个。
  // now 在按键时同步更新，长按 Tab 不用等下一次渲染才能继续切。
  const focusTrail = useRef({ now: 0, other: 1 })

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
  const [manualRefreshTicks, setManualRefreshTicks] = useState({})
  const [directoryVersions, setDirectoryVersions] = useState({})

  const rowsCache = useRef({}) // tabId -> 当前排序后的条目数组
  const cfgRef = useRef(null)
  cfgRef.current = cfg
  const operationDeps = useRef(null)
  const completionCallbacks = useRef(new Map())
  const [queueOpen, setQueueOpen] = useState(false)
  const [operationNotice, setOperationNotice] = useState(null)
  const [hiddenConflicts, setHiddenConflicts] = useState(new Set())
  const [exitChoice, setExitChoice] = useState(false)
  const [exitDraining, setExitDraining] = useState(false)
  const exitResolver = useRef(null)
  const operationEffects = useRef(null)
  if (!operationEffects.current) operationEffects.current = createOperationEffects({
    refreshDirectories: paths => operationDeps.current.refreshDirectories(paths),
    removeSelection: paths => operationDeps.current.removeSelection(paths),
    ownerPath: id => operationDeps.current.ownerPath(id),
    feedback: (...args) => operationDeps.current.feedback(...args),
    beginRename: (...args) => operationDeps.current.beginRename(...args),
    onError: error => setOperationNotice(String(error)),
  })
  const operations = useRef(null)
  if (!operations.current) operations.current = createOperationClient({
    api, listen: hasTauri ? listen : async () => () => {},
    onAdmissionRejected: ({ requestId }) => completionCallbacks.current.delete(requestId),
    onOutcomes: (job, rows) => operationEffects.current.outcomes(job, rows),
    onSettled: async (job, summary) => {
      await operationEffects.current.settled(job, summary)
      if (!operationDeps.current) return
      const callback = completionCallbacks.current.get(job.requestId)
      completionCallbacks.current.delete(job.requestId)
      if (job.state === 'completed' && (summary.counts.succeeded || 0) + (summary.counts.noop || 0) === job.progress.itemsTotal) callback?.()
    },
  })
  const [operationState, setOperationState] = useState(() => operations.current.getState())
  useEffect(() => {
    const client = operations.current
    const unsubscribe = client.subscribe(setOperationState)
    client.start().catch(error => setOperationNotice(String(error)))
    return () => {
      unsubscribe()
      client.dispose()
      operationEffects.current.dispose()
      operationDeps.current = null
      clearTimeout(rowToastTimer.current)
      clearTimeout(flashTimer.current)
    }
  }, [])
  useEffect(() => subscribeClip(setClipState), [])
  // 窗口置顶：配置变化（含启动恢复）时同步给原生窗口
  useEffect(() => {
    if (!hasTauri || !cfg) return
    getCurrentWindow().setAlwaysOnTop(!!cfg.alwaysOnTop).catch((e) => trace(`setAlwaysOnTop failed: ${e}`))
  }, [cfg?.alwaysOnTop])

  // The close hook is installed immediately; flushing waits until disk hydration finishes.
  const hydration = useRef(null)
  if (!hydration.current) {
    let resolve
    const promise = new Promise(done => { resolve = done })
    hydration.current = { promise, resolve, error: null }
  }
  const savers = useRef(null)
  if (!savers.current) {
    const onError = error => setSaveError(String(error))
    savers.current = {
      session: createSerialSaver(api.saveSession, { delay: 300, onError }),
      // Commit the migrated session before stripping its legacy fields from config.
      config: createSerialSaver(async prefs => {
        await savers.current.session.flush()
        await api.saveConfig(prefs)
      }, { delay: 300, onError }),
      views: createSerialSaver(api.saveViewSettings, { delay: 0, onError }),
    }
  }
  const queuePersistence = c => {
    if (!c) return
    savers.current.session.update(sessionForDisk(c))
    savers.current.config.update(preferencesForDisk(c))
    if (c.viewSettings) savers.current.views.update(c.viewSettings)
  }
  const flushPersistence = async () => {
    await hydration.current.promise
    if (hydration.current.error) throw hydration.current.error
    // Re-read the live ref after awaiting writes in case navigation happened during IO.
    let before
    do {
      before = cfgRef.current
      queuePersistence(before)
      const results = await Promise.allSettled(Object.values(savers.current).map(saver => saver.flush()))
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
    } while (before !== cfgRef.current)
    setSaveError(null)
  }

  // ---------- 启动 ----------
  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const h = await api.homeDir()
        const [saved, storedViews, loaded] = await Promise.all([
          api.loadConfig().catch(() => null),
          api.loadViewSettings().catch(() => null),
          api.loadSession().then(value => ({ value }), error => ({ error })),
        ])
        if (!live) return
        const { session, warning } = restoreSession(loaded.value, saved, h)
        const c = { ...sanitizeConfig(saved, h), ...session }
        const focus = c.focusedIdx
        const viewSettings = storedViews && typeof storedViews === 'object'
          ? normalizeViewSettings(storedViews) : seedViewSettings(c.panes, focus)
        const initial = { ...c, viewSettings }
        cfgRef.current = initial
        setHome(h)
        setCfg(initial)
        setFocused(focus)
        if (loaded.error || warning) setRecoveryNotice(warning || `会话读取失败，已从旧配置恢复：${loaded.error}。请检查并重试保存。`)
        hydration.current.resolve()
        trace(`boot: focusedIdx=${focus} layout=${c.layout} panes=${c.panes.length} ws=${c.workspaces.length}`)
      } catch (error) {
        if (!live) return
        hydration.current.error = error
        hydration.current.resolve()
        setRecoveryNotice(`启动恢复失败：${error}`)
      }
    })()
    return () => { live = false }
  }, [])

  // 启动时扫描模板目录；打开空白菜单时会再扫一次，放下新模板不用重启
  useEffect(() => {
    let live = true
    api
      .listTemplates()
      .then((list) => {
        if (live && Array.isArray(list)) setTemplates(list)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  // Compare document snapshots: stats, refresh and preference changes do not write session.json.
  useEffect(() => { if (cfg) queuePersistence(cfg) }, [cfg])
  useEffect(() => () => { Object.values(savers.current).forEach(saver => saver.dispose()) }, [])

  useEffect(() => {
    if (!hasTauri) return
    const win = getCurrentWindow()
    const coordinator = createSessionClose({
      flush: flushPersistence,
      operations: {
        busy: async () => { await operations.current.start(); await operations.current.resync(); return operations.current.getState().busy },
        choose: () => new Promise(resolve => { exitResolver.current = resolve; setExitChoice(true) }),
        prepare: async cancelRemaining => {
          setExitChoice(false)
          setExitDraining(cancelRemaining)
          try { await operations.current.prepareExit(cancelRemaining) }
          finally { setExitDraining(false) }
        },
        drained: () => { setExitChoice(false); exitResolver.current?.(true); exitResolver.current = null },
      },
      // destroy bypasses closeRequested, so the flushed close cannot re-enter this hook.
      close: () => win.destroy(),
      reply: (requestId, allowExit) => api.sessionExitReply(requestId, allowExit),
      confirmDiscard: error => confirm(`保存失败：${error}\n仍要退出吗？未保存的更改将丢失。`, {
        title: '无法保存会话', kind: 'warning', okLabel: '仍退出', cancelLabel: '取消退出',
      }),
    })
    const report = error => setSaveError(String(error))
    const registrations = [
      win.onCloseRequested(event => {
        event.preventDefault()
        return coordinator.requestClose().catch(report)
      }),
      listen('bento-session-exit-requested', event => coordinator.requestExit(event.payload?.requestId).catch(report)),
      listen('bento-operation-exit-drained', event => coordinator.requestDrained(event.payload?.requestId).catch(report)),
    ]
    return () => { registrations.forEach(registration => registration.then(unlisten => unlisten()).catch(report)) }
  }, [])

  // 路径 → canonicalize 后的键。解析失败时记下词法键，查找缺覆盖就用默认，不把错误抛到界面。
  const keyCache = useRef(new Map())
  const [keyEpoch, setKeyEpoch] = useState(0)
  const keyFor = (path) => {
    const lex = canonicalPathKey(path)
    if (!lex) return null
    return keyCache.current.get(lex) || lex
  }
  const viewPathSig = cfg
    ? cfg.panes.map((p) => `${p.active}\t${p.tabs.map((t) => t.path).join('\t')}`).join('\n')
    : ''
  useEffect(() => {
    if (!viewPathSig) return
    const paths = []
    const seen = new Set()
    for (const pane of cfgRef.current?.panes || []) {
      for (const tab of pane.tabs || []) {
        const lex = canonicalPathKey(tab.path)
        if (!lex || seen.has(lex) || keyCache.current.has(lex)) continue
        seen.add(lex)
        paths.push(tab.path)
      }
    }
    if (!paths.length) return
    let cancelled = false
    ;(async () => {
      let changed = false
      for (const path of paths) {
        const lex = canonicalPathKey(path)
        if (!lex || cancelled) return
        let key = lex
        try {
          key = (await resolveViewKey(path, api.resolvePath)) || lex
        } catch {
          key = lex
        }
        if (cancelled) return
        if (keyCache.current.get(lex) !== key) {
          keyCache.current.set(lex, key)
          if (key !== lex) changed = true
        }
      }
      if (changed && !cancelled) setKeyEpoch((n) => n + 1)
    })()
    return () => {
      cancelled = true
    }
  }, [viewPathSig])

  // 导航、换标签、改排序/列之后，把有效视图写回窗格。缺覆盖时用默认，不报错。
  useLayoutEffect(() => {
    setCfg((c) => {
      if (!c?.viewSettings) return c
      let store = c.viewSettings
      for (const [lex, canon] of keyCache.current) {
        const next = rekeyOverride(store, lex, canon)
        if (next !== store) store = next
      }
      const panes = syncPaneViews(c.panes, store, keyFor)
      if (store === c.viewSettings && panes === c.panes) return c
      return { ...c, viewSettings: store, panes }
    })
  }, [viewPathSig, cfg?.viewSettings, keyEpoch])

  // 聚焦窗格变化时持久化
  useEffect(() => {
    if (!cfg) return
    setCfg((c) => {
      const clamped = Math.min(focused, paneCount(c.layout) - 1)
      if (c.focusedIdx === clamped) return c
      return { ...c, focusedIdx: clamped }
    })
  }, [focused])

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
  if (focusTrail.current.now !== focusIdx) {
    focusTrail.current = { now: focusIdx, other: focusTrail.current.now }
  }
  const refresh = () => setTick((t) => t + 1)
  const refreshTab = (tabId) => setManualRefreshTicks((ticks) => bumpManualRefreshTick(ticks, tabId))
  const directoryKeyFor = (path) => directoryKey(path, keyCache.current)
  const refreshDirectories = (paths) => {
    const valid = [...new Set(paths.filter(Boolean))]
    if (!valid.length) return
    // Invalidate lexical and known alias keys immediately, then resolve unknown aliases without scanning.
    setDirectoryVersions(v => invalidateDirectories(v, valid.flatMap(path => [path, directoryKeyFor(path)])))
    return Promise.all(valid.map(path => api.resolvePath(path.endsWith('/') ? path : path + '/').catch(() => path))).then(resolved => {
      if (!operationDeps.current) return
      const extra = resolved.filter((path, i) => directoryKey(path) !== directoryKeyFor(valid[i]))
      if (extra.length) setDirectoryVersions(v => invalidateDirectories(v, extra))
    })
  }

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
      refreshTab(tabId)
      return
    }
    trace(`nav tab=${tabId} -> ${path}`)
    updateTab(tabId, t => navigateTab(t, { path }))
    setSel(s => ({ ...s, [tabId]: new Set() }))
  }

  const travel = (tabId, step) => {
    updateTab(tabId, t => navigateTab(t, { step }))
    setSel(s => ({ ...s, [tabId]: new Set() }))
  }
  const navBack = tabId => travel(tabId, -1)
  const navForward = tabId => travel(tabId, 1)

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
        tabId: paneEl.dataset.tabId,
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
      }, plan.tabId)
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
  const onSelect = (tabId, next) => {
    setSel((s) => ({ ...s, [tabId]: next }))
    if (next.size === 1) previewNavigation.current?.selectionChanged(tabId, [...next][0])
  }
  const selArr = (tabId) => Array.from(sel[tabId] || [])

  const previewDeps = useRef(null)
  previewDeps.current = {
    getRows: (tabId, directory) => {
      const owner = cfgRef.current?.panes.slice(0, visibleCount).find(p => (p.tabs[p.active] || p.tabs[0])?.id === tabId)
      const tab = owner && (owner.tabs[owner.active] || owner.tabs[0])
      return tab?.path === directory ? rowsCache.current[tabId] || [] : []
    },
    select: (tabId, path) => onSelect(tabId, new Set([path])),
    reveal: (tabId, path) => setRevealReq({ tabId, path, nonce: Date.now() }),
    present: (path, paths, session) => api.quickLook(path, paths, session),
    update: (path, paths, session, revision) => api.updateQuickLook(path, paths, session, revision),
  }
  const previewNavigation = useRef(null)
  if (!previewNavigation.current) previewNavigation.current = createQuickLookNavigation({
    getRows: (...args) => previewDeps.current.getRows(...args),
    select: (...args) => previewDeps.current.select(...args),
    reveal: (...args) => previewDeps.current.reveal(...args),
    present: (...args) => previewDeps.current.present(...args),
    update: (...args) => previewDeps.current.update(...args),
  })
  useEffect(() => {
    if (!hasTauri) return
    let live = true
    const unsubs = [
      listen('bento-quick-look-navigate', e => live && previewNavigation.current.navigate(e.payload)),
      listen('bento-quick-look-closed', e => live && previewNavigation.current.closed(e.payload)),
    ]
    return () => { live = false; unsubs.forEach(p => p.then(unlisten => unlisten())) }
  }, [])

  // ---------- 文件操作 ----------
  // The owner is captured at operation start; Pane resolves its own visible row or local fallback.
  const targetTabFor = (dest) => {
    const panes = cfgRef.current?.panes || []
    const candidates = panes.slice(0, visibleCount).map(p => p.tabs[p.active] || p.tabs[0])
    return candidates.find(t => t?.id === activeTabOf(focusIdx)?.id && directoryKeyFor(t.path) === directoryKeyFor(dest))?.id
      || candidates.find(t => t && directoryKeyFor(t.path) === directoryKeyFor(dest))?.id
  }
  const showRowToast = (tabId, paths, text) => {
    if (!tabId) return
    setRowToast({ tabId, paths, text })
    clearTimeout(rowToastTimer.current)
    rowToastTimer.current = setTimeout(() => setRowToast(null), 2200)
  }

  // 多选时按当前列表顺序输出，避免 Set 插入序和肉眼看到的行序不一致。
  const orderedPaths = (tabId, paths) => {
    const list = paths?.length ? paths : selArr(tabId)
    if (list.length < 2) return list
    const rows = rowsCache.current[tabId] || []
    const order = new Map(rows.map((r, i) => [r.path, i]))
    return [...list].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))
  }

  const copyPlainPaths = (tabId, paths) => {
    const list = (paths || []).filter((p) => typeof p === 'string' && p)
    if (!list.length) return
    const text = list.join('\n')
    const done = () => showRowToast(tabId, list, list.length === 1 ? '已复制路径' : `已复制 ${list.length} 条路径`)
    writeText(text).then(done).catch(() => {
      copyText(text).then(done)
    })
  }

  operationDeps.current = {
    refreshDirectories,
    ownerPath: id => cfgRef.current?.panes.flatMap(p => p.tabs).find(tab => tab.id === id)?.path,
    feedback: showRowToast,
    beginRename: (tabId, path, selectAll) => {
      setSel(s => ({ ...s, [tabId]: new Set([path]) }))
      setRenaming({ tabId, path, value: basename(path), selectAll })
    },
    removeSelection: paths => {
      const gone = new Set(paths)
      setSel(s => {
        let changed = false
        const next = { ...s }
        for (const [id, selected] of Object.entries(s)) {
          if (![...selected].some(path => gone.has(path))) continue
          next[id] = new Set([...selected].filter(path => !gone.has(path)))
          changed = true
        }
        return changed ? next : s
      })
      window.dispatchEvent(new CustomEvent('bento-moved', { detail: { paths } }))
    },
  }
  const submitOperation = async (kind, items, destination, ownerTabId, intent, options = {}, extra = {}, onSuccess) => {
    const request = { requestId: operationId(), kind, items: items.map((item, i) => ({ itemId: `i${i}`, ...item })), destination: destination || null, options, ownerTabId: ownerTabId || null, intent, ...extra }
    if (onSuccess) completionCallbacks.current.set(request.requestId, onSuccess)
    try { return await operations.current.enqueue(request) }
    catch (error) { setOperationNotice(String(error)); return null }
  }
  const transferInto = (dest, paths, mode, onSuccess, ownerTabId = targetTabFor(dest), options = {}) => {
    if (!paths?.length) return
    return submitOperation(mode === 'move' ? 'move' : 'copy', paths.map(source => ({ source })), dest, ownerTabId, options.keepBoth ? 'duplicate' : 'transfer', options, {}, onSuccess)
  }
  const moveInto = (dest, paths, ownerTabId = targetTabFor(dest), cutRevision = null) => {
    if (!paths?.length || (cutRevision && !reserveCut(cutRevision))) return
    return submitOperation('move', paths.map(source => ({ source })), dest, ownerTabId, cutRevision ? 'cutPaste' : 'transfer', {}, { clipRevision: cutRevision }).then(job => {
      // An ambiguous admission stays reserved until reconciliation prevents a duplicate cut.
      if (!job && !operations.current.getState().pendingSubmissions.length && cutRevision) releaseCut(cutRevision)
      return job
    })
  }
  const undoLast = () => operations.current.undo().catch(error => setOperationNotice(String(error)))
  const doTrash = (tabId, paths) => {
    const list = paths?.length ? paths : selArr(tabId)
    if (list.length) return submitOperation('trash', list.map(source => ({ source })), null, tabId, 'trash')
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
    const cut = mode === 'cut' || mode === 'move'
    if (!paths.length) {
      // ⌘C 没有选中项时取消剪切；已有拷贝则保持，避免把拷贝剪贴板清掉。
      if (!cut) clearCut()
      return
    }
    setClip({ mode: cut ? 'cut' : 'copy', paths: [...paths] })
    // 提示贴在被复制的文件旁边，而不是屏幕底部
    showRowToast(tabId, paths, `${cut ? '已剪切' : '已复制'}${describeItems(tabId, paths)}`)
    // 文件引用写进系统剪贴板：其他软件 ⌘V 可直接粘贴文件本体。剪切只留在应用内。
    if (!cut) {
      api
        .copyFilesToClipboard(paths)
        .then(() => trace(`clipboard ok ${paths.length} paths`))
        .catch((e) => trace(`clipboard FAILED ${e}`))
    }
  }

  const doPaste = (tabId) => {
    const current = getClip()
    if (!current?.paths?.length) return
    const dest = locateTab(tabId)?.path
    if (!dest) return
    if (current.mode === 'cut') moveInto(dest, current.paths, tabId, current.revision)
    else transferInto(dest, current.paths, 'copy', undefined, tabId)
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
  const runZip = (paths, dir, o, ownerTabId = targetTabFor(dir)) => submitOperation('zip', paths.map(source => ({ source })), dir, ownerTabId, 'archive', {
    archiveName: o.name, compressionLevel: o.level, password: o.password || null, separate: !!o.separate,
  })
  const retryOperation = jobId => {
    const retry = operations.current.retryInfo(jobId)
    if (retry?.kind !== 'zip') return operations.current.retry(jobId)
    setZipDlg({
      id: operationId(), paths: retry.items.map(item => item.source), dir: retry.destination,
      name: retry.options.archiveName, tabId: retry.ownerTabId, requirePassword: retry.requiresPassword,
      prefs: normalizeZipPrefs({ mode: 'custom', level: retry.options.compressionLevel, separate: retry.options.separate }),
    })
  }
  // 默认文件名：单个项目 = 该项目名.zip；多个项目 = 当前文件夹名.zip
  const zipDefaultName = (paths, dir) =>
    paths.length === 1 ? `${basename(paths[0])}.zip` : `${basename(dir) || '归档'}.zip`
  const zipMenuItems = (paths, dir, entry, tabId) => {
    const p = normalizeZipPrefs(cfg.zipPrefs)
    const name = zipDefaultName(paths, dir)
    const openDlg = () => setZipDlg({ id: Date.now(), paths, dir, name, tabId })
    const what = paths.length > 1 ? `${paths.length} 项` : `「${entry.name}」`
    if (!p.oneClick) return [{ label: `压缩${what}…`, action: openDlg }]
    return [
      {
        label: `压缩${what}`,
        action: () =>
          runZip(paths, dir, { name, level: levelOf(p), password: p.password, separate: p.separate && paths.length > 1 }, tabId),
      },
      { label: '压缩选项…', action: openDlg },
    ]
  }

  const doDuplicate = (tabId, paths) => {
    const list = paths?.length ? paths : selArr(tabId)
    const dest = locateTab(tabId)?.path
    if (list.length && dest) transferInto(dest, list, 'copy', undefined, tabId, { keepBoth: true })
  }

  const newFolder = tabId => {
    const dest = locateTab(tabId)?.path
    if (dest) return submitOperation('create', [{ createKind: 'directory' }], dest, tabId, 'newDirectory')
  }
  const newFile = (tabId, kind) => {
    const dest = locateTab(tabId)?.path
    if (dest) return submitOperation('create', [{ createKind: kind === 'md' ? 'markdown' : kind === 'txt' ? 'text' : kind }], dest, tabId, 'newFile')
  }
  const newFromTemplate = (tabId, template) => {
    const dest = locateTab(tabId)?.path
    if (dest && template?.path) return submitOperation('create', [{ createKind: 'template', source: template.path }], dest, tabId, 'newTemplate')
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
    if (!value || value === current) return
    return submitOperation('rename', [{ source: path, targetName: value }], null, tabId, 'rename')
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
      { label: '打开', shortcut: '⌘↓', action: () => openEntry(tabId, entry) },
      ...paneOpenItems,
      paneOpenItems.length ? { sep: true } : null,
      { label: '拷贝', shortcut: '⌘C', action: () => doCopyCut(tabId, 'copy') },
      { label: '剪切', shortcut: '⌘X', action: () => doCopyCut(tabId, 'move') },
      { sep: true },
      {
        label: paths.length > 1 ? `重新命名 ${paths.length} 个项目…` : '重新命名',
        shortcut: normalizeEnterAction(cfg?.enterAction) === 'open' ? 'F2' : '↩',
        action: () =>
          paths.length > 1
            ? openBatchRename(tabId, paths)
            : startRename(tabId, entry.path, entry.name),
      },
      { label: '拷贝副本', shortcut: '⌘D', action: () => doDuplicate(tabId, paths) },
      ...zipMenuItems(paths, parentDir, entry, tabId),
      { label: '移到废纸篓', danger: true, shortcut: '⌘⌫', action: () => doTrash(tabId, paths) },
      { sep: true },
      {
        label: entry.is_dir ? '添加到书签' : '将所在文件夹添加到书签',
        action: () => addFavorite(entry.is_dir ? entry.path : parentDir),
      },
      { label: '在终端打开', action: () => termDir && api.openTerminal(termDir).catch((e) => alert(String(e))) },
      { label: '拷贝路径', shortcut: '⌥⌘C', action: () => copyPlainPaths(tabId, orderedPaths(tabId, paths)) },
      { label: '在访达中显示', action: () => api.reveal(entry.path).catch(() => {}) },
    ].filter(Boolean)
    setMenu({ x, y, items })
  }

  // 排序和列按文件夹记住：改当前目录只写它的覆盖，其他目录仍用默认或自己的覆盖。
  const commitFolderView = (path, patch) => {
    const lex = canonicalPathKey(path)
    if (!lex) return
    const key = keyCache.current.get(lex) || lex
    setCfg((c) => {
      const store = withFolderPatch(c.viewSettings, key, patch)
      if (store === c.viewSettings) return c
      return { ...c, viewSettings: store }
    })
  }
  const clearFolderView = (path) => {
    const lex = canonicalPathKey(path)
    if (!lex) return
    setCfg((c) => {
      let store = clearFolderOverride(c.viewSettings, lex)
      const canon = keyCache.current.get(lex)
      if (canon && canon !== lex) store = clearFolderOverride(store, canon)
      if (store === c.viewSettings) return c
      return { ...c, viewSettings: store }
    })
  }
  const applyViewToAll = (path) => {
    const key = keyFor(path)
    if (!key) return
    setCfg((c) => {
      const store = applyToAllFolders(c.viewSettings, viewForPath(c.viewSettings, key))
      if (store === c.viewSettings) return c
      return { ...c, viewSettings: store }
    })
  }
  const folderOverridden = (path) => {
    const lex = canonicalPathKey(path)
    if (!lex || !cfg?.viewSettings) return false
    if (hasFolderOverride(cfg.viewSettings, lex)) return true
    const canon = keyCache.current.get(lex)
    return !!(canon && canon !== lex && hasFolderOverride(cfg.viewSettings, canon))
  }
  const folderViewMenu = (path) => [
    {
      label: '此文件夹使用默认视图',
      disabled: !path || !folderOverridden(path),
      action: () => path && clearFolderView(path),
    },
    {
      label: '应用到所有文件夹',
      disabled: !path,
      action: () => path && applyViewToAll(path),
    },
  ]
  const colMenu = (i, x, y) => {
    const pane = cfg.panes[i]
    const path = pane?.tabs[pane.active]?.path
    const current = viewForPath(cfg.viewSettings, keyFor(path))
    const vis = current.columns.visible
    setMenu({
      x,
      y,
      items: [
        ...COL_LABELS.map(([key, label]) => ({
          label,
          checked: !!vis[key],
          action: () =>
            path &&
            commitFolderView(path, {
              columns: { widths: current.columns.widths, visible: { ...vis, [key]: !vis[key] } },
            }),
        })),
        { sep: true },
        ...folderViewMenu(path),
      ],
    })
  }

  const newFileItems = (tabId, list) => {
    const items = [
      { label: '文本文件', action: () => newFile(tabId, 'text') },
      { label: 'Markdown', action: () => newFile(tabId, 'markdown') },
    ]
    if (list?.length) {
      items.push({ sep: true })
      for (const t of list) items.push({ label: t.name, action: () => newFromTemplate(tabId, t) })
    }
    return items
  }

  const blankItems = (tabId, list) => {
    const path = locateTab(tabId)?.path
    return [
      { label: '新建文件夹', shortcut: '⇧⌘N', action: () => newFolder(tabId) },
      { label: '新建', children: newFileItems(tabId, list) },
      {
        label: '将当前文件夹添加到书签',
        action: () => addFavorite(path),
      },
      { label: '粘贴项目', shortcut: '⌘V', disabled: !clip, action: () => doPaste(tabId) },
      { sep: true },
      {
        label: cfg.showHidden ? '隐藏隐藏文件' : '显示隐藏文件',
        shortcut: '⇧⌘.',
        action: () => setCfg((c) => ({ ...c, showHidden: !c.showHidden })),
      },
      { label: '刷新', shortcut: '⌘R', action: () => refreshTab(tabId) },
      { sep: true },
      ...folderViewMenu(path),
      { label: '在访达中显示', action: () => api.reveal(path || '/').catch(() => {}) },
    ]
  }

  const blankMenu = (tabId, x, y) => {
    setMenu({ kind: 'blank', tabId, x, y, items: blankItems(tabId, templates) })
    api
      .listTemplates()
      .then((list) => {
        if (!Array.isArray(list)) return
        setTemplates(list)
        setMenu((m) => {
          if (!m || m.kind !== 'blank' || m.tabId !== tabId) return m
          return { ...m, items: blankItems(tabId, list) }
        })
      })
      .catch(() => {})
  }

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
  const textEditing = useRef(null)
  keyRef.current = (e) => {
    if (exitChoice || exitDraining || visibleConflict) return
    // ⌘,：输入框聚焦时也可打开设置
    if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.key === ',') {
      e.preventDefault()
      setSearchOpen(false)
      setMenu(null)
      setLayoutPickerOpen(false)
      setSettingsOpen(true)
      return
    }
    // Text Undo/Redo must explicitly reach WebKit; file Undo uses the effect stack.
    if (e.metaKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'z') {
      if (isTextEditingElement(document.activeElement)) {
        textEditing.current?.handleKeyDown(e)
        return
      }
      if (!e.shiftKey) {
        e.preventDefault()
        undoLast()
      }
      return
    }
    // ⌘K：打开/聚焦搜索面板（浏览器习惯）
    if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      setSearchOpen(true)
      return
    }
    // ⌘L / ⌘⇧G：即使焦点在输入框里也能跳到地址栏编辑（浏览器习惯）。
    // Esc 退出编辑由地址栏输入框自己处理并 stopPropagation，避免落到下面的「取消选择」。
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
    // ⌥⌘C：复制当前选择的完整路径，多选一行一个。macOS 上 ⌥ 会改写 key（ç），所以认 code。
    // 放在输入框提前返回之前，地址栏聚焦时也能复制文件路径，而不是地址栏里选中的文字。
    if (e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyC') {
      e.preventDefault()
      if (e.repeat) return
      const tab = activeTabOf(focusIdx)
      if (!tab) return
      copyPlainPaths(tab.id, orderedPaths(tab.id))
      return
    }
    if (e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault()
      const tab = activeTabOf(focusIdx)
      if (tab) refreshTab(tab.id)
      return
    }
    if (isTextEditingElement(document.activeElement)) {
      textEditing.current?.handleKeyDown(e)
      return
    }
    const meta = e.metaKey
    const tab = activeTabOf(focusIdx)
    if (!tab) return
    const tid = tab.id
    const paths = selArr(tid)
    const paneRows = rowsCache.current[tid] || []
    const firstEntry = () => paneRows.find((x) => x.path === paths[0])

    const listBlocked = searchOpen || settingsOpen || batchRename || menu || zipDlg || layoutPickerOpen || exitChoice || exitDraining || visibleConflict
    // 重命名输入框还没挂上时也不要把 Tab/F5/F6 当成窗格命令。
    const paneAction = listBlocked || renaming ? null : resolvePaneKey(e)
    if (paneAction === 'focusNext' || paneAction === 'focusPrev') {
      // 单窗格：不拦截 Tab，地址栏以外的焦点移动保持原样。
      if (visibleCount < 2) return
      e.preventDefault()
      const current = focusTrail.current.now
      const next = paneIndexAfterKey(paneAction, current, visibleCount)
      if (next < 0 || next === current) return
      focusTrail.current = { now: next, other: current }
      setFocused(next)
      triggerFlash(next)
      // 把 DOM 焦点跟到新窗格的列表上，避免高亮在这边、键盘焦点还留在那边。
      requestAnimationFrame(() => {
        document.querySelectorAll('.panes > .pane')[next]?.querySelector('.rows')?.focus({ preventScroll: true })
      })
      return
    }
    if (paneAction === 'copyToOther' || paneAction === 'moveToOther') {
      e.preventDefault()
      if (e.repeat || visibleCount < 2) return
      const destIdx = otherPaneIndex(focusIdx, visibleCount, focusTrail.current.other)
      const dest = destIdx >= 0 ? activeTabOf(destIdx)?.path : null
      const moving = orderedPaths(tid)
      if (!dest || !moving.length) return
      triggerFlash(destIdx)
      if (paneAction === 'moveToOther') moveInto(dest, moving)
      else transferInto(dest, moving, 'copy', undefined, activeTabOf(destIdx)?.id)
      return
    }
    const listAction = listBlocked ? null : resolveListKey(e, cfg?.enterAction)
    if (listAction) {
      e.preventDefault()
      if (listAction === 'open') {
        const entry = firstEntry()
        if (entry && !entry.isPseudo) openEntry(tid, entry)
        return
      }
      if (listAction === 'enterDir') {
        const entry = firstEntry()
        if (entry?.is_dir && !entry.isPseudo) openEntry(tid, entry)
        return
      }
      if (listAction === 'parent') {
        nav(tid, parentPath(tab.path))
        return
      }
      if (listAction === 'rename') {
        if (paths.length > 1) openBatchRename(tid, paths)
        else if (paths.length === 1 && paneRows.some((r) => r.path === paths[0])) {
          startRename(tid, paths[0], basename(paths[0]))
        }
        return
      }
      const rows = paneRows.filter((r) => !r.isPseudo)
      if (!rows.length) return
      const scroller = document.querySelectorAll('.panes > .pane')[focusIdx]?.querySelector('.rows')
      const nextIdx = listIndexAfterKey(
        listAction,
        rows.findIndex((r) => r.path === paths[0]),
        rows.length,
        pageStride(scroller?.clientHeight),
      )
      if (nextIdx < 0) return
      const path = rows[nextIdx].path
      onSelect(tid, new Set([path]))
      requestAnimationFrame(() => {
        const pane = document.querySelectorAll('.panes > .pane')[focusIdx]
        const row = pane?.querySelector('.row.selected')
        if (row) row.scrollIntoView({ block: 'nearest' })
        else if (scroller) setRevealReq({ tabId: tid, path, nonce: Date.now(), scrollTop: scroller.scrollTop })
      })
      return
    }

    if (meta && !e.altKey && !e.shiftKey && e.key === 'c') { e.preventDefault(); doCopyCut(tid, 'copy'); return }
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
      // 按住空格会连发 keydown；只响应第一次，避免面板刚打开就被关掉
      if (e.repeat) return
      const entry = firstEntry()
      const primary = entry && !entry.is_dir && !entry.isPseudo ? entry.path
        : paneRows.find(r => paths.includes(r.path) && !r.is_dir && !r.isPseudo)?.path
      if (primary) previewNavigation.current.open(tid, tab.path, primary, paths)
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
    if (e.key === 'Backspace') { e.preventDefault(); nav(tid, parentPath(tab.path)); return }
    if (e.key === 'Escape') {
      clearCut()
      onSelect(tid, new Set())
      return
    }
  }

  useEffect(() => {
    const editor = createTextEditing({
      doc: document, readText, writeText,
      writeFallback: text => navigator.clipboard.writeText(text),
    })
    textEditing.current = editor
    const h = (e) => keyRef.current?.(e)
    window.addEventListener('keydown', h)
    return () => {
      window.removeEventListener('keydown', h)
      editor.dispose()
      textEditing.current = null
    }
  }, [])

  const conflictKey = job => `${job.jobId}:${job.conflict?.conflictId}:${job.conflict?.revision}`
  const visibleConflict = operationState.jobs.find(job => job.state === 'waitingConflict' && job.conflict && !hiddenConflicts.has(conflictKey(job)))
  const cutSet = useMemo(() => new Set(clip?.mode === 'cut' ? clip.paths : []), [clip])

  if (!cfg) return <div className="boot">{recoveryNotice || 'Bento 启动中…'}</div>

  const focusedTab = activeTabOf(focusIdx)

  return (
    <div className="app">
      {recoveryNotice && <div role="alert">{recoveryNotice} <button onClick={() => setRecoveryNotice(null)}>知道了</button></div>}
      {saveError && <div role="alert">保存失败：{saveError} <button onClick={() => flushPersistence().catch(error => setSaveError(String(error)))}>重试保存</button></div>}
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
              selection={sel[p.tabs[p.active]?.id] || EMPTY_SELECTION}
              filter={filters[p.tabs[p.active]?.id] || ''}
              renaming={renaming}
              tick={rootRefreshKey(tick, directoryVersions, directoryKeyFor(p.tabs[p.active]?.path), manualRefreshTicks[p.tabs[p.active]?.id] || 0)}
              directoryVersions={directoryVersions}
              directoryKeyFor={directoryKeyFor}
              operationToast={rowToast?.tabId === p.tabs[p.active]?.id ? rowToast : null}
              onColWidths={(w) => {
                const path = p.tabs[p.active]?.path
                if (!path) return
                const current = viewForPath(cfg.viewSettings, keyFor(path))
                commitFolderView(path, { columns: { widths: normalizeCols(w), visible: current.columns.visible } })
              }}
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
              onDropTransfer={(dest, paths, mode, onSuccess) => transferInto(dest, paths, mode, onSuccess, p.tabs[p.active]?.id)}
              onFilter={(tid, v) => setFilters((f) => ({ ...f, [tid]: v }))}
              onSort={(tid, key, dir) => {
                const path = locateTab(tid)?.path
                if (path) commitFolderView(path, { sort: { key, dir } })
              }}
              onStats={(tid, st) =>
                setStats((s) => {
                  const prev = s[tid]
                  if (
                    prev &&
                    prev.count === st.count &&
                    prev.total === st.total &&
                    prev.listing === st.listing &&
                    prev.listingLive === st.listingLive &&
                    prev.incomplete === st.incomplete &&
                    prev.selCount === st.selCount &&
                    prev.selSize === st.selSize
                  ) {
                    return s
                  }
                  return { ...s, [tid]: st }
                })
              }
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

      <StatusBar path={focusedTab?.path || '/'} stats={stats[focusedTab?.id]}>
        <Suspense fallback={null}>
          <OperationQueue state={operationState} client={operations.current} open={queueOpen}
            onToggle={() => setQueueOpen(open => !open)} onClose={() => setQueueOpen(false)} notice={operationNotice}
            onConflict={job => setHiddenConflicts(current => {
              const next = new Set(current)
              next.delete(conflictKey(job))
              return next
            })}
            onUndo={undoLast} onRetry={retryOperation} onError={error => setOperationNotice(String(error))} reveal={api.reveal} />
        </Suspense>
      </StatusBar>
      {operationNotice && <div className="operation-notice" role="alert">
        {operationNotice} <button className="btn" onClick={() => setOperationNotice(null)}>知道了</button>
      </div>}
      {visibleConflict && !exitChoice && !exitDraining && <Suspense fallback={null}>
        <OperationConflict key={conflictKey(visibleConflict)} job={visibleConflict}
          onHide={() => setHiddenConflicts(current => new Set([...current, conflictKey(visibleConflict)]))}
          onResolve={(...args) => operations.current.resolve(...args)} onError={setOperationNotice} />
      </Suspense>}
      {(exitChoice || exitDraining) && <div className="modal-backdrop">
        <section className="modal operation-exit" role="dialog" aria-modal="true" aria-label="退出前的文件操作">
          <h2 className="modal-title">{exitDraining ? '正在结束文件操作…' : '文件操作尚未完成'}</h2>
          <p>{exitDraining ? '正在等待当前文件、归档进程和恢复记录安全收尾。'
            : '继续操作，或取消剩余任务并等待当前项目收尾后退出。已经完成的文件将保留。'}</p>
          {exitChoice && <div className="modal-footer">
            <button autoFocus className="btn primary" onClick={() => {
              setExitChoice(false)
              exitResolver.current?.(false)
              exitResolver.current = null
            }}>继续操作</button>
            <button className="btn" onClick={() => {
              setExitChoice(false)
              exitResolver.current?.(true)
              exitResolver.current = null
            }}>取消剩余操作后退出</button>
          </div>}
        </section>
      </div>}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {hoverTip && (
        <div className="drag-tip" style={{ left: hoverTip.x, top: hoverTip.y }}>
          {hoverTip.text}
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
        enterAction={normalizeEnterAction(cfg.enterAction)}
        onEnterActionChange={(enterAction) => setCfg((c) => ({ ...c, enterAction: normalizeEnterAction(enterAction) }))}
        onClose={() => setSettingsOpen(false)}
      />
      {zipDlg && (
        <ZipDialog
          key={zipDlg.id}
          count={zipDlg.paths.length}
          dir={zipDlg.dir}
          defaultName={zipDlg.name}
          prefs={zipDlg.prefs || normalizeZipPrefs(cfg.zipPrefs)}
          requirePassword={zipDlg.requirePassword}
          onCancel={() => setZipDlg(null)}
          onSubmit={(o, saved) => {
            const d = zipDlg
            setZipDlg(null)
            setCfg((c) => ({ ...c, zipPrefs: saved })) // 记住上次的压缩设置
            runZip(d.paths, o.dir, o, d.tabId)
          }}
        />
      )}
      {batchRename && (
        <BatchRenameDialog
          items={batchRename.items}
          onCancel={() => setBatchRename(null)}
          onApply={async results => {
            const tid = batchRename.tabId
            setBatchRename(null)
            await submitOperation('rename', results.filter(item => item.newName !== item.name).map(item => ({ source: item.path, targetName: item.newName })), null, tid, 'batchRename')
          }}
        />
      )}
    </div>
  )
}
