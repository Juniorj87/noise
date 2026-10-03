// GET /api/quote — single-provider Cetus quote (legacy frontend path).
import { handler } from './_lib/http.js';
import { cetusAdapter, deepLink } from './_lib/adapters.js';
import { feeBreakdown } from './_lib/services.js';
import { cached, withBreaker } from './_lib/util.js';

export default handler(async (req, res, url) => {
  const from = (url.searchParams.get('from') || '').toUpperCase();
  const to = (url.searchParams.get('to') || '').toUpperCase();
  const amount = Number(url.searchParams.get('amount') || 0);
  const decimals = Number(url.searchParams.get('decimals') || 9);
  if (!from || !to || !(amount > 0)) {
    return { error: 'INVALID_QUOTE_REQUEST', message: 'Provide from, to and a positive amount.', status: 400 };
  }
  const amountMist = Math.round(amount * 10 ** decimals);
  try {
    const q = await withBreaker('cetus', () =>
      cached(`quote:${from}:${to}:${amountMist}`, 15_000, () => cetusAdapter.getQuote({ from, to, amountMist })));
    const minReceived = Number(q.amountOut) * 0.995;
    const fees = await feeBreakdown(amount, 'swap');
    fees.platformFeeAsset = from; // fee leg is carved from the input coin
    return { ...q, minReceived: String(Math.floor(minReceived)), fees };
  } catch (e) {
    return { error: e.code || 'PROVIDER_UNAVAILABLE', fallback: await deepLink('cetus', { from, to }), status: 502 };
  }
});
