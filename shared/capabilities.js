// shared/capabilities.js — Action capability model (production capability fix).
//
// Data and execution are INDEPENDENT. A readable protocol (TVL/APY/quote) does
// NOT mean Noise can execute it. Each action declares five stages; execution is
// only allowed when build+simulate+execute are LIVE. The UI must gate Review on
// `execute === 'LIVE'` and otherwise offer "View on Provider".
export const CAP_STATES = ['LIVE', 'PARTIAL', 'READ_ONLY', 'UNAVAILABLE', 'COMING_SOON'];

function cap(data, quote, build, simulate, execute, extra = {}) {
  return { data, quote, build, simulate, execute, ...extra };
}

export const ACTION_CAPABILITIES = {
  // LIVE end-to-end (build + simulate + wallet sign proven in code).
  swap: cap('LIVE', 'LIVE', 'LIVE', 'LIVE', 'LIVE', { provider: 'Cetus', url: 'https://app.cetus.zone', note: 'Cetus router: quote → build → simulate → wallet sign.' }),
  stake: cap('LIVE', '—', 'LIVE', 'LIVE', 'LIVE', { provider: 'Sui native staking', url: 'https://sui.io', note: 'Native stake PTB built + simulated; wallet signs.' }),
  unstake: cap('LIVE', '—', 'LIVE', 'LIVE', 'LIVE', { provider: 'Sui native staking', url: 'https://sui.io', note: 'Native unstake PTB built + simulated; wallet signs.' }),
  liquid_stake: cap('LIVE', '—', 'LIVE', 'LIVE', 'LIVE', { provider: 'Aftermath', url: 'https://aftermath.finance', note: 'Liquid stake/unstake PTB built + simulated; wallet signs.' }),
  predict_mint: cap('LIVE', 'LIVE', 'LIVE', 'LIVE', 'LIVE', { provider: 'DeepBook Predict', url: 'https://deepbook.tech' }),
  predict_redeem: cap('LIVE', 'LIVE', 'LIVE', 'LIVE', 'LIVE', { provider: 'DeepBook Predict', url: 'https://deepbook.tech' }),
  predict_claim: cap('LIVE', '—', 'LIVE', 'LIVE', 'LIVE', { provider: 'DeepBook Predict', url: 'https://deepbook.tech' }),
  spot_order: cap('LIVE', 'LIVE', 'LIVE', 'LIVE', 'LIVE', { provider: 'DeepBook', url: 'https://deepbook.tech' }),
  limit_order: cap('LIVE', '—', 'LIVE', 'LIVE', 'LIVE', { provider: 'DeepBook', url: 'https://deepbook.tech' }),
  market_order: cap('LIVE', 'LIVE', 'LIVE', 'LIVE', 'LIVE', { provider: 'DeepBook', url: 'https://deepbook.tech' }),
  cancel_order: cap('LIVE', '—', 'LIVE', 'LIVE', 'LIVE', { provider: 'DeepBook', url: 'https://deepbook.tech' }),
  setup_trading_account: cap('LIVE', '—', 'LIVE', 'LIVE', 'LIVE', { provider: 'DeepBook', url: 'https://deepbook.tech' }),

  // Data / quote readable, but no verified build in Noise.
  liquidity: cap('LIVE', 'LIVE', 'READ_ONLY', 'UNAVAILABLE', 'READ_ONLY', { provider: 'Cetus / Aftermath pools', url: 'https://app.cetus.zone', note: 'Pool TVL/APR are live; pool add-liquidity build is not wired.' }),
  claim: cap('LIVE', '—', 'READ_ONLY', 'UNAVAILABLE', 'READ_ONLY', { provider: 'Aftermath', url: 'https://aftermath.finance', note: 'Rewards are readable; protocol reward claim needs a provider adapter.' }),
  supply: cap('UNAVAILABLE', '—', 'READ_ONLY', 'UNAVAILABLE', 'READ_ONLY', { provider: 'NAVI / Suilend', url: 'https://naviprotocol.io', note: 'Lending SDKs are blocked — no markets are shown rather than invented.' }),
  borrow: cap('UNAVAILABLE', '—', 'UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE', { provider: 'NAVI / Suilend', url: 'https://naviprotocol.io', note: 'Lending execution is unavailable in Noise.' }),
  repay: cap('UNAVAILABLE', '—', 'UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE', { provider: 'NAVI / Suilend', url: 'https://naviprotocol.io', note: 'Lending execution is unavailable in Noise.' }),
  withdraw: cap('UNAVAILABLE', '—', 'UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE', { provider: 'NAVI / Suilend', url: 'https://naviprotocol.io', note: 'Lending execution is unavailable in Noise.' }),
  transfer: cap('LIVE', '—', 'READ_ONLY', 'UNAVAILABLE', 'READ_ONLY', { provider: 'Sui', url: 'https://sui.io', note: 'Transfers are not built in Noise.' }),
};

export function capabilityOf(action) { return ACTION_CAPABILITIES[action] || null; }
export function isExecutable(action) {
  const c = capabilityOf(action);
  return Boolean(c && c.execute === 'LIVE');
}
export function executionStatus(action) {
  const c = capabilityOf(action);
  return c ? c.execute : 'UNAVAILABLE';
}
/** Actions keyed by the labels the UI uses, for mirroring into app.html. */
export function uiCapabilities() { return JSON.parse(JSON.stringify(ACTION_CAPABILITIES)); }
