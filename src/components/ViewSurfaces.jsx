import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { parentPath } from '../format'
import FileIcon from './FileIcon'
import InlineRename from './InlineRename'

const TILE_WIDTH = 112
const TILE_HEIGHT = 108
const COLUMN_ROW_HEIGHT = 21

function keepEditorMounted(index) {
  return range => {
    const visible = defaultRangeExtractor(range)
    if (index >= 0 && !visible.includes(index)) visible.push(index)
    return visible.sort((a, b) => a - b)
  }
}

function sameTrail(a, b) {
  return a.length === b.length && a.every((entry, index) => entry.path === b[index].path)
}

function FileTile({ entry, selected, trailOpen, cut, current, renaming, viewportRef, renameRef, onRenameChange, onRenameCommit, onRenameCancel, onRenameHeight, onClick, onOpen, onMenu, onDragStart, onDrop, className }) {
  return <div
    data-path={entry.path}
    data-dir={entry.is_dir ? '1' : undefined}
    className={`${className}${selected ? ' selected' : ''}${trailOpen ? ' trail-open' : ''}${cut ? ' cut' : ''}${current ? ' kbd-current' : ''}`}
    title={entry.name}
    onClick={onClick}
    onDoubleClick={onOpen}
    onContextMenu={onMenu}
    onMouseDown={e => { if (e.button === 0 && !e.target?.closest?.('input, textarea, button')) onDragStart?.(e) }}
    onDragOver={e => { if (entry.is_dir) e.preventDefault() }}
    onDrop={e => { if (entry.is_dir) onDrop?.(e, entry.path) }}
  >
    <span className="view-file-icon"><FileIcon path={entry.path} name={entry.name} isDir={entry.is_dir} ext={entry.ext} /></span>
    {renaming
      ? <InlineRename inputRef={renameRef} viewportRef={viewportRef} value={renaming.value} onChange={onRenameChange} onCommit={onRenameCommit} onCancel={onRenameCancel} onHeight={onRenameHeight} />
      : <span className="view-file-name">{entry.name}</span>}
    {entry.is_dir && className === 'column-item' && <span className="column-chevron">›</span>}
  </div>
}

function useTileActions({ tabId, rows, selection, cutSet, focused, renaming, viewportRef, renameRef, onSelect, onFocus, onOpen, onMenu, onDragStart, onDropTransfer, index, scopeKey }) {
  const anchor = useRef(null)
  useEffect(() => { if (scopeKey === false) anchor.current = null }, [scopeKey])
  const select = (entry, event) => {
    onFocus(index)
    const position = rows.findIndex(item => item.path === entry.path)
    let next
    if (event.metaKey || event.ctrlKey) {
      next = new Set(selection)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
    } else if (event.shiftKey && anchor.current != null) {
      next = new Set(selection)
      for (let i = Math.min(anchor.current, position); i <= Math.max(anchor.current, position); i++) next.add(rows[i].path)
    } else next = new Set([entry.path])
    if (!event.shiftKey) anchor.current = position
    onSelect(tabId, next)
  }
  return entry => ({
    entry,
    selected: selection?.has(entry.path),
    cut: cutSet?.has(entry.path),
    current: focused && selection?.has(entry.path),
    renaming: renaming?.tabId === tabId && renaming.path === entry.path ? renaming : null,
    viewportRef, renameRef,
    onClick: event => select(entry, event),
    onOpen: () => onOpen(tabId, entry),
    onMenu: event => {
      event.preventDefault(); event.stopPropagation(); onFocus(index)
      if (!selection?.has(entry.path)) onSelect(tabId, new Set([entry.path]))
      onMenu(tabId, entry, event.clientX, event.clientY)
    },
    onDragStart: event => onDragStart?.(event, entry),
    onDrop: (event, path) => {
      event.preventDefault(); event.stopPropagation()
      try { const { paths } = JSON.parse(event.dataTransfer.getData('application/x-bento')); if (paths?.length) onDropTransfer(path, paths, event.altKey ? 'copy' : 'move') } catch {}
    },
  })
}

