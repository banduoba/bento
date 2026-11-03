import { useEffect, useRef, useState } from 'react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { api, hasTauri } from '../api'
import AboutSection from './AboutSection'
import ShortcutSettings from './ShortcutSettings'
import SettingsIcon from './SettingsIcon'
import { IconLayout1, IconLayout2, IconLayout4 } from '../icons'
import { shortcutLabel } from '../keyBindings'
import useDialogFocus, { isComposingKey } from './useDialogFocus'

const SECTIONS = [
  { id: 'search', label: '搜索', description: '选择搜索范围，让结果更贴近你正在处理的文件。' },
  { id: 'general', label: '通用', description: '调整文件显示、目录刷新和日常操作方式。' },
  { id: 'shortcuts', label: '快捷键', description: '为常用操作设置顺手的按键，也可以从预设开始。' },
  { id: 'backup', label: '备份', description: '保存偏好设置，或从已有备份中恢复。' },
  { id: 'permission', label: '权限', description: '管理 Bento 访问文件和搜索受保护位置所需的权限。' },
  { id: 'about', label: '关于', description: '版本、更新和反馈，以及你的使用统计偏好。' },
]

/**
 * 设置面板：搜索范围与通用偏好
 * cfg.searchPaths 为空 = 搜索全部已索引位置；非空 = 结果限定在这些目录（及其子目录）内
 */
