// /api/lending/<provider>/<action> — NAVI + Suilend + Haedal + Scallop + Bucket execution layer.
// Reads (GET): markets (navi/suilend/scallop/bucket) | position | rewards (navi) | rate (haedal).
// Builds (POST): supply | withdraw | borrow | repay | claim | stake | unstake.
// Every build is devInspect-simulated BEFORE bytes are returned: a failed
// simulation is SIMULATION_FAILED, never silent bytes. The backend never signs.
import { handler, readJson } from '../http.js';
import { cached, withBreaker } from '../util.js';
import {
  normalizeLendingError,
  devInspectB64,
  suilendMarkets, suilendPosition, suilendSupply, suilendWithdraw,
  suilendBorrow, suilendRepay, suilendClaim,
  naviMarkets, naviPosition, naviRewards, naviSupply, naviWithdraw,
  naviBorrow, naviRepay, naviClaim,
  haedalRate, haedalPosition, haedalStakeBuild, haedalUnstakeInstantBuild,
  haedalUnstakeRequestBuild, haedalClaimBuild,
  marginPreflight, marginSetupBuild,
  mstableMint, mstableBurn,
  springsuiMint, springsuiRedeem,
  scallopMarkets, scallopSupply, scallopWithdraw, scallopBorrow, scallopRepay,
  scallopPositions,
  bucketMarkets, bucketPsmSwap, bucketPositions,
} from '../lending.js';

import { voloBuild, voloState } from '../protocol-execution.js';

const PROVIDERS = ['navi', 'suilend', 'haedal', 'margin', 'metastable', 'springsui', 'scallop', 'bucket', 'volo'];

function bad(e) {
  const n = normalizeLendingError(e);
  const status = n.code === 'PROVIDER_UNAVAILABLE' || n.code === 'NETWORK_ERROR' ? 502
    : n.code === 'SIMULATION_FAILED' ? 400
    : /INVALID|NO_|MISSING/.test(n.code) ? 400 : 502;
  return { error: n.code, message: String(n.message || '').slice(0, 300), status };
}

/* Fail-closed simulation gate: signable bytes are returned ONLY on devInspect
 * success. No success → SIMULATION_FAILED with no txBytes, never a fallback. */
async function simulated(txBytes, wallet, meta) {
  let sim = null, gasEst = null;
  try {
    const r = await devInspectB64(txBytes, wallet);
    sim = r.simulation;
    if (!r.ok) {
      const detail = String(sim?.effects?.status?.error || 'simulation failed').slice(0, 200);
      return { error: 'SIMULATION_FAILED', message: 'On-chain dry run failed: ' + detail + ' — nothing was sent to your wallet.', status: 400 };
    }
    const gu = sim?.effects?.gasUsed;
    if (gu) gasEst = String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0)));
  } catch (e) {
    return { error: 'SIMULATION_FAILED', message: 'Simulation unavailable (' + String(e.message || e).slice(0, 120) + ') — signing blocked for safety. Retry shortly.', status: 400 };
  }
  return { txBytes, simulation: sim, simulationStatus: 'success', gasEst, meta };
}

