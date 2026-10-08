// GET/POST /api/earn/<action> — native Sui staking routes.
import { handler, readJson, requireQuery } from '../http.js';
import { isWalletAddress, feeConfig, referralPolicyFor } from '../services.js';
import { simulate } from '../adapters.js';
import { cached, withBreaker } from '../util.js';
import {
  parseMistAmount, earnFeePreview, getValidators, getPositions, systemState,
  nativeStakeTx, nativeUnstakeTx, MIN_STAKE_MIST,
} from '../earn.js';

function err(code, message, status = 400) {
  return { error: code, message, status };
}

function checkWallet(w) {
  if (!isWalletAddress(w)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  return w;
}

/** StakedSui object IDs share the 0x+64hex format of addresses. */
function checkObjectId(v) {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw Object.assign(new Error('INVALID_OBJECT_ID'), { code: 'INVALID_OBJECT_ID' });
  }
  return v;
}

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').pop();

  /* ---------- live reads (cached) ---------- */

  if (action === 'validators') {
    try {
      return await withBreaker('sui-rpc', () => cached('earn:validators', 30_000, getValidators));
    } catch (e) {
      return err('PROVIDER_UNAVAILABLE', 'Validator list unavailable — Sui RPC unreachable.', 502);
    }
  }

  if (action === 'positions') {
    const wallet = checkWallet(requireQuery(url, 'wallet'));
    try {
      return await withBreaker('sui-rpc', () => cached('earn:pos:' + wallet, 15_000, () => getPositions(wallet)));
    } catch (e) {
      return err('PROVIDER_UNAVAILABLE', 'Staking positions unavailable — Sui RPC unreachable.', 502);
    }
  }

  if (action === 'state') {
    try {
      return await withBreaker('sui-rpc', () => cached('earn:state', 15_000, systemState));
    } catch (e) {
      return err('PROVIDER_UNAVAILABLE', 'Sui system state unavailable — Sui RPC unreachable.', 502);
    }
  }

  /* ---------- tx builders (POST; wallet signs, backend never does) ---------- */

  if (req.method !== 'POST') return err('INVALID_REQUEST', 'POST required for stake/unstake.', 400);

  const b = await readJson(req);

  if (action === 'stake') {
    const wallet = checkWallet(b.wallet);
    const validator = checkWallet(b.validator);
    const mist = parseMistAmount(b.amount);
    if (mist === null) {
      return err('INVALID_AMOUNT', 'amount is required in raw MIST (integer; 1 SUI = 1_000_000_000).');
    }
    if (mist < MIN_STAKE_MIST) {
      return err('INVALID_AMOUNT', `Amount is below the on-chain minimum stake of ${MIN_STAKE_MIST} MIST (1 SUI).`);
    }
    const txBytes = await nativeStakeTx(wallet, validator, mist);

    const sim = await simulate(txBytes, wallet).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
    let gasEst = null;
    if (sim && sim.effects && sim.effects.gasUsed) {
      const gu = sim.effects.gasUsed;
      gasEst = String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0)));
    }
    const simOk = sim && !sim.error && sim.effects && sim.effects.status && sim.effects.status.status === 'success';
    // Fail-closed gate: no signable bytes unless the dry run passed.
    if (!simOk) {
      return err('SIMULATION_FAILED', 'On-chain dry run failed: ' + String(sim?.detail || sim?.effects?.status?.error || 'failed').slice(0, 200) + ' — nothing was sent to your wallet.', 400);
    }

    const cfg = await feeConfig();
    const fees = earnFeePreview({ amountSui: Number(mist) / 1e9, earnBps: 0, networkFeeSui: gasEst == null ? null : Number(gasEst) / 1e9 });

    return {
      ok: true,
      mode: 'native',
      action: 'stake',
      validator,
      amountMist: mist.toString(),
      txBytes,
      simulation: sim,
      simulationStatus: 'success',
      simulationDetail: null,
      gasEst,
      fees,
      referralPolicy: referralPolicyFor('sui-native', 'stake'),
      note: 'Unsigned PTB — review in your wallet. Native Sui stake: SUI delegates to the validator; rewards accrue in the StakedSui object and are withdrawn with principal (no separate claim). The hub never signs or custody.',
    };
  }

  if (action === 'unstake') {
    const wallet = checkWallet(b.wallet);
    const stakedSuiId = checkObjectId(b.stakedSuiId);
    const txBytes = await nativeUnstakeTx(wallet, stakedSuiId);

    const sim = await simulate(txBytes, wallet).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
    let gasEst = null;
    if (sim && sim.effects && sim.effects.gasUsed) {
      const gu = sim.effects.gasUsed;
      gasEst = String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0)));
    }
    const simOk = sim && !sim.error && sim.effects?.status?.status === 'success';
    if (!simOk) return err('SIMULATION_FAILED', 'Unstake simulation failed or unavailable; signing blocked.', 400);

    const cfg = await feeConfig();
    const fees = earnFeePreview({ amountSui: 0, earnBps: 0, networkFeeSui: gasEst == null ? null : Number(gasEst) / 1e9 });

    return {
      ok: true,
      mode: 'native',
      action: 'unstake',
      stakedSuiId,
      txBytes,
      simulation: sim,
      simulationStatus: simOk ? 'success' : (sim.error ? 'unavailable' : 'failed'),
      simulationDetail: !simOk && sim.error ? String(sim.detail || '').slice(0, 200) : null,
      gasEst,
      fees,
      feesNote: 'Withdrawn amount (principal + accumulated rewards) is determined on-chain; fees shown are structure-only.',
      referralPolicy: referralPolicyFor('sui-native', 'unstake'),
      note: 'Unsigned PTB — review in your wallet. Native Sui withdraw: returns principal AND accumulated rewards in one transaction — native staking has no separate claim action. The hub never signs or custody.',
    };
  }

  return err('NOT_FOUND', 'Unknown earn action.', 404);
}, { limit: 60 });
