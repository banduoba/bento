import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { validEvent } from '../src/index.mjs';
import { recordLaunch, readStats, pruneActivity, utcDay } from '../src/storage.mjs';

const ownerToken = 'test-only-owner-token-with-at-least-32-characters';
const sample = {
  installationId: 'e772714f-de4a-49bc-9ba7-05a1005d6f1b', version: '0.3.1',
  platform: 'macos', arch: 'arm64', type: 'launch',
};

// D1's binding wraps SQLite. Execute real production SQL, with the same batch
// transaction semantics, rather than mocking deduplication or aggregate results.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_usage.sql', import.meta.url), 'utf8'));
  return {
    sqlite,
    prepare(sql) {
      return {
        params: [],
        bind(...params) { this.params = params; return this; },
        async run() { return sqlite.prepare(sql).run(...this.params); },
        execute() {
          const statement = sqlite.prepare(sql);
          if (statement.columns().length) return { success: true, results: statement.all(...this.params) };
          statement.run(...this.params);
          return { success: true, results: [] };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

function environment(t) {
  const DB = database();
  t.after(() => DB.sqlite.close());
  const limiter = () => ({ limit: async () => ({ success: true }) });
  return { DB, ADMIN_TOKEN: ownerToken, INGEST_LIMIT: limiter(), INSTALL_LIMIT: limiter(), ADMIN_LIMIT: limiter() };
}

function report(event = sample, headers = {}) {
  return new Request('https://analytics.example/v1/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(event),
  });
}
function stats(headers = {}) {
  return new Request('https://analytics.example/v1/stats', { headers });
}

test('strict schema accepts only the approved fields, UUIDv4, semver, and architectures', () => {
  assert.equal(validEvent(sample), true);
  assert.equal(validEvent({ ...sample, arch: 'x86_64', version: '1.2.3-beta.1+mac.2' }), true);
  for (const value of [null, [], { ...sample, path: '/private/file' }, { ...sample, filename: 'x' },
    { ...sample, search: 'query' }, { ...sample, installationId: 'not-an-id' },
    { ...sample, installationId: sample.installationId.replace('-49bc-', '-19bc-') },
    { ...sample, version: '1.2' }, { ...sample, version: '1.2.3-01' },
    { ...sample, version: '0'.repeat(100) }, { ...sample, arch: 'intel' },
    { ...sample, platform: 'windows' }, { ...sample, type: 'download' },
    { ...sample, version: undefined }, { ...sample, installationId: 12 }]) {
    assert.equal(validEvent(value), false, JSON.stringify(value));
  }
});

test('simultaneous duplicate launches count once, persist only approved data, normalize UUID case', async t => {
  const env = environment(t);
  const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => worker.fetch(report({
    ...sample, installationId: i % 2 ? sample.installationId.toUpperCase() : sample.installationId,
  }, { 'CF-Connecting-IP': '192.0.2.123' }), env)));
  assert.ok(responses.every(response => response.status === 204));
  const result = await readStats(env.DB, utcDay());
  assert.equal(result.totalInstallations, 1);
  assert.equal(result.dau, 1);
  assert.equal(result.active7, 1);
  assert.equal(result.active30, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM daily_activity').get().count, 1);
  const serialized = JSON.stringify(env.DB.sqlite.prepare('SELECT * FROM installations').all());
  assert.ok(!serialized.includes('192.0.2.123'));
  assert.ok(serialized.includes(sample.installationId));
});

test('batch rolls back installation insertion if daily insert fails', async t => {
  const env = environment(t);
  const original = env.DB.batch.bind(env.DB);
  env.DB.batch = statements => original([statements[0], env.DB.prepare('INSERT INTO nonexistent_table VALUES (1)')]);
  const response = await worker.fetch(report(), env);
  assert.equal(response.status, 503);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM installations').get().count, 0);
});

test('UTC windows include today, deduplicate across days, and exclude out-of-window dates', async t => {
  const env = environment(t);
  const id = number => `e772714f-de4a-49bc-9ba7-${String(number).padStart(12, '0')}`;
  for (const [number, day] of [[1, '2026-11-03'], [1, '2026-11-02'], [2, '2026-10-28'],
    [3, '2026-10-27'], [4, '2026-10-05'], [5, '2026-10-04'], [6, '2026-11-04']]) {
    await recordLaunch(env.DB, { ...sample, installationId: id(number) }, day);
  }
  const result = await readStats(env.DB, '2026-11-03');
  assert.equal(result.totalInstallations, 6);
  assert.equal(result.dau, 1);
  assert.equal(result.active7, 2);
  assert.equal(result.active30, 4);
  assert.equal(result.daily.length, 30);
  assert.equal(result.daily[0].day, '2026-10-05');
  assert.equal(result.daily[29].day, '2026-11-03');
  assert.equal(utcDay(new Date('2026-11-03T00:30:00+08:00')), '2026-11-02');
});

test('upgrade changes latest breakdown without inventing another installation or daily active', async t => {
  const env = environment(t);
  await recordLaunch(env.DB, sample, '2026-11-02');
  await recordLaunch(env.DB, { ...sample, version: '0.3.2', arch: 'x86_64' }, '2026-11-03');
  await recordLaunch(env.DB, { ...sample, version: '0.3.3', arch: 'x86_64' }, '2026-11-03');
  const result = await readStats(env.DB, '2026-11-03');
  assert.equal(result.totalInstallations, 1);
  assert.equal(result.active7, 1);
  assert.deepEqual(result.versions.map(row => ({ ...row })), [{ version: '0.3.3', count: 1 }]);
  assert.deepEqual(result.architectures.map(row => ({ ...row })), [{ arch: 'x86_64', count: 1 }]);
  assert.equal(env.DB.sqlite.prepare('SELECT first_seen FROM installations').get().first_seen, '2026-11-02');
});

test('retention removes old membership while preserving first-launch totals', async t => {
  const env = environment(t);
  await recordLaunch(env.DB, sample, '2026-09-29');
  await recordLaunch(env.DB, sample, '2026-09-30');
  await recordLaunch(env.DB, sample, '2026-11-03');
  await worker.scheduled({ scheduledTime: Date.parse('2026-11-03T00:17:00Z') }, env);
  assert.deepEqual(env.DB.sqlite.prepare('SELECT day FROM daily_activity ORDER BY day').all().map(row => row.day), ['2026-09-30', '2026-11-03']);
  assert.equal((await readStats(env.DB, '2026-11-03')).totalInstallations, 1);
});

test('dashboard API fails closed for missing, bad, short, and URL tokens', async t => {
  const env = environment(t);
  for (const headers of [{}, { Authorization: 'Bearer wrong-token' }, { Authorization: 'Basic ' + ownerToken }]) {
    assert.equal((await worker.fetch(stats(headers), env)).status, 401);
  }
  assert.equal((await worker.fetch(stats({ Authorization: 'Bearer ' + ownerToken }), { ...env, ADMIN_TOKEN: undefined })).status, 401);
  assert.equal((await worker.fetch(stats({ Authorization: 'Bearer short' }), { ...env, ADMIN_TOKEN: 'short' })).status, 401);
  assert.equal((await worker.fetch(new Request('https://analytics.example/v1/stats?token=' + ownerToken), env)).status, 400);
  const response = await worker.fetch(stats({ Authorization: 'Bearer ' + ownerToken }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const result = await response.json();
  assert.equal(result.totalInstallations, 0);
  assert.equal(result.dau, 0);
  assert.ok(!JSON.stringify(result).includes('installationId'));
});

test('dashboard shell includes no secret, blocks framing, and keeps token out of persistent storage', async t => {
  const env = environment(t);
  const response = await worker.fetch(new Request('https://analytics.example/dashboard'), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(!html.includes(ownerToken));
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(html));
  assert.match(html, /type="password"/);
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('Content-Security-Policy'), /script-src 'nonce-/);
});

test('unauthenticated stats requests cannot exhaust the owner quota', async t => {
  const env = environment(t);
  let calls = 0;
  env.ADMIN_LIMIT.limit = async () => ({ success: ++calls <= 30 });
  for (let index = 0; index < 40; index++) {
    assert.equal((await worker.fetch(stats(index % 2 ? { Authorization: 'Bearer incorrect' } : {}), env)).status, 401);
  }
  assert.equal(calls, 0);
  assert.equal((await worker.fetch(stats({ Authorization: 'Bearer ' + ownerToken }), env)).status, 200);
  assert.equal(calls, 1);
});

test('only Tauri CORS origins may submit; native requests and allowed preflight work', async t => {
  const env = environment(t);
  for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']) {
    const response = await worker.fetch(report(sample, { Origin: origin }), env);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    const preflight = await worker.fetch(new Request('https://analytics.example/v1/events', {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    }), env);
    assert.equal(preflight.status, 204);
  }
  for (const origin of ['https://evil.example', 'null', 'http://localhost:1420']) {
    const response = await worker.fetch(report(sample, { Origin: origin }), env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal((await worker.fetch(stats({ Authorization: 'Bearer ' + ownerToken, Origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await worker.fetch(stats({ Authorization: 'Bearer ' + ownerToken, Origin: 'https://analytics.example' }), env)).status, 200);
});

test('invalid bodies, media, lengths, fields, and methods never write to D1', async t => {
  const env = environment(t);
  const cases = [
    [report({ ...sample, filename: '/private' }), 400],
    [report(sample, { 'Content-Type': 'text/plain' }), 415],
    [report(sample, { 'Content-Encoding': 'gzip' }), 415],
    [report(sample, { 'Content-Length': '9999' }), 413],
    [new Request('https://analytics.example/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' }), 400],
    [new Request('https://analytics.example/v1/events', { method: 'GET' }), 405],
    [new Request('https://analytics.example/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(513) }), 413],
  ];
  for (const [request, code] of cases) assert.equal((await worker.fetch(request, env)).status, code);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM installations').get().count, 0);
});

test('global, installation, and admin limit failures protect D1 and return retry hints', async t => {
  const env = environment(t);
  for (const binding of ['INGEST_LIMIT', 'INSTALL_LIMIT', 'ADMIN_LIMIT']) {
    const modified = { ...env, [binding]: { limit: async () => ({ success: false }) } };
    const request = binding === 'ADMIN_LIMIT' ? stats({ Authorization: 'Bearer ' + ownerToken }) : report();
    const response = await worker.fetch(request, modified);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '60');
  }
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM installations').get().count, 0);
});

test('limiter failure fails closed without leaking exception or body', async t => {
  const env = environment(t);
  env.INGEST_LIMIT.limit = async () => { throw new Error('sensitive internal detail'); };
  const response = await worker.fetch(report(sample, { Origin: 'tauri://localhost' }), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'tauri://localhost');
  assert.equal(await response.text(), '{"error":"temporarily_unavailable"}');
});
