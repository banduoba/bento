import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { hasTauri } from './api'

// 各窗格登记自己要监听的目录（当前目录 + 展开的子目录），这里取并集同步给后端。
// 切走或卸载时从并集拿掉，后端 unwatch 不再可见的路径。
// 后端把约 100ms 内的 FSEvents 收成一批，发 `fs-changed`：
// 能对上路径时是 { dir, reload:false, removes, upserts }，否则 { reload:true } 由窗格整表重读。
const owners = new Map() // ownerId -> string[]
const subs = new Set()
let pushTimer = null
let lastPushed = ''
let listening = false

function push() {
  const paths = [...new Set([...owners.values()].flat())].sort()
  const sig = paths.join('\n')
  if (sig === lastPushed) return
  lastPushed = sig
  invoke('set_watched', { paths }).catch(() => {})
}

function schedulePush() {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(push, 80)
}

export function setWatch(ownerId, paths) {
  if (!hasTauri) return
  owners.set(ownerId, paths)
  schedulePush()
}

export function clearWatch(ownerId) {
  if (!hasTauri) return
  owners.delete(ownerId)
  schedulePush()
}

export function onFsChange(cb) {
  if (!hasTauri) return () => {}
  subs.add(cb)
  if (!listening) {
    listening = true
    listen('fs-changed', (e) => subs.forEach((fn) => fn(e.payload || []))).catch(() => {
      listening = false
    })
  }
  return () => subs.delete(cb)
}
