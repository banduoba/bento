const script = `
const form = document.querySelector('form');
const login = document.querySelector('#login');
const panel = document.querySelector('#panel');
const status = document.querySelector('#status');
let token = '';
let generation = 0;
function row(values) {
  const tr = document.createElement('tr');
  for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
  return tr;
}
function table(id, values) {
  const body = document.querySelector(id);
  body.replaceChildren(...values.map(values => row(values)));
  if (!values.length) body.append(row(['暂无数据', '0']));
}
async function refresh() {
  const current = generation;
  status.textContent = '正在读取…';
  try {
    const response = await fetch('/v1/stats', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', credentials: 'omit' });
    if (current !== generation) return;
    if (!response.ok) {
      if (response.status === 401) { logout(); throw new Error('访问令牌无效'); }
      throw new Error(response.status === 429 ? '请求频繁，请稍后重试' : '服务暂时不可用');
    }
    const data = await response.json();
    if (current !== generation) return;
    for (const key of ['totalInstallations', 'dau', 'active7', 'active30']) document.querySelector('#' + key).textContent = data[key].toLocaleString();
    document.querySelector('#date').textContent = data.date + ' · UTC';
    table('#versions', data.versions.map(item => [item.version, item.count.toLocaleString()]));
    table('#architectures', data.architectures.map(item => [item.arch, item.count.toLocaleString()]));
    table('#daily', [...data.daily].reverse().map(item => [item.day, item.count.toLocaleString()]));
    const maximum = Math.max(1, ...data.daily.map(item => item.count));
    const bars = document.querySelector('#bars');
    bars.replaceChildren(...data.daily.map(item => {
      const span = document.createElement('span');
      span.style.height = Math.max(2, item.count / maximum * 100) + '%';
      span.title = item.day + ': ' + item.count;
      return span;
    }));
    login.hidden = true;
    panel.hidden = false;
    status.textContent = '';
  } catch (error) { if (current === generation || !token) status.textContent = error.message; }
}
function logout() {
  generation++;
  token = '';
  form.reset();
  panel.hidden = true;
  login.hidden = false;
  for (const item of panel.querySelectorAll('tbody, #bars')) item.replaceChildren();
  for (const key of ['totalInstallations', 'dau', 'active7', 'active30']) document.querySelector('#' + key).textContent = '—';
  status.textContent = '';
}
form.addEventListener('submit', event => {
  event.preventDefault();
  generation++;
  token = document.querySelector('#token').value.trim();
  form.reset();
  refresh();
});
document.querySelector('#refresh').addEventListener('click', refresh);
document.querySelector('#logout').addEventListener('click', logout);
window.addEventListener('pagehide', logout);
`;

export function dashboard() {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return new Response(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bento 使用统计</title>
<style nonce="${nonce}">
:root{font-family:system-ui,-apple-system,sans-serif;color:#29322d;background:#f5f6f2;color-scheme:light}
*{box-sizing:border-box}body{margin:0}main{max-width:1000px;margin:64px auto;padding:0 24px}header{display:flex;justify-content:space-between;align-items:center;gap:16px}h1{font-size:30px;letter-spacing:-1px;margin:8px 0}h2{font-size:16px;margin:0 0 20px}.eyebrow{font-size:12px;letter-spacing:2px;color:#5f7565}.muted,p,small{color:#6b746e;line-height:1.7}p{font-size:14px}.box{background:#fff;border:1px solid #e0e5de;border-radius:16px;padding:24px;margin-top:24px}#login{max-width:480px;margin:48px auto}label{display:block;font-size:14px;margin-bottom:8px}input{width:100%;padding:12px;border:1px solid #c4cec4;border-radius:8px;font:inherit;margin-bottom:16px}button{border:0;border-radius:8px;padding:11px 16px;font:inherit;font-size:14px;cursor:pointer;background:#304d3a;color:#fff}.secondary{background:#e9eee7;color:#304d3a}button:focus-visible,input:focus-visible{outline:3px solid #9db591;outline-offset:3px}.actions{display:flex;gap:8px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.metric{padding:22px}.metric p{margin:0;font-size:12px}.metric strong{font-size:32px;display:block;margin-top:12px;font-variant-numeric:tabular-nums}.split{display:grid;grid-template-columns:1fr 1fr;gap:20px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:11px 0;border-bottom:1px solid #edf0eb}th{font-weight:500;color:#728077}th:last-child,td:last-child{text-align:right;font-variant-numeric:tabular-nums}#bars{height:130px;display:flex;align-items:flex-end;gap:4px;border-bottom:1px solid #dbe3d7;margin-top:32px}#bars span{flex:1;background:#71936e;min-height:2px;border-radius:3px 3px 0 0}.axis{display:flex;justify-content:space-between;font-size:11px;color:#728077;padding-top:8px}details{margin-top:24px}summary{cursor:pointer;font-size:13px;color:#456346}#status{min-height:24px;font-size:14px}[hidden]{display:none!important}@media(max-width:650px){main{margin:28px auto;padding:0 16px}.cards{grid-template-columns:repeat(2,1fr);gap:10px}.split{grid-template-columns:1fr;gap:0}.box{padding:20px}.metric strong{font-size:28px}header{align-items:flex-start}h1{font-size:26px}}
</style></head><body><main>
<header><div><div class="eyebrow">BENTO · OWNER</div><h1>使用统计</h1><p>按匿名安装统计，日期以 UTC 为准。</p></div></header>
<section id="login" class="box"><h2>私有仪表盘</h2><form autocomplete="off"><label for="token">访问令牌</label><input id="token" type="password" required minlength="32" maxlength="128" autocomplete="off" spellcheck="false"><button type="submit">查看统计</button></form><p>令牌仅在当前页面内存中使用，刷新或退出后需重新输入。</p></section>
<p id="status" role="status" aria-live="polite"></p>
<section id="panel" hidden><header><small id="date"></small><div class="actions"><button id="refresh" class="secondary">刷新</button><button id="logout" class="secondary">退出</button></div></header>
<div class="cards"><div class="box metric"><p>累计首次启动</p><strong id="totalInstallations">—</strong></div><div class="box metric"><p>今日活跃安装 · DAU</p><strong id="dau">—</strong></div><div class="box metric"><p>近 7 天活跃安装</p><strong id="active7">—</strong></div><div class="box metric"><p>近 30 天活跃安装</p><strong id="active30">—</strong></div></div>
<section class="box"><h2>最近 30 天</h2><div id="bars" role="img" aria-label="最近 30 天每日活跃安装数量；完整数据见下方明细"></div><div class="axis"><span>30 天前</span><span>今天</span></div><details><summary>每日明细</summary><table><thead><tr><th>UTC 日期</th><th>活跃安装</th></tr></thead><tbody id="daily"></tbody></table></details></section>
<div class="split"><section class="box"><h2>最近上报版本</h2><table><thead><tr><th>版本</th><th>安装数</th></tr></thead><tbody id="versions"></tbody></table></section><section class="box"><h2>最近上报架构</h2><table><thead><tr><th>架构</th><th>安装数</th></tr></thead><tbody id="architectures"></tbody></table></section></div>
<p>累计首次启动为曾成功上报的随机安装 ID 数量，不等于下载量或真实人数。重装、清除设置可能产生新 ID；关闭统计、离线、请求失败会少计。公开上报接口可能收到伪造数据，频率限制仅尽力防护。</p>
</section></main><script nonce="${nonce}">${script}</script></body></html>`, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  } });
}
