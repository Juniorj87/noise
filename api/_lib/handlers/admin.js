// /api/admin/<action> — summary | fees | protocol | health. X-Admin-Key guarded.
// ADMIN_KEY lives only in env; never in responses, never in frontend (§12).
import {NOISE_HUB_REVENUE_WALLET} from '../../../shared/logic.js';
import { handler, readJson, requireAdmin } from '../http.js';
import { listProtocols } from '../adapters.js';
import { REFERRAL_POLICIES, isValidBps } from '../services.js';
import { getPool, ensureSchema, getConfig, setConfig, dbConfigured } from '../pg.js';
import { setFeeConfig, getAllFeeConfigs, validateFeeRecipient } from '../fee-engine.js';

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
        swapBps: Number(swapBps ?? process.env.PLATFORM_SWAP_FEE_BPS ?? 2),
        earnBps: Number(earnBps ?? process.env.PLATFORM_EARN_FEE_BPS ?? 0),
        refRate: Number(referralRate ?? process.env.REFERRAL_DEFAULT_RATE ?? 30),
        feeRecipient: feeRecipient ?? process.env.ACTION_HUB_FEE_RECIPIENT ?? NOISE_HUB_REVENUE_WALLET,
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
    if (b.earnBps != null && Number(b.earnBps)!==0)return{error:'UNSUPPORTED_FEE_POLICY',message:'Hub fees on earn operations are not implemented.',status:400};
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
      const recipient = String(b.feeRecipient ?? (await getConfig('feeRecipient')) ?? process.env.ACTION_HUB_FEE_RECIPIENT ?? NOISE_HUB_REVENUE_WALLET).trim();
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

  if (action === 'referral') {
    // GET: referral controls + live referral/revenue aggregates.
    // POST: update referral controls (rate can never mint rewards above revenue —
    // settlement always computes reward = eligible × rate server-side).
    if (req.method === 'POST') {
      const b = await readJson(req);
      if (b.referralRate != null) {
        const v = Number(b.referralRate);
        if (!(v >= 0 && v <= 100)) return { error: 'INVALID_RATE', message: 'referral rate must be 0–100.', status: 400 };
        await setConfig('referralRate', String(v));
      }
      if (b.refWindowDays != null) {
        const v = Number(b.refWindowDays);
        if (!(v >= 1 && v <= 365)) return { error: 'INVALID_WINDOW', message: 'window must be 1–365 days.', status: 400 };
        await setConfig('refWindowDays', String(v));
      }
      if (b.minPayout != null) {
        const v = Number(b.minPayout);
        if (!(v >= 0 && v <= 100000)) return { error: 'INVALID_MINIMUM', message: 'minimum payout out of range.', status: 400 };
        await setConfig('minPayout', String(v));
      }
      if (b.payoutEnabled !== undefined) await setConfig('payoutEnabled', b.payoutEnabled ? 'true' : 'false');
      if (b.leaderboardEnabled !== undefined) await setConfig('leaderboardEnabled', b.leaderboardEnabled ? 'true' : 'false');
      return { ok: true };
    }
    const { getRevenueSummary } = await import('../referral-analytics.js');
    const summary = await getRevenueSummary(pool);
    const payouts = (await pool.query("SELECT COUNT(*)::int AS c FROM referral_payouts WHERE status = 'pending'")).rows[0];
    const [referralRate, refWindowDays, minPayout, payoutEnabled, leaderboardEnabled] = await Promise.all([
      getConfig('referralRate'), getConfig('refWindowDays'), getConfig('minPayout'),
      getConfig('payoutEnabled'), getConfig('leaderboardEnabled'),
    ]);
    return {
      controls: {
        referralRate: Number(referralRate ?? process.env.REFERRAL_DEFAULT_RATE ?? 30),
        refWindowDays: Number(refWindowDays ?? process.env.REFERRAL_WINDOW_DAYS ?? 30),
        minPayout: Number(minPayout ?? 1),
        payoutEnabled: payoutEnabled === 'true',
        leaderboardEnabled: leaderboardEnabled !== 'false',
      },
      summary, pendingPayouts: Number(payouts?.c) || 0,
      revenueWallet: process.env.NOISE_HUB_REVENUE_WALLET || process.env.ACTION_HUB_FEE_RECIPIENT || null,
    };
  }

  if (action === 'revenue') {
    const { getRevenueSummary } = await import('../referral-analytics.js');
    return getRevenueSummary(pool);
  }

  if (action === 'reconciliation') {
    const { getReconciliation } = await import('../revenue-wallet.js');
    return getReconciliation();
  }

  if (action === 'payout') {
    // Manual settlement attestation: admin confirms an on-chain payout tx.
    // Flips the referrer's pending rewards to paid — never mints, never auto-sends.
    if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
    const b = await readJson(req);
    if (!b.payoutId || !b.txDigest) return { error: 'INVALID_REQUEST', message: 'payoutId and txDigest required.', status: 400 };
    const pay = (await pool.query('SELECT * FROM referral_payouts WHERE id = $1', [b.payoutId])).rows[0];
    if (!pay) return { error: 'NOT_FOUND', message: 'Payout not found.', status: 404 };
    if (pay.status === 'confirmed') return { ok: true, already: true };
    await pool.query("UPDATE referral_payouts SET status = 'confirmed', tx_digest = $1, confirmed_at = now() WHERE id = $2",
      [String(b.txDigest).slice(0, 200), b.payoutId]);
    await pool.query(`UPDATE referral_rewards SET status = 'paid', paid_at = now(), tx_digest = $1
       WHERE status IN ('pending','confirmed') AND COALESCE(referrer,
         (SELECT referrer_wallet FROM referrals r WHERE r.id = referral_rewards.referral_id)) = $2`,
      [String(b.txDigest).slice(0, 200), pay.referrer]);
    return { ok: true, payoutId: b.payoutId };
  }

  return { error: 'NOT_FOUND', message: 'Unknown admin action.', status: 404 };
});
