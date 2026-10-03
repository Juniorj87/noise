// DeepBook adapter (API mode) — real SDK surface verified against
// @mysten/deepbook-v3 2.6.x: midPrice, getLevel2TicksFromMid, poolBookParams,
// poolTradeParams, vaultBalances, getQuoteQuantityOut, accountOpenOrders,
// getOrderNormalized, getBalanceManagerIds, and tx builders deepBook.placeLimitOrder /
// placeMarketOrder / cancelOrder + balanceManager.createBalanceManagerWithOwner /
// shareBalanceManager. No invented methods, no fake data.
//
// SDK 2.6.x architecture (verified in node_modules source):
// - DeepBookClient keeps its DeepBookConfig PRIVATE (no c.config / c.getPool).
// - The constructor accepts `pools` and `balanceManagers` maps that are stored
//   in that config; tx builders resolve poolKey/balanceManagerKey through it.
// - Static deployments are exported as mainnetPools / testnetPools (24 mainnet
//   pools incl. SUI_USDC, DEEP_SUI, DEEP_USDC).
// - convertQuantity/convertPrice: Number input is scaled by the coin scalar,
//   BigInt input is used as the RAW on-chain u64. We pass human Numbers and
//   let the SDK scale — same path the SDK documents.
import { DeepBookClient, mainnetPools, testnetPools } from '@mysten/deepbook-v3';
import { Transaction } from '@mysten/sui/transactions';
import { sui, NETWORK } from './adapters.js';
import {
  validateLimitOrder, validateMarketOrder, estimateExecutionFromBook,
  makeClientOrderId, resolveOrderStatus, isOpenStatus,
} from '../../shared/deepbook-logic.js';

/** Static pool registry for the active network (SDK deployment constants). */
function poolsMap() {
  return NETWORK === 'testnet' ? (testnetPools || {}) : (mainnetPools || {});
}

/** Pool registry entry or a typed UNKNOWN_MARKET error. */
function poolEntry(market) {
  const pool = poolsMap()[market];
  if (!pool) {
    throw Object.assign(new Error('UNKNOWN_MARKET'), { code: 'UNKNOWN_MARKET' });
  }
  return pool;
}

function clientFor(address, balanceManagers) {
  return new DeepBookClient({
    client: sui.provider.rawClient(),
    address: address || '0x' + '0'.repeat(64),
    network: NETWORK,
    // Registered BalanceManagers keyed for the tx builders (balanceManagerKey).
    balanceManagers: balanceManagers || undefined,
  });
}

/** All pool keys configured for the active network. */
export function knownPoolKeys() {
  return Object.keys(poolsMap());
}

/** Throttled real-error logging so provider failures (e.g. RPC 429) are diagnosable. */
let loggedProviderErrors = 0;
function logProviderError(op, market, e) {
  if (loggedProviderErrors >= 5) return;
  loggedProviderErrors++;
  console.error(`[deepbook] ${op} ${market} failed: ${e?.message || e}`);
}

/**
 * Map with bounded concurrency + inter-start stagger. Multi-pool reads
 * (markets) hit the RPC dozens of times; a simultaneous burst trips the
 * public RPC rate limiter (HTTP 429), so starts are spaced out.
 */
