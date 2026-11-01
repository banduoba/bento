// Explicit commands handle macOS text shortcuts without requiring an Edit menu.
// Use its editing commands so typing, selection replacement, cut and paste share
// browser-managed undo history and emit the input events React listens for.
export function isTextEditingElement(el) {
  return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || !!el?.isContentEditable
}

function selectionSnapshot(doc, el) {
  if (!el.isContentEditable) return [el.selectionStart, el.selectionEnd, el.selectionDirection]
  const selection = doc.getSelection?.()
  if (!selection?.rangeCount) return []
  const range = selection.getRangeAt(0)
  return [range.startContainer, range.startOffset, range.endContainer, range.endOffset]
}

export function createTextEditing({ doc, readText, writeText, writeFallback }) {
  const pending = new Set()
  let disposed = false
  const cancelPending = () => { for (const cancel of [...pending]) cancel() }
  const command = (name, value = null) => doc.execCommand?.(name, false, value)
  const historyCommand = (name, el) => {
    // WebKit history belongs to the document. Cancel before it edits a different
    // root or restores that root's selection, keeping the invoking editor focused.
    let root = el
    if (el.isContentEditable) {
      while (root.parentElement?.isContentEditable) root = root.parentElement
    }
    const guard = e => {
      if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return
      if (e.target !== root && !root.contains?.(e.target)) e.preventDefault()
    }
    doc.addEventListener?.('beforeinput', guard, true)
    try { command(name) }
    finally { doc.removeEventListener?.('beforeinput', guard, true) }
  }
  const snapshot = el => {
    const selection = selectionSnapshot(doc, el)
    const value = el.isContentEditable ? el.textContent : el.value
    let cancelled = false
    const sameSelection = () => {
      const now = selectionSnapshot(doc, el)
      return now.length === selection.length && now.every((part, i) => part === selection[i])
    }
    const cancel = () => {
      cancelled = true
      cleanup()
    }
    const onEdit = e => { if (e.target === el || el.contains?.(e.target)) cancel() }
    const onSelection = () => { if (!sameSelection()) cancel() }
    const listeners = [['beforeinput', onEdit], ['input', onEdit], ['focusout', onEdit], ['selectionchange', onSelection]]
    const cleanup = () => {
      pending.delete(cancel)
      doc.defaultView?.removeEventListener('blur', cancel)
      for (const [type, listener] of listeners) doc.removeEventListener?.(type, listener, true)
    }
    pending.add(cancel)
    doc.defaultView?.addEventListener('blur', cancel)
    for (const [type, listener] of listeners) doc.addEventListener?.(type, listener, true)
    return {
      valid: () => !disposed && !cancelled && doc.activeElement === el && doc.hasFocus?.() !== false && el.isConnected !== false &&
        (el.isContentEditable ? el.textContent : el.value) === value && sameSelection(),
      cleanup,
    }
  }
  const clipboardCommand = async (key, el, selected) => {
    const original = snapshot(el)
    try {
      if (key === 'v') {
        const text = await readText()
        if (text && original.valid()) command('insertText', text)
      } else {
        try { await writeText(selected) }
        catch { if (!writeFallback) return; await writeFallback(selected) }
        if (key === 'x' && original.valid()) command('delete')
      }
    } catch {
      // A failed clipboard request must not delete text or bypass undo via .value.
    } finally {
      original.cleanup()
    }
  }
  return {
    handleKeyDown(e, el = doc.activeElement) {
      if (disposed || !isTextEditingElement(el) || !e.metaKey || e.altKey || e.ctrlKey || e.isComposing) return
      const key = e.key.toLowerCase()
      if (key === 'z') {
        e.preventDefault()
        cancelPending()
        historyCommand(e.shiftKey ? 'redo' : 'undo', el)
        return
      }
      if (e.shiftKey) return
      if (key === 'a') {
        e.preventDefault()
        cancelPending()
        if (el.isContentEditable) command('selectAll')
        else el.select?.()
        return
      }
      if (!['c', 'x', 'v'].includes(key)) return
      if ((key === 'x' || key === 'v') && (el.readOnly || el.disabled)) return
      const selected = el.isContentEditable
        ? doc.getSelection?.()?.toString() || ''
        : (el.value || '').slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
      if (key !== 'v' && !selected) return
      e.preventDefault()
      cancelPending()
      void clipboardCommand(key, el, selected)
    },
    dispose() { disposed = true; cancelPending() },
  }
}
