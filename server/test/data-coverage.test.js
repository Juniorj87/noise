// DATA PASS coverage matrix — offline. Verifies: normalization honesty
// (missing ≠ 0, no silent fallbacks, APY/APR never confused), the static
// provider→field coverage matrix against live code, and guards against demo
// literals and float-fallback patterns in data paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  numOrNull, valueState, freshState, fmtAge,
  normalizePool, formatAprPct, normalizeApy, aprToApy, formatApyPct,
} from '../../shared/earn-normalize.js';
import { PROTOCOLS, getProtocol } from '../../shared/registry.js';
import * as earnLib from '../../api/_lib/earn.js';

const root = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/* ---------- normalization: API → model ---------- */
test('data: numOrNull never invents — missing/invalid → null', () => {
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull(NaN), null);
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull(0), 0);
  assert.equal(numOrNull('0'), 0);
  assert.equal(numOrNull('12.5'), 12.5);
});

test('data: valueState separates missing / zero / invalid / ok', () => {
  assert.equal(valueState(null), 'missing');
  assert.equal(valueState(undefined), 'missing');
  assert.equal(valueState(''), 'missing');
  assert.equal(valueState(0), 'zero');
  assert.equal(valueState('0'), 'zero');
  assert.equal(valueState('nope'), 'invalid');
  assert.equal(valueState(1.43), 'ok');
});

test('data: empty pool normalizes to all-null, never zeros', () => {
  const p = normalizePool({});
  assert.equal(p.tvl, null);
  assert.equal(p.volume24h, null);
  assert.equal(p.fees24h, null);
  assert.equal(p.totalApr, null);
  assert.equal(p.aprBasis, null);
  assert.equal(p.rewardApr, null);
  assert.equal(formatAprPct(p.totalApr), '—');
});

test('data: exact zero renders 0.00% (confirmed zero, not missing)', () => {
  assert.equal(formatAprPct(0), '0.00%');
  assert.equal(formatAprPct(null), '—');
  assert.equal(formatAprPct(undefined), '—');
  assert.equal(formatAprPct('—'), '—');
  assert.equal(formatAprPct(0.004), '< 0.01%');
  assert.equal(formatAprPct(6.42), '6.42%');
});

test('data: provider fraction APR converts once, explicitly', () => {
  const p = normalizePool({ name: 'X', stats: { tvl: 1000, fees: 10, apr: 0.0642 } });
  assert.ok(Math.abs(p.totalApr - 6.42) < 1e-9, 'fraction 0.0642 → 6.42%, got ' + p.totalApr);
  assert.equal(p.aprBasis, 'provider');
  // fee APR computed only from real fees/TVL with labelled basis
  assert.ok(Math.abs(p.feeApr - (10 * 365 / 1000 * 100)) < 1e-9);
  const noFees = normalizePool({ name: 'Y', stats: { tvl: 1000 } });
  assert.equal(noFees.feeApr, null);
  assert.equal(noFees.totalApr, null);
});

test('data: APY keeps provider basis; APR never relabelled as APY', () => {
  // Aftermath staking SDK: decimal ratio 0.0143 = 1.43% APY
  const a = normalizeApy(0.0143, { unit: 'ratio', source: 'Aftermath Staking SDK' });
  assert.equal(a.kind, 'apy');
  assert.equal(a.pct, 1.43);
  assert.equal(a.basis, 'provider');
  assert.equal(formatApyPct(a.pct), '1.43%');
  assert.equal(formatApyPct(null), '—');
  assert.equal(formatApyPct(0), '0.00%');
  // APR→APY only with a confirmed compounding model
  assert.equal(aprToApy(7, null), null);
  assert.equal(aprToApy(null, 365), null);
  const daily = aprToApy(7, 365);
  assert.ok(Math.abs(daily - ((Math.pow(1 + 0.07 / 365, 365) - 1) * 100)) < 1e-6);
});

test('data: freshness states from timestamps', () => {
  const now = Date.now();
  assert.equal(freshState(new Date(now - 8000).toISOString(), now), 'LIVE');
  assert.equal(freshState(new Date(now - 60000).toISOString(), now), 'RECENT');
  assert.equal(freshState(new Date(now - 600000).toISOString(), now), 'STALE');
  assert.equal(freshState(null), 'UNAVAILABLE');
  assert.equal(freshState('garbage'), 'UNAVAILABLE');
  assert.equal(fmtAge(new Date(now - 8000).toISOString(), now), '8s');
  assert.equal(fmtAge(null), '—');
});

test('data: validator APY missing stays null (no silent 0)', () => {
  const rows = earnLib.normalizeValidators(
    { activeValidators: [{ suiAddress: '0xabc', name: 'V', stakingPoolSuiBalance: '5' }] },
    { apys: [] },
  );
  assert.equal(rows[0].apy, null);
  const withApy = earnLib.normalizeValidators(
    { activeValidators: [{ suiAddress: '0xabc', name: 'V', stakingPoolSuiBalance: '5' }] },
    { apys: [{ address: '0xABC', apy: 0.05 }] },
  );
  assert.equal(withApy[0].apy, 0.05);
});

