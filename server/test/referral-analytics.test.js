// Referral → Revenue → Rewards → Leaderboard → Analytics tests.
// Covers: attribution, revenue states, accounting math, idempotency,
// leaderboard ordering/ties/periods/viewer-rank, privacy, reconciliation.
// No network. SQLite dev DB with unique wallets per run + full cleanup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const RUN = Date.now().toString(36) + randomBytes(3).toString('hex');
const TEST_WALLETS = new Set();
const W = (n) => {
  const w = '0x' + n.toString(16).padStart(62, '0') + RUN.replace(/[^0-9a-f]/gi, 'a').slice(0, 2).padEnd(2, 'a');
  TEST_WALLETS.add(w);
  return w;
};
const CODE = (s) => ('t' + RUN + s).toLowerCase().replace(/[^a-z0-9-_]/g, 'x').slice(0, 20);
const DIGEST = (s) => ('Dg' + RUN + s + 'AbC123XyZ456AbC123XyZ45').slice(0, 40);

let S, A, L, db;
before(async () => {
  S = await import('../src/services.js');
  A = await import('../src/referral-analytics.js');
  L = await import('../../shared/logic.js');
  db = (await import('../src/db.js')).db;
});

const CREATED_IDS = { tx: [], ref: [], rev: [], rew: [], pay: [] };
function track(table, id) { CREATED_IDS[table].push(id); }

function confirmTx(wallet, { fee = '2', provider = 'aftermath-perps', action = 'perps', digest } = {}) {
  const tx = S.createTransaction({ wallet, action, provider, platform_fee: fee });
  track('tx', tx.id);
  S.transitionTransaction(tx.id, 'submitted', { digest });
  S.transitionTransaction(tx.id, 'pending');
  return S.transitionTransaction(tx.id, 'confirmed');
}
function cleanup() {
  try {
    for (const w of TEST_WALLETS) {
      db.prepare('DELETE FROM referral_attributions WHERE referrer = ? OR referred_wallet = ?').run(w, w);
    }
    for (const id of CREATED_IDS.rew) db.prepare('DELETE FROM referral_rewards WHERE id = ?').run(id);
    for (const id of CREATED_IDS.rev) db.prepare('DELETE FROM revenue_entries WHERE id = ?').run(id);
    for (const id of CREATED_IDS.tx) db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    for (const id of CREATED_IDS.pay) db.prepare('DELETE FROM referral_payouts WHERE id = ?').run(id);
    for (const id of CREATED_IDS.ref) db.prepare('DELETE FROM referrals WHERE id = ?').run(id);
  } catch { /* best-effort */ }
}
after(() => { S.invalidateCache('leaderboard:'); cleanup(); });

