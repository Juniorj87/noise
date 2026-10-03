// GET /api/capital?wallet=&refresh=true — real Sui RPC reads, 30s instance cache.
// Aggregation layer: wallet balances + stakes + (best-effort) DeepBook spot
// open orders + Predict positions. Position reads are provider-isolated:
// a dead provider yields a null section with a note, never a failed Capital.
import { handler } from './_lib/http.js';
import { isWalletAddress } from './_lib/services.js';
import { suiAdapter } from './_lib/adapters.js';
import { cached, invalidateCache, withBreaker } from './_lib/util.js';

export default handler(async (req, res, url) => {
  const wallet = url.searchParams.get('wallet');
  if (!wallet || !isWalletAddress(wallet)) {
    return { error: wallet ? 'INVALID_WALLET' : 'MISSING_WALLET', message: 'Provide a valid 0x… wallet address.', status: 400 };
  }
  const forceRefresh = url.searchParams.get('refresh') === 'true';
  const withPositions = url.searchParams.get('positions') !== 'false';
  if (forceRefresh) invalidateCache('capital:' + wallet);
  const data = await withBreaker('sui-rpc', () =>
    cached('capital:' + wallet, 30_000, () => suiAdapter.getCapital(wallet), forceRefresh));

  let deepbookOrders = null;
  let predictPositions = null;
  if (withPositions) {
    const [{ deepbookAdapter }, { deepbookPredictAdapter }] = await Promise.all([
      import('./_lib/deepbook.js').catch(() => ({})),
      import('./_lib/deepbook-predict.js').catch(() => ({})),
    ]);
    const [ordersRes, posRes] = await Promise.allSettled([
      deepbookAdapter ? cached(`capital:orders:${wallet}`, 30_000, () => deepbookAdapter.getOpenOrders(wallet), forceRefresh) : Promise.reject(new Error('unavailable')),
      deepbookPredictAdapter ? cached(`capital:predict:${wallet}`, 30_000, () => deepbookPredictAdapter.getPositions(wallet), forceRefresh) : Promise.reject(new Error('unavailable')),
    ]);
    deepbookOrders = ordersRes.status === 'fulfilled'
      ? { orders: ordersRes.value, updatedAt: new Date().toISOString() }
      : { orders: null, note: 'DeepBook orders temporarily unavailable — balances above are unaffected.' };
    predictPositions = posRes.status === 'fulfilled'
      ? { ...(posRes.value || {}), note: undefined }
      : { positions: null, note: 'Predict positions temporarily unavailable — balances above are unaffected.' };
  }

  // suiAdapter.getCapital now returns direct data (unwrap envelope for compatibility)
  return {
    ...data,
    noDoubleCount: true,
    deepbookOrders,
    predictPositions,
  };
});
