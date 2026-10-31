import { useEffect, useRef, useState } from 'react'
import { open as pickDir } from '@tauri-apps/plugin-dialog'
import { hasTauri } from '../api'

// 「创建归档」对话框（QSpace 风格）：位置 / 文件名 / 压缩方式 / 密码 / 一键压缩 / 单独压缩
export const DEFAULT_ZIP_PREFS = {
  mode: 'fast', // fast=速度快(1) | small=体积小(9) | custom=自定义(level)
  level: 6,
  oneClick: false, // 开启后右键「压缩」直接按这些设置压缩，不再弹窗
  separate: false, // 多个项目各压成独立 zip
  keepPassword: false, // 「保持」：记住密码（明文存在配置里）
  password: '',
}

export function normalizeZipPrefs(saved) {
  const p = { ...DEFAULT_ZIP_PREFS }
  if (['fast', 'small', 'custom'].includes(saved?.mode)) p.mode = saved.mode
  const lv = Number(saved?.level)
  if (Number.isFinite(lv)) p.level = Math.min(9, Math.max(1, Math.round(lv)))
  p.oneClick = saved?.oneClick === true
  p.separate = saved?.separate === true
  p.keepPassword = saved?.keepPassword === true
  p.password = p.keepPassword && typeof saved?.password === 'string' ? saved.password : ''
  return p
}

export const levelOf = (prefs) => (prefs.mode === 'small' ? 9 : prefs.mode === 'custom' ? prefs.level : 1)

// 路径过长时中间省略，保留开头与结尾
const ellipsizeMiddle = (s, max = 46) => (s.length <= max ? s : `${s.slice(0, Math.ceil(max * 0.4))}…${s.slice(-Math.floor(max * 0.55))}`)

export default function ZipDialog({ count, dir, defaultName, prefs, onCancel, onSubmit, requirePassword = false }) {
  const [location, setLocation] = useState(dir)
  const [name, setName] = useState(defaultName)
  const [mode, setMode] = useState(prefs.mode)
  const [level, setLevel] = useState(prefs.level)
  const [usePw, setUsePw] = useState(requirePassword || (prefs.keepPassword && !!prefs.password))
  const [pw, setPw] = useState(prefs.password)
  const [keepPw, setKeepPw] = useState(prefs.keepPassword)
  const [oneClick, setOneClick] = useState(prefs.oneClick)
  const [separate, setSeparate] = useState(prefs.separate && count > 1)
  const nameRef = useRef(null)

  useEffect(() => {
    const el = nameRef.current
    if (el) {
      el.focus()
      el.setSelectionRange(0, Math.max(0, name.toLowerCase().endsWith('.zip') ? name.length - 4 : name.length))
    }
  }, [])

  const canSubmit = (separate || name.trim()) && (!usePw || pw.length > 0)
  const submit = () => {
    if (!canSubmit) return
    const saved = { mode, level, oneClick, separate, keepPassword: keepPw, password: keepPw && usePw ? pw : '' }
    onSubmit(
      { dir: location, name: name.trim(), level: levelOf(saved), password: usePw ? pw : '', separate: separate && count > 1 },
      saved
    )
  }

  const choose = async () => {
    if (!hasTauri) return
    try {
      const sel = await pickDir({ directory: true, multiple: false, defaultPath: location, title: '选择压缩包保存位置' })
      if (typeof sel === 'string') setLocation(sel.length > 1 && sel.endsWith('/') ? sel.slice(0, -1) : sel)
    } catch {}
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal zip-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="zip-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') onCancel()
          else if (e.key === 'Enter' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON') submit()
        }}
      >
        <div className="modal-title" id="zip-title">创建归档</div>

        <div className="zip-location">
          <span className="zip-path" title={location}>{ellipsizeMiddle(location)}</span>
          <button className="btn small" onClick={choose}>位置</button>
        </div>

        <input
          ref={nameRef}
          className="zip-name"
          value={separate ? '' : name}
          placeholder={separate ? '各个项目使用各自的名称' : '压缩包名称'}
          disabled={separate}
          onChange={(e) => setName(e.target.value)}
        />

        <div className="zip-row">
          <div className="zip-radios" role="radiogroup" aria-label="压缩方式">
            {[['fast', '速度快'], ['small', '体积小'], ['custom', '自定义']].map(([id, label]) => (
              <label key={id} className="zip-radio">
                <input type="radio" name="zip-mode" checked={mode === id} onChange={() => setMode(id)} />
                <span>{label}</span>
              </label>
            ))}
            {mode === 'custom' && (
              <select className="zip-level" value={level} onChange={(e) => setLevel(Number(e.target.value))} aria-label="压缩级别">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                  <option key={n} value={n}>{n} 级</option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div className="zip-row zip-pw">
          <label className="zip-check">
            <input type="checkbox" checked={usePw} onChange={(e) => setUsePw(e.target.checked)} />
            <span>添加密码</span>
          </label>
          <input
            className="zip-pwinput"
            type="password"
            value={pw}
            disabled={!usePw}
            placeholder="密码"
            autoComplete="off"
            onChange={(e) => setPw(e.target.value)}
          />
          <label className="zip-check" title="记住密码，下次自动填入（以明文保存在配置文件中）">
            <input type="checkbox" checked={keepPw} disabled={!usePw} onChange={(e) => setKeepPw(e.target.checked)} />
            <span>保持</span>
          </label>
        </div>

        <div className="zip-foot">
          <div className="zip-checks">
            <label className="zip-check" title="开启后，右键「压缩」直接按这些设置压缩，不再弹出此窗口（仍可用「压缩选项…」打开）">
              <input type="checkbox" checked={oneClick} onChange={(e) => setOneClick(e.target.checked)} />
              <span>开启一键压缩</span>
            </label>
            <label className="zip-check" title={count > 1 ? '每个选中的项目各压成一个 zip' : '选中多个项目时可用'}>
              <input type="checkbox" checked={separate} disabled={count < 2} onChange={(e) => setSeparate(e.target.checked)} />
              <span>单独压缩</span>
            </label>
          </div>
          <div className="zip-actions">
            <button className="btn" onClick={onCancel}>取消</button>
            <button className="btn primary" disabled={!canSubmit} onClick={submit}>压缩</button>
          </div>
        </div>
      </div>
    </div>
  )
}
