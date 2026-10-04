// Referral → Revenue → Rewards → Leaderboard → Analytics (PostgreSQL).
// Read-only aggregation layer OVER the existing accounting chain
// (revenue_entries ← confirmed txs via settleReferralForTx, referral_rewards).
// No new fee engine, no frontend-trusted numbers: every figure is a DB aggregate.
// Leaderboard cache: 45s (configurable via LEADERBOARD_CACHE_MS).
import {
  truncateWallet, leaderboardComparator, periodCutoffIso, moneyStr,
  LEADERBOARD_PERIODS, LEADERBOARD_METRICS,
} from '../../shared/logic.js';
import { cached } from './util.js';

const PENDING_REWARD = `status IN ('pending','confirmed')`;

function periodClause(period, col = 'created_at') {
  const cutoff = periodCutoffIso(period === 'week' ? 'week' : period === 'month' ? 'month' : 'all');
  return cutoff ? { sql: ` AND ${col} >= $DATE$`, cutoff } : { sql: '', cutoff: null };
}

function rewardWhere(alias = 'rr') {
  // Prefer the denormalized referrer column; fall back to the referral join.
  return `COALESCE(${alias}.referrer, (SELECT referrer_wallet FROM referrals r WHERE r.id = ${alias}.referral_id))`;
}

/* ---------- personal stats ---------- */
// Canonical attribution set: referral_attributions + legacy single-slot rows,
// deduped by (referrer, referred) — timestamps differ between the two sources,
// so a plain UNION would double-count.
const ATTR_UNION = `
  SELECT referrer, referred, MAX(at) AS at FROM (
    SELECT referrer AS referrer, referred_wallet AS referred, attributed_at AS at FROM referral_attributions WHERE referrer IS NOT NULL
    UNION ALL
    SELECT referrer_wallet AS referrer, referred_wallet AS referred, created_at AS at FROM referrals WHERE referrer_wallet IS NOT NULL AND referred_wallet IS NOT NULL
  ) GROUP BY referrer, referred`;

export async function getReferralStats(pool, wallet) {
  const w = String(wallet);
  const ref = (await pool.query(
    `SELECT COUNT(*)::int AS referred FROM (${ATTR_UNION}) WHERE referrer = $1`, [w])).rows[0];
  const act = (await pool.query(
    `SELECT COUNT(DISTINCT u.referred)::int AS active
     FROM (${ATTR_UNION}) u JOIN transactions t
       ON t.wallet = u.referred AND t.status = 'confirmed'
     WHERE u.referrer = $1`, [w])).rows[0];
  const rev = (await pool.query(
    `SELECT COALESCE(SUM(CAST(eligible_revenue AS REAL)),0) AS eligible,
            COALESCE(SUM(CAST(referral_reward AS REAL)),0) AS rewards,
            COALESCE(SUM(CAST(net_revenue AS REAL)),0) AS retained
     FROM revenue_entries WHERE referrer_wallet = $1`, [w])).rows[0];
  let pend = { pending: 0, paid: 0 };
  try {
    pend = (await pool.query(
      `SELECT COALESCE(SUM(CAST(rr.amount AS REAL)) FILTER (WHERE rr.${PENDING_REWARD}),0) AS pending,
              COALESCE(SUM(CAST(rr.amount AS REAL)) FILTER (WHERE rr.status = 'paid'),0) AS paid
       FROM referral_rewards rr WHERE ${rewardWhere('rr')} = $1`, [w])).rows[0];
  } catch {
    pend = (await pool.query(
      `SELECT COALESCE(SUM(CAST(rr.amount AS REAL)) FILTER (WHERE rr.${PENDING_REWARD}),0) AS pending,
              COALESCE(SUM(CAST(rr.amount AS REAL)) FILTER (WHERE rr.status = 'paid'),0) AS paid
       FROM referral_rewards rr JOIN referrals r ON r.id = rr.referral_id
       WHERE r.referrer_wallet = $1`, [w])).rows[0];
  }
  const referred = ref?.referred ?? 0;
  const active = act?.active ?? 0;
  const earned = rev?.rewards ?? 0;
  return {
    referred,
    active,
    eligibleRevenue: moneyStr(rev?.eligible),
    earned: moneyStr(earned),
    pending: moneyStr(pend?.pending),
    paid: moneyStr(pend?.paid),
    retained: moneyStr(rev?.retained),
    conversion: referred > 0 ? Math.round((active / referred) * 10000) / 10000 : 0,
    updatedAt: new Date().toISOString(),
    source: 'Noise accounting',
  };
}

