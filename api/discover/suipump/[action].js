// GET /api/discover/suipump/<action> — SuiPump discovery endpoints.
// Uses official public read-only API (no key required).
import { handler, requireQuery } from '../../_lib/http.js';
import { suipumpAdapter } from '../../_lib/suipump.js';
import { cached, withBreaker } from '../../_lib/util.js';

function err(code, message, status = 400) {
  return { error: code, message, status };
}

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').pop();

  if (action === 'tokens') {
    try {
      const result = await withBreaker('suipump', () => cached('suipump:tokens', 30_000, () => suipumpAdapter.getTokens()));
      return result;
    } catch (e) {
      if (e.code === 'PROVIDER_UNAVAILABLE') {
        return err('PROVIDER_UNAVAILABLE', 'SuiPump API temporarily unavailable.', 502);
      }
      return err('INTERNAL_ERROR', 'Failed to fetch tokens.', 500);
    }
  }

  if (action === 'stats') {
    const curveId = requireQuery(url, 'curveId');
    try {
      const result = await withBreaker('suipump', () => cached(`suipump:stats:${curveId}`, 15_000, () => suipumpAdapter.getTokenStats(curveId)));
      return result;
    } catch (e) {
      if (e.code === 'PROVIDER_UNAVAILABLE') {
        return err('PROVIDER_UNAVAILABLE', 'Token stats unavailable.', 502);
      }
      return err('INTERNAL_ERROR', 'Failed to fetch token stats.', 500);
    }
  }

  if (action === 'supply') {
    const curveId = requireQuery(url, 'curveId');
    try {
      const result = await withBreaker('suipump', () => cached(`suipump:supply:${curveId}`, 30_000, () => suipumpAdapter.getCurveSupply(curveId)));
      return result;
    } catch (e) {
      if (e.code === 'PROVIDER_UNAVAILABLE') {
        return err('PROVIDER_UNAVAILABLE', 'Curve supply unavailable.', 502);
      }
      return err('INTERNAL_ERROR', 'Failed to fetch curve supply.', 500);
    }
  }

  if (action === 'trades') {
    const curveId = requireQuery(url, 'curveId');
    const limit = Number(url.searchParams.get('limit') || '50');
    try {
      const result = await withBreaker('suipump', () => cached(`suipump:trades:${curveId}:${limit}`, 10_000, () => suipumpAdapter.getTrades(curveId, limit)));
      return result;
    } catch (e) {
      if (e.code === 'PROVIDER_UNAVAILABLE') {
        return err('PROVIDER_UNAVAILABLE', 'Trades unavailable.', 502);
      }
      return err('INTERNAL_ERROR', 'Failed to fetch trades.', 500);
    }
  }

  return err('NOT_FOUND', 'Unknown SuiPump discovery action.', 404);
}, { limit: 120 });
