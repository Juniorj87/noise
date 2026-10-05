// GET /api/providers — SwapProvider availability + provider health (spec §7-12, #3).
// Honest: a provider with no adapter is listed with a reason, never a fake quote.
import { handler } from '../http.js';
import { providerHealth, cacheSize } from '../util.js';
import { swapProviders } from '../../../shared/swap-providers.js';
import { statusCounts, REGISTRY_VERIFIED_AT } from '../../../shared/registry.js';

export default handler(async () => {
  const health = providerHealth();
  const healthBy = Object.fromEntries(health.map((h) => [h.provider, h]));
  const swap = swapProviders().map((p) => ({
    ...p,
    health: healthBy[p.id]?.status || (p.quote ? 'UNKNOWN' : 'NOT_WIRED'),
  }));
  return {
    swap,
    swapSummary: {
      quotable: swap.filter((p) => p.quote).map((p) => p.name),
      buildable: swap.filter((p) => p.build).map((p) => p.name),
      unavailable: swap.filter((p) => !p.quote).map((p) => ({ provider: p.name, reason: p.reason })),
    },
    health,
    cacheEntries: cacheSize(),
    ecosystem: statusCounts(),
    verifiedAt: REGISTRY_VERIFIED_AT,
    updatedAt: new Date().toISOString(),
    source: 'Noise provider registry',
  };
});
