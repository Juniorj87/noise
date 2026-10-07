// API-mode business services — ported 1:1 from server/src/services.js onto
// PostgreSQL (spec §7, §13, §14). Same state machine, same fee/referral math,
// same safety gates. No SQLite, no in-memory authoritative state.
import { randomBytes } from 'node:crypto';
import { getPool, ensureSchema, getConfig, setConfig } from './pg.js';

export const uid = (prefix = 'id') => prefix + '_' + Date.now().toString(36) + randomBytes(4).toString('hex');

/* ---------- validators (identical to server/src/services.js) ---------- */
export const ACTIONS = ['swap', 'supply', 'withdraw', 'borrow', 'repay', 'stake', 'unstake', 'deposit', 'claim', 'notify', 'transfer',
  // Trade execution (DeepBook Spot + Predict). Distinct from generic swap/claim.
  'spot_order', 'limit_order', 'market_order', 'cancel_order', 'setup_trading_account',
  'predict_mint', 'predict_redeem', 'predict_claim', 'predict_settlement'];
export const PROVIDERS = ['cetus', 'aftermath', 'aftermath-router', 'aftermath-perps', 'deepbook', 'deepbook-predict', 'sui-native', 'navi', 'suilend', 'haedal', 'hub'];
export function isWalletAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{64}$/.test(a); }
export function isPositiveAmount(n) { return typeof n === 'number' && isFinite(n) && n > 0; }
export function isValidBps(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100; }
export function isValidDigest(d) { return typeof d === 'string' && /^[A-Za-z0-9]{20,100}$/.test(d); }

/* ---------- fees (identical math; platform bps overridable via DB config) ---------- */
export function bpsFee(amount, bps) { return Math.round(((amount * bps) / 10000) * 1e6) / 1e6; }

export async function feeConfig() {
  const [swap, earn] = await Promise.all([
    getConfig('swapBps', String(Number(process.env.PLATFORM_SWAP_FEE_BPS ?? 20))),
    getConfig('earnBps', String(Number(process.env.PLATFORM_EARN_FEE_BPS ?? 0))),
  ]);
  return { swapBps: Number(swap), earnBps: Number(earn) };
}

export const FeeEngine = {
  calculateProtocolFee: (amount, protocolBps = 0) => bpsFee(amount, protocolBps),
  calculateProviderFee: (amount, providerBps = 0) => bpsFee(amount, providerBps),
  calculatePlatformFee: (amount, kind = 'swap', cfg = null) => bpsFee(amount, kind === 'swap' ? cfg.swapBps : cfg.earnBps),
  calculateNetworkFee: () => 0.01,
  calculateTotal: (f) => +(Number(f.protocolFee) + Number(f.providerFee) + Number(f.platformFee) + Number(f.networkFee)).toFixed(6),
  calculateReferralReward: (eligible, protocolId, action) => referralReward(eligible, protocolId, action).reward,
  calculateNetPlatformRevenue: ({ platformFee = 0, providerShare = 0, referralReward: rr = 0 }) =>
    Math.round((platformFee + providerShare - rr) * 1e6) / 1e6,
};

export async function feeBreakdown(amount, kind = 'swap') {
  const cfg = await feeConfig();
  const f = {
    protocolFee: FeeEngine.calculateProtocolFee(amount),
    providerFee: FeeEngine.calculateProviderFee(amount),
    platformFee: FeeEngine.calculatePlatformFee(amount, kind, cfg),
    networkFee: FeeEngine.calculateNetworkFee(),
  };
  return { ...f, total: FeeEngine.calculateTotal(f) };
}

/* ---------- referrals (identical policies + settlement rules) ---------- */
export const REFERRAL_POLICIES = {
  'aftermath-perps': { '*': { rate: 10, basis: '10% of referee fees <$100M volume, 5% above (docs/perpetuals/referrals)', verified: '2026-09-30' } },
  'aftermath-router': { swap: { rate: 0, basis: 'hub keeps 97.5% of its own integrator fee; Aftermath retains 2.5% (docs/router fees)', verified: '2026-09-30' } },
  cetus: { '*': { rate: 0, basis: 'partner program closed to new teams (partner-swap docs)', verified: '2026-09-30' } },
  // Predict: referral/builder revenue is a split of protocol proceeds, never a
  // trader debit. Without a registered builder code there is no eligible hub
  // revenue, so the policy rate applies to $0 until a code is configured.
  'deepbook-predict': { '*': { rate: 0, basis: 'builder-code split only when a builder code is registered; no separate trader debit', verified: '2026-10-02' } },
  deepbook: { '*': { rate: 0, basis: 'no DeepBook integrator revenue share verified', verified: '2026-10-02' } },
};
export function referralPolicyFor(protocolId, action = '*') {
  const p = REFERRAL_POLICIES[protocolId];
  if (p && (p[action] || p['*'])) return { protocolId, action, ...(p[action] || p['*']) };
  return { protocolId, action, rate: 0, basis: 'partner terms UNVERIFIED — no invented revenue', verified: null };
}
export function referralReward(eligiblePlatformFee, protocolId = null, action = '*') {
  const policy = protocolId ? referralPolicyFor(protocolId, action) : null;
  const rate = policy ? policy.rate : Number(process.env.REFERRAL_DEFAULT_RATE ?? 30);
  const base = Math.max(0, Number(eligiblePlatformFee) || 0);
  const reward = Math.round(base * (rate / 100) * 1e6) / 1e6;
  return { reward, retained: Math.round((base - reward) * 1e6) / 1e6, rate, policy };
}

