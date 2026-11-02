import { useLayoutEffect, useRef } from 'react'

export const isComposingKey = event => !!(event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229)

const visible = element => !!(element?.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
  element.getClientRects().length && !['hidden', 'collapse'].includes(element.ownerDocument.defaultView.getComputedStyle(element).visibility))

function tabStops(dialog) {
  const controls = [...dialog.querySelectorAll('a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && visible(element))
  return controls.filter(element => {
    if (element.type !== 'radio' || !element.name) return true
    const group = controls.filter(other => other.type === 'radio' && other.name === element.name && other.form === element.form)
    return element === (group.find(other => other.checked) || group[0])
  }).sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity))
}

// Capture during the opening render: React's host autoFocus runs before layout
// effects, so capturing there would mistake a dialog input for its trigger.
export default function useDialogFocus(open = true) {
  const ref = useRef(null)
  const opening = useRef(false)
  const trigger = useRef(null)
  if (open && !opening.current) trigger.current = globalThis.document?.activeElement
  opening.current = open

  useLayoutEffect(() => {
    const dialog = ref.current
    const doc = dialog?.ownerDocument
    if (!open || !doc) return
    const win = doc.defaultView
    const origin = trigger.current
    const hasFocus = () => doc.hasFocus()
    const topDialog = () => [...doc.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(visible).at(-1)
    let lastFocus = dialog.contains(doc.activeElement) ? doc.activeElement : null
    const focusInside = () => {
      const controls = tabStops(dialog)
      const target = controls.includes(lastFocus) ? lastFocus : controls[0] || dialog
      target.focus({ preventScroll: true })
    }
    const onFocus = event => {
      if (!hasFocus() || topDialog() !== dialog) return
      if (dialog.contains(event.target)) lastFocus = event.target
      else focusInside()
    }
    const onKey = event => {
      if (event.key !== 'Tab' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey ||
          isComposingKey(event) || !hasFocus() || topDialog() !== dialog) return
      const controls = tabStops(dialog)
      const index = controls.indexOf(doc.activeElement)
      const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0)
        : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
      event.preventDefault()
      event.stopPropagation()
      const target = controls[next] || dialog
      target.focus({ preventScroll: true })
    }
    win.addEventListener('keydown', onKey, true)
    doc.addEventListener('focusin', onFocus)
    if (hasFocus() && topDialog() === dialog && !dialog.contains(doc.activeElement)) focusInside()
    return () => {
      win.removeEventListener('keydown', onKey, true)
      doc.removeEventListener('focusin', onFocus)
      // Wait for React to remove the host nodes. StrictMode's effect probe keeps
      // them connected, and a replacement modal must retain its own focus.
      queueMicrotask(() => {
        if (dialog.isConnected || !hasFocus() || topDialog()) return
        const active = doc.activeElement
        if (active && active !== doc.body && active.isConnected && !dialog.contains(active)) return
        const target = origin?.tabIndex >= 0 && visible(origin) && !origin.matches(':disabled') &&
          !origin.closest('[role="menu"], [role="menuitem"]') ? origin
          : doc.querySelector('.pane.focused .rows, .pane.focused [tabindex="0"]')
        if (visible(target)) target.focus({ preventScroll: true })
      })
    }
  }, [open])

  return ref
}
