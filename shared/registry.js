// shared/registry.js — canonical Noise Hub ProtocolRegistry.
//
// One structure for the whole ecosystem (spec §21). Dependency-free so the dev
// server, the serverless API and tests can all import it. The static UI keeps a
// generated JSON mirror (see scripts/build-check.mjs + server/test/registry.test.js)
// so there is exactly ONE source of truth.
//
// Honesty contract (spec §2, §9, §21):
//   LIVE        — Noise can really perform every action it advertises.
//   PARTIAL     — part of the advertised surface really works (e.g. live data,
//                 no execution yet).
//   DISCOVER    — presented as ecosystem discovery / deep link; no execution.
//   COMING_SOON — surface exists but execution is intentionally disabled.
// No protocol may claim execution unless status is LIVE (enforced by test).

export const REGISTRY_VERIFIED_AT = '2026-10-04';

export const STATUS = ['LIVE', 'PARTIAL', 'DISCOVER', 'COMING_SOON'];

// Actions that move funds and therefore require a real, signed transaction.
export const EXECUTION_ACTIONS = [
  'swap', 'supply', 'withdraw', 'borrow', 'repay', 'stake', 'unstake', 'deposit',
  'claim', 'transfer', 'spot_order', 'limit_order', 'market_order', 'cancel_order',
  'setup_trading_account', 'predict_mint', 'predict_redeem', 'predict_claim',
  'predict_settlement', 'margin',
];

// Discover filter buckets (spec §22). Every protocol maps to exactly one.
export const FILTERS = ['ALL', 'DEX', 'TRADING', 'LENDING', 'EARN', 'STAKING', 'BTCFI', 'BRIDGE', 'INFRASTRUCTURE'];

const C = {
  // data = readable on-chain/market data, swap = token swap, trade = order book /
  // markets, earn = yield/staking rewards, position = user positions, execution =
  // Noise can build + (wallet) sign a real transaction.
  d: (o = {}) => ({ data: false, swap: false, trade: false, earn: false, position: false, execution: false, ...o }),
};

function p(entry) {
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    bucket: entry.bucket,
    status: entry.status,
    actions: entry.actions || [],
    capability: entry.capability || C.d(),
    dataSource: entry.dataSource || '—',
    fee: entry.fee || '—',
    ref: entry.ref || '—',
    url: entry.url || '',
    docs: entry.docs || '',
    logo: entry.logo || null,
    note: entry.note || '',
    last: entry.last || REGISTRY_VERIFIED_AT,
  };
}

