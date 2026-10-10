// Production-blocker regression tests (FINAL FIX TASK).
// No DATABASE_URL needed: pure logic + provider-shape + HTTP mapping only.
// DB-backed paths (tracker pass, referral settlement, fee config) are covered
// by pg.test.js when DATABASE_URL is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* ---------- 1. txstatus: provider-envelope mapping ---------- */
const { fetchTxBlockStatus } = await import('../../api/_lib/txstatus.js');

const okEnvelope = (st, extra = {}) => ({
  getTransaction: async () => ({
    value: { effects: { status: { status: st, error: extra.error || null }, gasUsed: { computationCost: '100', storageCost: '50', storageRebate: '10' } },
      balanceChanges: [{ amount: '500', coinType: '0x2::sui::SUI' }], checkpoint: '999' },
  }),
});

test('txstatus: success → confirmed with gas + output', async () => {
  const r = await fetchTxBlockStatus(okEnvelope('success'), 'd1');
  assert.equal(r.status, 'confirmed');
  assert.equal(r.gas, '140');
  assert.ok(r.actualOutput.includes('0x2::sui::SUI'));
});

test('txstatus: failure → failed with reason, never confirmed', async () => {
  const r = await fetchTxBlockStatus(okEnvelope('failure', { error: 'InsufficientGas' }), 'd2');
  assert.equal(r.status, 'failed');
  assert.ok(r.failureReason.includes('InsufficientGas'));
});

test('txstatus: effects without status yet → pending (never failed)', async () => {
  const r = await fetchTxBlockStatus({ getTransaction: async () => ({ value: { effects: {} } }) }, 'd3');
  assert.equal(r.status, 'pending');
});

test('txstatus: digest unknown → throws TX_NOT_FOUND_ON_CHAIN (tracker retries)', async () => {
  const nf = { getTransaction: async () => { throw new Error('Could not find transaction'); } };
  await assert.rejects(() => fetchTxBlockStatus(nf, 'd4'), (e) => e.code === 'TX_NOT_FOUND_ON_CHAIN');
});

test('txstatus: transport error → PROVIDER_UNAVAILABLE (never failed)', async () => {
  const down = { getTransaction: async () => { throw new Error('fetch failed'); } };
  await assert.rejects(() => fetchTxBlockStatus(down, 'd5'), (e) => e.code === 'PROVIDER_UNAVAILABLE');
});

test('txstatus: legacy JSON-RPC client shape still works', async () => {
  const legacy = { getTransactionBlock: async () => ({ effects: { status: { status: 'success' } }, checkpoint: '1' }) };
  const r = await fetchTxBlockStatus(legacy, 'd6');
  assert.equal(r.status, 'confirmed');
});

/* ---------- 2. tracker classifier + expiry predicate ---------- */
const S = await import('../../api/_lib/services.js');

test('classifier: confirmed→confirmed, failed→failed, rejected→rejected', () => {
  assert.equal(S.classifyTrackingResult({ status: 'confirmed' }), 'confirmed');
  assert.equal(S.classifyTrackingResult({ status: 'failed' }), 'failed');
  assert.equal(S.classifyTrackingResult({ status: 'rejected' }), 'rejected');
});

test('classifier: pending/submitted/null/unknown → pending (never failed)', () => {
  for (const r of [{ status: 'pending' }, { status: 'submitted' }, null, undefined, {}, { status: 'weird' }]) {
    assert.equal(S.classifyTrackingResult(r), 'pending');
  }
});

