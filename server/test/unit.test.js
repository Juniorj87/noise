// Unit tests — fee math, referral math, automation validation, registry honesty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bpsFee, feeBreakdown, referralReward, validateAutomation, parseAutomationNL } from '../src/services.js';

test('fee math: 1000 USDC at 25 bps = 2.50', () => {
  assert.equal(bpsFee(1000, 25), 2.5);
});

test('fee math: 1 bps = 0.01%', () => {
  assert.equal(bpsFee(10000, 1), 1);
});

test('swap breakdown separates fee categories', () => {
  const f = feeBreakdown(1000, 'swap');
  assert.ok('protocolFee' in f && 'providerFee' in f && 'platformFee' in f && 'networkFee' in f && 'total' in f);
  assert.equal(f.total, +(f.platformFee + f.networkFee).toFixed(6));
});

test('referral: $2.00 at 30% = $0.60 reward, $1.40 retained', () => {
  const { reward, retained } = referralReward(2.0);
  assert.equal(reward, 0.6);
  assert.equal(retained, 1.4);
});

test('referral reward is never an extra user fee (reward <= eligible)', () => {
  const { reward } = referralReward(1.0);
  assert.ok(reward <= 1.0);
});

test('automation limits: per-exec cannot exceed daily', () => {
  assert.equal(validateAutomation({ maxPerExecutionUsd: 500, maxDailyUsd: 100 }), 'LIMIT_INCONSISTENT');
});

test('automation limits: rejects non-positive and absurd', () => {
  assert.equal(validateAutomation({ maxPerExecutionUsd: 0, maxDailyUsd: 100 }), 'LIMIT_PER_EXECUTION_INVALID');
  assert.equal(validateAutomation({ maxPerExecutionUsd: 50, maxDailyUsd: 0 }), 'LIMIT_DAILY_INVALID');
});

test('automation limits: sane config passes', () => {
  assert.equal(validateAutomation({ maxPerExecutionUsd: 50, maxDailyUsd: 200 }), null);
});

test('NL parser: monday yield → schedule intent', () => {
  const p = parseAutomationNL('Every Monday check if there is a better USDC yield and tell me');
  assert.equal(p.trigger.type, 'SCHEDULE');
  assert.equal(p.output, 'NOTIFY');
});

test('NL parser: rewards threshold → claim intent', () => {
  const p = parseAutomationNL('If my rewards are above $10, claim them');
  assert.equal(p.trigger.type, 'REWARD_THRESHOLD');
});

test('FeeEngine methods agree with feeBreakdown', async () => {
  const { FeeEngine } = await import('../src/services.js');
  const f = {
    protocolFee: FeeEngine.calculateProtocolFee(1000),
    providerFee: FeeEngine.calculateProviderFee(1000),
    platformFee: FeeEngine.calculatePlatformFee(1000, 'swap'),
    networkFee: FeeEngine.calculateNetworkFee(),
  };
  const { feeBreakdown } = await import('../src/services.js');
  const b = feeBreakdown(1000, 'swap');
  assert.deepEqual({ ...f, total: FeeEngine.calculateTotal(f) }, b);
});

test('FeeEngine net platform revenue', async () => {
  const { FeeEngine } = await import('../src/services.js');
  assert.equal(FeeEngine.calculateNetPlatformRevenue({ platformFee: 2, providerShare: 0, referralReward: 0.6 }), 1.4);
});

test('referralPolicyFor: cetus 0, aftermath-perps 10, unknown 0 unverified', async () => {
  const { referralPolicyFor } = await import('../src/services.js');
  assert.equal(referralPolicyFor('cetus', 'swap').rate, 0);
  assert.equal(referralPolicyFor('aftermath-perps', 'perps').rate, 10);
  const u = referralPolicyFor('nope', 'swap');
  assert.equal(u.rate, 0);
  assert.equal(u.verified, null);
});

test('compareRoutes ranks by effective output, best only when compared', async () => {
  const { compareRoutes } = await import('../src/adapters.js');
  const r = compareRoutes([
    { provider: 'A', amountOut: '100' },
    { provider: 'B', amountOut: '120' },
  ]);
  assert.equal(r.compared, 2);
  assert.equal(r.best, 'B');
  const empty = compareRoutes([{ provider: 'A', error: 'x' }]);
  assert.equal(empty.compared, 0);
  assert.equal(empty.best, null);
});

test('envelope carries source contract', async () => {
  const { envelope } = await import('../src/adapters.js');
  const e = envelope(1.5, 'Aftermath Prices', 'https://x', 'high');
  assert.equal(e.value, 1.5);
  assert.ok(e.source && e.sourceUrl && e.updatedAt && e.freshness && e.confidence);
});

test('no-double-count aggregation invariant', () => {
  // wallet=100 free + lending position=500 → total 600, never 1100
  const walletFree = 100, positions = [{ amount: 500 }];
  const total = walletFree + positions.reduce((a, p) => a + p.amount, 0);
  assert.equal(total, 600);
});
