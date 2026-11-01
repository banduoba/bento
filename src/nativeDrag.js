import { startDrag } from '@crabnebula/tauri-plugin-drag'
import singleDragPreview from './assets/drag/1.png?inline'
import singleFileDragPreview from './assets/drag/1-file.png?inline'
import multipleDragPreview from './assets/drag/n.png?inline'
import multipleFileDragPreview from './assets/drag/n-file.png?inline'

export const trace = (m) =>
  import.meta.env.DEV && window.__TAURI_INTERNALS__
    ? window.__TAURI_INTERNALS__.invoke('append_trace_log', { msg: m }).catch(() => {})
    : Promise.resolve()

// 本应用发起的原生拖拽进行中（drop 事件据此区分「内部移动」与「外部来源只复制」）
export const dragState = { internal: false }

const loadImage = (src) => {
  const img = new Image()
  img.src = src
  return img.decode().then(() => img)
}

// 插件的 icon 接受 PNG data URL（tauri-plugin-drag 2.1.1 Base64Image）或磁盘路径，二者等价。
// 单项直接用底图；多项用 canvas 把底图里的「N」替换成实际数量。
export async function makeDragPreview(count, isDir) {
  if (count === 1) return isDir ? singleDragPreview : singleFileDragPreview
  const base = await loadImage(isDir ? multipleDragPreview : multipleFileDragPreview)
  const canvas = document.createElement('canvas')
  // Canvas PNG 不保留模板的 144 dpi 元数据，按逻辑尺寸输出以免原生预览变大。
  canvas.width = base.naturalWidth / 2
  canvas.height = base.naturalHeight / 2
  const ctx = canvas.getContext('2d')
  ctx.drawImage(base, 0, 0, canvas.width, canvas.height)
  // 与底图的标签区域保持一致，替换 N 为实际数量。
  ctx.clearRect(52, 12, canvas.width - 68, 24)
  ctx.fillStyle = 'rgba(28, 28, 32, 0.94)'
  ctx.fillRect(52, 12, canvas.width - 68, 24)
  ctx.font = '500 13px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillStyle = '#f2f2f6'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${count} 个项目`, 52, 24, canvas.width - 70)
  return canvas.toDataURL('image/png')
}

// 预览图生成失败时的兜底（单项底图一定可用）
export const fallbackPreview = (isDir) => (isDir ? singleDragPreview : singleFileDragPreview)

/**
 * 启动原生文件拖拽（NSDraggingSession）。onEnd 在会话结束/失败时恰好调用一次。
 * 全程 trace：invoke → started → ended(result, cursor) / ERROR。
 */
export async function runNativeDrag(paths, icon, onEnd) {
  dragState.internal = true
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    // 原生「会话结束」回调先于窗口自己的 drop 事件到达（实测 ended → drop 相差 <5ms），
    // 立即清除会让 drop 误判成外部来源；保留一小段宽限期
    setTimeout(() => {
      dragState.internal = false
    }, 1500)
    onEnd?.()
  }
  trace(`startDrag invoke icon=${icon.slice(0, 22)}…(${icon.length}B) paths=${paths.length} first=${paths[0]}`)
  try {
    await startDrag({ item: paths, icon }, (r) => {
      trace(`startDrag ended result=${r?.result} cursor=${JSON.stringify(r?.cursorPos)}`)
      end()
    })
    trace('startDrag session started')
  } catch (error) {
    trace(`startDrag ERROR ${error?.message || error}`)
    console.warn('无法启动文件拖拽', error)
    end()
  }
}
