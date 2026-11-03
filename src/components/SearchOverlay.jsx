import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, fileSrc } from '../api'
import { fmtDate, fmtSize, copyText } from '../format'
import { IconCopy, IconSearch } from '../icons'
import FileIcon from './FileIcon'
import ContextMenu from './ContextMenu'
import { makeDragPreview, runNativeDrag } from '../nativeDrag'
import { FORMATS, searchError, searchRequestId } from '../search/model.js'

const SCOPES = [
  { id: 'global', label: '全局' },
  { id: 'pane', label: '当前文件夹' },
  { id: 'home', label: '主目录' },
]

const SORTS = [
  { id: 'btime', label: '创建日期' },
  { id: 'mtime', label: '修改日期' },
  { id: 'size', label: '大小' },
  { id: 'name', label: '名称' },
  { id: 'score', label: '相关度' },
]

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const SEARCH_TIMEOUT_MS = 8000
const HISTORY_KEY = 'bento-search-history'
const normalizeHistory = (items) => Array.isArray(items)
  ? [...new Set(items.filter((s) => typeof s === 'string').map((s) => s.trim()).filter(Boolean))].slice(0, 8)
  : []

function readHistory() {
  try {
    return normalizeHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'))
  } catch {
    return []
  }
}

function HistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 4.5V8l2.25 1.5" />
    </svg>
  )
}

function SearchGuide({ noResults = false }) {
  return (
    <div className="search-empty">
      <div className="search-empty-title">{noResults ? '没有找到匹配的项目' : '从文件名开始搜索'}</div>
      <p>{noResults ? '试试减少关键词、切换搜索范围，或使用以下语法。' : '输入关键词，或组合以下语法缩小范围。'}</p>
      <div className="search-examples">
        <span><code>*报告*</code> 通配符</span>
        <span><code>ext:pdf</code> 文件类型</span>
        <span><code>re:^IMG</code> 正则</span>
        <span><code>报告 2026</code> 同时匹配</span>
      </div>
    </div>
  )
}

// 内容预览高亮：与 Rust content_pattern/LineMatcher 一致——整串字面量（含 ':' 的词是过滤器，不参与；
// 双引号去掉），不拆词，大小写不敏感（仅用于着色，命中行以后端 matchLines 为准）。
function contentPattern(q) {
  return (q || '')
    .split(/\s+/)
    .filter((w) => w && !w.includes(':'))
    .join(' ')
    .replace(/"/g, '')
}

function Highlight({ text, query, literal = false }) {
  const parts = useMemo(() => {
    let frags
    if (literal) {
      const pat = contentPattern(query)
      frags = pat ? [pat] : []
    } else {
      frags = [
        ...new Set(
          (query || '')
            .trim()
            .split(/\s+/)
            .flatMap((t) => (t.includes(':') ? [] : t.split(/[*?]+/)))
            .map((s) => s.trim())
            .filter((s) => s.length >= 1)
        ),
      ]
    }
    if (!frags.length) return null
    const re = new RegExp(`(${frags.map(escapeRe).join('|')})`, 'gi')
    return text.split(re)
  }, [text, query, literal])
  if (!parts) return <>{text}</>
  return <>{parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p))}</>
}

/**
 * 聚焦搜索浮层（⌥⌘F）：范围/排序由 App 持久化；结果行支持右键菜单
 */
