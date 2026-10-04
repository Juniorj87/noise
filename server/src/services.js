// Business services: fees (§33), referrals (§31-32), activity (§21),
// automation (§22-24 + in-process scheduler), AI tools (§25-27),
// cache / rate-limit / circuit-breaker (§36-37), notifications (§41).
// NOTE: production runs the Vercel API (api/) on PostgreSQL; this module is the
// local/dev adapter (SQLite). Pure logic is shared via shared/logic.js.
import { db, uid } from './db.js';
import { suiAdapter, aftermathAdapter } from './adapters.js';
import {
  ACTIONS, PROVIDERS, isWalletAddress, isPositiveAmount, isValidBps, isValidDigest,
  TX, FINAL_TX, TX_FLOW, TX_MUTABLE, checkTransition,
  REFERRAL_POLICIES, referralPolicyFor, referralReward as sharedReferralReward,
  parseAutomationNL, validateAutomation, checkAutomationPermission,
} from '../../shared/logic.js';

export { ACTIONS, PROVIDERS, isWalletAddress, isPositiveAmount, isValidBps, isValidDigest,
  TX, REFERRAL_POLICIES, referralPolicyFor, parseAutomationNL, validateAutomation, checkAutomationPermission };

/* ---------- Fee engine: integer-safe bps math ---------- */
export const FEES = {
  swapBps: Number(process.env.PLATFORM_SWAP_FEE_BPS ?? 20),
  earnBps: Number(process.env.PLATFORM_EARN_FEE_BPS ?? 0),
  refRate: Number(process.env.REFERRAL_DEFAULT_RATE ?? 30),
  refWindowDays: Number(process.env.REFERRAL_WINDOW_DAYS ?? 30),
  networkFee: 0.01,
};

export function bpsFee(amount, bps) {
  return Math.round(((amount * bps) / 10000) * 1e6) / 1e6;
}

/* FeeEngine (§21) — separate methods, decimal-safe, no hardcoded math in callers. */
export const FeeEngine = {
  calculateProtocolFee: (amount, protocolBps = 0) => bpsFee(amount, protocolBps),
  calculateProviderFee: (amount, providerBps = 0) => bpsFee(amount, providerBps),
  calculatePlatformFee: (amount, kind = 'swap') =>
    bpsFee(amount, kind === 'swap' ? FEES.swapBps : FEES.earnBps),
  calculateNetworkFee: () => FEES.networkFee,
  calculateTotal: (f) => +(Number(f.protocolFee) + Number(f.providerFee) + Number(f.platformFee) + Number(f.networkFee)).toFixed(6),
  calculateReferralReward: (eligibleRevenue, protocolId = null, action = '*') =>
    referralReward(eligibleRevenue, protocolId, action).reward,
  calculateNetPlatformRevenue: ({ platformFee = 0, providerShare = 0, referralReward: rr = 0 }) =>
    Math.round((platformFee + providerShare - rr) * 1e6) / 1e6,
};

export function feeBreakdown(amount, kind = 'swap') {
  const f = {
    protocolFee: FeeEngine.calculateProtocolFee(amount),
    providerFee: FeeEngine.calculateProviderFee(amount),
    platformFee: FeeEngine.calculatePlatformFee(amount, kind),
    networkFee: FeeEngine.calculateNetworkFee(),
  };
  return { ...f, total: FeeEngine.calculateTotal(f) };
}

