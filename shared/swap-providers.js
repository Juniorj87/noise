// shared/swap-providers.js — the SwapProvider abstraction (spec §7-12, #2, #3).
//
// Only providers with a real quote/build path are marked quote/build true.
// Everything else is listed with an explicit reason so the router can say
// "provider unavailable" instead of inventing a rate (spec §9). Kept in sync
// with shared/registry.js by test.
export const SWAP_PROVIDERS = [
  {id:'momentum',name:'Momentum',category:'dex',quote:true,build:true,status:'LIVE',reason:null},
  { id: 'cetus', name: 'Cetus', category: 'dex', quote: true, build: true, status: 'LIVE', reason: null },
  { id: 'aftermath', name: 'Aftermath Router', category: 'dex', quote: true, build: true, status: 'LIVE', reason: null },
  { id: 'deepbook', name: 'DeepBook', category: 'trading', quote: false, build: false, status: 'LIVE', reason: 'USE_TRADE_ORDERBOOK' },
  { id: 'turbos', name: 'Turbos', category: 'dex', quote: true, build: true, status: 'LIVE', reason: null },
  { id: 'bluefin-spot', name: 'Bluefin Spot', category: 'dex', quote: true, build: true, status: 'LIVE', reason: null },
  { id: 'flowx', name: 'FlowX', category: 'dex', quote: true, build: true, status: 'LIVE', reason: null },
];

export function swapProviders() { return SWAP_PROVIDERS.map((p) => ({ ...p })); }
export function quotableSwapProviders() { return SWAP_PROVIDERS.filter((p) => p.quote).map((p) => ({ ...p })); }
