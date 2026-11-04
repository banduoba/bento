import { extractionActive } from '../extractionTask.js'
import { basename } from '../format'
const titles = { running: '正在解压', cancelling: '正在取消', completed: '解压完成', partial: '部分解压完成', failed: '解压失败', cancelled: '已取消解压' }
export default function ExtractionFeedback({ job, starting, cancelling, error, onCancel, onDismiss, onLocate, onSystemExtract }) {
 if (!job && !starting && !error) return null
 const busy = starting || extractionActive(job)
 const partial = job?.results?.some(result => result.output && result.state !== 'completed')
 return <aside className="extraction-feedback" data-extraction-feedback role="region" aria-labelledby="extraction-feedback-title"
  onKeyDown={event => event.stopPropagation()}>
  <header className="extraction-feedback-header">
   <h3 id="extraction-feedback-title" role="status">{starting ? '正在准备解压' : titles[job?.state] || '无法开始解压'}</h3>
   <span className="extraction-count">{job ? `${job.processed} / ${job.total}` : ''}</span>
  </header>
  {busy && <>
   <p className="extraction-source" title={job?.source || ''}>{job?.source ? basename(job.source) : '正在准备输出目录…'}</p>
   <div className="extraction-indicator" role="progressbar" aria-label="解压进度" aria-valuetext={titles[job?.state] || '正在准备解压'} />
   <p className="extraction-detail" title={job?.currentEntry || ''}>{job?.currentEntry || '文件将解压到压缩包旁的新文件夹中。'}</p>
  </>}
  {!busy && job?.results?.length > 0 && <ul className="extraction-results">
   {job.results.map((result, i) => <li key={i}>
    <div className="extraction-result-heading"><span title={result.source}>{basename(result.source)}</span><span>{result.state === 'completed' ? '完成' : result.state === 'cancelled' ? '已取消' : '失败'}</span></div>
    {result.error && <p className="extraction-error">{result.error}</p>}
    <div className="extraction-result-actions">
     {result.output && <button className="extraction-link" onClick={() => onLocate(result.output)}>{result.state === 'completed' ? '定位输出文件夹' : '查看部分文件'}</button>}
     {result.state === 'failed' && <button className="extraction-link" onClick={() => onSystemExtract([result.source])}>用系统归档工具解压…</button>}
    </div>
   </li>)}
  </ul>}
  {partial && !busy && <p className="extraction-detail">未完成文件已保留在输出目录，并带有未完成标记。</p>}
  {(error || job?.error) && <p className="extraction-error" role="alert">{error || job.error}</p>}
  <footer className="extraction-feedback-footer">
   <span>{job ? `已用时 ${Math.floor(job.elapsedMs / 1000)} 秒` : ''}</span>
   {busy ? <button className="btn small" disabled={starting || cancelling || job?.state === 'cancelling'} onClick={onCancel}>{cancelling || job?.state === 'cancelling' ? '正在取消…' : '取消解压'}</button>
    : <button className="btn small" onClick={onDismiss}>完成</button>}
  </footer>
 </aside>
}