export const PROTOCOLS = [
  // ---- settlement / infrastructure -------------------------------------------
  p({
    id: 'sui', name: 'Sui', category: 'infrastructure', bucket: 'INFRASTRUCTURE', status: 'LIVE',
    actions: ['settlement', 'rpc', 'balances', 'objects', 'stakes', 'transfer'],
    capability: C.d({ data: true, execution: true }),
    dataSource: 'Sui RPC / gRPC', fee: 'gas only', ref: '—',
    url: 'https://sui.io', docs: 'https://docs.sui.io',
    note: 'Settlement layer: balances, objects, stakes and transaction status read live. Plain coin transfers build + simulate in Noise; wallet signs.',
  }),
  p({
    id: 'sui-native', name: 'Sui Native Staking', category: 'staking', bucket: 'STAKING', status: 'LIVE',
    actions: ['stake', 'unstake', 'rewards', 'validators', 'position'],
    capability: C.d({ data: true, earn: true, position: true, execution: true }),
    dataSource: 'Sui RPC (system state)', fee: 'validator commission', ref: '—',
    url: 'https://sui.io', docs: '',
    note: 'Native validator staking: stake, unstake, rewards and validators.',
  }),

  // ---- DEX / liquidity -------------------------------------------------------
  p({
    id: 'cetus', name: 'Cetus', category: 'dex', bucket: 'DEX', status: 'LIVE',
    actions: ['swap', 'quote', 'build-tx', 'simulate', 'position'],
    capability: C.d({ data: true, swap: true, position: true, execution: true }),
    dataSource: 'Cetus Aggregator SDK', fee: 'pool fee + platform bps (cfg)', ref: 'partner closed to new teams → policy 0',
    url: 'https://app.cetus.zone', docs: 'https://cetus-1.gitbook.io/cetus-developer-docs',
    note: 'Primary swap router: quote → build → simulate → sign, proven live.',
  }),
  p({
    id: 'aftermath', name: 'Aftermath', category: 'dex', bucket: 'DEX', status: 'PARTIAL',
    actions: ['swap-quote', 'swap-build', 'pools', 'staking-apy', 'rewards', 'position'],
    capability: C.d({ data: true, swap: true, earn: true, position: true }),
    dataSource: 'Aftermath REST + TS SDK', fee: 'router: no protocol fee; pools 0.30%/0.10%', ref: 'router 2.5% of integrator fee',
    url: 'https://aftermath.finance', docs: 'https://docs.aftermath.finance',
    note: 'Live data + quotes; swap build wired (router tx appended after the Noise fee leg, simulated pre-sign). Selectable in Swap execution route. E2E proof needs a funded wallet run.',
  }),
  p({
    id: 'deepbook', name: 'DeepBook', category: 'trading', bucket: 'TRADING', status: 'LIVE',
    actions: ['markets', 'orderbook', 'spot_order', 'limit_order', 'market_order', 'cancel_order', 'setup_trading_account', 'position'],
    capability: C.d({ data: true, trade: true, position: true, execution: true }),
    dataSource: 'DeepBook v3 SDK', fee: 'maker/taker (protocol)', ref: '—',
    url: 'https://deepbook.tech', docs: 'https://docs.sui.io/standards/deepbookv3',
    note: "Sui's native onchain liquidity layer. Live markets, L2 orderbook, order build/cancel via BalanceManager.",
  }),
  p({
    id: 'deepbook-predict', name: 'DeepBook Predict', category: 'trading', bucket: 'TRADING', status: 'LIVE',
    actions: ['markets', 'predict_mint', 'predict_redeem', 'predict_claim', 'predict_settlement', 'position'],
    capability: C.d({ data: true, trade: true, position: true, execution: true }),
    dataSource: '@mysten/deepbook-v3/predict', fee: 'predict fee (simulated pre-sign)', ref: '—',
    url: 'https://deepbook.tech', docs: '',
    note: 'Live prediction markets: UP/DOWN mint, redeem, claim-settled, positions.',
  }),
  p({
    id: 'deepbook-margin', name: 'DeepBook Margin', category: 'trading', bucket: 'TRADING', status: 'COMING_SOON',
    actions: ['preflight', 'setup-margin-account'], capability: C.d({ data: true }),
    dataSource: 'DeepBook Margin SDK (gRPC)', fee: 'gas only for setup', ref: '—',
    url: 'https://deepbook.tech', docs: '',
    note: 'On-chain preflight (enabled pools SUI_USDC, DEEP_USDC + margin pool ids) and margin-account creation wired + simulated. Leveraged borrow/trade needs a user MarginManager + fresh Pyth feeds — built per-manager after setup E2E.',
  }),
  p({
    id: 'turbos', name: 'Turbos', category: 'dex', bucket: 'DEX', status: 'PARTIAL',
    actions: ['pools', 'swap-quote'],
    capability: C.d({ data: true, swap: true }),
    dataSource: 'Turbos REST (TVL/volume/APR) + SDK quotes', fee: 'pool fee (provider)', ref: 'verify',
    url: 'https://turbos.finance', docs: '',
    note: 'Live CLMM pools and swap quotes compared in every Swap (3rd route). Execution builds via Cetus/Aftermath routers. E2E proof needs a funded wallet run.',
  }),
  p({
    id: 'flowx', name: 'FlowX', category: 'dex', bucket: 'DEX', status: 'DISCOVER',
    actions: ['pools'], capability: C.d(),
    dataSource: 'Cetus Aggregator (routed liquidity)', fee: 'pool fee (provider)', ref: 'verify',
    url: 'https://flowx.finance', docs: 'https://docs.flowx.finance',
    note: 'Usable inside Swap via Cetus Aggregator routing when the router selects it — no separate FlowX adapter; deep-link for direct use.',
  }),
  p({
    id: 'momentum', name: 'Momentum', category: 'dex', bucket: 'DEX', status: 'DISCOVER',
    actions: [], capability: C.d(),
    dataSource: '—', fee: 'verify', ref: 'verify',
    url: '', docs: '',
    note: 'Site unreachable at audit 2026-10-06 (TLS/DNS fail) — deep-link disabled until a verified domain exists. No data shown rather than a dead link.',
  }),
  p({
    id: 'kriya', name: 'Kriya', category: 'dex', bucket: 'DEX', status: 'DISCOVER',
    actions: [], capability: C.d(),
    dataSource: '—', fee: '—', ref: '—',
    url: 'https://kriya.finance', docs: 'https://docs.kriya.finance',
    note: 'SUNSET — protocol is winding down. Excluded from routing and quotes; card stays for history with a deep-link only.',
  }),
  p({
    id: 'metastable', name: 'Metastable', category: 'stablecoin', bucket: 'EARN', status: 'PARTIAL',
    actions: ['vaults', 'mint-build', 'burn-build'],
    capability: C.d({ data: true }),
    dataSource: 'metastable-ts-sdk (vault reads)', fee: 'deposit 0%; withdraw 0.01–1% dynamic', ref: 'verify',
    url: 'https://mstable.io', docs: 'https://docs.mstable.io',
    note: 'Aftermath-incubated Sui stablecoin vaults (mUSD 17 assets, mSUI 16, mBTC, mETH — all read live). Previous metastable.io domain is dead — canonical home is mstable.io. mSUI mint/burn builds via the official SDK; mUSD/mBTC/mETH need a Pyth key the bundled SDK cannot pass (Hermes 401) — honest blocker. E2E proof needs a funded wallet run.',
  }),

  // ---- perpetuals / derivatives ---------------------------------------------
  p({
    id: 'bluefin-spot', name: 'Bluefin Spot', category: 'dex', bucket: 'DEX', status: 'DISCOVER',
    actions: [], capability: C.d(),
    dataSource: '—', fee: 'verify', ref: 'verify',
    url: 'https://bluefin.io', docs: 'https://docs.bluefin.io',
    note: 'Bluefin publishes perps market data, not a spot book — spot stays deep-link only.',
  }),
  p({
    id: 'bluefin-perps', name: 'Bluefin Perps', category: 'trading', bucket: 'TRADING', status: 'PARTIAL',
    actions: ['markets', 'orderbook', 'tickers'],
    capability: C.d({ data: true, trade: true }),
    dataSource: 'Bluefin Pro API (public market data, no key)', fee: 'provider fee', ref: 'verify',
    url: 'https://bluefin.io', docs: 'https://docs.bluefin.io',
    note: 'Live perps markets, orderbook depth and 24h tickers in Discover. Trading needs a venue account — execution on Bluefin.',
  }),
  p({
    id: 'typus', name: 'Typus', category: 'trading', bucket: 'TRADING', status: 'DISCOVER',
    actions: [], capability: C.d(),
    dataSource: '—', fee: 'verify', ref: 'verify',
    url: 'https://typus.finance', docs: 'https://docs.typus.finance',
    note: 'Options vaults need user vault positions + auctions on the venue — no public execution API found 2026-10-06. Deep-link only.',
  }),
  p({
    id: 'sudo', name: 'Sudo', category: 'trading', bucket: 'TRADING', status: 'DISCOVER',
    actions: [], capability: C.d(),
    dataSource: '—', fee: 'verify', ref: 'verify',
    url: 'https://app.sudo.finance', docs: 'https://docs.sudo.finance',
    note: 'On-chain perps on Sui (sub-second, Pyth oracles). No public market-data API found 2026-10-06 — execution on the venue, deep-link only.',
  }),
  p({
    id: 'perpsplexity', name: 'Perpsplexity', category: 'trading', bucket: 'TRADING', status: 'DISCOVER',
    actions: ['markets'], capability: C.d({ data: true }),
    dataSource: 'Perpsplexity venue (status read)', fee: 'provider fee', ref: 'verify',
    url: 'https://perpsplexity.app', docs: '',
    note: 'Live venue status read; execution on the venue. No public token-discovery API.',
  }),

  // ---- lending / borrowing ---------------------------------------------------
  p({
    id: 'navi', name: 'NAVI', category: 'lending', bucket: 'LENDING', status: 'PARTIAL',
    actions: ['markets', 'position', 'rewards', 'supply-build', 'withdraw-build', 'borrow-build', 'repay-build', 'claim-build'],
    capability: C.d({ data: true, position: true }),
    dataSource: 'NAVI Lending SDK v2 (gRPC)', fee: 'referral-share first', ref: 'terms unverified → policy 0',
    url: 'https://naviprotocol.io', docs: 'https://docs.naviprotocol.io',
    note: 'Live markets (35 pools), positions, health factor and rewards. Supply/withdraw/borrow/repay/claim PTBs build + simulate via the new @naviprotocol/lending SDK; wallet signs. E2E proof needs a funded wallet run.',
  }),
  p({
    id: 'suilend', name: 'Suilend', category: 'lending', bucket: 'LENDING', status: 'PARTIAL',
    actions: ['markets', 'position', 'supply-build', 'withdraw-build', 'borrow-build', 'repay-build', 'claim-build'],
    capability: C.d({ data: true, position: true }),
    dataSource: 'Suilend SDK v12 (gRPC)', fee: 'referral-share first', ref: 'terms unverified → policy 0',
    url: 'https://suilend.fi', docs: 'https://docs.suilend.fi',
    note: 'Live markets (45 reserves) and obligation positions. Supply/withdraw/borrow/repay/claim PTBs build + simulate; wallet signs. E2E proof needs a funded wallet run.',
  }),
  p({
    id: 'scallop', name: 'Scallop', category: 'lending', bucket: 'LENDING', status: 'PARTIAL',
    actions: ['markets', 'position', 'supply-build', 'withdraw-build', 'borrow-build', 'repay-build'],
    capability: C.d({ data: true, position: true }),
    dataSource: 'Scallop SDK v5 (gRPC)', fee: 'referral-share first', ref: 'terms unverified → policy 0',
    url: 'https://scallop.io', docs: 'https://docs.scallop.io',
    note: 'Live markets, obligations and portfolio. Supply/withdraw/borrow/repay PTBs build unsigned via the official SDK; wallet signs. E2E proof needs a funded wallet run.',
  }),
  p({
    id: 'bucket', name: 'Bucket', category: 'lending', bucket: 'LENDING', status: 'PARTIAL',
    actions: ['markets', 'position', 'psm-swap-build'],
    capability: C.d({ data: true, position: true, swap: true }),
    dataSource: 'Bucket SDK v2 (gRPC)', fee: 'PSM low-fee swaps', ref: 'verify',
    url: 'https://bucketprotocol.io', docs: 'https://docs.bucketprotocol.io',
    note: 'Live PSM pools, collaterals and USDB supply. USDB PSM swaps build + simulate; wallet signs. sUSDB savings deposit needs an lpType the SDK cannot enumerate (upstream BigInt bug) — honest blocker.',
  }),
  p({
    id: 'alphalend', name: 'AlphaLend', category: 'lending', bucket: 'LENDING', status: 'DISCOVER',
    actions: [], capability: C.d(),
    dataSource: '—', fee: '—', ref: '—',
    url: 'https://alphalend.xyz', docs: 'https://docs.alphafi.xyz/alphalend/introduction',
    note: 'SUNSET — AlphaFi (operator) is winding down. Withdraw via the provider; no new positions through Noise.',
  }),

  // ---- liquid staking / yield ------------------------------------------------
  p({
    id: 'haedal', name: 'Haedal', category: 'liquid-staking', bucket: 'STAKING', status: 'PARTIAL',
    actions: ['stake-build', 'unstake-build', 'claim-build', 'position', 'rate'],
    capability: C.d({ data: true, earn: true, position: true, execution: false }),
    dataSource: 'Haedal on-chain interface (devInspect reads + Move builds)', fee: 'instant unstake 9%; delayed free', ref: 'verify',
    url: 'https://haedal.xyz', docs: '',
    note: 'Live haSUI/SUI rate (1.0825), positions and tickets. Stake (min 1 SUI, auto or chosen validator), delayed/instant unstake and ticket claim PTBs build via the upgraded staking package; wallet signs. E2E proof needs a funded wallet run.',
  }),
  p({
    id: 'volo', name: 'Volo', category: 'liquid-staking', bucket: 'STAKING', status: 'PARTIAL',
    actions: ['stats'],
    capability: C.d({ data: true, earn: true }),
    dataSource: 'NAVI open API (vSUI stats)', fee: 'verify', ref: 'verify',
    url: 'https://volo.fi', docs: '',
    note: 'Live totals, validator APYs and stake stats. Stake builds need StakePool/Metadata object IDs unpublished in verified docs — execution blocked with exact reason, never faked.',
  }),
  p({
    id: 'springsui', name: 'SpringSui', category: 'liquid-staking', bucket: 'STAKING', status: 'PARTIAL',
    actions: ['rate', 'mint-build', 'redeem-build', 'position'],
    capability: C.d({ data: true, earn: true, position: true }),
    dataSource: 'SpringSui SDK v4 (gRPC object reads)', fee: 'protocol mint/redeem fees', ref: 'verify',
    url: 'https://springsui.com', docs: 'https://docs.suilend.fi/springsui/springsui-integration.md',
    note: 'Live sSUI/SUI rate and 60M SUI TVL. Mint/redeem PTBs build + simulate; wallet signs. Instant unstaking via SIP-33. E2E proof needs a funded wallet run.',
  }),
  p({
    id: 'alphafi', name: 'AlphaFi', category: 'yield', bucket: 'EARN', status: 'DISCOVER',
    actions: [], capability: C.d(),
    dataSource: '—', fee: '—', ref: '—',
    url: 'https://alphafi.xyz', docs: 'https://docs.alphafi.xyz',
    note: 'SUNSET — AlphaFi is winding down (official site notice). Withdraw via the provider; no new positions through Noise.',
  }),
  p({
    id: 'kai', name: 'Kai', category: 'yield', bucket: 'EARN', status: 'DISCOVER',
    actions: [], capability: C.d(),
    dataSource: '—', fee: 'verify', ref: 'verify',
    url: 'https://kai.finance', docs: '',
    note: 'No public markets/execution API found 2026-10-06 — execution on the venue, deep-link only.',
  }),
  p({
    id: 'nemo', name: 'Nemo', category: 'btcfi', bucket: 'BTCFI', status: 'DISCOVER',
    actions: [], capability: C.d(),
    dataSource: '—', fee: 'verify', ref: 'verify',
    url: 'https://nemo.fi', docs: '',
    note: 'BTCFi yield. No public markets/execution API found 2026-10-06 (venue slow to respond) — execution on the venue, deep-link only.',
  }),
  p({
    id: 'steamm', name: 'STEAMM', category: 'yield', bucket: 'EARN', status: 'DISCOVER',
    actions: [], capability: C.d(),
    dataSource: '—', fee: 'verify', ref: 'verify',
    url: 'https://suilend.fi', docs: 'https://docs.suilend.fi/steamm-developer-integration-guide.md',
    note: 'Suilend AMM pools need position-aware LP flows — no verified unsigned-build path yet. Deep-link to Suilend only.',
  }),

  // ---- discovery / launchpads ------------------------------------------------
  p({
    id: 'suipump', name: 'SuiPump', category: 'launchpad', bucket: 'INFRASTRUCTURE', status: 'LIVE',
    actions: ['tokens', 'price', 'volume', 'trades', 'bonding', 'graduation'],
    capability: C.d({ data: true }),
    dataSource: 'SuiPump API', fee: 'provider fee', ref: '—',
    url: 'https://suipump.fun', docs: '',
    note: '674+ launchpad tokens: factual metrics only, never recommendations.',
  }),

  // ---- bridges ---------------------------------------------------------------
  p({
    id: 'suibridge', name: 'Sui Bridge', category: 'bridge', bucket: 'BRIDGE', status: 'DISCOVER',
    actions: [], capability: C.d(),
    dataSource: '—', fee: 'provider fee', ref: '—',
    url: 'https://bridge.sui.io', docs: '',
    note: 'Native bridge. Deep link — execution leaves Noise Hub.',
  }),
  p({
    id: 'wormhole', name: 'Wormhole / Portal', category: 'bridge', bucket: 'BRIDGE', status: 'DISCOVER',
    actions: [], capability: C.d(),
    dataSource: '—', fee: 'provider fee', ref: 'verify',
    url: 'https://portalbridge.com', docs: 'https://docs.wormhole.com',
    note: 'Bridge. Deep link only.',
  }),

  // ---- data / security layer (spec §25-35) ----------------------------------
  // NOTE: Walrus / Seal intentionally not listed — Noise Hub does not integrate
  // them. The hub stores app memory in its own database (see AI Assistant).
];

