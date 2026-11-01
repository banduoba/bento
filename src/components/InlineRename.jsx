import { useLayoutEffect, useRef } from 'react'
import { LIST_ROW_HEIGHT } from '../shortcuts'

// There is only one mirror/observer while a filename is being edited.
export default function InlineRename({ value, inputRef, viewportRef, onChange, onCommit, onCancel, onHeight }) {
  const mirrorRef = useRef(null)
  const refreshRef = useRef(null)
  const heightCallback = useRef(onHeight)
  heightCallback.current = onHeight
  const composing = useRef(false)
  const finished = useRef(false)

  useLayoutEffect(() => {
    const input = inputRef.current
    const mirror = mirrorRef.current
    const container = input?.parentElement
    const viewport = viewportRef.current
    if (!input || !mirror || !container) return
    const win = input.ownerDocument.defaultView
    let previousHeight = 0
    let horizontalOffset = 0
    let active = true
    const refresh = () => {
      if (!active) return
      const css = win.getComputedStyle(input)
      const number = key => parseFloat(css[key]) || 0
      const horizontal = number('paddingLeft') + number('paddingRight') + number('borderLeftWidth') + number('borderRightWidth')
      const borders = number('borderTopWidth') + number('borderBottomWidth')
      const containerCss = win.getComputedStyle(container)
      const naturalLeft = input.getBoundingClientRect().left - horizontalOffset
      const columnRight = container.getBoundingClientRect().right - (parseFloat(containerCss.paddingRight) || 0)
      let visibleLeft = naturalLeft
      let visibleRight = columnRight
      if (viewport) {
        const viewportCss = win.getComputedStyle(viewport)
        // clientWidth excludes borders and the vertical scrollbar; clientLeft also
        // handles a left-side scrollbar. Keep the editor inside the visible list.
        const clientLeft = viewport.getBoundingClientRect().left + viewport.clientLeft
        visibleLeft = Math.max(visibleLeft, clientLeft + (parseFloat(viewportCss.paddingLeft) || 0))
        visibleRight = Math.min(visibleRight, clientLeft + viewport.clientWidth - (parseFloat(viewportCss.paddingRight) || 0))
      }
      const hasIntersection = visibleRight > visibleLeft
      horizontalOffset = hasIntersection ? visibleLeft - naturalLeft : 0
      if (input.style.marginLeft !== `${horizontalOffset}px`) input.style.marginLeft = `${horizontalOffset}px`
      const available = hasIntersection ? Math.max(1, Math.floor(visibleRight - visibleLeft)) : 1
      const width = Math.min(available, Math.max(48, Math.ceil(mirror.getBoundingClientRect().width + horizontal + 2)))
      if (input.style.width !== `${width}px`) input.style.width = `${width}px`
      // scrollHeight measures actual browser soft wraps, including CJK and spaces.
      const oldHeight = input.style.height
      input.style.height = '0px'
      input.style.overflowY = 'hidden'
      const contentHeight = Math.ceil(input.scrollHeight + borders)
      const lineHeight = number('lineHeight') || 22
      const minimum = lineHeight + number('paddingTop') + number('paddingBottom') + borders
      const cap = Math.max(minimum, (viewport?.clientHeight || win.innerHeight) - 8)
      const height = Math.min(contentHeight, cap)
      input.style.height = oldHeight === `${height}px` ? oldHeight : `${height}px`
      input.style.overflowY = contentHeight > cap ? 'auto' : 'hidden'
      const rowHeight = Math.max(LIST_ROW_HEIGHT, height + 2)
      if (rowHeight !== previousHeight) {
        previousHeight = rowHeight
        heightCallback.current?.(rowHeight)
      }
    }
    refreshRef.current = refresh
    refresh()
    const observer = new ResizeObserver(refresh)
    observer.observe(container)
    if (viewport) observer.observe(viewport)
    win.addEventListener('resize', refresh)
    let scrollLeft = viewport?.scrollLeft
    const onScroll = () => {
      if (viewport.scrollLeft === scrollLeft) return
      scrollLeft = viewport.scrollLeft
      refresh()
    }
    viewport?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      active = false
      refreshRef.current = null
      observer.disconnect()
      win.removeEventListener('resize', refresh)
      viewport?.removeEventListener('scroll', onScroll)
    }
  }, [inputRef, viewportRef])

  useLayoutEffect(() => { refreshRef.current?.() }, [value])

  const finish = action => {
    if (finished.current) return
    finished.current = true
    action()
  }
  const stop = e => e.stopPropagation()
  return (
    <>
      <textarea
        ref={inputRef}
        className="rename-input"
        aria-label="重命名"
        rows={1}
        wrap="soft"
        value={value}
        onChange={e => onChange(e.target.value.replace(/[\r\n]/g, ''))}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false }}
        onKeyDown={e => {
          const isComposing = composing.current || e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229 || e.nativeEvent?.keyCode === 229
          if (e.key === 'Enter' || e.key === 'Escape') {
            e.stopPropagation()
            if (isComposing) return
            e.preventDefault()
            finish(e.key === 'Enter' ? onCommit : onCancel)
            return
          }
          // Meta/Ctrl text commands remain available to the existing text editor.
          if (!e.metaKey && !e.ctrlKey) e.stopPropagation()
        }}
        onBlur={() => finish(onCommit)}
        onMouseDown={stop}
        onClick={stop}
        onDoubleClick={stop}
        onContextMenu={stop}
        draggable={false}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
      />
      <span ref={mirrorRef} className="rename-measure" aria-hidden="true">{value || ' '}</span>
    </>
  )
}