async function mapLimit(items, limit, fn, staggerMs = 150) {
  const out = new Array(items.length);
  let i = 0;
  let lastStart = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      const wait = staggerMs - (Date.now() - lastStart);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastStart = Date.now();
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Retry once on RPC rate limiting (HTTP 429) after a short backoff. */
async function retryOn429(fn, delayMs = 1200) {
  try {
    return await fn();
  } catch (e) {
    if (String(e?.message || e).includes('429')) {
      await new Promise((r) => setTimeout(r, delayMs));
      return await fn();
    }
    throw e;
  }
}

/** Reference gas price, cached — presetting it lets txb.build skip the SDK's getCurrentSystemState RPC round-trip. */
let gasPriceCache = { at: 0, value: null };
async function referenceGasPrice() {
  const now = Date.now();
  if (gasPriceCache.value != null && now - gasPriceCache.at < 30_000) return gasPriceCache.value;
  const priceEnv = await sui.getReferenceGasPrice();
  const price = priceEnv.value;
  gasPriceCache = { at: now, value: price };
  return price;
}

/** Preset cached gas price, then build with 429 backoff → base64 tx bytes. */
async function finalizeTx(txb) {
  const price = await retryOn429(() => referenceGasPrice());
  if (price) {
    try {
      txb.setGasPrice(BigInt(price));
    } catch { /* builder falls back to network price */ }
  }
  const bytes = await retryOn429(() => txb.build({ client: sui.provider.rawClient() }));
  return Buffer.from(bytes).toString('base64');
}

export const deepbookAdapter = {
  id: 'deepbook',

  /**
   * All markets with live mid/best/spread. Pools failing live reads are
   * skipped honestly. Fees are per-market (getMarketInfo), not fetched here
   * to keep this list cheap (2 live reads per pool, bounded concurrency).
   */
  async getMarkets() {
    const c = clientFor();
    const entries = Object.entries(poolsMap());
    // One live read per pool (not two): the L1 snapshot already carries
    // best bid/ask, and mid = (bestBid + bestAsk) / 2 is the standard
    // market mid — honest and derived, flagged via midDerived.
    const rows = await mapLimit(entries, 3, async ([k, pool]) => {
      const book = await retryOn429(() => c.getLevel2TicksFromMid(k, 1)).catch((e) => {
        logProviderError('orderbook', k, e);
        return null;
      });
      const bestBid = book?.bid_prices?.[0] ?? null;
      const bestAsk = book?.ask_prices?.[0] ?? null;
      const twoSided = bestBid != null && bestAsk != null;
      return {
        market: k,
        poolAddress: pool.address,
        baseAsset: pool.baseCoin,
        quoteAsset: pool.quoteCoin,
        midPrice: twoSided ? (Number(bestBid) + Number(bestAsk)) / 2 : null,
        midDerived: twoSided,
        bestBid, bestAsk,
        spread: twoSided ? Number(bestAsk) - Number(bestBid) : null,
        updatedAt: new Date().toISOString(),
        source: 'DeepBook SDK (getLevel2TicksFromMid; mid = (bestBid + bestAsk) / 2)',
      };
    });
    // A pool whose live read failed is skipped, not shown with nulls.
    const live = rows.filter((r) => r.bestBid != null || r.bestAsk != null);
    if (!live.length) {
      throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE', status: 502 });
    }
    return live;
  },

  /** Real level-2 order book + derived best bid/ask/mid/spread. */
  async getOrderBook(market, ticks = 10) {
    poolEntry(market); // validates the market is configured before the chain read
    const c = clientFor();
    const t = Math.min(Math.max(1, Number(ticks) || 10), 25);
    const [book, mid] = await Promise.all([
      retryOn429(() => c.getLevel2TicksFromMid(market, t)),
      c.midPrice(market).catch(() => null),
    ]);
    const bestBid = book.bid_prices?.length ? book.bid_prices[0] : null;
    const bestAsk = book.ask_prices?.length ? book.ask_prices[0] : null;
    return {
      market,
      bids: (book.bid_prices || []).map((p, i) => [p, book.bid_quantities[i]]),
      asks: (book.ask_prices || []).map((p, i) => [p, book.ask_quantities[i]]),
      bestBid, bestAsk,
      midPrice: mid,
      spread: bestBid != null && bestAsk != null ? Number(bestAsk) - Number(bestBid) : null,
      updatedAt: new Date().toISOString(),
      source: 'DeepBook SDK (getLevel2TicksFromMid)',
    };
  },

  /** Pool trading params: tickSize, lotSize, minSize (real chain read). */
  async getMarketInfo(market) {
    const pool = poolEntry(market);
    const c = clientFor();
    const [book, trade, vault] = await Promise.all([
      retryOn429(() => c.poolBookParams(market)),
      c.poolTradeParams(market).catch(() => null),
      c.vaultBalances(market).catch(() => null),
    ]);
    return {
      market,
      poolAddress: pool.address,
      baseAsset: pool.baseCoin,
      quoteAsset: pool.quoteCoin,
      tickSize: book.tickSize,
      lotSize: book.lotSize,
      minOrderSize: book.minSize,
      takerFee: trade?.takerFee ?? null,
      makerFee: trade?.makerFee ?? null,
      liquidity: vault ? { base: vault.base, quote: vault.quote, deep: vault.deep } : null,
      updatedAt: new Date().toISOString(),
      source: 'DeepBook SDK (poolBookParams, poolTradeParams, vaultBalances)',
    };
  },

  /** Book-based execution estimate for the review screen (real order book, no invention). */
  async estimateMarketOrder({ market, side, quantity }) {
    const [book, info] = await Promise.all([
      this.getOrderBook(market, 20),
      this.getMarketInfo(market),
    ]);
    const est = estimateExecutionFromBook({ side, quantity, bids: book.bids, asks: book.asks, midPrice: book.midPrice });
    if (!est.ok) return est;
    const feeRate = side === 'BUY' || side === 'SELL' ? (info.takerFee ?? 0) : 0;
    return {
      ...est,
      market, side, quantity: Number(quantity),
      deepFee: feeRate != null ? feeRate * est.estimatedOutput : null,
      tickSize: info.tickSize, lotSize: info.lotSize, minOrderSize: info.minOrderSize,
      updatedAt: book.updatedAt,
    };
  },

  /** Wallet's BalanceManager ids (address strings, wallet-owned objects via SDK dry-run). */
  async getBalanceManagerIds(wallet) {
    const c = clientFor(wallet);
    return c.getBalanceManagerIds(wallet);
  },

  /** Real open orders for wallet (per BalanceManager) with normalized fields. */
  async getOpenOrders(wallet, market = null) {
    const c = clientFor(wallet);
    const managers = await c.getBalanceManagerIds(wallet).catch(() => []);
    const pools = market ? [market] : knownPoolKeys();
    const out = [];
    for (const pool of pools) {
      for (const mid of managers || []) {
        try {
          const ids = await retryOn429(() => c.accountOpenOrders(pool, mid), 800);
          for (const oid of ids || []) {
            const o = await c.getOrderNormalized(pool, String(oid)).catch(() => null);
            if (!o) continue;
            out.push({
              wallet, manager: mid, market: pool,
              orderId: String(o.order_id),
              side: o.isBid ? 'BUY' : 'SELL',
              type: 'LIMIT',
              price: o.normalized_price,
              quantity: o.quantity,
              filledQuantity: o.filled_quantity,
              remainingQuantity: String(Math.max(0, Number(o.quantity) - Number(o.filled_quantity))),
              status: resolveOrderStatus(o.status, o.filled_quantity),
              expireTimestamp: o.expire_timestamp,
              createdAt: null, // on-chain orders carry no timestamp; null, not invented
              updatedAt: new Date().toISOString(),
              source: 'DeepBook SDK (accountOpenOrders + getOrderNormalized)',
            });
          }
        } catch { /* per manager/pool failure must not kill the list */ }
      }
    }
    return out;
  },

  /** Single order status — resolves order state from the chain, never guesses. */
  async getOrderStatus(wallet, market, orderId) {
    poolEntry(market);
    const c = clientFor(wallet);
    const o = await c.getOrderNormalized(market, String(orderId)).catch(() => null);
    if (!o) return { market, orderId: String(orderId), orderStatus: 'UNKNOWN', onBook: false, note: 'Order not found on the book (filled, cancelled, or never existed).' };
    const status = resolveOrderStatus(o.status, o.filled_quantity);
    return {
      market, orderId: String(o.order_id), orderStatus: status, onBook: isOpenStatus(status),
      price: o.normalized_price, quantity: o.quantity, filledQuantity: o.filled_quantity,
      remainingQuantity: String(Math.max(0, Number(o.quantity) - Number(o.filled_quantity))),
      side: o.isBid ? 'BUY' : 'SELL',
      source: 'DeepBook SDK (getOrderNormalized)',
    };
  },

  /**
   * Build real market-order PTB. Uses SDK tx builder; BalanceManager required.
   * The manager is registered via the client constructor (SDK resolves
   * balanceManagerKey internally). Returns { txBytes, manager } — the wallet
   * signs, the backend never does.
   */
  async buildMarketOrder({ wallet, market, side, quantity, managerId }) {
    const info = await this.getMarketInfo(market);
    const v = validateMarketOrder({ quantity, lotSize: info.lotSize, minSize: info.minOrderSize });
    if (!v.ok) return { error: v.error };
    const managers = managerId ? [managerId] : await clientFor(wallet).getBalanceManagerIds(wallet).catch(() => []);
    if (!managers?.length) return { error: 'TRADING_ACCOUNT_REQUIRED' };
    const manager = managers[0];
    const c = clientFor(wallet, { hub: { address: manager } });
    const txb = new Transaction();
    txb.setSender(wallet);
    txb.add(c.deepBook.placeMarketOrder({
      poolKey: market,
      balanceManagerKey: 'hub',
      clientOrderId: BigInt(makeClientOrderId()),
      quantity: v.quantity, // human units — SDK scales by base-coin scalar
      isBid: side === 'BUY',
    }));
    const txBytes = await finalizeTx(txb);
    return { txBytes, clientOrderId: null, manager };
  },

  /** Build real limit-order PTB with tick/lot/min validation (integer math). */
  async buildLimitOrder({ wallet, market, side, price, quantity, managerId }) {
    const info = await this.getMarketInfo(market);
    const v = validateLimitOrder({ price, quantity, tickSize: info.tickSize, lotSize: info.lotSize, minSize: info.minOrderSize });
    if (!v.ok) return { error: v.error };
    const managers = managerId ? [managerId] : await clientFor(wallet).getBalanceManagerIds(wallet).catch(() => []);
    if (!managers?.length) return { error: 'TRADING_ACCOUNT_REQUIRED' };
    const manager = managers[0];
    const c = clientFor(wallet, { hub: { address: manager } });
    const txb = new Transaction();
    txb.setSender(wallet);
    txb.add(c.deepBook.placeLimitOrder({
      poolKey: market,
      balanceManagerKey: 'hub',
      clientOrderId: BigInt(makeClientOrderId()),
      price: v.price, // human units, tick-normalized — SDK converts to on-chain u64
      quantity: v.quantity,
      isBid: side === 'BUY',
    }));
    const txBytes = await finalizeTx(txb);
    return {
      txBytes,
      normalized: { price: v.price, quantity: v.quantity }, manager,
      poolParams: { tickSize: info.tickSize, lotSize: info.lotSize, minOrderSize: info.minOrderSize },
    };
  },

  /** Build real cancel-order PTB. */
  async buildCancelOrder({ wallet, market, orderId, managerId }) {
    poolEntry(market);
    const managers = managerId ? [managerId] : await clientFor(wallet).getBalanceManagerIds(wallet).catch(() => []);
    if (!managers?.length) return { error: 'TRADING_ACCOUNT_REQUIRED' };
    const manager = managers[0];
    const c = clientFor(wallet, { hub: { address: manager } });
    const txb = new Transaction();
    txb.setSender(wallet);
    txb.add(c.deepBook.cancelOrder(market, 'hub', String(orderId)));
    const txBytes = await finalizeTx(txb);
    return { txBytes, manager };
  },

  /**
   * Build "Set up trading account" PTB: create BalanceManager (shared) owned by wallet.
   * Standard flow: build → simulate → wallet sign → execute.
   */
  async buildTradingAccountSetup({ wallet }) {
    const c = clientFor(wallet);
    const txb = new Transaction();
    txb.setSender(wallet);
    const mgr = txb.add(c.balanceManager.createBalanceManagerWithOwner(wallet));
    txb.add(c.balanceManager.shareBalanceManager(mgr));
    const txBytes = await finalizeTx(txb);
    return { txBytes };
  },
};