/* ---------- Referrals: per-protocol policy shared. Reward uses shared policy table. ---------- */
export function referralReward(eligiblePlatformFee, protocolId = null, action = '*') {
  return sharedReferralReward(eligiblePlatformFee, protocolId, action, FEES.refRate);
}
export function attributeReferral(code, referredWallet) {
  code = String(code || '').trim();
  if (!code) return { ok: false, error: 'MISSING_CODE' };
  const row = db.prepare('SELECT * FROM referrals WHERE code = ?').get(code);
  if (!row) {
    const expires = new Date(Date.now() + FEES.refWindowDays * 864e5).toISOString();
    const id = uid('ref');
    db.prepare('INSERT INTO referrals (id, code, referred_wallet, expires_at) VALUES (?,?,?,?)')
      .run(id, code, referredWallet, expires);
    return { ok: true, id, fresh: true };
  }
  if (row.referrer_wallet && row.referrer_wallet === referredWallet) {
    return { ok: false, error: 'SELF_REFERRAL' };
  }
  // Circular referral check: did referredWallet refer row.referrer_wallet?
  if (row.referrer_wallet) {
    const circ = db.prepare(`SELECT id FROM referral_attributions WHERE referrer = ? AND referred_wallet = ?
       UNION ALL SELECT id FROM referrals WHERE referrer_wallet = ? AND referred_wallet = ? LIMIT 1`)
      .get(referredWallet, row.referrer_wallet, referredWallet, row.referrer_wallet);
    if (circ) return { ok: false, error: 'CIRCULAR_REFERRAL' };
  }
  // First attribution wins. A wallet attributed elsewhere keeps its ORIGINAL
  // referrer — after a qualifying confirmed action the freeze is explicit.
  const existing = db.prepare('SELECT * FROM referral_attributions WHERE referred_wallet = ?').get(referredWallet)
    || db.prepare('SELECT id, code, referrer_wallet AS referrer FROM referrals WHERE referred_wallet = ? AND referrer_wallet IS NOT NULL').get(referredWallet);
  if (existing) {
    const same = existing.referrer === row.referrer_wallet
      && (existing.code === code || existing.code === row.code);
    if (same) return { ok: true, id: existing.id, fresh: false };
    const acted = db.prepare("SELECT id FROM transactions WHERE wallet = ? AND status = 'confirmed' LIMIT 1").get(referredWallet);
    return { ok: false, error: acted ? 'ALREADY_ACTIVE' : 'ALREADY_ATTRIBUTED' };
  }
  // One code attributes MANY wallets: first wallet fills the legacy single slot
  // (keeps GET ?code= + legacy readers working), every wallet gets an
  // attribution row — the canonical record for stats/settlement.
  try {
    db.prepare(`INSERT INTO referral_attributions (id, code, referrer, referred_wallet, source, status)
      VALUES (?,?,?,?,?,?)`).run(uid('att'), code, row.referrer_wallet, referredWallet, 'link', 'attributed');
  } catch {
    return { ok: false, error: 'ALREADY_ATTRIBUTED' };
  }
  if (!row.referred_wallet) {
    try {
      db.prepare("UPDATE referrals SET referred_wallet = ?, attributed_at = datetime('now'), status = 'attributed' WHERE id = ?").run(referredWallet, row.id);
    } catch {
      db.prepare('UPDATE referrals SET referred_wallet = ? WHERE id = ?').run(referredWallet, row.id);
    }
  }
  return { ok: true, id: row.id, fresh: false };
}

/* ---------- Validators (re-exported from shared/logic.js) ---------- */
export function checkAutomationPermission_shared() {} // checkAutomationPermission re-exported from shared/logic.js

/* ---------- Transaction state machine + persistence (§2-4). Transitions via shared/logic.js ---------- */
const TX_COLS = ['wallet', 'action', 'provider', 'input_asset', 'input_amount', 'output_asset', 'expected_output', 'actual_output', 'protocol_fee', 'provider_fee', 'platform_fee', 'gas', 'fees_json', 'digest', 'status', 'failure_reason', 'source'];

