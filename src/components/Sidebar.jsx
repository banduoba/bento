import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { api } from '../api'
import { labelOf } from '../format'
import { createFolderTree } from '../folderTree.js'
import { setWatch, clearWatch, onFsChange } from '../fsWatch.js'
import { IconDrive, IconFolder, IconHouse } from '../icons'
import { getCachedIcon, requestSystemIcons, subscribeSystemIcons } from '../systemIcons'
import homeIcon from '../assets/sidebar/Home.png'
import desktopIcon from '../assets/sidebar/Desktop.png'
import documentsIcon from '../assets/sidebar/Documents.png'
import downloadsIcon from '../assets/sidebar/Downloads.png'
import moviesIcon from '../assets/sidebar/Movies.png'
import musicIcon from '../assets/sidebar/Music.png'
import picturesIcon from '../assets/sidebar/Pictures.png'
import applicationsIcon from '../assets/sidebar/Applications.png'

const favoriteIcons = {
  Desktop: desktopIcon,
  Documents: documentsIcon,
  Downloads: downloadsIcon,
  Movies: moviesIcon,
  Music: musicIcon,
  Pictures: picturesIcon,
  // 只有收藏里已经有「应用程序」时才会命中，不新增侧边栏分区
  Applications: applicationsIcon,
}

function SystemIcon({ src, template }) {
  const kind = template ? 'sb-template-icon' : 'sb-color-icon'
  return <img className={`sb-system-icon ${kind}`} src={src} width={20} height={20} alt="" draggable={false} />
}

// Finder / QSpace 侧边栏用独立彩色字形。iconForFile 对 Desktop、Downloads 等
// 返回的是蓝文件夹加角标，不能用于这些已知目录。自定义收藏才用系统图标。
function bundledFavoriteSrc(favorite) {
  if (favorite?.name && Object.hasOwn(favoriteIcons, favorite.name)) return favoriteIcons[favorite.name]
  const tail = String(favorite?.path || '').split('/').filter(Boolean).pop()
  if (tail && Object.hasOwn(favoriteIcons, tail)) return favoriteIcons[tail]
  return null
}

function FavoriteIcon({ favorite, native }) {
  const src = bundledFavoriteSrc(favorite)
  if (src) return <SystemIcon src={src} template={false} />
  if (native?.icon) return <SystemIcon src={native.icon} template={!!native.template} />
  return <IconFolder size={20} />
}

const trace = (m) => invoke('log_debug', { msg: m }).catch(() => {})

const MIME = 'application/x-bento'

// 模块级组件：避免内嵌组件每次渲染重建导致元素重挂载（曾吞掉 click 事件）
function FavItem({ icon, label, path, removable, active, dropping, setDropKey, onOpen, onMenu, onDropPin, onToggle, expanded, expandable = true, depth = 0 }) {
  return (
    <div
      className={`sb-item${active ? ' active' : ''}${dropping ? ' sb-drop' : ''}`}
      title={path}
      role="link"
      tabIndex={0}
      style={depth ? { paddingLeft: 12 + depth * 14 } : undefined}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        onOpen(path)
      }}
      // 用 mousedown 触发导航：不依赖 click 事件合成
      onMouseDown={(e) => {
        if (e.button !== 0) return
        trace(`sb-mousedown path=${path}`)
        onOpen(path)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY, label, path, removable)
      }}
      onDragOver={(e) => {
        if ([...(e.dataTransfer?.types || [])].includes(MIME)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDragEnter={() => setDropKey(path)}
      onDragLeave={() => setDropKey((k) => (k === path ? null : k))}
      onDrop={(e) => {
        e.preventDefault()
        setDropKey(null)
        onDropPin(e)
      }}
    >
      {expandable ? (
        <button
          className="sb-disclosure"
          aria-label={`${expanded ? '收起' : '展开'} ${label}`}
          aria-expanded={!!expanded}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
          onKeyDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onToggle() }}
        >
          <svg
            className="sb-disclosure-icon"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M5.5 3.5 L10 8 L5.5 12.5" />
          </svg>
        </button>
      ) : <span className="sb-disclosure-space" />}
      {icon}
      <span className="sb-label">{label}</span>
    </div>
  )
}

