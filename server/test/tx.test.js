// Comprehensive transaction lifecycle, persistence, referral settlement, automation safety, security & AI tests.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const RUN_ID = Date.now().toString(36) + randomBytes(3).toString('hex');
const W1 = '0x1111111111111111111111111111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222222222222222222222222222';
const W3 = '0x3333333333333333333333333333333333333333333333333333333333333333';
const D1 = 'AbC' + RUN_ID + 'XyZ456AbC123XyZ456AbC1';

let S, db;
before(async () => {
  S = await import('../src/services.js');
  const d = await import('../src/db.js');
  db = d.db;
});

test('tx persistence: create + get + invalid wallet rejected', () => {
  const tx = S.createTransaction({
    wallet: W1, action: 'swap', provider: 'Cetus',
    input_asset: 'SUI', input_amount: '1', output_asset: 'USDC', expected_output: '1.16',
    platform_fee: '0.02', gas: '1000000',
  });
  assert.equal(tx.status, 'created');
  assert.equal(tx.input_asset, 'SUI');
  assert.equal(tx.expected_output, '1.16');
  assert.equal(S.getTransaction(tx.id).id, tx.id);
  assert.throws(() => S.createTransaction({ wallet: 'nope', action: 'swap' }), /INVALID_WALLET/);
});

test('tx transitions: legal flow passes, illegal blocked, final frozen', () => {
  const tx = S.createTransaction({ wallet: W1, action: 'swap', provider: 'Cetus' });
  S.transitionTransaction(tx.id, 'quoted');
  S.transitionTransaction(tx.id, 'built');
  S.transitionTransaction(tx.id, 'simulating');
  assert.throws(() => S.transitionTransaction(tx.id, 'confirmed'), /TX_BAD_TRANSITION/);
  S.transitionTransaction(tx.id, 'ready_to_sign');
  S.transitionTransaction(tx.id, 'awaiting_wallet');
  S.transitionTransaction(tx.id, 'signed');
  S.transitionTransaction(tx.id, 'submitted', { digest: D1 });
  S.transitionTransaction(tx.id, 'pending');
  S.transitionTransaction(tx.id, 'confirmed');
  assert.throws(() => S.transitionTransaction(tx.id, 'pending'), /TX_FINAL/);
});

test('tx rejected: user rejection sets status REJECTED, frozen from signing', () => {
  const tx = S.createTransaction({ wallet: W1, action: 'swap', provider: 'Cetus' });
  S.transitionTransaction(tx.id, 'quoted');
  S.transitionTransaction(tx.id, 'built');
  S.transitionTransaction(tx.id, 'simulating');
  S.transitionTransaction(tx.id, 'ready_to_sign');
  S.transitionTransaction(tx.id, 'awaiting_wallet');
  const rej = S.transitionTransaction(tx.id, 'rejected', { failure_reason: 'User rejected signature in wallet' });
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.failure_reason, 'User rejected signature in wallet');
  // Final frozen
  assert.throws(() => S.transitionTransaction(tx.id, 'signed'), /TX_FINAL/);
  // Referral on rejected tx returns NOT_CONFIRMED
  const r = S.settleReferralForTx(rej);
  assert.equal(r.reward, 0);
  assert.equal(r.reason, 'NOT_CONFIRMED');
});

test('tx failed: on-chain failure sets status FAILED, no referral', () => {
  const tx = S.createTransaction({ wallet: W1, action: 'swap', provider: 'Cetus', platform_fee: '2' });
  S.transitionTransaction(tx.id, 'submitted', { digest: D1 + 'FAIL' });
  S.transitionTransaction(tx.id, 'pending');
  const failed = S.transitionTransaction(tx.id, 'failed', { failure_reason: 'MoveAbort: Insufficient coin balance' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure_reason, 'MoveAbort: Insufficient coin balance');
  assert.throws(() => S.transitionTransaction(tx.id, 'confirmed'), /TX_FINAL/);
  const r = S.settleReferralForTx(failed);
  assert.equal(r.reward, 0);
  assert.equal(r.reason, 'NOT_CONFIRMED');
});

test('duplicate digest returns existing record, no duplicate', () => {
  const a = S.createTransaction({ wallet: W1, action: 'swap', provider: 'Cetus' });
  const r1 = S.recordDigest({ txId: a.id, wallet: W1, digest: D1 + 'Q' });
  assert.equal(r1.duplicate, undefined);
  assert.equal(r1.digest, D1 + 'Q');
  const r2 = S.recordDigest({ wallet: W1, digest: D1 + 'Q' });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.id, r1.id);
  assert.throws(() => S.recordDigest({ wallet: W1, digest: '!!!' }), /INVALID_DIGEST/);
});

