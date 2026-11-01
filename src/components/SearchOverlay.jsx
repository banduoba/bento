import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, fileSrc } from '../api'
import { fmtDate, fmtSize, copyText } from '../format'
import { IconSearch } from '../icons'
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
  const [selIdx, setSelIdx] = useState(0)
  const [idxStatus, setIdxStatus] = useState(null) // fsearch 引擎状态
  const [menu, setMenu] = useState(null) // { x, y, item }
  const dragRef = useRef(null) // 原生拖拽状态
  const suppressClickRef = useRef(false)
  const inputRef = useRef(null)
  const tokenRef = useRef(0)
  const timerRef = useRef(null)
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
    setSelIdx(0)
    const q = query.trim()
    if (!open || !q) { setBusy(false); return }
    setBusy(true)
    const requestId = searchRequestId()
    let submitted = false
    const t0 = performance.now()
    timerRef.current = setTimeout(async () => {
      submitted = true
      setHistory(items => normalizeHistory([q, ...items]))
      try {
        const r = await api.searchQuery(q, scope, scope === 'pane' ? root : null, showHidden, searchPaths, mode, requestId, format)
        if (tokenRef.current !== token) return
        setResults(r.items)
        setResponse(r)
        setElapsed(Math.round(performance.now() - t0))
      } catch (error) {
        if (tokenRef.current === token) setError(searchError(error))
      } finally {
        if (tokenRef.current === token) setBusy(false)
      }
    }, 250)
    return () => {
      clearTimeout(timerRef.current)
      ++tokenRef.current
      if (submitted) api.cancelSearch(requestId).catch(() => {})
    }
  }, [open, query, scope, root, showHidden, searchPaths, mode, format, retry])

  // 预览加载完成后滚动到第一处命中
  useEffect(() => {
    if (preview && !preview.loading && preview.kind === 'text' && preview.matchLines?.length) {
      requestAnimationFrame(() => firstHitRef.current?.scrollIntoView({ block: 'center' }))
    }
  }, [preview])

  // 全局范围时轮询 fsearch 索引状态（未建好时结果来自系统索引，需要提示）
  useEffect(() => {
    if (!open || scope !== 'global') {
      setIdxStatus(null)
      return
    }
    let live = true
    const poll = () =>
      api
        .fsearchStatus()
        .then((s) => live && setIdxStatus(s))
        .catch(() => live && setIdxStatus(null))
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
    const count = query.trim() ? sorted.length : history.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelIdx((i) => Math.max(0, Math.min(i + 1, count - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (query.trim()) choose(sorted[selIdx])
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

  const resultActions = (item) => (
    <span className="search-actions">
      <button
        className="search-reveal search-copy"
        title="复制路径"
        aria-label={`复制路径：${item.path}`}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          copyText(item.path)
        }}
      >
        复制路径
      </button>
      <button
        className="search-reveal"
        title="在访达中显示"
        onClick={(e) => {
          e.stopPropagation()
          onReveal(item.path)
        }}
      >
        访达
      </button>
    </span>
  )

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
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
          {busy && <span className="search-busy">搜索中…</span>}
        </div>
        <div className="search-toolbar">
          <div className="tb-group">
            <span className="tb-label">范围</span>
            {SCOPES.map((s) => (
              <button
                key={s.id}
                className={`seg-btn${scope === s.id ? ' on' : ''}`}
                onClick={() => onScopeChange(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="tb-group">
            <span className="tb-label">搜索</span>
            {[{ id: 'name', label: '名称' }, { id: 'content', label: '内容' }].map((m) => (
              <button
                key={m.id}
                className={`seg-btn${mode === m.id ? ' on' : ''}`}
                onClick={() => onModeChange(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="tb-group">
            <span className="tb-label">排序</span>
            {SORTS.map((s) => (
              <button key={s.id} className={`seg-btn${sortBy === s.id ? ' on' : ''}`} onClick={() => onSortChange(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="search-meta">
          <div className="search-status" aria-live="polite">
            <span className="search-count">
            {!query.trim()
              ? '最近搜索'
              : busy
                ? '搜索中…'
                : error ? '搜索失败' : `${sorted.length} 个结果${elapsed != null ? ` · ${elapsed} ms` : ''}`}
          </span>
            {scope === 'global' && idxStatus && !idxStatus.ready && (
              <span className="search-idx-hint">
                {' '}· 全局索引建立中（已收录 {idxStatus.entries.toLocaleString()} 条），{response?.source.includes('spotlight') ? '当前结果来自系统索引' : '等待索引就绪'}
              </span>
            )}
            {scope === 'global' && idxStatus && idxStatus.ready && idxStatus.full_disk_access === false && (
              <span className="search-idx-hint">
                {' '}· 未授予「完全磁盘访问权限」，其他用户/资源库目录不在索引内（系统设置 → 隐私与安全性）
              </span>
            )}
          </div>
          <span className="search-syntax"><code>* ?</code> 通配 · <code>ext:</code> 后缀 · <code>re:</code> 正则 · 空格 = 且</span>
        </div>
        {error && <div className="search-notice search-error" role="alert"><span>{error}</span><button onClick={() => setRetry(n => n + 1)}>重试</button></div>}
        {!busy && response && (response.incomplete || response.truncated) && <div className="search-notice" role="status">
          {response.truncated && <div>结果已截断，请收窄搜索范围或关键词。</div>}
          {response.incomplete && <div>搜索未穷尽，当前结果可能不完整。</div>}
          {response.warnings.map(w => <div key={w.code}>{w.message}</div>)}
        </div>}
        <div className="search-formats" role="group" aria-label="结果格式过滤">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              className={`seg-btn${format === f.id ? ' on' : ''}`}
              aria-pressed={format === f.id}
              title={f.extensions?.join(' · ')}
              onClick={() => {
                setFormat((current) => current === f.id ? 'all' : f.id)
                setSelIdx(0)
                setMenu(null)
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className={`search-body${mode === 'content' ? ' two-col' : ''}`}>
        <div className="search-results">
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
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false
                    return
                  }
                  choose(item)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setSelIdx(i)
                  setMenu({ x: e.clientX, y: e.clientY, item })
                }}
              >
                <span className="search-file">
                  <span className="fileicon">
                    <FileIcon path={item.path} name={item.name} isDir={item.is_dir} />
                  </span>
                  <span className="search-main">
                    <span className="search-heading">
                      <span className="search-name" title={item.name}>
                        {mode === 'content' ? (
                          item.name
                        ) : (
                          <Highlight text={item.name} query={query} />
                        )}
                      </span>
                      <span className="search-date">{fmtDate(item.btime_ms)}</span>
                    </span>
                    <span className="search-details">
                      <span className="search-dir" title={item.dir}>
                        {item.dir}
                      </span>
                      {mode === 'content' && item.matches != null && (
                        <span className="search-matches">{item.matches >= 20 ? '20+' : item.matches} 行命中</span>
                      )}
                    </span>
                  </span>
                </span>
                <span className="search-size">{item.is_dir ? '--' : fmtSize(item.size)}</span>
                {resultActions(item)}
              </div>
            ))
          )}
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
        <div className="search-hint">
          ↑↓ 选择 · ↩ {query.trim() ? '打开' : '搜索'} · {query.trim() && '右键 更多操作 · '}Esc 关闭 · 范围：{SCOPES.find((s) => s.id === scope)?.label}
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
