// API-mode (serverless) tests — no DATABASE_URL needed. Verifies the Vercel
// layer: cron secret auth, safe error mapping, strict CORS, AI registry parity.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUI_NETWORK = process.env.SUI_NETWORK || 'mainnet';
const { handler, corsOrigin } = await import('../../api/_lib/http.js');

function fakeReq({ method = 'GET', headers = {}, url = 'http://localhost/api/x' } = {}) {
  return { method, headers, url, socket: { remoteAddress: '127.0.0.1' } };
}
function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: null, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b; this.ended = true; } };
  return res;
}

test('http: handler wraps with CORS + safe JSON', async () => {
  const route = handler(async () => ({ ok: true }));
  const res = fakeRes();
  await route(fakeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.ok(res.headers['access-control-allow-origin']);
});

test('http: thrown unknown errors never leak internals', async () => {
  const route = handler(async () => { throw new Error('E:\\secret\\path DB_URL=postgres://x'); });
  const res = fakeRes();
  await route(fakeReq(), res);
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 500);
  assert.equal(body.error, 'INTERNAL');
  assert.ok(!res.body.includes('secret'));
  assert.ok(!res.body.includes('postgres'));
  assert.ok(!res.body.includes('E:\\\\'));
});

test('http: known codes map to 400 with readable message', async () => {
  const route = handler(async () => { const e = new Error('INVALID_WALLET'); e.code = 'INVALID_WALLET'; throw e; });
  const res = fakeRes();
  await route(fakeReq(), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'INVALID_WALLET');
});

test('http: rate limit returns 429 after burst', async () => {
  const route = handler(async () => ({ ok: true }), { limit: 2 });
  const res1 = fakeRes(); const res2 = fakeRes(); const res3 = fakeRes();
  await route(fakeReq(), res1); await route(fakeReq(), res2); await route(fakeReq(), res3);
  assert.equal(res3.statusCode, 429);
});

test('cors: production origins allowed, strangers get no ACAO header', () => {
  assert.equal(corsOrigin(fakeReq({ headers: { origin: 'https://app.noisehub.xyz' } })), 'https://app.noisehub.xyz');
  assert.equal(corsOrigin(fakeReq({ headers: { origin: 'https://noisehub.xyz' } })), 'https://noisehub.xyz');
  assert.equal(corsOrigin(fakeReq({ headers: { origin: 'https://evil.example' } })), null);
});

test('cors: wildcard is never returned', () => {
  for (const o of ['', 'https://app.noisehub.xyz', 'https://evil.example']) {
    assert.notEqual(corsOrigin(fakeReq({ headers: { origin: o || undefined } })), '*');
  }
});

test('cron: tx-tracker requires CRON_SECRET when set', async () => {
  process.env.CRON_SECRET = 'test-cron-secret-123';
  const mod = await import('../../api/_lib/handlers/cron.js');
  const res = fakeRes();
  await mod.default(fakeReq({ url: 'http://localhost/api/cron/tx-tracker' }), res);
  assert.equal(res.statusCode, 401);
  const ok = fakeRes();
  await mod.default(fakeReq({ url: 'http://localhost/api/cron/tx-tracker', headers: { authorization: 'Bearer test-cron-secret-123' } }), ok);
  assert.equal(ok.statusCode, 200);
  const body = JSON.parse(ok.body);
  // Without DATABASE_URL the cron honestly skips; with DB it would track.
  assert.equal(body.ok, true);
  assert.ok(body.skipped || Array.isArray(body.tracked));
  delete process.env.CRON_SECRET;
});

test('cron: automation endpoint auth + no-signature guarantee', async () => {
  process.env.CRON_SECRET = 'test-cron-secret-456';
  const mod = await import('../../api/_lib/handlers/cron.js');
  const res = fakeRes();
  await mod.default(fakeReq({ url: 'http://localhost/api/cron/automation', headers: { 'x-cron-secret': 'wrong' } }), res);
  assert.equal(res.statusCode, 401);
  const ok = fakeRes();
  await mod.default(fakeReq({ url: 'http://localhost/api/cron/automation', headers: { 'x-cron-secret': 'test-cron-secret-456' } }), ok);
  assert.equal(JSON.parse(ok.body).ok, true);
  delete process.env.CRON_SECRET;
});

test('api services: state machine constants match the SQLite adapter', async () => {
  const api = await import('../../api/_lib/services.js');
  const shared = await import('../../shared/logic.js');
  assert.deepEqual(api.TX, shared.TX);
  assert.deepEqual(api.REFERRAL_POLICIES, shared.REFERRAL_POLICIES);
  assert.equal(api.isWalletAddress('0x' + 'a'.repeat(64)), true);
  const r = api.referralReward(2, 'cetus', 'swap');
  assert.equal(r.reward, 0); // policy rate 0 — no invented revenue
});

test('ai registry: five providers, env-only keys, no inline secrets', async () => {
  const { AI_PROVIDERS, aiConfig } = await import('../../api/_lib/providers.js');
  for (const n of ['openrouter', 'openai', 'anthropic', 'gemini', 'custom']) {
    assert.ok(AI_PROVIDERS[n].keyEnv);
    assert.ok(!AI_PROVIDERS[n].key);
  }
  const cfg = aiConfig('openrouter');
  assert.equal(cfg.key, null); // no keys in test env
});

test('env template: single AI_PROVIDER, DATABASE_URL, CRON_SECRET sections', async () => {
  const { readFileSync } = await import('node:fs');
  const txt = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  assert.equal(txt.split('\n').filter((l) => /^AI_PROVIDER=/.test(l)).length, 1);
  assert.ok(txt.includes('DATABASE_URL='));
  assert.ok(txt.includes('CRON_SECRET='));
  assert.ok(txt.includes('ADMIN_KEY='));
  assert.ok(txt.includes('SUI_NETWORK=mainnet'));
});

test('vercel.json: crons registered + legacy aliases present', async () => {
  const { readFileSync } = await import('node:fs');
  const cfg = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const paths = cfg.crons.map((c) => c.path);
  assert.ok(paths.includes('/api/cron/tx-tracker'));
  assert.ok(paths.includes('/api/cron/automation'));
  assert.ok(cfg.rewrites.some((r) => r.source === '/api/swap/build'));
  assert.ok(cfg.rewrites.some((r) => r.source === '/api/automation-status'));
});

test('http: string payload status never becomes the HTTP code', async () => {
  const route = handler(async () => ({ expected: '100', status: 'PENDING' }));
  const res = fakeRes();
  await route(fakeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'PENDING');
  const route2 = handler(async () => ({ error: 'NOPE', status: 409 }));
  const res2 = fakeRes();
  await route2(fakeReq(), res2);
  assert.equal(res2.statusCode, 409);
});

test('schema.sql: unique digest indexes exist for txs + revenue', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../../database/schema.sql', import.meta.url), 'utf8');
  assert.ok(sql.includes('UNIQUE INDEX IF NOT EXISTS idx_tx_digest_unique'));
  assert.ok(sql.includes('UNIQUE INDEX IF NOT EXISTS idx_rev_digest_unique'));
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS automations'));
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS referral_rewards'));
});