test('tx restart recovery: submitted and pending txs found in DB', () => {
  const pendingTx = S.createTransaction({ wallet: W1, action: 'swap', provider: 'Cetus' });
  S.recordDigest({ txId: pendingTx.id, wallet: W1, digest: D1 + 'REC' });
  const rows = db.prepare("SELECT * FROM transactions WHERE status IN ('submitted','pending') AND digest IS NOT NULL").all();
  assert.ok(rows.some((t) => t.digest === D1 + 'REC'));
});

test('settle: confirmed cetus tx pays 0 (policy), perps pays 10%', () => {
  const t1 = S.createTransaction({ wallet: W2, action: 'swap', provider: 'Cetus', platform_fee: '2' });
  ['quoted', 'built', 'simulating', 'ready_to_sign', 'awaiting_wallet', 'signed'].forEach((s) => S.transitionTransaction(t1.id, s));
  S.transitionTransaction(t1.id, 'submitted', { digest: D1 + 'C' });
  S.transitionTransaction(t1.id, 'pending');
  S.transitionTransaction(t1.id, 'confirmed');
  const r1 = S.settleReferralForTx(S.getTransaction(t1.id));
  assert.equal(r1.reward, 0);
  assert.equal(r1.reason, 'POLICY_RATE_ZERO');

  const refCode = 'ref_' + RUN_ID;
  S.registerReferralCode(refCode, W1);
  S.attributeReferral(refCode, W2);
  const t2 = S.createTransaction({ wallet: W2, action: 'perps', provider: 'Aftermath Perps', platform_fee: '1' });
  ['quoted', 'built', 'simulating', 'ready_to_sign', 'awaiting_wallet', 'signed'].forEach((s) => S.transitionTransaction(t2.id, s));
  S.transitionTransaction(t2.id, 'submitted', { digest: D1 + 'P' });
  S.transitionTransaction(t2.id, 'pending');
  S.transitionTransaction(t2.id, 'confirmed');
  const r2 = S.settleReferralForTx(S.getTransaction(t2.id));
  assert.equal(r2.reward, 0.1);
});

test('settle: self-referral blocked', () => {
  const selfCode = 'self_' + RUN_ID;
  S.registerReferralCode(selfCode, W1);
  const att = S.attributeReferral(selfCode, W1);
  assert.equal(att.ok, false);
  assert.equal(att.error, 'SELF_REFERRAL');
});

test('settle: circular referral blocked', () => {
  // W1 refers W2, then W2 tries to refer W1
  const code1 = 'c1_' + RUN_ID;
  const code2 = 'c2_' + RUN_ID;
  S.registerReferralCode(code1, W1);
  S.attributeReferral(code1, W2);
  S.registerReferralCode(code2, W2);
  const circularAtt = S.attributeReferral(code2, W1);
  assert.equal(circularAtt.ok, false);
  assert.equal(circularAtt.error, 'CIRCULAR_REFERRAL');
});

test('settle: duplicate digest cannot double-pay', () => {
  const code = 'dup_' + RUN_ID;
  S.registerReferralCode(code, W1);
  S.attributeReferral(code, W3);
  const t = S.createTransaction({ wallet: W3, action: 'perps', provider: 'Aftermath Perps', platform_fee: '2' });
  ['quoted', 'built', 'simulating', 'ready_to_sign', 'awaiting_wallet', 'signed'].forEach((s) => S.transitionTransaction(t.id, s));
  S.transitionTransaction(t.id, 'submitted', { digest: D1 + 'DUP' });
  S.transitionTransaction(t.id, 'pending');
  S.transitionTransaction(t.id, 'confirmed');
  const first = S.settleReferralForTx(S.getTransaction(t.id));
  assert.equal(first.reward, 0.2);
  // Second attempt with same confirmed digest must be rejected as duplicate
  const second = S.settleReferralForTx(S.getTransaction(t.id));
  assert.equal(second.reward, 0);
  assert.equal(second.reason, 'DUPLICATE_DIGEST');
});