/* ---------- referral activity (privacy: short wallet only) ---------- */
export async function getReferralActivity(pool, wallet, limit = 25) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 25));
  const rows = (await pool.query(
    `SELECT e.created_at AS date, e.action, e.wallet AS referred,
            COALESCE(CAST(e.eligible_revenue AS REAL),0) AS revenue,
            COALESCE(CAST(e.referral_reward AS REAL),0) AS share,
            COALESCE(rr.status, 'pending') AS status
     FROM revenue_entries e
     LEFT JOIN referral_rewards rr ON rr.revenue_id = e.id
     WHERE e.referrer_wallet = $1
     ORDER BY e.created_at DESC LIMIT $2`, [String(wallet), lim])).rows;
  return rows.map((r) => ({
    date: r.date,
    action: r.action,
    user: truncateWallet(r.referred),
    revenue: moneyStr(r.revenue),
    share: moneyStr(r.share),
    status: String(r.status || 'pending').toUpperCase(),
  }));
}

/* ---------- leaderboard (DB aggregation; deterministic ordering) ---------- */
export async function leaderboardRows(pool, period = 'all') {
  const p = LEADERBOARD_PERIODS.includes(period) ? period : 'all';
  const cutoff = periodCutoffIso(p);
  const params = [];
  let revFilter = '';
  let txFilter = '';
  if (cutoff) {
    params.push(cutoff);
    revFilter = ` AND e.created_at >= $${params.length}`;
    txFilter = ` AND t.created_at >= $${params.length}`;
  }
  // params[0] (cutoff) is reused by all three period filters — same value, one bind.
  const attrDateFilter = cutoff ? ' WHERE at >= $1' : '';
  const rows = (await pool.query(
    `SELECT COALESCE(ref_agg.referrer, rev_agg.referrer, act_agg.referrer) AS wallet,
            COALESCE(ref_agg.referred, 0)::int AS referred,
            COALESCE(act_agg.active, 0)::int AS "activeReferrals",
            COALESCE(rev_agg.eligible, 0) AS "eligibleRevenue",
            COALESCE(rev_agg.earned, 0) AS earned
     FROM (
       SELECT referrer, COUNT(*)::int AS referred
       FROM (${ATTR_UNION})${attrDateFilter} GROUP BY 1
     ) ref_agg
     FULL OUTER JOIN (
       SELECT e.referrer_wallet AS referrer,
              COALESCE(SUM(CAST(e.eligible_revenue AS REAL)),0) AS eligible,
              COALESCE(SUM(CAST(e.referral_reward AS REAL)),0) AS earned
       FROM revenue_entries e WHERE e.referrer_wallet IS NOT NULL${revFilter} GROUP BY 1
     ) rev_agg ON rev_agg.referrer = ref_agg.referrer
     FULL OUTER JOIN (
       SELECT u.referrer AS referrer, COUNT(DISTINCT u.referred)::int AS active
       FROM (${ATTR_UNION}) u JOIN transactions t
         ON t.wallet = u.referred AND t.status = 'confirmed'
       WHERE 1 = 1${txFilter} GROUP BY 1
     ) act_agg ON act_agg.referrer = COALESCE(ref_agg.referrer, rev_agg.referrer)
     WHERE COALESCE(ref_agg.referrer, rev_agg.referrer, act_agg.referrer) IS NOT NULL`, params)).rows;
  // Normalize wallet key from the FULL OUTER JOIN.
  const out = rows.map((r) => ({
    wallet: r.wallet,
    referred: Number(r.referred) || 0,
    activeReferrals: Number(r.activeReferrals) || 0,
    eligibleRevenue: moneyStr(r.eligibleRevenue),
    earned: moneyStr(r.earned),
  })).filter((r) => r.wallet);
  // Period views show only referrers with period activity; all-time shows everyone.
  if (cutoff) return out.filter((r) => Number(r.earned) > 0 || r.activeReferrals > 0);
  return out;
}

export async function getLeaderboard(pool, { period = 'all', metric = 'earned', limit = 50, viewer = null } = {}) {
  const p = LEADERBOARD_PERIODS.includes(period) ? period : 'all';
  const m = LEADERBOARD_METRICS.includes(metric) ? metric : 'earned';
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const ttl = Number(process.env.LEADERBOARD_CACHE_MS || 45_000);
  const all = await cached(`leaderboard:${p}`, ttl, () => leaderboardRows(pool, p));
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
    if (idx >= 0) {
      const v = sorted[idx];
      viewerOut = { rank: idx + 1, total: sorted.length, earned: v.earned, eligibleRevenue: v.eligibleRevenue, activeReferrals: v.activeReferrals, wallet: truncateWallet(v.wallet) };
    } else {
      viewerOut = { rank: null, total: sorted.length, earned: '0', eligibleRevenue: '0', activeReferrals: 0, wallet: truncateWallet(viewer) };
    }
  }
  return { period: p, metric: m, items, viewer: viewerOut, total: sorted.length, updatedAt: new Date().toISOString(), source: 'Noise accounting' };
}