/* ---------- static coverage matrix: provider → field → code proof ---------- */
test('data: coverage matrix matches live code (honest DISCOVER, no invented DATA)', () => {
  const matrix = [
    // [protocolId, field, expected, proof]
    ['aftermath', 'pools+APR', 'LIVE', normalizePool({ name: 't', stats: { tvl: 1, apr: 0.01 } }).totalApr === 1],
    ['aftermath', 'staking-APY', 'LIVE', typeof earnLib.aftermathApi === 'function'],
    ['sui-native', 'stakes', 'LIVE', typeof earnLib.getPositions === 'function'],
    ['sui-native', 'validators', 'LIVE', typeof earnLib.getValidators === 'function'],
    ['deepbook', 'orderbook', 'LIVE', getProtocol('deepbook').capability.trade === true],
    ['deepbook', '24h-ticker', 'UNAVAILABLE', getProtocol('deepbook').note.length > 0],
    ['navi', 'lending-DATA', 'LIVE', getProtocol('navi').status === 'PARTIAL' && getProtocol('navi').capability.data === true],
    ['suilend', 'lending-DATA', 'LIVE', getProtocol('suilend').status === 'PARTIAL' && getProtocol('suilend').capability.data === true],
    ['scallop', 'lending-DATA', 'LIVE', getProtocol('scallop').status === 'PARTIAL' && getProtocol('scallop').capability.data === true],
    ['bucket', 'lending-DATA', 'LIVE', getProtocol('bucket').status === 'PARTIAL' && getProtocol('bucket').capability.data === true],
    ['haedal', 'staking-DATA', 'PENDING', getProtocol('haedal').status === 'PARTIAL'],
    ['volo', 'staking-DATA', 'LIVE', getProtocol('volo').status === 'LIVE' && getProtocol('volo').capability.data === true],
    ['springsui', 'staking-DATA', 'LIVE', getProtocol('springsui').status === 'PARTIAL' && getProtocol('springsui').capability.data === true],
    ['turbos', 'swap-DATA', 'LIVE', getProtocol('turbos').status === 'LIVE' && getProtocol('turbos').capability.data === true],
    ['bluefin-perps', 'trade-DATA', 'LIVE', getProtocol('bluefin-perps').status === 'PARTIAL' && getProtocol('bluefin-perps').capability.data === true],
    ['metastable', 'vault-DATA', 'LIVE', getProtocol('metastable').status === 'PARTIAL' && getProtocol('metastable').capability.data === true],
    ['obric', 'removed', 'REMOVED', getProtocol('obric') === null],
    ['deepbook-predict', 'markets', 'LIVE', getProtocol('deepbook-predict').status === 'LIVE'],
    ['deepbook-margin', 'execution', 'COMING_SOON', getProtocol('deepbook-margin').status === 'COMING_SOON'],
    ['cetus', 'swap', 'LIVE', getProtocol('cetus').capability.execution === true],
  ];
  const bad = matrix.filter(([, , , proof]) => !proof);
  assert.deepEqual(bad.map((b) => b[0] + '/' + b[1]), []);
  // every matrix protocol exists in the canonical registry — except rows that
  // assert a deliberate removal (expected === 'REMOVED').
  for (const [id, , expected] of matrix) {
    if (expected === 'REMOVED') assert.equal(getProtocol(id), null, id + ' should stay removed');
    else assert.ok(getProtocol(id), 'registry missing ' + id);
  }
  assert.ok(PROTOCOLS.length >= 20, 'registry unexpectedly small');
});

/* ---------- guards: no demo literals, no silent fallbacks in data paths ---------- */
test('data: no hardcoded demo financials in shipped frontend', () => {
  const html = root('../../app.html');
  for (const demo of ['$84.20', '$25.26', '$0.42', '$0.13', '184 referrals', 'Protocol X']) {
    assert.ok(!html.includes(demo), 'demo literal leaked: ' + demo);
  }
  // leaderboard/stats render only API values or em-dash placeholders
  assert.ok(html.includes('No referral activity yet'));
});

test('data: no silent zero-fallbacks in normalization layer', () => {
  const norm = root('../../shared/earn-normalize.js');
  assert.ok(!/\|\| 0(?!\.)/.test(norm), '|| 0 fallback in earn-normalize.js');
  assert.ok(!/\?\? 0(?!\.)/.test(norm), '?? 0 fallback in earn-normalize.js');
  const earn = root('../../api/_lib/earn.js');
  assert.ok(earn.includes('Missing APY stays missing'), 'APY null-guard missing');
});

test('data: staking APY carries explicit ratio units in both adapters', async () => {
  for (const p of ['../../api/_lib/adapters.js', '../../server/src/adapters.js']) {
    const src = root(p);
    assert.ok(src.includes("unit: 'ratio'"), p + ' missing APY unit metadata');
    assert.ok(src.includes("kind: 'apy'"), p + ' missing APY kind metadata');
  }
});
