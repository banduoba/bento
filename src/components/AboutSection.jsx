import { useEffect, useRef, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { api, hasTauri } from '../api'
import { version as demoVersion } from '../../package.json'
import { DOWNLOAD_URL, ISSUES_URL, PROJECT_URL, fetchLatestRelease } from '../updateCheck'

function analyticsCopy() {
  const language = (globalThis.navigator?.languages?.[0] || globalThis.navigator?.language || 'en').toLowerCase()
  if (/^zh-(hant|tw|hk|mo)/.test(language)) return {
    title: '分享使用統計',
    saveOffError: '無法儲存偏好。本次執行已停止傳送；下次啟動可能重新開啟。',
    saveOnError: '無法儲存偏好。本次執行已開啟；下次啟動會使用原設定。',
    retry: '重試儲存',
    description: '預設開啟。透過 Cloudflare 統計每日活躍安裝量與版本：僅傳送隨機安裝識別碼、Bento 版本、macOS 與處理器架構。啟動時與持續執行期間每日最多計數一次；不傳送檔案、路徑或搜尋內容。隨時關閉即可停止傳送。',
  }
  if (language.startsWith('zh')) return {
    title: '分享使用统计',
    saveOffError: '无法保存偏好。本次运行已停止发送；下次启动可能重新开启。',
    saveOnError: '无法保存偏好。本次运行已开启；下次启动会使用原设置。',
    retry: '重试保存',
    description: '默认开启。通过 Cloudflare 统计每日活跃安装量与版本：仅发送随机安装标识、Bento 版本、macOS 与处理器架构。启动时与持续运行期间每日最多计数一次；不发送文件、路径或搜索内容。随时关闭即可停止发送。',
  }
  return {
    title: 'Share usage counts',
    saveOffError: 'Could not save this choice. Sending is stopped for this session; the next launch may enable it again.',
    saveOnError: 'Could not save this choice. Sending is enabled for this session; the next launch will use the previous setting.',
    retry: 'Retry saving',
    description: 'On by default. Cloudflare counts daily active installations and versions using only a random installation ID, Bento version, macOS and processor architecture. Launches and daily activity while running count at most once per day. No files, paths or searches are sent. Turn this off at any time to stop sending.',
  }
}

export default function AboutSection({ analyticsEnabled, onAnalyticsEnabledChange, analyticsPersistenceError }) {
  const analytics = analyticsCopy()
  const [version, setVersion] = useState(null)
  const [versionError, setVersionError] = useState(false)
  const [result, setResult] = useState({ status: 'idle' })
  const [linkError, setLinkError] = useState('')
  const request = useRef({ id: 0, controller: null })

  useEffect(() => {
    let active = true
    const runningVersion = hasTauri ? getVersion() : Promise.resolve(demoVersion)
    runningVersion.then(value => { if (active) setVersion(value) })
      .catch(() => { if (active) setVersionError(true) })
    return () => {
      active = false
      request.current.id++
      request.current.controller?.abort()
    }
  }, [])

  const openLink = async (url) => {
    setLinkError('')
    try {
      if (hasTauri) await api.openPath(url)
      else window.open(url, '_blank', 'noopener,noreferrer')
    } catch { setLinkError('无法打开浏览器，请稍后重试。') }
  }

  const check = async () => {
    if (!version) return
    request.current.controller?.abort()
    const controller = new AbortController()
    const id = ++request.current.id
    request.current.controller = controller
    setResult({ status: 'checking' })
    try {
      const latest = await fetchLatestRelease(version, { signal: controller.signal })
      if (request.current.id === id) setResult(latest)
    } catch (error) {
      if (request.current.id === id && error.name !== 'AbortError') {
        setResult({ status: 'error', message: error.message })
      }
    } finally {
      if (request.current.id === id) request.current.controller = null
    }
  }

  let statusText = '仅在点击时检查 GitHub 正式发布版本。'
  if (result.status === 'checking') statusText = '正在检查更新…'
  if (result.status === 'available') statusText = `发现新版本 ${result.version}，可前往 GitHub 下载。`
  if (result.status === 'current') statusText = '已是最新版本。'
  if (result.status === 'ahead') statusText = `本地版本较新，GitHub 正式发布版本为 ${result.version}。`
  if (result.status === 'not-found') statusText = '尚无正式发布版本，可稍后重试。'
  if (result.status === 'error') statusText = result.message

  return (
    <section id="settings-about" className="settings-group" aria-labelledby="settings-about-title">
      <h2 id="settings-about-title">关于</h2>
      <div className="settings-card">
        <div className="settings-option">
          <div className="settings-label">
            <div className="settings-option-title">Bento</div>
            <p>轻量多窗格文件管理器，为 macOS 而设计。</p>
            <p>版本 {version ?? (versionError ? '读取失败' : '读取中…')} · MIT License · banduoba</p>
          </div>
        </div>
        <div className="settings-option">
          <div className="settings-label"><div className="settings-option-title">项目主页</div><p>{PROJECT_URL}</p></div>
          <button className="btn small" onClick={() => openLink(PROJECT_URL)}>项目主页</button>
        </div>
        <div className="settings-option">
          <div className="settings-label"><div className="settings-option-title">下载与发布记录</div><p>在 GitHub Releases 下载正式版本。</p></div>
          <button className="btn small" onClick={() => openLink(DOWNLOAD_URL)}>下载页面</button>
        </div>
        <div className="settings-option">
          <div className="settings-label"><div className="settings-option-title">反馈与建议</div><p>通过 GitHub Issues 报告问题。</p></div>
          <button className="btn small" onClick={() => openLink(ISSUES_URL)}>反馈问题</button>
        </div>
        <div className="settings-option">
          <div className="settings-label">
            <div className="settings-option-title">检查更新</div>
            <p role="status" aria-live="polite">{versionError ? '无法读取当前应用版本，请打开下载页面核对。' : statusText}</p>
          </div>
          <button className="btn small" disabled={!version || result.status === 'checking'} onClick={check}>
            {result.status === 'checking' ? '检查中…' : '检查更新'}
          </button>
        </div>
        {result.status === 'available' && <div className="settings-option">
          <div className="settings-label"><p>打开官方发布页面，手动下载并安装。</p></div>
          <button className="btn small primary" onClick={() => openLink(result.url)}>下载新版本</button>
        </div>}
      </div>
      <div className="settings-card">
        <div className="settings-option">
          <div className="settings-label">
            <div className="settings-option-title" id="settings-analytics-title">{analytics.title}</div>
            <p id="settings-analytics-description">{analytics.description}</p>
          </div>
          <button className="settings-toggle" role="switch" aria-checked={analyticsEnabled === true}
            aria-labelledby="settings-analytics-title" aria-describedby="settings-analytics-description"
            onClick={() => onAnalyticsEnabledChange?.(!analyticsEnabled)}>
            <span />
          </button>
        </div>
      </div>
      {analyticsPersistenceError && <div className="settings-option">
        <p className="settings-hint" role="alert">{analyticsEnabled ? analytics.saveOnError : analytics.saveOffError}</p>
        <button className="btn small" onClick={() => onAnalyticsEnabledChange?.(analyticsEnabled)}>{analytics.retry}</button>
      </div>}
      {linkError && <p className="settings-hint" role="alert">{linkError}</p>}
    </section>
  )
}