/* ---------- revenue time series (chart data, DB buckets) ---------- */
export async function getRevenueSeries(pool, { wallet = null, range = '30d' } = {}) {
  const days = range === '7d' ? 7 : range === '90d' ? 90 : range === 'all' ? 3650 : 30;
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const params = [cutoff];
  let where = 'e.created_at >= $1';
  if (wallet) { params.push(String(wallet)); where += ' AND e.referrer_wallet = $2'; }
  const rows = (await pool.query(
    `SELECT date_trunc('day', e.created_at)::date::text AS day,
            COALESCE(SUM(CAST(e.eligible_revenue AS REAL)),0) AS revenue,
            COALESCE(SUM(CAST(e.referral_reward AS REAL)),0) AS rewards,
            COUNT(*)::int AS txs
     FROM revenue_entries e WHERE ${where}
     GROUP BY 1 ORDER BY 1`, params)).rows;
  return { range, points: rows.map((r) => ({ t: r.day, revenue: moneyStr(r.revenue), rewards: moneyStr(r.rewards), txs: Number(r.txs) || 0 })), updatedAt: new Date().toISOString(), source: 'Noise accounting' };
}

/* ---------- global network stats (real data only) ---------- */
export async function getNetworkStats(pool) {
  const r = (await pool.query(
    `SELECT (SELECT COUNT(DISTINCT referrer)::int FROM (${ATTR_UNION})) AS referrers,
            (SELECT COUNT(DISTINCT referred)::int FROM (${ATTR_UNION})) AS referred,
            (SELECT COALESCE(SUM(CAST(eligible_revenue AS REAL)),0) FROM revenue_entries) AS eligible,
            (SELECT COALESCE(SUM(CAST(amount AS REAL)),0) FROM referral_rewards WHERE status = 'paid') AS paid`)).rows[0];
  return {
    referrers: Number(r?.referrers) || 0,
    referred: Number(r?.referred) || 0,
    eligibleRevenue: moneyStr(r?.eligible),
    rewardsDistributed: moneyStr(r?.paid),
    updatedAt: new Date().toISOString(),
    source: 'Noise accounting',
  };
}

/* ---------- revenue summary (admin): totals + by protocol + by action ---------- */
export async function getRevenueSummary(pool) {
  const totals = (await pool.query(
    `SELECT COALESCE(SUM(CAST(e.eligible_revenue AS REAL)),0) AS eligible,
            COALESCE(SUM(CAST(e.referral_reward AS REAL)),0) AS referral,
            COALESCE(SUM(CAST(e.net_revenue AS REAL)),0) AS retained,
            COUNT(*)::int AS txs
     FROM revenue_entries e`)).rows[0];
  const split = (await pool.query(
    `SELECT COALESCE(SUM(CAST(rr.amount AS REAL)) FILTER (WHERE rr.${PENDING_REWARD}),0) AS pending,
            COALESCE(SUM(CAST(rr.amount AS REAL)) FILTER (WHERE rr.status = 'paid'),0) AS paid
     FROM referral_rewards rr`)).rows[0];
  const byProtocol = (await pool.query(
    `SELECT COALESCE(e.provider,'(unknown)') AS protocol,
            COALESCE(SUM(CAST(e.eligible_revenue AS REAL)),0) AS revenue,
            COALESCE(SUM(CAST(e.referral_reward AS REAL)),0) AS referral,
            COALESCE(SUM(CAST(e.net_revenue AS REAL)),0) AS retained,
            COUNT(*)::int AS txs
     FROM revenue_entries e GROUP BY 1 ORDER BY 2 DESC`)).rows;
  const byAction = (await pool.query(
    `SELECT COALESCE(e.action,'(unknown)') AS action,
            COALESCE(SUM(CAST(e.eligible_revenue AS REAL)),0) AS revenue,
            COALESCE(SUM(CAST(e.referral_reward AS REAL)),0) AS referral,
            COALESCE(SUM(CAST(e.net_revenue AS REAL)),0) AS retained,
            COUNT(*)::int AS txs
     FROM revenue_entries e GROUP BY 1 ORDER BY 2 DESC`)).rows;
  const norm = (rows) => rows.map((r) => ({
    ...r,
    revenue: moneyStr(r.revenue), referral: moneyStr(r.referral),
    retained: moneyStr(r.retained), txs: Number(r.txs) || 0,
  }));
  return {
    total: { eligible: moneyStr(totals?.eligible), referral: moneyStr(totals?.referral), retained: moneyStr(totals?.retained), paid: moneyStr(split?.paid), pending: moneyStr(split?.pending), txs: Number(totals?.txs) || 0 },
    byProtocol: norm(byProtocol),
    byAction: norm(byAction),
    updatedAt: new Date().toISOString(),
    source: 'Noise accounting',
  };
}

/* ---------- reconciliation inputs from DB (observed comes from the wallet scan) ---------- */
export async function getReconciliationExpected(pool) {
  const r = (await pool.query(
    `SELECT COALESCE(SUM(CAST(eligible_revenue AS REAL)),0) AS eligible FROM revenue_entries`)).rows[0];
  const p = (await pool.query(
    `SELECT COALESCE(SUM(CAST(amount AS REAL)) FILTER (WHERE status = 'paid'),0) AS paid FROM referral_rewards`)).rows[0];
  return { expectedIn: moneyStr(r?.eligible), paidOut: moneyStr(p?.paid) };
}
