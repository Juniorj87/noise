// /api/leaderboard — standalone global ranking (separate from /api/referral).
// Referral page = MY link/stats/earnings. Leaderboard = GLOBAL ranking.
// Metrics come only from Noise accounting (revenue_entries + attributions).
// VOLUME has no verified source → COMING_SOON, never invented.
import { handler } from '../http.js';
import { getPool, ensureSchema, getConfig } from '../pg.js';
import { getLeaderboard, getNetworkStats } from '../referral-analytics.js';
import { LEADERBOARD_VOLUME_STATUS } from '../../../shared/logic.js';

async function enabled() {
  if (String(process.env.LEADERBOARD_ENABLED || 'true').toLowerCase() === 'false') return false;
  return String(await getConfig('leaderboardEnabled', 'true')) !== 'false';
}

export default handler(async (req, res, url) => {
  const parts = url.pathname.split('/').filter(Boolean);
  const action = parts[parts.length - 1];
  if (!(await enabled())) {
    return { error: 'LEADERBOARD_DISABLED', message: 'Leaderboard is disabled.', status: 503 };
  }
  await ensureSchema();
  const pool = getPool();
  if (req.method !== 'GET') return { error: 'INVALID_REQUEST', message: 'GET required.', status: 400 };
  if (action === 'leaderboard' || url.pathname === '/api/leaderboard') {
    const metric = url.searchParams.get('metric') || 'earned';
    if (metric === 'volume') {
      return {
        period: url.searchParams.get('period') || 'all', metric: 'volume',
        status: LEADERBOARD_VOLUME_STATUS,
        items: [], viewer: null, total: 0,
        message: 'Volume ranking is COMING SOON — no verified on-chain volume source exists in Noise accounting yet.',
        updatedAt: new Date().toISOString(), source: 'Noise accounting',
      };
    }
    return getLeaderboard(pool, {
      period: url.searchParams.get('period') || 'all',
      metric,
      limit: url.searchParams.get('limit') || 50,
      viewer: url.searchParams.get('wallet') || null,
    });
  }
  if (action === 'referrals' || action === 'activity' || action === 'earnings') {
    const map = { referrals: 'referrals', activity: 'active', earnings: 'earned' };
    return getLeaderboard(pool, {
      period: url.searchParams.get('period') || 'all',
      metric: map[action],
      limit: url.searchParams.get('limit') || 50,
      viewer: url.searchParams.get('wallet') || null,
    });
  }
  if (action === 'volume') {
    return {
      status: LEADERBOARD_VOLUME_STATUS, items: [], total: 0,
      message: 'Volume ranking is COMING SOON — no verified on-chain volume source exists in Noise accounting yet.',
      updatedAt: new Date().toISOString(), source: 'Noise accounting',
    };
  }
  if (action === 'network') {
    return getNetworkStats(pool);
  }
  return { error: 'NOT_FOUND', message: 'Unknown leaderboard action.', status: 404 };
});