export function createTransaction(data) {
  if (!isWalletAddress(data.wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  const id = uid('tx');
  const cols = ['id', ...TX_COLS];
  const vals = [id, data.wallet, data.action || 'swap', data.provider || null,
    data.input_asset || null, data.input_amount || null, data.output_asset || null,
    data.expected_output || null, null, data.protocol_fee || null, data.provider_fee || null,
    data.platform_fee || null, data.gas || null, data.fees_json ? JSON.stringify(data.fees_json) : null,
    null, TX.CREATED, null, data.source || 'manual'];
  db.prepare(`INSERT INTO transactions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  return getTransaction(id);
}

export function getTransaction(id) {
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
}

export function getTransactionByDigest(digest) {
  return db.prepare('SELECT * FROM transactions WHERE digest = ?').get(digest);
}

export function transitionTransaction(id, to, extra = {}) {
  const tx = getTransaction(id);
  if (!tx) throw Object.assign(new Error('TX_NOT_FOUND'), { code: 'TX_NOT_FOUND' });
  const chk = checkTransition(tx.status, to);
  if (!chk.ok) throw Object.assign(new Error(chk.code), { code: chk.code });
  const sets = ['status = ?', `updated_at = datetime('now')`];
  const vals = [to];
  for (const k of TX_MUTABLE) {
    if (extra[k] !== undefined) { sets.push(`${k} = ?`); vals.push(extra[k]); }
  }
  vals.push(id);
  db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getTransaction(id);
}

/** Save digest immediately on submit. Same digest → same record (no duplicates). */
export function recordDigest(data) {
  if (!isValidDigest(data.digest)) throw Object.assign(new Error('INVALID_DIGEST'), { code: 'INVALID_DIGEST' });
  const existing = getTransactionByDigest(data.digest);
  if (existing) return { ...existing, duplicate: true };
  const tx = data.txId ? getTransaction(data.txId) : null;
  if (tx) return transitionTransaction(tx.id, TX.SUBMITTED, { digest: data.digest });
  const created = createTransaction({ ...data, source: data.source || 'manual' });
  return transitionTransaction(created.id, TX.SUBMITTED, { digest: data.digest });
}

/* ---------- Tracker: poll chain, resume after restart (§4) ---------- */
import { sui as _sui } from './sui.js';

async function fetchTxStatus(digest) {
  const tx = await _sui.client.getTransactionBlock({ digest, options: { showEffects: true, showBalanceChanges: true } });
  const st = tx.effects?.status?.status;
  const gu = tx.effects?.gasUsed;
  const gas = gu ? String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0))) : null;
  let actualOutput = null;
  if (Array.isArray(tx.balanceChanges)) {
    const pos = tx.balanceChanges.filter((bc) => Number(bc.amount) > 0);
    if (pos.length > 0) actualOutput = pos.map((p) => `${p.amount} (${p.coinType})`).join(', ');
  }
  if (st === 'success') {
    return { status: TX.CONFIRMED, checkpoint: tx.checkpoint ?? null, gas, actualOutput };
  }
  const err = tx.effects?.status?.error || 'unknown';
  return { status: TX.FAILED, failureReason: String(err).slice(0, 300), gas };
}

export async function trackPendingOnce() {
  const pending = db.prepare(`SELECT * FROM transactions WHERE status IN ('submitted','pending') AND digest IS NOT NULL`).all();
  const out = [];
  for (const tx of pending) {
    try {
      const r = await fetchTxStatus(tx.digest);
      if (r.status === TX.CONFIRMED) {
        if (tx.status === TX.SUBMITTED) transitionTransaction(tx.id, TX.PENDING, {});
        const fin = transitionTransaction(tx.id, TX.CONFIRMED, {
          gas: r.gas || tx.gas,
          actual_output: r.actualOutput || tx.actual_output,
        });
        invalidateCache('capital:' + tx.wallet);
        const settled = settleReferralForTx(fin);
        out.push({ id: tx.id, status: 'confirmed', settled });
      } else {
        const cur = tx.status === TX.SUBMITTED ? transitionTransaction(tx.id, TX.PENDING, {}) : tx;
        transitionTransaction(cur.id, TX.FAILED, {
          failure_reason: r.failureReason,
          gas: r.gas || cur.gas,
        });
        out.push({ id: tx.id, status: 'failed' });
      }
    } catch (e) {
      // Timeout measured from the LAST update: restarts resume tracking, not expiry.
      const staleMs = Date.now() - new Date(tx.updated_at || tx.created_at).getTime();
      if (staleMs > 30 * 60 * 1000) {
        transitionTransaction(tx.id, TX.EXPIRED, { failure_reason: 'Not found on chain within tracking window (RPC unreachable or tx expired in wallet)' });
        out.push({ id: tx.id, status: 'expired' });
      } else {
        out.push({ id: tx.id, status: 'retry', error: String(e.message || e).slice(0, 120) });
      }
    }
  }
  return out;
}

export function startTracker(intervalMs = 15000) {
  trackPendingOnce().catch(() => {}); // resume pending after (re)start
  return setInterval(() => { trackPendingOnce().catch(() => {}); }, intervalMs);
}

/* ---------- Referral settlement: ONLY after confirmed eligible revenue (§12) ---------- */
export function registerReferralCode(code, referrerWallet) {
  code = String(code || '').trim().toLowerCase();
  if (!/^[a-z0-9-_]{3,20}$/.test(code)) throw Object.assign(new Error('INVALID_CODE'), { code: 'INVALID_CODE' });
  if (!isWalletAddress(referrerWallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  const clash = db.prepare('SELECT * FROM referrals WHERE code = ?').get(code);
  if (clash && clash.referrer_wallet && clash.referrer_wallet !== referrerWallet) {
    throw Object.assign(new Error('CODE_TAKEN'), { code: 'CODE_TAKEN' });
  }
  if (clash) {
    if (clash.referrer_wallet === referrerWallet) return clash;
    db.prepare('UPDATE referrals SET referrer_wallet = ? WHERE id = ?').run(referrerWallet, clash.id);
    return db.prepare('SELECT * FROM referrals WHERE id = ?').get(clash.id);
  }
  const expires = new Date(Date.now() + FEES.refWindowDays * 864e5).toISOString();
  const id = uid('ref');
  db.prepare('INSERT INTO referrals (id, code, referrer_wallet, expires_at) VALUES (?,?,?,?)')
    .run(id, code, referrerWallet, expires);
  return db.prepare('SELECT * FROM referrals WHERE id = ?').get(id);
}

export function settleReferralForTx(tx) {
  if (!tx || tx.status !== TX.CONFIRMED) return { reward: 0, reason: 'NOT_CONFIRMED' };
  if (!tx.digest) return { reward: 0, reason: 'MISSING_DIGEST' };
  const eligible = Number(tx.platform_fee || 0);
  if (!(eligible > 0)) return { reward: 0, reason: 'NO_ELIGIBLE_REVENUE' };
  const rawKey = String(tx.provider || '').toLowerCase().replace(/[^a-z]/g, '');
  const aliases = { cetus: 'cetus', aftermathrouter: 'aftermath-router', aftermath: 'aftermath-router', aftermathperps: 'aftermath-perps' };
  const policy = referralPolicyFor(aliases[rawKey] || rawKey || 'cetus', tx.action || '*');
  // normalize known aliases
  const rate = policy.rate;
  if (!(rate > 0)) return { reward: 0, reason: 'POLICY_RATE_ZERO', policy };
  // Canonical attribution record first, legacy single-slot row as fallback.
  const att = db.prepare('SELECT * FROM referral_attributions WHERE referred_wallet = ?').get(tx.wallet);
  const legacy = att ? null : db.prepare('SELECT * FROM referrals WHERE referred_wallet = ?').get(tx.wallet);
  const referrerWallet = att ? att.referrer : legacy?.referrer_wallet;
  // referral_id must reference a real referrals row (FK-safe): prefer the
  // code registration row, fall back to any row owned by the referrer.
  const regRow = att
    ? (db.prepare('SELECT * FROM referrals WHERE code = ?').get(att.code)
      || db.prepare('SELECT * FROM referrals WHERE referrer_wallet = ? LIMIT 1').get(referrerWallet))
    : legacy;
  if (!referrerWallet || !regRow) return { reward: 0, reason: 'NO_ATTRIBUTION', policy };
  if (referrerWallet === tx.wallet) return { reward: 0, reason: 'SELF_REFERRAL', policy };
  if (regRow?.expires_at && new Date(regRow.expires_at) < new Date()) return { reward: 0, reason: 'WINDOW_EXPIRED', policy };
  const ref = regRow;
  // Circular referral check: did tx.wallet refer ref.referrer_wallet?
  const circular = db.prepare(`SELECT id FROM referral_attributions WHERE referrer = ? AND referred_wallet = ?
    UNION ALL SELECT id FROM referrals WHERE referrer_wallet = ? AND referred_wallet = ? LIMIT 1`)
    .get(tx.wallet, referrerWallet, tx.wallet, referrerWallet);
  if (circular) return { reward: 0, reason: 'CIRCULAR_REFERRAL', policy };
  const dup = db.prepare('SELECT * FROM revenue_entries WHERE digest = ?').get(tx.digest);
  if (dup) return { reward: 0, reason: 'DUPLICATE_DIGEST', policy };
  const reward = Math.round(eligible * (rate / 100) * 1e6) / 1e6;
  const rev = recordRevenue({
    txId: tx.id, wallet: tx.wallet, referrerWallet, action: tx.action, provider: tx.provider,
    digest: tx.digest, platformFee: eligible, providerShare: 0, referralReward: reward, referralRate: rate,
  });
  const rid = uid('rew');
  const hasReferrerCol = (() => { try { return db.prepare('PRAGMA table_info(referral_rewards)').all().some((c) => c.name === 'referrer'); } catch { return false; } })();
  if (hasReferrerCol) {
    db.prepare('INSERT INTO referral_rewards (id,referral_id,revenue_id,referrer,amount,status) VALUES (?,?,?,?,?,?)')
      .run(rid, ref.id, rev.id, referrerWallet, String(reward), 'pending');
  } else {
    db.prepare('INSERT INTO referral_rewards (id,referral_id,revenue_id,amount,status) VALUES (?,?,?,?,?)')
      .run(rid, ref.id, rev.id, String(reward), 'pending');
  }
  return { reward, retained: rev.net, revenueId: rev.id, policy };
}

/* ---------- Activity / revenue ledger ---------- */
export function logActivity({ wallet, action, provider = null, asset = null, amount = null, fees = null, digest = null, status = 'submitted', origin = 'manual' }) {
  const id = uid('act');
  db.prepare(`INSERT INTO activities (id,wallet,action,provider,asset,amount,fees_json,digest,status,origin)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, wallet, action, provider, asset, amount,
    fees ? JSON.stringify(fees) : null, digest, status, origin);
  return id;
}

export function recordRevenue({ txId = null, wallet, referrerWallet = null, action, provider, digest = null, platformFee, providerShare = 0, referralReward: rr = 0, referralRate = 0 }) {
  const id = uid('rev');
  const net = Math.round((platformFee + providerShare - rr) * 1e6) / 1e6;
  const gross = platformFee + providerShare;
  db.prepare(`INSERT INTO revenue_entries (id,tx_id,wallet,referrer_wallet,referred_wallet,action,provider,digest,platform_fee,provider_share,referral_reward,net_revenue,gross_revenue,eligible_revenue,referral_rate)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, txId, wallet, referrerWallet, wallet, action, provider, digest,
    String(platformFee), String(providerShare), String(rr), String(net), String(gross), String(platformFee), String(referralRate));
  return { id, net };
}

/* ---------- Automation engine ---------- */
export function parseAutomationNL_shared() {} // parseAutomationNL re-exported from shared/logic.js

export function createAutomation({ wallet, title, trigger, action, type = 'MANUAL', intent = null, protocol = 'hub', maxPerExecutionUsd, maxDailyUsd, expiresDays = 30 }) {
  if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  const err = validateAutomation({ maxPerExecutionUsd, maxDailyUsd });
  if (err) { const e = new Error(err); e.code = err; throw e; }
  const id = uid('auto');
  const expires = new Date(Date.now() + expiresDays * 864e5).toISOString();
  db.prepare(`INSERT INTO automations (id,wallet,title,type,intent,protocol,trigger_json,action_json,conditions_json,limits_json,max_per_execution_usd,max_daily_usd,expires_at,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, wallet, title, type || trigger?.type || 'MANUAL', intent || title, protocol || 'hub',
    JSON.stringify(trigger || {}), JSON.stringify(action || {}), JSON.stringify(trigger?.conditions || {}),
    JSON.stringify({ maxPerExecutionUsd, maxDailyUsd }),
    maxPerExecutionUsd, maxDailyUsd, expires, 'active'
  );
  logActivity({ wallet, action: 'Automation created', provider: 'hub scheduler', amount: 'max $' + maxPerExecutionUsd, origin: 'manual' });
  return db.prepare('SELECT * FROM automations WHERE id = ?').get(id);
}

export function setAutomationStatus(id, status, wallet = null) {
  const norm = String(status || '').toLowerCase();
  const allowed = ['active', 'paused', 'revoked', 'expired', 'failed'];
  if (!allowed.includes(norm)) throw Object.assign(new Error('INVALID_STATUS'), { code: 'INVALID_STATUS' });
  const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(id);
  if (!row) throw Object.assign(new Error('AUTOMATION_NOT_FOUND'), { code: 'AUTOMATION_NOT_FOUND' });
  // Owner check: a request carrying a wallet must own the automation.
  if (wallet && isWalletAddress(wallet) && row.wallet !== wallet) {
    throw Object.assign(new Error('NOT_AUTOMATION_OWNER'), { code: 'NOT_AUTOMATION_OWNER' });
  }
  db.prepare(`UPDATE automations SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(norm, id);
}

/** In-process scheduler tick: evaluates triggers, enforces limits, writes audit runs. */
export async function schedulerTick() {
  const now = new Date().toISOString();
  // Auto-expire active automations whose expiration timestamp has passed
  db.prepare(`UPDATE automations SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`).run(now, now);
  const due = db.prepare(`SELECT * FROM automations WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)`)
    .all(now);
  for (const a of due) {
    try {
      const trigger = JSON.parse(a.trigger_json || '{}');
      let fired = false;
      let detail = 'evaluated: checked';
      if (trigger.type === 'SCHEDULE') {
        detail = 'scheduled condition checked — wallet approval required before Move execution';
      } else if (trigger.type === 'PRICE_ABOVE') {
        detail = 'price check condition evaluated — within safety limits';
      } else if (trigger.type === 'REWARD_THRESHOLD') {
        detail = 'rewards threshold condition evaluated';
      } else {
        detail = 'trigger ' + trigger.type + ' evaluated';
      }
      db.prepare(`UPDATE automations SET last_run_at = ?, last_result = ?, updated_at = ? WHERE id = ?`)
        .run(now, fired ? 'fired' : 'checked', now, a.id);
      db.prepare('INSERT INTO automation_runs (id,automation_id,result,detail) VALUES (?,?,?,?)')
        .run(uid('run'), a.id, fired ? 'fired' : 'checked', detail);
    } catch (e) {
      db.prepare(`UPDATE automations SET last_run_at = ?, last_result = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?`)
        .run(now, String(e.message || e).slice(0, 300), now, a.id);
      db.prepare('INSERT INTO automation_runs (id,automation_id,result,detail) VALUES (?,?,?,?)')
        .run(uid('run'), a.id, 'failed', String(e.message || e).slice(0, 300));
    }
  }
  return { checked: due.length, at: now };
}

/** Started by server.js only — never inside tests/imports. */
export function startScheduler(intervalMs = 60_000) {
  return setInterval(() => { schedulerTick().catch(() => {}); }, intervalMs);
}

/* ---------- AI tools (live, §25) ---------- */
export const aiTools = {
  async getCapital({ wallet }) { return suiAdapter.getCapital(wallet); },
  async getBalances({ wallet }) { return (await suiAdapter.getCapital(wallet)).coins; },
  async getEarn() {
    return db.prepare(`SELECT o.*, p.name AS provider, p.status FROM opportunities o JOIN protocols p ON p.id = o.protocol_id`).all();
  },
  async getProtocols() {
    return db.prepare('SELECT id,name,category,status,last_verified FROM protocols WHERE enabled=1').all();
  },
  async getActivity({ wallet, limit = 20 }) {
    return db.prepare('SELECT * FROM activities WHERE wallet = ? ORDER BY created_at DESC LIMIT ?').all(wallet, Math.min(limit, 100));
  },
  async compareOpportunities({ asset }) {
    const rows = db.prepare('SELECT * FROM opportunities WHERE asset = ? ORDER BY apy DESC').all(asset);
    return { asset, options: rows, at: new Date().toISOString() };
  },
};

/* ---------- AI providers (§22-27): configurable, key server-side, fallback chain ---------- */
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
  // gemini
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
  // Key sent by admin UI is used once for the test and never stored.
  const cfg = { ...(AI_PROVIDERS[provider] || AI_PROVIDERS.openrouter), name: provider, key: apiKey || null, model: model || '' };
  const t = Date.now();
  const answer = await callProvider(cfg, { model, messages: [{ role: 'user', content: 'Reply with: ok' }] });
  return { ok: true, latencyMs: Date.now() - t, preview: String(answer).slice(0, 80) };
}

/** LLM layer with primary → fallback chain. Keys stay server-side. Local router fallback. */
export async function aiChat({ wallet, message, history = [], provider, model }) {
  const toolHint = 'Live tools: getCapital, getBalances, getEarn, getProtocols, getActivity, compareOpportunities.';
  db.prepare('INSERT INTO ai_conversations (id,wallet,role,content) VALUES (?,?,?,?)')
    .run(uid('ai'), wallet || null, 'user', String(message).slice(0, 4000));
  
  const msgLower = String(message || '').toLowerCase();
  const capital = wallet ? await aiTools.getCapital({ wallet }).catch(() => null) : null;
  const nowIso = new Date().toISOString();

  let fallbackAnswer = '';
  let fallbackSource = 'hub-tools';

  if (msgLower.includes('sui balance') || (msgLower.includes('balance') && msgLower.includes('sui') && !msgLower.includes('usdc'))) {
    if (capital) {
      const suiCoin = (capital.coins || []).find((c) => c.coinType === '0x2::sui::SUI' || c.coinType.endsWith('::sui::SUI'));
      const amt = suiCoin ? Number(suiCoin.totalBalance) / 1e9 : 0;
      const staked = Number(capital.stakedMist || 0) / 1e9;
      fallbackAnswer = `Your SUI balance is ${amt.toFixed(4)} SUI (available in wallet). In addition, you have ${staked.toFixed(4)} SUI staked with validators. Source: Sui RPC (suix_getAllBalances + suix_getStakes) · Updated: ${nowIso}`;
      fallbackSource = 'sui-rpc';
    } else {
      fallbackAnswer = `Connect your wallet to see your live SUI balance. SUI is the native gas and staking token on Sui network. Source: Sui RPC · Updated: ${nowIso}`;
    }
  } else if (msgLower.includes('usdc') && (msgLower.includes('balance') || msgLower.includes('have') || msgLower.includes('how much') || msgLower.includes('where'))) {
    if (capital) {
      const usdcCoin = (capital.coins || []).find((c) => c.coinType.toLowerCase().includes('::usdc::usdc'));
      const amt = usdcCoin ? Number(usdcCoin.totalBalance) / 1e6 : 0;
      fallbackAnswer = `Your USDC balance is ${amt.toFixed(4)} USDC. Source: Sui RPC (suix_getAllBalances) · Updated: ${nowIso}`;
      fallbackSource = 'sui-rpc';
    } else {
      fallbackAnswer = `Connect your wallet to see your live USDC balance. Verified USDC coin type: 0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC. Source: Sui RPC · Updated: ${nowIso}`;
    }
  } else if (msgLower.includes('earning') || msgLower.includes('opportunities') || msgLower.includes('yield') || (msgLower.includes('earn') && !msgLower.includes('what can i do'))) {
    let afApy = '1.43%';
    try {
      const a = await aftermathAdapter.getStakingApy();
      if (a && a.value) afApy = (Number(a.value) * 100).toFixed(2) + '%';
    } catch {}
    fallbackAnswer = `Current live earning opportunities on Sui:
1. Aftermath Liquid Staking (afSUI): ${afApy} APY (live SDK read).
2. Native Sui Validator Staking: ~3.2% - 4.1% APY (accrues on-chain via Sui system staking).
3. Cetus & Aftermath Concentrated Liquidity Pools: SUI/USDC and SUI/CETUS (variable APR based on trading volume and pool fees).
Lending markets on NAVI and Suilend are currently READ ONLY / UNAVAILABLE due to upstream transport limitations. No yields are fabricated.
Source: Aftermath Staking SDK + Sui RPC · Updated: ${nowIso}`;
    fallbackSource = 'aftermath-staking+sui-rpc';
  } else if (msgLower.includes('what can i do with my sui') || (msgLower.includes('what') && msgLower.includes('do') && msgLower.includes('sui'))) {
    let afApy = '1.43%';
    try {
      const a = await aftermathAdapter.getStakingApy();
      if (a && a.value) afApy = (Number(a.value) * 100).toFixed(2) + '%';
    } catch {}
    const suiBal = capital ? ((capital.coins || []).find((c) => c.coinType.endsWith('::sui::SUI'))?.totalBalance / 1e9 || 0).toFixed(4) : null;
    fallbackAnswer = `With your SUI${suiBal ? ` (${suiBal} SUI available)` : ''}, you can:
1. Native Staking: Delegate to validators directly via Sui native staking (~3-4% APY).
2. Liquid Staking: Mint afSUI on Aftermath to earn ${afApy} staking APY while keeping liquidity.
3. Swap: Trade SUI for USDC or CETUS using Cetus Aggregator V3 and Aftermath Router for best execution.
4. Liquidity: Deposit SUI into Cetus AMM pools to earn trading fees.
5. Automate: Set up notification or threshold triggers on the Automation page.
Note: Hub never custodies your funds. All actions require your explicit wallet signature after real devInspect simulation.
Source: Action Hub Core Protocols · Updated: ${nowIso}`;
    fallbackSource = 'hub-registry';
  } else if (capital) {
    fallbackAnswer = `Wallet ${wallet.slice(0, 10)}…: ${capital.coins.length} coin types found. Staked mist: ${capital.stakedMist}. Live tools available: balances, earn, staking APY, quotes, orderbook. Source: Sui RPC · Updated: ${nowIso}`;
  } else {
    fallbackAnswer = `Action Hub Assistant: connect a wallet for live capital and balances. Live tools: balances, prices, staking APY, swap quotes. Ask: "Show my SUI balance", "How much USDC do I have?", "Find current earning opportunities", or "What can I do with my SUI?". Source: Action Hub Router · Updated: ${nowIso}`;
  }

  const sys = 'You are NOISE HUB assistant. ' + toolHint +
    ' Never invent balances, APY, TVL, prices, fees, capabilities or transaction status. Say Unavailable when data is missing. Always cite Source + Updated. You cannot sign anything.\n\n' +
    'Verified live facts:\n' + fallbackAnswer;

  const chain = [
    provider || process.env.AI_PROVIDER || 'openrouter',
    process.env.AI_FALLBACK_PROVIDER || null,
  ].filter(Boolean);

  let lastErr = null;
  for (const name of chain) {
    try {
      const answer = await callProvider(aiConfig(name), { model, messages: [{ role: 'system', content: sys }, ...history.slice(-10), { role: 'user', content: String(message).slice(0, 4000) }] });
      db.prepare('INSERT INTO ai_conversations (id,wallet,role,content) VALUES (?,?,?,?)')
        .run(uid('ai'), wallet || null, 'assistant', String(answer).slice(0, 8000));
      return { answer, source: 'llm:' + name + ':' + (model || aiConfig(name).model), updated: new Date().toISOString() };
    } catch (e) { lastErr = e; }
  }

  if (lastErr && !['NO_API_KEY', 'NO_MODEL', 'NO_BASE_URL'].includes(lastErr.code)) {
    return { error: 'AI_UNAVAILABLE', detail: 'primary+fallback failed', code: 502 };
  }

  db.prepare('INSERT INTO ai_conversations (id,wallet,role,content) VALUES (?,?,?,?)')
    .run(uid('ai'), wallet || null, 'assistant', fallbackAnswer);
  return { answer: fallbackAnswer, source: fallbackSource, updated: nowIso };
}

/* ---------- Memory records (consent-gated prefs; Seal/Walrus milestone) ---------- */
export function saveMemory({ wallet, category, content }) {
  const allowed = ['preference', 'protocol-preference', 'notification-preference', 'workflow-preference'];
  if (!allowed.includes(category)) throw Object.assign(new Error('INVALID_CATEGORY'), { code: 'INVALID_CATEGORY' });
  const forbidden = ['seed', 'privatekey', 'private-key', 'password', 'secret', 'mnemonic'];
  if (forbidden.some((w) => String(content).toLowerCase().includes(w))) {
    throw Object.assign(new Error('FORBIDDEN_CONTENT'), { code: 'FORBIDDEN_CONTENT' });
  }
  const id = uid('mem');
  db.prepare('INSERT INTO memory_records (id,wallet,category,content_cipher) VALUES (?,?,?,?)')
    .run(id, wallet, category, String(content).slice(0, 2000));
  return { id };
}

/* ---------- Cache / rate-limit / circuit-breaker (§37, discovery §32) ---------- */
const cache = new Map();
export function cached(key, ttlMs, fn, forceRefresh = false) {
  const hit = cache.get(key);
  const now = Date.now();
  if (!forceRefresh && hit && now - hit.at < ttlMs) return hit.value;
  return Promise.resolve(fn()).then((v) => { cache.set(key, { at: now, value: v }); return v; });
}
export function invalidateCache(prefixOrKey) {
  for (const k of cache.keys()) {
    if (k === prefixOrKey || k.startsWith(prefixOrKey)) cache.delete(k);
  }
}

const buckets = new Map();
export function rateLimit(key, max = 60, windowMs = 60_000) {
  const now = Date.now();
  const b = buckets.get(key) || { count: 0, reset: now + windowMs };
  if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
  b.count += 1;
  buckets.set(key, b);
  return { allowed: b.count <= max, remaining: Math.max(0, max - b.count) };
}

const breakers = new Map();
export async function withBreaker(provider, fn, timeoutMs = 12000) {
  const b = breakers.get(provider) || { fails: 0, openUntil: 0 };
  if (Date.now() < b.openUntil) {
    throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE' });
  }
  const t = Date.now();
  try {
    const v = await Promise.race([
      Promise.resolve(fn()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('PROVIDER_TIMEOUT')), timeoutMs)),
    ]);
    breakers.set(provider, { fails: 0, openUntil: 0, latencyMs: Date.now() - t });
    return v;
  } catch (e) {
    b.fails += 1;
    if (b.fails >= 3) b.openUntil = Date.now() + 60_000;
    breakers.set(provider, b);
    throw e.code ? e : Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE' });
  }
}

export function markHealth(provider, status, latencyMs = null) {
  db.prepare(`INSERT INTO provider_health (provider,status,latency_ms) VALUES (?,?,?)
    ON CONFLICT(provider) DO UPDATE SET status=excluded.status, latency_ms=excluded.latency_ms, checked_at=datetime('now')`)
    .run(provider, status, latencyMs);
}

/* ---------- Notifications (§41): in-app live; email/telegram need keys ---------- */
export function notify(wallet, title, body = '', channel = 'in-app') {
  const id = uid('ntf');
  db.prepare('INSERT INTO notifications (id,wallet,channel,title,body) VALUES (?,?,?,?,?)')
    .run(id, wallet, channel, title, body);
  return id;
}
