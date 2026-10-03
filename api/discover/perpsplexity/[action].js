// GET /api/discover/perpsplexity/<action> — Perpsplexity discovery endpoints.
// Perpsplexity is a perps trading platform, not a token discovery service.
// Returns deep link information for trading.
import { handler } from '../../_lib/http.js';
import { perpsplexityAdapter } from '../../_lib/perpsplexity.js';

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').pop();

  if (action === 'tokens' || action === 'markets') {
    try {
      const result = action === 'markets'
        ? await perpsplexityAdapter.getMarkets()
        : await perpsplexityAdapter.getTokens();
      return result;
    } catch (e) {
      return { error: 'PROVIDER_UNAVAILABLE', message: 'Perpsplexity service unavailable', status: 502 };
    }
  }

  return { error: 'NOT_FOUND', message: 'Unknown Perpsplexity discovery action.', status: 404 };
}, { limit: 120 });
