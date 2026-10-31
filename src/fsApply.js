// 把一批目录变更按路径键贴进已有列表。reload 由调用方整表重读，这里不动。

export function entrySig(entry) {
  return `${entry.path}|${entry.name}|${entry.size}|${entry.mtime_ms}|${entry.btime_ms || 0}|${entry.is_dir ? 1 : 0}`
}

export function normalizeFsChanges(payload) {
  if (!Array.isArray(payload)) return []
  const out = []
  for (const item of payload) {
    if (typeof item === 'string') {
      if (item) out.push({ dir: item, reload: true, upserts: [], removes: [] })
      continue
    }
    if (!item || typeof item !== 'object' || !item.dir) continue
    out.push({
      dir: item.dir,
      reload: !!item.reload,
      upserts: Array.isArray(item.upserts) ? item.upserts : [],
      removes: Array.isArray(item.removes) ? item.removes : [],
    })
  }
  return out
}

function entryName(entry) {
  if (entry?.name) return entry.name
  const path = entry?.path || ''
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

export function applyDirDelta(list, delta, showHidden) {
  if (!Array.isArray(list) || !delta || delta.reload) return list
  const removes = new Set(delta.removes || [])
  const upserts = []
  for (const entry of delta.upserts || []) {
    if (!entry?.path) continue
    if (!showHidden && entryName(entry).startsWith('.')) {
      removes.add(entry.path)
      continue
    }
    removes.delete(entry.path)
    upserts.push(entry)
  }
  if (removes.size === 0 && upserts.length === 0) return list

  const upsertByPath = new Map()
  for (const entry of upserts) upsertByPath.set(entry.path, entry)

  let changed = false
  const next = []
  for (const entry of list) {
    if (removes.has(entry.path)) {
      changed = true
      continue
    }
    const updated = upsertByPath.get(entry.path)
    if (updated) {
      upsertByPath.delete(entry.path)
      if (entrySig(updated) !== entrySig(entry)) {
        changed = true
        next.push(updated)
      } else {
        next.push(entry)
      }
    } else {
      next.push(entry)
    }
  }
  for (const entry of upsertByPath.values()) {
    changed = true
    next.push(entry)
  }
  return changed ? next : list
}
