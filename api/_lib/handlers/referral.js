// /api/referral — lookup (GET ?code= | ?wallet= → full §45 shape).
// /api/referral/stats | activity | leaderboard | rank | revenue | network (GET).
// /api/referral/register | attribute | reward | claim (POST).
// Reward settles ONLY for confirmed on-chain transactions with eligible revenue.
// The backend recomputes everything — frontend numbers are never trusted.
import { handler, readJson, requireQuery } from '../http.js';
import {
  registerReferralCode, attributeReferral, settleReferralForTx,
  getTransactionByDigest, isValidDigest, isWalletAddress,
} from '../services.js';
import { getConfig, getPool, ensureSchema } from '../pg.js';
import { REFERRAL_POLICIES } from '../../../shared/logic.js';
import {
  getReferralStats, getReferralActivity, getLeaderboard,
  getRevenueSeries, getNetworkStats,
} from '../referral-analytics.js';

const REF_LINK_BASE = 'https://noisehub.xyz/?ref=';

async function refRate() {
  return Number(await getConfig('referralRate', process.env.REFERRAL_DEFAULT_RATE ?? '30'));
}
async function windowDays() {
  return Number(await getConfig('refWindowDays', process.env.REFERRAL_WINDOW_DAYS ?? '30'));
}
async function leaderboardEnabled() {
  return String(await getConfig('leaderboardEnabled', 'true')) !== 'false';
}

async function fullShape(wallet) {
  await ensureSchema();
  const pool = getPool();
  const own = (await pool.query(
    'SELECT code FROM referrals WHERE referrer_wallet = $1 ORDER BY created_at ASC LIMIT 1', [wallet])).rows[0];
  const stats = await getReferralStats(pool, wallet);
  const lb = await getLeaderboard(pool, { period: 'all', metric: 'earned', limit: 1, viewer: wallet });
  return {
    wallet,
    referral: own ? { code: own.code, link: REF_LINK_BASE + own.code } : null,
    stats: {
      referred: stats.referred, active: stats.active,
      eligibleRevenue: stats.eligibleRevenue, earned: stats.earned,
      pending: stats.pending, paid: stats.paid,
      retained: stats.retained, conversion: stats.conversion,
    },
    rank: lb.viewer ? { position: lb.viewer.rank, total: lb.viewer.total } : { position: null, total: 0 },
    rate: await refRate(),
    rateNote: 'Program default — actual settlement uses the verified per-protocol policy (see policies); 0% where partner terms are unverified.',
    policies: REFERRAL_POLICIES,
    windowDays: await windowDays(),
    updatedAt: stats.updatedAt,
    source: 'Noise accounting',
  };
}

export default handler(async (req, res, url) => {
  const parts = url.pathname.split('/').filter(Boolean);
  const action = parts[parts.length - 1];

  if (req.method === 'GET' && (url.pathname === '/api/referral' || action === 'referral')) {
    const wallet = url.searchParams.get('wallet');
    if (wallet) {
      if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
      return fullShape(wallet);
    }
    const code = requireQuery(url, 'code');
    await ensureSchema();
    const row = (await getPool().query('SELECT id, code, expires_at, created_at FROM referrals WHERE code = $1', [code])).rows[0];
    if (!row) return { error: 'UNKNOWN_CODE', message: 'Referral code not found.', status: 404 };
    const rewards = (await getPool().query('SELECT COALESCE(SUM(CAST(amount AS REAL)),0) AS total FROM referral_rewards WHERE referral_id = $1', [row.id])).rows[0];
    return { referral: row, earned: rewards.total, rate: await refRate(), rateNote: 'Program default — actual settlement uses the verified per-protocol policy; 0% where partner terms are unverified.', windowDays: await windowDays() };
  }

  if (req.method === 'GET' && action === 'stats') {
    const wallet = requireQuery(url, 'wallet');
    if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    return fullShape(wallet);
  }

  if (req.method === 'GET' && action === 'activity') {
    const wallet = requireQuery(url, 'wallet');
    if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    await ensureSchema();
    return {
      items: await getReferralActivity(getPool(), wallet, url.searchParams.get('limit') || 25),
      updatedAt: new Date().toISOString(), source: 'Noise accounting',
    };
  }

  if (req.method === 'GET' && action === 'leaderboard') {
    if (!(await leaderboardEnabled())) {
      return { error: 'LEADERBOARD_DISABLED', message: 'Leaderboard is disabled.', status: 503 };
    }
    await ensureSchema();
    return getLeaderboard(getPool(), {
      period: url.searchParams.get('period') || 'all',
      metric: url.searchParams.get('metric') || 'earned',
      limit: url.searchParams.get('limit') || 50,
      viewer: url.searchParams.get('wallet') || null,
    });
  }

  if (req.method === 'GET' && action === 'rank') {
    const wallet = requireQuery(url, 'wallet');
    if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    await ensureSchema();
    const lb = await getLeaderboard(getPool(), { period: 'all', metric: 'earned', limit: 1, viewer: wallet });
    return { ...(lb.viewer || { rank: null }), updatedAt: lb.updatedAt, source: lb.source };
  }

  if (req.method === 'GET' && action === 'revenue') {
    const wallet = url.searchParams.get('wallet') || null;
    if (wallet && !isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    await ensureSchema();
    return getRevenueSeries(getPool(), { wallet, range: url.searchParams.get('range') || '30d' });
  }

  if (req.method === 'GET' && action === 'network') {
    await ensureSchema();
    return getNetworkStats(getPool());
  }

  if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
  const b = await readJson(req);

  if (action === 'register') {
    return { referral: await registerReferralCode(b.code, b.wallet) };
  }
  if (action === 'attribute') {
    if (!isWalletAddress(b.wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    const r = await attributeReferral(b.code, b.wallet);
    return r.ok ? r : { ...r, status: 400 };
  }
  if (action === 'reward') {
    if (!b.digest || !isValidDigest(b.digest)) throw Object.assign(new Error('INVALID_DIGEST'), { code: 'INVALID_DIGEST' });
    const tx = await getTransactionByDigest(b.digest);
    if (!tx || tx.status !== 'confirmed') {
      return { error: 'NO_CONFIRMED_TX', message: 'Referral rewards settle only after on-chain confirmation.', status: 409 };
    }
    return { ...await settleReferralForTx(tx), digest: b.digest };
  }
  if (action === 'claim') {
    // Stage 1: claims are intents only — no auto-send, no private key, no fake tx.
    if (!isWalletAddress(b.wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    const enabled = String(await getConfig('payoutEnabled', 'false')) === 'true';
    if (!enabled) {
      return { error: 'PAYOUT_DISABLED', message: 'Claiming coming soon — rewards are tracked and safe.', status: 501 };
    }
    await ensureSchema();
    const pool = getPool();
    const stats = await getReferralStats(pool, b.wallet);
    const min = Number(await getConfig('minPayout', '1'));
    if (!(Number(stats.pending) >= min)) {
      return { error: 'BELOW_MINIMUM', message: `Minimum payout is $${min}.`, status: 400 };
    }
    const { randomBytes } = await import('node:crypto');
    const id = 'pay_' + Date.now().toString(36) + randomBytes(4).toString('hex');
    await pool.query(
      `INSERT INTO referral_payouts (id, referrer, amount, asset, destination, status)
       VALUES ($1,$2,$3,'USDC',$4,'pending')`,
      [id, b.wallet, String(stats.pending), b.wallet]);
    return { ok: true, payoutId: id, amount: stats.pending, status: 'pending' };
  }
  return { error: 'NOT_FOUND', message: 'Unknown referral action.', status: 404 };
});
