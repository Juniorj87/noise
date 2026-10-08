import { turbosSwapBuild } from '../protocol-execution.js';
import { venueConfig } from '../../../shared/routed-venues.js';
// POST /api/swap — build the PTB (Cetus fastRouterSwap) + devInspect simulation.
// Backend NEVER signs: wallet receives txBytes only (spec §23, §24).
import { positiveU64 } from '../../../shared/execution-math.js';
import { handler, readJson } from '../http.js';
import { cetusAdapter, simulate, coinType } from '../adapters.js';
import { isWalletAddress, feeConfig } from '../services.js';
import { withBreaker } from '../util.js';
import { calculateFeeBreakdown } from '../fee-engine.js';
import { aftermathSwapBuild, normalizeLendingError } from '../lending.js';

// Base units per whole token — the fee leg is carved from the input coin, so
// the human-readable fee MUST be denominated in the input asset, not dollars.
const ASSET_DECIMALS = { SUI: 9, USDC: 6, DEEP: 6, CETUS: 9, NAVX: 9 };
function toHumanAmount(baseUnits, asset) {
  const decimals = ASSET_DECIMALS[String(asset || '').toUpperCase()] ?? 9;
  return String(Number(baseUnits) / 10 ** decimals);
}

export default handler(async (req) => {
  if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
  const b = await readJson(req);
  const { from, to, sender, slippage = 0.01 } = b;
  let amountMist;
  try { amountMist = String(positiveU64(b.amountMist)); }
  catch (e) { return { error: 'INVALID_AMOUNT', message: e.message, status: 400 }; }
  if (!from || !to || !Number.isFinite(Number(amountMist)) || !(Number(amountMist) > 0)) {
    return { error: 'INVALID_BUILD_REQUEST', message: 'Provide from, to and a positive amountMist.', status: 400 };
  }
  if (!isWalletAddress(sender)) return { error: 'INVALID_WALLET', message: 'Sender must be a valid 0x… address.', status: 400 };
  if (!(Number(slippage) >= 0 && Number(slippage) < 1)) return { error: 'INVALID_SLIPPAGE', message: 'Slippage must be between 0 and 1.', status: 400 };
  // Aftermath execution path: quote -> route -> tx (with Noise fee leg) -> simulate.
  // Fail-closed: signable bytes are returned ONLY on devInspect success.
  if (['aftermath','turbos'].includes(String(b.provider || '').toLowerCase())) {
    const selectedProvider = String(b.provider).toLowerCase();
    try {
      const cfg = await feeConfig().catch(() => ({ swapBps: 2 }));
      const r = await withBreaker(selectedProvider, () => (selectedProvider === 'turbos' ? turbosSwapBuild : aftermathSwapBuild)({
        wallet: sender,
        fromType: coinType(String(from).toUpperCase()),
        toType: coinType(String(to).toUpperCase()),
        amountMist: String(amountMist),
        slippage: Number(slippage),
        feeBps: Number(cfg.swapBps || 0),
        feeRecipient: null,
      }));
      const sim = await simulate(r.txBytes, sender).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
      if (!sim || sim.error || sim?.effects?.status?.status !== 'success') {
        return { error: 'SIMULATION_FAILED', message: 'On-chain dry run failed: ' + String(sim?.detail || sim?.effects?.status?.error || 'failed').slice(0, 200) + ' — nothing was sent to your wallet.', status: 400 };
      }
      let gasEst = null;
      if (sim && sim.effects && sim.effects.gasUsed) {
        const gu = sim.effects.gasUsed;
        gasEst = String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0)));
      }
      return {
        provider: selectedProvider === 'turbos' ? 'Turbos' : 'Aftermath', amountOut: String(r.meta?.amountOut ?? 0),
        txBytes: r.txBytes, simulation: sim, simulationStatus: 'success', gasEst, feeCollected: r.meta?.feeCollected || null,
        feeBreakdown: { platformFee: r.meta?.feeCollected ? toHumanAmount(r.meta.feeCollected.amountMist, from) : '0', platformFeeAsset: String(from).toUpperCase(), networkFee: gasEst == null ? null : String(Number(gasEst) / 1e9), networkFeeAsset: 'SUI' },
        builtAt: new Date().toISOString(),
      };
    } catch (e) {
      const n = normalizeLendingError(e);
      return { error: n.code || 'BUILD_FAILED', detail: String(n.message || e).slice(0, 200), status: /INVALID|INSUFFICIENT/.test(n.code) ? 400 : 502 };
    }
  }
  try {
    venueConfig(b.provider);
    const { router, txBytes, feeCollected, provider } = await withBreaker('cetus', () => cetusAdapter.buildSwap({ from: String(from).toUpperCase(), to: String(to).toUpperCase(), amountMist, sender, slippage, venue: b.provider }));
    const sim = await simulate(txBytes, sender).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
    if (!sim || sim.error || sim?.effects?.status?.status !== 'success') {
      return { error: 'SIMULATION_FAILED', message: 'On-chain dry run failed: ' + String(sim?.detail || sim?.effects?.status?.error || 'failed').slice(0, 200) + ' — nothing was sent to your wallet.', status: 400 };
    }
    let gasEst = null;
    if (sim && sim.effects && sim.effects.gasUsed) {
      const gu = sim.effects.gasUsed;
      gasEst = String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0)));
    }

    // Fee breakdown: the Action Hub line reflects ONLY the fee leg actually
    // present in the PTB (feeCollected). No recipient / non-SUI input →
    // nothing collected and 0 of the input asset displayed — never fake
    // accounting. The value is denominated in the input coin (platformFeeAsset).
    const feeBreakdown = await calculateFeeBreakdown({
      protocolFee: router.protocolFee || '0',
      providerFee: router.providerFee || '0',
      networkFee: gasEst || '0',
      action: 'swap',
      provider: 'cetus',
      instrument: `${from}_${to}`,
      amount: router.amountOut || '0',
      asset: to,
    });
    const feeAsset = String(from).toUpperCase();
    // feeCollected.amountMist is the raw on-chain leg (base units of the input
    // coin). Report it in whole input-token units so it is comparable with the
    // engine estimate and never mislabelled as USD.
    const feeHuman = feeCollected ? toHumanAmount(feeCollected.amountMist, feeAsset) : '0';
    if (!feeCollected) {
      feeBreakdown.platformFee = '0';
      feeBreakdown.platformFeeAsset = feeAsset;
      feeBreakdown.breakdown.platform = { amount: '0', asset: feeAsset, label: 'Noise Hub fee', enabled: false };
      feeBreakdown.total = String(Number(feeBreakdown.protocolFee || 0) + Number(feeBreakdown.providerFee || 0) + Number(feeBreakdown.networkFee || 0));
    } else {
      feeBreakdown.platformFee = feeHuman;
      feeBreakdown.platformFeeAsset = feeAsset;
      feeBreakdown.breakdown.platform = { amount: feeHuman, asset: feeAsset, label: 'Noise Hub fee', enabled: true, recipient: feeCollected.recipient, bps: feeCollected.bps };
      feeBreakdown.total = String(Number(feeBreakdown.protocolFee || 0) + Number(feeBreakdown.providerFee || 0) + Number(feeHuman || 0) + Number(feeBreakdown.networkFee || 0));
    }

    // Protocol/pool charges are included in route output but are not separately
    // quantified here. Never add input-token amounts to SUI gas as one total.
    feeBreakdown.protocolFee = null;
    feeBreakdown.providerFee = null;
    feeBreakdown.networkFee = gasEst == null ? null : String(Number(gasEst) / 1e9);
    feeBreakdown.networkFeeAsset = 'SUI';
    feeBreakdown.total = null;
    feeBreakdown.totalBasis = 'Fees denominated by asset; no cross-asset sum';
    feeBreakdown.breakdown.protocol = {amount:null,label:'Pool fees included in quoted output'};
    feeBreakdown.breakdown.provider = {amount:null,label:'Provider charges included in quoted output'};
    feeBreakdown.breakdown.network = {amount:feeBreakdown.networkFee,asset:'SUI',label:'Simulated net gas charge'};

    return {
      provider, quoteId: router.quoteID ?? null,
      amountOut: String(router.amountOut ?? 0),
      txBytes, simulation: sim, simulationStatus: 'success', gasEst, feeBreakdown, feeCollected,
      builtAt: new Date().toISOString(),
    };
  } catch (e) {
    if (e.code === 'INSUFFICIENT_LIQUIDITY') return { error: e.code, message: 'No route with enough liquidity for this amount.', status: 400 };
    return { error: e.code || 'BUILD_FAILED', detail: String(e.message || e).slice(0, 200), status: 502 };
  }
});
