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

/* ---------- revenue wallet (PUBLIC address — settlement/verification layer only) ----------
 * This address may live in server-side config and be shown to users.
 * It is NEVER a private key / seed / mnemonic — signing stays in the user's
 * wallet (non-custodial) or in a dedicated server signer (stage 2, not here). */
export const NOISE_HUB_REVENUE_WALLET = '0xa29a8f72981c5644c348a51cd4aded6dbb47ad4361f7a825e19d377e9c4373a1';
export function revenueWalletAddress() { return NOISE_HUB_REVENUE_WALLET; }

/* ---------- decimal-safe accounting (BigInt, smallest units — no float money) ---------- */
export function toMinorUnits(amountStr, decimals = 6) {
  const s = String(amountStr ?? '0').trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw Object.assign(new Error('INVALID_AMOUNT'), { code: 'INVALID_AMOUNT' });
  const neg = s.startsWith('-');
  const [w, f = ''] = s.replace('-', '').split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  const v = BigInt(w === '' ? '0' : w) * (10n ** BigInt(decimals)) + BigInt(frac === '' ? '0' : frac);
  return neg ? (-v).toString() : v.toString();
}
export function fromMinorUnits(minorStr, decimals = 6) {
  const neg = String(minorStr).startsWith('-');
  const v = BigInt(String(minorStr).replace('-', ''));
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = String(v % base).padStart(decimals, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}
/** Split eligible revenue (minor units, string) by rate bps → { rewardMinor, retainedMinor }. */
export function splitRevenueMinor(eligibleMinorStr, rateBps) {
  const eligible = BigInt(eligibleMinorStr);
  const rate = BigInt(Math.max(0, Math.min(10000, Number(rateBps) || 0)));
  const reward = (eligible * rate) / 10000n;
  return { rewardMinor: reward.toString(), retainedMinor: (eligible - reward).toString() };
}
/** Aggregate guard: SUM(REAL) can return 8.700000000000001 — round to 6dp. */
export function moneyStr(v) {
  const n = Number(v) || 0;
  return String(Math.round(n * 1e6) / 1e6);
}
/** Decimal-string split (display convenience — exact to 6dp, never float). */
export function splitRevenue(eligibleStr, ratePercent) {
  const bps = Math.round(Number(ratePercent || 0) * 100);
  const minor = toMinorUnits(eligibleStr, 6);
  const { rewardMinor, retainedMinor } = splitRevenueMinor(minor, bps);
  return { reward: fromMinorUnits(rewardMinor, 6), retained: fromMinorUnits(retainedMinor, 6) };
}

/* ---------- privacy: short wallet only, never full address in leaderboards ---------- */
export function truncateWallet(addr) {
  if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]+$/.test(addr)) return '—';
  const h = addr.slice(2);
  if (h.length < 8) return addr;
  return `0x${h.slice(0, 4)}...${h.slice(-4)}`;
}

/* ---------- leaderboard: deterministic ordering (one implementation, both stacks) ----------
 * Primary: earned DESC → eligible DESC → active DESC → wallet ASC. */
export function compareLeaderboardRows(a, b) {
  const num = (v) => Number(v) || 0;
  if (num(b.earned) !== num(a.earned)) return num(b.earned) - num(a.earned);
  if (num(b.eligibleRevenue) !== num(a.eligibleRevenue)) return num(b.eligibleRevenue) - num(a.eligibleRevenue);
  if ((b.activeReferrals || 0) !== (a.activeReferrals || 0)) return (b.activeReferrals || 0) - (a.activeReferrals || 0);
  return String(a.wallet || '').localeCompare(String(b.wallet || ''));
}
export function assignRanks(rows) {
  return [...rows].sort(compareLeaderboardRows).map((r, i) => ({ ...r, rank: i + 1 }));
}
export const LEADERBOARD_PERIODS = ['week', 'month', 'all'];
export const LEADERBOARD_METRICS = ['earned', 'revenue', 'active'];
/** Metric modes reorder the primary key; tie-breaks stay deterministic. */
export function compareLeaderboardRowsRevenue(a, b) {
  const num = (v) => Number(v) || 0;
  if (num(b.eligibleRevenue) !== num(a.eligibleRevenue)) return num(b.eligibleRevenue) - num(a.eligibleRevenue);
  if (num(b.earned) !== num(a.earned)) return num(b.earned) - num(a.earned);
  if ((b.activeReferrals || 0) !== (a.activeReferrals || 0)) return (b.activeReferrals || 0) - (a.activeReferrals || 0);
  return String(a.wallet || '').localeCompare(String(b.wallet || ''));
}
export function compareLeaderboardRowsActive(a, b) {
  if ((b.activeReferrals || 0) !== (a.activeReferrals || 0)) return (b.activeReferrals || 0) - (a.activeReferrals || 0);
  const num = (v) => Number(v) || 0;
  if (num(b.earned) !== num(a.earned)) return num(b.earned) - num(a.earned);
  if (num(b.eligibleRevenue) !== num(a.eligibleRevenue)) return num(b.eligibleRevenue) - num(a.eligibleRevenue);
  return String(a.wallet || '').localeCompare(String(b.wallet || ''));
}
export function leaderboardComparator(metric) {
  if (metric === 'revenue') return compareLeaderboardRowsRevenue;
  if (metric === 'active') return compareLeaderboardRowsActive;
  return compareLeaderboardRows;
}

/* ---------- reconciliation: DB expected vs wallet observed (pure, testable) ---------- */
export function reconcileRevenue({ expectedIn, paidOut, observed, tolerance = 0.01 } = {}) {
  const exp = Number(expectedIn) || 0;
  const paid = Number(paidOut) || 0;
  const expected = Math.round((exp - paid) * 1e6) / 1e6;
  if (observed === null || observed === undefined || observed === '') {
    return { expected: String(expected), received: null, difference: null, status: 'PENDING', coverage: 'observed-unavailable' };
  }
  const rec = Number(observed) || 0;
  const diff = Math.round((rec - expected) * 1e6) / 1e6;
  return {
    expected: String(expected),
    received: String(rec),
    difference: String(diff),
    status: Math.abs(diff) <= Number(tolerance) ? 'MATCHED' : 'MISMATCH',
    coverage: 'partial-scan',
  };
}
export function periodCutoffIso(period, nowMs = Date.now()) {
  if (period === 'week') return new Date(nowMs - 7 * 864e5).toISOString();
  if (period === 'month') return new Date(nowMs - 30 * 864e5).toISOString();
  return null; // 'all'
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
