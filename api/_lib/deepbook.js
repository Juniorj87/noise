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
//
// Mainnet deployment note: mainnet now runs DeepBook core v9
// (0xbca0cefe…). The installed SDK still ships the v8 id, so we override the
// package id and pass the merged coin/pool maps (the SDK requires both when
// `packageIds` is supplied). Public signatures are unchanged between v8 and v9.
// HBTC_USDC (Hashi BTC) is the newest mainnet pool; the installed constants
// predate it, so its coin and pool are registered here from the upstream
// deployment record (scalar 1e8, pool 0x61368ab9…).
import {
  DeepBookClient, mainnetPools, testnetPools,
  mainnetCoins, testnetCoins, mainnetPackageIds,
} from '@mysten/deepbook-v3';
import { Transaction } from '@mysten/sui/transactions';
import { sui, NETWORK } from './adapters.js';
import {
  validateLimitOrder, validateMarketOrder, estimateExecutionFromBook,
  makeClientOrderId, resolveOrderStatus, isOpenStatus,
} from '../../shared/deepbook-logic.js';

/** Mainnet DeepBook core v9 (upstream deployment record). */
const MAINNET_DEEPBOOK_PACKAGE_ID =
  '0xbca0cefe720330e7bb4f2283438b68de6a0e656688db4ac90d61e71fe6151fe8';

/** Newest mainnet coin/pool not present in the installed SDK constants. */
const MAINNET_EXTRA_COINS = {
  HBTC: {
    address: '0xd30fb3f8914efdbeb7b8e85fae1d65dc584b44a1281f66737b92bb9f03a59d06',
    type: '0xd30fb3f8914efdbeb7b8e85fae1d65dc584b44a1281f66737b92bb9f03a59d06::btc::BTC',
    scalar: 100000000,
  },
};
const MAINNET_EXTRA_POOLS = {
  HBTC_USDC: {
    address: '0x61368ab907934d7840d2e639b7fc2ee74785ffe3d46427d70e1ab8545f320c9b',
    baseCoin: 'HBTC',
    quoteCoin: 'USDC',
  },
};

/** Static pool registry for the active network (SDK deployment constants). */
function poolsMap() {
  if (NETWORK === 'testnet') return testnetPools || {};
  return { ...(mainnetPools || {}), ...MAINNET_EXTRA_POOLS };
}

