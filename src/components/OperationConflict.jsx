import { useEffect, useRef, useState } from 'react'

export default function OperationConflict({ job, onHide, onResolve, onError }) {
  const [apply, setApply] = useState(false)
  const [busy, setBusy] = useState(false)
  const resolving = useRef(false)
  const skip = useRef(null)
  const conflict = job.conflict
  const decide = async decision => {
    if (resolving.current) return
    resolving.current = true
    setBusy(true)
    try {
      await onResolve(job.jobId, conflict, decision, decision === 'cancel' ? false : apply)
    } catch (error) {
      onError(String(error))
    } finally {
      resolving.current = false
      setBusy(false)
    }
  }
  useEffect(() => { skip.current?.focus() }, [])
  useEffect(() => {
    const key = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onHide()
      } else if (event.key === 'Enter' && event.target?.tagName !== 'BUTTON') {
        event.preventDefault()
        event.stopImmediatePropagation()
        void decide('skip')
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })
  const allowed = conflict.allowedDecisions
  const replace = allowed.includes('replace') && conflict.sourceKind === 'file' && conflict.destinationKind === 'file'

  return (
    <div className="modal-backdrop" onMouseDown={onHide}>
      <section className="modal operation-conflict" role="dialog" aria-modal="true"
        aria-labelledby="operation-conflict-title" onMouseDown={event => event.stopPropagation()}>
        <h2 id="operation-conflict-title" className="modal-title">目标位置已有同名项目</h2>
        <p>{conflict.reason}</p>
        <dl>
          <dt>源项目 · {conflict.sourceKind}</dt><dd>{conflict.source}</dd>
          <dt>目标项目 · {conflict.destinationKind}</dt><dd>{conflict.destination}</dd>
        </dl>
        <p className="operation-note">默认跳过。文件夹不会自动合并或替换。关闭此窗口后，任务仍等待处理。</p>
        <label className="operation-apply">
          <input type="checkbox" checked={apply} onChange={event => setApply(event.target.checked)} disabled={busy} />
          应用于此任务其余同类冲突
        </label>
        <div className="modal-footer">
          <button className="btn" disabled={busy} onClick={() => decide('cancel')}>取消此任务</button>
          <button className="btn" disabled={busy} onClick={onHide}>稍后处理</button>
          {replace && <button className="btn" disabled={busy} onClick={() => decide('replace')}>替换（可撤销）</button>}
          {allowed.includes('keepBoth') && <button className="btn" disabled={busy} onClick={() => decide('keepBoth')}>保留两份</button>}
          <button ref={skip} className="btn primary" disabled={busy || !allowed.includes('skip')}
            onClick={() => decide('skip')}>跳过</button>
        </div>
      </section>
    </div>
  )
}
