// GET/POST /api/aftermath/<action> — Aftermath surfaces.
// GET: staking-apy | rewards | pools | lp | positions | liquid.
// POST: liquid-stake | liquid-unstake — build unsigned PTBs only;
// the wallet signs, the backend never does (spec §5, §16).
import { handler, readJson, requireQuery } from '../http.js';
import { aftermathAdapter, simulate } from '../adapters.js';
import { cached, withBreaker } from '../util.js';
import { isWalletAddress, feeConfig, referralPolicyFor } from '../services.js';
import {
  parseMistAmount, earnFeePreview,
  liquidStakeTx, liquidUnstakeTx, aftermathPositions, liquidState,
  MIN_STAKE_MIST, MIN_UNSTAKE_MIST,
} from '../earn.js';

function err(code, message, status = 400) {
  return { error: code, message, status };
}

function checkWallet(w) {
  if (!isWalletAddress(w)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  return w;
}

/** Map SDK coin-selection / Move failures to honest 4xx codes. */
function mapBuildError(e) {
  const msg = String(e?.message || e).toLowerCase();
  if (msg.includes('does not have coins') || msg.includes('insufficient balance')) {
    return err('INSUFFICIENT_FUNDS', 'Wallet balance is insufficient for this amount — nothing was signed or sent.', 422);
  }
  if (msg.includes('inactive validator') || msg.includes('invalid validator')) {
    return err('INVALID_VALIDATOR', 'Validator is not active for liquid staking — pick another validator.', 400);
  }
  console.error('[api:aftermath] build failed:', String(e?.message || e).slice(0, 300));
  return err('BUILD_FAILED', 'Transaction could not be built — nothing was signed or sent.', 400);
}

/** Shared build → simulate → gate → fee preview flow for liquid staking. */
async function buildLiquid({ txBytes, wallet, action, amountMist, extra = {} }) {
  const sim = await simulate(txBytes, wallet).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
  let gasEst = null;
  if (sim && sim.effects && sim.effects.gasUsed) {
    const gu = sim.effects.gasUsed;
    gasEst = String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0)));
  }
  const simOk = sim && sim.effects && sim.effects.status && sim.effects.status.status === 'success';
  const cfg = await feeConfig();
  return {
    ok: true,
    mode: 'liquid',
    protocol: 'aftermath',
    action,
    amountMist: amountMist.toString(),
    txBytes,
    simulation: sim,
    simulationStatus: simOk ? 'success' : (sim.error ? 'unavailable' : 'failed'),
    simulationDetail: !simOk && sim.error ? String(sim.detail || '').slice(0, 200) : null,
    gasEst,
    fees: earnFeePreview({
      amountSui: Number(amountMist) / 1e9,
      earnBps: cfg.earnBps,
      ...extra.fees,
    }),
    referralPolicy: referralPolicyFor('aftermath', action === 'liquid-stake' ? 'stake' : 'unstake'),
    ...extra.body,
  };
}

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').pop();

  /* ---------- live reads (cached, GET) ---------- */
  if (req.method === 'GET') {
    if (action === 'rewards') {
      const wallet = requireQuery(url, 'wallet');
      try {
        return await withBreaker('aftermath', () => cached('af:rewards:' + wallet, 60_000, () => aftermathAdapter.getClaimableRewards(wallet)));
      } catch (e) {
        return { error: e.code || 'PROVIDER_UNAVAILABLE', message: 'Aftermath provider unreachable.', status: 502 };
      }
    }
    if (action === 'lp') {
      const wallet = requireQuery(url, 'wallet');
      try {
        return await withBreaker('aftermath', () => cached('af:lp:' + wallet, 60_000, () => aftermathAdapter.getOwnedLp(wallet)));
      } catch (e) {
        return { error: e.code || 'PROVIDER_UNAVAILABLE', message: 'Aftermath provider unreachable.', status: 502 };
      }
    }
    if (action === 'positions') {
      const wallet = checkWallet(requireQuery(url, 'wallet'));
      try {
        return await withBreaker('aftermath', () => cached('af:positions:' + wallet, 60_000, () => aftermathPositions(wallet)));
      } catch (e) {
        return { error: e.code || 'PROVIDER_UNAVAILABLE', message: 'Aftermath provider unreachable.', status: 502 };
      }
    }
    try {
      if (action === 'staking-apy') {
        return await withBreaker('aftermath', () => cached('af:staking-apy', 300_000, () => aftermathAdapter.getStakingApy()));
      }
      if (action === 'pools') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 12), 50);
        return await withBreaker('aftermath', () => cached('af:pools:' + limit, 90_000, () => aftermathAdapter.getPoolSummaries(limit)));
      }
      if (action === 'liquid') {
        return await withBreaker('aftermath', () => cached('af:liquid', 90_000, liquidState));
      }
      return { error: 'NOT_FOUND', message: 'Unknown aftermath action.', status: 404 };
    } catch (e) {
      return { error: e.code || 'PROVIDER_UNAVAILABLE', message: 'Aftermath provider unreachable.', status: 502 };
    }
  }

  /* ---------- tx builders (POST; wallet signs, backend never does) ---------- */

  if (req.method !== 'POST') return err('INVALID_REQUEST', 'POST required for liquid-stake/liquid-unstake.', 400);

  const b = await readJson(req);

  if (action === 'liquid-stake') {
    const wallet = checkWallet(b.wallet);
    const validator = checkWallet(b.validator);
    const mist = parseMistAmount(b.amount);
    if (mist === null) {
      return err('INVALID_AMOUNT', 'amount is required in raw MIST (integer; 1 SUI = 1_000_000_000).');
    }
    if (mist < MIN_STAKE_MIST) {
      return err('INVALID_AMOUNT', `Amount is below the protocol minimum stake of ${MIN_STAKE_MIST} MIST (1 SUI).`);
    }
    try {
      const txBytes = await liquidStakeTx(wallet, validator, mist);
      return await buildLiquid({
        txBytes, wallet, action: 'liquid-stake', amountMist: mist,
        extra: {
          body: {
            validator,
            note: 'Liquid-stake: SUI → afSUI via Aftermath. Unsigned PTB — review in your wallet. afSUI accrues staking yield and can be swapped back to SUI. The hub never signs or custody.',
          },
        },
      });
    } catch (e) {
      return mapBuildError(e);
    }
  }

  if (action === 'liquid-unstake') {
    const wallet = checkWallet(b.wallet);
    const mist = parseMistAmount(b.amount);
    if (mist === null) {
      return err('INVALID_AMOUNT', 'amount is required in raw afSUI MIST (integer; 1 afSUI = 1_000_000_000).');
    }
    if (mist < MIN_UNSTAKE_MIST) {
      return err('INVALID_AMOUNT', `Amount is below the protocol minimum unstake of ${MIN_UNSTAKE_MIST} afSUI-MIST (1 afSUI).`);
    }
    const isAtomic = b.isAtomic !== false;
    try {
      const txBytes = await liquidUnstakeTx(wallet, mist, isAtomic);
      return await buildLiquid({
        txBytes, wallet, action: 'liquid-unstake', amountMist: mist,
        extra: {
          fees: {
            protocolFeeRatio: 0.05,
            protocolFeeBasis: 'Aftermath SDK Staking.constants.fees.protocolUnstake (5% of unstaked afSUI) — charged on-chain by the vault',
          },
          body: {
            isAtomic,
            note: isAtomic
              ? 'Atomic unstake: afSUI → SUI immediately. Can fail on-chain with "Insufficient Sui Reserves" when the vault cannot satisfy the swap. Unsigned PTB — review in your wallet.'
              : 'Queued unstake: the request is processed at the next epoch boundary; SUI is available afterwards. Unsigned PTB — review in your wallet.',
          },
        },
      });
    } catch (e) {
      return mapBuildError(e);
    }
  }

  return err('NOT_FOUND', 'Unknown aftermath action.', 404);
}, { limit: 60 });
