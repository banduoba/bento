import { useEffect, useRef, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { hasTauri } from './api'
import { createUsageAnalytics, readAnalyticsEnabled, writeAnalyticsEnabled } from './usageAnalytics'

export default function useUsageAnalytics() {
  const [enabled, setEnabled] = useState(readAnalyticsEnabled)
  const stop = useRef(() => {})
  const revision = useRef(0)
  useEffect(() => {
    const environment = import.meta.env ?? {}
    if (!enabled || !hasTauri || environment.PROD !== true || environment.MODE === 'test' || !environment.VITE_BENTO_ANALYTICS_URL) return
    let live = true
    const requestRevision = revision.current
    const target = typeof __BENTO_BUILD_ARCH__ === 'string' ? __BENTO_BUILD_ARCH__ : ''
    const arch = target === 'aarch64' ? 'arm64' : target
    getVersion().then(version => {
      if (!live || revision.current !== requestRevision) return
      stop.current = createUsageAnalytics({ endpoint: environment.VITE_BENTO_ANALYTICS_URL, version, arch, native: hasTauri, production: true })
    }).catch(() => {})
    return () => { live = false; stop.current(); stop.current = () => {} }
  }, [enabled])
  const changeEnabled = value => {
    // Cancel before waiting for React's effect cleanup or a storage write.
    if (!value) { revision.current++; stop.current() }
    writeAnalyticsEnabled(value)
    setEnabled(value)
  }
  return [enabled, changeEnabled]
}
