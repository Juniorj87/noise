// Referral → Revenue → Rewards → Leaderboard → Analytics (SQLite dev server).
// Sync mirror of api/_lib/referral-analytics.js — same semantics, same shapes.
import { db } from './db.js';
import {
  truncateWallet, leaderboardComparator, periodCutoffIso, moneyStr,
  LEADERBOARD_PERIODS, LEADERBOARD_METRICS,
} from '../../shared/logic.js';
import { cached } from './services.js';

const num = (v) => Number(v) || 0;

// Canonical attribution set: referral_attributions + legacy single-slot rows,
// deduped by (referrer, referred) — timestamps differ between the two sources
// (JS ISO vs SQLite datetime), so a plain UNION would double-count.
const ATTR_UNION = `
  SELECT referrer, referred, MAX(at) AS at FROM (
    SELECT referrer AS referrer, referred_wallet AS referred, attributed_at AS at FROM referral_attributions WHERE referrer IS NOT NULL
    UNION ALL
    SELECT referrer_wallet AS referrer, referred_wallet AS referred, created_at AS at FROM referrals WHERE referrer_wallet IS NOT NULL AND referred_wallet IS NOT NULL
  ) GROUP BY referrer, referred`;

export function getReferralStats(wallet) {
  const w = String(wallet);
  const ref = db.prepare(`SELECT COUNT(*) AS referred FROM (${ATTR_UNION}) WHERE referrer = ?`).get(w);
  const act = db.prepare(
    `SELECT COUNT(DISTINCT u.referred) AS active
     FROM (${ATTR_UNION}) u JOIN transactions t
       ON t.wallet = u.referred AND t.status = 'confirmed'
     WHERE u.referrer = ?`).get(w);
  const rev = db.prepare(
    `SELECT COALESCE(SUM(CAST(eligible_revenue AS REAL)),0) AS eligible,
            COALESCE(SUM(CAST(referral_reward AS REAL)),0) AS rewards,
            COALESCE(SUM(CAST(net_revenue AS REAL)),0) AS retained
     FROM revenue_entries WHERE referrer_wallet = ?`).get(w);
  let pend = { pending: 0, paid: 0 };
  try {
    pend = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN status IN ('pending','confirmed') THEN CAST(amount AS REAL) ELSE 0 END),0) AS pending,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN CAST(amount AS REAL) ELSE 0 END),0) AS paid
       FROM referral_rewards WHERE COALESCE(referrer, (SELECT referrer_wallet FROM referrals r WHERE r.id = referral_rewards.referral_id)) = ?`).get(w);
  } catch {
    pend = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN rr.status IN ('pending','confirmed') THEN CAST(rr.amount AS REAL) ELSE 0 END),0) AS pending,
              COALESCE(SUM(CASE WHEN rr.status = 'paid' THEN CAST(rr.amount AS REAL) ELSE 0 END),0) AS paid
       FROM referral_rewards rr JOIN referrals r ON r.id = rr.referral_id
       WHERE r.referrer_wallet = ?`).get(w);
  }
  const referred = num(ref?.referred);
  const active = num(act?.active);
  return {
    referred, active,
    eligibleRevenue: moneyStr(rev?.eligible),
    earned: moneyStr(rev?.rewards),
    pending: moneyStr(pend?.pending),
    paid: moneyStr(pend?.paid),
    retained: moneyStr(rev?.retained),
    conversion: referred > 0 ? Math.round((active / referred) * 10000) / 10000 : 0,
    updatedAt: new Date().toISOString(),
    source: 'Noise accounting',
  };
}

export function getReferralActivity(wallet, limit = 25) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 25));
  const rows = db.prepare(
    `SELECT e.created_at AS date, e.action, e.wallet AS referred,
            COALESCE(CAST(e.eligible_revenue AS REAL),0) AS revenue,
            COALESCE(CAST(e.referral_reward AS REAL),0) AS share,
            COALESCE(rr.status, 'pending') AS status
     FROM revenue_entries e
     LEFT JOIN referral_rewards rr ON rr.revenue_id = e.id
     WHERE e.referrer_wallet = ?
     ORDER BY e.created_at DESC LIMIT ?`).all(String(wallet), lim);
  return rows.map((r) => ({
    date: r.date,
    action: r.action,
    user: truncateWallet(r.referred),
    revenue: moneyStr(r.revenue),
    share: moneyStr(r.share),
    status: String(r.status || 'pending').toUpperCase(),
  }));
}