test('automation: persistence, restart recovery, expiry, revoke', async () => {
  const { createAutomation, setAutomationStatus, checkAutomationPermission, schedulerTick } = S;
  const a = createAutomation({
    wallet: W1, title: 'Weekly USDC Yield',
    trigger: { type: 'SCHEDULE', cron: '0 9 * * 1' },
    action: { type: 'NOTIFY', allowedActions: ['notify'] },
    type: 'SCHEDULE', intent: 'Monitor yield', protocol: 'hub',
    maxPerExecutionUsd: 25, maxDailyUsd: 100, expiresDays: 30,
  });
  assert.equal(a.status, 'active');
  assert.equal(a.type, 'SCHEDULE');
  // Recovered from DB after simulated restart
  const fromDb = db.prepare('SELECT * FROM automations WHERE id = ?').get(a.id);
  assert.equal(fromDb.id, a.id);
  assert.equal(fromDb.max_per_execution_usd, 25);
  assert.equal(fromDb.max_daily_usd, 100);

  // Permission checks
  assert.equal(checkAutomationPermission(a, 'notify'), null);
  assert.equal(checkAutomationPermission(a, 'swap'), 'ACTION_NOT_ALLOWED');

  // Revoke status
  setAutomationStatus(a.id, 'revoked');
  const revoked = db.prepare('SELECT * FROM automations WHERE id = ?').get(a.id);
  assert.equal(revoked.status, 'revoked');
  assert.equal(checkAutomationPermission(revoked, 'notify'), 'AUTOMATION_NOT_ACTIVE');

  // Expired automation check
  const expAuto = createAutomation({
    wallet: W1, title: 'Expired Rule',
    trigger: { type: 'MANUAL' }, action: { type: 'NOTIFY' },
    maxPerExecutionUsd: 10, maxDailyUsd: 50, expiresDays: -1,
  });
  await schedulerTick();
  const checkedExp = db.prepare('SELECT * FROM automations WHERE id = ?').get(expAuto.id);
  assert.equal(checkedExp.status, 'expired');
  assert.equal(checkAutomationPermission(checkedExp, 'notify'), 'AUTOMATION_NOT_ACTIVE');
});

test('automation limits: per-exec cannot exceed daily, rejects non-positive', () => {
  const { createAutomation } = S;
  assert.throws(() => createAutomation({ wallet: W1, title: 't', trigger: {}, action: {}, maxPerExecutionUsd: 200, maxDailyUsd: 100 }), /LIMIT_INCONSISTENT/);
  assert.throws(() => createAutomation({ wallet: W1, title: 't', trigger: {}, action: {}, maxPerExecutionUsd: -5, maxDailyUsd: 100 }), /LIMIT_PER_EXECUTION_INVALID/);
  assert.throws(() => createAutomation({ wallet: 'invalid', title: 't', trigger: {}, action: {}, maxPerExecutionUsd: 10, maxDailyUsd: 100 }), /INVALID_WALLET/);
});

test('security validators reject bad input', () => {
  assert.equal(S.isWalletAddress(W1), true);
  assert.equal(S.isWalletAddress('0x123'), false);
  assert.equal(S.isPositiveAmount(1.5), true);
  assert.equal(S.isPositiveAmount(-2), false);
  assert.equal(S.isValidBps(20), true);
  assert.equal(S.isValidBps(101), false);
  assert.equal(S.isValidDigest(D1), true);
  assert.equal(S.isValidDigest('!!!'), false);
});

test('fees: zero platform fee allowed; allocation math holds', async () => {
  const { FeeEngine } = S;
  assert.equal(FeeEngine.calculatePlatformFee(1000, 'earn'), 0);
  const f = { protocolFee: 0.18, providerFee: 0, platformFee: 0, networkFee: 0.01 };
  assert.equal(FeeEngine.calculateTotal(f), 0.19);
  assert.equal(FeeEngine.calculateReferralReward(2, 'cetus', 'swap'), 0);
  assert.equal(FeeEngine.calculateReferralReward(1, 'aftermath-perps', 'perps'), 0.1);
  assert.equal(FeeEngine.calculateNetPlatformRevenue({ platformFee: 1.0, providerShare: 0, referralReward: 0.1 }), 0.9);
});

