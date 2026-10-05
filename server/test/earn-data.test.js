// Earn data semantics tests (production data fix): missing/zero/edge APR cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePool, formatAprPct, numOrNull, poolDiagnostics } from '../../shared/earn-normalize.js';

const base = { name: 'SUI/USDC LP', poolId: '0xpool', tvl: 87357, volume24h: 1200, fees24h: 3.35, apr: 0.014 };

test('valid non-zero APR: fraction → percent, provider basis', () => {
  const p = normalizePool(base);
  assert.equal(p.tvl, 87357);
  assert.equal(p.fees24h, 3.35);
  assert.ok(Math.abs(p.totalApr - 1.4) < 1e-9);
  assert.equal(p.aprBasis, 'provider');
  assert.equal(formatAprPct(p.totalApr), '1.40%');
});

test('missing APR never becomes 0.00%', () => {
  const p = normalizePool({ name: 'LBTC/suiWBTC', tvl: 126041, fees24h: 0.0018 });
  // fee APR computable, or unknown → never 0.
  if (p.totalApr === null) assert.equal(formatAprPct(p.totalApr), '—');
  else assert.notEqual(formatAprPct(p.totalApr), '0.00%');
  assert.equal(formatAprPct(null), '—');
  assert.equal(formatAprPct(undefined), '—');
  assert.equal(formatAprPct(NaN), '—');
});

test('real zero fees → real 0 APR (allowed to render 0.00%)', () => {
  const p = normalizePool({ name: 'ZeroFee', tvl: 100000, fees24h: 0 });
  assert.equal(p.feeApr, 0);
  assert.equal(p.totalApr, 0);
  assert.equal(p.exactZero, true);
  assert.equal(formatAprPct(0), '0.00%');
});

test('extremely small APR → "< 0.01%", not 0.00%', () => {
  const p = normalizePool({ name: 'Tiny', tvl: 1e9, fees24h: 0.001 });
  assert.ok(p.totalApr > 0 && p.totalApr < 0.01);
  assert.equal(formatAprPct(p.totalApr), '< 0.01%');
  assert.equal(formatAprPct(0.00036), '< 0.01%');
});

test('missing rewards → rewardApr null, rewardsAvailable false', () => {
  const p = normalizePool(base);
  assert.equal(p.rewardApr, null);
  assert.equal(p.rewardsAvailable, false);
});

test('missing TVL → cannot compute fee APR', () => {
  const p = normalizePool({ name: 'NoTvl', fees24h: 5 });
  assert.equal(p.tvl, null);
  assert.equal(p.feeApr, null);
  assert.equal(p.totalApr, null);
});

test('null / undefined provider fields → all metrics null, pool still returned', () => {
  const p = normalizePool({});
  assert.equal(p.tvl, null);
  assert.equal(p.fees24h, null);
  assert.equal(p.volume24h, null);
  assert.equal(p.totalApr, null);
  assert.equal(formatAprPct(p.totalApr), '—');
});

test('raw stats wrapper shape is supported', () => {
  const p = normalizePool({ pool: { name: 'Wrapped', objectId: '0x1' }, stats: { tvl: 5000, volume: 10, fees: 1, apr: 0.05 } });
  assert.equal(p.name, 'Wrapped');
  assert.equal(p.poolId, '0x1');
  assert.equal(p.tvl, 5000);
  assert.ok(Math.abs(p.totalApr - 5) < 1e-9);
});

test('numOrNull rejects empty/NaN/Infinity', () => {
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull(Infinity), null);
  assert.equal(numOrNull('3.5'), 3.5);
});

test('poolDiagnostics surfaces every field + the displayed APR', () => {
  const d = poolDiagnostics({ name: 'AF', tvl: 87357, fees24h: 3.35, apr: 0.014 });
  assert.equal(d.feeApr, '1.400%');
  assert.equal(d.rewardApr, 'unavailable');
  assert.ok(d.totalApr.endsWith('%'));
  assert.equal(d.displayedApr, '1.40%');
  assert.equal(d.dataSource, 'Aftermath Pools');
});
