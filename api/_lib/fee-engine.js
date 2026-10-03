// Action Hub Fee Engine — unified platform fee calculation and collection.
// Supports configurable fees per action, provider, instrument, and global defaults.
// Referral rewards are calculated from platform revenue, not as additional user fees.
//
// Fee priority: specific > provider > action > global
// Referral: split of platform revenue, not user debit

import { getPool, ensureSchema } from './pg.js';

/**
 * Validate a Sui wallet address format.
 */
function isValidSuiAddress(address) {
  return /^0x[a-fA-F0-9]{40,}$/.test(address);
}

/**
 * Get fee configuration from database or environment.
 * Returns: { enabled, bps, recipient, source }
 */
async function getFeeConfig(action = null, provider = null, instrument = null) {
  await ensureSchema();
  const pool = getPool();

  // Try specific config first (provider + action + instrument)
  if (provider && action && instrument) {
    const specific = await pool.query(
      'SELECT * FROM config WHERE key = $1',
      [`fee:${provider}:${action}:${instrument}`]
    );
    if (specific.rows.length > 0) {
      const cfg = JSON.parse(specific.rows[0].value);
      return { ...cfg, source: 'database-specific' };
    }
  }

  // Try provider-specific config
  if (provider) {
    const providerCfg = await pool.query(
      'SELECT * FROM config WHERE key = $1',
      [`fee:${provider}`]
    );
    if (providerCfg.rows.length > 0) {
      const cfg = JSON.parse(providerCfg.rows[0].value);
      return { ...cfg, source: 'database-provider' };
    }
  }

  // Try action-specific config
  if (action) {
    const actionCfg = await pool.query(
      'SELECT * FROM config WHERE key = $1',
      [`fee:${action}`]
    );
    if (actionCfg.rows.length > 0) {
      const cfg = JSON.parse(actionCfg.rows[0].value);
      return { ...cfg, source: 'database-action' };
    }
  }

  // Fall back to environment defaults (+ DB global overrides set via admin)
  const { getConfig } = await import('./pg.js').catch(() => ({}));
  let defaultBps = parseInt(process.env.ACTION_HUB_DEFAULT_FEE_BPS || '0', 10);
  let recipient = process.env.ACTION_HUB_FEE_RECIPIENT || '';
  try {
    if (getConfig) {
      const [dbGlobal, dbRecipient] = await Promise.all([
        pool.query('SELECT * FROM config WHERE key = $1', ['fee:global']).catch(() => ({ rows: [] })),
        getConfig('feeRecipient', null).catch(() => null),
      ]);
      if (dbGlobal.rows.length > 0) {
        const cfg = JSON.parse(dbGlobal.rows[0].value);
        if (cfg.bps != null) defaultBps = cfg.bps;
        if (cfg.recipient !== undefined) recipient = cfg.recipient;
        return { ...cfg, source: 'database-global' };
      }
      if (dbRecipient) recipient = dbRecipient;
    }
  } catch { /* env defaults stand */ }
  const enabled = !!recipient && defaultBps > 0;

  return {
    enabled,
    bps: defaultBps,
    recipient,
    source: 'environment-default',
  };
}

const ASSET_DECIMALS = { SUI: 9, USDC: 6, DEEP: 6, CETUS: 6, NAVX: 6 };

/** Raw base units → whole-token string (no float money on the way in). */
export function toHumanUnits(baseUnits, asset) {
  const decimals = ASSET_DECIMALS[String(asset || '').toUpperCase()] ?? 9;
  try {
    const neg = String(baseUnits).startsWith('-');
    const v = BigInt(String(baseUnits).replace('-', ''));
    const base = 10n ** BigInt(decimals);
    const whole = v / base;
    const frac = String(v % base).padStart(decimals, '0').replace(/0+$/, '');
    return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
  } catch {
    return String(Number(baseUnits) / 10 ** decimals);
  }
}

/** Whole-token display with unit — never a bare number, never `$rawMIST`. */
export function feeDisplay(humanAmount, asset) {
  const a = String(asset || '').toUpperCase();
  return `${humanAmount}${a ? ' ' + a : ''}`;
}

/**
 * Calculate platform fee for a given action.
 * Amount unit contract: the fee is computed in the SAME unit as `amount`
 * (raw MIST/base-units in → base-units out; human in → human out).
 * The return always carries explicit unit fields so Review can render
 * `0.001 SUI` (and USD only as a separate, labelled conversion) — raw MIST
 * must never reach the UI as `$`.
 * Returns: { enabled, bps, amount, amountMist?, amountSui?, display, asset, recipient, source }
 */
export async function getPlatformFee({ action, provider, instrument, user, amount, asset }) {
  if (!amount || Number(amount) <= 0) {
    return { enabled: false, bps: 0, amount: '0', asset, recipient: null, source: 'invalid-amount' };
  }

  const config = await getFeeConfig(action, provider, instrument);

  if (!config.enabled || !config.bps || config.bps <= 0) {
    return { enabled: false, bps: 0, amount: '0', asset, recipient: config.recipient || null, source: config.source };
  }

  // Validate recipient if enabled
  if (config.recipient && !isValidSuiAddress(config.recipient)) {
    console.error(`[fee-engine] Invalid fee recipient: ${config.recipient}`);
    return { enabled: false, bps: 0, amount: '0', asset, recipient: null, source: 'invalid-recipient' };
  }

  // Integer-safe bps math: digit-string (MIST) inputs stay in BigInt so a
  // raw on-chain amount never loses precision through Number().
  const rawStr = String(amount);
  const isRawInt = /^\d+$/.test(rawStr);
  let feeAmount;
  if (isRawInt) {
    try {
      feeAmount = String((BigInt(rawStr) * BigInt(config.bps)) / 10000n);
    } catch {
      feeAmount = String((Number(amount) * config.bps) / 10000);
    }
  } else {
    feeAmount = String((Number(amount) * config.bps) / 10000);
  }

  const out = {
    enabled: true,
    bps: config.bps,
    amount: feeAmount,
    asset,
    recipient: config.recipient,
    source: config.source,
  };
  // Explicit unit labelling: human + display always accompany the raw value.
  if (isRawInt) {
    out.amountMist = feeAmount;
    out.amountSui = toHumanUnits(feeAmount, asset);
    out.display = feeDisplay(out.amountSui, asset);
  } else {
    out.display = feeDisplay(feeAmount, asset);
  }
  return out;
}