/* ---------- attribution ---------- */
test('attribution: one link attributes many wallets; self + circular blocked', () => {
  const referrer = W(101), referred = W(102), other = W(103);
  const code = CODE('attr1');
  const reg = S.registerReferralCode(code, referrer);
  track('ref', reg.id);
  const a1 = S.attributeReferral(code, referred);
  assert.equal(a1.ok, true);
  // repeat attribution of the same wallet → idempotent, no duplicate row
  const before = db.prepare('SELECT COUNT(*) AS c FROM referral_attributions WHERE referred_wallet = ?').get(referred).c;
  const a2 = S.attributeReferral(code, referred);
  assert.equal(a2.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM referral_attributions WHERE referred_wallet = ?').get(referred).c, before);
  // a second wallet on the same code → multi-attribution allowed (one link, many people)
  const multi = S.attributeReferral(code, other);
  assert.equal(multi.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM referral_attributions WHERE code = ? AND referrer = ?', [code, referrer]).get(code, referrer).c, 2);
  // self referral → reject
  const self = S.attributeReferral(code, referrer);
  assert.equal(self.ok, false);
  assert.equal(self.error, 'SELF_REFERRAL');
  // circular: referred tries to refer the referrer back
  const code2 = CODE('attr2');
  const reg2 = S.registerReferralCode(code2, referred);
  track('ref', reg2.id);
  const circ = S.attributeReferral(code2, referrer);
  assert.equal(circ.ok, false);
  assert.equal(circ.error, 'CIRCULAR_REFERRAL');
  // wallet attributed elsewhere keeps its ORIGINAL referrer
  const code3 = CODE('attr3');
  const reg3 = S.registerReferralCode(code3, W(104));
  track('ref', reg3.id);
  const steal = S.attributeReferral(code3, referred);
  assert.equal(steal.ok, false);
  assert.equal(steal.error, 'ALREADY_ATTRIBUTED');
});

test('attribution: overwrite rejected after qualifying confirmed action', () => {
  const referrer = W(111), referred = W(112);
  const code = CODE('frz1');
  const reg = S.registerReferralCode(code, referrer);
  track('ref', reg.id);
  assert.equal(S.attributeReferral(code, referred).ok, true);
  confirmTx(referred, { digest: DIGEST('frz') }); // qualifying action → attribution frozen
  const code2 = CODE('frz2');
  const reg2 = S.registerReferralCode(code2, W(113));
  track('ref', reg2.id);
  const r = S.attributeReferral(code2, referred);
  assert.equal(r.ok, false);
  assert.ok(['ALREADY_ATTRIBUTED', 'ALREADY_ACTIVE'].includes(r.error), 'got ' + r.error);
});

/* ---------- revenue states: only confirmed + eligible settles ---------- */
test('revenue: confirmed tx with eligible fee settles 10% (aftermath-perps)', () => {
  const referrer = W(121), referred = W(122);
  const reg = S.registerReferralCode(CODE('rev1'), referrer);
  track('ref', reg.id);
  assert.equal(S.attributeReferral(reg.code, referred).ok, true);
  const tx = confirmTx(referred, { fee: '2', digest: DIGEST('rev1') });
  const s = S.settleReferralForTx(tx);
  assert.equal(s.reward, 0.2);
  assert.equal(s.retained, 1.8);
  track('rev', s.revenueId);
  const rew = db.prepare('SELECT * FROM referral_rewards WHERE revenue_id = ?').get(s.revenueId);
  track('rew', rew.id);
  assert.equal(rew.status, 'pending');
});

test('revenue: failed / expired / rejected txs settle nothing', () => {
  const t1 = S.createTransaction({ wallet: W(131), action: 'swap', provider: 'aftermath-perps', platform_fee: '5' });
  track('tx', t1.id);
  S.transitionTransaction(t1.id, 'submitted', { digest: DIGEST('fail1') });
  S.transitionTransaction(t1.id, 'pending');
  const failed = S.transitionTransaction(t1.id, 'failed', { failure_reason: 'MoveAbort' });
  assert.deepEqual(S.settleReferralForTx(failed), { reward: 0, reason: 'NOT_CONFIRMED' });
  const t2 = S.createTransaction({ wallet: W(132), action: 'swap', provider: 'aftermath-perps', platform_fee: '5' });
  track('tx', t2.id);
  S.transitionTransaction(t2.id, 'expired', { failure_reason: 'wallet closed' });
  assert.equal(S.settleReferralForTx(S.getTransaction(t2.id)).reason, 'NOT_CONFIRMED');
});

test('revenue: zero fee and zero-rate policy settle nothing', () => {
  const referrer = W(141), referred = W(142);
  const reg = S.registerReferralCode(CODE('zero1'), referrer);
  track('ref', reg.id);
  S.attributeReferral(reg.code, referred);
  const tx = confirmTx(referred, { fee: '0', digest: DIGEST('zero1') });
  assert.equal(S.settleReferralForTx(tx).reason, 'NO_ELIGIBLE_REVENUE');
  // cetus policy rate is 0 → no invented revenue
  const tx2 = S.createTransaction({ wallet: referred, action: 'swap', provider: 'cetus', platform_fee: '3' });
  track('tx', tx2.id);
  S.transitionTransaction(tx2.id, 'submitted', { digest: DIGEST('zero2') });
  S.transitionTransaction(tx2.id, 'pending');
  const c2 = S.transitionTransaction(tx2.id, 'confirmed');
  assert.equal(S.settleReferralForTx(c2).reason, 'POLICY_RATE_ZERO');
});

test('attribution: legacy referrals-row-only record still settles (backfill compat)', () => {
  const referrer = W(161), referred = W(162);
  const code = CODE('leg1');
  const reg = S.registerReferralCode(code, referrer);
  track('ref', reg.id);
  // Simulate a pre-migration row: referred slot filled, NO attributions-table row.
  db.prepare('UPDATE referrals SET referred_wallet = ? WHERE id = ?').run(referred, reg.id);
  db.prepare('DELETE FROM referral_attributions WHERE referred_wallet = ?').run(referred);
  const tx = confirmTx(referred, { fee: '3', digest: DIGEST('leg1') });
  const s = S.settleReferralForTx(tx);
  assert.equal(s.reward, 0.3);
  track('rev', s.revenueId);
  track('rew', db.prepare('SELECT * FROM referral_rewards WHERE revenue_id = ?').get(s.revenueId).id);
  // Idempotent backfill: re-running the migration must not duplicate or crash.
  db.prepare(`INSERT OR IGNORE INTO referral_attributions (id, code, referrer, referred_wallet, attributed_at, status)
    SELECT 'att_' || substr(id, 1, 40), code, referrer_wallet, referred_wallet, created_at, 'attributed'
    FROM referrals WHERE referred_wallet IS NOT NULL AND referrer_wallet IS NOT NULL`).run();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM referral_attributions WHERE referred_wallet = ?').get(referred).c, 1);
});

test('stats: same wallet in both attribution sources counts once (no double count)', () => {
  const referrer = W(171), referred = W(172);
  const reg = S.registerReferralCode(CODE('dedup1'), referrer);
  track('ref', reg.id);
  assert.equal(S.attributeReferral(reg.code, referred).ok, true);
  // Force divergent timestamps across the two sources (JS ISO vs SQLite datetime).
  db.prepare('UPDATE referral_attributions SET attributed_at = ? WHERE referred_wallet = ?')
    .run('2026-01-02T03:04:05.678Z', referred);
  db.prepare('UPDATE referrals SET created_at = ? WHERE id = ?')
    .run('2026-01-02 03:04:06', reg.id);
  const st = A.getReferralStats(referrer);
  assert.equal(st.referred, 1);
});

/* ---------- decimal-safe accounting ---------- */
test('accounting: $1 @30% = $0.30/$0.70; $2.50 @30% = $0.75/$1.75 (exact)', () => {
  assert.deepEqual(L.splitRevenue('1', 30), { reward: '0.3', retained: '0.7' });
  assert.deepEqual(L.splitRevenue('2.50', 30), { reward: '0.75', retained: '1.75' });
  assert.equal(L.toMinorUnits('2.50', 6), '2500000');
  assert.equal(L.fromMinorUnits('750000', 6), '0.75');
  assert.deepEqual(L.splitRevenueMinor('2500000', 3000), { rewardMinor: '750000', retainedMinor: '1750000' });
  // 0.1 + 0.2 float trap does not exist in minor units
  assert.equal(L.toMinorUnits('0.1', 6), '100000');
  assert.equal(L.toMinorUnits('0.2', 6), '200000');
});

test('accounting: SUM(REAL) float dust never reaches API payloads', () => {
  assert.equal(L.moneyStr(8.700000000000001), '8.7');
  assert.equal(L.moneyStr(82.10000000000001), '82.1');
  assert.equal(L.moneyStr(null), '0');
  assert.equal(L.moneyStr('2'), '2');
});

/* ---------- idempotency ---------- */
test('idempotency: same digest settles exactly once', () => {
  const referrer = W(151), referred = W(152);
  const reg = S.registerReferralCode(CODE('idem1'), referrer);
  track('ref', reg.id);
  S.attributeReferral(reg.code, referred);
  const tx = confirmTx(referred, { fee: '4', digest: DIGEST('idem1') });
  const first = S.settleReferralForTx(tx);
  assert.equal(first.reward, 0.4);
  track('rev', first.revenueId);
  track('rew', db.prepare('SELECT * FROM referral_rewards WHERE revenue_id = ?').get(first.revenueId).id);
  const before = db.prepare('SELECT COUNT(*) AS c FROM revenue_entries WHERE digest = ?').get(tx.digest).c;
  const second = S.settleReferralForTx(S.getTransaction(tx.id));
  assert.equal(second.reason, 'DUPLICATE_DIGEST');
  assert.equal(second.reward, 0);
  const afterCount = db.prepare('SELECT COUNT(*) AS c FROM revenue_entries WHERE digest = ?').get(tx.digest).c;
  assert.equal(before, 1);
  assert.equal(afterCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM referral_rewards WHERE revenue_id = ?').get(first.revenueId).c, 1);
});

/* ---------- leaderboard ---------- */
function seedEarner(n, { fee, referredCount = 1, action = 'perps', provider = 'aftermath-perps' }) {
  const referrer = W(200 + n);
  const reg = S.registerReferralCode(CODE('lb' + n), referrer);
  track('ref', reg.id);
  for (let i = 0; i < referredCount; i++) {
    const referred = W(300 + n * 10 + i);
    S.attributeReferral(reg.code, referred);
    const tx = confirmTx(referred, { fee, provider, action, digest: DIGEST('lb' + n + 'x' + i) });
    const s = S.settleReferralForTx(tx);
    if (s.revenueId) {
      track('rev', s.revenueId);
      const rw = db.prepare('SELECT * FROM referral_rewards WHERE revenue_id = ?').get(s.revenueId);
      if (rw) track('rew', rw.id);
    }
  }
  S.invalidateCache('leaderboard:');
  return referrer;
}

test('leaderboard: ordered by earned DESC with deterministic tie-breaks', async () => {
  const big = seedEarner(1, { fee: '10', referredCount: 2 }); // earned 2×1.0 = 2.0
  const mid = seedEarner(2, { fee: '10', referredCount: 1 }); // earned 1.0
  const lb = await A.getLeaderboard({ period: 'all', metric: 'earned', limit: 200 });
  const idx = (w) => lb.items.findIndex((r) => r.wallet === L.truncateWallet(w));
  // both present and correctly ordered
  assert.ok(idx(big) >= 0 && idx(mid) >= 0);
  assert.ok(idx(big) < idx(mid), 'higher earned ranks first');
  // deterministic: repeated calls agree
  S.invalidateCache('leaderboard:');
  const lb2 = await A.getLeaderboard({ period: 'all', metric: 'earned', limit: 200 });
  assert.deepEqual(lb.items.map((i) => i.wallet), lb2.items.map((i) => i.wallet));
  // ranks are 1-based and sequential at the top
  assert.equal(lb.items[0].rank, 1);
});

test('leaderboard: ties break by eligible → active → wallet ASC', () => {
  const rows = [
    { wallet: '0xbbb', earned: '1', eligibleRevenue: '10', activeReferrals: 1 },
    { wallet: '0xaaa', earned: '1', eligibleRevenue: '10', activeReferrals: 1 },
    { wallet: '0xccc', earned: '1', eligibleRevenue: '12', activeReferrals: 0 },
  ];
  const ranked = L.assignRanks(rows);
  assert.equal(ranked[0].wallet, '0xccc'); // higher eligible first
  assert.equal(ranked[1].wallet, '0xaaa'); // wallet ASC final tie-break
  assert.equal(ranked[2].wallet, '0xbbb');
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3]);
});

test('leaderboard: period filtering uses DB aggregation, viewer rank works', async () => {
  const ref = seedEarner(5, { fee: '10', referredCount: 1 });
  const revRow = db.prepare('SELECT id FROM revenue_entries WHERE referrer_wallet = ?').get(ref);
  db.prepare("UPDATE revenue_entries SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(revRow.id);
  db.prepare("UPDATE transactions SET created_at = '2020-01-01T00:00:00.000Z', updated_at = '2020-01-01T00:00:00.000Z' WHERE wallet IN (SELECT referred_wallet FROM referrals WHERE referrer_wallet = ?)").run(ref);
  S.invalidateCache('leaderboard:');
  const week = await A.getLeaderboard({ period: 'week', metric: 'earned', limit: 200, viewer: ref });
  // old revenue + old activity excluded from the weekly view → viewer absent
  const inWeek = week.items.find((r) => r.wallet === L.truncateWallet(ref));
  assert.equal(inWeek, undefined);
  assert.equal(week.viewer.rank, null);
  S.invalidateCache('leaderboard:');
  const all = await A.getLeaderboard({ period: 'all', metric: 'earned', limit: 5, viewer: W(999) });
  // unknown viewer → explicit null rank, never a crash
  assert.ok(all.viewer && typeof all.viewer.total === 'number');
  assert.equal(all.viewer.rank, null);
  S.invalidateCache('leaderboard:');
  const selfRank = await A.getLeaderboard({ period: 'all', metric: 'earned', limit: 200, viewer: ref });
  assert.ok(selfRank.viewer.rank >= 1);
  assert.equal(selfRank.items[selfRank.viewer.rank - 1].wallet, L.truncateWallet(ref));
});

/* ---------- privacy ---------- */
test('privacy: only short wallets leave the server, never full addresses', async () => {
  const full = '0x8a1234567890abcdef1234567890abcdef1234567890abcdef1234567891c000';
  assert.equal(L.truncateWallet(full), '0x8a12...c000');
  assert.ok(!L.truncateWallet(full).includes(full.slice(10, 50)));
  const ref = seedEarner(7, { fee: '10', referredCount: 1 });
  S.invalidateCache('leaderboard:');
  const lb = await A.getLeaderboard({ period: 'all', metric: 'earned', limit: 200 });
  const blob = JSON.stringify(lb);
  assert.ok(!blob.includes(ref), 'full wallet must never appear in leaderboard payload');
  const act = A.getReferralActivity(ref, 10);
  assert.ok(act.length > 0);
  for (const a of act) {
    assert.ok(!/0x[0-9a-fA-F]{64}/.test(a.user), 'activity user must be truncated');
    assert.ok(!('referred' in a) && !('wallet' in a));
  }
});

/* ---------- reconciliation ---------- */
test('reconciliation: matched / pending / mismatch', () => {
  assert.equal(L.reconcileRevenue({ expectedIn: '124.20', paidOut: '0', observed: '124.20' }).status, 'MATCHED');
  assert.equal(L.reconcileRevenue({ expectedIn: '124.20', paidOut: '0', observed: '100' }).status, 'MISMATCH');
  assert.equal(L.reconcileRevenue({ expectedIn: '124.20', paidOut: '0', observed: null }).status, 'PENDING');
  const r = L.reconcileRevenue({ expectedIn: '124.20', paidOut: '24.20', observed: '100' });
  assert.equal(r.expected, '100');
  assert.equal(r.status, 'MATCHED');
});

/* ---------- single-system parity: one fee/referral policy everywhere ---------- */
test('parity: one referral policy table across shared/api/server, one revenue wallet', async () => {
  const api = await import('../../api/_lib/services.js');
  for (const [proto, action, rate] of [['cetus', 'swap', 0], ['aftermath-perps', '*', 10], ['deepbook', '*', 0], ['deepbook-predict', '*', 0]]) {
    assert.equal(L.referralPolicyFor(proto, action).rate, rate, 'shared ' + proto);
    assert.equal(api.referralPolicyFor(proto, action).rate, rate, 'api ' + proto);
    assert.equal(S.referralPolicyFor(proto, action).rate, rate, 'server ' + proto);
  }
  assert.equal(L.revenueWalletAddress(), '0xa29a8f72981c5644c348a51cd4aded6dbb47ad4361f7a825e19d377e9c4373a1');
  assert.equal(S.FeeEngine.calculateReferralReward(2, 'aftermath-perps', '*'), api.referralReward(2, 'aftermath-perps', '*').reward);
});

test('secrets: no private key / seed / mnemonic anywhere near revenue code', async () => {
  const { readFileSync } = await import('node:fs');
  const files = [
    '../../api/_lib/referral-analytics.js',
    '../../api/_lib/revenue-wallet.js',
    '../../api/_lib/handlers/referral.js',
    '../../api/_lib/handlers/revenue.js',
    '../src/referral-analytics.js',
  ];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const bad of ['PRIVATE_KEY', 'MNEMONIC', 'SEED_PHRASE', 'secretKey']) {
      assert.ok(!src.includes(bad), `${f} must not contain ${bad}`);
    }
  }
});

/* ---------- personal stats shape ---------- */
test('stats: shape matches contract, conversion = active/referred', () => {
  const ref = seedEarner(9, { fee: '10', referredCount: 2 });
  const st = A.getReferralStats(ref);
  assert.equal(st.referred, 2);
  assert.equal(st.active, 2);
  assert.equal(st.earned, '2');
  assert.equal(st.pending, '2');
  assert.equal(st.paid, '0');
  assert.equal(st.conversion, 1);
  assert.equal(st.source, 'Noise accounting');
  assert.ok(st.updatedAt);
});
