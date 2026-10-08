// GET /api/quote — single-provider Cetus quote (legacy frontend path).
// GET /api/quotes — Cetus + Aftermath + Turbos compared by effective output (§7-8).
import { COIN_DECIMALS, decimalToRaw } from '../../../shared/execution-math.js';
import { handler } from '../http.js';
import { cetusAdapter, aftermathAdapter, compareRoutes, coinType, deepLink } from '../adapters.js';
import { feeBreakdown } from '../services.js';
import { cached, withBreaker } from '../util.js';
import { turbosFeeQuote as turbosQuote } from '../protocol-execution.js';
import { venueConfig } from '../../../shared/routed-venues.js';
import { swapProviders } from '../../../shared/swap-providers.js';

export default handler(async (req, res, url) => {
  const from = (url.searchParams.get('from') || '').toUpperCase();
  const to = (url.searchParams.get('to') || '').toUpperCase();
  const amountText = url.searchParams.get('amount') || '';
  const amount = Number(amountText);
  const decimals = COIN_DECIMALS[from];
  if (!from || !to || !(amount > 0)) {
    return { error: 'INVALID_QUOTE_REQUEST', message: 'Provide from, to and a positive amount.', status: 400 };
  }
  let amountMist;
  try {
    coinType(from); coinType(to);
    if (url.searchParams.has('decimals') && Number(url.searchParams.get('decimals')) !== decimals) throw Object.assign(new Error('Asset decimals do not match chain metadata.'), { code: 'INVALID_QUOTE_REQUEST' });
    amountMist = decimalToRaw(amountText, decimals);
  } catch (e) { return { error: e.code || 'INVALID_QUOTE_REQUEST', message: e.message, status: 400 }; }

  const venue=url.searchParams.get('provider');
  if(venue && !['best','aftermath','turbos','cetus'].includes(venue)){
    try {venueConfig(venue);const q=await cetusAdapter.getQuote({from,to,amountMist,venue});return {...compareRoutes([q]),failed:[],fees:{platformFee:null,total:null,note:'Hub fee is included in quote output; see route.feeCollected. Gas from simulation.'},providers:[{id:venue,name:q.provider,available:true,build:true}]};}
    catch(e){return {error:e.code||'PROVIDER_UNAVAILABLE',message:e.message,status:502};}
  }
  if (url.pathname === '/api/quotes') {
    try { coinType(from); coinType(to); }
    catch (e) { return { error: e.code || 'UNSUPPORTED_ASSET', message: 'Token not supported on the active network.', status: 400 }; }

    const [cetus, aftermath, turbos] = await Promise.allSettled([
      withBreaker('cetus', () => cached(`quote:cetus:${from}:${to}:${amountMist}`, 15_000, () => cetusAdapter.getQuote({ from, to, amountMist }))),
      withBreaker('aftermath', () => cached(`quote:af:${from}:${to}:${amountMist}`, 15_000, () => aftermathAdapter.getQuote({ from, to, amountMist }))),
      withBreaker('turbos', () => cached(`quote:turbos:${from}:${to}:${amountMist}`, 15_000, () => turbosQuote({ fromType: coinType(from), toType: coinType(to), amountMist: String(amountMist) }))),
    ]);
    const ok = [], failed = [];
    if (cetus.status === 'fulfilled') ok.push(cetus.value);
    else failed.push({ provider: 'Cetus', error: cetus.reason?.code || 'PROVIDER_UNAVAILABLE' });
    if (aftermath.status === 'fulfilled') ok.push(aftermath.value);
    else failed.push({ provider: 'Aftermath Router', error: aftermath.reason?.code || 'PROVIDER_UNAVAILABLE' });
    if (turbos.status === 'fulfilled') ok.push(turbos.value);
    else failed.push({ provider: 'Turbos', error: turbos.reason?.code || 'PROVIDER_UNAVAILABLE' });
    if (!ok.length) {
      return { error: 'ALL_PROVIDERS_UNAVAILABLE', failed, fallback: await deepLink('cetus', { from, to }), message: 'All quote providers are unreachable right now.', status: 502 };
    }
    const fb = {platformFee:null,platformFeeAsset:from,networkFee:null,networkFeeAsset:'SUI',total:null,note:'Hub fee is already included in each route output; exact raw fee is in route.feeCollected. Gas is obtained by simulation.'};
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
        reason: got ? null : (bad?.error || 'SELECT_VENUE_FOR_QUOTE'),
        build: p.build,
      };
    });
    return { ...compared, failed, fees: fb, providers };
  }

  try {
    const q = await withBreaker('cetus', () =>
      cached(`quote:${from}:${to}:${amountMist}`, 15_000, () => cetusAdapter.getQuote({ from, to, amountMist })));
    const minReceived = BigInt(q.amountOut) * 995n / 1000n;
    const fees = {platformFee:q.feeCollected?.amountMist||'0',platformFeeUnit:'raw-input-units',networkFee:null,total:null,note:'Hub fee included in quote output'};
    fees.platformFeeAsset = from;
    return { ...q, minReceived: String(minReceived), fees };
  } catch (e) {
    return { error: e.code || 'PROVIDER_UNAVAILABLE', fallback: await deepLink('cetus', { from, to }), status: 502 };
  }
});
