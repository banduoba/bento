import { useEffect, useMemo, useState } from 'react'

const MODES = [
  { id: 'replace', label: '替换文本' },
  { id: 'add', label: '添加文本' },
  { id: 'format', label: '格式化名称' },
  { id: 'case', label: '转换大小写' },
]

function modificationDate(mtimeMs) {
  if (!Number.isFinite(mtimeMs)) return ''
  const date = new Date(mtimeMs)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getFullYear()).padStart(4, '0')}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}

/**
 * 批量重命名对话框（Finder/QSpace 风格）
 * items: [{ path, name, isDir, mtime_ms }]，newName 计算保留扩展名
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
  const [addDate, setAddDate] = useState(false)
  const [caseStyle, setCaseStyle] = useState('upper')
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
        } else if (mode === 'format') {
          base = fmtName + String(Math.max(startNum, 0) + i).padStart(Math.min(Math.max(digits, 1), 6), '0')
        } else if (mode === 'case') {
          if (caseStyle === 'upper') base = stem.toUpperCase()
          else if (caseStyle === 'lower') base = stem.toLowerCase()
          else base = stem.toLowerCase().replace(/(^|[^\p{L}\p{M}\p{N}])\p{L}/gu, (letter) => letter.toUpperCase())
        }
        if (addDate && (mode === 'add' || mode === 'format')) {
          const date = modificationDate(it.mtime_ms)
          if (date) base = mode === 'add' && addPos === 'before'
            ? `${date}_${base}`
            : `${base}_${date}`
        }
        return { ...it, newBase: base, newName: base + ext }
      }),
    [items, mode, find, replaceWith, addText, addPos, fmtName, startNum, digits, addDate, caseStyle]
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
      if (e.key === 'Enter' && !e.target?.closest?.('button') && valid && !busy) apply()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const apply = async () => {
    if (!valid || busy) return
    setBusy(true)
    try { await onApply(results) }
    finally { setBusy(false) }
  }

  const preview = results.slice(0, 6)
  const rest = results.length - preview.length

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal batch-rename-dialog" role="dialog" aria-modal="true"
        aria-labelledby="batch-rename-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="batch-rename-header">
          <h2 id="batch-rename-title" className="modal-title">重新命名 {items.length} 个项目</h2>
          <p>设置命名规则，下方实时预览结果。</p>
        </header>

        <div className="batch-rename-modes" role="group" aria-label="重命名模式">
          {MODES.map((m) => (
            <button key={m.id} type="button" className={`seg-btn${mode === m.id ? ' on' : ''}`}
              aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>

        <div className="batch-rename-controls">
          {mode === 'replace' && (
            <>
              <div className="batch-rename-inputs">
                <label className="batch-rename-field">
                  查找文本
                  <input autoFocus placeholder="输入要替换的文本" value={find}
                    onChange={(e) => setFind(e.target.value)} />
                </label>
                <label className="batch-rename-field">
                  替换为
                  <input placeholder="留空则删除匹配文本" value={replaceWith}
                    onChange={(e) => setReplaceWith(e.target.value)} />
                </label>
              </div>
              <p className="batch-rename-note">替换名称中的所有匹配文本，保留扩展名。</p>
            </>
          )}

          {mode === 'add' && (
            <>
              <label className="batch-rename-field">
                添加文本
                <input autoFocus placeholder="输入要添加的文本" value={addText}
                  onChange={(e) => setAddText(e.target.value)} />
              </label>
              <div className="batch-rename-options">
                <div className="batch-rename-option">
                  <span>插入位置</span>
                  <div className="batch-rename-segments" role="group" aria-label="插入位置">
                    {[{ id: 'before', label: '名称前' }, { id: 'after', label: '名称后' }].map((p) => (
                      <button key={p.id} type="button" className={`seg-btn${addPos === p.id ? ' on' : ''}`}
                        aria-pressed={addPos === p.id} onClick={() => setAddPos(p.id)}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="batch-rename-date">
                  <input type="checkbox" checked={addDate} onChange={(e) => setAddDate(e.target.checked)} />
                  添加日期
                </label>
              </div>
              <p className="batch-rename-note">使用文件修改日期（yyyyMMdd），随插入位置添加。</p>
            </>
          )}

          {mode === 'format' && (
            <>
              <label className="batch-rename-field">
                自定义名称
                <input placeholder="输入统一的名称" value={fmtName}
                  onChange={(e) => setFmtName(e.target.value)} />
              </label>
              <div className="batch-rename-options">
                <label className="batch-rename-number">
                  起始编号
                  <input type="number" min="0" value={startNum}
                    onChange={(e) => setStartNum(+e.target.value || 0)} />
                </label>
                <label className="batch-rename-number">
                  编号位数
                  <input type="number" min="1" max="6" value={digits}
                    onChange={(e) => setDigits(+e.target.value || 2)} />
                </label>
                <label className="batch-rename-date">
                  <input type="checkbox" checked={addDate} onChange={(e) => setAddDate(e.target.checked)} />
                  添加日期
                </label>
              </div>
              <p className="batch-rename-note">名称后依次添加编号；勾选日期后再追加修改日期（yyyyMMdd）。</p>
            </>
          )}

          {mode === 'case' && (
            <>
              <div className="batch-rename-field">
                <span>转换方式</span>
                <div className="batch-rename-segments batch-rename-case" role="group" aria-label="转换方式">
                  {[
                    { id: 'upper', label: '全部大写' },
                    { id: 'lower', label: '全部小写' },
                    { id: 'title', label: '首字母大写' },
                  ].map((c) => (
                    <button key={c.id} type="button" className={`seg-btn${caseStyle === c.id ? ' on' : ''}`}
                      aria-pressed={caseStyle === c.id} onClick={() => setCaseStyle(c.id)}>
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="batch-rename-note">仅转换名称，保留扩展名；首字母大写按每个词处理。</p>
            </>
          )}
        </div>

        <section className="batch-rename-preview" aria-label="重命名预览">
          <div className="batch-rename-preview-heading">
            <h3>预览</h3>
            <span>{results.filter((r) => r.newName !== r.name).length} / {items.length} 个项目将更改</span>
          </div>
          <div className="batch-rename-columns" aria-hidden="true">
            <span>原名称</span><span /><span>新名称</span>
          </div>
          <div className="modal-preview">
            {preview.map((r) => (
              <div key={r.path} className="preview-line">
                <span className={r.newName === r.name ? '' : 'old'} title={r.name}>{r.name}</span>
                <span className="arrow" aria-hidden="true">→</span>
                <span className={r.newName === r.name ? '' : 'new'} title={r.newName}>{r.newName}</span>
              </div>
            ))}
            {rest > 0 && <div className="preview-more">…以及另外 {rest} 个项目</div>}
          </div>
          <div className="batch-rename-validation" aria-live="polite">
            {hasDup && <div className="modal-error">重命名后的名称有重复，请调整规则</div>}
            {anyEmpty && <div className="modal-error">名称不能为空，请调整规则</div>}
            {!anyEmpty && !changed && !hasDup && mode === 'replace' && find && (
              <div className="modal-error">没有找到可替换的文本</div>
            )}
          </div>
        </section>

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