export function IconView(props) {
  const { rows, scrollRef, innerRef, paneWidth, tabId, renaming, renameRef } = props
  const columns = Math.max(1, Math.floor(Math.max(1, paneWidth - 24) / TILE_WIDTH))
  const [renameSize, setRenameSize] = useState(null)
  const previousRenameRow = useRef(-1)
  const tiles = useTileActions({ ...props, viewportRef: scrollRef, renameRef })
  const renameIndex = renaming?.tabId === tabId ? rows.findIndex(row => row.path === renaming.path) : -1
  const virtual = useVirtualizer({
    count: Math.ceil(rows.length / columns),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TILE_HEIGHT,
    overscan: 4,
    rangeExtractor: keepEditorMounted(renameIndex < 0 ? -1 : Math.floor(renameIndex / columns)),
    getItemKey: row => rows[row * columns]?.path ?? row,
  })
  useEffect(() => {
    const row = renameIndex < 0 ? -1 : Math.floor(renameIndex / columns)
    const previous = previousRenameRow.current
    if (previous >= 0 && previous !== row) virtual.resizeItem(previous, TILE_HEIGHT)
    if (row < 0 && previous >= 0) { setRenameSize(null); virtual.measure() }
    previousRenameRow.current = row
  }, [renameIndex, columns])
  useEffect(() => {
    if (renaming?.tabId !== tabId || !renaming.path) return
    const at = rows.findIndex(row => row.path === renaming.path)
    if (at < 0) return
    virtual.scrollToIndex(Math.floor(at / columns), { align: 'auto' })
    let frame = 0
    const focus = () => {
      const input = renameRef.current
      if (!input) { frame = requestAnimationFrame(focus); return }
      input.focus?.({ preventScroll: true })
      input.setSelectionRange?.(0, renaming.selectAll ? input.value.length : Math.max(0, input.value.lastIndexOf('.')) || input.value.length)
    }
    frame = requestAnimationFrame(focus)
    return () => cancelAnimationFrame(frame)
  }, [renaming?.path, rows, columns])
  useEffect(() => {
    if (!props.reveal || props.reveal.tabId !== tabId) return
    const at = rows.findIndex(row => row.path === props.reveal.path)
    if (at < 0) return
    if (!props.reveal.selectionPaths) props.onSelect(tabId, new Set([props.reveal.path]))
    virtual.scrollToIndex(Math.floor(at / columns), { align: 'center' })
    props.onRevealDone?.()
  }, [props.reveal, rows, columns])
  const onKeyDown = event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const current = [...(props.selection || [])].find(path => rows.some(row => row.path === path))
    const index = rows.findIndex(row => row.path === current)
    let next = index
    if (index < 0) next = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? rows.length - 1 : 0
    else if (event.key === 'ArrowUp') next = Math.max(0, index - columns)
    else if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, index + columns)
    else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1)
    else next = Math.min(rows.length - 1, index + 1)
    if (rows[next]) {
      props.onSelect(tabId, new Set([rows[next].path]))
      virtual.scrollToIndex(Math.floor(next / columns), { align: 'auto' })
    }
    event.preventDefault(); event.stopPropagation()
  }
  return <div className="rows icon-view" data-view-mode="icons" ref={scrollRef} tabIndex={0} aria-label="图标视图" onFocus={() => props.onFocus(props.index)} onClick={event => { if (!event.target?.closest?.('[data-path]')) props.onSelect(tabId, new Set()) }} onKeyDown={onKeyDown}>
    {props.loading && <div className="loading">载入中…</div>}
    {!props.loading && rows.length === 0 && <div className="empty">{props.emptyText}</div>}
    <div className="icon-rows" ref={innerRef} style={{ height: virtual.getTotalSize() }}>
      {virtual.getVirtualItems().map(row => <div key={row.key} className="icon-grid-row" style={{ transform: `translateY(${row.start}px)`, height: renameSize?.row === row.index ? renameSize.size : row.size, gridTemplateColumns: `repeat(${columns}, ${TILE_WIDTH}px)` }}>
        {rows.slice(row.index * columns, (row.index + 1) * columns).map(entry => <FileTile key={entry.path} {...tiles(entry)} className="icon-item" onRenameChange={props.onRenameChange} onRenameCommit={props.onRenameCommit} onRenameCancel={props.onRenameCancel} onRenameHeight={height => {
          if (renaming?.path !== entry.path) return
          const size = Math.max(TILE_HEIGHT, height + 62)
          virtual.resizeItem(row.index, size)
          setRenameSize(previous => previous?.row === row.index && previous.size === size ? previous : { row: row.index, size })
        }} />)}
      </div>)}
    </div>
  </div>
}


