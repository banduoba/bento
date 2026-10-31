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

/**
 * 窗格快捷键。
 * focusNext / focusPrev  Tab / Shift+Tab 切换活动窗格
 * copyToOther            F5 把选中项复制到另一窗格的当前目录
 * moveToOther            F6 把选中项移动到另一窗格的当前目录
 *
 * 不认 ⌘ / ⌥ / ⌃（⌃Tab 仍是窗格内换标签）。是否执行由调用方看可见窗格数：
 * 单窗格时焦点切换应放行，复制/移动应直接放弃。
 */
export function resolvePaneKey(e) {
  if (!e || e.metaKey || e.altKey || e.ctrlKey) return null
  if (e.key === 'Tab') return e.shiftKey ? 'focusPrev' : 'focusNext'
  if (e.shiftKey) return null
  if (e.key === 'F5') return 'copyToOther'
  if (e.key === 'F6') return 'moveToOther'
  return null
}

/** Tab 之后的活动窗格。不足两个窗格、或下标非法时返回 -1，调用方保持原样。 */
export function paneIndexAfterKey(action, active, count) {
  if (action !== 'focusNext' && action !== 'focusPrev') return -1
  if (!Number.isInteger(count) || count < 2) return -1
  if (!Number.isInteger(active) || active < 0 || active >= count) return -1
  const step = action === 'focusNext' ? 1 : count - 1
  return (active + step) % count
}

/**
 * F5/F6 的目标窗格。
 * 正好两个窗格时就是对侧。更多窗格时优先用刚离开的那个，对不上再取下一个。
 * 单窗格返回 -1。
 */
export function otherPaneIndex(active, count, previous) {
  if (!Number.isInteger(count) || count < 2) return -1
  if (!Number.isInteger(active) || active < 0 || active >= count) return -1
  if (count === 2) return 1 - active
  if (Number.isInteger(previous) && previous !== active && previous >= 0 && previous < count) return previous
  return (active + 1) % count
}