function FolderBranch({ id, tree, branches, parent = null, leaf = false, depth = 0, ...row }) {
  const [limited, setLimited] = useState(false)
  const node = branches.get(id)
  const toggle = () => {
    setLimited(false)
    if (node) tree.close(id)
    else if (!tree.open(id, row.path, parent)) setLimited(true)
  }
  return (
    <>
      <FavItem {...row} depth={depth} expandable={!leaf} expanded={!!node} onToggle={toggle} />
      {limited && <div className="sb-tree-note" role="status">
        已展开 64 个文件夹，请先收起部分分支。
        <button onKeyDown={(e) => e.stopPropagation()} onClick={() => row.onOpen(row.path)}>在文件夹中查看全部</button>
      </div>}
      {node && <div className="sb-tree-children">
        {node.status === 'loading' && <div className="sb-tree-note" role="status">正在加载 {row.label}…</div>}
        {node.status === 'error' && <div className="sb-tree-note" role="status">
          {row.label}：{node.error}
          <button onKeyDown={(e) => e.stopPropagation()} onClick={() => tree.retry(id)}>重试</button>
        </div>}
        {node.entries.map(entry => <FolderBranch
          key={entry.path}
          id={`${id}\0${entry.path}`}
          parent={id}
          tree={tree}
          branches={branches}
          leaf={entry.is_symlink}
          depth={depth + 1}
          icon={<IconFolder size={20} />}
          label={entry.name}
          path={entry.path}
          removable={false}
          active={row.focusedPath === entry.path}
          focusedPath={row.focusedPath}
          dropping={false}
          setDropKey={row.setDropKey}
          onOpen={row.onOpen}
          onMenu={row.onMenu}
          onDropPin={row.onDropPin}
        />)}
        {node.status === 'ready' && node.entries.length === 0 && !node.truncated && <div className="sb-tree-note">没有子文件夹</div>}
        {node.truncated && <div className="sb-tree-note" role="status">
          此层文件夹较多，仅显示部分。
          <button onKeyDown={(e) => e.stopPropagation()} onClick={() => row.onOpen(row.path)}>在文件夹中查看全部</button>
        </div>}
      </div>}
    </>
  )
}

function WorkspaceItem({ ws, active, renaming, onSwitch, onMenu, onRenameChange, onRenameCommit, onRenameCancel }) {
  const inputRef = useRef(null)
  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [renaming])
  return (
    <div
      className={`sb-item ws-item${active ? ' active' : ''}`}
      title={active ? '当前工作区' : `切换到 ${ws.name}`}
      onMouseDown={(e) => {
        if (e.button !== 0 || renaming) return
        onSwitch(ws.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onMenu(e.clientX, e.clientY, ws.id, ws.name)
      }}
    >
      <span className="ws-dot" />
      {renaming ? (
        <input
          ref={inputRef}
          className="ws-rename"
          value={renaming.value}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') onRenameCommit()
            if (e.key === 'Escape') onRenameCancel()
          }}
          onBlur={onRenameCommit}
          onMouseDown={(e) => e.stopPropagation()}
          spellCheck={false}
        />
      ) : (
        <span>{ws.name}</span>
      )}
    </div>
  )
}

