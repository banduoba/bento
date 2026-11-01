import { useEffect, useRef, useState } from 'react'
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, displayedSidebarWidth, normalizeSidebarWidth, sidebarWidthLimit } from '../sidebarWidth'

// Width previews belong here so moving the separator does not rerender the
// Sidebar tree or App's panes. Only a completed adjustment changes preferences.
export default function SidebarLayout({ width, onWidthCommit, children }) {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [draft, setDraft] = useState(null)
  const drag = useRef(null)
  const preferred = normalizeSidebarWidth(width)
  const max = sidebarWidthLimit(viewportWidth)
  const displayed = displayedSidebarWidth(draft ?? preferred, viewportWidth)
  const clamp = value => Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)))

  const release = active => {
    if (active.target.hasPointerCapture(active.id)) active.target.releasePointerCapture(active.id)
  }
  const cancel = (update = true) => {
    const active = drag.current
    drag.current = null
    if (update) setDraft(null)
    if (active) release(active)
  }

  useEffect(() => {
    const resize = () => { cancel(); setViewportWidth(window.innerWidth) }
    const blur = () => cancel()
    window.addEventListener('resize', resize)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('resize', resize)
      window.removeEventListener('blur', blur)
      cancel(false)
    }
  }, [])

  const finish = e => {
    const active = drag.current
    if (!active || active.id !== e.pointerId) return
    drag.current = null
    setDraft(null)
    release(active)
    if (active.value !== active.start) onWidthCommit(active.value)
  }
  const keyDown = e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const step = e.shiftKey ? 32 : 8
    let next
    switch (e.key) {
      case 'ArrowLeft': next = clamp(displayed - step); break
      case 'ArrowRight': next = clamp(displayed + step); break
      case 'Home': next = MIN_SIDEBAR_WIDTH; break
      case 'End': next = max; break
      case 'Escape': e.stopPropagation(); e.preventDefault(); cancel(); return
      case 'Enter': case ' ': e.stopPropagation(); e.preventDefault(); return
      case 'Tab': e.stopPropagation(); return
      default: return
    }
    e.stopPropagation()
    e.preventDefault()
    cancel()
    if (next !== displayed) onWidthCommit(next)
  }

  return (
    <div className={`sidebar-layout${draft !== null ? ' resizing' : ''}`} style={{ width: displayed }}>
      {children}
      <div
        className="sidebar-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={max}
        aria-valuenow={displayed}
        tabIndex={0}
        onPointerDown={e => {
          if (e.button !== 0 || drag.current) return
          e.preventDefault()
          e.stopPropagation()
          e.currentTarget.focus({ preventScroll: true })
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { id: e.pointerId, target: e.currentTarget, x: e.clientX, start: displayed, value: displayed }
          setDraft(displayed)
        }}
        onPointerMove={e => {
          const active = drag.current
          if (!active || active.id !== e.pointerId) return
          active.value = clamp(active.start + e.clientX - active.x)
          setDraft(active.value)
        }}
        onPointerUp={finish}
        onPointerCancel={e => { if (drag.current?.id === e.pointerId) cancel() }}
        // Unexpected capture loss and app switching both cancel, never persist.
        onLostPointerCapture={e => { if (drag.current?.id === e.pointerId) cancel() }}
        onKeyDown={keyDown}
        onDoubleClick={e => {
          e.preventDefault()
          e.stopPropagation()
          cancel()
          if (preferred !== DEFAULT_SIDEBAR_WIDTH) onWidthCommit(DEFAULT_SIDEBAR_WIDTH)
        }}
      />
    </div>
  )
}