function Column({ depth, path, entries, pending, active, selection, trailPath, common, onChoose, onActivate, revealPath, keyboardTarget }) {
  const ref = useRef(null)
  const renameIndex = entries.findIndex(entry => entry.path === common.renaming?.path)
  const previousRenameIndex = useRef(-1)
  const virtual = useVirtualizer({
    count: entries.length,
    getScrollElement: () => ref.current,
    estimateSize: () => COLUMN_ROW_HEIGHT,
    overscan: 12,
    rangeExtractor: keepEditorMounted(renameIndex),
    getItemKey: index => entries[index]?.path ?? index,
  })
  const tiles = useTileActions({ ...common, rows: entries, selection: active ? selection : new Set(), viewportRef: ref, scopeKey: active })
  useEffect(() => {
    const previous = previousRenameIndex.current
    if (previous >= 0 && previous !== renameIndex) virtual.resizeItem(previous, COLUMN_ROW_HEIGHT)
    previousRenameIndex.current = renameIndex
  }, [renameIndex])
  useEffect(() => {
    if (renameIndex < 0) return
    virtual.scrollToIndex(renameIndex, { align: 'auto' })
    let frame = 0
    const focus = () => {
      const input = common.renameRef.current
      if (!input) { frame = requestAnimationFrame(focus); return }
      input.focus?.({ preventScroll: true })
      input.setSelectionRange?.(0, common.renaming.selectAll ? input.value.length : Math.max(0, input.value.lastIndexOf('.')) || input.value.length)
    }
    frame = requestAnimationFrame(focus)
    return () => cancelAnimationFrame(frame)
  }, [renameIndex, common.renaming?.path, entries])
  useEffect(() => {
    const target = keyboardTarget?.depth === depth ? keyboardTarget.index : -1
    if (target >= 0) virtual.scrollToIndex(target, { align: 'auto' })
  }, [keyboardTarget])
  useEffect(() => {
    if (!revealPath) return
    const at = entries.findIndex(entry => entry.path === revealPath)
    if (at >= 0) virtual.scrollToIndex(at, { align: 'center' })
  }, [revealPath, entries])
  return <div className={`column${active ? ' active' : ''}`} data-column-path={path} data-column-depth={depth}>
    <div className="column-header" title={path}>{depth === 0 ? path : path.slice(path.lastIndexOf('/') + 1)}</div>
    <div className="column-scroll" ref={ref}>
      {pending && <div className="column-status">载入中…</div>}
      {!pending && depth > 0 && entries.length === 0 && <div className="column-status">文件夹为空</div>}
      <div className="column-inner" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map(item => {
          const entry = entries[item.index]
          if (!entry) return null
          const tile = tiles(entry)
          return <div key={item.key} className="column-position" style={{ transform: `translateY(${item.start}px)`, height: item.size }}>
            <FileTile
              {...tile}
              className="column-item"
              selected={active && selection.has(entry.path)}
              trailOpen={trailPath === entry.path && !(active && selection.has(entry.path))}
              onRenameChange={common.onRenameChange}
              onRenameCommit={common.onRenameCommit}
              onRenameCancel={common.onRenameCancel}
              onRenameHeight={height => virtual.resizeItem(item.index, Math.max(COLUMN_ROW_HEIGHT, height))}
              onClick={event => { tile.onClick(event); onChoose(entry, depth) }}
              onMenu={event => { onActivate(depth); tile.onMenu(event) }}
              onOpen={entry.is_dir ? () => {} : tile.onOpen}
            />
          </div>
        })}
      </div>
    </div>
  </div>
}

