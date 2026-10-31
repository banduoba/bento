import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { trace, makeDragPreview, fallbackPreview, runNativeDrag } from '../nativeDrag'
import { api } from '../api'
import { setWatch, clearWatch, onFsChange } from '../fsWatch'
import { fmtSize, fmtDate, basename, parentPath, labelOf, makeMatcher, copyText, kindOf, splitName } from '../format'
import { COL_MIN, COL_MAX, DEFAULT_COLS, applyColVars, fitColumns, normalizeCols, normalizeVis } from '../columns'
import { IconArrowUp, IconCheck, IconChevronLeft, IconChevronRight, IconCopy, IconFolder, IconPencil, IconRefresh, IconSearch } from '../icons'
import FileIcon from './FileIcon'

const MIME = 'application/x-bento'

function sortEntries(list, key, dir) {
  const f = dir === 'asc' ? 1 : -1
  // 文件与文件夹按所选规则统一混排（Finder/QSpace 惯例）
  return [...list].sort((a, b) => {
    let c = 0
    if (key === 'size') c = a.size - b.size
    else if (key === 'mtime') c = a.mtime_ms - b.mtime_ms
    else if (key === 'btime') c = (a.btime_ms || 0) - (b.btime_ms || 0)
    else if (key === 'kind') c = kindOf(a).localeCompare(kindOf(b), 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
    else c = a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
    return c * f
  })
}

export default function Pane({
  index,
  area,
  pane,
  home,
  cfg,
  focused,
  selection,
  filter,
  renaming,
  tick,
  cutSet,
  editPathSignal,
  flash,
  reveal,
  onRevealDone,
  onFocus,
  onNav,
  onBack,
  onForward,
  onOpen,
  onSelect,
  onMenu,
  onBlankMenu,
  onTabMenu,
  onNewTab,
  onCloseTab,
  onSwitchTab,
  onDropTransfer,
  onFilter,
  onSort,
  onColWidths,
  onColMenu,
  onStats,
  onRowsCache,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}) {
  const [entries, setEntries] = useState(null)
  const [error, setError] = useState(null)
  const [dropTarget, setDropTarget] = useState(null) // 'bg' | 文件夹路径
  const [editingPath, setEditingPath] = useState(null) // 非空 = 地址栏编辑中
  const [pathError, setPathError] = useState(null) // 回车跳转失败时的行内错误，保留输入
  const [pathFocusNonce, setPathFocusNonce] = useState(0) // ⌘L / 铅笔：进入编辑后聚焦并全选
  const [completions, setCompletions] = useState(null) // { base, matches, active } Tab 候选；active < 0 表示还没选定一条
  const completionsRef = useRef(null) // 与 state 同步，连按 Tab 时不用等下一次渲染
  const editSeq = useRef(0) // 作废过期的 resolve（继续输入、Esc、再次 ⌘L）
  const completeSeq = useRef(0) // 作废过期的补全
  const pathEditClosed = useRef(false)
  const caretRef = useRef(null) // 补全写入后把光标放到末尾，避免沿用进入编辑时的全选
  const suggestRef = useRef(null)
  const [collapsedCount, setCollapsedCount] = useState(0) // 面包屑溢出时折叠的前置层级数
  const [copiedPath, setCopiedPath] = useState(null) // 行内复制路径反馈
  const [copyToast, setCopyToast] = useState(null) // { path, x, y, placeLeft } 锚定按钮的提示条
  const [expandedDirs, setExpandedDirs] = useState(() => new Set()) // 树形展开的文件夹
  const [kidsVersion, setKidsVersion] = useState(0)
  const [activity, setActivity] = useState({}) // dirPath -> 递归活动时间(ms)，后台懒加载
  const kidsRef = useRef({}) // dirPath -> 子条目数组（null=载入中）
  const copyTimer = useRef(null)
  const toastTimer = useRef(null)
  completionsRef.current = completions
  const setCompletionList = (next) => {
    completionsRef.current = next
    setCompletions(next)
  }
  const showCopyToast = (path, btnRect) => {
    setCopiedPath(path)
    // 提示条出现在按钮旁边：默认右侧垂直居中，右侧空间不足则翻到左侧
    const spaceRight = window.innerWidth - btnRect.right - 12
    const placeLeft = spaceRight < 300
    setCopyToast({
      path,
      x: placeLeft ? btnRect.left - 8 : btnRect.right + 8,
      y: btnRect.top + btnRect.height / 2,
      placeLeft,
    })
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopiedPath(null), 1200)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setCopyToast(null), 2200)
  }
  const [moreMenu, setMoreMenu] = useState(null) // { x, y, segs } 折叠层级的悬停列表
  const [clickFocus, setClickFocus] = useState(null) // 最近一次点击的行；键盘移动选择后若不在选区里则回退到当前选中项
  const moreTimer = useRef(null)
  const anchorRef = useRef(null)
  const scrollRef = useRef(null)
  const crumbsRef = useRef(null)
  const renameRef = useRef(null)
  const pathInputRef = useRef(null)
  const innerRef = useRef(null)


  // ---------- 行原生拖拽（拖出到其他软件/本应用窗格） ----------
  const rowDragRef = useRef(null)
  const rowSuppressRef = useRef(false)
  const [draggingPaths, setDraggingPaths] = useState(() => new Set())
  useEffect(() => {
    let live = true
    let suppressTimer
    const finishDrag = (d) => {
      if (!live || rowDragRef.current !== d) return
      rowDragRef.current = null
      setDraggingPaths(new Set())
      suppressTimer = setTimeout(() => {
        rowSuppressRef.current = false
      }, 0)
    }
    const onMove = (e) => {
      const d = rowDragRef.current
      if (!d || d.started) return
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) >= 3) {
        d.started = true
        trace(`row-dragstart ${d.paths.length} paths`)
        rowSuppressRef.current = true
        clearTimeout(suppressTimer)
        setDraggingPaths(new Set(d.paths))
        d.preview.then((icon) => {
          if (!live || rowDragRef.current !== d) return
          d.nativeStarted = true
          // Promise 仅表示会话启动；结束/取消由原生回调通知。
          return runNativeDrag(d.paths, icon, () => finishDrag(d))
        })
      }
    }
    const onUp = () => {
      const d = rowDragRef.current
      if (d && !d.nativeStarted) finishDrag(d)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      live = false
      clearTimeout(suppressTimer)
      rowDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const beginRowDrag = (e, entry) => {
    if (rowDragRef.current?.started) return
    const paths = selection?.has(entry.path) && selection.size > 1 ? [...selection] : [entry.path]
    const preview = makeDragPreview(paths.length, entry.is_dir).catch((err) => {
      trace(`makeDragPreview failed: ${err?.message || err}`)
      return fallbackPreview(entry.is_dir)
    })
    rowDragRef.current = { x: e.clientX, y: e.clientY, paths, preview, started: false }
  }

  // ---------- 列：宽度可拖动、可勾选显示、窗格太窄自动隐藏次要列（均只作用于当前窗格） ----------
  const colsInnerRef = useRef(null)
  const paneElRef = useRef(null)
  const [paneW, setPaneW] = useState(0)
  useLayoutEffect(() => {
    const el = paneElRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setPaneW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const shownCols = fitColumns(normalizeVis(pane.colVisible), normalizeCols(pane.colWidths), paneW)
  const shownKey = shownCols.join(',')
  // 列模板写成该窗格根元素上的 CSS 变量；每个窗格各存各的（pane.colWidths / pane.colVisible）
  useLayoutEffect(() => {
    if (paneElRef.current) applyColVars(pane.colWidths, paneElRef.current, shownCols)
  }, [pane.colWidths, shownKey])
  const startColResize = (e, key) => {
    e.preventDefault()
    e.stopPropagation()
    const cur = normalizeCols(pane.colWidths)
    const startW = cur[key] ?? e.currentTarget.parentElement.getBoundingClientRect().width // 名称列自适应时取当前实际宽度
    const startX = e.clientX
    const [lo, hi] = key === 'name' ? [120, 1600] : [COL_MIN, COL_MAX]
    let next = cur
    document.body.classList.add('col-resizing')
    const onMove = (ev) => {
      next = { ...cur, [key]: Math.max(lo, Math.min(hi, Math.round(startW + ev.clientX - startX))) }
      applyColVars(next, paneElRef.current) // 拖动中只改本窗格的 CSS 变量，松手才写配置
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('col-resizing')
      onColWidths?.(next)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const resetCol = (key) => {
    const cur = normalizeCols(pane.colWidths)
    onColWidths?.({ ...cur, [key]: key === 'name' ? null : DEFAULT_COLS[key] })
  }
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const sync = () => {
      if (colsInnerRef.current) colsInnerRef.current.style.transform = `translateX(${-el.scrollLeft}px)`
    }
    el.addEventListener('scroll', sync, { passive: true })
    return () => el.removeEventListener('scroll', sync)
  }, [])

  // ---------- 空白处拖拽框选（rubber band） ----------
  const rowsRef = useRef([])
  const marqueeRef = useRef(null)
  const [marqueeRect, setMarqueeRect] = useState(null)
  const suppressClickRef = useRef(false)

  const onMarqueeMove = (e) => {
    const m = marqueeRef.current
    const el = scrollRef.current
    if (!m || !el) return
    const rect = el.getBoundingClientRect()
    m.cx1 = e.clientX
    m.cy1 = e.clientY
    m.y1 = e.clientY - rect.top + el.scrollTop
    if (Math.abs(m.cx1 - m.cx0) > 3 || Math.abs(m.cy1 - m.cy0) > 3) m.moved = true
    setMarqueeRect({
      x: Math.min(m.cx0, m.cx1),
      y: Math.min(m.cy0, m.cy1),
      w: Math.abs(m.cx1 - m.cx0),
      h: Math.abs(m.cy1 - m.cy0),
    })
    const list = rowsRef.current
    if (!list.length) return
    const yA = Math.min(m.y0, m.y1)
    const yB = Math.max(m.y0, m.y1)
    const i0 = Math.max(0, Math.floor(yA / 28))
    const i1 = Math.min(list.length - 1, Math.floor((yB - 0.01) / 28))
    const next = new Set()
    for (let k = i0; k <= i1; k++) next.add(list[k].path)
    anchorRef.current = i1
    onSelect(tab.id, next)
  }

  const onMarqueeUp = () => {
    window.removeEventListener('mousemove', onMarqueeMove)
    window.removeEventListener('mouseup', onMarqueeUp)
    const m = marqueeRef.current
    if (m && !m.moved) {
      onSelect(tab.id, new Set()) // 空白处单击 = 取消选择
    }
    if (m && m.moved) {
      suppressClickRef.current = true
      setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
    }
    marqueeRef.current = null
    setMarqueeRect(null)
  }

  const startMarquee = (e) => {
    if (e.button !== 0) return
    const el = scrollRef.current
    if (!el) return
    onFocus(index)
    const rect = el.getBoundingClientRect()
    marqueeRef.current = {
      cx0: e.clientX,
      cy0: e.clientY,
      y0: e.clientY - rect.top + el.scrollTop,
      cx1: e.clientX,
      cy1: e.clientY,
      y1: e.clientY - rect.top + el.scrollTop,
      moved: false,
    }
    window.addEventListener('mousemove', onMarqueeMove)
    window.addEventListener('mouseup', onMarqueeUp)
  }

  const tab = pane.tabs[pane.active] || pane.tabs[0]

  // 移动成功后先从当前列表拿掉源路径，不必等目录重读返回。
  useEffect(() => {
    const onMoved = (event) => {
      const gone = new Set(event.detail?.paths || [])
      if (!gone.size) return
      setEntries((prev) => (prev ? prev.filter((entry) => !gone.has(entry.path)) : prev))
      let changed = false
      for (const dir of Object.keys(kidsRef.current)) {
        const kids = kidsRef.current[dir]
        if (!Array.isArray(kids)) continue
        const next = kids.filter((entry) => !gone.has(entry.path))
        if (next.length !== kids.length) {
          kidsRef.current[dir] = next
          changed = true
        }
      }
      if (changed) setKidsVersion((v) => v + 1)
    }
    window.addEventListener('bento-moved', onMoved)
    return () => window.removeEventListener('bento-moved', onMoved)
  }, [])

  useEffect(() => {
    let live = true
    setError(null)
    anchorRef.current = null
    api
      .listDir(tab.path, cfg.showHidden)
      .then((r) => {
        if (!live) return
        setEntries(r.entries)
      })
      .catch((e) => {
        if (!live) return
        setError(String(e))
        setEntries([])
      })
    return () => {
      live = false
    }
  }, [tab.id, tab.path, cfg.showHidden, tick])

  const rows = useMemo(() => {
    const base = entries || []
    const match = makeMatcher(filter)
    // 筛选时使用平铺列表
    if (match) return sortEntries(base.filter((e) => match(e.name)), tab.sortKey, tab.sortDir)
    // 树形展开：已展开文件夹的子条目就地插入
    const build = (list, depth) => {
      const withTimes = list.map((e) =>
        e.is_dir && activity[e.path] != null ? { ...e, mtime_ms: activity[e.path], btime_ms: activity[e.path] } : e
      )
      const out = []
      for (const e of sortEntries(withTimes, tab.sortKey, tab.sortDir)) {
        out.push({ ...e, depth })
        if (e.is_dir && expandedDirs.has(e.path)) {
          const kids = kidsRef.current[e.path]
          if (kids === null) out.push({ path: e.path + '/:loading', name: '载入中…', isPseudo: true, depth: depth + 1 })
          else if (kids.length === 0) out.push({ path: e.path + '/:empty', name: '（空文件夹）', isPseudo: true, depth: depth + 1 })
          else out.push(...build(kids, depth + 1))
        }
      }
      return out
    }
    return build(base, 0)
  }, [entries, filter, tab.sortKey, tab.sortDir, expandedDirs, kidsVersion, activity])
  rowsRef.current = rows

  const entryMap = useMemo(() => {
    const m = {}
    for (const r of rows) m[r.path] = r
    return m
  }, [rows])

  // 注册当前行数据到 App（供 ⌘A 全选 / ⌘↓ 打开 / 回车按设置打开或重命名）
  useEffect(() => {
    onRowsCache(tab.id, rows.filter((r) => !r.isPseudo))
  }, [rows, tab.id])

  // 目录活动时间：后台递归计算（限预算），完成后按活动时间重排
  useEffect(() => {
    if (!entries?.length) return
    const dirs = entries.filter((e) => e.is_dir).map((e) => e.path).slice(0, 200)
    if (!dirs.length) return
    let live = true
    api
      .dirActivity(dirs)
      .then((list) => {
        if (!live || !list?.length) return
        setActivity((prev) => {
          const next = { ...prev }
          let changed = false
          for (const d of list) {
            if (next[d.path] !== d.mtime_ms) {
              next[d.path] = d.mtime_ms
              changed = true
            }
          }
          return changed ? next : prev
        })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [entries, tick])

  // 搜索定位：行就绪后选中目标并滚动到可见处
  useEffect(() => {
    if (!reveal || entries === null) return
    const idx = rows.findIndex((r) => r.path === reveal.path)
    if (idx === -1) return
    onSelect(tab.id, new Set([reveal.path]))
    try {
      virt.scrollToIndex(idx, { align: 'center' })
    } catch {}
    onRevealDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, rows])

  // 向上汇报统计
  useEffect(() => {
    let selSize = 0
    for (const p of selection || []) {
      const e = entryMap[p]
      if (e && !e.is_dir) selSize += e.size
    }
    onStats(tab.id, {
      count: entries?.length ?? 0,
      selCount: selection?.size || 0,
      selSize,
    })
  }, [entryMap, selection, entries])



  // 切换标签页时重置展开状态与缓存
  useEffect(() => {
    setExpandedDirs(new Set())
    kidsRef.current = {}
  }, [tab.id])

  // 重新拉取已展开目录的内容（手动刷新 tick / 文件系统变化）；内容没变就不触发重渲染
  const entriesSig = (list) => list.map((e) => `${e.path}|${e.size}|${e.mtime_ms}|${e.is_dir}`).join('\n')
  const reloadKids = (only) => {
    const paths = Object.keys(kidsRef.current).filter(
      (p) => kidsRef.current[p] !== null && (!only || only.has(p))
    )
    if (!paths.length) return
    Promise.all(
      paths.map((p) =>
        api
          .listDir(p, cfg.showHidden)
          .then((r) => [p, r.entries])
          .catch(() => null)
      )
    ).then((res) => {
      let changed = false
      for (const x of res) {
        if (!x) continue
        const [p, list] = x
        const old = kidsRef.current[p]
        // old 为 undefined = 期间已折叠/切换标签页，丢弃过期结果
        if (old && entriesSig(old) !== entriesSig(list)) {
          kidsRef.current[p] = list
          changed = true
        }
      }
      if (changed) setKidsVersion((v) => v + 1)
    })
  }
  const reloadKidsRef = useRef(reloadKids)
  reloadKidsRef.current = reloadKids
  useEffect(() => {
    reloadKids()
  }, [tick])

  // 文件系统监听：当前目录 + 展开的子目录有文件新增/修改/删除时自动刷新，无需 ⌘R
  // 设置里「自动刷新目录」关闭时不登记监听（后端随之释放全部 FSEvents 流）
  const autoRefresh = cfg.autoRefresh !== false
  const watchRef = useRef({})
  watchRef.current = { tabId: tab.id, path: tab.path, showHidden: cfg.showHidden, autoRefresh }
  useEffect(() => {
    if (!autoRefresh) return
    const id = `pane-${tab.id}`
    setWatch(id, [tab.path, ...expandedDirs])
    return () => clearWatch(id)
  }, [tab.id, tab.path, expandedDirs, autoRefresh])
  useEffect(
    () =>
      onFsChange((dirs) => {
        const { tabId, path, showHidden, autoRefresh: on } = watchRef.current
        if (!on) return
        const changed = new Set(dirs)
        if (changed.has(path)) {
          api
            .listDir(path, showHidden)
            .then((r) => {
              const cur = watchRef.current
              if (cur.tabId !== tabId || cur.path !== path) return
              setEntries((prev) => (prev && entriesSig(prev) === entriesSig(r.entries) ? prev : r.entries))
            })
            .catch(() => {})
        }
        reloadKidsRef.current(changed)
      }),
    []
  )

  // 展开/折叠文件夹
  const toggleExpand = (e, entry) => {
    e.stopPropagation()
    const p = entry.path
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
    if (kidsRef.current[p] === undefined) {
      kidsRef.current[p] = null // 载入中
      api
        .listDir(p, cfg.showHidden)
        .then((r) => {
          kidsRef.current[p] = r.entries
          setKidsVersion((v) => v + 1)
        })
        .catch(() => {
          kidsRef.current[p] = []
          setKidsVersion((v) => v + 1)
        })
    }
  }

  // 地址栏进入编辑模式（点击路径空白/末尾区、铅笔、⌘L 或 ⌘⇧G 信号）
  const beginPathEdit = () => {
    editSeq.current += 1
    completeSeq.current += 1
    pathEditClosed.current = false
    setPathError(null)
    setCompletionList(null)
    caretRef.current = null
    setEditingPath(tab.path)
    setPathFocusNonce((n) => n + 1)
  }

  // 进入编辑后再聚焦并全选。不要依赖 editingPath：每次按键都会改它，全选会把后续输入冲掉。
  useEffect(() => {
    if (editingPath == null || !pathFocusNonce) return
    const el = pathInputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [pathFocusNonce])

  useEffect(() => {
    if (editPathSignal) beginPathEdit()
  }, [editPathSignal])

  // 导航后退出编辑模式
  useEffect(() => {
    editSeq.current += 1
    completeSeq.current += 1
    pathEditClosed.current = true
    setPathError(null)
    setCompletionList(null)
    setEditingPath(null)
  }, [tab.id, tab.path])

  const cancelPathEdit = () => {
    editSeq.current += 1
    completeSeq.current += 1
    pathEditClosed.current = true
    setPathError(null)
    setCompletionList(null)
    caretRef.current = null
    setEditingPath(null)
  }

  // 补全会替换整段文本。同步把光标放到末尾；值没变时 effect 不会跑，所以这里也直接拨一次。
  const writePathText = (text) => {
    caretRef.current = text.length
    setEditingPath(text)
    requestAnimationFrame(() => {
      const el = pathInputRef.current
      if (!el || el.value !== text) return
      try {
        el.setSelectionRange(text.length, text.length)
      } catch {}
    })
  }

  useEffect(() => {
    if (caretRef.current == null || editingPath == null) return
    const pos = caretRef.current
    caretRef.current = null
    const el = pathInputRef.current
    if (!el) return
    try {
      el.setSelectionRange(pos, pos)
    } catch {}
  }, [editingPath])

  useEffect(() => {
    if (!completions || completions.active < 0) return
    suggestRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [completions])

  const pathErrorText = (e) => {
    if (typeof e === 'string' && e.trim()) return e
    if (e && typeof e.message === 'string' && e.message.trim()) return e.message
    return '路径不存在'
  }

  // Enter / 失焦提交。失败时留在编辑态，不清空已输入的文本。
  // override 是字符串时用它（候选刚写入，受控输入的 DOM 值可能还是旧的）。
  const commitPathEdit = async (override) => {
    if (pathEditClosed.current || editingPath == null) return
    completeSeq.current += 1
    setCompletionList(null)
    const raw = typeof override === 'string' ? override : (pathInputRef.current?.value ?? editingPath)
    const v = raw.trim()
    if (!v) {
      setPathError('请输入路径')
      return
    }
    // 没改路径就直接回到面包屑，不必再问后端
    if (v === tab.path) {
      pathEditClosed.current = true
      setPathError(null)
      setEditingPath(null)
      return
    }
    const seq = ++editSeq.current
    try {
      const resolved = await api.resolvePath(v)
      if (seq !== editSeq.current || pathEditClosed.current) return
      pathEditClosed.current = true
      setPathError(null)
      setEditingPath(null)
      if (resolved !== tab.path) onNav(tab.id, resolved)
    } catch (err) {
      if (seq !== editSeq.current || pathEditClosed.current) return
      setPathError(pathErrorText(err))
    }
  }

  const requestCompletion = async () => {
    if (pathEditClosed.current || editingPath == null) return
    const v = (pathInputRef.current?.value ?? editingPath).trim()
    if (!v) return
    const seq = ++completeSeq.current
    try {
      const res = await api.completePath(v)
      if (seq !== completeSeq.current || pathEditClosed.current) return
      const matches = Array.isArray(res?.matches) ? res.matches : []
      if (!matches.length) return
      const base = typeof res.base === 'string' ? res.base : ''
      let text = typeof res.text === 'string' ? res.text : v
      let active = -1
      // 已经补到分叉点：Tab 再按一次才选定第一条。还没分叉（文本没变长）就直接选定第一条。
      if (matches.length > 1 && text === v) {
        active = 0
        const m = matches[0]
        text = `${base}${m.name}${m.is_dir ? '/' : ''}`
      }
      writePathText(text)
      setPathError(null)
      setCompletionList(matches.length > 1 ? { base, matches, active } : null)
    } catch {
      // 目录读不了或路径还不完整：保持原输入，不打断编辑
    }
  }

  const stepCompletion = (dir) => {
    const list = completionsRef.current
    if (!list?.matches?.length) return
    const n = list.matches.length
    const cur = list.active
    const i = cur < 0 ? (dir > 0 ? 0 : n - 1) : (cur + dir + n) % n
    const m = list.matches[i]
    writePathText(`${list.base}${m.name}${m.is_dir ? '/' : ''}`)
    setCompletionList({ ...list, active: i })
  }

  // navigate：Enter / 点击确认后按现有回车逻辑跳转。方向键和 Tab 只预览，不跳转。
  const acceptCompletion = (index, navigate) => {
    const list = completionsRef.current
    if (!list?.matches?.length) return
    const i = Math.max(0, Math.min(index, list.matches.length - 1))
    const m = list.matches[i]
    const text = `${list.base}${m.name}${m.is_dir ? '/' : ''}`
    writePathText(text)
    if (navigate) commitPathEdit(text)
    else setCompletionList({ ...list, active: i })
  }

  const onPathKeyDown = (e) => {
    const composing = e.nativeEvent.isComposing || e.keyCode === 229
    const list = completionsRef.current
    if (e.key === 'Tab') {
      // ⌃Tab 仍交给全局快捷键切换标签
      if (e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      if (composing) return
      if (list?.matches?.length > 1) stepCompletion(e.shiftKey ? -1 : 1)
      else requestCompletion()
      return
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && list?.matches?.length > 1 && !composing) {
      e.preventDefault()
      e.stopPropagation()
      stepCompletion(e.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (e.key === 'Enter') {
      if (composing) return
      e.preventDefault()
      e.stopPropagation()
      // 已经高亮某一条时 Enter 按该候选跳转；否则仍是原来的「按输入框内容跳转」
      if (list?.matches?.length > 1 && list.active >= 0) acceptCompletion(list.active, true)
      else commitPathEdit()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (list) {
        completeSeq.current += 1
        setCompletionList(null)
        return
      }
      cancelPathEdit()
      return
    }
    // 普通按键不外泄；⌘ 组合键（⌘C/⌘V/⌘A…）放行给全局文本快捷键
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation()
  }

  // 重命名输入框聚焦并选中主名（不含扩展名）
  useEffect(() => {
    if (renaming && renaming.path && renaming.tabId === tab.id) {
      const input = renameRef.current
      if (input) {
        input.focus()
        if (renaming.selectAll) {
          input.setSelectionRange(0, input.value.length)
        } else {
          const dot = input.value.lastIndexOf('.')
          input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
        }
      }
    }
    // 依赖 entries：新建后列表异步刷新，行渲染出来时才存在输入框
  }, [renaming?.path, entries])

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 14,
  })

  const rowClick = (e, entry, idx) => {
    if (entry.isPseudo) return
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    setClickFocus(entry.path)
    onFocus(index)
    let next
    if (e.metaKey || e.ctrlKey) {
      next = new Set(selection || [])
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      anchorRef.current = idx
    } else if (e.shiftKey && anchorRef.current != null) {
      next = new Set(selection || [])
      const [a, b] = [Math.min(anchorRef.current, idx), Math.max(anchorRef.current, idx)]
      for (let k = a; k <= b; k++) next.add(rows[k].path)
    } else {
      next = new Set([entry.path])
      anchorRef.current = idx
    }
    onSelect(tab.id, next)
  }

  const dragData = (entry) => {
    const cur = selection || new Set()
    const paths = cur.has(entry.path) ? Array.from(cur) : [entry.path]
    return JSON.stringify({ paths })
  }

  const internalDrag = (e) => [...(e.dataTransfer?.types || [])].includes(MIME)

  const handleDrop = (e, destPath) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    try {
      const { paths } = JSON.parse(e.dataTransfer.getData(MIME))
      if (paths?.length) onDropTransfer(destPath, paths, e.altKey ? 'copy' : 'move')
    } catch {}
  }

  const crumbs = useMemo(() => {
    const parts = tab.path.split('/').filter(Boolean)
    const segs = [{ label: 'Macintosh HD', path: '/' }]
    let acc = ''
    for (const p of parts) {
      acc += '/' + p
      segs.push({ label: basename('/' + p), path: acc })
    }
    return segs
  }, [tab.path])

  // 面包屑滚动到最右（未折叠时）
  useEffect(() => {
    const el = crumbsRef.current
    if (el && collapsedCount === 0) el.scrollLeft = el.scrollWidth
  }, [tab.path, collapsedCount])

  // 溢出自适应：路径变化先归零重测；塞不下就折叠前置层级，有富余则展开（留 8% 余量防振荡）
  const lastPathRef = useRef(tab.path)
  useLayoutEffect(() => {
    const el = crumbsRef.current
    if (!el || editingPath != null || crumbs.length <= 1) return
    if (lastPathRef.current !== tab.path) {
      lastPathRef.current = tab.path
      if (collapsedCount !== 0) {
        setCollapsedCount(0)
        return
      }
    }
    if (el.scrollWidth > el.clientWidth + 1 && collapsedCount < crumbs.length - 1) {
      setCollapsedCount((c) => Math.min(c + 1, crumbs.length - 1))
    } else if (
      collapsedCount > 0 &&
      el.scrollWidth < el.clientWidth * 0.92
    ) {
      setCollapsedCount((c) => c - 1)
    }
  }, [crumbs, collapsedCount, editingPath, tab.path])

  const renamingHere = renaming && renaming.tabId === tab.id ? renaming : null
  const kbdCurrent = clickFocus && selection?.has(clickFocus)
    ? clickFocus
    : rows.find((r) => !r.isPseudo && selection?.has(r.path))?.path

  return (
    <section
      ref={paneElRef}
      style={{ gridArea: area }}
      className={`pane${focused ? ' focused' : ''}${flash ? ' flash' : ''}${dropTarget === 'bg' ? ' drop-hover' : ''}`}
      onMouseDown={() => onFocus(index)}
      onContextMenu={(e) => {
        e.preventDefault()
        onBlankMenu(tab.id, e.clientX, e.clientY)
      }}
      onDragOver={(e) => {
        if (internalDrag(e)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move'
        }
      }}
      onDrop={(e) => handleDrop(e, tab.path)}
    >
      <div className="tabbar">
        {pane.tabs.map((t, k) => (
          <div
            key={t.id}
            className={`tab${k === pane.active ? ' on' : ''}`}
            title={t.path}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                e.stopPropagation()
                onCloseTab(t.id)
              } else if (e.button === 0) {
                onSwitchTab(index, k)
              }
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onTabMenu(t.id, e.clientX, e.clientY)
            }}
          >
            <IconFolder size={13} />
            <span className="tab-label">{labelOf(t.path, home)}</span>
            <button
              className="tab-close"
              title="关闭标签 (⌘W)"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onCloseTab(t.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="tab-new" title="新建标签 (⌘T)" onClick={() => onNewTab(index)}>
          +
        </button>
        <div className="tab-rest" onDoubleClick={() => onNewTab(index)} />
      </div>

      <div className="pane-head">
        <div className="navbtns">
          <button title="后退 (⌘[)" disabled={tab.hi <= 0} onClick={() => onBack(tab.id)}>
            <IconChevronLeft size={15} />
          </button>
          <button title="前进 (⌘])" disabled={tab.hi >= tab.history.length - 1} onClick={() => onForward(tab.id)}>
            <IconChevronRight size={15} />
          </button>
          <button title="上级目录 (⌘↑)" disabled={!parentPath(tab.path)} onClick={() => onNav(tab.id, parentPath(tab.path))}>
            <IconArrowUp size={15} />
          </button>
          <button title="刷新 (⌘R)" onClick={() => onNav(tab.id, tab.path, true)}>
            <IconRefresh size={14} />
          </button>
          <button title="编辑路径 (⌘L)" onClick={beginPathEdit}>
            <IconPencil size={14} />
          </button>
        </div>
        {editingPath != null ? (
          <div className={`path-edit${pathError ? ' invalid' : ''}`}>
            <input
              ref={pathInputRef}
              className="path-input"
              value={editingPath}
              title={pathError || '输入路径后回车跳转，Tab 补全，Esc 取消'}
              aria-invalid={pathError ? true : undefined}
              aria-errormessage={pathError ? `path-edit-error-${tab.id}` : undefined}
              aria-autocomplete="list"
              aria-expanded={completions?.matches?.length > 1 ? true : undefined}
              aria-controls={completions?.matches?.length > 1 ? `path-suggest-${tab.id}` : undefined}
              onChange={(e) => {
                // 继续输入时作废尚未返回的解析和补全，避免旧结果把窗格带走
                editSeq.current += 1
                completeSeq.current += 1
                setCompletionList(null)
                setEditingPath(e.target.value)
                if (pathError) setPathError(null)
              }}
              onKeyDown={onPathKeyDown}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => {
                if (suggestRef.current?.contains(e.relatedTarget)) return
                commitPathEdit()
              }}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
            />
            {completions?.matches?.length > 1 && (
              <div
                className="path-suggest"
                id={`path-suggest-${tab.id}`}
                ref={suggestRef}
                role="listbox"
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
              >
                {completions.matches.map((m, i) => (
                  <button
                    type="button"
                    key={m.name}
                    role="option"
                    data-active={i === completions.active ? 'true' : undefined}
                    className={i === completions.active ? 'on' : undefined}
                    aria-selected={i === completions.active}
                    title={m.is_dir ? `${m.name}/` : m.name}
                    onClick={() => acceptCompletion(i, true)}
                  >
                    {m.is_dir && <IconFolder size={13} />}
                    <span>
                      {m.name}
                      {m.is_dir ? '/' : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {pathError && !completions && (
              <div
                className="path-error"
                id={`path-edit-error-${tab.id}`}
                role="alert"
                onMouseDown={(e) => e.preventDefault()}
              >
                {pathError}
              </div>
            )}
          </div>
        ) : (
          <div
            className="crumbs"
            ref={crumbsRef}
            title="点击空白处编辑路径 (⌘L)"
            onMouseDown={(e) => {
              if (e.target === crumbsRef.current) {
                e.preventDefault()
                beginPathEdit()
              }
            }}
          >
            {collapsedCount > 0 && (
              <span
                className="crumb-more-wrap"
                onMouseEnter={(e) => {
                  clearTimeout(moreTimer.current)
                  const r = e.currentTarget.getBoundingClientRect()
                  setMoreMenu({ x: r.left, y: r.bottom + 6, segs: crumbs.slice(0, collapsedCount) })
                }}
                onMouseLeave={() => {
                  clearTimeout(moreTimer.current)
                  moreTimer.current = setTimeout(() => setMoreMenu(null), 250)
                }}
              >
                <button className="crumb-more" title="显示被折叠的上层目录">»</button>
              </span>
            )}
            {crumbs.slice(collapsedCount).map((c, i) => (
              <span key={c.path} style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
                {i + collapsedCount > 0 && <span className="crumb-sep">›</span>}
                <button
                  className={`crumb${i + collapsedCount === crumbs.length - 1 ? ' current' : ''}`}
                  onClick={() => onNav(tab.id, c.path)}
                >
                  {c.label}
                </button>
              </span>
            ))}
            {/* 常驻编辑入口：路径溢出铺满时也能点进来 */}
            <span
              className="crumbs-tail"
              title="点击编辑路径 (⌘L)"
              onMouseDown={(e) => {
                e.preventDefault()
                beginPathEdit()
              }}
            />
          </div>
        )}
        <div className="filterbox">
          <IconSearch size={13} />
          <input
            placeholder="筛选"
            value={filter}
            onChange={(e) => onFilter(tab.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                onFilter(tab.id, '')
                e.target.blur()
                return
              }
              if (!e.metaKey && !e.ctrlKey) e.stopPropagation()
            }}
          />
        </div>
      </div>

      <div className="cols" onContextMenu={(e) => {
        // 右键表头：勾选要显示的列（不要冒泡成窗格空白菜单）
        e.preventDefault()
        e.stopPropagation()
        onColMenu?.(e.clientX, e.clientY)
      }}>
        <div className="cols-inner" ref={colsInnerRef}>
          {[
            ['name', '名称', false],
            ['mtime', '修改日期', false],
            ['btime', '创建日期', false],
            ['size', '大小', true],
            ['kind', '种类', false],
          ]
            .filter(([key]) => key === 'name' || shownCols.includes(key))
            .map(([key, label, right]) => {
              const arrow = tab.sortKey === key && <span className="arrow">{tab.sortDir === 'asc' ? '▲' : '▼'}</span>
              return (
                <div
                  key={key}
                  className={`col-head${right ? ' right' : ''}`}
                  onClick={() => onSort(tab.id, key, tab.sortKey === key && tab.sortDir === 'asc' ? 'desc' : 'asc')}
                >
                  {right && arrow}
                  <span className="col-label">{label}</span>
                  {!right && arrow}
                  <span
                    className="col-resize"
                    title="拖动调整列宽（双击恢复默认；右键选择显示的列）"
                    onMouseDown={(e) => startColResize(e, key)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      resetCol(key)
                    }}
                  />
                </div>
              )
            })}
        </div>
      </div>

      <div
        className="rows"
        ref={scrollRef}
        tabIndex={0}
        aria-label="文件列表"
        onFocus={() => onFocus(index)}
        onMouseDown={(e) => {
          if (e.target === scrollRef.current || e.target === innerRef.current) {
            scrollRef.current?.focus({ preventScroll: true })
            startMarquee(e)
          }
        }}
      >
        {error ? (
          <div className="error">
            {error}
            <br />
            <button onClick={() => onNav(tab.id, tab.path, true)}>重试</button>
          </div>
        ) : entries === null ? (
          <div className="loading">载入中…</div>
        ) : rows.length === 0 ? (
          <div className="empty">{filter ? '没有匹配的项目' : '文件夹为空'}</div>
        ) : (
          <div className="rows-inner" ref={innerRef} style={{ height: virt.getTotalSize() }}>
            {virt.getVirtualItems().map((vi) => {
              const entry = rows[vi.index]
              const isRenaming = renamingHere?.path === entry.path
              return (
                <div
                  key={entry.path}
                  data-path={entry.isPseudo ? undefined : entry.path}
                  data-dir={entry.is_dir && !entry.isPseudo ? '1' : undefined}
                  className={`row${vi.index % 2 === 1 ? ' even' : ''}${selection?.has(entry.path) ? ' selected' : ''}${focused && kbdCurrent === entry.path ? ' kbd-current' : ''}${cutSet.has(entry.path) ? ' cut' : ''}${draggingPaths.has(entry.path) ? ' dragging' : ''}${
                    dropTarget === entry.path ? ' drop-target' : ''
                  }`}
                  style={{ transform: `translateY(${vi.start}px)` }}
                  onDragStart={(e) => e.preventDefault()}
                  onMouseDown={(e) => {
                    if (e.button !== 0 || entry.isPseudo) return
                    if (!e.target?.closest?.('input, textarea, button')) {
                      scrollRef.current?.focus({ preventScroll: true })
                    }
                    beginRowDrag(e, entry)
                  }}
                  onClick={(e) => {
                    if (rowSuppressRef.current) {
                      rowSuppressRef.current = false
                      return
                    }
                    rowClick(e, entry, vi.index)
                  }}
                  onDoubleClick={() => !entry.isPseudo && onOpen(tab.id, entry)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (entry.isPseudo) return
                    onFocus(index)
                    if (!selection?.has(entry.path)) onSelect(tab.id, new Set([entry.path]))
                    onMenu(tab.id, entry, e.clientX, e.clientY)
                  }}
                >
                  <div
                    className="row-name"
                    style={entry.depth ? { paddingLeft: entry.depth * 18 } : undefined}
                  >
                    {entry.is_dir ? (
                      <button
                        className={`disclosure${expandedDirs.has(entry.path) ? ' open' : ''}`}
                        title={expandedDirs.has(entry.path) ? '折叠' : '展开'}
                        onMouseDown={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        draggable={false}
                        onClick={(e) => toggleExpand(e, entry)}
                      >
                        <IconChevronRight size={12} />
                      </button>
                    ) : (
                      <span className="disclosure-spacer" />
                    )}
                    <span className="fileicon">
                      {entry.isPseudo ? null : (
                        <FileIcon path={entry.path} name={entry.name} isDir={entry.is_dir} ext={entry.ext} />
                      )}
                    </span>
                    {isRenaming ? (
                      <input
                        ref={renameRef}
                        className="rename-input"
                        value={renamingHere.value}
                        onChange={(e) => onRenameChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            e.stopPropagation()
                            onRenameCommit()
                            return
                          }
                          if (e.key === 'Escape') {
                            e.stopPropagation()
                            onRenameCancel()
                            return
                          }
                          if (!e.metaKey && !e.ctrlKey) e.stopPropagation()
                        }}
                        onBlur={onRenameCommit}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        draggable={false}
                      />
                    ) : (
                      <>
                        {(() => {
                          // 过长时只截断主干、始终露出扩展名（funn….pdf）
                          const [stem, ext] = splitName(entry.name, entry.is_dir)
                          return (
                            <span className="name" title={entry.name}>
                              <span className="name-stem">{stem}</span>
                              {ext && <span className="name-ext">{ext}</span>}
                            </span>
                          )
                        })()}
                        <button
                          className={`row-copy${copiedPath === entry.path ? ' copied' : ''}`}
                          title="复制路径"
                          onMouseDown={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          draggable={false}
                          onClick={(e) => {
                            e.stopPropagation()
                            copyText(entry.path)
                            showCopyToast(entry.path, e.currentTarget.getBoundingClientRect())
                          }}
                        >
                          {copiedPath === entry.path ? <IconCheck size={13} /> : <IconCopy size={13} />}
                        </button>
                      </>
                    )}
                  </div>
                  {shownCols.includes('mtime') && <span className="row-date">{fmtDate(entry.mtime_ms)}</span>}
                  {shownCols.includes('btime') && <span className="row-date">{fmtDate(entry.btime_ms)}</span>}
                  {shownCols.includes('size') && <span className="row-size">{entry.is_dir ? '--' : fmtSize(entry.size)}</span>}
                  {shownCols.includes('kind') && <span className="row-kind" title={kindOf(entry)}>{kindOf(entry)}</span>}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {moreMenu && (
        <div
          className="crumb-more-menu"
          style={{ left: moreMenu.x, top: moreMenu.y }}
          onMouseEnter={() => clearTimeout(moreTimer.current)}
          onMouseLeave={() => {
            clearTimeout(moreTimer.current)
            moreTimer.current = setTimeout(() => setMoreMenu(null), 200)
          }}
        >
          {moreMenu.segs.map((c) => (
            <button
              key={c.path}
              onClick={() => {
                setMoreMenu(null)
                onNav(tab.id, c.path)
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {copyToast && (
        <div
          className={`copy-toast${copyToast.placeLeft ? ' place-left' : ''}`}
          style={{ left: copyToast.x, top: copyToast.y }}
          title={copyToast.path}
        >
          <IconCheck size={13} />
          <span className="copy-toast-text">已复制：{copyToast.path}</span>
        </div>
      )}
      {marqueeRect && (
        <div
          className="marquee"
          style={{ left: marqueeRect.x, top: marqueeRect.y, width: marqueeRect.w, height: marqueeRect.h }}
        />
      )}
    </section>
  )
}
