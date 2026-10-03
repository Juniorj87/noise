// GET /api/prices-info — live price + 24h change with source envelope.
import { handler } from './_lib/http.js';
import { aftermathAdapter, coinType } from './_lib/adapters.js';
import { cached, withBreaker } from './_lib/util.js';

export default handler(async (req, res, url) => {
  const symbols = (url.searchParams.get('coins') || 'SUI,USDC').split(',').map((s) => s.trim().toUpperCase()).slice(0, 12);
  const coins = [];
  for (const s of symbols) { try { coins.push(coinType(s)); } catch { /* skip unknown honestly */ } }
  if (!coins.length) return { error: 'UNSUPPORTED_ASSET', message: 'No supported coin symbols provided.', status: 400 };
  try {
    return await withBreaker('aftermath', () => cached('priceinfo:' + coins.join(','), 60_000, () => aftermathAdapter.getPriceInfo(coins)));
  } catch {
    return { error: 'PROVIDER_UNAVAILABLE', message: 'Price provider unreachable.', status: 502 };
  }
});
