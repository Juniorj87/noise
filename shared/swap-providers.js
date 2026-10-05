// shared/swap-providers.js — the SwapProvider abstraction (spec §7-12, #2, #3).
//
// Only providers with a real quote/build path are marked quote/build true.
// Everything else is listed with an explicit reason so the router can say
// "provider unavailable" instead of inventing a rate (spec §9). Kept in sync
// with shared/registry.js by test.
export const SWAP_PROVIDERS = [
  { id: 'cetus', name: 'Cetus', category: 'dex', quote: true, build: true, status: 'LIVE', reason: null },
  { id: 'aftermath', name: 'Aftermath Router', category: 'dex', quote: true, build: false, status: 'PARTIAL', reason: 'QUOTE_ONLY' },
  { id: 'deepbook', name: 'DeepBook', category: 'trading', quote: false, build: false, status: 'LIVE', reason: 'USE_TRADE_ORDERBOOK' },
  { id: 'turbos', name: 'Turbos', category: 'dex', quote: false, build: false, status: 'DISCOVER', reason: 'NO_ADAPTER' },
  { id: 'bluefin-spot', name: 'Bluefin Spot', category: 'dex', quote: false, build: false, status: 'DISCOVER', reason: 'NO_ADAPTER' },
  { id: 'flowx', name: 'FlowX', category: 'dex', quote: false, build: false, status: 'DISCOVER', reason: 'ROUTED_VIA_CETUS_AGGREGATOR' },
];

export function swapProviders() { return SWAP_PROVIDERS.map((p) => ({ ...p })); }
export function quotableSwapProviders() { return SWAP_PROVIDERS.filter((p) => p.quote).map((p) => ({ ...p })); }