/**
 * Calculate referral reward from platform revenue.
 * Referral is NOT an additional user fee — it's a split of platform revenue.
 * Returns: { eligible, rate, rewardAmount, source }
 */
export async function getReferralReward({ platformRevenue, referralRate, referralCode }) {
  if (!platformRevenue || Number(platformRevenue) <= 0) {
    return { eligible: false, rate: 0, rewardAmount: '0', source: 'no-revenue' };
  }

  const rate = referralRate || parseInt(process.env.REFERRAL_DEFAULT_RATE || '0', 10);
  if (rate <= 0) {
    return { eligible: false, rate: 0, rewardAmount: '0', source: 'zero-rate' };
  }

  if (!referralCode) {
    return { eligible: false, rate, rewardAmount: '0', source: 'no-code' };
  }

  const rewardAmount = (Number(platformRevenue) * rate) / 100;

  return {
    eligible: true,
    rate,
    rewardAmount: String(rewardAmount),
    source: 'platform-revenue-split',
  };
}

/**
 * Calculate total fee breakdown for review screen.
 * Returns: { protocolFee, providerFee, platformFee, networkFee, total, breakdown }
 */
export async function calculateFeeBreakdown({
  protocolFee = '0',
  providerFee = '0',
  networkFee = '0',
  action,
  provider,
  instrument,
  amount,
  asset,
}) {
  const platformFee = await getPlatformFee({ action, provider, instrument, amount, asset });

  const total = String(
    Number(protocolFee || 0) +
    Number(providerFee || 0) +
    Number(platformFee.amount || 0) +
    Number(networkFee || 0)
  );

  return {
    protocolFee: String(protocolFee),
    providerFee: String(providerFee),
    platformFee: platformFee.amount,
    platformFeeAsset: platformFee.asset,
    platformFeeDisplay: platformFee.display || feeDisplay(platformFee.amount, platformFee.asset),
    networkFee: String(networkFee),
    total,
    breakdown: {
      protocol: { amount: String(protocolFee), label: 'Protocol fee' },
      provider: { amount: String(providerFee), label: 'Provider fee' },
      platform: { amount: platformFee.amount, asset: platformFee.asset, display: platformFee.display || feeDisplay(platformFee.amount, platformFee.asset), label: 'Noise Hub fee', enabled: platformFee.enabled },
      network: { amount: String(networkFee), label: 'Network fee (gas)' },
    },
  };
}

/**
 * Validate fee recipient (security check).
 * Prevents user-supplied or AI-generated recipients.
 */
export function validateFeeRecipient(recipient) {
  if (!recipient) return { valid: true, reason: 'no-recipient' };
  if (!isValidSuiAddress(recipient)) {
    return { valid: false, reason: 'invalid-address' };
  }
  // Additional security: recipient must be from env or admin-configured DB
  // This check is performed at runtime during transaction building
  return { valid: true, reason: 'format-valid' };
}

/**
 * Admin: set fee configuration.
 * Only callable from admin interface with proper authentication.
 */
export async function setFeeConfig({ scope, provider, action, instrument, bps, recipient, adminKey }) {
  // Admin key validation should be handled by the calling API endpoint
  await ensureSchema();
  const pool = getPool();

  let key;
  if (provider && action && instrument) {
    key = `fee:${provider}:${action}:${instrument}`;
  } else if (provider) {
    key = `fee:${provider}`;
  } else if (action) {
    key = `fee:${action}`;
  } else {
    key = 'fee:global';
  }

  const value = JSON.stringify({
    enabled: !!recipient && bps > 0,
    bps: parseInt(bps || '0', 10),
    recipient: recipient || '',
    updatedAt: new Date().toISOString(),
  });

  await pool.query(
    'INSERT INTO config (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()',
    [key, value]
  );

  return { key, value };
}

/**
 * Admin: get all fee configurations.
 */
export async function getAllFeeConfigs() {
  await ensureSchema();
  const pool = getPool();
  const result = await pool.query(
    "SELECT key, value, updated_at FROM config WHERE key LIKE 'fee:%' ORDER BY key"
  );

  return result.rows.map((row) => ({
    key: row.key,
    config: JSON.parse(row.value),
    updatedAt: row.updated_at,
  }));
}

/**
 * Calculate net platform revenue after referral split.
 * Returns: { grossPlatformRevenue, referralReward, netPlatformRevenue }
 */
export function calculateNetRevenue({ grossPlatformRevenue, referralRate }) {
  const gross = Number(grossPlatformRevenue || 0);
  const rate = referralRate || 0;
  const referralReward = (gross * rate) / 100;
  const net = gross - referralReward;

  return {
    grossPlatformRevenue: String(gross),
    referralReward: String(referralReward),
    netPlatformRevenue: String(net),
  };
}
