// GET /api/discover/<source> — ecosystem discovery surfaces (read-only, cached).
//   suipump/tokens        — SuiPump launchpad tokens (live chain reads via public API).
//   perpsplexity/markets  — Perpsplexity venue status (live /api/markets read + deep link).
// No invented data: a dead provider returns PROVIDER_UNAVAILABLE (502), never a guess.
import { handler } from '../http.js';
import { suipumpAdapter } from '../suipump.js';
import { perpsplexityAdapter } from '../perpsplexity.js';
import { cached, withBreaker } from '../util.js';

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
    return { error: 'NOT_FOUND', message: 'Unknown discovery source. Known: suipump/tokens, perpsplexity/markets.', status: 404 };
  } catch (e) {
    return { error: e.code || 'PROVIDER_UNAVAILABLE', message: 'Discovery provider unreachable — nothing is estimated.', status: 502 };
  }
}, { limit: 60 });
