// 应用内文件剪贴板：路径 + 模式。与系统粘贴板分开，剪切只在 Bento 里生效。

/** @typedef {{ mode: 'copy' | 'cut', paths: string[] }} FileClip */

/** @type {FileClip | null} */
let clip = null
/** @type {Set<(next: FileClip | null) => void>} */
const listeners = new Set()

export function getClip() {
  return clip
}

export function setClip(next) {
  clip = next
  for (const listener of listeners) listener(clip)
}

export function subscribeClip(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Esc，或没有选中项时的 ⌘C：只取消剪切。已有的拷贝剪贴板保持不变。 */
export function clearCut() {
  if (clip?.mode === 'cut') setClip(null)
}

/** 部分移动成功后，只留下仍然失败的剪切路径。 */
export function retainCut(paths) {
  if (clip?.mode !== 'cut') return
  if (!paths.length) setClip(null)
  else setClip({ mode: 'cut', paths: [...paths] })
}
