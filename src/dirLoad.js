// 分批目录加载的纯逻辑。窗格用 request id 丢掉过期批次；这里负责按路径合并，
// 以及把加载过程中的 FSEvents 增量再贴一遍，避免后面的扫描批次把已删除的路径加回来。
//
// 一批大约 500 条，和 `src-tauri/fswatch/src/stream.rs` 的 LIST_BATCH 一致。

import { applyDirDelta, entryName, entrySig } from './fsApply.js'

export const LIST_BATCH = 500

let nextRequestSerial = 0

export function nextLoadRequestId() {
  nextRequestSerial += 1
  return nextRequestSerial
}

export function isCurrentLoad(session, requestId) {
  return !!session && session.id === requestId && !session.cancelled && !session.done
}

// 视图设置会在导航之后的 layout 里把该文件夹记住的排序写回标签，往往赶在第一批之前。
// 扫描还没结束就要按新排序重来一次。列表已经在屏幕上时，改排序只在前端重排，不再整表重读。
export function shouldRestartLoad({ folderChanged, tickChanged, hasEntries, inFlight }) {
  if (folderChanged || tickChanged || !hasEntries) return true
  return !!inFlight
}

function emptyOverlay() {
  return { removes: new Set(), upserts: new Map() }
}

export function noteDelta(overlay, delta) {
  const base = overlay || emptyOverlay()
  const removes = new Set(base.removes)
  const upserts = new Map(base.upserts)
  for (const path of delta?.removes || []) {
    if (typeof path !== 'string' || !path) continue
    upserts.delete(path)
    removes.add(path)
  }
  for (const entry of delta?.upserts || []) {
    if (!entry?.path) continue
    removes.delete(entry.path)
    upserts.set(entry.path, entry)
  }
  return { removes, upserts }
}

// 同一路径只留一条。内容没变就沿用原来的对象，FSEvents 增量才不会把可见行整表换成新对象。
export function mergeByPath(prev, incoming) {
  const base = Array.isArray(prev) ? prev : []
  if (!Array.isArray(incoming) || incoming.length === 0) return base
  const fresh = new Map()
  for (const entry of incoming) {
    if (entry && typeof entry.path === 'string' && entry.path) fresh.set(entry.path, entry)
  }
  if (fresh.size === 0) return base
  let changed = base.length === 0
  const next = []
  for (const entry of base) {
    const updated = fresh.get(entry.path)
    if (!updated) {
      next.push(entry)
      continue
    }
    fresh.delete(entry.path)
    if (entrySig(updated) !== entrySig(entry)) {
      changed = true
      next.push(updated)
    } else {
      next.push(entry)
    }
  }
  for (const entry of fresh.values()) {
    changed = true
    next.push(entry)
  }
  return changed ? next : base
}

function withoutHidden(entries, showHidden) {
  if (showHidden || !Array.isArray(entries)) return entries
  return entries.filter((entry) => entry && !entryName(entry).startsWith('.'))
}

export function applyOverlay(list, overlay, showHidden) {
  if (!overlay) return list
  const removes = overlay.removes instanceof Set ? [...overlay.removes] : []
  const upserts = overlay.upserts instanceof Map ? [...overlay.upserts.values()] : []
  if (removes.length === 0 && upserts.length === 0) return list
  return applyDirDelta(list, { removes, upserts }, showHidden)
}

export function reduceLoadBatches(prev, batches, overlay, showHidden) {
  let merged = Array.isArray(prev) ? prev : []
  for (const batch of batches || []) {
    merged = mergeByPath(merged, withoutHidden(batch?.entries, showHidden))
  }
  return applyOverlay(merged, overlay, showHidden)
}

export function listCountLabel(stats) {
  const count = stats?.count ?? 0
  const countText = count.toLocaleString('zh-CN')
  const total = stats?.total
  if (stats?.listing && stats.listingLive && count === 0 && (typeof total !== 'number' || total === 0)) {
    return '正在读取…'
  }
  if (stats?.listing && stats.listingLive && typeof total === 'number' && total > count) {
    return `${countText} / ${total.toLocaleString('zh-CN')} 个项目`
  }
  if (stats?.listing && !stats.listingLive) return `${countText} 个项目 · 正在读取`
  return `${countText} 个项目`
}
