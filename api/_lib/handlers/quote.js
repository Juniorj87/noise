// GET /api/quote — single-provider Cetus quote (legacy frontend path).
// GET /api/quotes — Cetus + Aftermath compared by effective output (§7-8).
import { handler } from '../http.js';
import { cetusAdapter, aftermathAdapter, compareRoutes, coinType, deepLink } from '../adapters.js';
import { feeBreakdown } from '../services.js';
import { cached, withBreaker } from '../util.js';
import { swapProviders } from '../../../shared/swap-providers.js';

export default handler(async (req, res, url) => {
  const from = (url.searchParams.get('from') || '').toUpperCase();
  const to = (url.searchParams.get('to') || '').toUpperCase();
  const amount = Number(url.searchParams.get('amount') || 0);
  const decimals = Number(url.searchParams.get('decimals') || 9);
  if (!from || !to || !(amount > 0)) {
    return { error: 'INVALID_QUOTE_REQUEST', message: 'Provide from, to and a positive amount.', status: 400 };
  }
  const amountMist = Math.round(amount * 10 ** decimals);

  if (url.pathname === '/api/quotes') {
    try { coinType(from); coinType(to); }
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
    fb.platformFeeAsset = from;
    const compared = compareRoutes(ok, { platformFee: fb.platformFee, gasEst: 0 });
    // Honest per-provider status: a provider with no adapter reported (never a
    // fabricated rate), and a quotable provider that failed says so (spec §9).
    const match = (q, id) => String(q.provider || '').toLowerCase().includes(id === 'aftermath' ? 'aftermath' : id);
    const providers = swapProviders().map((p) => {
      if (!p.quote) return { id: p.id, name: p.name, available: false, reason: p.reason };
      const got = ok.find((q) => match(q, p.id));
      const bad = failed.find((f) => match(f, p.id));
      return {
        id: p.id, name: p.name,
        available: Boolean(got),
        reason: got ? null : (bad?.error || 'PROVIDER_UNAVAILABLE'),
        build: p.build,
      };
    });
    return { ...compared, failed, fees: fb, providers };
  }

  try {
    const q = await withBreaker('cetus', () =>
      cached(`quote:${from}:${to}:${amountMist}`, 15_000, () => cetusAdapter.getQuote({ from, to, amountMist })));
    const minReceived = Number(q.amountOut) * 0.995;
    const fees = await feeBreakdown(amount, 'swap');
    fees.platformFeeAsset = from;
    return { ...q, minReceived: String(Math.floor(minReceived)), fees };
  } catch (e) {
    return { error: e.code || 'PROVIDER_UNAVAILABLE', fallback: await deepLink('cetus', { from, to }), status: 502 };
  }
});
