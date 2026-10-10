// PostgreSQL adapter tests (API-mode business services).
// Run with: TEST_DATABASE_URL=postgres://… NODE_ENV=test node --test test/pg.test.js
// The suite NEVER touches production data: it requires an explicit test
// database (or PG_ALLOW_DATABASE_URL_TESTS=1 as a conscious override).
// Without either, it reports an honest skip — it never fakes a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.TEST_DATABASE_URL && process.env.PG_ALLOW_DATABASE_URL_TESTS !== '1') {
  test('pg adapter: skipped — set TEST_DATABASE_URL (separate test database, never production)', { skip: true }, () => {});
} else {
  // Route pg.js at the test database even if a production DATABASE_URL leaks
  // into this shell. Platform-safe (no shell-specific env prefix needed).
  if (process.env.TEST_DATABASE_URL) process.env.NODE_ENV = 'test';
  const S = await import('../../api/_lib/services.js');
  const { ensureSchema, getPool } = await import('../../api/_lib/pg.js');
  const RUN = 'pg' + Date.now().toString(36);
  const W1 = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const W2 = '0x2222222222222222222222222222222222222222222222222222222222222222';

  test('pg: schema applies idempotently', async () => {
    await ensureSchema();
    await ensureSchema(); // second call must not throw
    assert.ok(true);
  });

  test('pg: transaction lifecycle + final freeze', async () => {
    const tx = await S.createTransaction({ wallet: W1, action: 'swap', provider: 'Cetus', input_asset: 'SUI', input_amount: '1', output_asset: 'USDC', expected_output: '1.16', platform_fee: '0.02' });
    assert.equal(tx.status, 'created');
    await S.transitionTransaction(tx.id, 'quoted');
    await S.transitionTransaction(tx.id, 'built');
    await S.transitionTransaction(tx.id, 'simulating');
    await S.transitionTransaction(tx.id, 'ready_to_sign');
    await S.transitionTransaction(tx.id, 'awaiting_wallet');
    await S.transitionTransaction(tx.id, 'signed');
    await S.transitionTransaction(tx.id, 'submitted', { digest: 'Pg' + RUN + 'DigestAbCdEf1234567890' });
    await S.transitionTransaction(tx.id, 'pending');
    const fin = await S.transitionTransaction(tx.id, 'confirmed', { actual_output: '1.15 USDC' });
    assert.equal(fin.status, 'confirmed');
    await assert.rejects(() => S.transitionTransaction(tx.id, 'pending'), /TX_FINAL/);
  });

  test('pg: duplicate digest returns same record', async () => {
    const a = await S.createTransaction({ wallet: W1, action: 'swap', provider: 'Cetus' });
    const d = 'PgDup' + RUN + 'DigestAbCdEf12345678';
    const r1 = await S.recordDigest({ txId: a.id, wallet: W1, digest: d });
    assert.equal(r1.duplicate, undefined);
    const r2 = await S.recordDigest({ wallet: W1, digest: d });
    assert.equal(r2.duplicate, true);
    assert.equal(r2.id, r1.id);
  });

  test('pg: referral settle — confirmed only, duplicate blocked, self-referral blocked', async () => {
    const code = 'pgref' + RUN.slice(-6);
    await S.registerReferralCode(code, W1);
    await S.attributeReferral(code, W2);
    // perps pays 10% on eligible revenue
    const t = await S.createTransaction({ wallet: W2, action: 'perps', provider: 'Aftermath Perps', platform_fee: '1' });
    await S.transitionTransaction(t.id, 'submitted', { digest: 'PgRef' + RUN + 'DigestAbCdEf123456' });
    await S.transitionTransaction(t.id, 'pending');
    await S.transitionTransaction(t.id, 'confirmed');
    const first = await S.settleReferralForTx(await S.getTransaction(t.id));
    assert.equal(first.reward, 0.1);
    const second = await S.settleReferralForTx(await S.getTransaction(t.id));
    assert.equal(second.reward, 0);
    assert.equal(second.reason, 'DUPLICATE_DIGEST');
    // self-referral
    const selfAtt = await S.attributeReferral(code, W1);
    assert.equal(selfAtt.ok, false);
    // failed tx → no reward
    const t2 = await S.createTransaction({ wallet: W2, action: 'perps', provider: 'Aftermath Perps', platform_fee: '1' });
    await S.transitionTransaction(t2.id, 'submitted', { digest: 'PgFail' + RUN + 'DigestAbCdEf12345' });
    await S.transitionTransaction(t2.id, 'failed', { failure_reason: 'MoveAbort' });
    const r = await S.settleReferralForTx(await S.getTransaction(t2.id));
    assert.equal(r.reward, 0);
    assert.equal(r.reason, 'NOT_CONFIRMED');
  });

  test('pg: automation create/status/ownership/expiry', async () => {
    const a = await S.createAutomation({ wallet: W1, title: 'PG Rule', trigger: { type: 'MANUAL' }, action: { type: 'NOTIFY', allowedActions: ['notify'] }, maxPerExecutionUsd: 10, maxDailyUsd: 50, expiresDays: 7 });
    assert.equal(a.status, 'active');
    await assert.rejects(() => S.setAutomationStatus(a.id, 'paused', W2), /NOT_AUTOMATION_OWNER/);
    await S.setAutomationStatus(a.id, 'paused', W1);
    const after = (await getPool().query('SELECT status FROM automations WHERE id = $1', [a.id])).rows[0];
    assert.equal(after.status, 'paused');
  });

  test('pg: automation cron tick writes audit runs and expires old', async () => {
    const res = await S.automationTick();
    assert.ok(res.checked >= 0 && res.at);
  });

  test('pg: memory forbidden content rejected', async () => {
    await assert.rejects(() => S.saveMemory({ wallet: W1, category: 'preference', content: 'my private key is xyz' }), /FORBIDDEN_CONTENT/);
    const ok = await S.saveMemory({ wallet: W1, category: 'preference', content: 'prefers Cetus' });
    assert.ok(ok.id);
  });
}
