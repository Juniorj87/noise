// Pure, dependency-free business logic shared by the SQLite dev server
// (server/src/services.js) and the Vercel API layer (api/_lib/services.js).
// Keep this file import-free so tests can load it in isolation.

/* ---------- validators ---------- */
export const ACTIONS = ['swap', 'supply', 'withdraw', 'borrow', 'repay', 'stake', 'unstake', 'deposit', 'claim', 'notify', 'transfer',
  'spot_order', 'limit_order', 'market_order', 'cancel_order', 'setup_trading_account',
  'predict_mint', 'predict_redeem', 'predict_claim', 'predict_settlement'];
export const PROVIDERS = ['cetus', 'aftermath', 'aftermath-router', 'aftermath-perps', 'deepbook', 'deepbook-predict', 'sui-native', 'navi', 'suilend', 'hub'];
export function isWalletAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{64}$/.test(a); }
export function isPositiveAmount(n) { return typeof n === 'number' && isFinite(n) && n > 0; }
export function isValidBps(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100; }
export function isValidDigest(d) { return typeof d === 'string' && /^[A-Za-z0-9]{20,100}$/.test(d); }

/* ---------- fee math ---------- */
export function bpsFee(amount, bps) { return Math.round(((amount * bps) / 10000) * 1e6) / 1e6; }

/* ---------- transaction state machine ---------- */
export const TX = {
  CREATED: 'created', QUOTED: 'quoted', BUILT: 'built', SIMULATING: 'simulating',
  SIMULATION_FAILED: 'simulation_failed', READY_TO_SIGN: 'ready_to_sign',
  AWAITING_WALLET: 'awaiting_wallet', SIGNED: 'signed', SUBMITTED: 'submitted',
  PENDING: 'pending', CONFIRMED: 'confirmed', FAILED: 'failed',
  REJECTED: 'rejected', EXPIRED: 'expired',
};
export const FINAL_TX = [TX.CONFIRMED, TX.FAILED, TX.REJECTED, TX.EXPIRED];
export const TX_FLOW = {
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
export const TX_MUTABLE = ['digest', 'failure_reason', 'actual_output', 'gas', 'expected_output',
  'provider', 'protocol_fee', 'provider_fee', 'platform_fee',
  'input_asset', 'input_amount', 'output_asset'];

/** Validate a transition; returns { ok } or { ok:false, code }. Final-state freeze wins over flow check. */
export function checkTransition(from, to) {
  if (FINAL_TX.includes(from) && to !== from) return { ok: false, code: 'TX_FINAL' };
  if (!TX_FLOW[from]) return { ok: false, code: 'TX_BAD_TRANSITION' };
  if (to !== from && !(TX_FLOW[from] || []).includes(to)) return { ok: false, code: 'TX_BAD_TRANSITION' };
  return { ok: true };
}

/* ---------- referral policies (no universal 30% — per-protocol, verified) ---------- */
export const REFERRAL_POLICIES = {
  'aftermath-perps': { '*': { rate: 10, basis: '10% of referee fees <$100M volume, 5% above (docs/perpetuals/referrals)', verified: '2026-09-30' } },
  'aftermath-router': { swap: { rate: 0, basis: 'hub keeps 97.5% of its own integrator fee; Aftermath retains 2.5% (docs/router fees)', verified: '2026-09-30' } },
  cetus: { '*': { rate: 0, basis: 'partner program closed to new teams (partner-swap docs)', verified: '2026-09-30' } },
  'deepbook-predict': { '*': { rate: 0, basis: 'builder-code split only when a builder code is registered; no separate trader debit', verified: '2026-10-02' } },
  deepbook: { '*': { rate: 0, basis: 'no DeepBook integrator revenue share verified', verified: '2026-10-02' } },
};
export function referralPolicyFor(protocolId, action = '*') {
  const p = REFERRAL_POLICIES[protocolId];
  if (p && (p[action] || p['*'])) return { protocolId, action, ...(p[action] || p['*']) };
  return { protocolId, action, rate: 0, basis: 'partner terms UNVERIFIED — no invented revenue', verified: null };
}
export function referralReward(eligiblePlatformFee, protocolId = null, action = '*', defaultRate = 30) {
  const policy = protocolId ? referralPolicyFor(protocolId, action) : null;
  const rate = policy ? policy.rate : defaultRate;
  const base = Math.max(0, Number(eligiblePlatformFee) || 0);
  const reward = Math.round(base * (rate / 100) * 1e6) / 1e6;
  return { reward, retained: Math.round((base - reward) * 1e6) / 1e6, rate, policy };
}

/* ---------- automation NL parse + validation ---------- */
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
