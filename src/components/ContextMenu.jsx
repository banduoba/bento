import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconChevronRight } from '../icons'

function MenuButton({ item, onPick }) {
  return (
    <button
      type="button"
      className={`menu-item${item.danger ? ' danger' : ''}`}
      disabled={item.disabled}
      data-label={item.label}
      title={item.label}
      onClick={() => onPick(item)}
    >
      {item.checked !== undefined && <span className="menu-check">{item.checked ? '✓' : ''}</span>}
      <span className="menu-label">{item.label}</span>
      {item.shortcut && <span className="sc">{item.shortcut}</span>}
    </button>
  )
}

function SubMenu({ items, onPick, onEnter }) {
  const ref = useRef(null)
  const [box, setBox] = useState({ left: 'calc(100% - 4px)', top: -6 })

  useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const pr = parent.getBoundingClientRect()
    const width = el.offsetWidth
    const height = el.offsetHeight
    let left = parent.offsetWidth - 4
    if (pr.left + left + width > window.innerWidth - 8) left = -width + 4
    let top = -6
    if (pr.top + top + height > window.innerHeight - 8) {
      top -= pr.top + top + height - (window.innerHeight - 8)
    }
    if (pr.top + top < 8) top = 8 - pr.top
    setBox({ left, top })
  }, [items])

  return (
    <div
      ref={ref}
      className="menu submenu"
      style={{ left: box.left, top: box.top }}
      role="menu"
      onMouseEnter={onEnter}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MenuItems items={items} onPick={onPick} />
    </div>
  )
}

function MenuBranch({ item, onPick }) {
  const [open, setOpen] = useState(false)
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
    <div className={`menu-sub${open ? ' open' : ''}`} onMouseEnter={show} onMouseLeave={hide}>
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
      {open && <SubMenu items={item.children} onPick={onPick} onEnter={show} />}
    </div>
  )
}

function MenuItems({ items, onPick }) {
  return items.map((it, i) =>
    it.sep ? (
      <hr key={`sep-${i}`} />
    ) : it.children ? (
      <MenuBranch key={`${it.label}-${i}`} item={it} onPick={onPick} />
    ) : (
      <MenuButton key={`${it.label}-${i}`} item={it} onPick={onPick} />
    )
  )
}

export default function ContextMenu({ menu, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  useEffect(() => {
    const el = ref.current
    if (el) {
      const r = el.getBoundingClientRect()
      setPos({
        left: Math.min(menu.x, window.innerWidth - r.width - 8),
        top: Math.min(menu.y, window.innerHeight - r.height - 8),
      })
    }
    const close = () => onClose()
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, onClose])

  const onPick = (item) => {
    onClose()
    item.action?.()
  }

  return (
    <div
      ref={ref}
      className="menu"
      style={pos}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItems items={menu.items} onPick={onPick} />
    </div>
  )
}