export function refWindowDays() { return Number(process.env.REFERRAL_WINDOW_DAYS ?? 30); }

export async function registerReferralCode(code, referrerWallet) {
  code = String(code || '').trim().toLowerCase();
  if (!/^[a-z0-9-_]{3,20}$/.test(code)) throw Object.assign(new Error('INVALID_CODE'), { code: 'INVALID_CODE' });
  if (!isWalletAddress(referrerWallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  await ensureSchema();
  const pool = getPool();
  const clash = (await pool.query('SELECT * FROM referrals WHERE code = $1', [code])).rows[0];
  if (clash && clash.referrer_wallet && clash.referrer_wallet !== referrerWallet) {
    throw Object.assign(new Error('CODE_TAKEN'), { code: 'CODE_TAKEN' });
  }
  if (clash) {
    if (clash.referrer_wallet === referrerWallet) return clash;
    await pool.query('UPDATE referrals SET referrer_wallet = $1, updated_at = now() WHERE id = $2', [referrerWallet, clash.id]);
    return (await pool.query('SELECT * FROM referrals WHERE id = $1', [clash.id])).rows[0];
  }
  const expires = new Date(Date.now() + refWindowDays() * 864e5).toISOString();
  const id = uid('ref');
  await pool.query('INSERT INTO referrals (id, code, referrer_wallet, expires_at) VALUES ($1,$2,$3,$4)', [id, code, referrerWallet, expires]);
  return (await pool.query('SELECT * FROM referrals WHERE id = $1', [id])).rows[0];
}

export async function attributeReferral(code, referredWallet) {
  code = String(code || '').trim();
  if (!code) return { ok: false, error: 'MISSING_CODE' };
  await ensureSchema();
  const pool = getPool();
  const row = (await pool.query('SELECT * FROM referrals WHERE code = $1', [code])).rows[0];
  if (!row) {
    const expires = new Date(Date.now() + refWindowDays() * 864e5).toISOString();
    const id = uid('ref');
    await pool.query('INSERT INTO referrals (id, code, referred_wallet, expires_at) VALUES ($1,$2,$3,$4)', [id, code, referredWallet, expires]);
    return { ok: true, id, fresh: true };
  }
  if (row.referrer_wallet && row.referrer_wallet === referredWallet) return { ok: false, error: 'SELF_REFERRAL' };
  if (row.referrer_wallet) {
    const circ = (await pool.query(
      `SELECT id FROM referral_attributions WHERE referrer = $1 AND referred_wallet = $2
       UNION ALL SELECT id FROM referrals WHERE referrer_wallet = $1 AND referred_wallet = $2 LIMIT 1`,
      [referredWallet, row.referrer_wallet])).rows[0];
    if (circ) return { ok: false, error: 'CIRCULAR_REFERRAL' };
  }
  // First attribution wins — a wallet attributed elsewhere keeps its ORIGINAL
  // referrer; after a qualifying confirmed action the freeze is explicit.
  const existing = (await pool.query('SELECT * FROM referral_attributions WHERE referred_wallet = $1', [referredWallet])).rows[0]
    || (await pool.query('SELECT id, code, referrer_wallet AS referrer FROM referrals WHERE referred_wallet = $1 AND referrer_wallet IS NOT NULL', [referredWallet])).rows[0];
  if (existing) {
    const same = existing.referrer === row.referrer_wallet
      && (existing.code === code || existing.code === row.code);
    if (same) return { ok: true, id: existing.id, fresh: false };
    const acted = (await pool.query("SELECT id FROM transactions WHERE wallet = $1 AND status = 'confirmed' LIMIT 1", [referredWallet])).rows[0];
    return { ok: false, error: acted ? 'ALREADY_ACTIVE' : 'ALREADY_ATTRIBUTED' };
  }
  // One code attributes MANY wallets: first fills the legacy single slot,
  // every wallet gets an attribution row (canonical for stats/settlement).
  try {
    await pool.query(
      `INSERT INTO referral_attributions (id, code, referrer, referred_wallet, source, status)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uid('att'), code, row.referrer_wallet, referredWallet, 'link', 'attributed']);
  } catch {
    return { ok: false, error: 'ALREADY_ATTRIBUTED' };
  }
  if (!row.referred_wallet) {
    try {
      await pool.query("UPDATE referrals SET referred_wallet = $1, attributed_at = now(), status = 'attributed' WHERE id = $2", [referredWallet, row.id]);
    } catch {
      await pool.query('UPDATE referrals SET referred_wallet = $1 WHERE id = $2', [referredWallet, row.id]);
    }
  }
  return { ok: true, id: row.id, fresh: false };
}

/* ---------- transaction state machine (identical transitions) ---------- */
export const TX = {
  CREATED: 'created', QUOTED: 'quoted', BUILT: 'built', SIMULATING: 'simulating',
  SIMULATION_FAILED: 'simulation_failed', READY_TO_SIGN: 'ready_to_sign',
  AWAITING_WALLET: 'awaiting_wallet', SIGNED: 'signed', SUBMITTED: 'submitted',
  PENDING: 'pending', CONFIRMED: 'confirmed', FAILED: 'failed',
  REJECTED: 'rejected', EXPIRED: 'expired',
};
const FINAL_TX = [TX.CONFIRMED, TX.FAILED, TX.REJECTED, TX.EXPIRED];
const TX_FLOW = {
  [TX.CREATED]: [TX.QUOTED, TX.BUILT, TX.SUBMITTED, TX.EXPIRED],
  [TX.QUOTED]: [TX.QUOTED, TX.BUILT, TX.SUBMITTED, TX.EXPIRED],
  [TX.BUILT]: [TX.BUILT, TX.SIMULATING, TX.SIMULATION_FAILED, TX.EXPIRED],
  [TX.SIMULATING]: [TX.READY_TO_SIGN, TX.SIMULATION_FAILED, TX.EXPIRED],
  [TX.SIMULATION_FAILED]: [TX.BUILT, TX.SIMULATING, TX.EXPIRED],
  [TX.READY_TO_SIGN]: [TX.AWAITING_WALLET, TX.EXPIRED],
  [TX.AWAITING_WALLET]: [TX.SIGNED, TX.SUBMITTED, TX.REJECTED, TX.EXPIRED],
  [TX.SIGNED]: [TX.SUBMITTED, TX.EXPIRED],
  [TX.SUBMITTED]: [TX.PENDING, TX.CONFIRMED, TX.FAILED, TX.EXPIRED],
  [TX.PENDING]: [TX.PENDING, TX.CONFIRMED, TX.FAILED, TX.EXPIRED],
};
const TX_MUTABLE = ['digest', 'failure_reason', 'actual_output', 'gas', 'expected_output',
  'provider', 'protocol_fee', 'provider_fee', 'platform_fee',
  'input_asset', 'input_amount', 'output_asset'];

export async function createTransaction(data) {
  if (!isWalletAddress(data.wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  await ensureSchema();
  const id = uid('tx');
  await getPool().query(
    `INSERT INTO transactions (id, wallet, action, provider, input_asset, input_amount, output_asset,
       expected_output, protocol_fee, provider_fee, platform_fee, gas, fees_json, status, source, origin, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'manual', now())`,
    [id, data.wallet, data.action || 'swap', data.provider || null, data.input_asset || null,
      data.input_amount || null, data.output_asset || null, data.expected_output || null,
      data.protocol_fee || null, data.provider_fee || null, data.platform_fee || null,
      data.gas || null, data.fees_json ? JSON.stringify(data.fees_json) : null,
      TX.CREATED, data.source || 'manual']);
  return getTransaction(id);
}

export async function getTransaction(id) {
  return (await getPool().query('SELECT * FROM transactions WHERE id = $1', [id])).rows[0] || null;
}

export async function getTransactionByDigest(digest) {
  return (await getPool().query('SELECT * FROM transactions WHERE digest = $1', [digest])).rows[0] || null;
}

export async function transitionTransaction(id, to, extra = {}) {
  const tx = await getTransaction(id);
  if (!tx) throw Object.assign(new Error('TX_NOT_FOUND'), { code: 'TX_NOT_FOUND' });
  if (FINAL_TX.includes(tx.status) && to !== tx.status) {
    throw Object.assign(new Error('TX_FINAL'), { code: 'TX_FINAL' });
  }
  const allowed = TX_FLOW[tx.status] || [];
  if (to !== tx.status && !allowed.includes(to)) {
    throw Object.assign(new Error('TX_BAD_TRANSITION'), { code: 'TX_BAD_TRANSITION' });
  }
  const sets = ['status = $1', 'updated_at = now()'];
  const vals = [to];
  let n = 2;
  for (const k of TX_MUTABLE) {
    if (extra[k] !== undefined) { sets.push(`${k} = $${n}`); vals.push(extra[k]); n++; }
  }
  vals.push(id);
  await getPool().query(`UPDATE transactions SET ${sets.join(', ')} WHERE id = $${n}`, vals);
  return getTransaction(id);
}

/** Save digest immediately on submit. Same digest → same record (no duplicates). */
export async function recordDigest(data) {
  if (!isValidDigest(data.digest)) throw Object.assign(new Error('INVALID_DIGEST'), { code: 'INVALID_DIGEST' });
  const existing = await getTransactionByDigest(data.digest);
  if (existing) return { ...existing, duplicate: true };
  const tx = data.txId ? await getTransaction(data.txId) : null;
  if (tx) {
    // A confirmed/failed/rejected record is genuinely settled — never reopen it.
    if ([TX.CONFIRMED, TX.FAILED, TX.REJECTED].includes(tx.status)) return tx;
    try {
      return await transitionTransaction(tx.id, TX.SUBMITTED, { digest: data.digest });
    } catch (e) {
      if (e.code !== 'TX_BAD_TRANSITION' && e.code !== 'TX_FINAL') throw e;
      // The wallet produced a digest but the record never reached a state that
      // allows `submitted` (e.g. the tab closed mid-flow, or the PATCH to
      // `signed` was lost). Persist the digest directly so the background
      // tracker still owns this transaction instead of losing it from view.
      await getPool().query(
        'UPDATE transactions SET status = $1, digest = $2, failure_reason = NULL, updated_at = now() WHERE id = $3',
        [TX.SUBMITTED, data.digest, tx.id]);
      return getTransaction(tx.id);
    }
  }
  const created = await createTransaction({ ...data, source: data.source || 'manual' });
  return transitionTransaction(created.id, TX.SUBMITTED, { digest: data.digest });
}

/* ---------- referral settlement (ONLY after confirmed eligible revenue) ---------- */
export async function settleReferralForTx(tx) {
  if (!tx || tx.status !== TX.CONFIRMED) return { reward: 0, reason: 'NOT_CONFIRMED' };
  if (!tx.digest) return { reward: 0, reason: 'MISSING_DIGEST' };
  await ensureSchema();
  const pool = getPool();
  const eligible = Number(tx.platform_fee || 0);
  if (!(eligible > 0)) return { reward: 0, reason: 'NO_ELIGIBLE_REVENUE' };
  const rawKey = String(tx.provider || '').toLowerCase().replace(/[^a-z]/g, '');
  const aliases = { cetus: 'cetus', aftermathrouter: 'aftermath-router', aftermath: 'aftermath-router', aftermathperps: 'aftermath-perps', deepbook: 'deepbook', deepbookpredict: 'deepbook-predict' };
  const policy = referralPolicyFor(aliases[rawKey] || rawKey || 'cetus', tx.action || '*');
  const rate = policy.rate;
  if (!(rate > 0)) return { reward: 0, reason: 'POLICY_RATE_ZERO', policy };
  // Canonical attribution record first, legacy single-slot row as fallback.
  // referral_id must reference a real referrals row (FK-safe).
  const att = (await pool.query('SELECT * FROM referral_attributions WHERE referred_wallet = $1', [tx.wallet])).rows[0];
  const legacy = att ? null : (await pool.query('SELECT * FROM referrals WHERE referred_wallet = $1', [tx.wallet])).rows[0];
  const referrerWallet = att ? att.referrer : legacy?.referrer_wallet;
  const regRow = att
    ? ((await pool.query('SELECT * FROM referrals WHERE code = $1', [att.code])).rows[0]
      || (await pool.query('SELECT * FROM referrals WHERE referrer_wallet = $1 LIMIT 1', [referrerWallet])).rows[0])
    : legacy;
  if (!referrerWallet || !regRow) return { reward: 0, reason: 'NO_ATTRIBUTION', policy };
  if (referrerWallet === tx.wallet) return { reward: 0, reason: 'SELF_REFERRAL', policy };
  if (regRow.expires_at && new Date(regRow.expires_at) < new Date()) return { reward: 0, reason: 'WINDOW_EXPIRED', policy };
  const ref = regRow;
  const circular = (await pool.query(
    `SELECT id FROM referral_attributions WHERE referrer = $1 AND referred_wallet = $2
     UNION ALL SELECT id FROM referrals WHERE referrer_wallet = $1 AND referred_wallet = $2 LIMIT 1`,
    [tx.wallet, referrerWallet])).rows[0];
  if (circular) return { reward: 0, reason: 'CIRCULAR_REFERRAL', policy };
  const dup = (await pool.query('SELECT id FROM revenue_entries WHERE digest = $1', [tx.digest])).rows[0];
  if (dup) return { reward: 0, reason: 'DUPLICATE_DIGEST', policy };
  const reward = Math.round(eligible * (rate / 100) * 1e6) / 1e6;
  const net = Math.round((eligible - reward) * 1e6) / 1e6;
  const revId = uid('rev');
  await pool.query(
    `INSERT INTO revenue_entries (id, tx_id, wallet, referrer_wallet, referred_wallet, action, provider, digest,
       platform_fee, provider_share, referral_reward, net_revenue, gross_revenue, eligible_revenue, referral_rate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'0',$10,$11,$12,$12,$13)`,
    [revId, tx.id, tx.wallet, referrerWallet, tx.wallet, tx.action, tx.provider, tx.digest,
      String(eligible), String(reward), String(net), String(eligible), String(rate)]);
  // referrer column exists on fresh schemas; legacy DBs fall back to the join path.
  try {
    await pool.query('INSERT INTO referral_rewards (id, referral_id, revenue_id, referrer, amount, status) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid('rew'), ref.id, revId, referrerWallet, String(reward), 'pending']);
  } catch {
    await pool.query('INSERT INTO referral_rewards (id, referral_id, revenue_id, amount, status) VALUES ($1,$2,$3,$4,$5)',
      [uid('rew'), ref.id, revId, String(reward), 'pending']);
  }
  return { reward, retained: net, revenueId: revId, policy };
}

/* ---------- DeepBook orders (server-side record; chain status is authoritative) ---------- */
import { deepbookDb } from './deepbook-db.js';
export const {
  upsertDeepbookOrder, updateDeepbookOrderStatus, listDeepbookOrders,
  getDeepbookOrder, refreshDeepbookOpenOrders,
} = deepbookDb;

/* ---------- activity / revenue ---------- */
export async function logActivity({ wallet, action, provider = null, asset = null, amount = null, fees = null, digest = null, status = 'submitted', origin = 'manual' }) {
  await ensureSchema();
  const id = uid('act');
  await getPool().query(
    'INSERT INTO activities (id, wallet, action, provider, asset, amount, fees_json, digest, status, origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, wallet, action, provider, asset, amount, fees ? JSON.stringify(fees) : null, digest, status, origin]);
  return id;
}

export async function recordRevenue({ txId = null, wallet, referrerWallet = null, action, provider, digest = null, platformFee, providerShare = 0, referralReward: rr = 0, referralRate = 0 }) {
  await ensureSchema();
  const id = uid('rev');
  const net = Math.round((platformFee + providerShare - rr) * 1e6) / 1e6;
  const gross = platformFee + providerShare;
  await getPool().query(
    `INSERT INTO revenue_entries (id, tx_id, wallet, referrer_wallet, referred_wallet, action, provider, digest,
       platform_fee, provider_share, referral_reward, net_revenue, gross_revenue, eligible_revenue, referral_rate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, txId, wallet, referrerWallet, wallet, action, provider, digest,
      String(platformFee), String(providerShare), String(rr), String(net), String(gross), String(platformFee), String(referralRate)]);
  return { id, net };
}

/* ---------- automation (identical limits, permissions, expiry) ---------- */
export function parseAutomationNL(text) {
  const s = String(text || '').toLowerCase();
  if (s.includes('monday') && s.includes('yield')) {
    return { trigger: { type: 'SCHEDULE', cron: '0 9 * * 1' }, task: { type: 'COMPARE_EARN' }, asset: 'USDC', output: 'NOTIFY' };
  }
  if (s.includes('reward') && (s.includes('$10') || s.includes('10'))) {
    return { trigger: { type: 'REWARD_THRESHOLD', valueUsd: 10 }, action: { type: 'CLAIM_REWARDS' } };
  }
  if (s.includes('predict') && s.includes('expir')) {
    return { trigger: { type: 'PREDICT_EXPIRY', minutesBefore: 5 }, action: { type: 'NOTIFY' } };
  }
  if (s.includes('predict') && s.includes('probab')) {
    return { trigger: { type: 'PREDICT_PROBABILITY_ABOVE', value: 0.8 }, action: { type: 'NOTIFY' } };
  }
  if (s.includes('order') && s.includes('fill')) {
    return { trigger: { type: 'ORDER_FILLED' }, action: { type: 'NOTIFY' } };
  }
  if ((s.includes('below') || s.includes('under') || s.includes('<')) && (s.includes('$') || s.includes('price'))) {
    return { trigger: { type: 'PRICE_BELOW', asset: 'SUI', value: 1 }, action: { type: 'NOTIFY' } };
  }
  if ((s.includes('apy') || s.includes('yield')) && s.includes('above')) {
    return { trigger: { type: 'APY_ABOVE', value: 5 }, action: { type: 'NOTIFY' } };
  }
  if (s.includes('$5') || s.includes('price')) {
    return { trigger: { type: 'PRICE_ABOVE', asset: 'SUI', value: 5 }, action: { type: 'NOTIFY' } };
  }
  return { trigger: { type: 'MANUAL' }, task: String(text).slice(0, 80), output: 'NOTIFY' };
}

export function validateAutomation({ maxPerExecutionUsd, maxDailyUsd }) {
  if (!(maxPerExecutionUsd > 0) || maxPerExecutionUsd > 10000) return 'LIMIT_PER_EXECUTION_INVALID';
  if (!(maxDailyUsd > 0) || maxDailyUsd > 100000) return 'LIMIT_DAILY_INVALID';
  if (maxPerExecutionUsd > maxDailyUsd) return 'LIMIT_INCONSISTENT';
  return null;
}

export function checkAutomationPermission(auto, action) {
  if (!auto || auto.status !== 'active') return 'AUTOMATION_NOT_ACTIVE';
  if (auto.expires_at && new Date(auto.expires_at) < new Date()) return 'AUTOMATION_EXPIRED';
  try {
    const a = JSON.parse(auto.action_json || '{}');
    if (Array.isArray(a.allowedActions) && !a.allowedActions.includes(action)) return 'ACTION_NOT_ALLOWED';
  } catch {}
  return null;
}

export async function createAutomation({ wallet, title, trigger, action, type = 'MANUAL', intent = null, protocol = 'hub', maxPerExecutionUsd, maxDailyUsd, expiresDays = 30 }) {
  if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  const err = validateAutomation({ maxPerExecutionUsd, maxDailyUsd });
  if (err) { const e = new Error(err); e.code = err; throw e; }
  await ensureSchema();
  const id = uid('auto');
  const expires = new Date(Date.now() + expiresDays * 864e5).toISOString();
  await getPool().query(
    `INSERT INTO automations (id, wallet, title, type, intent, protocol, trigger_json, action_json, conditions_json,
       limits_json, max_per_execution_usd, max_daily_usd, expires_at, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active', now())`,
    [id, wallet, title, type || trigger?.type || 'MANUAL', intent || title, protocol || 'hub',
      JSON.stringify(trigger || {}), JSON.stringify(action || {}), JSON.stringify(trigger?.conditions || {}),
      JSON.stringify({ maxPerExecutionUsd, maxDailyUsd }), maxPerExecutionUsd, maxDailyUsd, expires]);
  await logActivity({ wallet, action: 'Automation created', provider: 'hub scheduler', amount: 'max $' + maxPerExecutionUsd, origin: 'manual' });
  return (await getPool().query('SELECT * FROM automations WHERE id = $1', [id])).rows[0];
}

export async function setAutomationStatus(id, status, wallet = null) {
  const norm = String(status || '').toLowerCase();
  const allowed = ['active', 'paused', 'revoked', 'expired', 'failed'];
  if (!allowed.includes(norm)) throw Object.assign(new Error('INVALID_STATUS'), { code: 'INVALID_STATUS' });
  await ensureSchema();
  const pool = getPool();
  const row = (await pool.query('SELECT * FROM automations WHERE id = $1', [id])).rows[0];
  if (!row) throw Object.assign(new Error('AUTOMATION_NOT_FOUND'), { code: 'AUTOMATION_NOT_FOUND' });
  if (wallet && isWalletAddress(wallet) && row.wallet !== wallet) {
    throw Object.assign(new Error('NOT_AUTOMATION_OWNER'), { code: 'NOT_AUTOMATION_OWNER' });
  }
  await pool.query("UPDATE automations SET status = $1, updated_at = now() WHERE id = $2", [norm, id]);
}

/** One scheduler pass over active automations (called by cron, not setInterval). */
export async function automationTick() {
  await ensureSchema();
  const pool = getPool();
  const nowIso = new Date().toISOString();
  await pool.query("UPDATE automations SET status = 'expired', updated_at = now() WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= $1", [nowIso]);
  const due = (await pool.query("SELECT * FROM automations WHERE status = 'active' AND (expires_at IS NULL OR expires_at > $1)", [nowIso])).rows;
  for (const a of due) {
    try {
      const trigger = JSON.parse(a.trigger_json || '{}');
      const detail = 'trigger ' + (trigger.type || 'MANUAL') + ' evaluated — wallet approval required before any execution';
      await pool.query('UPDATE automations SET last_run_at = $1, last_result = $2, updated_at = $1 WHERE id = $3', [nowIso, 'checked', a.id]);
      await pool.query('INSERT INTO automation_runs (id, automation_id, result, detail) VALUES ($1,$2,$3,$4)', [uid('run'), a.id, 'checked', detail]);
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      await pool.query("UPDATE automations SET last_run_at = $1, last_result = 'failed', failure_reason = $2, updated_at = $1 WHERE id = $3", [nowIso, msg, a.id]);
      await pool.query('INSERT INTO automation_runs (id, automation_id, result, detail) VALUES ($1,$2,$3,$4)', [uid('run'), a.id, 'failed', msg]);
    }
  }
  return { checked: due.length, at: nowIso };
}

/* ---------- memory (consent-gated app-level prefs; PostgreSQL storage) ----------
 * Noise Memory is plain application memory: AI -> Noise backend -> PostgreSQL.
 * Secrets (private keys, seeds, passwords, auth secrets) are rejected at write
 * and never reach storage. See shared/logic.js findSecretKind. */
export async function saveMemory({ wallet, category, content, namespace = 'personal' }) {
  const allowed = ['preference', 'protocol-preference', 'notification-preference', 'workflow-preference',
    'project-context', 'user-instruction', 'ai-fact'];
  if (!allowed.includes(category)) throw Object.assign(new Error('INVALID_CATEGORY'), { code: 'INVALID_CATEGORY' });
  const { findSecretKind } = await import('../../shared/logic.js');
  const kind = findSecretKind(String(category) + ' ' + String(content));
  if (kind) {
    throw Object.assign(new Error('FORBIDDEN_CONTENT'), { code: 'FORBIDDEN_CONTENT' });
  }
  const legacy = ['seed', 'privatekey', 'private-key', 'mnemonic'];
  if (legacy.some((w) => String(content).toLowerCase().includes(w))) {
    throw Object.assign(new Error('FORBIDDEN_CONTENT'), { code: 'FORBIDDEN_CONTENT' });
  }
  await ensureSchema();
  const id = uid('mem');
  const ns = String(namespace || 'personal').slice(0, 40);
  const body = String(content).slice(0, 2000);
  try {
    await getPool().query(
      'INSERT INTO memory_records (id, wallet, owner, namespace, category, content_cipher, status, encryption) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, wallet, wallet, ns, category, body, 'active', 'local']);
  } catch {
    // Legacy schema fallback (pre-migration DBs).
    await getPool().query('INSERT INTO memory_records (id, wallet, category, content_cipher) VALUES ($1,$2,$3,$4)',
      [id, wallet, category, body]);
  }
  return { id };
}

/** Owner-scoped keyword search over the Noise memory index (rebuildable cache).
 *  Simple token overlap — no invented embeddings; real semantic index later. */
export async function searchMemory({ wallet, query, limit = 8 }) {
  await ensureSchema();
  const lim = Math.max(1, Math.min(25, Number(limit) || 8));
  const q = String(query || '').toLowerCase();
  const tokens = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2).slice(0, 12);
  let rows;
  try {
    rows = (await getPool().query(
      "SELECT id, category, content_cipher AS content, created_at FROM memory_records WHERE wallet = $1 AND (status IS NULL OR status = 'active') ORDER BY created_at DESC LIMIT 200",
      [wallet])).rows;
  } catch {
    rows = (await getPool().query(
      'SELECT id, category, content_cipher AS content, created_at FROM memory_records WHERE wallet = $1 ORDER BY created_at DESC LIMIT 200',
      [wallet])).rows;
  }
  if (!tokens.length) return rows.slice(0, lim).map((r) => ({ ...r, score: 0 }));
  const scored = rows.map((r) => {
    const hay = String(r.content || '').toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score += 1;
    return { ...r, score };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score || String(b.created_at).localeCompare(String(a.created_at)));
  return scored.slice(0, lim);
}

export async function memoryStats(wallet) {
  await ensureSchema();
  try {
    const r = (await getPool().query(
      "SELECT COUNT(*)::int AS total, MAX(created_at) AS last FROM memory_records WHERE wallet = $1 AND (status IS NULL OR status = 'active')",
      [wallet])).rows[0];
    return { total: Number(r?.total) || 0, lastSync: r?.last || null };
  } catch {
    return { total: 0, lastSync: null };
  }
}

/* ---------- AI providers (identical registry; keys env-only) ---------- */
export const AI_PROVIDERS = {
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', style: 'openai', keyEnv: 'OPENROUTER_API_KEY', docs: 'https://openrouter.ai/docs' },
  openai: { url: 'https://api.openai.com/v1/chat/completions', style: 'openai', keyEnv: 'OPENAI_API_KEY', docs: 'https://platform.openai.com/docs' },
  custom: { url: process.env.AI_BASE_URL || '', style: 'openai', keyEnv: 'AI_API_KEY', docs: '' },
  anthropic: { url: 'https://api.anthropic.com/v1/messages', style: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', docs: 'https://docs.anthropic.com' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models', style: 'gemini', keyEnv: 'GOOGLE_AI_API_KEY', docs: 'https://ai.google.dev' },
};

function aiConfig(name) {
  const p = AI_PROVIDERS[name] || AI_PROVIDERS.openrouter;
  const key = process.env[p.keyEnv] || (name === (process.env.AI_PROVIDER || '') ? (process.env.AI_API_KEY || process.env.LLM_API_KEY) : null);
  return { ...p, name, key: key || null, model: process.env.AI_MODEL || '' };
}

async function callProvider(cfg, { model, messages }) {
  const useModel = model || cfg.model;
  if (!cfg.key) throw Object.assign(new Error('NO_API_KEY'), { code: 'NO_API_KEY' });
  if (!useModel) throw Object.assign(new Error('NO_MODEL'), { code: 'NO_MODEL' });
  if (cfg.style === 'openai') {
    if (!cfg.url) throw Object.assign(new Error('NO_BASE_URL'), { code: 'NO_BASE_URL' });
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({ model: useModel, messages }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw Object.assign(new Error('LLM_' + r.status), { code: 'LLM_UNAVAILABLE' });
    const j = await r.json();
    return j.choices?.[0]?.message?.content ?? 'LLM_EMPTY';
  }
  if (cfg.style === 'anthropic') {
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: useModel, max_tokens: 1024, system: messages[0]?.content || '', messages: messages.slice(1) }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw Object.assign(new Error('LLM_' + r.status), { code: 'LLM_UNAVAILABLE' });
    const j = await r.json();
    return j.content?.map((c) => c.text || '').join('') || 'LLM_EMPTY';
  }
  const r = await fetch(`${cfg.url}/${useModel}:generateContent?key=${encodeURIComponent(cfg.key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: messages.map((m) => m.content).join('\n') }] }] }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw Object.assign(new Error('LLM_' + r.status), { code: 'LLM_UNAVAILABLE' });
  const j = await r.json();
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || 'LLM_EMPTY';
}

export async function testAiConnection({ provider, model, apiKey }) {
  const cfg = { ...(AI_PROVIDERS[provider] || AI_PROVIDERS.openrouter), name: provider, key: apiKey || null, model: model || '' };
  const t = Date.now();
  const answer = await callProvider(cfg, { model, messages: [{ role: 'user', content: 'Reply with: ok' }] });
  return { ok: true, latencyMs: Date.now() - t, preview: String(answer).slice(0, 80) };
}

/** Pure classifier for tracker results (regression-tested):
 *  confirmed → 'confirmed'; explicit failed → 'failed'; rejected → 'rejected';
 *  everything else (pending / submitted / unknown-yet / null) → 'pending'.
 *  Absence of confirmation is NEVER classified as failure. */
export function classifyTrackingResult(r) {
  if (!r) return 'pending';
  if (r.status === TX.CONFIRMED || r.status === 'confirmed') return 'confirmed';
  if (r.status === TX.FAILED || r.status === 'failed') return 'failed';
  if (r.status === TX.REJECTED || r.status === 'rejected') return 'rejected';
  return 'pending';
}

export const TRACKING_WINDOW_MS = 30 * 60 * 1000;

/** Pure expiry predicate (regression-tested): expire ONLY when the digest is
 *  still unknown to the chain AND the record is older than the window. */
export function shouldExpireTx(tx, err, nowMs = Date.now()) {
  const notFound = err && (err.code === 'TX_NOT_FOUND_ON_CHAIN' || err.code === 'TX_NOT_FOUND' || err.pending);
  if (!notFound) return false;
  const staleMs = nowMs - new Date(tx.updated_at || tx.created_at).getTime();
  return staleMs > TRACKING_WINDOW_MS;
}

/** One pass of the chain-status tracker (called by cron, not setInterval).
 *  State rules (absence of confirmation is NEVER a failure):
 *   - confirmed          → confirmed (+ referral settlement, accounting)
 *   - explicitly failed  → failed
 *   - rejected           → rejected
 *   - pending/submitted  → stays pending/submitted (SUBMITTED → PENDING touch)
 *   - transient provider error → retry, never failed
 *   - expired            → ONLY when the digest is still unknown after the
 *                          tracking window (30 min) — never for live txs. */
export async function trackPendingOnce(fetchTxStatus) {
  await ensureSchema();
  const pool = getPool();
  const pending = (await pool.query("SELECT * FROM transactions WHERE status IN ('submitted','pending') AND digest IS NOT NULL")).rows;
  const out = [];
  for (const tx of pending) {
    let r;
    try {
      r = await fetchTxStatus(tx.digest);
    } catch (e) {
      // Real expiry: unknown to the chain AND outside the tracking window.
      // Anything else (transient RPC error, or a young tx) → retry.
      if (shouldExpireTx(tx, e)) {
        await transitionTransaction(tx.id, TX.EXPIRED, { failure_reason: 'Not found on chain within tracking window (RPC unreachable or tx expired in wallet)' });
        out.push({ id: tx.id, status: 'expired' });
      } else {
        out.push({ id: tx.id, status: 'retry', error: String(e.message || e).slice(0, 120) });
      }
      continue;
    }
    const cls = classifyTrackingResult(r);
    if (cls === 'confirmed') {
      if (tx.status === TX.SUBMITTED) await transitionTransaction(tx.id, TX.PENDING, {});
      const fin = await transitionTransaction(tx.id, TX.CONFIRMED, {
        gas: (r && r.gas) || tx.gas,
        actual_output: (r && r.actualOutput) || tx.actual_output,
      });
      await settleReferralForTx(fin);
      out.push({ id: tx.id, status: 'confirmed', settled: true });
    } else if (cls === 'failed') {
      const cur = tx.status === TX.SUBMITTED ? await transitionTransaction(tx.id, TX.PENDING, {}) : tx;
      await transitionTransaction(cur.id, TX.FAILED, { failure_reason: r.failureReason || 'Failed on-chain', gas: r.gas || cur.gas });
      out.push({ id: tx.id, status: 'failed' });
    } else if (cls === 'rejected') {
      const cur = tx.status === TX.SUBMITTED ? await transitionTransaction(tx.id, TX.PENDING, {}) : tx;
      try {
        await transitionTransaction(cur.id, TX.REJECTED, { failure_reason: r.failureReason || 'Rejected by wallet', gas: r.gas || cur.gas });
      } catch (e) {
        if (e.code !== 'TX_BAD_TRANSITION' && e.code !== 'TX_FINAL') throw e;
      }
      out.push({ id: tx.id, status: 'rejected' });
    } else {
      // pending / submitted / unknown-yet → keep alive, never fail.
      if (tx.status === TX.SUBMITTED) {
        await transitionTransaction(tx.id, TX.PENDING, {});
        out.push({ id: tx.id, status: 'pending' });
      } else {
        out.push({ id: tx.id, status: tx.status });
      }
    }
  }
  return out;
}

export { getConfig, setConfig };
