import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { api, hasTauri } from '../api'
import AboutSection from './AboutSection'

/**
 * 设置面板：搜索范围与通用偏好
 * cfg.searchPaths 为空 = 搜索全部已索引位置；非空 = 结果限定在这些目录（及其子目录）内
 */
export default function SettingsDialog({
  open: visible, searchPaths, onChange, showHidden, onShowHiddenChange, autoRefresh, onAutoRefreshChange, layout, onLayoutChange, enterAction, onEnterActionChange, onClose,
}) {
  const [busy, setBusy] = useState(false)
  const [fda, setFda] = useState(null) // null=查询中
  const [section, setSection] = useState('search')

  useEffect(() => {
    if (!visible) return
    api.fsearchStatus().then((st) => setFda(!!st.full_disk_access)).catch(() => setFda(null))
  }, [visible])

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
      <div className="modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"
        onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-title" id="settings-title">设置</div>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="设置分组">
            {[['search', '搜索'], ['general', '通用'], ['permission', '权限'], ['about', '关于']].map(([id, label]) => (
              <button key={id} className={`settings-nav-item${section === id ? ' on' : ''}`}
                aria-current={section === id ? 'page' : undefined} aria-controls={`settings-${id}`}
                onClick={() => setSection(id)}>
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {section === 'about' && <AboutSection />}
            {section === 'search' && <section id="settings-search" className="settings-group" aria-labelledby="settings-search-title">
              <h2 id="settings-search-title">搜索</h2>
              <div className="settings-card">
                <div className="settings-option">
                  <div className="settings-label">
                    <div className="settings-option-title">搜索范围</div>
                    <p>未添加目录时，搜索全部已索引位置。</p>
                  </div>
                  <button className="btn small" onClick={pick} disabled={busy}>
                    {busy ? '选择中…' : '添加目录…'}
                  </button>
                </div>
                <div className="settings-list">
                  {searchPaths.length === 0 && <div className="settings-empty">全部位置</div>}
                  {searchPaths.map((p) => (
                    <div key={p} className="settings-row">
                      <span className="settings-path" title={p}>{p}</span>
                      <button className="btn small" aria-label={`移除目录 ${p}`}
                        onClick={() => onChange(searchPaths.filter((x) => x !== p))}>
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <p className="settings-hint">
                全局搜索默认覆盖 Spotlight 已索引的全部位置（含挂载卷与其他用户目录，需授予
                「完全磁盘访问权限」）。添加目录后，全局搜索结果将只保留这些目录内的内容。
              </p>
            </section>}
            {section === 'general' && <section id="settings-general" className="settings-group" aria-labelledby="settings-general-title">
              <h2 id="settings-general-title">通用</h2>
              <div className="settings-card">
                <div className="settings-option">
                  <div className="settings-label">
                    <div className="settings-option-title" id="settings-hidden-title">显示隐藏文件</div>
                    <p id="settings-hidden-description">在文件窗格与搜索结果中显示隐藏项目。</p>
                  </div>
                  <button className="settings-toggle" role="switch" aria-checked={showHidden}
                    aria-labelledby="settings-hidden-title" aria-describedby="settings-hidden-description"
                    onClick={() => onShowHiddenChange(!showHidden)}>
                    <span />
                  </button>
                </div>
                <div className="settings-option">
                  <div className="settings-label">
                    <div className="settings-option-title" id="settings-autorefresh-title">自动刷新目录</div>
                    <p id="settings-autorefresh-description">文件在外部新增、修改、删除时，窗格即时更新（只监听当前可见的目录）。关闭后仅在手动刷新（⌘R）或导航时更新。</p>
                  </div>
                  <button className="settings-toggle" role="switch" aria-checked={autoRefresh}
                    aria-labelledby="settings-autorefresh-title" aria-describedby="settings-autorefresh-description"
                    onClick={() => onAutoRefreshChange(!autoRefresh)}>
                    <span />
                  </button>
                </div>
                <div className="settings-option">
                  <div className="settings-label">
                    <div className="settings-option-title" id="settings-enter-title">回车键</div>
                    <p id="settings-enter-description">
                      打开：回车打开所选项目，F2 重命名。重命名：回车开始重命名。⌘↓ 与双击始终打开。
                    </p>
                  </div>
                  <div className="settings-segments" role="group" aria-labelledby="settings-enter-title" aria-describedby="settings-enter-description">
                    {[['open', '打开'], ['rename', '重命名']].map(([id, label]) => (
                      <button key={id} type="button" className="seg-btn" aria-pressed={enterAction === id}
                        onClick={() => onEnterActionChange(id)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-option">
                  <div className="settings-label">
                    <div className="settings-option-title" id="settings-layout-title">默认布局</div>
                    <p>立即应用，自动保存当前工作区布局。</p>
                  </div>
                  <div className="settings-segments" role="group" aria-labelledby="settings-layout-title">
                    {[['1', '1', '单窗格'], ['2c', '2×1', '左右双窗格'], ['4', '2×2', '四窗格']].map(([id, label, title]) => (
                      <button key={id} className="seg-btn" aria-pressed={layout === id} title={title}
                        aria-label={`${label}，${title}`} onClick={() => onLayoutChange(id)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>}
            {section === 'permission' && (
              <section id="settings-permission" className="settings-group" aria-labelledby="settings-permission-title">
                <h2 id="settings-permission-title">权限</h2>
                {hasTauri ? (
                  <div className="settings-card">
                    <div className="settings-option">
                      <div className="settings-label">
                        <div className="settings-option-title">
                          完全磁盘访问权限
                          <span
                            className={`fda-badge ${fda ? 'ok' : fda === false ? 'off' : 'unknown'}`}
                          >
                            {fda ? '已授予' : fda === false ? '未授予' : '检查中'}
                          </span>
                        </div>
                        <p>授权可让搜索访问资源库等受保护目录。移到废纸篓使用 macOS 系统操作，访问受限时会提示错误。</p>
                      </div>
                      <button className="btn small" onClick={() => api.openPrivacySettings().catch((e) => alert(String(e)))}>
                        打开系统设置
                      </button>
                    </div>
                  </div>
                ) : <p className="settings-hint">请在 Bento 桌面应用中查看并管理完全磁盘访问权限。</p>}
              </section>
            )}
          </div>
        </div>
        <div className="modal-footer settings-footer">
          <button className="btn primary" onClick={onClose} autoFocus>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