test('expiry: only unknown-after-window expires', () => {
  const now = Date.now();
  const young = { updated_at: new Date(now - 60_000).toISOString() };
  const old = { updated_at: new Date(now - 31 * 60_1000).toISOString() };
  const nf = Object.assign(new Error('nope'), { code: 'TX_NOT_FOUND_ON_CHAIN' });
  const transient = Object.assign(new Error('down'), { code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(S.shouldExpireTx(young, nf, now), false);   // young + not found → retry
  assert.equal(S.shouldExpireTx(old, nf, now), true);      // stale + not found → expired
  assert.equal(S.shouldExpireTx(old, transient, now), false); // stale + RPC error → retry
  assert.equal(S.shouldExpireTx(old, null, now), false);
});

/* ---------- 3. fee units: MIST→SUI, never $rawMIST ---------- */
const F = await import('../../api/_lib/fee-engine.js');

test('fee units: 1 SUI of MIST → human SUI with display', () => {
  assert.equal(F.toHumanUnits('1000000000', 'SUI'), '1');
  assert.equal(F.toHumanUnits('1500000000', 'SUI'), '1.5');
  assert.equal(F.feeDisplay('0.002', 'SUI'), '0.002 SUI');
});

test('fee units: 6-decimal assets do not shift ×1000', () => {
  assert.equal(F.toHumanUnits('1000000', 'USDC'), '1');
  assert.equal(F.toHumanUnits('2500000', 'USDC'), '2.5');
});

test('fee units: BigInt bps math exact on large MIST (20 bps of 1M SUI)', () => {
  const fee = (BigInt('1000000000000000') * 20n) / 10000n;
  assert.equal(F.toHumanUnits(String(fee), 'SUI'), '2000');
});

/* ---------- 4. predict guards: pure market validation ---------- */
const P = await import('../../api/_lib/deepbook-predict.js');

test('predict: marketStatus expired/paused/active', () => {
  assert.equal(P.marketStatus(Date.now() - 1000, false), 'EXPIRED');
  assert.equal(P.marketStatus(Date.now() + 3600_000, true), 'PAUSED');
  assert.equal(P.marketStatus(Date.now() + 3600_000, false), 'ACTIVE');
});

test('predict: toMarketDescriptor rejects bad side/strike/range/underlying', () => {
  const future = Date.now() + 3600_000;
  assert.throws(() => P.toMarketDescriptor({ underlying: 'NOPE', expiryMs: future, side: 'up' }), (e) => e.code === 'UNKNOWN_UNDERLYING');
  const known = P.predictUnderlyings()[0];
  assert.throws(() => P.toMarketDescriptor({ underlying: known, expiryMs: future, side: 'sideways' }), (e) => e.code === 'INVALID_SIDE');
  assert.throws(() => P.toMarketDescriptor({ underlying: known, expiryMs: null, side: 'up' }), (e) => e.code === 'INVALID_MARKET');
});

test('predict: buildMint rejects expired before any chain call', async () => {
  const known = P.predictUnderlyings()[0];
  await assert.rejects(
    () => P.deepbookPredictAdapter.buildMint({ wallet: '0x1', underlying: known, expiryMs: Date.now() - 1000, side: 'up', quantity: 1 }),
    (e) => e.code === 'MARKET_EXPIRED');
});

test('predict: assertMarketBuildable rejects invalid descriptor', async () => {
  await assert.rejects(() => P.assertMarketBuildable({}), (e) => e.code === 'INVALID_MARKET');
});

/* ---------- 5. HTTP error mapping ---------- */
const { handler } = await import('../../api/_lib/http.js');
function fakeRes() {
  return { statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b; } };
}
const run = async (err) => {
  const res = fakeRes();
  await handler(async () => { throw err; })({ method: 'GET', headers: {}, url: 'http://localhost/api/x', socket: {} }, res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

test('http: QUOTE_FAILED/BUILD_FAILED → 502 with code', async () => {
  for (const code of ['QUOTE_FAILED', 'BUILD_FAILED']) {
    const r = await run(Object.assign(new Error(code), { code }));
    assert.equal(r.status, 502);
    assert.equal(r.body.error, code);
  }
});

test('http: SIMULATION_FAILED/INVALID_MARKET/MARKET_EXPIRED map, internals hidden', async () => {
  const sim = await run(Object.assign(new Error('sim failed at 0xabc'), { code: 'SIMULATION_FAILED' }));
  assert.equal(sim.status, 502);
  assert.equal(sim.body.error, 'SIMULATION_FAILED');
  const inv = await run(Object.assign(new Error('bad market'), { code: 'INVALID_MARKET' }));
  assert.equal(inv.status, 400);
  const exp = await run(Object.assign(new Error('expired'), { code: 'MARKET_EXPIRED' }));
  assert.equal(exp.status, 400);
});

test('http: UNKNOWN_* → 500 INTERNAL without leak', async () => {
  const r = await run(Object.assign(new Error('weird E:\\path'), { code: 'UNKNOWN_COIN' }));
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'UNKNOWN_COIN');
  assert.ok(!r.body.message.includes('E:\\'));
});

/* ---------- 5b. fee recipient: dashboard/CLI whitespace never breaks quotes --- */
const { validateFeeConfig } = await import('../../api/_lib/fee-engine.js');

test('fee: recipient with surrounding whitespace/quotes is trimmed, not INVALID_FEE_RECIPIENT', () => {
  const addr = '0xa29a8f72981c5644c348a51cd4aded6dbb47ad4361f7a825e19d377e9c4373a1';
  for (const dirty of ['  ' + addr + '\n', '"' + addr + '"', "'" + addr + "'"]) {
    const r = validateFeeConfig({ bps: 2, recipient: dirty }, 'test');
    assert.equal(r.enabled, true);
    assert.equal(r.recipient, addr);
  }
  assert.throws(() => validateFeeConfig({ bps: 2, recipient: '0xZZZ' }, 'test'), /INVALID_FEE_RECIPIENT/);
});

/* ---------- 6. cron auth: header-only, closed when unconfigured ---------- */
const { checkSecret, cronConfigured } = await import('../../api/_lib/pg.js');

test('cron: closed without CRON_SECRET; ?secret= never accepted', () => {
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  assert.equal(cronConfigured(), false);
  assert.equal(checkSecret({ headers: {}, url: 'http://localhost/api/cron/tx-tracker' }), false);
  assert.equal(checkSecret({ headers: {}, url: 'http://localhost/api/cron/tx-tracker?secret=abc' }), false);
  process.env.CRON_SECRET = 's3cr3t';
  assert.equal(cronConfigured(), true);
  assert.equal(checkSecret({ headers: { 'x-cron-secret': 's3cr3t' }, url: 'http://localhost/x' }), true);
  assert.equal(checkSecret({ headers: { authorization: 'Bearer s3cr3t' }, url: 'http://localhost/x' }), true);
  assert.equal(checkSecret({ headers: {}, url: 'http://localhost/x?secret=s3cr3t' }), false);
  assert.equal(checkSecret({ headers: { 'x-cron-secret': 'wrong' }, url: 'http://localhost/x' }), false);
  if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
});

/* ---------- 7. readJson: production POST bodies must never be dropped ---------- */
const { readJson } = await import('../../api/_lib/http.js');
import { EventEmitter } from 'node:events';
function mockReq({ body = undefined, complete = false, readableEnded = false, chunks = [] } = {}) {
  const req = new EventEmitter();
  req.body = body;
  req.complete = complete;
  req.readableEnded = readableEnded;
  req.destroy = () => {};
  if (chunks.length && !readableEnded) {
    queueMicrotask(() => {
      for (const c of chunks) req.emit('data', Buffer.from(c));
      req.emit('end');
    });
  }
  return req;
}

test('readJson: platform pre-parsed body object is used as-is', async () => {
  assert.deepEqual(await readJson(mockReq({ body: { wallet: '0x1' }, complete: true })), { wallet: '0x1' });
});

test('readJson: fully buffered body (complete=true, not ended) still parses', async () => {
  const r = await readJson(mockReq({ complete: true, chunks: ['{"a":1}'] }));
  assert.deepEqual(r, { a: 1 });
});

test('readJson: normal stream parses', async () => {
  const r = await readJson(mockReq({ chunks: ['{"a":', '2}'] }));
  assert.deepEqual(r, { a: 2 });
});

test('readJson: already-ended stream resolves {} instead of hanging', async () => {
  const r = await Promise.race([readJson(mockReq({ readableEnded: true, complete: true })), new Promise((_, rej) => setTimeout(() => rej(new Error('hang')), 2000))]);
  assert.deepEqual(r, {});
});

test('readJson: oversize body resolves {} and destroys the stream', async () => {
  let destroyed = false;
  const req = mockReq({ chunks: ['x'.repeat(300 * 1024)] });
  req.destroy = () => { destroyed = true; };
  assert.deepEqual(await readJson(req, 1024), {});
  assert.equal(destroyed, true);
});

test('readJson: second call returns the first promise (parse at most once)', async () => {
  const req = mockReq({ chunks: ['{"a":3}'] });
  const [a, b] = await Promise.all([readJson(req), readJson(req)]);
  assert.deepEqual(a, { a: 3 });
  assert.deepEqual(b, { a: 3 });
});
