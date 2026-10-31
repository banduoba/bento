import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { api } from '../api'
import { labelOf } from '../format'
import { IconDrive, IconFolder, IconHouse } from '../icons'
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
  return <img className={`sb-system-icon ${kind}`} src={src} width={16} height={16} alt="" draggable={false} />
}

function FavoriteIcon({ favorite, native }) {
  if (native?.icon) return <SystemIcon src={native.icon} template={!!native.template} />
  const tail = favorite.path.split('/').filter(Boolean).pop()
  const src = Object.hasOwn(favoriteIcons, favorite.name) ? favoriteIcons[favorite.name]
    : Object.hasOwn(favoriteIcons, tail) ? favoriteIcons[tail] : null
  return src
    ? <SystemIcon src={src} template />
    : <IconFolder size={15} />
}

const trace = (m) => invoke('log_debug', { msg: m }).catch(() => {})

const MIME = 'application/x-bento'

// 模块级组件：避免内嵌组件每次渲染重建导致元素重挂载（曾吞掉 click 事件）
function FavItem({ icon, label, path, removable, active, dropping, setDropKey, onOpen, onMenu, onDropPin }) {
  return (
    <div
      className={`sb-item${active ? ' active' : ''}${dropping ? ' sb-drop' : ''}`}
      title={path}
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
      {icon}
      <span>{label}</span>
    </div>
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
  const [vols, setVols] = useState([])
  const [dropKey, setDropKey] = useState(null)
  const [nativeIcons, setNativeIcons] = useState({})
  const iconCache = useRef({})

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

  // 主目录、收藏、卷都走 NSWorkspace。已取到的路径不再请求；失败则留给模板图 / IconDrive。
  useEffect(() => {
    const paths = []
    if (home) paths.push(home)
    for (const f of favorites || []) if (f?.path) paths.push(f.path)
    for (const v of vols) if (v?.path) paths.push(v.path)
    const missing = [...new Set(paths)].filter((p) => !Object.hasOwn(iconCache.current, p))
    if (!missing.length) return
    let live = true
    api.fileIcons(missing).then((rows) => {
      if (!live) return
      const next = { ...iconCache.current }
      const got = new Set()
      for (const row of rows || []) {
        if (!row?.path) continue
        got.add(row.path)
        next[row.path] = row
      }
      for (const p of missing) {
        if (!got.has(p)) next[p] = { path: p, icon: null, template: false }
      }
      iconCache.current = next
      setNativeIcons(next)
    }).catch(() => {})
    return () => {
      live = false
    }
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
      <FavItem
        icon={nativeIcons[home]?.icon
          ? <SystemIcon src={nativeIcons[home].icon} template={!!nativeIcons[home].template} />
          : home
            ? <SystemIcon src={homeIcon} template />
            : <IconHouse size={15} />}
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
        <FavItem
          key={f.path}
          icon={<FavoriteIcon favorite={f} native={nativeIcons[f.path]} />}
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
            <FavItem
              key={v.path}
              icon={nativeIcons[v.path]?.icon
                ? <SystemIcon src={nativeIcons[v.path].icon} template={!!nativeIcons[v.path].template} />
                : <IconDrive size={15} />}
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
