import { useEffect, useRef, useState } from 'react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { isComposingKey } from './useDialogFocus'
import { api, hasTauri } from '../api'
import { SHORTCUT_COMMANDS, bindingFromEvent, validateBindings, shortcutLabel, shortcutPreset, createShortcutBackup, parseShortcutBackup } from '../keyBindings'

export default function ShortcutSettings({ value = {}, onChange }) {
 const [recording, setRecording] = useState(null)
 const [query, setQuery] = useState('')
 const [notice, setNotice] = useState(null)
 const [busy, setBusy] = useState(false)
 const running = useRef(false), live = useRef(true)
 useEffect(() => { live.current = true; return () => { live.current = false } }, [])
 const apply = (next, message) => {
  try {
   const valid = validateBindings(next)
   onChange(valid)
   setRecording(null)
   setNotice(message ? { text: message } : null)
  } catch (error) { setNotice({ error: true, text: String(error.message || error) }) }
 }
 const activePreset = ['finder', 'commander'].find(name => {
  const preset = shortcutPreset(name), keys = Object.keys(preset)
  return keys.length === Object.keys(value).length && keys.every(key => value[key] === preset[key])
 })
 const record = (e, id) => {
  if (recording !== id || isComposingKey(e) || e.key === 'Dead') return
  e.preventDefault(); e.stopPropagation()
  if (e.key === 'Escape') { setRecording(null); setNotice(null); return }
  if (e.repeat) return
  const chord = bindingFromEvent(e)
  if (chord) apply({ ...value, [id]: chord }, '快捷键已更新。')
 }
 const backup = async importing => {
  if (!hasTauri || running.current) return
  running.current = true; setBusy(true); setNotice(null); setRecording(null)
  const snapshot = createShortcutBackup(value)
  try {
   const filters = [{ name: 'JSON', extensions: ['json'] }]
   const file = importing
    ? await open({ title: '导入快捷键方案', multiple: false, directory: false, filters })
    : await save({ title: '导出快捷键方案', defaultPath: 'Bento-shortcuts.json', filters })
   if (typeof file !== 'string' || !live.current) return
   if (importing) {
    const next = parseShortcutBackup(await api.readShortcutBackup(file))
    if (!live.current) return
    onChange(next)
   } else await api.exportShortcutBackup(file, snapshot)
   if (live.current) setNotice({ text: importing ? '快捷键方案已导入。' : '快捷键方案已导出。' })
  } catch (error) {
   if (live.current) setNotice({ error: true, text: `${importing ? '导入失败' : '导出失败'}：${error.message || error}` })
  } finally { running.current = false; if (live.current) setBusy(false) }
 }
 return <section id="settings-shortcuts" className="settings-group" aria-labelledby="shortcuts-title" aria-busy={busy}>
  <h2 id="shortcuts-title">快捷键</h2>
  <div className="shortcut-presets" role="group" aria-label="快捷键预设">
   <span>按键方案</span>
   <button type="button" className="btn small" disabled={busy} aria-pressed={activePreset === 'finder'} onClick={() => apply(shortcutPreset('finder'), '已恢复 Finder 默认快捷键。')}>Finder</button>
   <button type="button" className="btn small" disabled={busy} aria-pressed={activePreset === 'commander'} onClick={() => apply(shortcutPreset('commander'), '已应用 Commander：F3 快速查看、F7 新建文件夹、F8 移到废纸篓、⌥F7 搜索。')}>Commander</button>
  </div>
  <p className="settings-hint shortcut-help">点击按键后录入新组合，Esc 取消。预设会替换当前方案；回车行为仍按“通用”设置。功能键可能需要同时按 Fn。</p>
  <label className="shortcut-search">查找操作<input type="search" value={query} placeholder="名称、路径、视图…" onChange={e => setQuery(e.target.value)} /></label>
  {notice && <p className={`shortcut-notice${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
  <div className="shortcut-columns" aria-hidden="true"><span>操作</span><span>快捷键</span><span>管理</span></div>
  <div className="settings-card shortcut-list">
   {SHORTCUT_COMMANDS.filter(c => c.label.includes(query.trim())).map(c => <div className="shortcut-row" key={c.id}>
    <span className="shortcut-command">{c.label}</span>
    <button type="button" className={`shortcut-key${recording === c.id ? ' recording' : ''}`} disabled={busy}
     aria-label={`修改${c.label}快捷键`} aria-pressed={recording === c.id}
     data-shortcut-recording={recording === c.id ? 'true' : undefined}
     onClick={() => { setRecording(c.id); setNotice(null) }} onBlur={() => setRecording(null)} onKeyDown={e => record(e, c.id)}>
     <kbd>{recording === c.id ? '请按组合键…' : shortcutLabel(value, c.id)}</kbd>
    </button>
    <button type="button" className="shortcut-reset" disabled={busy || !Object.hasOwn(value, c.id)} aria-label={`恢复${c.label}默认快捷键`}
     onClick={() => { const next = { ...value }; delete next[c.id]; apply(next) }}>恢复</button>
    <button type="button" className="shortcut-reset" disabled={busy || value[c.id] === null} aria-label={`取消${c.label}快捷键`}
     onClick={() => apply({ ...value, [c.id]: null })}>清除</button>
   </div>)}
  </div>
  <p className="settings-hint">⌘C／⌘X／⌘V／⌘Z／⌘A、⌘,、方向键、Tab 切窗格和 F5／F6 保留原行为。自定义快捷键只在 Bento 内生效，输入框编辑时不执行文件操作。</p>
  <div className="shortcut-backup">
   <button type="button" className="btn small" disabled={!hasTauri || busy} onClick={() => backup(false)}>导出方案…</button>
   <button type="button" className="btn small" disabled={!hasTauri || busy} onClick={() => backup(true)}>导入方案…</button>
  </div>
 </section>
}
