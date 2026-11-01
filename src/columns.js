// 文件列表列：名称列默认固定 260px，其余列也固定像素，可在表头拖动调整宽度、
// 右键表头勾选显示哪些列。窗格上的 colWidths / colVisible 是当前文件夹的有效视图
// （全局默认，或 view-settings.json 里该路径的覆盖），不是窗格私有配置。
// 名称列为自适应（保存值为 null）时，窗格太窄会按优先级自动隐藏次要列；固定宽度时使用横向滚动。
// 宽度/模板以 CSS 变量写在窗格根元素上，拖动时直接改变量（不触发 React 渲染/写盘）。
export const NAME_MIN = 160
export const COL_MIN = 48
export const COL_MAX = 600
export const COL_GAP = 8
export const COL_PAD = 24
export const DEFAULT_COLS = { name: 260, size: 72, kind: 104, mtime: 130, btime: 130 }
// 默认显示 修改日期/大小/种类（与 QSpace 一致），创建日期按需右键勾选
export const DEFAULT_VIS = { mtime: true, btime: false, size: true, kind: true }
// 表头/行里的显示顺序：名称 | 修改日期 | 创建日期 | 大小 | 种类
export const COL_ORDER = ['mtime', 'btime', 'size', 'kind']
// 放不下时先隐藏谁（越靠前越先隐藏）
const DROP_ORDER = ['btime', 'kind', 'size', 'mtime']
export const COL_LABELS = [
  ['mtime', '修改日期'],
  ['btime', '创建日期'],
  ['size', '大小'],
  ['kind', '种类'],
]

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

export function normalizeCols(saved) {
  const out = { ...DEFAULT_COLS }
  for (const k of ['size', 'kind', 'mtime', 'btime']) {
    const v = Number(saved?.[k])
    if (Number.isFinite(v)) out[k] = clamp(Math.round(v), COL_MIN, COL_MAX)
  }
  const n = Number(saved?.name)
  if (saved?.name === null) out.name = null
  else if (saved?.name != null && Number.isFinite(n)) out.name = clamp(Math.round(n), 120, 1600)
  return out
}

export function normalizeVis(saved) {
  const out = { ...DEFAULT_VIS }
  for (const k of COL_ORDER) if (typeof saved?.[k] === 'boolean') out[k] = saved[k]
  return out
}

/**
 * 实际要显示的列（按 COL_ORDER 顺序）：用户勾选的列里，窗格宽度放不下时按 DROP_ORDER 依次隐藏。
 * 名称列手动固定宽度时不自动隐藏（交给横向滚动）。paneW 未知(0)时按用户勾选显示。
 */
export function fitColumns(vis, widths, paneW) {
  const want = COL_ORDER.filter((k) => vis[k])
  if (!paneW || widths.name != null) return want
  const total = (keys) => NAME_MIN + keys.reduce((s, k) => s + widths[k], 0) + COL_GAP * keys.length + COL_PAD
  let keep = want
  for (const k of DROP_ORDER) {
    if (total(keep) <= paneW) break
    keep = keep.filter((x) => x !== k)
  }
  return keep
}

export function applyColVars(cols, el, shown) {
  if (!el) return
  const s = el.style
  const w = normalizeCols(cols)
  const keys = shown || COL_ORDER
  const nameCol = w.name == null ? `minmax(${NAME_MIN}px, 1fr)` : `${w.name}px`
  s.setProperty('--c-template', [nameCol, ...keys.map((k) => `${w[k]}px`)].join(' '))
  const total = (w.name ?? NAME_MIN) + keys.reduce((a, k) => a + w[k], 0) + COL_GAP * keys.length + COL_PAD
  s.setProperty('--list-min', `${total}px`)
}
