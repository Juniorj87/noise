// /api/trade/<action> — DeepBook V3 Spot (live, canonical adapter).
// markets | market | orderbook | orders | estimate | build | cancel | setup-account | record
// /api/trade/predict/<action> — DeepBook Predict (live, official predict SDK).
// markets | market | balance | positions | quote-mint | quote-redeem | build-mint | build-redeem | claim
// Legacy /api/trade/deepbook/<action> aliases: info→market, setup→setup-account,
// orderbook/orderbook, estimate/estimate, orders/orders, build/build,
// cancel/cancel, record/record.
import { handler, readJson, requireQuery } from '../http.js';
import { deepbookAdapter, knownPoolKeys } from '../deepbook.js';
import { deepbookPredictAdapter } from '../deepbook-predict.js';
import { isWalletAddress } from '../services.js';
import { simulate } from '../adapters.js';
import { getPlatformFee } from '../fee-engine.js';
import { cached, withBreaker } from '../util.js';

function err(code, message, status = 400) {
  return { error: code, message, status };
}

/* Legacy deepbook/* action names mapped to canonical actions. */
const DEEPBOOK_ALIAS = {
  info: 'market',
  setup: 'setup-account',
  orderbook: 'orderbook',
  estimate: 'estimate',
  orders: 'orders',
  build: 'build',
  cancel: 'cancel',
  record: 'record',
};

function gasEstOf(sim) {
  const gu = sim?.effects?.gasUsed;
  if (!gu) return null;
  try {
    return String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0)));
  } catch { return null; }
}

/* Fail-closed simulation gate: txBytes are returned ONLY on devInspect
 * success. Anything else is SIMULATION_FAILED with no signable bytes. */
async function gatedBuild(buildResult, wallet) {
  if (!buildResult || buildResult.error || !buildResult.txBytes) {
    throw Object.assign(new Error(buildResult?.error || 'BUILD_FAILED'), { code: buildResult?.code || 'BUILD_FAILED' });
  }
  let sim = null;
  try {
    sim = await simulate(buildResult.txBytes, wallet);
  } catch (e) {
    throw Object.assign(new Error('SIMULATION_FAILED'), { code: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) });
  }
  const simOk = sim?.effects?.status?.status === 'success';
  if (!simOk) {
    const detail = String(sim?.effects?.status?.error || 'simulation failed').slice(0, 200);
    throw Object.assign(new Error('SIMULATION_FAILED: ' + detail), { code: 'SIMULATION_FAILED' });
  }
  return { txBytes: buildResult.txBytes, simulation: sim, simulationStatus: 'success', gasEst: gasEstOf(sim) };
}

/* Build → fail-closed simulation → response for the newer spot actions.
 * A builder that returns { error } never reaches the wallet. */
async function unsignedBuild(buildFn, wallet, note) {
  const built = await buildFn();
  if (built?.error) {
    throw Object.assign(new Error(built.error), { code: built.error });
  }
  const g = await gatedBuild(built, wallet);
  return { ok: true, ...built, ...g, simulationStatus: 'success', note };
}

function buildErr(e) {
  const code = e.code || 'BUILD_FAILED';
  const status = code === 'TRADING_ACCOUNT_REQUIRED' ? 409
    : (code === 'SIMULATION_FAILED' ? 400
      : (/INVALID|UNKNOWN|REQUIRED|UNSUPPORTED|BELOW/.test(code) ? 400 : 502));
  return err(code, String(e.message || e).slice(0, 240), status);
}

