/** 回车键在文件列表中的行为。默认 rename，与当前版本及访达一致。 */
export const ENTER_RENAME = 'rename'
export const ENTER_OPEN = 'open'

export const LIST_ROW_HEIGHT = 30

export function normalizeEnterAction(value) {
  return value === ENTER_OPEN ? ENTER_OPEN : ENTER_RENAME
}

/**
 * 文件列表快捷键 → 动作。
 * 只认「无 Shift/Alt/Ctrl」的组合；⌘↓ 打开、⌘↑ 回到上级（访达）。
 * 返回 null 表示交给其他逻辑。
 *
 * open      打开文件或进入文件夹
 * enterDir  仅当选中项是文件夹时进入
 * parent    上级目录
 * rename    重命名（多项则批量重命名）
 * next/prev/first/last/pageDown/pageUp  移动选择
 */
export function resolveListKey(e, enterAction) {
  if (!e || e.altKey || e.ctrlKey || e.shiftKey) return null
  if (e.metaKey) {
    if (e.key === 'ArrowDown') return 'open'
    if (e.key === 'ArrowUp') return 'parent'
    return null
  }
  switch (e.key) {
    case 'ArrowDown':
      return 'next'
    case 'ArrowUp':
      return 'prev'
    case 'ArrowRight':
      return 'enterDir'
    case 'ArrowLeft':
      return 'parent'
    case 'Home':
      return 'first'
    case 'End':
      return 'last'
    case 'PageDown':
      return 'pageDown'
    case 'PageUp':
      return 'pageUp'
    case 'Enter':
      return normalizeEnterAction(enterAction) === ENTER_OPEN ? 'open' : 'rename'
    case 'F2':
      return 'rename'
    default:
      return null
  }
}

/** 按动作计算下一个列表下标。index < 0 表示当前没有选中项。 */
export function listIndexAfterKey(action, index, count, pageSize) {
  if (count <= 0) return -1
  const page = Math.max(1, pageSize | 0)
  const missing = index < 0 || index >= count
  if (missing) {
    if (action === 'prev' || action === 'last' || action === 'pageUp') return count - 1
    if (action === 'next' || action === 'first' || action === 'pageDown') return 0
    return -1
  }
  switch (action) {
    case 'next':
      return Math.min(count - 1, index + 1)
    case 'prev':
      return Math.max(0, index - 1)
    case 'first':
      return 0
    case 'last':
      return count - 1
    case 'pageDown':
      return Math.min(count - 1, index + page)
    case 'pageUp':
      return Math.max(0, index - page)
    default:
      return index
  }
}

/** 一页大约能放下的行数，留一行重叠，避免翻页后完全不知道当前位置。 */
export function pageStride(clientHeight) {
  const height = Number.isFinite(clientHeight) && clientHeight > 0 ? clientHeight : LIST_ROW_HEIGHT * 10
  return Math.max(1, Math.floor(height / LIST_ROW_HEIGHT) - 1)
}