export function leaderboardRows(period = 'all') {
  const p = LEADERBOARD_PERIODS.includes(period) ? period : 'all';
  const cutoff = periodCutoffIso(p);
  const args = [];
  let revFilter = '';
  let txFilter = '';
  if (cutoff) { args.push(cutoff); revFilter = ' AND e.created_at >= ?'; txFilter = ' AND t.created_at >= ?'; }
  const revArgs = [...args];
  const txArgs = [...args];
  const refArgs = [];
  let refFilter = '';
  if (cutoff) { refArgs.push(cutoff); refFilter = ' WHERE at >= ?'; }
  const refRows = db.prepare(
    `SELECT referrer, COUNT(*) AS referred
     FROM (${ATTR_UNION})${refFilter} GROUP BY 1`).all(...refArgs);
  const byRef = new Map(refRows.map((r) => [r.referrer, { wallet: r.referrer, referred: num(r.referred), activeReferrals: 0, eligibleRevenue: '0', earned: '0' }]));
  const get = (k) => {
    if (!byRef.has(k)) byRef.set(k, { wallet: k, referred: 0, activeReferrals: 0, eligibleRevenue: '0', earned: '0' });
    return byRef.get(k);
  };
  const revRows = db.prepare(
    `SELECT e.referrer_wallet AS referrer,
            COALESCE(SUM(CAST(e.eligible_revenue AS REAL)),0) AS eligible,
            COALESCE(SUM(CAST(e.referral_reward AS REAL)),0) AS earned
     FROM revenue_entries e WHERE e.referrer_wallet IS NOT NULL${revFilter} GROUP BY 1`).all(...revArgs);
  for (const r of revRows) {
    const g = get(r.referrer);
    g.eligibleRevenue = moneyStr(r.eligible);
    g.earned = moneyStr(r.earned);
  }
  const actRows = db.prepare(
    `SELECT u.referrer AS referrer, COUNT(DISTINCT u.referred) AS active
     FROM (${ATTR_UNION}) u JOIN transactions t
       ON t.wallet = u.referred AND t.status = 'confirmed'
     WHERE 1 = 1${txFilter} GROUP BY 1`).all(...txArgs);
  for (const r of actRows) get(r.referrer).activeReferrals = num(r.active);
  const rows = [...byRef.values()];
  // Period views show only referrers with period activity; all-time shows everyone.
  if (cutoff) return rows.filter((r) => Number(r.earned) > 0 || r.activeReferrals > 0);
  return rows;
}

export async function getLeaderboard({ period = 'all', metric = 'earned', limit = 50, viewer = null } = {}) {
  const p = LEADERBOARD_PERIODS.includes(period) ? period : 'all';
  const m = LEADERBOARD_METRICS.includes(metric) ? metric : 'earned';
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const all = await cached(`leaderboard:${p}`, Number(process.env.LEADERBOARD_CACHE_MS || 45_000), () => leaderboardRows(p));
  const cmp = leaderboardComparator(m);
  const sorted = [...all].sort(cmp);
  const items = sorted.slice(0, lim).map((r, i) => ({
    rank: i + 1,
    wallet: truncateWallet(r.wallet),
    referred: r.referred,
    activeReferrals: r.activeReferrals,
    eligibleRevenue: r.eligibleRevenue,
    earned: r.earned,
  }));
  let viewerOut = null;
  if (viewer) {
    const idx = sorted.findIndex((r) => String(r.wallet).toLowerCase() === String(viewer).toLowerCase());
    viewerOut = idx >= 0
      ? { rank: idx + 1, total: sorted.length, earned: sorted[idx].earned, eligibleRevenue: sorted[idx].eligibleRevenue, activeReferrals: sorted[idx].activeReferrals, wallet: truncateWallet(sorted[idx].wallet) }
      : { rank: null, total: sorted.length, earned: '0', eligibleRevenue: '0', activeReferrals: 0, wallet: truncateWallet(viewer) };
  }
  return { period: p, metric: m, items, viewer: viewerOut, total: sorted.length, updatedAt: new Date().toISOString(), source: 'Noise accounting' };
}

