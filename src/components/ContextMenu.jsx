import { useEffect, useRef, useState } from 'react'

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

  return (
    <div
      ref={ref}
      className="menu"
      style={pos}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((it, i) =>
        it.sep ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            className={`menu-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.action?.()
            }}
          >
            {it.checked !== undefined && <span className="menu-check">{it.checked ? '✓' : ''}</span>}
            <span>{it.label}</span>
            {it.shortcut && <span className="sc">{it.shortcut}</span>}
          </button>
        )
      )}
    </div>
  )
}
