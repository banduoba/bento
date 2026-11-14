import { api } from './api'

export const FILE_LABEL_EVENT = 'bento-file-labels'
export const FILE_LABEL_COLORS = [
  { value: 6, label: '红色', color: '#ff3b30', rgb: '255, 59, 48' },
  { value: 7, label: '橙色', color: '#ff9500', rgb: '255, 149, 0' },
  { value: 5, label: '黄色', color: '#ffcc00', rgb: '255, 204, 0' },
  { value: 2, label: '绿色', color: '#34c759', rgb: '52, 199, 89' },
  { value: 4, label: '蓝色', color: '#007aff', rgb: '0, 122, 255' },
  { value: 3, label: '紫色', color: '#af52de', rgb: '175, 82, 222' },
  { value: 1, label: '灰色', color: '#8e8e93', rgb: '142, 142, 147' },
]
export const validFileLabel = item => item && !item.error && typeof item.path === 'string' && Number.isInteger(item.color) && item.color >= 0 && item.color <= 7
export const labelColor = value => FILE_LABEL_COLORS.find(color => color.value === value)
export const fileLabelStyle = value => {
  const color = labelColor(value)
  return color ? { '--file-label-color': color.color, '--file-label-bg': `rgba(${color.rgb}, .18)`, '--file-label-hover': `rgba(${color.rgb}, .25)` } : undefined
}

export function fileLabelMenuItem(paths, labels, apply) {
  const values = new Map((labels || []).filter(validFileLabel).map(item => [item.path, item.color]))
  return { label: '颜色标签', colors: [...FILE_LABEL_COLORS, { value: 0, label: '移除颜色标签' }].map(color => {
    const count = paths.filter(path => values.get(path) === color.value).length
    return { ...color, checked: count === paths.length ? true : count ? 'mixed' : false, action: () => apply(color.value) }
  }) }
}

export async function readFileLabels(paths, current = () => true) {
  const unique = [...new Set(paths)]
  const results = []
  for (let i = 0; i < unique.length && current(); i += 128) {
    const batch = await api.getFileLabels(unique.slice(i, i + 128))
    if (Array.isArray(batch)) results.push(...batch)
  }
  return results
}

// Serialize writes from successive menus, including multi-batch selections.
let writes = Promise.resolve()
export function applyFileLabel(paths, color) {
  const captured = [...new Set(paths)]
  const operation = writes.then(async () => {
    const results = []
    for (let i = 0; i < captured.length; i += 128) {
      const batchPaths = captured.slice(i, i + 128)
      const reply = await api.setFileLabel(batchPaths, color)
      const receipts = new Map((Array.isArray(reply) ? reply : []).map(item => [item.path, item]))
      const batch = batchPaths.map(path => {
        const item = receipts.get(path)
        return validFileLabel(item) && item.color === color ? item
          : { path, error: item?.error || '无法确认颜色标签是否已保存，请刷新后检查。' }
      })
      results.push(...batch)
      const successful = batch.filter(validFileLabel)
      if (successful.length) window.dispatchEvent(new CustomEvent(FILE_LABEL_EVENT, { detail: successful }))
    }
    const failed = results.filter(item => item.error)
    if (failed.length) throw new Error(`有 ${failed.length} 个项目未能设置颜色标签：\n${failed.slice(0, 5).map(item => `${item.path}: ${item.error}`).join('\n')}`)
    return results
  })
  writes = operation.catch(() => {})
  return operation
}
