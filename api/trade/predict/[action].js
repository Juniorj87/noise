// GET/POST /api/trade/predict/<action> — DeepBook Predict routes.
// Official @mysten/deepbook-v3/predict SDK. Market addressing:
// { underlying, expiryMs, side: 'up'|'down'|'range', strike | (lower+upper), marketId? }.
// Every build is preceded by a fresh chain quote inside the adapter.
import { handler, readJson, requireQuery } from '../../_lib/http.js';
import { deepbookPredictAdapter, predictUnderlyings, predictConstants } from '../../_lib/deepbook-predict.js';
import { isWalletAddress } from '../../_lib/services.js';
import { simulate } from '../../_lib/adapters.js';
import { withBreaker, cached } from '../../_lib/util.js';

function err(code, message, status = 400) {
  return { error: code, message, status };
}

function checkWallet(w) {
  if (!isWalletAddress(w)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  return w;
}

function marketParams(url, b = {}) {
  const g = (k) => (b[k] !== undefined ? b[k] : url.searchParams.get(k));
  return {
    underlying: g('underlying'),
    expiryMs: g('expiryMs') ?? g('expiry'),
    side: g('side') || 'up',
    strike: g('strike') ?? 'reference',
    marketId: g('marketId') || undefined,
    lower: g('lower'),
    upper: g('upper'),
  };
}

function simGas(sim) {
  if (sim && sim.effects && sim.effects.gasUsed) {
    const gu = sim.effects.gasUsed;
    return String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0)));
  }
  return null;
}

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').pop();

  /* ---------- live reads (GET) ---------- */

  if (action === 'markets') {
    try {
      return await withBreaker('deepbook-predict', () =>
        cached('predict:markets', 20_000, () => deepbookPredictAdapter.getMarkets()));
    } catch (e) {
      return err(e.code || 'PROVIDER_UNAVAILABLE', 'DeepBook Predict markets temporarily unavailable. Your wallet and funds are unaffected. [Retry]', 502);
    }
  }

  if (action === 'underlyings') {
    try {
      return { underlyings: predictUnderlyings(), constants: predictConstants(), updatedAt: new Date().toISOString() };
    } catch (e) {
      return err('PROVIDER_UNAVAILABLE', 'Predict configuration unavailable.', 502);
    }
  }

  if (action === 'market') {
    const p = marketParams(url);
    if (!p.underlying || p.expiryMs == null) return err('INVALID_REQUEST', 'underlying and expiryMs are required.');
    try {
      return await withBreaker('deepbook-predict', () =>
        cached(`predict:market:${p.underlying}:${p.expiryMs}:${p.side}:${p.strike}`, 10_000,
          () => deepbookPredictAdapter.getMarket(p)));
    } catch (e) {
      if (e.code === 'UNKNOWN_UNDERLYING' || e.code === 'INVALID_SIDE' || e.code === 'INVALID_STRIKE' || e.code === 'INVALID_RANGE' || e.code === 'INVALID_MARKET') {
        return err(e.code, e.message, 400);
      }
      return err('PROVIDER_UNAVAILABLE', 'Market state unavailable. Your wallet and funds are unaffected. [Retry]', 502);
    }
  }

  if (action === 'positions') {
    let wallet;
    try {
      wallet = checkWallet(requireQuery(url, 'wallet'));
    } catch {
      return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
    }
    try {
      return await withBreaker('deepbook-predict', () =>
        cached(`predict:positions:${wallet}`, 15_000, () => deepbookPredictAdapter.getPositions(wallet)));
    } catch (e) {
      return err('PROVIDER_UNAVAILABLE', 'Positions unavailable. Your wallet and funds are unaffected. [Retry]', 502);
    }
  }

  if (action === 'balance') {
    let wallet;
    try {
      wallet = checkWallet(requireQuery(url, 'wallet'));
    } catch {
      return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
    }
    try {
      return await deepbookPredictAdapter.getBalance(wallet);
    } catch (e) {
      return err('PROVIDER_UNAVAILABLE', 'Predict balance unavailable.', 502);
    }
  }

  /* ---------- quotes + builds (POST) ---------- */

  if (req.method !== 'POST') return err('INVALID_REQUEST', 'POST required for quote/build actions.', 400);
  const b = await readJson(req);

  if (action === 'quote-mint') {
    let wallet;
    try {
      wallet = checkWallet(b.wallet);
    } catch {
      return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
    }
    const p = marketParams(url, b);
    try {
      if (b.spend != null) {
        return await deepbookPredictAdapter.quoteMintBudget({
          wallet, ...p, spend: Number(b.spend), minQuantity: Number(b.minQuantity ?? 0), maxCost: b.maxCost != null ? Number(b.maxCost) : undefined,
        });
      }
      return await deepbookPredictAdapter.quoteMint({
        wallet, ...p, quantity: Number(b.quantity), maxCost: b.maxCost != null ? Number(b.maxCost) : undefined,
        maxProbability: b.maxProbability != null ? Number(b.maxProbability) : undefined,
      });
    } catch (e) {
      if (e.code === 'QUOTE_FAILED' || e.code?.startsWith('INVALID') || e.code === 'UNKNOWN_UNDERLYING') {
        return err(e.code, e.message, 400);
      }
      return err('INTERNAL_ERROR', 'Quote failed.', 500);
    }
  }

  async function buildAndSimulate(built, wallet, feeCtx) {
    if (built.error) return err(built.code || 'BUILD_FAILED', built.error, 400);
    const sim = await simulate(built.txBytes, wallet).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
    const gasEst = simGas(sim);
    const simOk = sim && sim.effects && sim.effects.status && sim.effects.status.status === 'success';
    if (sim && !sim.error && !simOk) {
      return {
        error: 'SIMULATION_FAILED',
        message: 'Simulation failed. The transaction was not sent to your wallet.',
        simulation: sim,
        simulationStatus: 'failed',
        status: 400,
      };
    }
    return {
      ok: true,
      txBytes: built.txBytes,
      quote: built.quote || null,
      market: built.market || feeCtx || null,
      simulation: sim,
      simulationStatus: simOk ? 'success' : 'unavailable',
      simulationGate: simOk ? 'READY_TO_SIGN' : 'SIGNATURE_BLOCKED_UNTIL_SIMULATION_PASSES',
      gasEst,
      feeBreakdown: {
        // Exact protocol-side components come from the simulated chain quote.
        premium: built.quote?.premium ?? null,
        tradingFee: built.quote?.tradingFee ?? null,
        subsidy: built.quote?.subsidy ?? null,
        builderFee: built.quote?.builderFee ?? null,
        penalty: built.quote?.penalty ?? null,
        inventoryImpact: built.quote?.inventoryImpact ?? null,
        totalCost: built.quote?.totalCost ?? null,
        // No separate Action Hub debit exists on Predict without a registered
        // builder code — referral/builder revenue is a protocol-proceeds split.
        actionHubFee: '0.00',
          actionHubFeeNote: 'No separate Noise Hub debit. Builder/referral revenue is a split of protocol proceeds, not a trader charge.',
        networkFeeMist: gasEst,
        feesExact: built.quote?.feesExact === true,
      },
      feeNote: built.feeNote || null,
      note: 'Unsigned PTB — review every field in your wallet before signing. Settlement is handled onchain by DeepBook Predict.',
    };
  }

  if (action === 'build-mint') {
    let wallet;
    try {
      wallet = checkWallet(b.wallet);
    } catch {
      return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
    }
    const p = marketParams(url, b);
    try {
      const built = b.spend != null
        ? await deepbookPredictAdapter.buildMintBudget({
            wallet, ...p, spend: Number(b.spend), minQuantity: Number(b.minQuantity ?? 0), maxCost: b.maxCost != null ? Number(b.maxCost) : undefined,
          })
        : await deepbookPredictAdapter.buildMint({
            wallet, ...p, quantity: Number(b.quantity), maxCost: b.maxCost != null ? Number(b.maxCost) : undefined,
            maxProbability: b.maxProbability != null ? Number(b.maxProbability) : undefined,
          });
      return await buildAndSimulate(built, wallet, { underlying: p.underlying, expiryMs: String(p.expiryMs ?? '') });
    } catch (e) {
      if (e.code === 'QUOTE_FAILED' || e.code?.startsWith('INVALID') || e.code === 'UNKNOWN_UNDERLYING') {
        return err(e.code, e.message, 400);
      }
      return err('BUILD_FAILED', String(e.message || e).slice(0, 200), 500);
    }
  }

  if (action === 'quote-redeem') {
    let wallet;
    try {
      wallet = checkWallet(b.wallet);
    } catch {
      return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
    }
    try {
      return await deepbookPredictAdapter.quoteRedeem({
        wallet, underlying: b.underlying, expiryMs: b.expiryMs ?? b.expiry,
        orderId: b.orderId ?? b.positionId, quantity: Number(b.quantity), marketId: b.marketId,
      });
    } catch (e) {
      if (e.code === 'QUOTE_FAILED' || e.code?.startsWith('INVALID')) return err(e.code, e.message, 400);
      return err('INTERNAL_ERROR', 'Redeem quote failed.', 500);
    }
  }

  if (action === 'build-redeem') {
    let wallet;
    try {
      wallet = checkWallet(b.wallet);
    } catch {
      return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
    }
    try {
      const built = await deepbookPredictAdapter.buildRedeem({
        wallet, underlying: b.underlying, expiryMs: b.expiryMs ?? b.expiry,
        orderId: b.orderId ?? b.positionId, quantity: Number(b.quantity), marketId: b.marketId,
      });
      const sim = await simulate(built.txBytes, wallet).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
      if (built.error) return err(built.code || 'BUILD_FAILED', built.error, 400);
      const gasEst = simGas(sim);
      const simOk = sim && sim.effects && sim.effects.status && sim.effects.status.status === 'success';
      return {
        ok: true, txBytes: built.txBytes, quote: built.quote || null,
        simulation: sim, simulationStatus: simOk ? 'success' : 'unavailable', gasEst,
        feeBreakdown: {
          grossProceeds: built.quote?.grossProceeds ?? null,
          tradingFee: built.quote?.tradingFee ?? null,
          builderFee: built.quote?.builderFee ?? null,
          penalty: built.quote?.penalty ?? null,
          impactRebate: built.quote?.impactRebate ?? null,
          netProceeds: built.quote?.netProceeds ?? null,
          actionHubFee: '0.00',
          networkFeeMist: gasEst,
          feesExact: built.quote?.feesExact === true,
        },
        note: 'Unsigned PTB — review in your wallet before signing.',
      };
    } catch (e) {
      if (e.code === 'QUOTE_FAILED' || e.code?.startsWith('INVALID')) return err(e.code, e.message, 400);
      return err('BUILD_FAILED', String(e.message || e).slice(0, 200), 500);
    }
  }

  if (action === 'claim') {
    let wallet;
    try {
      wallet = checkWallet(b.wallet);
    } catch {
      return err('INVALID_WALLET', 'Provide a valid 0x… wallet.', 400);
    }
    if (b.orderId == null) return err('INVALID_REQUEST', 'orderId is required.');
    try {
      const built = await deepbookPredictAdapter.buildClaim({
        wallet, underlying: b.underlying, expiryMs: b.expiryMs ?? b.expiry,
        orderId: b.orderId ?? b.positionId, marketId: b.marketId,
      });
      if (built.error) return err(built.code || 'BUILD_FAILED', built.error, 400);
      const sim = await simulate(built.txBytes, wallet).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
      const simOk = sim && sim.effects && sim.effects.status && sim.effects.status.status === 'success';
      return {
        ok: true, txBytes: built.txBytes, simulation: sim,
        simulationStatus: simOk ? 'success' : 'unavailable', gasEst: simGas(sim),
        note: 'Unsigned claim PTB — review in your wallet. If the market settles automatically onchain, no separate claim is needed.',
      };
    } catch (e) {
      return err('BUILD_FAILED', String(e.message || e).slice(0, 200), 500);
    }
  }

  return err('NOT_FOUND', 'Unknown Predict action.', 404);
}, { limit: 120 });
