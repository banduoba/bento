import { dashboard } from './dashboard.mjs';
import { recordLaunch, readStats, pruneActivity, utcDay } from './storage.mjs';

const MAX_BODY_BYTES = 512;
const TAURI_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
const FIELDS = ['arch', 'installationId', 'platform', 'type', 'version'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function validEvent(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === FIELDS.join(',')
    && typeof value.installationId === 'string' && UUID_V4.test(value.installationId)
    && typeof value.version === 'string' && value.version.length <= 64 && SEMVER.test(value.version)
    && value.platform === 'macos' && value.type === 'launch'
    && (value.arch === 'arm64' || value.arch === 'x86_64');
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', ...headers,
  } });
}

function cors(origin) {
  return origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {};
}

async function boundedBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_json');
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('body_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function authorized(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ') || header.length > 256) return false;
  const encoder = new TextEncoder();
  // Fixed-length digests and a constant-work comparison avoid a prefix oracle.
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(header.slice(7))),
    crypto.subtle.digest('SHA-256', encoder.encode(secret)),
  ]);
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function handle(request, env) {
  const url = new URL(request.url);
  // Tokens and IDs never belong in URLs (including dashboard login URLs).
  if (url.search) return json({ error: 'query_not_allowed' }, 400);
  if (url.pathname === '/v1/events') {
    const origin = request.headers.get('Origin');
    if (origin !== null && !TAURI_ORIGINS.has(origin)) return json({ error: 'origin_not_allowed' }, 403);
    const headers = cors(origin);
    if (request.method === 'OPTIONS') {
      if (request.headers.get('Access-Control-Request-Method') !== 'POST'
          || (request.headers.get('Access-Control-Request-Headers') ?? '').split(',')
            .some(header => header.trim() && header.trim().toLowerCase() !== 'content-type')) {
        return json({ error: 'preflight_not_allowed' }, 403, headers);
      }
      return new Response(null, { status: 204, headers: {
        ...headers, 'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '3600',
      } });
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { ...headers, Allow: 'POST, OPTIONS' });
    if (!(await env.INGEST_LIMIT.limit({ key: 'bento-events' })).success) {
      return json({ error: 'rate_limited' }, 429, { ...headers, 'Retry-After': '60' });
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') ?? '')) {
      return json({ error: 'content_type' }, 415, headers);
    }
    if (request.headers.has('Content-Encoding')) return json({ error: 'content_encoding' }, 415, headers);
    const length = request.headers.get('Content-Length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
      return json({ error: 'body_too_large' }, 413, headers);
    }
    let event;
    try { event = await boundedBody(request); }
    catch (error) { return json({ error: error.message === 'body_too_large' ? 'body_too_large' : 'invalid_json' }, error.message === 'body_too_large' ? 413 : 400, headers); }
    if (!validEvent(event)) return json({ error: 'invalid_event' }, 400, headers);
    event.installationId = event.installationId.toLowerCase();
    if (!(await env.INSTALL_LIMIT.limit({ key: event.installationId })).success) {
      return json({ error: 'rate_limited' }, 429, { ...headers, 'Retry-After': '60' });
    }
    await recordLaunch(env.DB, event, utcDay());
    return new Response(null, { status: 204, headers: { ...headers, 'Cache-Control': 'no-store' } });
  }

  if (url.pathname === '/v1/stats') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    // No cross-origin dashboard API access, even if a token is supplied.
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'origin_not_allowed' }, 403);
    if (!await authorized(request, env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
    if (!(await env.ADMIN_LIMIT.limit({ key: 'bento-dashboard' })).success) {
      return json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
    }
    return json(await readStats(env.DB, utcDay()));
  }
  if ((url.pathname === '/' || url.pathname === '/dashboard') && request.method === 'GET') return dashboard();
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch {
      // Never log request bodies, headers, identifiers, IP addresses, or raw errors.
      const origin = request.headers.get('Origin');
      return json({ error: 'temporarily_unavailable' }, 503, TAURI_ORIGINS.has(origin) ? cors(origin) : {});
    }
  },
  async scheduled(event, env) { await pruneActivity(env.DB, utcDay(new Date(event.scheduledTime))); },
};
