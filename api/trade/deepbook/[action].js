// GET/POST /api/trade/deepbook/<action> — DeepBook V3 trading routes (spec §9).
// Reads (markets, orderbook, orders, status) are live chain reads. Mutating
// routes only BUILD unsigned PTBs — the wallet signs, the backend never does
// (spec §5). Order records in Postgres are server-side bookkeeping; the chain
// is authoritative for order state.
import { handler, readJson, requireQuery } from '../../_lib/http.js';
import { deepbookAdapter } from '../../_lib/deepbook.js';
import {
  upsertDeepbookOrder, listDeepbookOrders, getDeepbookOrder,
} from '../../_lib/deepbook-db.js';
import { isWalletAddress, isValidDigest, REFERRAL_POLICIES } from '../../_lib/services.js';
import { simulate } from '../../_lib/adapters.js';
import { cached, withBreaker } from '../../_lib/util.js';
import { dbConfigured } from '../../_lib/pg.js';
import { isOpenStatus } from '../../../shared/deepbook-logic.js';
import { calculateFeeBreakdown } from '../../_lib/fee-engine.js';

function err(code, message, status = 400) {
  return { error: code, message, status };
}

function checkWallet(w) {
  if (!isWalletAddress(w)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  return w;
}

/** Hub fee preview for the review screen using unified fee engine. */
async function tradeFeePreview(notionalUsd, action, provider, instrument) {
  const feeBreakdown = await calculateFeeBreakdown({
    protocolFee: '0', // DeepBook fees are on-chain in the pool
    providerFee: '0',
    networkFee: '0.01', // Estimated gas
    action,
    provider,
    instrument,
    amount: String(notionalUsd || 0),
    asset: 'USDC',
  });
  return {
    ...feeBreakdown,
    note: 'DeepBook taker/maker fees are read per-market (poolTradeParams) and paid on-chain to the pool vault; hub fee is a separate platform bps. Referral allocation: from platform revenue only, not an extra user fee.',
  };
}

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').pop();

  /* ---------- live reads (cached) ---------- */

  if (action === 'markets') {
    try {
      const markets = await withBreaker('deepbook', () => cached('dbv3:markets', 20_000, () => deepbookAdapter.getMarkets()));
      return { markets, updatedAt: new Date().toISOString(), source: 'DeepBook SDK (midPrice, getLevel2TicksFromMid)' };
    } catch (e) {
      return err('PROVIDER_UNAVAILABLE', 'DeepBook markets temporarily unreachable — try again shortly.', 502);
    }
  }

  if (action === 'orderbook') {
    const market = (url.searchParams.get('market') || url.searchParams.get('pool') || 'SUI_USDC').toUpperCase();
    const ticks = Number(url.searchParams.get('ticks') || 10);
    try {
      const book = await withBreaker('deepbook', () => cached(`dbv3:ob:${market}:${ticks}`, 10_000, () => deepbookAdapter.getOrderBook(market, ticks)));
      return book;
    } catch (e) {
      return err(e.code === 'PROVIDER_TIMEOUT' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', 'Order book unavailable for ' + market + ' — DeepBook RPC unreachable or market not found.', 502);
    }
  }

  if (action === 'info') {
    const market = (url.searchParams.get('market') || 'SUI_USDC').toUpperCase();
    try {
      return await withBreaker('deepbook', () => cached(`dbv3:info:${market}`, 30_000, () => deepbookAdapter.getMarketInfo(market)));
    } catch (e) {
      return err('PROVIDER_UNAVAILABLE', 'Market info unavailable for ' + market + '.', 502);
    }
  }

  if (action === 'estimate') {
    const market = (url.searchParams.get('market') || 'SUI_USDC').toUpperCase();
    const side = (url.searchParams.get('side') || 'BUY').toUpperCase();
    const quantity = url.searchParams.get('quantity');
    if (!['BUY', 'SELL'].includes(side)) return err('INVALID_REQUEST', 'side must be BUY or SELL.');
    if (!(Number(quantity) > 0)) return err('INVALID_REQUEST', 'quantity must be a positive number.');
    try {
      const est = await withBreaker('deepbook', () => cached(`dbv3:est:${market}:${side}:${quantity}`, 8_000, () => deepbookAdapter.estimateMarketOrder({ market, side, quantity })));
      if (!est.ok) return err('NO_BOOK_DATA', 'Not enough resting liquidity on the book to estimate this order honestly.', 422);
      return est;
    } catch (e) {
      return err('PROVIDER_UNAVAILABLE', 'Estimate unavailable — DeepBook RPC unreachable.', 502);
    }
  }

  if (action === 'orders') {
    const wallet = checkWallet(requireQuery(url, 'wallet'));
    const market = url.searchParams.get('market') ? url.searchParams.get('market').toUpperCase() : null;
    const openOnly = url.searchParams.get('openOnly') === 'true';
    const live = url.searchParams.get('live') === 'true';
    // Persistence is best-effort: without DATABASE_URL (local dev) the
    // chain read still works and the recorded view is honestly empty.
    const recorded = dbConfigured()
      ? await listDeepbookOrders({ wallet, market, openOnly }).catch(() => [])
      : [];
    if (!live) {
      return { orders: recorded, source: 'hub-db (chain-refreshed by tracker; use live=true for a synchronous chain read)', updatedAt: new Date().toISOString() };
    }
    const chainOrders = await withBreaker('deepbook', () => deepbookAdapter.getOpenOrders(wallet, market)).catch(() => null);
    if (!chainOrders) return err('PROVIDER_UNAVAILABLE', 'Live order query failed — DeepBook RPC unreachable.', 502);
    const managerIds = await deepbookAdapter.getBalanceManagerIds(wallet).catch(() => []);
    const managerKnown = Array.isArray(managerIds) && managerIds.length > 0;
    // Merge: record chain state into the DB (upsert) and return the chain view.
    for (const o of chainOrders) {
      await upsertDeepbookOrder({ wallet: o.wallet, market: o.market, orderId: o.orderId, side: o.side, type: o.type, price: o.price, quantity: o.quantity, filledQuantity: o.filledQuantity, status: o.status }).catch(() => {});
    }
    return { orders: chainOrders, managerKnown, managers: managerIds, source: 'DeepBook SDK (accountOpenOrders + getOrderNormalized)', updatedAt: new Date().toISOString() };
  }

  if (action === 'status') {
    const market = (url.searchParams.get('market') || '').toUpperCase();
    const orderId = url.searchParams.get('orderId');
    const digest = url.searchParams.get('digest');
    try {
      if (digest) {
        if (!isValidDigest(digest)) return err('INVALID_DIGEST', 'digest must be a Sui transaction digest.');
      } else if (!market || !orderId) {
        return err('INVALID_REQUEST', 'Provide market+orderId, or a tx digest.');
      }
      if (market && orderId) {
        const st = await withBreaker('deepbook', () => deepbookAdapter.getOrderStatus(checkWallet(url.searchParams.get('wallet') || '0x' + '0'.repeat(64)), market, orderId));
        const row = digest ? null : await getDeepbookOrder(url.searchParams.get('wallet') || '', market, orderId).catch(() => null);
        return { ...st, recorded: row || null, explorerUrl: digest ? `https://suiscan.xyz/mainnet/tx/${digest}` : null };
      }
      return { error: 'INVALID_REQUEST', message: 'Provide market+orderId (digest-only lookup arrives with the tx tracker).', status: 400 };
    } catch (e) {
      if (e.code === 'INVALID_WALLET') return err('INVALID_WALLET', 'wallet must be a valid 0x… address.');
      return err('PROVIDER_UNAVAILABLE', 'Order status unavailable — DeepBook RPC unreachable.', 502);
    }
  }

  /* ---------- tx builders (POST; wallet signs, backend never does) ---------- */

  if (req.method !== 'POST') return err('INVALID_REQUEST', 'POST required for build/cancel/setup.', 400);

  const b = await readJson(req);

  if (action === 'build') {
    const wallet = checkWallet(b.wallet);
    const market = String(b.market || '').toUpperCase();
    const side = String(b.side || '').toUpperCase();
    const type = String(b.type || 'MARKET').toUpperCase();
    if (!market) return err('INVALID_BUILD_REQUEST', 'market is required (e.g. SUI_USDC).');
    if (!['BUY', 'SELL'].includes(side)) return err('INVALID_BUILD_REQUEST', 'side must be BUY or SELL.');
    if (!['MARKET', 'LIMIT'].includes(type)) return err('INVALID_BUILD_REQUEST', 'type must be MARKET or LIMIT.');

    const built = type === 'LIMIT'
      ? await deepbookAdapter.buildLimitOrder({ wallet, market, side, price: b.price, quantity: b.quantity, managerId: b.managerId })
      : await deepbookAdapter.buildMarketOrder({ wallet, market, side, quantity: b.quantity, managerId: b.managerId });
    if (built.error) {
      const map = {
        TRADING_ACCOUNT_REQUIRED: ['TRADING_ACCOUNT_REQUIRED', 'No DeepBook BalanceManager found for this wallet. Create one first (Set up trading account), then place orders.', 422],
        BELOW_MIN_ORDER_SIZE: ['BELOW_MIN_ORDER_SIZE', 'Quantity is below the market minimum order size — increase the amount.', 400],
        INVALID_PRICE: ['INVALID_PRICE', 'Price is invalid or off the market tick grid.', 400],
        INVALID_QUANTITY: ['INVALID_QUANTITY', 'Quantity is invalid or below one lot.', 400],
        INVALID_TICK_SIZE: ['INVALID_TICK_SIZE', 'Market params unreadable — try again shortly.', 502],
        INVALID_LOT_SIZE: ['INVALID_LOT_SIZE', 'Market params unreadable — try again shortly.', 502],
      };
      const m = map[built.error] || [built.error, 'Order could not be built — nothing was signed or sent.', 400];
      return err(m[0], m[1], m[2]);
    }

    // devInspect sim-gate (same safety flow as swap): the wallet is only
    // prompted after an on-chain dry run passes.
    const sim = await simulate(built.txBytes, wallet).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
    let gasEst = null;
    if (sim && sim.effects && sim.effects.gasUsed) {
      const gu = sim.effects.gasUsed;
      gasEst = String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0)));
    }
    const simOk = sim && sim.effects && sim.effects.status && sim.effects.status.status === 'success';

    // Fee preview for the review screen using unified fee engine.
    const notional = Number(b.notionalUsd) || (Number(b.quantity) || 0) * (Number(b.price) || 0);
    const fee = await tradeFeePreview(notional, type === 'MARKET' ? 'market_order' : 'limit_order', 'deepbook', market);

    return {
      ok: true,
      txBytes: built.txBytes,
      manager: built.manager,
      clientOrderId: built.clientOrderId || null,
      normalized: built.normalized || null,
      poolParams: built.poolParams || null,
      simulation: sim,
      simulationStatus: simOk ? 'success' : (sim.error ? 'unavailable' : 'failed'),
      simulationDetail: !simOk && sim.error ? String(sim.detail || '').slice(0, 200) : null,
      gasEst,
      fees: fee,
      referralPolicy: REFERRAL_POLICIES['deepbook'] || null,
      note: 'Unsigned PTB — review in your wallet. DeepBook taker/maker fees are charged by the pool on-chain (per-market); nothing is signed or sent by the hub.',
    };
  }

  if (action === 'cancel') {
    const wallet = checkWallet(b.wallet);
    const market = String(b.market || '').toUpperCase();
    if (!market || !b.orderId) return err('INVALID_BUILD_REQUEST', 'market and orderId are required.');
    const built = await deepbookAdapter.buildCancelOrder({ wallet, market, orderId: b.orderId, managerId: b.managerId });
    if (built.error) {
      if (built.error === 'TRADING_ACCOUNT_REQUIRED') {
        return err('TRADING_ACCOUNT_REQUIRED', 'No DeepBook BalanceManager found for this wallet.', 422);
      }
      return err(built.error, 'Cancel order could not be built — nothing was signed or sent.', 400);
    }
    return { ok: true, txBytes: built.txBytes, manager: built.manager, note: 'Unsigned cancel PTB — the wallet signs.' };
  }

  if (action === 'setup') {
    const wallet = checkWallet(b.wallet);
    const built = await deepbookAdapter.buildTradingAccountSetup({ wallet });
    return {
      ok: true,
      txBytes: built.txBytes,
      note: 'Creates and shares a DeepBook BalanceManager owned by your wallet. One-time setup; orders are then placed through this manager. The wallet signs — the hub never custodies.',
    };
  }

  if (action === 'record') {
    // After wallet signature: record the placed order (bookkeeping only).
    const wallet = checkWallet(b.wallet);
    const market = String(b.market || '').toUpperCase();
    const side = String(b.side || '').toUpperCase();
    if (!market || !['BUY', 'SELL'].includes(side) || !(Number(b.quantity) > 0)) {
      return err('INVALID_REQUEST', 'wallet, market, side (BUY|SELL) and positive quantity are required.');
    }
    if (b.digest && !isValidDigest(b.digest)) return err('INVALID_DIGEST', 'digest must be a Sui transaction digest.');
    let row = null;
    if (dbConfigured()) {
      row = await upsertDeepbookOrder({
        wallet, market,
        orderId: b.orderId ? String(b.orderId) : null,
        side, type: String(b.type || 'LIMIT').toUpperCase(),
        price: b.price ?? null, quantity: b.quantity,
        filledQuantity: b.filledQuantity ?? 0,
        status: isOpenStatus(b.status) ? b.status : 'OPEN',
        txDigest: b.digest || null,
      }).catch(() => null);
    }
    return {
      ok: true,
      order: row,
      recorded: Boolean(row),
      note: row
        ? 'Recorded. Chain remains authoritative; the tracker refreshes fills/status.'
        : 'Not persisted (no DATABASE_URL on this deployment). Chain remains authoritative.',
    };
  }

  return err('NOT_FOUND', 'Unknown DeepBook trade action.', 404);
}, { limit: 120 });
