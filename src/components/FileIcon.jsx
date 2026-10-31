import { useEffect, useState } from 'react'
import { fileSrc } from '../api'
import { isImage } from '../format'
import { IconFile, IconFolder } from '../icons'
import { getCachedIcon, requestSystemIcons, subscribeSystemIcons } from '../systemIcons'

function extOf(name, ext) {
  if (typeof ext === 'string' && ext) return ext.toLowerCase()
  const base = name || ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

// 列表与搜索共用：图片保留缩略图；其余走 NSWorkspace，约 16px。
export default function FileIcon({ path, name, isDir, ext }) {
  const [, setTick] = useState(0)
  const kind = extOf(name, ext)
  const thumb = !isDir && isImage(kind) && !!path
  useEffect(() => {
    if (thumb || !path) return
    requestSystemIcons([path])
    return subscribeSystemIcons((updated) => {
      if (!updated || updated.has(path)) setTick((n) => n + 1)
    })
  }, [path, thumb])

  if (thumb) {
    return <img className="thumb" src={fileSrc(path)} loading="lazy" alt="" draggable={false} />
  }
  const native = path ? getCachedIcon(path) : undefined
  if (native?.icon) {
    const tone = native.template ? 'sb-template-icon' : 'sb-color-icon'
    return (
      <img
        className={`sb-system-icon ${tone}`}
        src={native.icon}
        width={16}
        height={16}
        alt=""
        draggable={false}
      />
    )
  }
  return isDir ? <IconFolder size={16} /> : <IconFile size={16} />
}
