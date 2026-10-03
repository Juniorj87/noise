// /api/admin/<action> — summary | fees | protocol | health. X-Admin-Key guarded.
// ADMIN_KEY lives only in env; never in responses, never in frontend (§12).
import { handler, readJson, requireAdmin } from '../_lib/http.js';
import { listProtocols } from '../_lib/adapters.js';
import { REFERRAL_POLICIES, isValidBps } from '../_lib/services.js';
import { getPool, ensureSchema, getConfig, setConfig, dbConfigured } from '../_lib/pg.js';
import { setFeeConfig, getAllFeeConfigs, validateFeeRecipient } from '../_lib/fee-engine.js';

export default handler(async (req, res, url) => {
  requireAdmin(req);
  const action = url.pathname.split('/').pop();
  await ensureSchema();
  const pool = getPool();

  if (action === 'summary') {
    const revenue = (await pool.query('SELECT COALESCE(SUM(CAST(net_revenue AS REAL)),0) AS total FROM revenue_entries')).rows[0];
    const failed = (await pool.query("SELECT COUNT(*) AS c FROM activities WHERE status IN ('failed','rejected')")).rows[0];
    const [swapBps, earnBps, feeRecipient, referralRate] = await Promise.all([
      getConfig('swapBps'), getConfig('earnBps'), getConfig('feeRecipient'), getConfig('referralRate'),
    ]);
    const feeOverrides = await getAllFeeConfigs().catch(() => []);
    return {
      revenueNet: revenue.total,
      failedActivity: failed,
      protocols: await listProtocols(),
      fees: {
        swapBps: Number(swapBps ?? process.env.PLATFORM_SWAP_FEE_BPS ?? 20),
        earnBps: Number(earnBps ?? process.env.PLATFORM_EARN_FEE_BPS ?? 0),
        refRate: Number(referralRate ?? process.env.REFERRAL_DEFAULT_RATE ?? 30),
        feeRecipient: feeRecipient ?? process.env.ACTION_HUB_FEE_RECIPIENT ?? '',
        defaultFeeBps: Number(process.env.ACTION_HUB_DEFAULT_FEE_BPS ?? 0),
        overrides: feeOverrides,
        note: 'DB-backed overrides via POST /api/admin/fees. Empty recipient = platform fee disabled.',
      },
      referralPolicies: REFERRAL_POLICIES,
      db: dbConfigured() ? 'postgres' : 'not-configured',
      health: (await pool.query('SELECT * FROM provider_health')).rows,
    };
  }

  if (action === 'fees') {
    if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
    const b = await readJson(req);
    if (b.swapBps != null) {
      const v = Number(b.swapBps);
      if (!isValidBps(v)) return { error: 'INVALID_BPS', message: 'bps must be 0–100.', status: 400 };
      await setConfig('swapBps', String(v));
    }
    if (b.earnBps != null) {
      const v = Number(b.earnBps);
      if (!isValidBps(v)) return { error: 'INVALID_BPS', message: 'bps must be 0–100.', status: 400 };
      await setConfig('earnBps', String(v));
    }
    if (b.referralRate != null) {
      const v = Number(b.referralRate);
      if (!(v >= 0 && v <= 100)) return { error: 'INVALID_RATE', message: 'referral rate must be 0–100.', status: 400 };
      await setConfig('referralRate', String(v));
    }
    if (b.feeRecipient !== undefined) {
      const r = String(b.feeRecipient || '').trim();
      if (r && !validateFeeRecipient(r).valid) {
        return { error: 'INVALID_RECIPIENT', message: 'feeRecipient must be a valid 0x… Sui address or empty (disabled).', status: 400 };
      }
      await setConfig('feeRecipient', r);
    }
    if (b.providerOverride) {
      const { provider, action: act, instrument, bps } = b.providerOverride;
      if (!provider) return { error: 'INVALID_REQUEST', message: 'providerOverride.provider is required.', status: 400 };
      const v = Number(bps);
      if (!isValidBps(v)) return { error: 'INVALID_BPS', message: 'bps must be 0–100.', status: 400 };
      const recipient = String(b.feeRecipient ?? (await getConfig('feeRecipient')) ?? process.env.ACTION_HUB_FEE_RECIPIENT ?? '').trim();
      await setFeeConfig({ provider, action: act || null, instrument: instrument || null, bps: v, recipient });
    }
    return { ok: true, fees: { swapBps: Number(await getConfig('swapBps', '0')), earnBps: Number(await getConfig('earnBps', '0')) } };
  }

  if (action === 'protocol') {
    if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
    const b = await readJson(req);
    await pool.query('UPDATE protocols SET enabled = $1, status = $2 WHERE id = $3', [b.enabled ? 1 : 0, b.status || 'MAINTENANCE', b.id]);
    return { ok: true };
  }

  if (action === 'health') {
    return { health: (await pool.query('SELECT * FROM provider_health')).rows };
  }

  return { error: 'NOT_FOUND', message: 'Unknown admin action.', status: 404 };
});
