// GET /api/referral?code= — lookup code + earned total.
import { handler, requireQuery } from '../_lib/http.js';
import { getConfig } from '../_lib/pg.js';
import { getPool, ensureSchema } from '../_lib/pg.js';

export default handler(async (req, res, url) => {
  const code = requireQuery(url, 'code');
  await ensureSchema();
  const row = (await getPool().query('SELECT * FROM referrals WHERE code = $1', [code])).rows[0];
  if (!row) return { error: 'UNKNOWN_CODE', message: 'Referral code not found.', status: 404 };
  const rewards = (await getPool().query('SELECT COALESCE(SUM(CAST(amount AS REAL)),0) AS total FROM referral_rewards WHERE referral_id = $1', [row.id])).rows[0];
  const refRate = Number(await getConfig('refRate', process.env.REFERRAL_DEFAULT_RATE ?? '30'));
  const windowDays = Number(process.env.REFERRAL_WINDOW_DAYS ?? 30);
  return { referral: row, earned: rewards.total, rate: refRate, windowDays };
});