export default function SearchOverlay({
  open,
  root,
  showHidden,
  searchPaths,
  scope,
  sortBy,
  mode = 'name',
  onModeChange,
  onScopeChange,
  onSortChange,
  onClose,
  onOpenEntry,
  onLocate,
  onReveal,
}) {
  const [query, setQuery] = useState('')
  const [composing, setComposing] = useState(false)
  const [history, setHistory] = useState(readHistory)
  const [results, setResults] = useState([])
  const [format, setFormat] = useState('all')
  const [elapsed, setElapsed] = useState(null)
  const [response, setResponse] = useState(null)
  const [error, setError] = useState(null)
  const [retry, setRetry] = useState(0)
  const [preview, setPreview] = useState(null)
  const previewRef = useRef(null)
  const firstHitRef = useRef(null) // 选中结果的内容预览 {loading, kind, text, matchLines, truncated, path}
  const [busy, setBusy] = useState(false)
  const [fallbackIdx, setFallbackIdx] = useState(0)
  const [selectedPath, setSelectedPath] = useState(null)
  const [idxStatus, setIdxStatus] = useState(null) // fsearch 引擎状态
  const [menu, setMenu] = useState(null) // { x, y, item }
  const dragRef = useRef(null) // 原生拖拽状态
  const suppressClickRef = useRef(false)
  const inputRef = useRef(null)
  const tokenRef = useRef(0)
  const timerRef = useRef(null)
  const statusPendingRef = useRef(false)
  const menuRef = useRef(null)
  menuRef.current = menu

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
    } catch {}
  }, [history])

  const searchHistory = (term) => {
    setQuery(term)
    setSelIdx(0)
    inputRef.current?.focus()
  }

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select() // 选中上一次的搜索词，直接输入即替换
    }
  }, [open])

  // Esc：有右键菜单先关菜单，否则关浮层
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        if (menuRef.current) setMenu(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, open])

  // Invalidate before paint; a superseded response cannot affect results or busy state.
  useLayoutEffect(() => {
    const token = ++tokenRef.current
    setResults([])
    setResponse(null)
    setError(null)
    setElapsed(null)
    setPreview(null)
    setFallbackIdx(0)
    setSelectedPath(null)
    const q = query.trim()
    if (!open || !q || composing) { setBusy(false); return }
    setBusy(true)
    const requestId = searchRequestId()
    let settled = false
    let submitted = false
    let watchdog = null
    const cancel = () => {
      if (!submitted) return
      submitted = false
      api.cancelSearch(requestId).catch(() => {})
    }
    const t0 = performance.now()
    timerRef.current = setTimeout(async () => {
      submitted = true
      setHistory(items => normalizeHistory([q, ...items]))
      watchdog = setTimeout(() => {
        if (tokenRef.current !== token) return
        ++tokenRef.current
        cancel()
        setError('搜索超时，请重试或收窄搜索范围。')
        setBusy(false)
      }, SEARCH_TIMEOUT_MS)
      try {
        const r = await api.searchQuery(q, scope, scope === 'pane' ? root : null, showHidden, searchPaths, mode, requestId, format, partial => {
          if (tokenRef.current !== token || settled) return
          setResults(partial.items)
          setResponse(partial)
          setElapsed(Math.round(performance.now() - t0))
        })
        settled = true
        if (tokenRef.current !== token) return
        setResults(r.items)
        setResponse(r)
        setElapsed(Math.round(performance.now() - t0))
      } catch (error) {
        if (tokenRef.current === token) setError(searchError(error))
      } finally {
        settled = true
        clearTimeout(watchdog)
        submitted = false
        if (tokenRef.current === token) setBusy(false)
      }
    }, mode === 'name' ? 120 : 250)
    return () => {
      settled = true
      clearTimeout(timerRef.current)
      clearTimeout(watchdog)
      ++tokenRef.current
      cancel()
    }
  }, [open, query, scope, root, showHidden, searchPaths, mode, format, retry, composing])

  // 预览加载完成后滚动到第一处命中
  useEffect(() => {
    if (preview && !preview.loading && preview.kind === 'text' && preview.matchLines?.length) {
      requestAnimationFrame(() => firstHitRef.current?.scrollIntoView({ block: 'center' }))
    }
  }, [preview])

  // Keep status polling single flight, including a close/reopen while an invoke is pending.
  useEffect(() => {
    if (!open || scope !== 'global') {
      setIdxStatus(null)
      return
    }
    let live = true
    const poll = async () => {
      if (!live || statusPendingRef.current) return
      statusPendingRef.current = true
      try {
        const status = await api.fsearchStatus()
        if (live) setIdxStatus(status)
      } catch {
        if (live) setIdxStatus(null)
      } finally {
        statusPendingRef.current = false
      }
    }
    poll()
    const t = setInterval(poll, 1500)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [open, scope])

  const choose = (item) => {
    if (!item) return
    onOpenEntry(item)
    onClose()
  }

  const locate = (item) => {
    if (!item) return
    onLocate(item.dir, item.path)
    onClose()
  }

  const activateResult = (item) => {
    if (!item) return
    if (item.is_dir) choose(item)
    else locate(item)
  }

  // 搜索结果拖出应用到其他软件（原生拖拽）
  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current
      if (!d || d.started) return
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 6) {
        d.started = true
        suppressClickRef.current = true
        // 之前漏传 icon（插件要求必填）→ 会话从未启动；改用共用的预览图 + 全程 trace
        makeDragPreview(1, !!d.item.is_dir)
          .then((icon) => runNativeDrag([d.item.path], icon))
          .finally(() => {
            dragRef.current = null
            setTimeout(() => {
              suppressClickRef.current = false
            }, 0)
          })
      }
    }
    const onUp = () => {
      dragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const onKeyDown = (e) => {
    if (composing || e.isComposing || e.nativeEvent?.isComposing) return
    const count = query.trim() ? sorted.length : history.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelIdx((i) => Math.max(0, Math.min(i + 1, count - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (query.trim()) activateResult(sorted[selIdx])
      else if (history[selIdx]) searchHistory(history[selIdx])
    }
  }

  const sorted = useMemo(() => {
    const arr = results.slice()
    if (sortBy === 'btime') arr.sort((a, b) => (b.btime_ms || 0) - (a.btime_ms || 0))
    else if (sortBy === 'mtime') arr.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0))
    else if (sortBy === 'size') arr.sort((a, b) => (b.size || 0) - (a.size || 0))
    else if (sortBy === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    return arr // score：保持引擎返回的相关度顺序
  }, [results, sortBy])
  const selectedIndex = selectedPath ? sorted.findIndex(item => item.path === selectedPath) : -1
  const selIdx = query.trim() ? (selectedIndex >= 0 ? selectedIndex : Math.max(0, Math.min(fallbackIdx, sorted.length - 1))) : fallbackIdx
  const setSelIdx = update => {
    const next = typeof update === 'function' ? update(selIdx) : update
    setFallbackIdx(next)
    setSelectedPath(query.trim() ? sorted[next]?.path || null : null)
  }


  // 内容模式：选中结果变化 → 读取文件内容预览
  useEffect(() => {
    if (mode !== 'content' || !open) return
    const item = sorted[selIdx]
    if (!item) {
      setPreview(null)
      return
    }
    let live = true
    firstHitRef.current = null
    setPreview({ loading: true, path: item.path, name: item.name })
    api
      .readTextPreview(item.path, query)
      .then((d) => live && setPreview({ ...d, path: item.path, name: item.name }))
      .catch(() => live && setPreview({ kind: 'error', text: '', matchLines: [], path: item.path, name: item.name }))
    return () => {
      live = false
    }
  }, [selIdx, sorted, mode, open, query])


  const menuItems = (item) => [
    { label: '打开', action: () => choose(item) },
    {
      label: item.is_dir ? '在聚焦窗格中打开' : '在聚焦窗格中显示',
      action: () => {
        onLocate(item.is_dir ? item.path : item.dir, item.is_dir ? null : item.path)
        onClose()
      },
    },
    { sep: true },
    { label: '拷贝路径', action: () => copyText(item.path) },
    {
      label: '在终端打开',
      action: () => api.openTerminal(item.is_dir ? item.path : item.dir).catch(() => {}),
    },
    { label: '在访达中显示', action: () => onReveal(item.path) },
  ]

  const copyAction = (item) => (
    <button
      className="search-reveal search-copy"
      title="复制路径"
      aria-label={`复制路径：${item.path}`}
      draggable={false}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        copyText(item.path)
      }}
    >
      <IconCopy size={12} />
    </button>
  )

  const revealAction = (item) => (
    <button
      className="search-reveal search-finder"
      title="在访达中显示"
      aria-label={`在访达中显示：${item.path}`}
      draggable={false}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onReveal(item.path)
      }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6.5 3.5h-3v9h9v-3M8.5 2.5h5v5M13 3 7 9" />
      </svg>
    </button>
  )

  const resultName = (item) => (
    <span className="search-name-cell">
      {copyAction(item)}
      <span className="fileicon"><FileIcon path={item.path} name={item.name} isDir={item.is_dir} /></span>
      <span className="search-name" title={item.name}>
        {mode === 'name' ? <Highlight text={item.name} query={query} /> : item.name}
      </span>
    </span>
  )

  const createdDate = sortBy === 'btime'
  const dateLabel = createdDate ? '创建日期' : '修改日期'
  const indexBuilding = scope === 'global' && idxStatus && !idxStatus.ready
  const needsDiskAccess = scope === 'global' && idxStatus?.full_disk_access === false
  const warnings = [...new Set((response?.warnings || []).map(w => w.message).filter(Boolean))]
  const hasCoverageNotice = !busy && (response?.incomplete || response?.truncated || warnings.length > 0)
  const coverageSummary = response?.truncated ? '结果已截断，建议收窄范围'
    : hasCoverageNotice ? '结果可能不完整' : '名称索引准备中'
  const selectedItem = query.trim() ? sorted[selIdx] : null
  const resultActionLabel = selectedItem?.is_dir ? '打开文件夹' : '定位'

  return (
    <div className={`search-overlay${open ? '' : ' hidden'}`} aria-hidden={!open} inert={!open} onMouseDown={onClose}>
      <div className="search-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="search-top">
          <IconSearch size={17} />
          <input
            ref={inputRef}
            value={query}
            placeholder={mode === 'content' ? '搜索文件内容…' : '搜索文件名…'}
            aria-label={mode === 'content' ? '搜索文件内容' : '搜索文件名'}
            onChange={(e) => { setQuery(e.target.value); setSelIdx(0) }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
          <div className="search-scopes" role="group" aria-label="搜索范围">
            {SCOPES.map(s => (
              <button key={s.id} className={`seg-btn${scope === s.id ? ' on' : ''}`}
                aria-pressed={scope === s.id} onClick={() => {
                  setSelIdx(0)
                  setMenu(null)
                  onScopeChange(s.id)
                }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="search-toolbar">
          <div className="search-modes" role="group" aria-label="搜索方式">
            {[{ id: 'name', label: '名称' }, { id: 'content', label: '内容' }].map((m) => (
              <button key={m.id} className={`seg-btn${mode === m.id ? ' on' : ''}`}
                aria-pressed={mode === m.id} onClick={() => onModeChange(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="search-formats" role="group" aria-label="结果格式过滤">
            {FORMATS.map(f => (
              <button key={f.id} className={`seg-btn${format === f.id ? ' on' : ''}`}
                aria-pressed={format === f.id} title={f.extensions?.join(' · ')} onClick={() => {
                  setFormat(current => current === f.id ? 'all' : f.id)
                  setSelIdx(0)
                  setMenu(null)
                }}>
                {f.label}
              </button>
            ))}
          </div>
          <label className="search-select-label search-sort">
            <span>排序</span>
            <select aria-label="结果排序" value={sortBy} onChange={(e) => onSortChange(e.target.value)}>
              {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <details className="search-help">
            <summary>搜索语法</summary>
            <div className="search-help-content"><code>* ?</code> 通配符 · <code>ext:</code> 后缀 · <code>re:</code> 正则 · 空格 = 且</div>
          </details>
        </div>
        {error && <div className="search-notice search-error" role="alert"><span>{error}</span><button onClick={() => setRetry(n => n + 1)}>重试</button></div>}
        {needsDiskAccess && <div className="search-notice search-access" role="status">
          <span title="未授予完全磁盘访问权限，其他用户和资源库目录不在索引内（系统设置 → 隐私与安全性）">部分目录未索引：需完全磁盘访问权限</span>
          <button className="search-idx-settings-link" onClick={() => api.openPrivacySettings().catch((e) => alert(String(e)))}>
            打开系统设置
          </button>
        </div>}
        {(hasCoverageNotice || indexBuilding) && (
          <details className="search-coverage">
            <summary>{coverageSummary}<span className="search-coverage-more">详情</span></summary>
            <div className="search-coverage-details">
              {hasCoverageNotice && <>
                {response?.truncated && <div>结果已截断，请收窄搜索范围或关键词。</div>}
                {response?.incomplete && <div>搜索未穷尽，当前结果可能不完整。</div>}
                {warnings.map(message => <div key={message}>{message}</div>)}
              </>}
              {indexBuilding && <div>
                名称索引尚未就绪{idxStatus.entries > 0 ? `（已收录 ${idxStatus.entries.toLocaleString()} 条）` : ''}，{response && !busy ? '已显示可用结果' : '搜索将使用当前可用来源'}。
              </div>}
            </div>
          </details>
        )}
        <div className={`search-body${mode === 'content' ? ' two-col' : ''}`}>
        <div className={`search-list-pane${mode === 'name' ? ' search-name-table' : ''}`}>
        <div className="search-results" aria-label="搜索结果">
          {mode === 'name' && query.trim() && (
            <div className="search-columns">
              <span className="search-column-name">名称</span>
              <span className="search-column-dir">位置</span>
              <span className="search-column-size">大小</span>
              <span className="search-column-date">{dateLabel}</span>
            </div>
          )}
          {!query.trim() ? (
            history.length ? history.map((term, i) => (
              <button key={term} className={`search-history-item${i === selIdx ? ' on' : ''}`}
                onMouseEnter={() => setSelIdx(i)} onClick={() => searchHistory(term)}
                onKeyDown={(e) => e.stopPropagation()}>
                <HistoryIcon />
                <span>{term}</span>
                <span className="search-history-action" aria-hidden="true">搜索 ↵</span>
              </button>
            )) : <SearchGuide />
          ) : !busy && sorted.length === 0 ? (
            error || response?.incomplete ? <div className="search-empty">{error ? '请重试搜索。' : '当前扫描未返回匹配项，可收窄范围后重试。'}</div> : <SearchGuide noResults />
          ) : (
            sorted.map((item, i) => (
              <div
                key={item.path + i}
                className={`search-item${mode === 'content' ? ' search-item-content' : ''}${i === selIdx ? ' on' : ''}`}
                title={`${item.path}\n${item.is_dir ? '--' : fmtSize(item.size)}`}
                onMouseEnter={() => setSelIdx(i)}
                onMouseDown={(e) => {
                  if (e.button === 0) dragRef.current = { x: e.clientX, y: e.clientY, item, started: false }
                }}
                onClick={(e) => {
                  if (suppressClickRef.current || e.target.closest('button')) return
                  activateResult(item)
                }}
                onDoubleClick={(e) => {
                  if (suppressClickRef.current || e.target.closest('button')) return
                  activateResult(item)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setSelIdx(i)
                  setMenu({ x: e.clientX, y: e.clientY, item })
                }}
              >
                {mode === 'name' ? (
                  <>
                    {resultName(item)}
                    <span className="search-dir" title={item.dir}>{item.dir}</span>
                    <span className="search-size">{item.is_dir ? '--' : fmtSize(item.size)}</span>
                    <span className="search-date">{fmtDate(createdDate ? item.btime_ms : item.mtime_ms)}</span>
                  </>
                ) : (
                  <span className="search-main">
                    <span className="search-heading">
                      {resultName(item)}
                      <span className="search-date" title={dateLabel}>{fmtDate(createdDate ? item.btime_ms : item.mtime_ms)}</span>
                    </span>
                    <span className="search-details">
                      <span className="search-dir" title={item.dir}>{item.dir}</span>
                      {item.matches != null && <span className="search-matches">{item.matches >= 20 ? '20+' : item.matches} 行命中</span>}
                    </span>
                    {item.lines?.slice(0, 2).map(line => (
                      <span className="search-content-line" key={line.no}>
                        <span className="line-no">{line.no}</span>
                        <span className="line-text"><Highlight text={line.text} query={query} literal /></span>
                      </span>
                    ))}
                  </span>
                )}
                {revealAction(item)}
              </div>
            ))
          )}
        </div>
        </div>
        {mode === 'content' && (
          <div className="search-preview-pane" ref={previewRef}>
            {!preview && <div className="sp-message">搜索后在此预览文件内容</div>}
            {!preview || !preview.loading ? null : <div className="sp-loading">读取内容中…</div>}
            {preview?.loading === false && preview.kind === 'image' && (
              <div className="sp-image">
                <img src={`${fileSrc(preview.path)}`} alt="" draggable={false} />
              </div>
            )}
            {preview?.loading === false && preview.kind === 'binary' && (
              <div className="sp-message">二进制文件，无法预览文本内容</div>
            )}
            {preview?.loading === false && preview.kind === 'error' && (
              <div className="sp-message">无法读取该文件内容</div>
            )}
            {preview && preview.kind === 'text' && preview.text && (
              <>
                <div className="sp-head" title={preview.path}>
                  <span className="sp-matches">{preview.matchLines?.length ?? 0} 行命中</span>
                  <span className="sp-name">{preview.name}</span>
                  <button
                    className="search-reveal sp-copy"
                    title="复制路径"
                    aria-label={`复制路径：${preview.path}`}
                    onKeyDown={(e) => e.stopPropagation()}
                    onClick={() => copyText(preview.path)}
                  >
                    复制路径
                  </button>
                  {preview.truncated && (
                    <span className="sp-truncated">
                      （内容过大，仅显示前 256 KB）
                      {preview.hiddenHits > 0 &&
                        (preview.matchLines?.length
                          ? `另有 ${preview.hiddenHits} 行命中位于已截断部分之外`
                          : `命中位于已截断部分之外（共 ${preview.hiddenHits} 行），预览区内无命中`)}
                    </span>
                  )}
                </div>
                <div className="sp-lines">
                  {preview.text.split('\n').map((text, i) => {
                    const no = i + 1
                    const isMatch = preview.matchLines?.includes(no)
                    return (
                      <div
                        key={no}
                        className={`pl-line${isMatch ? ' hit' : ''}`}
                        data-line={no}
                        ref={isMatch && !firstHitRef.current ? firstHitRef : undefined}
                      >
                        <span className="pl-no">{no}</span>
                        <span className="pl-text">
                          <Highlight text={text} query={query} literal />
                        </span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
            {preview && preview.loading && <div className="sp-lines" />}
          </div>
        )}
        </div>
        <div className="search-footer">
          <span className="search-count" role="status" aria-live="polite">
            {!query.trim() ? '最近搜索' : busy ? (sorted.length ? `${sorted.length} 个结果 · 补充搜索中…` : '搜索中…') : error ? '搜索失败'
              : `${sorted.length} 个结果${elapsed != null ? ` · ${elapsed} ms` : ''}`}
          </span>
          {selectedItem && <span className="search-selected-path" title={selectedItem.path}>{selectedItem.path}</span>}
          <span className="search-hint" title={`↑↓ 选择 · 单击 / ↩ ${resultActionLabel} · 右键打开与更多操作 · Esc 关闭`}>
            ↑↓ 选择 · ↩ {query.trim() ? resultActionLabel : '搜索'} · Esc 关闭
          </span>
        </div>
      </div>
      {menu && (
        <ContextMenu
          menu={{ x: menu.x, y: menu.y, items: menuItems(menu.item) }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