export default function Sidebar({
  home,
  favorites,
  focusedPath,
  tick,
  showHidden = false,
  autoRefresh = true,
  workspaces,
  activeWorkspace,
  wsRenaming,
  onSwitchWorkspace,
  onCreateWorkspace,
  onWorkspaceMenu,
  onWsRenameChange,
  onWsRenameCommit,
  onWsRenameCancel,
  onOpen,
  onMenu,
  onDropPin,
}) {
  const ref = useRef(null)
  const [tree] = useState(() => createFolderTree({ list: api.listSubdirectories, setWatch, clearWatch, onFsChange, showHidden, autoRefresh }))
  const [branches, setBranches] = useState(() => tree.snapshot())
  useEffect(() => {
    const unsubscribe = tree.subscribe(setBranches)
    tree.start()
    return () => { unsubscribe(); tree.stop() }
  }, [tree])
  useEffect(() => { tree.setOptions({ showHidden, autoRefresh }) }, [tree, showHidden, autoRefresh])
  const [vols, setVols] = useState([])
  const [dropKey, setDropKey] = useState(null)
  const [, setIconTick] = useState(0)

  useEffect(() => {
    let live = true
    api
      .listDir('/Volumes', false)
      .then((r) => live && setVols(r.entries.filter((e) => e.is_dir)))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [tick])

  useEffect(() => {
    tree.retainRoots([`home:${home}`, ...(favorites || []).map(f => `favorite:${f.path}`), ...vols.map(v => `volume:${v.path}`)])
  }, [tree, home, favorites, vols])

  // 列表、自定义收藏和卷需要 iconForFile（特殊目录在列表里仍是文件夹角标）。
  // 侧边栏展示时，已知特殊目录改用内置彩色字形，不读这份缓存。
  useEffect(() => {
    const paths = []
    if (home) paths.push(home)
    for (const f of favorites || []) if (f?.path) paths.push(f.path)
    for (const v of vols) if (v?.path) paths.push(v.path)
    const want = new Set(paths)
    requestSystemIcons(want)
    return subscribeSystemIcons((updated) => {
      for (const p of updated || []) {
        if (want.has(p)) {
          setIconTick((n) => n + 1)
          return
        }
      }
    })
  }, [home, favorites, vols])

  // 原生事件探针：确认 DOM 是否收到点击（与 React 合成事件无关）
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const h = (e) => trace(`native-click target=${e.target.className || e.target.tagName} title=${e.target.title || ''}`)
    el.addEventListener('click', h)
    return () => el.removeEventListener('click', h)
  }, [])

  return (
    <div className="sidebar" ref={ref}>
      <div className="sb-title">个人收藏</div>
      <FolderBranch
        id={`home:${home}`} tree={tree} branches={branches} focusedPath={focusedPath}
        icon={home
          ? <SystemIcon src={homeIcon} template={false} />
          : <IconHouse size={20} />}
        label="主目录"
        path={home}
        removable={false}
        active={focusedPath === home}
        dropping={dropKey === home}
        setDropKey={setDropKey}
        onOpen={onOpen}
        onMenu={onMenu}
        onDropPin={onDropPin}
      />
      {favorites.map((f) => (
        <FolderBranch
          id={`favorite:${f.path}`} tree={tree} branches={branches} focusedPath={focusedPath}
          key={f.path}
          icon={<FavoriteIcon favorite={f} native={getCachedIcon(f.path)} />}
          label={labelOf(f.path, home)}
          path={f.path}
          removable
          active={focusedPath === f.path}
          dropping={dropKey === f.path}
          setDropKey={setDropKey}
          onOpen={onOpen}
          onMenu={onMenu}
          onDropPin={onDropPin}
        />
      ))}

      {vols.length > 0 && (
        <>
          <div className="sb-title">位置</div>
          {vols.map((v) => (
            <FolderBranch
              id={`volume:${v.path}`} tree={tree} branches={branches} focusedPath={focusedPath}
              key={v.path}
              icon={getCachedIcon(v.path)?.icon
                ? <SystemIcon src={getCachedIcon(v.path).icon} template={!!getCachedIcon(v.path).template} />
                : <IconDrive size={20} />}
              label={v.name}
              path={v.path}
              removable={false}
              active={focusedPath === v.path}
              dropping={dropKey === v.path}
              setDropKey={setDropKey}
              onOpen={onOpen}
              onMenu={onMenu}
              onDropPin={onDropPin}
            />
          ))}
        </>
      )}

      <div className="sb-title ws-head">
        <span>工作区</span>
        <button className="sb-add" title="新建工作区" onClick={onCreateWorkspace}>
          +
        </button>
      </div>
      {(workspaces || []).map((w) => (
        <WorkspaceItem
          key={w.id}
          ws={w}
          active={w.id === activeWorkspace}
          renaming={wsRenaming?.id === w.id ? wsRenaming : null}
          onSwitch={onSwitchWorkspace}
          onMenu={onWorkspaceMenu}
          onRenameChange={onWsRenameChange}
          onRenameCommit={onWsRenameCommit}
          onRenameCancel={onWsRenameCancel}
        />
      ))}
    </div>
  )
}