export default handler(async (req, res, url) => {
  const segs = url.pathname.split('/').filter(Boolean);
  let action = segs.pop();
  const isPredict = segs.includes('predict');
  if (!isPredict && segs.includes('deepbook') && DEEPBOOK_ALIAS[action]) {
    action = DEEPBOOK_ALIAS[action];
    // Legacy callers send `market=`; canonical estimate/market read `pool`.
    if ((action === 'estimate' || action === 'market') && !url.searchParams.get('pool') && url.searchParams.get('market')) {
      url.searchParams.set('pool', url.searchParams.get('market'));
    }
  }
  if (isPredict) return predictRouter(req, res, url, action);

  try {
    /* ---------- market discovery (never hardcoded client-side) ---------- */
    if (action === 'markets') {
      const rows = await withBreaker('deepbook', () =>
        cached('db:spot:markets', 8_000, () => deepbookAdapter.getMarkets()));
      const KNOWN = new Set(knownPoolKeys());
      return {
        markets: rows.map((r) => ({
          market: r.market,
          baseAsset: r.baseAsset,
          quoteAsset: r.quoteAsset,
          poolAddress: r.poolAddress,
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
          cached(`db:ob:${pool}:${ticks}`, 2_000, () => deepbookAdapter.getOrderBook(pool, ticks)));
        return { ...book, staleAfterMs: 6_000 };
      } catch (e) {
        if (e.code === 'UNKNOWN_MARKET') return err('UNKNOWN_MARKET', `Unknown market ${pool}.`, 400);
        return err('PROVIDER_UNAVAILABLE', 'DeepBook order book temporarily unavailable. [Retry]', 502);
      }
    }

    /* ---------- execution estimate (book-based, no invention) ---------- */
    if (action === 'estimate') {
      const pool = url.searchParams.get('pool') || url.searchParams.get('market') || 'SUI_USDC';
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
        // Canonical replacement for the dev-only shim field: tells the UI whether
        // this wallet owns any BalanceManager, so the "create trading account"
        // affordance is not shown to wallets that already have one.
        let managerKnown = null;
        try {
          const ids = await withBreaker('deepbook', () => cached(`db:mgrs:${wallet}`, 30_000, () => deepbookAdapter.getBalanceManagerIds(wallet)));
          managerKnown = Array.isArray(ids) && ids.length > 0;
        } catch { managerKnown = orders.length > 0 ? true : null; }
        return {
          orders,
          managerKnown,
          ordersUnavailable: false,
          setupNote: orders.length === 0 ? 'Empty means no open orders on the inspected balance managers, or no trading account yet (see setup-account).' : null,
          updatedAt: new Date().toISOString(),
          source: 'DeepBook SDK (accountOpenOrders + getOrderNormalized)',
        };
      } catch (e) {
        return err('PROVIDER_UNAVAILABLE', 'Open orders temporarily unavailable. [Retry]', 502);
      }
    }

    /* ---------- balance-manager capital + per-pool account state ---------- */
    if (action === 'account') {
      const wallet = requireQuery(url, 'wallet');
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      const pool = url.searchParams.get('pool') || url.searchParams.get('market') || 'SUI_USDC';
      const managerId = url.searchParams.get('manager') || url.searchParams.get('managerId') || null;
      try {
        return await withBreaker('deepbook', () =>
          cached(`db:acct:${wallet}:${managerId || 'all'}:${pool}`, 10_000,
            () => deepbookAdapter.getAccount({ wallet, market: pool, managerId })));
      } catch (e) {
        if (e.code === 'UNKNOWN_MARKET') return err('UNKNOWN_MARKET', `Unknown market ${pool}.`, 400);
        return err('PROVIDER_UNAVAILABLE', 'Trading account temporarily unavailable. [Retry]', 502);
      }
    }

    /* ---------- full pool state (fees, next epoch, quorum, flags) ---------- */
    if (action === 'pool-info') {
      const pool = url.searchParams.get('pool') || url.searchParams.get('market') || 'SUI_USDC';
      try {
        return await withBreaker('deepbook', () =>
          cached(`db:pool:${pool}`, 30_000, () => deepbookAdapter.getPoolInfo(pool)));
      } catch (e) {
        if (e.code === 'UNKNOWN_MARKET') return err('UNKNOWN_MARKET', `Unknown market ${pool}.`, 400);
        return err('PROVIDER_UNAVAILABLE', 'Pool info temporarily unavailable. [Retry]', 502);
      }
    }

    /* ---------- single order state ---------- */
    if (action === 'order') {
      const wallet = requireQuery(url, 'wallet');
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      const pool = url.searchParams.get('pool') || url.searchParams.get('market');
      const orderId = url.searchParams.get('orderId');
      if (!pool || orderId == null) return err('INVALID_REQUEST', 'pool and orderId are required.', 400);
      try {
        return await deepbookAdapter.getOrderStatus(wallet, pool, orderId);
      } catch (e) {
        if (e.code === 'UNKNOWN_MARKET') return err('UNKNOWN_MARKET', `Unknown market ${pool}.`, 400);
        return err('PROVIDER_UNAVAILABLE', 'Order state temporarily unavailable. [Retry]', 502);
      }
    }

    /* ---------- DEEP fee needed for an order ---------- */
    if (action === 'deep-required') {
      const pool = url.searchParams.get('pool') || url.searchParams.get('market') || 'SUI_USDC';
      const quantity = Number(url.searchParams.get('quantity') || 0);
      const price = Number(url.searchParams.get('price') || 0);
      if (!(quantity > 0) || !(price > 0)) return err('INVALID_AMOUNT', 'quantity and price must be > 0.');
      try {
        return await deepbookAdapter.getOrderDeepRequired(pool, quantity, price);
      } catch (e) {
        if (e.code === 'UNKNOWN_MARKET') return err('UNKNOWN_MARKET', `Unknown market ${pool}.`, 400);
        return err('PROVIDER_UNAVAILABLE', 'DEEP fee quote temporarily unavailable. [Retry]', 502);
      }
    }

    /* ---------- direct-swap quote (pool, no BalanceManager) ---------- */
    if (action === 'swap-quote') {
      const pool = url.searchParams.get('pool') || url.searchParams.get('market') || 'SUI_USDC';
      const side = (url.searchParams.get('side') || 'BASE_TO_QUOTE').toUpperCase();
      const amount = Number(url.searchParams.get('amount') || 0);
      if (!(amount > 0)) return err('INVALID_AMOUNT', 'amount must be > 0.');
      try {
        return await withBreaker('deepbook', () =>
          cached(`db:swapq:${pool}:${side}:${amount}`, 3_000,
            () => deepbookAdapter.quoteSwap({ market: pool, side, amount })));
      } catch (e) {
        if (e.code === 'UNKNOWN_MARKET') return err('UNKNOWN_MARKET', `Unknown market ${pool}.`, 400);
        return err('QUOTE_FAILED', String(e.message || e).slice(0, 200), 502);
      }
    }

    /* ---------- referral state ---------- */
    if (action === 'referral') {
      const wallet = requireQuery(url, 'wallet');
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      const pool = url.searchParams.get('pool') || url.searchParams.get('market') || 'SUI_USDC';
      const managerId = url.searchParams.get('manager') || url.searchParams.get('managerId') || null;
      const referral = url.searchParams.get('referral') || null;
      try {
        return await withBreaker('deepbook', () =>
          cached(`db:ref:${wallet}:${managerId || 'all'}:${pool}:${referral || ''}`, 20_000,
            () => deepbookAdapter.getReferral({ wallet, market: pool, managerId, referral })));
      } catch (e) {
        if (e.code === 'UNKNOWN_MARKET') return err('UNKNOWN_MARKET', `Unknown market ${pool}.`, 400);
        return err('PROVIDER_UNAVAILABLE', 'Referral state temporarily unavailable. [Retry]', 502);
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
        const simOk = sim && !sim.error && sim?.effects?.status?.status === 'success';
        if (!simOk) {
          return err('SIMULATION_FAILED', 'On-chain dry run failed: ' + String(sim?.detail || sim?.effects?.status?.error || 'failed').slice(0, 200) + ' — nothing was sent to your wallet.', 400);
        }
        return { ok: true, ...built, simulation: sim, simulationStatus: 'success', note: 'One-time trading-account setup. Sign in your wallet — backend never signs.' };
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
        const sim = await simulate(built.txBytes, wallet).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
        const simOk = sim && !sim.error && sim?.effects?.status?.status === 'success';
        if (!simOk) {
          return err('SIMULATION_FAILED', 'On-chain dry run failed: ' + String(sim?.detail || sim?.effects?.status?.error || 'failed').slice(0, 200) + ' — nothing was sent to your wallet.', 400);
        }
        let gasEst = null;
        if (sim?.effects?.gasUsed) {
          const gu = sim.effects.gasUsed;
          gasEst = String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0)));
        }
        const platform = await getPlatformFee({ action: 'spot_order', provider: 'deepbook', instrument: market, amount: quantity, asset: market }).catch(() => ({ enabled: false, amount: '0' }));
        const collectible = platform.enabled && false;
        return {
          ok: true,
          txBytes: built.txBytes,
          manager: built.manager || null,
          normalized: built.normalized || null,
          simulation: sim,
          simulationStatus: 'success',
          simulationGate: simOk ? 'READY_TO_SIGN' : 'SIGNATURE_BLOCKED_UNTIL_SIMULATION_PASSES',
          gasEst,
          feeBreakdown: {
            deepFee: null,
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
        const simOk = sim && !sim.error && sim?.effects?.status?.status === 'success';
        if (!simOk) {
          return err('SIMULATION_FAILED', 'On-chain dry run failed: ' + String(sim?.detail || sim?.effects?.status?.error || 'failed').slice(0, 200) + ' — nothing was sent to your wallet.', 400);
        }
        return { ok: true, ...built, simulation: sim, simulationStatus: 'success', note: 'Unsigned cancel PTB — review in your wallet.' };
      } catch (e) {
        if (e.code === 'UNKNOWN_MARKET') return err('UNKNOWN_MARKET', `Unknown market ${market}.`, 400);
        return err('BUILD_FAILED', String(e.message || e).slice(0, 200), 502);
      }
    }

    /* ---------- capital management (deposit / withdraw / withdraw-all) ---------- */
    if (action === 'deposit' || action === 'withdraw' || action === 'withdraw-all') {
      const { wallet } = b;
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      if (!b.coin) return err('INVALID_COIN', 'coin is required (e.g. SUI, USDC, DEEP).', 400);
      try {
        if (action === 'deposit') {
          return await unsignedBuild(
            () => deepbookAdapter.buildDeposit({ wallet, managerId: b.managerId, coin: b.coin, amount: b.amount }),
            wallet,
            'Unsigned deposit — the owner signature moves coins into the BalanceManager.');
        }
        const all = action === 'withdraw-all';
        return await unsignedBuild(
          () => deepbookAdapter.buildWithdraw({
            wallet, managerId: b.managerId, coin: b.coin, amount: b.amount,
            all, recipient: b.recipient,
          }),
          wallet,
          all
            ? 'Unsigned withdraw-all — the full manager balance moves to the recipient.'
            : 'Unsigned withdrawal — funds leave the BalanceManager to the recipient.');
      } catch (e) {
        return buildErr(e);
      }
    }

    /* ---------- modify an open order ---------- */
    if (action === 'modify') {
      const { wallet, market, orderId, quantity } = b;
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      if (!market || orderId == null) return err('INVALID_REQUEST', 'market and orderId are required.', 400);
      try {
        return await unsignedBuild(
          () => deepbookAdapter.buildModifyOrder({ wallet, market, orderId, quantity, managerId: b.managerId }),
          wallet,
          'Unsigned modify-order PTB — only the remaining quantity changes.');
      } catch (e) {
        return buildErr(e);
      }
    }

    /* ---------- batch / all-order cancel ---------- */
    if (action === 'cancel-orders') {
      const { wallet, market } = b;
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      if (!market) return err('INVALID_REQUEST', 'market is required.', 400);
      const orderIds = Array.isArray(b.orderIds) ? b.orderIds : (b.orderId != null ? [b.orderId] : []);
      try {
        return await unsignedBuild(
          () => deepbookAdapter.buildCancelOrders({
            wallet, market, orderIds, all: b.all === true, managerId: b.managerId, live: b.live !== false,
          }),
          wallet,
          b.all === true
            ? 'Unsigned cancel-all PTB — stops every open order in this pool.'
            : 'Unsigned batch cancel — unknown/filled ids are skipped by the live-order builder.');
      } catch (e) {
        return buildErr(e);
      }
    }

    /* ---------- settled balances + maker rebates ---------- */
    if (action === 'withdraw-settled') {
      const { wallet, market } = b;
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      if (!market) return err('INVALID_REQUEST', 'market is required.', 400);
      try {
        return await unsignedBuild(
          () => deepbookAdapter.buildWithdrawSettled({ wallet, market, managerId: b.managerId }),
          wallet,
          'Unsigned withdraw-settled PTB — moves settled fills into the manager balance.');
      } catch (e) {
        return buildErr(e);
      }
    }
    if (action === 'claim-rebates') {
      const { wallet, market } = b;
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      if (!market) return err('INVALID_REQUEST', 'market is required.', 400);
      try {
        return await unsignedBuild(
          () => deepbookAdapter.buildClaimRebates({ wallet, market, managerId: b.managerId }),
          wallet,
          'Unsigned rebate claim — maker rebates settle into the manager.');
      } catch (e) {
        return buildErr(e);
      }
    }

    /* ---------- pool referrals (mint / set / update / claim) ---------- */
    if (action === 'mint-referral') {
      const { wallet, market, multiplier } = b;
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      if (!market) return err('INVALID_REQUEST', 'market is required.', 400);
      try {
        return await unsignedBuild(
          () => deepbookAdapter.buildMintReferral({ wallet, market, multiplier }),
          wallet,
          'Unsigned mint-referral — multiplier must be 0.1–2.0 in 0.1 steps.');
      } catch (e) {
        return buildErr(e);
      }
    }
    if (action === 'set-referral') {
      const { wallet, market } = b;
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      if (!market) return err('INVALID_REQUEST', 'market is required.', 400);
      try {
        return await unsignedBuild(
          () => deepbookAdapter.buildSetReferral({ wallet, market, managerId: b.managerId, referral: b.referral || null }),
          wallet,
          b.referral ? 'Unsigned set-referral — attaches the referral to this BalanceManager.' : 'Unsigned unset-referral — clears the manager referral for this pool.');
      } catch (e) {
        return buildErr(e);
      }
    }
    if (action === 'update-referral') {
      const { wallet, market, referral, multiplier } = b;
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      if (!market || !referral) return err('INVALID_REQUEST', 'market and referral are required.', 400);
      try {
        return await unsignedBuild(
          () => deepbookAdapter.buildUpdateReferralMultiplier({ wallet, market, referral, multiplier }),
          wallet,
          'Unsigned referral-multiplier update (0.1–2.0 in 0.1 steps).');
      } catch (e) {
        return buildErr(e);
      }
    }
    if (action === 'claim-referral') {
      const { wallet, market, referral } = b;
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      if (!market || !referral) return err('INVALID_REQUEST', 'market and referral are required.', 400);
      try {
        return await unsignedBuild(
          () => deepbookAdapter.buildClaimReferralRewards({ wallet, market, referral }),
          wallet,
          'Unsigned referral-reward claim — base, quote and DEEP rewards go to the wallet.');
      } catch (e) {
        return buildErr(e);
      }
    }

    /* ---------- DEEP governance staking ---------- */
    if (action === 'stake' || action === 'unstake') {
      const { wallet, market } = b;
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      if (!market) return err('INVALID_REQUEST', 'market is required.', 400);
      try {
        return await unsignedBuild(
          () => (action === 'stake'
            ? deepbookAdapter.buildStake({ wallet, market, amount: b.amount, managerId: b.managerId })
            : deepbookAdapter.buildUnstake({ wallet, market, managerId: b.managerId })),
          wallet,
          action === 'stake'
            ? 'Unsigned DEEP stake — staked DEEP improves taker fees/maker rebates in this pool.'
            : 'Unsigned DEEP unstake — releases the manager stake in this pool.');
      } catch (e) {
        return buildErr(e);
      }
    }

    /* ---------- direct spot swap (no BalanceManager) ---------- */
    if (action === 'swap') {
      const { wallet, market, side, amount, minOut, deepAmount } = b;
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      if (!market) return err('INVALID_REQUEST', 'market is required.', 400);
      try {
        return await unsignedBuild(
          () => deepbookAdapter.buildSwap({ wallet, market, side, amount, minOut, deepAmount }),
          wallet,
          'Unsigned direct pool swap — minOut is enforced on-chain.');
      } catch (e) {
        return buildErr(e);
      }
    }

    /* ---------- limit-order intent log (fire-and-forget client hint) ----------
     * The wallet already signed and submitted; the digest is the source of
     * truth for tracking. This validates and stores the intent so the UI can
     * reconcile it — never a substitute for on-chain state. */
    if (action === 'record') {
      // The shared POST body was already parsed above (readJson is memoized —
      // never re-attach stream listeners to a consumed request).
      if (!isWalletAddress(b.wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      if (!b.market || !['BUY', 'SELL'].includes(String(b.side || '').toUpperCase())) {
        return err('INVALID_REQUEST', 'market and side (BUY/SELL) are required.', 400);
      }
      if (!(Number(b.price) > 0) || !(Number(b.quantity) > 0)) {
        return err('INVALID_AMOUNT', 'price and quantity must be > 0.', 400);
      }
      try {
        recordOrderIntent({
          wallet: b.wallet, market: b.market, side: String(b.side).toUpperCase(),
          type: String(b.type || 'LIMIT').toUpperCase(), price: String(b.price),
          quantity: String(b.quantity), digest: b.digest || null, status: 'OPEN',
        });
      } catch (e) {
        return err('RECORD_FAILED', String(e.message || e).slice(0, 200), 500);
      }
      return { ok: true, recorded: true, note: 'Intent stored. On-chain digest remains the source of truth for tracking.' };
    }

    return err('NOT_FOUND', 'Unknown trade action.', 404);
  } catch (e) {
    return err(e.code || 'PROVIDER_UNAVAILABLE', 'DeepBook provider unreachable. Your wallet and funds are unaffected. [Retry]', 502);
  }
});

/* In-memory intent log (per process; the digest tracker is authoritative).
 * Vercel may recycle instances — intents are a best-effort hint only. */
const orderIntents = [];
function recordOrderIntent(intent) {
  orderIntents.unshift({ ...intent, recordedAt: new Date().toISOString() });
  if (orderIntents.length > 200) orderIntents.length = 200;
  return true;
}

/* ---------------- DeepBook Predict router (official predict SDK) ---------- */
async function predictRouter(req, res, url, action) {
  const A = deepbookPredictAdapter;
  try {
    if (action === 'markets' && req.method === 'GET') {
      const r = await withBreaker('deepbook-predict', () =>
        cached('dbp:markets', 8_000, () => A.getMarkets()));
      return r;
    }
    if (action === 'market' && req.method === 'GET') {
      const q = url.searchParams;
      try {
        return await withBreaker('deepbook-predict', () =>
          cached(`dbp:market:${q.get('underlying')}:${q.get('expiryMs')}:${q.get('side')}:${q.get('strike')}`, 15_000, () =>
            A.getMarket({
              underlying: q.get('underlying'), expiryMs: q.get('expiryMs'),
              side: q.get('side') || 'up', strike: q.get('strike') || 'reference',
            })));
      } catch (e) {
        return err(e.code || 'PROVIDER_UNAVAILABLE', String(e.message || e).slice(0, 200), /INVALID|UNKNOWN/.test(e.code || '') ? 400 : 502);
      }
    }
    if (action === 'balance' && req.method === 'GET') {
      const wallet = url.searchParams.get('wallet');
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      try {
        return await withBreaker('deepbook-predict', () =>
          cached(`dbp:bal:${wallet}`, 15_000, () => A.getBalance(wallet)));
      } catch (e) {
        return err('PROVIDER_UNAVAILABLE', 'Predict balance unavailable.', 502);
      }
    }
    if (action === 'positions' && req.method === 'GET') {
      const wallet = url.searchParams.get('wallet');
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      try {
        return await withBreaker('deepbook-predict', () =>
          cached(`dbp:pos:${wallet}`, 15_000, () => A.getPositions(wallet)));
      } catch (e) {
        return err('PROVIDER_UNAVAILABLE', 'Predict positions unavailable.', 502);
      }
    }
    if (action === 'plp-balance' && req.method === 'GET') {
      const wallet = url.searchParams.get('wallet');
      if (!isWalletAddress(wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      try {
        return await withBreaker('deepbook-predict', () =>
          cached(`dbp:plp:${wallet}`, 15_000, () => A.getPlpBalance(wallet)));
      } catch (e) {
        return err('PROVIDER_UNAVAILABLE', 'Predict PLP balance unavailable.', 502);
      }
    }
    if (req.method !== 'POST') return err('INVALID_REQUEST', 'Unknown predict action.', 404);
    const b = await readJson(req);
    if (action === 'quote-mint') {
      try {
        if (b.spend != null) {
          return await A.quoteMintBudget({
            wallet: b.wallet, underlying: b.underlying, expiryMs: b.expiryMs,
            side: b.side || 'up', strike: b.strike ?? 'reference',
            spend: Number(b.spend), minQuantity: Number(b.minQuantity ?? 0), maxCost: b.maxCost,
          });
        }
        return await A.quoteMint({
          wallet: b.wallet, underlying: b.underlying, expiryMs: b.expiryMs,
          side: b.side || 'up', strike: b.strike ?? 'reference',
          quantity: Number(b.quantity), maxCost: b.maxCost, maxProbability: b.maxProbability,
        });
      } catch (e) {
        return err(e.code || 'QUOTE_FAILED', String(e.message || e).slice(0, 200), /INVALID|UNKNOWN/.test(e.code || '') ? 400 : 502);
      }
    }
    if (action === 'build-mint') {
      if (!isWalletAddress(b.wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      try {
        const built = b.spend != null
          ? await A.buildMintBudget({
            wallet: b.wallet, underlying: b.underlying, expiryMs: b.expiryMs,
            side: b.side || 'up', strike: b.strike ?? 'reference',
            spend: Number(b.spend), minQuantity: Number(b.minQuantity ?? 0), maxCost: b.maxCost,
          })
          : await A.buildMint({
            wallet: b.wallet, underlying: b.underlying, expiryMs: b.expiryMs,
            side: b.side || 'up', strike: b.strike ?? 'reference',
            quantity: Number(b.quantity), maxCost: b.maxCost, maxProbability: b.maxProbability,
          });
        const g = await gatedBuild(built, b.wallet);
        return {
          ok: true, txBytes: g.txBytes, quote: built.quote, market: built.market,
          feeNote: built.feeNote, simulation: g.simulation, simulationStatus: g.simulationStatus,
          gasEst: g.gasEst, note: 'Unsigned mint PTB — review in your wallet before signing.',
        };
      } catch (e) {
        const code = e.code || 'BUILD_FAILED';
        const status = code === 'SIMULATION_FAILED' ? 400 : (/INVALID|UNKNOWN|EXPIRED|PAUSED|UNAVAILABLE/.test(code) ? 400 : 502);
        return err(code, String(e.message || e).slice(0, 200), status);
      }
    }
    if (action === 'quote-redeem') {
      try {
        return await A.quoteRedeem({
          wallet: b.wallet, underlying: b.underlying, expiryMs: b.expiryMs,
          orderId: b.orderId, quantity: Number(b.quantity),
        });
      } catch (e) {
        return err(e.code || 'QUOTE_FAILED', String(e.message || e).slice(0, 200), /INVALID/.test(e.code || '') ? 400 : 502);
      }
    }
    if (action === 'build-redeem') {
      if (!isWalletAddress(b.wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      try {
        const built = await A.buildRedeem({
          wallet: b.wallet, underlying: b.underlying, expiryMs: b.expiryMs,
          orderId: b.orderId, quantity: Number(b.quantity),
        });
        const g = await gatedBuild(built, b.wallet);
        return {
          ok: true, txBytes: g.txBytes, quote: built.quote,
          simulation: g.simulation, simulationStatus: g.simulationStatus, gasEst: g.gasEst,
          note: 'Unsigned redeem PTB — review in your wallet before signing.',
        };
      } catch (e) {
        const code = e.code || 'BUILD_FAILED';
        return err(code, String(e.message || e).slice(0, 200), code === 'SIMULATION_FAILED' ? 400 : 502);
      }
    }
    if (action === 'claim') {
      if (!isWalletAddress(b.wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      try {
        const built = await A.buildClaim({
          wallet: b.wallet, underlying: b.underlying, expiryMs: b.expiryMs, orderId: b.orderId,
        });
        const g = await gatedBuild(built, b.wallet);
        return {
          ok: true, txBytes: g.txBytes,
          simulation: g.simulation, simulationStatus: g.simulationStatus, gasEst: g.gasEst,
          note: 'Unsigned claim-settled PTB — review in your wallet before signing.',
        };
      } catch (e) {
        const code = e.code || 'BUILD_FAILED';
        const status = code === 'SIMULATION_FAILED' ? 400 : (/INVALID|UNKNOWN|EXPIRED|PAUSED|UNAVAILABLE/.test(code) ? 400 : 502);
        return err(code, String(e.message || e).slice(0, 200), status);
      }
    }
    // Predict account funding + LP (unsigned PTBs, wallet signs; gatedBuild simulates)
    if (['account-setup', 'account-deposit', 'account-withdraw', 'plp-supply', 'plp-withdraw'].includes(action)) {
      if (!isWalletAddress(b.wallet)) return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
      try {
        let built;
        if (action === 'account-setup') built = await A.buildAccountSetup({ wallet: b.wallet });
        else if (action === 'account-deposit') built = await A.buildDeposit({ wallet: b.wallet, amountUsdc: Number(b.amountUsdc), create: !!b.create });
        else if (action === 'account-withdraw') built = await A.buildWithdraw({ wallet: b.wallet, amountUsdc: Number(b.amountUsdc) });
        else if (action === 'plp-withdraw') built = await A.buildPlpWithdraw({ wallet: b.wallet, shares: b.shares });
        else built = await A.buildPlpSupply({ wallet: b.wallet, amountUsdc: Number(b.amountUsdc) });
        const g = await gatedBuild(built, b.wallet);
        return {
          ok: true, txBytes: g.txBytes,
          simulation: g.simulation, simulationStatus: g.simulationStatus, gasEst: g.gasEst,
          note: 'Unsigned Predict PTB — review in your wallet before signing.',
        };
      } catch (e) {
        const code = e.code || 'BUILD_FAILED';
        return err(code, String(e.message || e).slice(0, 200), code === 'SIMULATION_FAILED' ? 400 : 502);
      }
    }
    return err('NOT_FOUND', 'Unknown predict action.', 404);
  } catch (e) {
    return err(e.code || 'PROVIDER_UNAVAILABLE', 'Predict provider unreachable. Your wallet and funds are unaffected. [Retry]', 502);
  }
}