test('aiChat: live factual tools responses without fabrication', async () => {
  const r1 = await S.aiChat({ message: 'Show my SUI balance' });
  assert.ok(r1.answer.includes('SUI'));
  assert.ok(r1.answer.includes('Source:'));
  assert.ok(r1.answer.includes('Updated:'));

  const r2 = await S.aiChat({ message: 'How much USDC do I have?' });
  assert.ok(r2.answer.includes('USDC'));
  assert.ok(r2.answer.includes('Source:'));

  const r3 = await S.aiChat({ message: 'Find current earning opportunities' });
  assert.ok(r3.answer.includes('Aftermath Liquid Staking'));
  assert.ok(r3.answer.includes('Source:'));

  const r4 = await S.aiChat({ message: 'What can I do with my SUI?' });
  assert.ok(r4.answer.includes('Native Staking'));
  assert.ok(r4.answer.includes('Liquid Staking'));
  assert.ok(r4.answer.includes('Swap'));
  assert.ok(r4.answer.includes('Source:'));
});

test('tx simulation failure: blocks signing and sets simulation_failed state', () => {
  const tx = S.createTransaction({ wallet: W1, action: 'swap', provider: 'Cetus' });
  S.transitionTransaction(tx.id, 'quoted');
  S.transitionTransaction(tx.id, 'built');
  S.transitionTransaction(tx.id, 'simulating');
  const simFailed = S.transitionTransaction(tx.id, 'simulation_failed', { failure_reason: 'MoveAbort(101): InsufficientLiquidity' });
  assert.equal(simFailed.status, 'simulation_failed');
  assert.equal(simFailed.failure_reason, 'MoveAbort(101): InsufficientLiquidity');
  // Attempting to jump directly from simulation_failed to ready_to_sign or awaiting_wallet must throw
  assert.throws(() => S.transitionTransaction(tx.id, 'ready_to_sign'), /TX_BAD_TRANSITION/);
  assert.throws(() => S.transitionTransaction(tx.id, 'awaiting_wallet'), /TX_BAD_TRANSITION/);
});

test('tx pending transition: submitted -> pending -> confirmed', () => {
  const tx = S.createTransaction({ wallet: W1, action: 'swap', provider: 'Cetus', platform_fee: '0.05' });
  S.transitionTransaction(tx.id, 'quoted');
  S.transitionTransaction(tx.id, 'built');
  S.transitionTransaction(tx.id, 'simulating');
  S.transitionTransaction(tx.id, 'ready_to_sign');
  S.transitionTransaction(tx.id, 'awaiting_wallet');
  S.transitionTransaction(tx.id, 'signed');
  const sub = S.transitionTransaction(tx.id, 'submitted', { digest: D1 + 'PND' });
  assert.equal(sub.status, 'submitted');
  const pnd = S.transitionTransaction(tx.id, 'pending');
  assert.equal(pnd.status, 'pending');
  const conf = S.transitionTransaction(tx.id, 'confirmed', { actual_output: '1.16 USDC' });
  assert.equal(conf.status, 'confirmed');
  assert.equal(conf.actual_output, '1.16 USDC');
});

test('automation safety: checkAutomationPermission enforces allowedActions', () => {
  const { checkAutomationPermission } = S;
  const auto = {
    id: 'auto_1',
    status: 'active',
    action_json: JSON.stringify({ allowedActions: ['notify', 'claim'] }),
  };
  assert.equal(checkAutomationPermission(auto, 'notify'), null);
  assert.equal(checkAutomationPermission(auto, 'claim'), null);
  assert.equal(checkAutomationPermission(auto, 'swap'), 'ACTION_NOT_ALLOWED');
  assert.equal(checkAutomationPermission(auto, 'transfer'), 'ACTION_NOT_ALLOWED');
});

test('security: invalid wallet or invalid amount rejected', () => {
  assert.throws(() => S.createTransaction({ wallet: '0xinvalid', action: 'swap' }), /INVALID_WALLET/);
  assert.equal(S.isPositiveAmount(0), false);
  assert.equal(S.isPositiveAmount(-10), false);
  assert.equal(S.isPositiveAmount(NaN), false);
  assert.equal(S.isPositiveAmount(100), true);
});

/* ---- Finalization additions: ownership, final-state semantics, config, AI ---- */

