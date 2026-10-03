// POST /api/swap — build the PTB (Cetus fastRouterSwap) + devInspect simulation.
// Backend NEVER signs: wallet receives txBytes only (spec §23, §24).
import { handler, readJson } from './_lib/http.js';
import { cetusAdapter, simulate } from './_lib/adapters.js';
import { isWalletAddress } from './_lib/services.js';
import { withBreaker } from './_lib/util.js';
import { calculateFeeBreakdown } from './_lib/fee-engine.js';

// Base units per whole token — the fee leg is carved from the input coin, so
// the human-readable fee MUST be denominated in the input asset, not dollars.
const ASSET_DECIMALS = { SUI: 9, USDC: 6, DEEP: 6, CETUS: 6, NAVX: 6 };
function toHumanAmount(baseUnits, asset) {
  const decimals = ASSET_DECIMALS[String(asset || '').toUpperCase()] ?? 9;
  return String(Number(baseUnits) / 10 ** decimals);
}

export default handler(async (req) => {
  if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
  const b = await readJson(req);
  const { from, to, amountMist, sender, slippage = 0.01 } = b;
  if (!from || !to || !Number.isFinite(Number(amountMist)) || !(Number(amountMist) > 0)) {
    return { error: 'INVALID_BUILD_REQUEST', message: 'Provide from, to and a positive amountMist.', status: 400 };
  }
  if (!isWalletAddress(sender)) return { error: 'INVALID_WALLET', message: 'Sender must be a valid 0x… address.', status: 400 };
  if (!(Number(slippage) >= 0 && Number(slippage) < 1)) return { error: 'INVALID_SLIPPAGE', message: 'Slippage must be between 0 and 1.', status: 400 };
  try {
    const { router, txBytes, feeCollected } = await withBreaker('cetus', () => cetusAdapter.buildSwap({ from: String(from).toUpperCase(), to: String(to).toUpperCase(), amountMist, sender, slippage }));
    const sim = await simulate(txBytes, sender).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
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

    return {
      provider: 'Cetus', quoteId: router.quoteID ?? null,
      amountOut: String(router.amountOut ?? 0),
      txBytes, simulation: sim, gasEst, feeBreakdown, feeCollected,
      builtAt: new Date().toISOString(),
    };
  } catch (e) {
    if (e.code === 'INSUFFICIENT_LIQUIDITY') return { error: e.code, message: 'No route with enough liquidity for this amount.', status: 400 };
    return { error: e.code || 'BUILD_FAILED', detail: String(e.message || e).slice(0, 200), status: 502 };
  }
});
