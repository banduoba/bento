import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { createExtractionTask } from './extractionTask.js'
export default function useExtractionFeedback(onTerminal, onStarted) {
 const [state, setState] = useState({ job: null, starting: false, cancelling: false, error: null })
 const task = useRef(null), callback = useRef(onTerminal), accepted = useRef(onStarted)
 callback.current = onTerminal
 accepted.current = onStarted
 useEffect(() => {
  const current = createExtractionTask({ api, onChange: setState, onTerminal: job => callback.current(job), onStarted: (job, context) => accepted.current?.(job, context) })
  task.current = current
  return () => { current.dispose(); if (task.current === current) task.current = null }
 }, [])
 const start = useCallback((paths, context) => task.current?.start(paths, context), [])
 const compress = useCallback((...args) => task.current?.compress(...args), [])
 const cancel = useCallback(() => task.current?.cancel(), [])
 const dismiss = useCallback(() => task.current?.dismiss(), [])
 return { ...state, start, compress, cancel, dismiss }
}
