import { api } from './api'

// 侧边栏、列表、搜索共用。Rust 侧还有进程内缓存；这里避免同一路径反复过 IPC。
const cache = new Map()
const queued = new Set()
const listeners = new Set()
let flushTimer = 0
const BATCH = 64

export function getCachedIcon(path) {
  return cache.get(path)
}

export function subscribeSystemIcons(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function requestSystemIcons(paths) {
  let added = false
  const list = paths && typeof paths[Symbol.iterator] === 'function' ? paths : []
  for (const p of list) {
    if (typeof p !== 'string' || !p.startsWith('/')) continue
    if (cache.has(p) || queued.has(p)) continue
    queued.add(p)
    added = true
  }
  if (!added || flushTimer) return
  flushTimer = setTimeout(flush, 24)
}

function flush() {
  flushTimer = 0
  const batch = []
  for (const p of queued) {
    batch.push(p)
    if (batch.length >= BATCH) break
  }
  for (const p of batch) queued.delete(p)
  if (queued.size) flushTimer = setTimeout(flush, 32)
  if (!batch.length) return
  api
    .fileIcons(batch)
    .then((rows) => {
      const got = new Set()
      for (const row of rows || []) {
        if (!row?.path) continue
        got.add(row.path)
        cache.set(row.path, row)
      }
      for (const p of batch) {
        if (!got.has(p)) cache.set(p, { path: p, icon: null, template: false })
      }
      const updated = new Set(batch)
      for (const fn of listeners) fn(updated)
    })
    .catch(() => {
      // 不写入缓存，下次请求还能重试
    })
}
