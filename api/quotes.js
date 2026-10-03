// GET /api/quotes — Cetus + Aftermath compared by effective output (§7-8).
import { handler } from './_lib/http.js';
import { cetusAdapter, aftermathAdapter, compareRoutes, coinType, deepLink } from './_lib/adapters.js';
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
  let amountMist;
  try { coinType(from); coinType(to); amountMist = Math.round(amount * 10 ** decimals); }
  catch (e) { return { error: e.code || 'UNSUPPORTED_ASSET', message: 'Token not supported on the active network.', status: 400 }; }

  const [cetus, aftermath] = await Promise.allSettled([
    withBreaker('cetus', () => cached(`quote:cetus:${from}:${to}:${amountMist}`, 15_000, () => cetusAdapter.getQuote({ from, to, amountMist }))),
    withBreaker('aftermath', () => cached(`quote:af:${from}:${to}:${amountMist}`, 15_000, () => aftermathAdapter.getQuote({ from, to, amountMist }))),
  ]);
  const ok = [], failed = [];
  if (cetus.status === 'fulfilled') ok.push(cetus.value);
  else failed.push({ provider: 'Cetus', error: cetus.reason?.code || 'PROVIDER_UNAVAILABLE' });
  if (aftermath.status === 'fulfilled') ok.push(aftermath.value);
  else failed.push({ provider: 'Aftermath Router', error: aftermath.reason?.code || 'PROVIDER_UNAVAILABLE' });
  if (!ok.length) {
    return { error: 'ALL_PROVIDERS_UNAVAILABLE', failed, fallback: await deepLink('cetus', { from, to }), message: 'Both quote providers are unreachable right now.', status: 502 };
  }
  const fb = await feeBreakdown(amount, 'swap');
  // Platform fee is a leg on the input coin — state its unit so the UI never
  // renders it as dollars.
  fb.platformFeeAsset = from;
  const compared = compareRoutes(ok, { platformFee: fb.platformFee, gasEst: 0 });
  return { ...compared, failed, fees: fb };
});
