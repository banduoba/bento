import { useEffect, useState } from 'react'
import { api } from '../api'
import { fmtSize } from '../format'

export default function StatusBar({ path, stats, progress }) {
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

  const parts = [`${stats?.count ?? 0} 个项目`]
  if (stats?.selCount > 0) {
    parts.push(`已选 ${stats.selCount} 个${stats.selSize ? `（${fmtSize(stats.selSize)}）` : ''}`)
  }

  return (
    <div className="statusbar">
      <span>{parts.join('，')}</span>
      <span>
        {progress ? (
          <span className="prog">{progress.mode === 'move' ? '移动' : '拷贝'}中 {progress.done}/{progress.total}…</span>
        ) : free != null ? (
          `可用空间 ${fmtSize(free)}`
        ) : (
          ''
        )}
      </span>
    </div>
  )
}