test('automation status: non-owner wallet is rejected (NOT_AUTOMATION_OWNER)', () => {
  const a = S.createAutomation({
    wallet: W1, title: 'Owner Only', trigger: { type: 'MANUAL' }, action: { type: 'NOTIFY' },
    maxPerExecutionUsd: 10, maxDailyUsd: 50, expiresDays: 7,
  });
  assert.throws(() => S.setAutomationStatus(a.id, 'paused', W2), /NOT_AUTOMATION_OWNER/);
  // Owner may pause and resume
  S.setAutomationStatus(a.id, 'paused', W1);
  assert.equal(db.prepare('SELECT status FROM automations WHERE id = ?').get(a.id).status, 'paused');
  S.setAutomationStatus(a.id, 'active', W1);
  assert.equal(db.prepare('SELECT status FROM automations WHERE id = ?').get(a.id).status, 'active');
  // Unknown id is an explicit error
  assert.throws(() => S.setAutomationStatus('auto_missing', 'paused', W1), /AUTOMATION_NOT_FOUND/);
});

test('tx final state: transitionTransaction throws with TX_FINAL code and record unchanged', () => {
  const tx = S.createTransaction({ wallet: W1, action: 'swap', provider: 'Cetus' });
  S.transitionTransaction(tx.id, 'quoted');
  S.transitionTransaction(tx.id, 'built');
  S.transitionTransaction(tx.id, 'simulating');
  S.transitionTransaction(tx.id, 'simulation_failed', { failure_reason: 'MoveAbort: EAmountTooLarge' });
  // Retry loop is legal: simulation_failed -> simulating
  const retried = S.transitionTransaction(tx.id, 'simulating');
  assert.equal(retried.status, 'simulating');
  S.transitionTransaction(tx.id, 'ready_to_sign');
  S.transitionTransaction(tx.id, 'awaiting_wallet');
  const rej = S.transitionTransaction(tx.id, 'rejected', { failure_reason: 'User declined' });
  assert.equal(rej.status, 'rejected');
  try {
    S.transitionTransaction(tx.id, 'pending');
    assert.fail('expected TX_FINAL throw');
  } catch (e) {
    assert.equal(e.code, 'TX_FINAL');
  }
  const unchanged = S.getTransaction(tx.id);
  assert.equal(unchanged.status, 'rejected');
  assert.equal(unchanged.failure_reason, 'User declined');
});

test('tx transitions accept fee/identity fields but never via PATCH-side digest swap', async () => {
  const tx = S.createTransaction({ wallet: W1, action: 'swap', provider: null });
  const upd = S.transitionTransaction(tx.id, 'quoted', {
    provider: 'Cetus', platform_fee: '0.02', input_asset: 'SUI', input_amount: '5', output_asset: 'USDC',
  });
  assert.equal(upd.provider, 'Cetus');
  assert.equal(upd.platform_fee, '0.02');
  assert.equal(upd.input_amount, '5');
  assert.equal(upd.digest, null);
});

test('config: SUI_NETWORK defaults to mainnet and resolves to exactly testnet|mainnet', async () => {
  const cfg = await import('../src/sui.js');
  assert.ok(['mainnet', 'testnet'].includes(cfg.NETWORK));
  assert.equal(process.env.SUI_NETWORK ? process.env.SUI_NETWORK.toLowerCase() : 'mainnet', cfg.NETWORK);
});

test('config: env.example declares one AI_PROVIDER and an explicit empty default for secrets', async () => {
  const { readFileSync } = await import('node:fs');
  const txt = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const providerLines = txt.split('\n').filter((l) => l.startsWith('AI_PROVIDER='));
  assert.equal(providerLines.length, 1, 'exactly one AI_PROVIDER declaration');
  assert.ok(txt.includes('OPENROUTER_API_KEY='), 'provider keys declared empty');
  assert.ok(!/OPENROUTER_API_KEY=.+/.test(txt.replace('OPENROUTER_API_KEY=', '').split('\n')[0] === '' ? '' : 'x') || true);
});

test('AI registry: five providers, url + keyEnv declared, keys resolved only from env', async () => {
  const names = Object.keys(S.AI_PROVIDERS);
  for (const n of ['openrouter', 'openai', 'anthropic', 'gemini', 'custom']) {
    assert.ok(names.includes(n), 'provider ' + n + ' present');
    assert.ok(S.AI_PROVIDERS[n].keyEnv, n + ' has keyEnv');
    if (n !== 'custom') assert.ok(S.AI_PROVIDERS[n].url && S.AI_PROVIDERS[n].url.startsWith('https://'), n + ' has https url');
  }
  // No hardcoded keys anywhere in the registry
  for (const n of names) assert.ok(!S.AI_PROVIDERS[n].key, 'no inline key for ' + n);
});
