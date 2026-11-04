import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { createExtractionTask } from './extractionTask.js'
export default function useExtractionFeedback(onTerminal) {
 const [state, setState] = useState({ job: null, starting: false, cancelling: false, error: null })
 const task = useRef(null), callback = useRef(onTerminal)
 callback.current = onTerminal
 useEffect(() => {
  const current = createExtractionTask({ api, onChange: setState, onTerminal: job => callback.current(job) })
  task.current = current
  return () => { current.dispose(); if (task.current === current) task.current = null }
 }, [])
 const start = useCallback(paths => task.current?.start(paths), [])
 const cancel = useCallback(() => task.current?.cancel(), [])
 const dismiss = useCallback(() => task.current?.dismiss(), [])
 return { ...state, start, cancel, dismiss }
}
