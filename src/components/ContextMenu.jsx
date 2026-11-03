import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronRight } from '../icons'
import FileIcon from './FileIcon'
import { menuPosition, submenuPosition } from '../contextMenuPosition'

function MenuButton({ item, onPick }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item${item.danger ? ' danger' : ''}${item.iconPath || item.iconSpace ? ' has-icon' : ''}`}
      disabled={item.disabled}
      data-label={item.label}
      title={item.title || item.label}
      onClick={() => onPick(item)}
    >
      {item.checked !== undefined && <span className="menu-check">{item.checked ? '✓' : ''}</span>}
      {(item.iconPath || item.iconSpace) && <span className="menu-app-icon" aria-hidden="true">
        {item.iconPath && <FileIcon path={item.iconPath} ext="app" />}
      </span>}
      <span className="menu-label">{item.label}</span>
      {item.shortcut && <span className="sc">{item.shortcut}</span>}
    </button>
  )
}

function SubMenu({ items, onPick, onEnter, onLeave, anchorRef, rootRef }) {
  const ref = useRef(null)
  const [box, setBox] = useState({ left: 8, top: 8 })

  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current
      const anchor = anchorRef.current
      const parent = rootRef.current
      if (!el || !anchor || !parent) return
      setBox(submenuPosition(parent.getBoundingClientRect(), anchor.getBoundingClientRect(), el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [items, anchorRef, rootRef])

  const content = (
    <div ref={ref} className="menu submenu" style={box} role="menu"
      onMouseEnter={onEnter} onMouseLeave={onLeave} onMouseDown={(e) => e.stopPropagation()}>
      <MenuItems items={items} onPick={onPick} rootRef={rootRef} />
    </div>
  )
  return createPortal(content, document.body)
}

function MenuBranch({ item, onPick, rootRef }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef(null)
  const closeTimer = useRef(null)
  const show = () => {
    clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const hide = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 160)
  }
  useEffect(() => () => clearTimeout(closeTimer.current), [])

  return (
    <div ref={anchorRef} className={`menu-sub${open ? ' open' : ''}`} onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        className="menu-item"
        data-label={item.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <span className="menu-label">{item.label}</span>
        <span className="sc chev" aria-hidden="true">
          <IconChevronRight size={12} />
        </span>
      </button>
      {open && <SubMenu items={item.children} onPick={onPick} onEnter={show} onLeave={hide} anchorRef={anchorRef} rootRef={rootRef} />}
    </div>
  )
}

function MenuItems({ items, onPick, rootRef }) {
  return items.map((it, i) =>
    it.sep ? (
      <hr key={`sep-${i}`} />
    ) : it.children ? (
      <MenuBranch key={`${it.label}-${i}`} item={it} onPick={onPick} rootRef={rootRef} />
    ) : (
      <MenuButton key={`${it.label}-${i}`} item={it} onPick={onPick} />
    )
  )
}

export default function ContextMenu({ menu, onClose, keyboard = false }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setPos(menuPosition(menu.x, menu.y, r.width, r.height, window.innerWidth, window.innerHeight))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [menu])

  useEffect(() => {
    const close = (e) => onClose(e)
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (keyboard) {
          e.preventDefault()
          e.stopPropagation()
        }
        onClose(e)
      } else if (keyboard && e.key === 'Tab') onClose(e)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, onClose, keyboard])

  useEffect(() => {
    if (keyboard) ref.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [keyboard])

  const onPick = (item) => {
    onClose({ type: 'pick' })
    item.action?.()
  }

  return (
    <div
      ref={ref}
      className="menu"
      style={pos}
      role="menu"
      onKeyDown={keyboard ? (e) => {
        // Pane-local menus are not tracked by App's global shortcut handler.
        e.stopPropagation()
        if (e.key === 'Escape' || e.key === 'Tab') {
          if (e.key === 'Escape') e.preventDefault()
          onClose(e)
          return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
        e.preventDefault()
        const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')]
        const active = buttons.indexOf(ref.current.ownerDocument.activeElement)
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
          : (active + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus({ preventScroll: true })
      } : undefined}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        if (keyboard) e.stopPropagation()
      }}
    >
      <MenuItems items={menu.items} onPick={onPick} rootRef={ref} />
    </div>
  )
}
