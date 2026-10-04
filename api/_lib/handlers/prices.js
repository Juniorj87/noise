// GET /api/prices — live prices with source envelope.
// GET /api/prices-info — live price + 24h change with source envelope.
import { handler } from '../http.js';
import { aftermathAdapter, coinType } from '../adapters.js';
import { cached, withBreaker } from '../util.js';

export default handler(async (req, res, url) => {
  const symbols = (url.searchParams.get('coins') || 'SUI,USDC').split(',').map((s) => s.trim().toUpperCase()).slice(0, 12);
  const types = [];
  for (const s of symbols) { try { types.push(coinType(s)); } catch { /* skip unknown honestly */ } }
  if (!types.length) return { error: 'UNSUPPORTED_ASSET', message: 'No supported coin symbols provided.', status: 400 };
  try {
    if (url.pathname === '/api/prices-info') {
      return await withBreaker('aftermath', () => cached('priceinfo:' + types.join(','), 60_000, () => aftermathAdapter.getPriceInfo(types)));
    }
    return await withBreaker('aftermath', () => cached('prices:' + types.join(','), 30_000, () => aftermathAdapter.getPrices(types)));
  } catch {
    return { error: 'PROVIDER_UNAVAILABLE', message: 'Price provider unreachable.', status: 502 };
  }
});
