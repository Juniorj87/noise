// /api/trade/<action> — DeepBook V3 Spot (live, canonical adapter).
// markets | market | orderbook | orders | estimate | build | cancel | setup-account
import { handler, readJson, requireQuery } from '../_lib/http.js';
import { deepbookAdapter, knownPoolKeys } from '../_lib/deepbook.js';
import { isWalletAddress } from '../_lib/services.js';
import { simulate } from '../_lib/adapters.js';
import { getPlatformFee } from '../_lib/fee-engine.js';
import { cached, withBreaker } from '../_lib/util.js';

function err(code, message, status = 400) {
  return { error: code, message, status };
}

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').pop();

  try {
    /* ---------- market discovery (never hardcoded client-side) ---------- */
    if (action === 'markets') {
      const rows = await withBreaker('deepbook', () =>
        cached('db:spot:markets', 20_000, () => deepbookAdapter.getMarkets()));
      const KNOWN = new Set(knownPoolKeys());
      return {
        markets: rows.map((r) => ({
          market: r.market,
          baseAsset: r.baseAsset,
          quoteAsset: r.quoteAsset,
          poolAddress: r.poolAddress,
          // Header metrics. 24h change/volume are NOT published by the
          // DeepBook SDK — null with reason, never 0.
          last: r.midPrice,
          bestBid: r.bestBid,
          bestAsk: r.bestAsk,
          spread: r.spread,
          change24h: null,
          change24hNote: 'Unavailable — DeepBook SDK publishes no 24h ticker',
          volume24h: null,
          volume24hNote: 'Unavailable — DeepBook SDK publishes no 24h volume',
          midDerived: r.midDerived === true,
          updatedAt: r.updatedAt,
          source: r.source,
        })),
        knownMarkets: [...KNOWN],
        marginNote: 'Margin is Coming Soon — spot execution only.',
        failed: 0,
        updatedAt: new Date().toISOString(),
      };
    }

    /* ---------- single market header + pool params ---------- */
    if (action === 'market') {
      const pool = url.searchParams.get('pool') || url.searchParams.get('market') || 'SUI_USDC';
      try {
        const [book, info] = await Promise.all([
          withBreaker('deepbook', () => cached(`db:ob:${pool}:1`, 10_000, () => deepbookAdapter.getOrderBook(pool, 1))),
          withBreaker('deepbook', () => cached(`db:info:${pool}`, 60_000, () => deepbookAdapter.getMarketInfo(pool))),
        ]);
        return {
          market: pool,
          baseAsset: info.baseAsset,
          quoteAsset: info.quoteAsset,
          poolAddress: info.poolAddress,
          last: book.midPrice,
          bestBid: book.bestBid,
          bestAsk: book.bestAsk,
          spread: book.spread,
          change24h: null,
          change24hNote: 'Unavailable — DeepBook SDK publishes no 24h ticker',
          volume24h: null,
          volume24hNote: 'Unavailable — DeepBook SDK publishes no 24h volume',
          tickSize: info.tickSize,
          lotSize: info.lotSize,
          minOrderSize: info.minOrderSize,
          takerFee: info.takerFee,
          makerFee: info.makerFee,
          liquidity: info.liquidity,
          updatedAt: book.updatedAt,
          source: 'DeepBook SDK (getLevel2TicksFromMid + poolBookParams/poolTradeParams/vaultBalances)',
        };
      } catch (e) {
        if (e.code === 'UNKNOWN_MARKET') return err('UNKNOWN_MARKET', `Unknown market ${pool}.`, 400);
        return err('PROVIDER_UNAVAILABLE', 'DeepBook market data is temporarily unavailable. The provider did not respond — your wallet and funds are unaffected. [Retry]', 502);
      }
    }

    /* ---------- L2 order book ---------- */
    if (action === 'orderbook') {
      const pool = url.searchParams.get('pool') || url.searchParams.get('market') || 'SUI_USDC';
      const ticks = Math.min(Math.max(1, Number(url.searchParams.get('ticks') || 10)), 25);
      try {
        const book = await withBreaker('deepbook', () =>
          cached(`db:ob:${pool}:${ticks}`, 5_000, () => deepbookAdapter.getOrderBook(pool, ticks)));
        return { ...book, staleAfterMs: 15_000 };
      } catch (e) {
        if (e.code === 'UNKNOWN_MARKET') return err('UNKNOWN_MARKET', `Unknown market ${pool}.`, 400);
        return err('PROVIDER_UNAVAILABLE', 'DeepBook order book temporarily unavailable. [Retry]', 502);
      }
    }

    /* ---------- execution estimate (book-based, no invention) ---------- */
    if (action === 'estimate') {
      const pool = url.searchParams.get('pool') || 'SUI_USDC';
      const side = (url.searchParams.get('side') || 'BUY').toUpperCase();
      const quantity = Number(url.searchParams.get('quantity') || 0);
      if (!(quantity > 0)) return err('INVALID_AMOUNT', 'quantity must be > 0.');
      try {
        const est = await deepbookAdapter.estimateMarketOrder({ market: pool, side, quantity });
        return { ...est, source: 'DeepBook SDK order book (estimate, not a quote)' };
      } catch (e) {
        if (e.code === 'UNKNOWN_MARKET') return err('UNKNOWN_MARKET', `Unknown market ${pool}.`, 400);
        return err('ESTIMATE_FAILED', String(e.message || e).slice(0, 200), 400);
      }
    }

    /* ---------- open orders (per wallet balance managers) ---------- */
    if (action === 'orders') {
      const wallet = requireQuery(url, 'wallet');
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      const pool = url.searchParams.get('pool') || url.searchParams.get('market') || null;
      try {
        const orders = await withBreaker('deepbook', () =>
          cached(`db:orders:${wallet}:${pool || 'all'}`, 15_000, () => deepbookAdapter.getOpenOrders(wallet, pool)));
        return {
          orders,
          ordersUnavailable: false,
          setupNote: orders.length === 0 ? 'Empty means no open orders on the inspected balance managers, or no trading account yet (see setup-account).' : null,
          updatedAt: new Date().toISOString(),
          source: 'DeepBook SDK (accountOpenOrders + getOrderNormalized)',
        };
      } catch (e) {
        return err('PROVIDER_UNAVAILABLE', 'Open orders temporarily unavailable. [Retry]', 502);
      }
    }

    /* ---------- builds (POST): market | limit | cancel | setup-account ---------- */
    if (req.method !== 'POST') return err('INVALID_REQUEST', 'Unknown trade action.', 404);
    const b = await readJson(req);

    if (action === 'setup-account') {
      if (!isWalletAddress(b.wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      try {
        const built = await deepbookAdapter.buildTradingAccountSetup({ wallet: b.wallet });
        const sim = await simulate(built.txBytes, b.wallet).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
        const simOk = sim?.effects?.status?.status === 'success';
        return { ok: true, ...built, simulation: sim, simulationStatus: simOk ? 'success' : 'unavailable', note: 'One-time trading-account setup. Sign in your wallet — backend never signs.' };
      } catch (e) {
        return err('BUILD_FAILED', String(e.message || e).slice(0, 200), 502);
      }
    }

    if (action === 'build') {
      const { wallet, market, side, type, price, quantity, managerId } = b;
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      const S = String(side || '').toUpperCase();
      const T = String(type || 'LIMIT').toUpperCase();
      if (!['BUY', 'SELL'].includes(S)) return err('INVALID_SIDE', "side must be BUY or SELL.", 400);
      try {
        const built = T === 'MARKET'
          ? await deepbookAdapter.buildMarketOrder({ wallet, market, side: S, quantity, managerId })
          : await deepbookAdapter.buildLimitOrder({ wallet, market, side: S, price, quantity, managerId });
        if (built.error) {
          const status = built.error === 'TRADING_ACCOUNT_REQUIRED' ? 409 : 400;
          const message = built.error === 'TRADING_ACCOUNT_REQUIRED'
            ? 'No DeepBook trading account (BalanceManager) found for this wallet. Create one via setup-account first.'
            : built.error;
          return err(built.error, message, status);
        }
        // Mandatory simulation gate — never hand unsigned bytes without it.
        const sim = await simulate(built.txBytes, wallet).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
        const simOk = sim?.effects?.status?.status === 'success';
        if (sim && !sim.error && !simOk) {
          return err('SIMULATION_FAILED', 'Simulation failed. The transaction was not sent to your wallet.', 400);
        }
        let gasEst = null;
        if (sim?.effects?.gasUsed) {
          const gu = sim.effects.gasUsed;
          gasEst = String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0)));
        }
        // Platform fee: reported only if actually collectible on this PTB.
        // Spot PTB has no safe generic fee leg (user funds sit in the
        // BalanceManager), so the honest value is disabled/$0.00.
        const platform = await getPlatformFee({ action: 'spot_order', provider: 'deepbook', instrument: market, amount: quantity, asset: market }).catch(() => ({ enabled: false, amount: '0' }));
        const collectible = platform.enabled && false; // no safe PTB fee leg for spot today
        return {
          ok: true,
          txBytes: built.txBytes,
          manager: built.manager || null,
          normalized: built.normalized || null,
          simulation: sim,
          simulationStatus: simOk ? 'success' : 'unavailable',
          simulationGate: simOk ? 'READY_TO_SIGN' : 'SIGNATURE_BLOCKED_UNTIL_SIMULATION_PASSES',
          gasEst,
          feeBreakdown: {
            deepFee: null, // filled from estimate/takerFee client-side; exact fee settles onchain
            actionHubFee: collectible ? platform.amount : '0.00',
            actionHubFeeNote: 'No separate Noise Hub debit is added to the spot PTB today — displayed fee equals the actual transaction.',
            networkFeeMist: gasEst,
          },
          note: 'Unsigned PTB — review price, size and fees in your wallet before signing.',
        };
      } catch (e) {
        if (e.code === 'UNKNOWN_MARKET') return err('UNKNOWN_MARKET', `Unknown market ${market}.`, 400);
        return err('BUILD_FAILED', String(e.message || e).slice(0, 200), 502);
      }
    }

    if (action === 'cancel') {
      const { wallet, market, orderId, managerId } = b;
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      if (!market || orderId == null) return err('INVALID_REQUEST', 'market and orderId are required.', 400);
      try {
        const built = await deepbookAdapter.buildCancelOrder({ wallet, market, orderId, managerId });
        if (built.error) return err(built.error, built.error === 'TRADING_ACCOUNT_REQUIRED' ? 'No trading account found for this wallet.' : built.error, 400);
        const sim = await simulate(built.txBytes, wallet).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
        const simOk = sim?.effects?.status?.status === 'success';
        return { ok: true, ...built, simulation: sim, simulationStatus: simOk ? 'success' : 'unavailable', note: 'Unsigned cancel PTB — review in your wallet.' };
      } catch (e) {
        if (e.code === 'UNKNOWN_MARKET') return err('UNKNOWN_MARKET', `Unknown market ${market}.`, 400);
        return err('BUILD_FAILED', String(e.message || e).slice(0, 200), 502);
      }
    }

    return err('NOT_FOUND', 'Unknown trade action.', 404);
  } catch (e) {
    return err(e.code || 'PROVIDER_UNAVAILABLE', 'DeepBook provider unreachable. Your wallet and funds are unaffected. [Retry]', 502);
  }
});
