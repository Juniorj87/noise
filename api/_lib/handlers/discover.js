// GET /api/discover/<source> — ecosystem discovery surfaces (read-only, cached).
//   suipump/tokens        — SuiPump launchpad tokens (live chain reads via public API).
//   perpsplexity/markets  — Perpsplexity venue status (live /api/markets read + deep link).
//   turbos/pools          — Turbos CLMM pools with liquidity (live chain reads via SDK).
//   bluefin/markets       — Bluefin perps markets + assets (public REST, no key).
//   bluefin/depth         — Bluefin orderbook (?symbol, ?limit).
//   bluefin/tickers       — Bluefin 24h tickers (public REST).
//   scallop/markets       — Scallop lending pools + collaterals (live SDK query).
//   bucket/markets        — Bucket collaterals + USDB supply (live SDK query).
//   springsui/rate        — sSUI/SUI exchange rate + totals (live object read).
//   volo/stats            — vSUI totals + validator APYs (NAVI open API).
//   metastable/vaults     — mUSD/mSUI/mBTC/mETH vaults (live SDK reads).
// No invented data: a dead provider returns PROVIDER_UNAVAILABLE (502), never a guess.
import { handler } from '../http.js';
import { suipumpAdapter } from '../suipump.js';
import { perpsplexityAdapter } from '../perpsplexity.js';
import {
  turbosPools, bluefinMarkets, bluefinDepth, bluefinTickers,
  scallopMarkets, bucketMarkets, springsuiRate, voloStats, mstableVaults,
} from '../lending.js';
import { cached, withBreaker } from '../util.js';

const KNOWN = 'suipump/tokens, perpsplexity/markets, turbos/pools, bluefin/markets|depth|tickers, scallop/markets, bucket/markets, springsui/rate, volo/stats, metastable/vaults';

export default handler(async (req, res, url) => {
  const parts = url.pathname.split('/').filter(Boolean);
  const source = parts[2] || '';
  const action = parts[3] || '';

  if (req.method !== 'GET') {
    return { error: 'INVALID_REQUEST', message: 'GET required for discovery surfaces.', status: 400 };
  }

  try {
    if (source === 'suipump' && (action === 'tokens' || action === '')) {
      return await withBreaker('suipump', () => cached('discover:suipump:tokens', 60_000, () => suipumpAdapter.getTokens()));
    }
    if (source === 'perpsplexity' && (action === 'markets' || action === '')) {
      return await withBreaker('perpsplexity', () => cached('discover:ppx:markets', 60_000, () => perpsplexityAdapter.getMarkets()));
    }
    if (source === 'turbos' && action === 'pools') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 24), 100);
      // Full pool universe is ~10k objects — allow a long first fetch, then serve cache.
      return { pools: await withBreaker('turbos', () => cached('discover:turbos:pools:' + limit, 120_000, () => turbosPools(limit)), 60000), updatedAt: new Date().toISOString() };
    }
    if (source === 'bluefin' && (action === 'markets' || action === '')) {
      return await withBreaker('bluefin', () => cached('discover:bluefin:markets', 60_000, () => bluefinMarkets()));
    }
    if (source === 'bluefin' && action === 'depth') {
      const symbol = url.searchParams.get('symbol');
      if (!symbol) return { error: 'MISSING_SYMBOL', message: 'symbol required.', status: 400 };
      return await withBreaker('bluefin', () => cached('discover:bluefin:depth:' + symbol, 15_000, () => bluefinDepth(symbol)));
    }
    if (source === 'bluefin' && action === 'tickers') {
      return await withBreaker('bluefin', () => cached('discover:bluefin:tickers', 30_000, () => bluefinTickers()));
    }
    if (source === 'scallop' && action === 'markets') {
      return await withBreaker('scallop', () => cached('discover:scallop:markets', 120_000, () => scallopMarkets()));
    }
    if (source === 'bucket' && action === 'markets') {
      return await withBreaker('bucket', () => cached('discover:bucket:markets', 120_000, () => bucketMarkets()));
    }
    if (source === 'springsui' && action === 'rate') {
      return await withBreaker('springsui', () => cached('discover:springsui:rate', 60_000, () => springsuiRate()));
    }
    if (source === 'volo' && action === 'stats') {
      return await withBreaker('volo', () => cached('discover:volo:stats', 300_000, () => voloStats()));
    }
    if (source === 'metastable' && action === 'vaults') {
      return await withBreaker('metastable', () => cached('discover:mstable:vaults', 120_000, () => mstableVaults()));
    }
    return { error: 'NOT_FOUND', message: 'Unknown discovery source. Known: ' + KNOWN + '.', status: 404 };
  } catch (e) {
    return { error: e.code || 'PROVIDER_UNAVAILABLE', message: 'Discovery provider unreachable — nothing is estimated.', status: 502 };
  }
}, { limit: 60 });
