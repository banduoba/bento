import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { api, hasTauri } from '../api'

/**
 * 设置面板：管理全局搜索范围（附加搜索目录）
 * cfg.searchPaths 为空 = 搜索全部已索引位置；非空 = 结果限定在这些目录（及其子目录）内
 */
export default function SettingsDialog({ open: visible, searchPaths, onChange, onClose }) {
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!visible) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, onClose])

  if (!visible) return null

  // 系统目录选择器
  const pick = async () => {
    if (!hasTauri || busy) return
    setBusy(true)
    try {
      const selected = await open({ directory: true, multiple: false, title: '选择要纳入搜索的目录' })
      if (typeof selected === 'string' && !searchPaths.some((p) => p === selected)) {
        onChange([...searchPaths, selected.endsWith('/') ? selected.slice(0, -1) : selected])
      }
    } catch {}
    setBusy(false)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">设置 — 搜索范围</div>
        <div className="modal-body">
          <div className="settings-hint">
            全局搜索默认覆盖 Spotlight 已索引的全部位置（含挂载卷与其他用户目录，需授予
            「完全磁盘访问权限」）。添加目录后，全局搜索结果将只保留这些目录内的内容。
          </div>
          <div className="settings-list">
            {searchPaths.length === 0 && <div className="settings-empty">未限定（搜索全部位置）</div>}
            {searchPaths.map((p) => (
              <div key={p} className="settings-row">
                <span className="settings-path" title={p}>
                  {p}
                </span>
                <button className="btn small" onClick={() => onChange(searchPaths.filter((x) => x !== p))}>
                  移除
                </button>
              </div>
            ))}
          </div>
          <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
            <button className="btn" onClick={pick} disabled={busy}>
              {busy ? '选择中…' : '添加目录…'}
            </button>
            <button className="btn primary" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