function coinsMap() {
  if (NETWORK === 'testnet') return testnetCoins || {};
  return { ...(mainnetCoins || {}), ...MAINNET_EXTRA_COINS };
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
  const base = {
    client: sui.provider.rawClient(),
    address: address || '0x' + '0'.repeat(64),
    network: NETWORK,
    // Registered BalanceManagers keyed for the tx builders (balanceManagerKey).
    balanceManagers: balanceManagers || undefined,
  };
  // Supplying packageIds makes the SDK ignore its default coin/pool maps, so
  // both merged maps must be passed alongside it.
  if (NETWORK === 'testnet') return new DeepBookClient(base);
  return new DeepBookClient({
    ...base,
    packageIds: { ...mainnetPackageIds, DEEPBOOK_PACKAGE_ID: MAINNET_DEEPBOOK_PACKAGE_ID },
    coins: coinsMap(),
    pools: poolsMap(),
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

/** Manager ids for a wallet, or an explicit one when supplied. */
async function resolveManagers(wallet, managerId) {
  if (managerId) return [managerId];
  return (await clientFor(wallet).getBalanceManagerIds(wallet).catch(() => [])) || [];
}

/** Client with the manager registered under the 'hub' key, or a typed error. */
async function managerBuiltClient(wallet, managerId) {
  const managers = await resolveManagers(wallet, managerId);
  if (!managers.length) {
    return { error: 'TRADING_ACCOUNT_REQUIRED' };
  }
  const manager = managers[0];
  return { client: clientFor(wallet, { hub: { address: manager } }), manager };
}

function positiveAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
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

  /**
   * Full pool state beyond the trading header: next-epoch trade params,
   * governance quorum, registry flags and the pool DEEP price. Every field is
   * a live read; failures are returned as null, never invented.
   */
  async getPoolInfo(market) {
    const pool = poolEntry(market);
    const c = clientFor();
    const [book, trade, tradeNext, vault, stable, whitelisted, registered, quorum, deepPrice] = await Promise.all([
      retryOn429(() => c.poolBookParams(market)),
      c.poolTradeParams(market).catch(() => null),
      c.poolTradeParamsNext(market).catch(() => null),
      c.vaultBalances(market).catch(() => null),
      c.stablePool(market).catch(() => null),
      c.whitelisted(market).catch(() => null),
      c.registeredPool(market).catch(() => null),
      c.quorum(market).catch(() => null),
      c.getPoolDeepPrice(market).catch(() => null),
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
      stakeRequired: trade?.stakeRequired ?? null,
      nextEpoch: tradeNext
        ? { takerFee: tradeNext.takerFee, makerFee: tradeNext.makerFee, stakeRequired: tradeNext.stakeRequired }
        : null,
      liquidity: vault ? { base: vault.base, quote: vault.quote, deep: vault.deep } : null,
      stablePool: stable,
      whitelisted,
      registeredPool: registered,
      quorum,
      deepPrice: deepPrice ?? null,
      updatedAt: new Date().toISOString(),
      source: 'DeepBook SDK (poolBookParams, poolTradeParams, poolTradeParamsNext, vaultBalances, stablePool, whitelisted, registeredPool, quorum, getPoolDeepPrice)',
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

  /**
   * BalanceManager capital + per-pool account state: manager balances,
   * settled/unclaimed/owed balances, locked amounts, volume and stake.
   * Reads only; a wallet with no manager returns an empty list.
   */
  async getAccount({ wallet, market = 'SUI_USDC', managerId = null }) {
    const poolKey = poolsMap()[market] ? market : 'SUI_USDC';
    const pool = poolsMap()[poolKey];
    const c = clientFor(wallet);
    const managers = await resolveManagers(wallet, managerId);
    if (!managers.length) {
      return {
        wallet, market: poolKey, managers: [], balances: {}, accounts: [],
        accountExists: false, note: 'No DeepBook trading account (BalanceManager) for this wallet yet.',
        updatedAt: new Date().toISOString(),
      };
    }
    const knownCoins = coinsMap();
    const coinKeys = [...new Set([pool.baseCoin, pool.quoteCoin, 'SUI', 'USDC', 'DEEP'])]
      .filter((k) => knownCoins[k]);
    const balances = await c.checkManagerBalancesWithAddress(managers, coinKeys).catch(() => null);
    const accounts = [];
    for (const manager of managers) {
      const mc = clientFor(wallet, { hub: { address: manager } });
      const [account, locked] = await Promise.all([
        mc.account(poolKey, 'hub').catch(() => null),
        mc.lockedBalance(poolKey, 'hub').catch(() => null),
      ]);
      const exists = await mc.accountExists(poolKey, 'hub').catch(() => null);
      accounts.push({ manager, accountExists: exists, account, locked });
    }
    return {
      wallet,
      market: poolKey,
      managers,
      balances: balances || {},
      accounts,
      accountExists: accounts.some((a) => a.accountExists === true),
      updatedAt: new Date().toISOString(),
      source: 'DeepBook SDK (checkManagerBalancesWithAddress, account, lockedBalance, accountExists)',
    };
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

  /** DEEP required to place an order at this size/price (taker and maker). */
  async getOrderDeepRequired(market, quantity, price) {
    poolEntry(market);
    const c = clientFor();
    const r = await c.getOrderDeepRequired(market, Number(quantity), Number(price));
    return {
      market, quantity: Number(quantity), price: Number(price),
      deepRequiredTaker: r.deepRequiredTaker,
      deepRequiredMaker: r.deepRequiredMaker,
      source: 'DeepBook SDK (getOrderDeepRequired)',
    };
  },

  /**
   * Build real market-order PTB. Uses SDK tx builder; BalanceManager required.
   * The manager is registered via the client constructor (SDK resolves
   * balanceManagerKey internally). Returns { txBytes, manager } — the wallet
   * signs, the backend never does.
   */
  async buildMarketOrder({ wallet, market, side, quantity, managerId, payWithDeep = true }) {
    const info = await this.getMarketInfo(market);
    const v = validateMarketOrder({ quantity, lotSize: info.lotSize, minSize: info.minOrderSize });
    if (!v.ok) return { error: v.error };
    const built = await managerBuiltClient(wallet, managerId);
    if (built.error) return { error: built.error };
    const { client: c, manager } = built;
    const txb = new Transaction();
    txb.setSender(wallet);
    txb.add(c.deepBook.placeMarketOrder({
      poolKey: market,
      balanceManagerKey: 'hub',
      clientOrderId: BigInt(makeClientOrderId()),
      quantity: v.quantity, // human units — SDK scales by base-coin scalar
      isBid: side === 'BUY',
      payWithDeep: payWithDeep !== false,
    }));
    const txBytes = await finalizeTx(txb);
    return { txBytes, clientOrderId: null, manager };
  },

  /** Build real limit-order PTB with tick/lot/min validation (integer math). */
  async buildLimitOrder({ wallet, market, side, price, quantity, managerId, payWithDeep = true, expiration = null }) {
    const info = await this.getMarketInfo(market);
    const v = validateLimitOrder({ price, quantity, tickSize: info.tickSize, lotSize: info.lotSize, minSize: info.minOrderSize });
    if (!v.ok) return { error: v.error };
    const built = await managerBuiltClient(wallet, managerId);
    if (built.error) return { error: built.error };
    const { client: c, manager } = built;
    const txb = new Transaction();
    txb.setSender(wallet);
    const params = {
      poolKey: market,
      balanceManagerKey: 'hub',
      clientOrderId: BigInt(makeClientOrderId()),
      price: v.price, // human units, tick-normalized — SDK converts to on-chain u64
      quantity: v.quantity,
      isBid: side === 'BUY',
      payWithDeep: payWithDeep !== false,
    };
    if (expiration != null) params.expiration = BigInt(expiration);
    txb.add(c.deepBook.placeLimitOrder(params));
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
    const built = await managerBuiltClient(wallet, managerId);
    if (built.error) return { error: built.error };
    const { client: c, manager } = built;
    const txb = new Transaction();
    txb.setSender(wallet);
    txb.add(c.deepBook.cancelOrder(market, 'hub', String(orderId)));
    const txBytes = await finalizeTx(txb);
    return { txBytes, manager };
  },

  /**
   * Cancel one, many, or every open order in a pool. `cancelLive*` is used by
   * default: unknown/filled ids are skipped instead of aborting the whole PTB.
   */
  async buildCancelOrders({ wallet, market, orderIds = [], all = false, managerId, live = true }) {
    poolEntry(market);
    if (!all && (!Array.isArray(orderIds) || !orderIds.length)) return { error: 'ORDER_IDS_REQUIRED' };
    const built = await managerBuiltClient(wallet, managerId);
    if (built.error) return { error: built.error };
    const { client: c, manager } = built;
    const txb = new Transaction();
    txb.setSender(wallet);
    if (all) {
      txb.add(c.deepBook.cancelAllOrders(market, 'hub'));
    } else if (orderIds.length === 1) {
      txb.add(live
        ? c.deepBook.cancelLiveOrder(market, 'hub', String(orderIds[0]))
        : c.deepBook.cancelOrder(market, 'hub', String(orderIds[0])));
    } else {
      const ids = orderIds.map((id) => String(id));
      txb.add(live
        ? c.deepBook.cancelLiveOrders(market, 'hub', ids)
        : c.deepBook.cancelOrders(market, 'hub', ids));
    }
    const txBytes = await finalizeTx(txb);
    return { txBytes, manager, cancelled: all ? 'ALL' : orderIds.length };
  },

  /** Modify an existing order's quantity (real tx builder). */
  async buildModifyOrder({ wallet, market, orderId, quantity, managerId }) {
    poolEntry(market);
    if (!orderId) return { error: 'ORDER_ID_REQUIRED' };
    const info = await this.getMarketInfo(market);
    const v = validateMarketOrder({ quantity, lotSize: info.lotSize, minSize: info.minOrderSize });
    if (!v.ok) return { error: v.error };
    const built = await managerBuiltClient(wallet, managerId);
    if (built.error) return { error: built.error };
    const { client: c, manager } = built;
    const txb = new Transaction();
    txb.setSender(wallet);
    txb.add(c.deepBook.modifyOrder(market, 'hub', String(orderId), v.quantity));
    const txBytes = await finalizeTx(txb);
    return { txBytes, manager, normalized: { quantity: v.quantity } };
  },

  /** Withdraw settled amounts (fills that settled into the manager) back into it. */
  async buildWithdrawSettled({ wallet, market, managerId }) {
    poolEntry(market);
    const built = await managerBuiltClient(wallet, managerId);
    if (built.error) return { error: built.error };
    const { client: c, manager } = built;
    const txb = new Transaction();
    txb.setSender(wallet);
    txb.add(c.deepBook.withdrawSettledAmounts(market, 'hub'));
    const txBytes = await finalizeTx(txb);
    return { txBytes, manager };
  },

  /** Claim maker rebates accumulated in the pool for this manager. */
  async buildClaimRebates({ wallet, market, managerId }) {
    poolEntry(market);
    const built = await managerBuiltClient(wallet, managerId);
    if (built.error) return { error: built.error };
    const { client: c, manager } = built;
    const txb = new Transaction();
    txb.setSender(wallet);
    txb.add(c.deepBook.claimRebates(market, 'hub'));
    const txBytes = await finalizeTx(txb);
    return { txBytes, manager };
  },

  /** Deposit wallet coins into the manager (owner operation). */
  async buildDeposit({ wallet, managerId, coin, amount }) {
    const value = positiveAmount(amount);
    if (!value) return { error: 'INVALID_AMOUNT' };
    const coinKey = String(coin || '').toUpperCase();
    if (!coinsMap()[coinKey]) return { error: 'UNSUPPORTED_COIN' };
    const built = await managerBuiltClient(wallet, managerId);
    if (built.error) return { error: built.error };
    const { client: c, manager } = built;
    const txb = new Transaction();
    txb.setSender(wallet);
    txb.add(c.balanceManager.depositIntoManager('hub', coinKey, value));
    const txBytes = await finalizeTx(txb);
    return { txBytes, manager, coin: coinKey, amount: value };
  },

  /** Withdraw an amount (or everything) from the manager to the wallet. */
  async buildWithdraw({ wallet, managerId, coin, amount, all = false, recipient = null }) {
    const coinKey = String(coin || '').toUpperCase();
    if (!coinsMap()[coinKey]) return { error: 'UNSUPPORTED_COIN' };
    const value = all ? null : positiveAmount(amount);
    if (!all && !value) return { error: 'INVALID_AMOUNT' };
    const built = await managerBuiltClient(wallet, managerId);
    if (built.error) return { error: built.error };
    const { client: c, manager } = built;
    const to = recipient || wallet;
    const txb = new Transaction();
    txb.setSender(wallet);
    if (all) {
      txb.add(c.balanceManager.withdrawAllFromManager('hub', coinKey, to));
    } else {
      txb.add(c.balanceManager.withdrawFromManager('hub', coinKey, value, to));
    }
    const txBytes = await finalizeTx(txb);
    return { txBytes, manager, coin: coinKey, amount: all ? 'ALL' : value, recipient: to };
  },

  /** Mint a pool referral with a fee multiplier (0.1–2.0, steps of 0.1). */
  async buildMintReferral({ wallet, market, multiplier }) {
    poolEntry(market);
    const m = Number(multiplier);
    if (!Number.isFinite(m) || m < 0.1 || m > 2 || Math.round(m * 10) !== m * 10) {
      return { error: 'INVALID_MULTIPLIER' };
    }
    const c = clientFor(wallet);
    const txb = new Transaction();
    txb.setSender(wallet);
    txb.add(c.deepBook.mintReferral(market, m));
    const txBytes = await finalizeTx(txb);
    return { txBytes, market, multiplier: m };
  },

  /** Point this wallet's manager at an existing pool referral (or clear it). */
  async buildSetReferral({ wallet, market, managerId, referral = null }) {
    poolEntry(market);
    const built = await managerBuiltClient(wallet, managerId);
    if (built.error) return { error: built.error };
    const { client: c, manager } = built;
    const txb = new Transaction();
    txb.setSender(wallet);
    const tradeCap = txb.add(c.balanceManager.mintTradeCap('hub'));
    if (referral) {
      txb.add(c.balanceManager.setBalanceManagerReferral('hub', String(referral), tradeCap));
    } else {
      txb.add(c.balanceManager.unsetBalanceManagerReferral('hub', market, tradeCap));
    }
    const txBytes = await finalizeTx(txb);
    return { txBytes, manager, referral: referral || null };
  },

  /** Update the multiplier on a referral this wallet owns. */
  async buildUpdateReferralMultiplier({ wallet, market, referral, multiplier }) {
    poolEntry(market);
    const m = Number(multiplier);
    if (!referral) return { error: 'REFERRAL_REQUIRED' };
    if (!Number.isFinite(m) || m < 0.1 || m > 2 || Math.round(m * 10) !== m * 10) {
      return { error: 'INVALID_MULTIPLIER' };
    }
    const c = clientFor(wallet);
    const txb = new Transaction();
    txb.setSender(wallet);
    txb.add(c.deepBook.updatePoolReferralMultiplier(market, String(referral), m));
    const txBytes = await finalizeTx(txb);
    return { txBytes, market, referral: String(referral), multiplier: m };
  },

  /** Claim a referral's rewards and send the three coins to the wallet. */
  async buildClaimReferralRewards({ wallet, market, referral }) {
    poolEntry(market);
    if (!referral) return { error: 'REFERRAL_REQUIRED' };
    const c = clientFor(wallet);
    const txb = new Transaction();
    txb.setSender(wallet);
    const rewards = txb.add(c.deepBook.claimPoolReferralRewards(market, String(referral)));
    txb.transferObjects([rewards.baseRewards, rewards.quoteRewards, rewards.deepRewards], wallet);
    const txBytes = await finalizeTx(txb);
    return { txBytes, market, referral: String(referral) };
  },

  /** Pool referral read: id attached to the manager, balances and multiplier. */
  async getReferral({ wallet, market = 'SUI_USDC', managerId = null, referral = null }) {
    poolEntry(market);
    const built = await managerBuiltClient(wallet, managerId);
    if (built.error) return { wallet, market, ...built, referralId: null };
    const { client: c, manager } = built;
    const referralId = referral || await c.getBalanceManagerReferralId('hub', market).catch(() => null);
    if (!referralId) {
      return {
        wallet, market, manager, referralId: null, balances: null, multiplier: null,
        note: 'This manager has no referral set for the pool. Mint one, then set it on the manager.',
        updatedAt: new Date().toISOString(),
      };
    }
    const [balances, multiplier] = await Promise.all([
      c.getPoolReferralBalances(market, referralId).catch(() => null),
      c.poolReferralMultiplier(market, referralId).catch(() => null),
    ]);
    return {
      wallet, market, manager, referralId, balances, multiplier,
      updatedAt: new Date().toISOString(),
      source: 'DeepBook SDK (getBalanceManagerReferralId, getPoolReferralBalances, poolReferralMultiplier)',
    };
  },

  /** Stake DEEP inside this pool for fee/rebate benefits (governance weight). */
  async buildStake({ wallet, market, amount, managerId }) {
    poolEntry(market);
    const value = positiveAmount(amount);
    if (!value) return { error: 'INVALID_AMOUNT' };
    const built = await managerBuiltClient(wallet, managerId);
    if (built.error) return { error: built.error };
    const { client: c, manager } = built;
    const txb = new Transaction();
    txb.setSender(wallet);
    txb.add(c.governance.stake(market, 'hub', value));
    const txBytes = await finalizeTx(txb);
    return { txBytes, manager, amount: value };
  },

  /** Unstake DEEP from this pool. */
  async buildUnstake({ wallet, market, managerId }) {
    poolEntry(market);
    const built = await managerBuiltClient(wallet, managerId);
    if (built.error) return { error: built.error };
    const { client: c, manager } = built;
    const txb = new Transaction();
    txb.setSender(wallet);
    txb.add(c.governance.unstake(market, 'hub'));
    const txBytes = await finalizeTx(txb);
    return { txBytes, manager };
  },

  /** Pool quote for a direct swap: output plus the DEEP fee the pool takes. */
  async quoteSwap({ market, side = 'BASE_TO_QUOTE', amount }) {
    poolEntry(market);
    const value = positiveAmount(amount);
    if (!value) return { error: 'INVALID_AMOUNT' };
    const dir = String(side).toUpperCase() === 'QUOTE_TO_BASE' ? 'QUOTE_TO_BASE' : 'BASE_TO_QUOTE';
    const c = clientFor();
    const quote = dir === 'BASE_TO_QUOTE'
      ? await c.getQuoteQuantityOutInputFee(market, value)
      : await c.getBaseQuantityOutInputFee(market, value);
    return {
      market, side: dir, amount: value, quote,
      updatedAt: new Date().toISOString(),
      source: 'DeepBook SDK (getQuoteQuantityOutInputFee / getBaseQuantityOutInputFee)',
    };
  },

  /**
   * Direct spot swap against the pool (no BalanceManager). The all-in DEEP
   * fee is read from the pool's input-fee quote unless the caller supplies
   * one; output and leftover DEEP are transferred to the wallet.
   */
  async buildSwap({ wallet, market, side = 'BASE_TO_QUOTE', amount, minOut = 0, deepAmount = null }) {
    poolEntry(market);
    const value = positiveAmount(amount);
    if (!value) return { error: 'INVALID_AMOUNT' };
    const dir = String(side).toUpperCase() === 'QUOTE_TO_BASE' ? 'QUOTE_TO_BASE' : 'BASE_TO_QUOTE';
    const c = clientFor(wallet);
    let deep = deepAmount != null ? Number(deepAmount) : null;
    let quote = null;
    try {
      quote = dir === 'BASE_TO_QUOTE'
        ? await c.getQuoteQuantityOutInputFee(market, value)
        : await c.getBaseQuantityOutInputFee(market, value);
      if (deep == null) deep = Number(quote.deepRequired) || 0;
    } catch (e) {
      return { error: 'QUOTE_FAILED', detail: String(e?.message || e).slice(0, 160) };
    }
    const txb = new Transaction();
    txb.setSender(wallet);
    if (dir === 'BASE_TO_QUOTE') {
      const [baseOut, quoteOut, deepOut] = txb.add(c.deepBook.swapExactBaseForQuote({
        poolKey: market, amount: value, deepAmount: deep, minOut: Number(minOut) || 0,
      }));
      txb.transferObjects([quoteOut, deepOut], wallet);
      txb.transferObjects([baseOut], wallet);
    } else {
      const [baseOut, quoteOut, deepOut] = txb.add(c.deepBook.swapExactQuoteForBase({
        poolKey: market, amount: value, deepAmount: deep, minOut: Number(minOut) || 0,
      }));
      txb.transferObjects([baseOut, deepOut], wallet);
      txb.transferObjects([quoteOut], wallet);
    }
    const txBytes = await finalizeTx(txb);
    return {
      txBytes, market, side: dir, amount: value,
      deepAmount: deep, quote,
      note: 'Direct pool swap (no BalanceManager). minOut is enforced on-chain.',
    };
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