/* ------------------------------ helpers ---------------------------------- */

const BY_ID = new Map(PROTOCOLS.map((x) => [x.id, x]));

export function getProtocol(id) { return BY_ID.get(id) || null; }
export function allProtocols() { return PROTOCOLS.slice(); }
export function byStatus(status) { return PROTOCOLS.filter((x) => x.status === status); }
export function byBucket(bucket) {
  if (!bucket || bucket === 'ALL') return PROTOCOLS.slice();
  return PROTOCOLS.filter((x) => x.bucket === bucket);
}
export function statusCounts() {
  const out = { LIVE: 0, PARTIAL: 0, DISCOVER: 0, COMING_SOON: 0 };
  for (const x of PROTOCOLS) out[x.status] = (out[x.status] || 0) + 1;
  return out;
}
export function searchProtocols(q) {
  const s = String(q || '').toLowerCase().trim();
  if (!s) return [];
  return PROTOCOLS.filter((x) => (x.id + ' ' + x.name + ' ' + x.category + ' ' + x.actions.join(' ')).toLowerCase().includes(s));
}
export function hasExecution(p) { return Boolean(p.capability && p.capability.execution); }

/** Capability matrix rows for the UI (spec “Protocol capability matrix”). */
export function capabilityMatrix() {
  return PROTOCOLS.map((x) => ({
    id: x.id, name: x.name, category: x.category, bucket: x.bucket, status: x.status,
    data: x.capability.data, swap: x.capability.swap, trade: x.capability.trade,
    earn: x.capability.earn, position: x.capability.position, execution: x.capability.execution,
  }));
}

/** Compact shape the static UI mirror uses (kept in sync by test). */
export function uiRegistry() {
  return PROTOCOLS.map((x) => ({
    id: x.id, name: x.name, cat: x.category, status: x.status,
    caps: x.actions, url: x.url, docs: x.docs, fee: x.fee, ref: x.ref, last: x.last,
  }));
}

export function serializeRegistry() {
  return JSON.stringify({ verifiedAt: REGISTRY_VERIFIED_AT, protocols: PROTOCOLS }, null, 2);
}
