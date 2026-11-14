import { useEffect, useRef, useState } from 'react'
import { FILE_LABEL_EVENT, readFileLabels, validFileLabel } from './fileLabels'

// Metadata is loaded after paint, independently of directory/search results.
// Each mounted view has one active read and only its newest pending request.
export default function useFileLabels(paths, revision) {
  const key = [...new Set(paths.filter(path => typeof path === 'string' && path.startsWith('/')))].join('\0')
  const [labels, setLabels] = useState({})
  const [refresh, setRefresh] = useState(0)
  const epoch = useRef(0)
  const reader = useRef({ busy: false, pending: null })
  useEffect(() => {
    if (!key) return
    const visible = new Set(key.split('\0'))
    const invalidate = event => {
      const changed = Array.isArray(event?.detail) ? event.detail.filter(item => visible.has(item.path) && validFileLabel(item)) : null
      if (changed && !changed.length) return
      epoch.current++
      if (changed) setLabels(previous => {
        const next = { ...previous }
        for (const item of changed) next[item.path] = item.color
        return next
      })
      setRefresh(value => value + 1)
    }
    window.addEventListener(FILE_LABEL_EVENT, invalidate)
    window.addEventListener('focus', invalidate)
    return () => {
      epoch.current++
      window.removeEventListener(FILE_LABEL_EVENT, invalidate)
      window.removeEventListener('focus', invalidate)
    }
  }, [key])
  useEffect(() => {
    const task = { paths: key ? key.split('\0') : [], live: true, epoch: epoch.current }
    const state = reader.current
    state.pending = task
    const run = async () => {
      if (state.busy) return
      state.busy = true
      try {
        while (state.pending) {
          const request = state.pending
          state.pending = null
          const current = () => request.live && request.epoch === epoch.current
          if (!request.paths.length) { if (current()) setLabels(previous => Object.keys(previous).length ? {} : previous); continue }
          try {
            const result = await readFileLabels(request.paths, current)
            if (current()) setLabels(Object.fromEntries(result.filter(validFileLabel).map(item => [item.path, item.color])))
          } catch { /* Inaccessible metadata must not hide files or block first paint. */ }
        }
      } finally { state.busy = false }
    }
    void run()
    return () => { task.live = false; if (state.pending === task) state.pending = null }
  }, [key, revision, refresh])
  return labels
}
