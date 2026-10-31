import { useState } from 'react'
import { terminal } from '../operations/store.js'

const operationNames = { copy: '拷贝', move: '移动', trash: '移到废纸篓', rename: '重命名', create: '新建', zip: '压缩', undo: '撤销', recovery: '恢复' }
const states = { queued: '排队中', running: '进行中', waitingConflict: '等待处理冲突', cancelling: '正在取消', completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' }
const phases = { preparing: '准备', scanning: '扫描文件', copying: '拷贝内容', metadata: '保留元数据', publishing: '发布文件', removingSource: '清理源文件', archiving: '创建归档', undoing: '恢复原状', recovering: '处理恢复记录', finished: '已结束' }
const outcomeNames = { succeeded: '成功', noop: '无需更改', skipped: '跳过', failed: '失败', cancelled: '取消', notStarted: '未开始', partial: '部分完成' }
const recoveryNames = { restoreBackup: '恢复受保护的原文件', finishSourceCleanup: '完成源文件清理', discardStaging: '将暂存文件移到废纸篓' }

export function byteLabel(value) {
  if (value == null || !/^\d+$/.test(String(value))) return '未知'
  const count = BigInt(value), units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB']
  let divisor = 1n, unit = 0
  while (unit < units.length - 1 && count >= divisor * 1024n) { divisor *= 1024n; unit++ }
  const tenths = count * 10n / divisor
  return `${tenths / 10n}${unit && tenths % 10n ? `.${tenths % 10n}` : ''} ${units[unit]}`
}

export function progressValue(progress) {
  if (!progress?.bytesTotal || !/^\d+$/.test(progress.bytesTotal) || !/^\d+$/.test(progress.bytesDone)) return undefined
  const total = BigInt(progress.bytesTotal)
  if (total === 0n) return undefined
  const value = BigInt(progress.bytesDone) * 1000n / total
  return Number(value > 1000n ? 1000n : value)
}

function OperationJob({ job, client, onConflict, onRetry, run }) {
  const p = job.progress
  const paths = job.sources?.length ? job.sources : job.details.map(outcome => outcome.source).filter(Boolean).slice(0, 3)
  const destination = job.destination || job.details.find(outcome => outcome.actualDestination)?.actualDestination
  const finished = terminal(job.state)
  return (
    <article className={`operation-job ${job.state}`} data-job-id={job.jobId}>
      <div className="operation-job-heading">
        <b>{operationNames[job.kind]}</b>
        <span>{!finished && job.cancelability === 'finishing' ? '正在收尾' : states[job.state]}</span>
      </div>
      {[...new Set(paths)].map(path => <div className="operation-path" title={path} key={path}>源：{path}</div>)}
      {destination && <div className="operation-path" title={destination}>目标：{destination}</div>}
      {!finished && <>
        <div className="operation-phase">{phases[job.phase]} · {p.itemsFinished}/{p.itemsTotal} 项</div>
        <progress max="1000" value={progressValue(p)} />
        <div className="operation-note">
          {byteLabel(p.bytesDone)} / {byteLabel(p.bytesTotal)}
          {p.currentPath && <span className="operation-path" title={p.currentPath}>{p.currentPath}</span>}
        </div>
      </>}
      {finished && <div className="operation-note">
        {Object.entries(job.counts).map(([name, count]) => `${outcomeNames[name] || name} ${count}`).join(' · ')}
        {job.resultsPending && ' · 正在同步结果'}
      </div>}
      {(job.error || job.detailError) && <p className="operation-error">{job.error?.message || job.detailError}</p>}
      <div className="operation-actions">
        {job.state === 'waitingConflict' && <button className="btn primary" onClick={() => onConflict(job)}>处理冲突</button>}
        {!finished && <button className="btn" disabled={job.cancelRequested || job.state === 'cancelling'}
          onClick={() => run(() => client.cancel(job.jobId))}>{job.cancelRequested ? '已请求取消' : '取消任务'}</button>}
        {client.canRetry(job.jobId) && <button className="btn" onClick={() => run(() => onRetry(job.jobId))}>
          {job.kind === 'zip' ? '重新压缩…' : '重试未完成项目'}
        </button>}
      </div>
      {!!job.details.length && <details>
        <summary>结果详情（最多显示 50 项）</summary>
        {job.details.map((outcome, index) => <div className={outcome.error ? 'operation-error' : 'operation-note'}
          key={`${outcome.itemId}-${index}`} title={outcome.source || outcome.actualDestination || ''}>
          {outcome.source || outcome.actualDestination || outcome.itemId}：{outcome.error?.message || outcomeNames[outcome.status]}
          {['finishSourceCleanup', 'manualRecovery'].includes(outcome.retry) ? '；请查看恢复记录，勿重复粘贴' : ''}
        </div>)}
      </details>}
    </article>
  )
}

export default function OperationQueue({ state, client, open, onToggle, onConflict, onUndo, onRetry, onError, reveal }) {
  const [historyCount, setHistoryCount] = useState(20)
  const [recoveryCount, setRecoveryCount] = useState(20)
  const active = state.jobs.filter(job => !terminal(job.state))
  const history = state.jobs.filter(job => terminal(job.state)).slice(-historyCount).reverse()
  const run = fn => Promise.resolve().then(fn).catch(onError)
  return (
    <div className="operations">
      <button className={`operation-toggle${active.length ? ' active' : ''}`} onClick={onToggle} aria-expanded={open}>
        文件操作{active.length ? ` · ${active.length} 个任务` : state.jobs.length ? ` · ${states[state.jobs.at(-1).state]}` : ''}
        {state.recoveries.length ? ` · ${state.recoveries.length} 项待恢复` : ''}
      </button>
      {open && <section className="operation-queue" aria-label="文件操作队列">
        <header>
          <b>文件操作</b>
          <button className="btn" disabled={state.busy || !state.latestUndoId}
            title={state.busy ? '当前任务结束后可撤销' : '撤销最近一次文件操作 (⌘Z)'} onClick={onUndo}>撤销</button>
          <button className="btn" onClick={() => run(() => client.resync())}>同步</button>
          <button className="btn" onClick={onToggle} aria-label="收起文件操作">收起</button>
        </header>
        {state.busy && <p className="operation-note">当前任务结束后可撤销。取消会保留已经完成的文件。</p>}
        {state.error && <p role="alert" className="operation-error">{state.error}</p>}
        {state.pendingSubmissions.map(request => <div key={request.requestId} className="operation-error">
          {operationNames[request.kind]}提交状态待确认
          <button className="btn" onClick={() => run(() => client.retrySubmission(request.requestId))}>同步并重试提交</button>
        </div>)}
        {!state.jobs.length && !state.pendingSubmissions.length && <p className="operation-note">暂无文件操作</p>}
        {[...active, ...history].map(job => <OperationJob key={job.jobId} job={job} client={client}
          onConflict={onConflict} onRetry={onRetry} run={run} />)}
        {state.jobs.filter(job => terminal(job.state)).length > historyCount &&
          <button className="btn" onClick={() => setHistoryCount(count => Math.min(count + 20, 256))}>显示更多历史</button>}
        {!!state.recoveries.length && <section className="operation-recoveries" aria-label="文件恢复记录">
          <h3>待处理恢复记录</h3>
          <p className="operation-note">中断的任务不会自动继续。请检查保留的文件后选择操作。</p>
          {state.recoveries.slice(0, recoveryCount).map(record => <article key={record.recoveryId}>
            <b>{record.description}</b>
            {[record.source, record.destination].filter(Boolean).map(path => <div className="operation-path" key={path}>
              {path} <button className="btn" onClick={() => run(() => reveal(path))}>在访达中显示</button>
            </div>)}
            {record.actions.map(action => <button className="btn" key={action} disabled={state.busy}
              onClick={() => run(() => client.recover(record.recoveryId, action))}>{recoveryNames[action] || action}</button>)}
          </article>)}
          {state.recoveries.length > recoveryCount &&
            <button className="btn" onClick={() => setRecoveryCount(count => count + 20)}>显示更多恢复记录</button>}
        </section>}
      </section>}
    </div>
  )
}
