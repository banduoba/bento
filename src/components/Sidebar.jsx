import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { api } from '../api'
import { labelOf } from '../format'
import { IconDrive, IconFolder, IconHouse } from '../icons'

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
        icon={<IconHouse size={15} />}
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
          icon={<IconFolder size={15} />}
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
              icon={<IconDrive size={15} />}
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
