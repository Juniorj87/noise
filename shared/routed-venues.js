// Verified provider identifiers exported by the pinned Cetus Aggregator SDK.
// Restricting providers is mandatory: never silently substitute another venue.
export const ROUTED_VENUES = Object.freeze({
  turbos: { name: 'Turbos', providers: ['TURBOS'] },
  flowx: { name: 'FlowX', providers: ['FLOWX', 'FLOWXV3'] },
  momentum: { name: 'Momentum', providers: ['MOMENTUM'] },
  'bluefin-spot': { name: 'Bluefin Spot', providers: ['BLUEFIN'] },
  steamm: { name: 'STEAMM', providers: ['STEAMM', 'STEAMM_OMM', 'STEAMM_OMM_V2'] },
});
export function venueConfig(venue) {
  if (!venue || venue === 'cetus') return null;
  const cfg = ROUTED_VENUES[venue];
  if (!cfg) throw Object.assign(new Error('Unsupported swap venue'), { code: 'INVALID_PROVIDER' });
  return cfg;
}

export function assertVenueRouter(router, cfg) {
  if (!router || router.error || router.insufficientLiquidity || !router.paths?.length || BigInt(router.amountOut || 0) <= 0n) throw Object.assign(new Error(router?.error?.msg || 'No liquid route for this venue and pair'), {code:'INSUFFICIENT_LIQUIDITY'});
  if (cfg && router.paths.some(p => !cfg.providers.includes(p.provider))) throw Object.assign(new Error('Router substituted another venue; signing blocked'), {code:'INVALID_PROVIDER'});
}
