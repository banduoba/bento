import { useEffect, useState } from 'react'
import { api } from '../api'
import { fmtSize } from '../format'
import { listCountLabel } from '../dirLoad'

export default function StatusBar({ path, stats, children }) {
  const [free, setFree] = useState(null)

  useEffect(() => {
    let live = true
    api
      .diskSpace(path)
      .then((v) => live && setFree(v))
      .catch(() => live && setFree(null))
    return () => {
      live = false
    }
  }, [path])

  const parts = [listCountLabel(stats)]
  if (stats?.selCount > 0) {
    parts.push(`已选 ${stats.selCount} 个${stats.selSize ? `（${fmtSize(stats.selSize)}）` : ''}`)
  }

  return (
    <div className="statusbar">
      <span>{parts.join('，')}</span>
      <div className="statusbar-right">
        <span>{free != null ? `可用空间 ${fmtSize(free)}` : ''}</span>
        {children}
      </div>
    </div>
  )
}
