import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'

const MODES = [
  { id: 'replace', label: '替换文本' },
  { id: 'add', label: '添加文本' },
  { id: 'format', label: '格式化名称' },
]

/**
 * 批量重命名对话框（Finder/QSpace 风格）
 * items: [{ path, name, isDir }]，newName 计算保留扩展名
 */
export default function BatchRenameDialog({ items, onCancel, onApply }) {
  const [mode, setMode] = useState('replace')
  const [find, setFind] = useState('')
  const [replaceWith, setReplaceWith] = useState('')
  const [addText, setAddText] = useState('')
  const [addPos, setAddPos] = useState('before')
  const [fmtName, setFmtName] = useState('文件')
  const [startNum, setStartNum] = useState(1)
  const [digits, setDigits] = useState(2)
  const [busy, setBusy] = useState(false)

  const results = useMemo(
    () =>
      items.map((it, i) => {
        const dot = it.name.lastIndexOf('.')
        const ext = dot > 0 ? it.name.slice(dot) : ''
        const stem = dot > 0 ? it.name.slice(0, dot) : it.name
        let base = stem
        if (mode === 'replace') {
          if (find) base = stem.split(find).join(replaceWith)
        } else if (mode === 'add') {
          base = addPos === 'before' ? addText + stem : stem + addText
        } else {
          base = fmtName + String(Math.max(startNum, 0) + i).padStart(Math.min(Math.max(digits, 1), 6), '0')
        }
        return { ...it, newBase: base, newName: base + ext }
      }),
    [items, mode, find, replaceWith, addText, addPos, fmtName, startNum, digits]
  )

  const lowerNames = results.map((r) => r.newName.toLowerCase())
  const hasDup = new Set(lowerNames).size !== lowerNames.length
  const anyEmpty = results.some((r) => !r.newBase.trim())
  const changed = results.some((r, i) => r.newName !== items[i].name)
  const valid = !hasDup && !anyEmpty && changed

  useEffect(() => {
    const onKey = (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter' && valid && !busy) apply()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const apply = async () => {
    if (!valid || busy) return
    setBusy(true)
    const errors = []
    for (const r of results) {
      if (r.newName === r.name) continue
      try {
        await api.rename(r.path, r.newName)
      } catch (e) {
        errors.push(`${r.name} → ${r.newName}: ${e}`)
      }
    }
    setBusy(false)
    onApply(errors)
  }

  const preview = results.slice(0, 6)
  const rest = results.length - preview.length

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">重新命名 {items.length} 个项目</div>
        <div className="modal-body">
          <div className="modal-row">
            <select value={mode} onChange={(e) => setMode(e.target.value)} className="modal-select">
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {mode === 'replace' && (
            <div className="modal-row two">
              <input autoFocus placeholder="查找" value={find} onChange={(e) => setFind(e.target.value)} />
              <input placeholder="替换成" value={replaceWith} onChange={(e) => setReplaceWith(e.target.value)} />
            </div>
          )}

          {mode === 'add' && (
            <>
              <div className="modal-row">
                <input
                  autoFocus
                  placeholder="要添加的文本"
                  value={addText}
                  onChange={(e) => setAddText(e.target.value)}
                />
              </div>
              <div className="modal-row radios">
                <label>
                  <input type="radio" checked={addPos === 'before'} onChange={() => setAddPos('before')} />
                  名称前
                </label>
                <label>
                  <input type="radio" checked={addPos === 'after'} onChange={() => setAddPos('after')} />
                  名称后
                </label>
              </div>
            </>
          )}

          {mode === 'format' && (
            <div className="modal-row format">
              <label>
                名称
                <input value={fmtName} onChange={(e) => setFmtName(e.target.value)} />
              </label>
              <label>
                起始编号
                <input
                  type="number"
                  min="0"
                  value={startNum}
                  onChange={(e) => setStartNum(+e.target.value || 0)}
                />
              </label>
              <label>
                位数
                <input
                  type="number"
                  min="1"
                  max="6"
                  value={digits}
                  onChange={(e) => setDigits(+e.target.value || 2)}
                />
              </label>
            </div>
          )}
        </div>

        <div className="modal-preview">
          {preview.map((r, i) => (
            <div key={r.path} className="preview-line">
              <span className={r.newName === r.name ? '' : 'old'}>{r.name}</span>
              {r.newName !== r.name && (
                <>
                  <span className="arrow">→</span>
                  <span className="new">{r.newName}</span>
                </>
              )}
            </div>
          ))}
          {rest > 0 && <div className="preview-more">…以及另外 {rest} 个项目</div>}
        </div>

        {hasDup && <div className="modal-error">重命名后的名称有重复，请调整规则</div>}
        {!anyEmpty && !changed && !hasDup && mode === 'replace' && find && (
          <div className="modal-error">没有找到可替换的文本</div>
        )}

        <div className="modal-footer">
          <button className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={apply} disabled={!valid || busy}>
            {busy ? '重命名中…' : '重命名'}
          </button>
        </div>
      </div>
    </div>
  )
}