export function getRevenueSeries({ wallet = null, range = '30d' } = {}) {
  const days = range === '7d' ? 7 : range === '90d' ? 90 : range === 'all' ? 3650 : 30;
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const args = [cutoff];
  let where = 'e.created_at >= ?';
  if (wallet) { args.push(String(wallet)); where += ' AND e.referrer_wallet = ?'; }
  const rows = db.prepare(
    `SELECT date(e.created_at) AS day,
            COALESCE(SUM(CAST(e.eligible_revenue AS REAL)),0) AS revenue,
            COALESCE(SUM(CAST(e.referral_reward AS REAL)),0) AS rewards,
            COUNT(*) AS txs
     FROM revenue_entries e WHERE ${where}
     GROUP BY 1 ORDER BY 1`).all(...args);
  return { range, points: rows.map((r) => ({ t: r.day, revenue: moneyStr(r.revenue), rewards: moneyStr(r.rewards), txs: num(r.txs) })), updatedAt: new Date().toISOString(), source: 'Noise accounting' };
}

export function getNetworkStats() {
  const r = db.prepare(
    `SELECT (SELECT COUNT(DISTINCT referrer) FROM (${ATTR_UNION})) AS referrers,
            (SELECT COUNT(DISTINCT referred) FROM (${ATTR_UNION})) AS referred,
            (SELECT COALESCE(SUM(CAST(eligible_revenue AS REAL)),0) FROM revenue_entries) AS eligible,
            (SELECT COALESCE(SUM(CAST(amount AS REAL)),0) FROM referral_rewards WHERE status = 'paid') AS paid`).get();
  return {
    referrers: num(r?.referrers), referred: num(r?.referred),
    eligibleRevenue: moneyStr(r?.eligible),
    rewardsDistributed: moneyStr(r?.paid),
    updatedAt: new Date().toISOString(),
    source: 'Noise accounting',
  };
}

export function getRevenueSummary() {
  const totals = db.prepare(
    `SELECT COALESCE(SUM(CAST(eligible_revenue AS REAL)),0) AS eligible,
            COALESCE(SUM(CAST(referral_reward AS REAL)),0) AS referral,
            COALESCE(SUM(CAST(net_revenue AS REAL)),0) AS retained,
            COUNT(*) AS txs FROM revenue_entries`).get();
  const split = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN status IN ('pending','confirmed') THEN CAST(amount AS REAL) ELSE 0 END),0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'paid' THEN CAST(amount AS REAL) ELSE 0 END),0) AS paid
     FROM referral_rewards`).get();
  const byProtocol = db.prepare(
    `SELECT COALESCE(provider,'(unknown)') AS protocol,
            COALESCE(SUM(CAST(eligible_revenue AS REAL)),0) AS revenue,
            COALESCE(SUM(CAST(referral_reward AS REAL)),0) AS referral,
            COALESCE(SUM(CAST(net_revenue AS REAL)),0) AS retained,
            COUNT(*) AS txs FROM revenue_entries GROUP BY 1 ORDER BY 2 DESC`).all();
  const byAction = db.prepare(
    `SELECT COALESCE(action,'(unknown)') AS action,
            COALESCE(SUM(CAST(eligible_revenue AS REAL)),0) AS revenue,
            COALESCE(SUM(CAST(referral_reward AS REAL)),0) AS referral,
            COALESCE(SUM(CAST(net_revenue AS REAL)),0) AS retained,
            COUNT(*) AS txs FROM revenue_entries GROUP BY 1 ORDER BY 2 DESC`).all();
  const norm = (rows) => rows.map((r) => ({ ...r, revenue: moneyStr(r.revenue), referral: moneyStr(r.referral), retained: moneyStr(r.retained), txs: num(r.txs) }));
  return {
    total: { eligible: moneyStr(totals?.eligible), referral: moneyStr(totals?.referral), retained: moneyStr(totals?.retained), paid: moneyStr(split?.paid), pending: moneyStr(split?.pending), txs: num(totals?.txs) },
    byProtocol: norm(byProtocol),
    byAction: norm(byAction),
    updatedAt: new Date().toISOString(),
    source: 'Noise accounting',
  };
}

export function getReconciliationExpected() {
  const r = db.prepare(`SELECT COALESCE(SUM(CAST(eligible_revenue AS REAL)),0) AS eligible FROM revenue_entries`).get();
  const p = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN CAST(amount AS REAL) ELSE 0 END),0) AS paid FROM referral_rewards`).get();
  return { expectedIn: moneyStr(r?.eligible), paidOut: moneyStr(p?.paid) };
}
