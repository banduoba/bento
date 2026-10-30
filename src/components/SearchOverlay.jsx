import { useEffect, useMemo, useRef, useState } from 'react'
import { api, fileSrc } from '../api'
import { fmtDate, fmtSize, isImage, extColor, copyText } from '../format'
import { IconFolder, IconSearch } from '../icons'
import ContextMenu from './ContextMenu'
import { startDrag } from '@crabnebula/tauri-plugin-drag'

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

// 高亮文件名里命中搜索词的片段（拆掉通配符后逐段高亮）
function Highlight({ text, query }) {
  const parts = useMemo(() => {
    const frags = [
      ...new Set(
        (query || '')
          .trim()
          .split(/\s+/)
          .flatMap((t) => (t.includes(':') ? [] : t.split(/[*?]+/)))
          .map((s) => s.trim())
          .filter((s) => s.length >= 1)
      ),
    ]
    if (!frags.length) return null
    const re = new RegExp(`(${frags.map(escapeRe).join('|')})`, 'gi')
    return text.split(re)
  }, [text, query])
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
  scope,
  sortBy,
  onScopeChange,
  onSortChange,
  onClose,
  onOpenEntry,
  onLocate,
  onReveal,
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
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

  // 防抖搜索 + 过期结果丢弃
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    const token = ++tokenRef.current
    if (!q) {
      setResults([])
      setBusy(false)
      return
    }
    setBusy(true)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      try {
        const r = await api.search(q, scope, scope === 'pane' ? root : null, showHidden)
        if (tokenRef.current !== token) return
        setResults(r || [])
        setSelIdx(0)
      } catch {
        if (tokenRef.current === token) setResults([])
      } finally {
        if (tokenRef.current === token) setBusy(false)
      }
    }, 250)
    return () => clearTimeout(timerRef.current)
  }, [query, scope, root, showHidden])

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
        .catch(() => live && setIdxStatus({ ready: true, entries: 0 }))
    poll()
    const t = setInterval(poll, 1500)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [scope])

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
        startDrag({ item: [d.item.path] })
          .catch(() => {})
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
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelIdx((i) => Math.min(i + 1, sorted.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(sorted[selIdx])
    }
  }

  const sorted = useMemo(() => {
    const arr = [...results]
    if (sortBy === 'btime') arr.sort((a, b) => (b.btime_ms || 0) - (a.btime_ms || 0))
    else if (sortBy === 'mtime') arr.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0))
    else if (sortBy === 'size') arr.sort((a, b) => (b.size || 0) - (a.size || 0))
    else if (sortBy === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    return arr // score：保持引擎返回的相关度顺序
  }, [results, sortBy])

  const menuItems = (item) => [
    { label: '打开', action: () => choose(item) },
    {
      label: item.is_dir ? '在聚焦窗格中打开' : '在聚焦窗格中打开所在文件夹',
      action: () => {
        onLocate(item.is_dir ? item.path : item.dir)
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

  return (
    <div className={`search-overlay${open ? "" : " hidden"}`} onMouseDown={onClose}>
      <div className="search-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="search-top">
          <IconSearch size={17} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索文件名：文本 / *通配* / ext:jpg / re:正则（空格分隔 = 且）"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
          {busy && <span className="search-busy">搜索中…</span>}
        </div>
        <div className="search-toolbar">
          <div className="tb-group">
            <span className="tb-label">范围</span>
            {SCOPES.map((s) => (
              <button key={s.id} className={`seg-btn${scope === s.id ? ' on' : ''}`} onClick={() => onScopeChange(s.id)}>
                {s.label}
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
          <span>
            {busy ? '搜索中…' : `${sorted.length} 个结果`}
            {scope === 'global' && idxStatus && !idxStatus.ready && (
              <span className="search-idx-hint">
                {' '}· 全局索引建立中（已收录 {idxStatus.entries.toLocaleString()} 条），当前结果来自系统索引
              </span>
            )}
            {scope === 'global' && idxStatus && idxStatus.ready && idxStatus.full_disk_access === false && (
              <span className="search-idx-hint">
                {' '}· 未授予「完全磁盘访问权限」，其他用户/资源库目录不在索引内（系统设置 → 隐私与安全性）
              </span>
            )}
          </span>
          <span className="search-syntax">* ? 通配 · ext:后缀 · re:正则 · 空格 = 且</span>
        </div>
        <div className="search-results">
          {query.trim() && !busy && sorted.length === 0 ? (
            <div className="search-empty">没有找到匹配的项目</div>
          ) : (
            sorted.map((item, i) => (
              <div
                key={item.path + i}
                className={`search-item${i === selIdx ? ' on' : ''}`}
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
                <span className="fileicon">
                  {item.is_dir ? (
                    <IconFolder size={22} />
                  ) : isImage(item.name.split('.').pop().toLowerCase()) ? (
                    <img className="thumb" src={fileSrc(item.path)} loading="lazy" alt="" draggable={false} />
                  ) : (
                    <span
                      className="exttile"
                      style={{ background: extColor(item.name.split('.').pop().toLowerCase()) }}
                    >
                      {(item.name.split('.').pop() || 'file').slice(0, 4)}
                    </span>
                  )}
                </span>
                <span className="search-main">
                  <span className="search-name" title={item.name}>
                    <Highlight text={item.name} query={query} />
                  </span>
                  <span className="search-dir" title={item.dir}>
                    {item.dir}
                  </span>
                </span>
                <span className="search-date">{fmtDate(item.btime_ms)}</span>
                <span className="search-size">{item.is_dir ? '--' : fmtSize(item.size)}</span>
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
              </div>
            ))
          )}
        </div>
        <div className="search-hint">
          ↑↓ 选择 · ↩ 打开 · 右键 更多操作 · Esc 关闭 · 范围：{SCOPES.find((s) => s.id === scope)?.label}
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