export function ColumnView(props) {
  const { rows, tabId, path, selection, renaming, renameRef, kidsVersion, childrenForPath, sortEntries } = props
  const [trail, setTrail] = useState([])
  const [activeDepth, setActiveDepth] = useState(0)
  const [keyboardTarget, setKeyboardTarget] = useState(null)
  const levels = useMemo(
    () => [{ path, entries: rows, pending: false }, ...trail.map(folder => {
      const children = childrenForPath(folder.path)
      return { path: folder.path, entries: Array.isArray(children) ? sortEntries(children) : [], pending: !Array.isArray(children) }
    })],
    [path, rows, trail, kidsVersion, props.showHidden, props.sortKey, props.sortDir],
  )
  const depth = Math.min(activeDepth, levels.length - 1)
  const activeRows = levels[depth].entries
  const workingDirectory = trail.at(-1)?.path || path
  useLayoutEffect(() => {
    const rootSelection = new Set([...selection].filter(item => parentPath(item) === path))
    if (rootSelection.size !== selection.size) props.onSelect(tabId, rootSelection)
  }, [tabId, path])
  useEffect(() => () => { props.onActiveDirectory?.(tabId, path, null) }, [tabId, path])
  useEffect(() => { props.onColumnTrailChange(trail.map(folder => folder.path)) }, [trail, props.showHidden])
  useEffect(() => { props.onRowsCache(tabId, activeRows) }, [tabId, activeRows])
  useEffect(() => { props.onActiveDirectory?.(tabId, path, workingDirectory) }, [tabId, path, workingDirectory])
  useEffect(() => {
    const scroller = props.scrollRef.current
    if (scroller) scroller.scrollLeft = scroller.scrollWidth
  }, [trail])
  useEffect(() => {
    if (!props.reveal || props.reveal.tabId !== tabId || !rows.some(row => row.path === props.reveal.path)) return
    setActiveDepth(0)
    setTrail([])
    props.onSelect(tabId, new Set([props.reveal.path]))
    props.onRevealDone?.()
  }, [props.reveal, rows])
  useEffect(() => {
    const request = props.columnNavigate
    if (!request) return
    const targetDepth = request.target === path ? -1 : trail.findIndex(folder => folder.path === request.target)
    setTrail(targetDepth < 0 ? [] : trail.slice(0, targetDepth + 1))
    setActiveDepth(targetDepth + 1)
    props.onSelect(tabId, new Set())
  }, [props.columnNavigate?.nonce])
  useEffect(() => {
    if (!props.rootSettled) return
    let available = rows
    for (let i = 0; i < trail.length; i++) {
      if (i > 0 && levels[i].pending) return
      if (!available.some(entry => entry.path === trail[i].path)) {
        setTrail(trail.slice(0, i))
        setActiveDepth(current => Math.min(current, i))
        props.onSelect(tabId, new Set())
        return
      }
      available = levels[i + 1]?.entries || []
    }
  }, [rows, kidsVersion, trail, props.rootSettled])
  useEffect(() => {
    if (selection?.size !== 1 || activeRows.some(entry => selection.has(entry.path))) return
    const selected = [...selection][0]
    const selectedDepth = levels.findIndex(level => level.entries.some(entry => entry.path === selected))
    if (selectedDepth >= 0) setActiveDepth(selectedDepth)
  }, [selection, levels, activeRows])

  const openBranch = (entry, chosenDepth) => {
    setActiveDepth(chosenDepth)
    const next = trail.slice(0, chosenDepth)
    if (entry.is_dir) next.push(entry)
    setTrail(current => sameTrail(current, next) ? current : next)
  }
  const activate = chosenDepth => {
    setActiveDepth(chosenDepth)
    const next = trail.slice(0, chosenDepth)
    setTrail(current => sameTrail(current, next) ? current : next)
  }
  const onKeyDown = event => {
    if (event.metaKey || event.ctrlKey || event.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const current = [...selection].find(item => activeRows.some(entry => entry.path === item))
    const index = activeRows.findIndex(entry => entry.path === current)
    let next, nextDepth = depth
    if (event.key === 'ArrowUp') next = activeRows[index < 0 ? activeRows.length - 1 : Math.max(0, index - 1)]
    if (event.key === 'ArrowDown') next = activeRows[index < 0 ? 0 : Math.min(activeRows.length - 1, index + 1)]
    if (event.key === 'ArrowRight' && index >= 0 && activeRows[index]?.is_dir) {
      nextDepth = depth + 1
      next = levels[nextDepth]?.entries[0]
      if (!next && levels[nextDepth]) {
        setActiveDepth(nextDepth)
        props.onSelect(tabId, new Set())
      }
    }
    if (event.key === 'ArrowLeft' && depth > 0) {
      nextDepth = depth - 1
      next = trail[nextDepth]
      if (next) {
        setActiveDepth(nextDepth)
        setTrail(trail.slice(0, nextDepth + 1))
        props.onSelect(tabId, new Set([next.path]))
      }
    } else if (next) {
      props.onSelect(tabId, new Set([next.path]))
      openBranch(next, nextDepth)
    }
    if (!next && !(event.key === 'ArrowRight' && levels[nextDepth])) return
    if (next) setKeyboardTarget({ depth: nextDepth, index: levels[nextDepth].entries.findIndex(entry => entry.path === next.path), nonce: Date.now() })
    event.preventDefault(); event.stopPropagation()
  }
  const common = { ...props, renaming, renameRef }
  return <div
    className="rows columns-view"
    data-view-mode="columns"
    data-working-directory={workingDirectory}
    ref={props.scrollRef}
    tabIndex={0}
    aria-label={`分栏视图：${workingDirectory}`}
    onFocus={() => props.onFocus(props.index)}
    onClick={event => {
      if (event.target?.closest?.('[data-path]')) return
      const column = event.target?.closest?.('[data-column-depth]')
      if (!column) return
      activate(Number(column.dataset.columnDepth))
      props.onSelect(tabId, new Set())
    }}
    onKeyDown={onKeyDown}
  >
    {props.loading && <div className="loading">载入中…</div>}
    {!props.loading && rows.length === 0 && <div className="empty">{props.emptyText}</div>}
    {levels.map((level, levelDepth) => <Column
      key={level.path}
      depth={levelDepth}
      path={level.path}
      entries={level.entries}
      pending={level.pending}
      active={depth === levelDepth}
      selection={selection}
      trailPath={trail[levelDepth]?.path}
      common={common}
      onChoose={openBranch}
      onActivate={activate}
      revealPath={levelDepth === 0 ? props.reveal?.path : null}
      keyboardTarget={keyboardTarget}
    />)}
  </div>
}