export default function SettingsDialog({
  analyticsEnabled, onAnalyticsEnabledChange, analyticsPersistenceError, shortcuts = {}, onShortcutsChange,
  open: visible, searchPaths, onChange, showHidden, onShowHiddenChange, autoRefresh, onAutoRefreshChange, layout, onLayoutChange, enterAction, onEnterActionChange, onExportSettings, onImportSettings, onClose,
}) {
  const [busy, setBusy] = useState(false)
  const [fda, setFda] = useState(null) // null=查询中
  const [section, setSection] = useState('search')
  const [backupBusy, setBackupBusy] = useState(false)
  const backupRunning = useRef(false)
  const [backupNotice, setBackupNotice] = useState(null)
  const dialogRef = useDialogFocus(visible)

  useEffect(() => {
    if (!visible) return
    api.fsearchStatus().then((st) => setFda(!!st.full_disk_access)).catch(() => setFda(null))
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !isComposingKey(e) && !e.target?.closest?.('[data-shortcut-recording]')) {
        e.stopPropagation()
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, onClose])

  if (!visible) return null
  const currentSection = SECTIONS.find(item => item.id === section)

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

  const backup = async importing => {
    if (!hasTauri || backupRunning.current) return
    backupRunning.current = true
    setBackupBusy(true)
    setBackupNotice(null)
    try {
      const filters = [{ name: 'JSON', extensions: ['json'] }]
      if (importing) {
        const selected = await open({ title: '导入 Bento 设置', multiple: false, directory: false, filters })
        if (typeof selected !== 'string') return
        await onImportSettings(await api.readSettingsBackup(selected))
      } else {
        const selected = await save({ title: '导出 Bento 设置', defaultPath: 'Bento-settings.json', filters })
        if (typeof selected !== 'string') return
        await api.exportSettingsBackup(selected, onExportSettings())
      }
      setBackupNotice({ error: false, text: importing ? '设置已导入。' : '设置已导出。' })
    } catch (error) {
      setBackupNotice({ error: true, text: `${importing ? '导入失败' : '导出失败'}：${error}` })
    } finally {
      backupRunning.current = false
      setBackupBusy(false)
    }
  }

  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={onClose}>
      <div ref={dialogRef} tabIndex={-1} className="modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"
        onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <div className="settings-body">
          <aside className="settings-sidebar">
            <div className="settings-brand">
              <img src="/bento-icon.png" width="34" height="34" alt="" draggable={false} />
              <div><strong>Bento</strong><span id="settings-title">设置</span></div>
            </div>
            <nav className="settings-nav" aria-label="设置分组">
              {SECTIONS.map(({ id, label }) => (
                <button key={id} type="button" className={`settings-nav-item${section === id ? ' on' : ''}`}
                  aria-label={label} aria-current={section === id ? 'page' : undefined} aria-controls={`settings-${id}`}
                  onClick={() => setSection(id)}>
                  <SettingsIcon kind={id} />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
          </aside>
          <div className="settings-main">
            <header className="settings-header">
              <h2 className="settings-section-title">{currentSection.label}</h2>
              <p>{currentSection.description}</p>
            </header>
          <div key={section} className="settings-content">
            {section === 'shortcuts' && <ShortcutSettings value={shortcuts} onChange={onShortcutsChange} />}
            {section === 'about' && <AboutSection analyticsPersistenceError={analyticsPersistenceError} analyticsEnabled={analyticsEnabled} onAnalyticsEnabledChange={onAnalyticsEnabledChange} />}
            {section === 'backup' && <section id="settings-backup" className="settings-group" aria-labelledby="settings-backup-title" aria-busy={backupBusy}>
              <h2 id="settings-backup-title">设置备份</h2>
              <div className="settings-card">
                <div className="settings-option">
                  <div className="settings-label">
                    <div className="settings-option-title">导出偏好设置</div>
                    <p>保存通用偏好、侧栏设置、搜索偏好与范围、收藏夹（含目录路径）到 JSON 文件。</p>
                  </div>
                  <button className="btn small" onClick={() => backup(false)} disabled={!hasTauri || backupBusy}>导出设置…</button>
                </div>
                <div className="settings-option">
                  <div className="settings-label">
                    <div className="settings-option-title">导入偏好设置</div>
                    <p>从 Bento 设置备份替换上述偏好，保存成功后立即应用。</p>
                  </div>
                  <button className="btn small" onClick={() => backup(true)} disabled={!hasTauri || backupBusy}>导入设置…</button>
                </div>
              </div>
              <p className="settings-hint">不包含快捷键方案、压缩设置与密码、标签页、导航历史、工作区、布局或文件夹视图；快捷键可在“快捷键”中单独导入导出。</p>
              {!hasTauri && <p className="settings-hint">请在 Bento 桌面应用中导入或导出设置。</p>}
              {backupBusy && <p role="status" className="settings-hint">正在处理设置备份…</p>}
              {backupNotice && <p role={backupNotice.error ? 'alert' : 'status'} className="settings-hint">{backupNotice.text}</p>}
            </section>}
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
                  {searchPaths.length === 0 && <div className="settings-empty"><SettingsIcon kind="search" size={23} /><div><strong>全部已索引位置</strong><span>添加文件夹，可缩小全局搜索的范围。</span></div></div>}
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
              <h3 className="settings-group-label">文件与目录</h3>
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
                    <p id="settings-autorefresh-description">文件在外部新增、修改、删除时，窗格即时更新（只监听当前可见的目录）。关闭后仅在手动刷新（{shortcutLabel(shortcuts, 'view-refresh')}）或导航时更新。</p>
                  </div>
                  <button className="settings-toggle" role="switch" aria-checked={autoRefresh}
                    aria-labelledby="settings-autorefresh-title" aria-describedby="settings-autorefresh-description"
                    onClick={() => onAutoRefreshChange(!autoRefresh)}>
                    <span />
                  </button>
                </div>
              </div>
              <h3 className="settings-group-label">操作习惯</h3>
              <div className="settings-card">
                <div className="settings-option">
                  <div className="settings-label">
                    <div className="settings-option-title" id="settings-enter-title">回车键</div>
                    <p id="settings-enter-description">
                      打开：回车打开所选项目。重命名：回车开始重命名。其他按键在“快捷键”中设置；双击始终打开。
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
                    {[['1', '单窗格', '单窗格', IconLayout1], ['2c', '双窗格', '左右双窗格', IconLayout2], ['4', '四窗格', '四窗格', IconLayout4]].map(([id, label, title, LayoutIcon]) => (
                      <button key={id} className="seg-btn" aria-pressed={layout === id} title={title}
                        aria-label={`${id === '1' ? '1' : id === '2c' ? '2×1' : '2×2'}，${title}`} onClick={() => onLayoutChange(id)}>
                        <LayoutIcon size={14} /><span>{label}</span>
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
            <div className="modal-footer settings-footer">
              <span className="settings-save-note">偏好设置会在更改后自动保存</span>
              <button className="btn primary" onClick={onClose} autoFocus>完成</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
