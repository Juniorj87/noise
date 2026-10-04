// GET /api/capital?wallet=&refresh=true — real Sui RPC reads, 30s instance cache.
// Aggregation layer: wallet balances + stakes + (best-effort) DeepBook spot
// open orders + Predict positions. Position reads are provider-isolated:
// a dead provider yields a null section with a note, never a failed Capital.
// /api/notifications — GET list; POST create (in-app channel).
import { handler, readJson, requireQuery } from '../http.js';
import { isWalletAddress, uid } from '../services.js';
import { suiAdapter } from '../adapters.js';
import { cached, invalidateCache, withBreaker } from '../util.js';
import { getPool, ensureSchema } from '../pg.js';

export default handler(async (req, res, url) => {
  if (url.pathname === '/api/notifications') {
    if (req.method === 'POST') {
      const b = await readJson(req);
      if (!b.wallet || !b.title) return { error: 'INVALID_NOTIFICATION', message: 'wallet and title are required.', status: 400 };
      await ensureSchema();
      const id = uid('ntf');
      await getPool().query('INSERT INTO notifications (id, wallet, channel, title, body) VALUES ($1,$2,$3,$4,$5)',
        [id, b.wallet, b.channel || 'in-app', b.title, b.body || '']);
      return { id };
    }
    const wallet = requireQuery(url, 'wallet');
    await ensureSchema();
    const items = (await getPool().query('SELECT * FROM notifications WHERE wallet = $1 ORDER BY created_at DESC LIMIT 50', [wallet])).rows;
    return { items };
  }

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
      import('../deepbook.js').catch(() => ({})),
      import('../deepbook-predict.js').catch(() => ({})),
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

  return {
    ...data,
    noDoubleCount: true,
    deepbookOrders,
    predictPositions,
  };
});