export default handler(async (req, res, url) => {
  const parts = url.pathname.split('/').filter(Boolean); // api lending <provider> <action>
  let provider = parts[2] || '';
  let action = parts[3] || '';
  // Multiplex shape (same contract as the dev server): POST /api/lending/build
  // { provider, action, ... }. Single frontend code path for both backends.
  let preBody = null;
  if (provider === 'build' && req.method === 'POST') {
    preBody = await readJson(req);
    provider = String(preBody.provider || '');
    action = String(preBody.action || '');
  }
  if (!PROVIDERS.includes(provider)) {
    return { error: 'NOT_FOUND', message: 'Unknown lending provider. Known: navi, suilend, haedal, margin, metastable, springsui, scallop, bucket.', status: 404 };
  }

  /* ------------------------------- reads ------------------------------- */
  if (req.method === 'GET') {
    try {
      if (provider === 'volo' && action === 'state') return await voloState();
      if (provider === 'navi' && action === 'markets') {
        return await withBreaker('navi', () => cached('lending:navi:markets', 120_000, () => naviMarkets()));
      }
      if (provider === 'navi' && action === 'position') {
        const wallet = url.searchParams.get('wallet');
        if (!wallet) return { error: 'MISSING_WALLET', message: 'wallet required.', status: 400 };
        return await withBreaker('navi', () => cached('lending:navi:pos:' + wallet, 30_000, () => naviPosition(wallet)));
      }
      if (provider === 'navi' && action === 'rewards') {
        const wallet = url.searchParams.get('wallet');
        if (!wallet) return { error: 'MISSING_WALLET', message: 'wallet required.', status: 400 };
        return await withBreaker('navi', () => cached('lending:navi:rew:' + wallet, 30_000, () => naviRewards(wallet)));
      }
      if (provider === 'suilend' && action === 'markets') {
        return await withBreaker('suilend', () => cached('lending:suilend:markets', 120_000, () => suilendMarkets()));
      }
      if (provider === 'suilend' && action === 'position') {
        const wallet = url.searchParams.get('wallet');
        if (!wallet) return { error: 'MISSING_WALLET', message: 'wallet required.', status: 400 };
        return await withBreaker('suilend', () => cached('lending:suilend:pos:' + wallet, 30_000, () => suilendPosition(wallet)));
      }
      if (provider === 'haedal' && action === 'rate') {
        return await withBreaker('haedal', () => cached('lending:haedal:rate', 60_000, () => haedalRate()));
      }
      if (provider === 'haedal' && action === 'position') {
        const wallet = url.searchParams.get('wallet');
        if (!wallet) return { error: 'MISSING_WALLET', message: 'wallet required.', status: 400 };
        return await withBreaker('haedal', () => cached('lending:haedal:pos:' + wallet, 30_000, () => haedalPosition(wallet)));
      }
      if (provider === 'margin' && action === 'preflight') {
        const pool = url.searchParams.get('pool') || 'SUI_USDC';
        return await withBreaker('margin', () => cached('lending:margin:pre:' + pool, 120_000, () => marginPreflight(pool)));
      }
      if (provider === 'scallop' && action === 'markets') {
        return await withBreaker('scallop', () => cached('lending:scallop:markets', 120_000, () => scallopMarkets()));
      }
      if (provider === 'scallop' && action === 'position') {
        const wallet = url.searchParams.get('wallet');
        if (!wallet) return { error: 'MISSING_WALLET', message: 'wallet required.', status: 400 };
        return await withBreaker('scallop', () => cached('lending:scallop:pos:' + wallet, 30_000, () => scallopPositions(wallet)));
      }
      if (provider === 'bucket' && action === 'markets') {
        return await withBreaker('bucket', () => cached('lending:bucket:markets', 120_000, () => bucketMarkets()));
      }
      if (provider === 'bucket' && action === 'position') {
        const wallet = url.searchParams.get('wallet');
        if (!wallet) return { error: 'MISSING_WALLET', message: 'wallet required.', status: 400 };
        return await withBreaker('bucket', () => cached('lending:bucket:pos:' + wallet, 30_000, () => bucketPositions(wallet)));
      }
      return { error: 'NOT_FOUND', message: 'Unknown lending read.', status: 404 };
    } catch (e) { return bad(e); }
  }

  /* ------------------------------- builds ------------------------------ */
  if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required for builds.', status: 400 };
  const b = preBody || await readJson(req);
  try {
    if (provider === 'volo') {
      const r = await voloBuild({wallet:b.wallet,amountMist:b.amountMist,action});
      return await simulated(r.txBytes,b.wallet,r.meta);
    }
    if (provider === 'navi') {
      if (action === 'supply') {
        const r = await naviSupply({ wallet: b.wallet, coinType: b.coinType, amountMist: b.amountMist, pool: b.pool });
        return await simulated(r.txBytes, b.wallet, { provider: 'navi', action, ...r.meta });
      }
      if (action === 'withdraw') {
        const r = await naviWithdraw({ wallet: b.wallet, coinType: b.coinType, amountMist: b.amountMist, pool: b.pool });
        return await simulated(r.txBytes, b.wallet, { provider: 'navi', action, ...r.meta });
      }
      if (action === 'borrow') {
        const r = await naviBorrow({ wallet: b.wallet, coinType: b.coinType, amountMist: b.amountMist, pool: b.pool });
        return await simulated(r.txBytes, b.wallet, { provider: 'navi', action, ...r.meta });
      }
      if (action === 'repay') {
        const r = await naviRepay({ wallet: b.wallet, coinType: b.coinType, amountMist: b.amountMist, pool: b.pool });
        return await simulated(r.txBytes, b.wallet, { provider: 'navi', action, ...r.meta });
      }
      if (action === 'claim') {
        const r = await naviClaim({ wallet: b.wallet });
        return await simulated(r.txBytes, b.wallet, { provider: 'navi', action, ...r.meta });
      }
    }
    if (provider === 'suilend') {
      if (action === 'supply') {
        const r = await suilendSupply({ wallet: b.wallet, coinType: b.coinType, amountMist: b.amountMist });
        return await simulated(r.txBytes, b.wallet, { provider: 'suilend', action, ...r.meta });
      }
      if (action === 'withdraw') {
        const r = await suilendWithdraw({ wallet: b.wallet, coinType: b.coinType, amountMist: b.amountMist });
        return await simulated(r.txBytes, b.wallet, { provider: 'suilend', action, ...r.meta });
      }
      if (action === 'borrow') {
        const r = await suilendBorrow({ wallet: b.wallet, coinType: b.coinType, amountMist: b.amountMist });
        return await simulated(r.txBytes, b.wallet, { provider: 'suilend', action, ...r.meta });
      }
      if (action === 'repay') {
        const r = await suilendRepay({ wallet: b.wallet, coinType: b.coinType, amountMist: b.amountMist, obligationId: b.obligationId });
        return await simulated(r.txBytes, b.wallet, { provider: 'suilend', action, ...r.meta });
      }
      if (action === 'claim') {
        const r = await suilendClaim({ wallet: b.wallet });
        return await simulated(r.txBytes, b.wallet, { provider: 'suilend', action, ...r.meta });
      }
    }
    if (provider === 'margin') {
      if (action === 'setup') {
        const r = await marginSetupBuild({ wallet: b.wallet, poolKey: b.pool || b.poolKey });
        return await simulated(r.txBytes, b.wallet, { provider: 'margin', action, ...r.meta });
      }
    }
    if (provider === 'metastable') {
      if (action === 'mint') {
        const r = await mstableMint({ wallet: b.wallet, mCoin: b.mCoin, coinType: b.coinType, amountHuman: b.amountHuman || b.amount, minOut: b.minOut });
        return await simulated(r.txBytes, b.wallet, { provider: 'metastable', action, ...r.meta });
      }
      if (action === 'burn') {
        const r = await mstableBurn({ wallet: b.wallet, mCoin: b.mCoin, coinType: b.coinType, amountHuman: b.amountHuman || b.amount, minOut: b.minOut });
        return await simulated(r.txBytes, b.wallet, { provider: 'metastable', action, ...r.meta });
      }
    }
    if (provider === 'springsui') {
      if (action === 'mint') {
        const r = await springsuiMint({ wallet: b.wallet, amountMist: b.amountMist });
        return await simulated(r.txBytes, b.wallet, { provider: 'springsui', action, ...r.meta });
      }
      if (action === 'redeem') {
        const r = await springsuiRedeem({ wallet: b.wallet, ssuiObjectId: b.ssuiObjectId, amountMist: b.amountMist });
        return await simulated(r.txBytes, b.wallet, { provider: 'springsui', action, ...r.meta });
      }
    }
    if (provider === 'scallop') {
      const fn = { supply: scallopSupply, withdraw: scallopWithdraw, borrow: scallopBorrow, repay: scallopRepay }[action];
      if (fn) {
        const r = await fn({ wallet: b.wallet, coinName: b.coinName || b.coin || b.symbol, amountMist: b.amountMist, obligationId: b.obligationId, obligationKey: b.obligationKey });
        return await simulated(r.txBytes, b.wallet, { provider: 'scallop', action, ...r.meta });
      }
    }
    if (provider === 'bucket') {
      if (action === 'psm-swap') {
        const r = await bucketPsmSwap({ wallet: b.wallet, coinType: b.coinType, amountMist: b.amountMist, dir: b.dir });
        return await simulated(r.txBytes, b.wallet, { provider: 'bucket', action, ...r.meta });
      }
    }
    if (provider === 'haedal') {
      if (action === 'stake') {
        const r = await haedalStakeBuild({ wallet: b.wallet, amountMist: b.amountMist, validator: b.validator });
        return await simulated(r.txBytes, b.wallet, { provider: 'haedal', action, ...r.meta });
      }
      if (action === 'unstake') {
        const r = b.mode === 'instant'
          ? await haedalUnstakeInstantBuild({ wallet: b.wallet, hasuiMist: b.amountMist, hasuiType: b.coinType })
          : await haedalUnstakeRequestBuild({ wallet: b.wallet, hasuiMist: b.amountMist, hasuiType: b.coinType });
        return await simulated(r.txBytes, b.wallet, { provider: 'haedal', action, ...r.meta });
      }
      if (action === 'claim') {
        const r = await haedalClaimBuild({ wallet: b.wallet, ticketId: b.ticketId });
        return await simulated(r.txBytes, b.wallet, { provider: 'haedal', action, ...r.meta });
      }
    }
    return { error: 'NOT_FOUND', message: 'Unknown lending build.', status: 404 };
  } catch (e) { return bad(e); }
}, { limit: 60 });
