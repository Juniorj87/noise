// Journey providers II: single-asset LST mints for the place-funds flow —
// springsui (sSUI), metastable mSUI (registry path), volo (vSUI).
// Same contract as journey-extension: live reads only, unsigned PTBs appended
// to the journey transaction (atomic with a swap leg where the SDK allows),
// fail-closed errors. STEAMM LP needs two assets and stays in the LP UI.
import { normalizeStructTag } from '@mysten/sui/utils';
import { MetastableSDK, M_SUI } from 'metastable-ts-sdk';
import { fetchLiquidStakingInfo, LstClient } from '@suilend/springsui-sdk';
import { grpcClient, jsonClient, voloStats } from './lending.js';
import { fail, rawHuman } from '../../shared/journey-model.js';

const SUI = normalizeStructTag('0x2::sui::SUI');
const SSUI = '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI';
const SPRING_INFO = {
  id: '0x15eda7330c8f99c30e430b4d82fd7ab2af3ead4ae17046fcb224aa9bad394f6b',
  type: SSUI,
  weightHookId: '0xbbafcb2d7399c0846f8185da3f273ad5b26b3b35993050affa44cfa890f1f144',
};
const CERT = '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT';
const VOLO = {
  package: '0x68d22cf8bdbcd11ecba1e094922873e4080d4d11133e2443fddda0bfd11dae20',
  pool: '0x2d914e23d82fedef1b5f56a32d5c64bdcc3087ccfea2b4d6ea51a71f587840e5',
  metadata: '0x680cd26af32b2bde8d3361e804c53ec1d1cfe24c7f039eb7f549e8dfde389a60',
};
const MSUI = M_SUI.coin;

const nowIso = () => new Date().toISOString();
const canon = (t) => { try { return normalizeStructTag(String(t)); } catch { return String(t); } };

// Trailing staking APY from the official NAVI open API (same family as the
// in-app Volo stats; Haedal methodology = 48h conversion-rate growth).
// Fail-soft: a dead stats endpoint must not kill the mint path.
export async function lstApy(kind) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    if (kind === 'volo') {
      const r = await voloStats();
      const apy = Number(r.apy);
      return Number.isFinite(apy) && apy >= 0 ? apy * 100 : null;
    }
    const r = await fetch(`https://open-api.naviprotocol.io/api/${kind}/stats`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const apy = Number((await r.json())?.data?.apy);
    return Number.isFinite(apy) && apy >= 0 ? apy * 100 : null;
  } catch { return null; } finally { clearTimeout(t); }
}

async function lstBalance(wallet, coinType) {
  const c = jsonClient();
  const page = await c.getCoins({ owner: wallet, coinType }).catch(() => null);
  const coins = (page?.data || []).filter((x) => !x.locked);
  const total = coins.reduce((a, x) => a + BigInt(x.balance || 0), 0n);
  return { coins, total };
}

/* -------------------------------- markets ------------------------------- */

export async function jpMarkets(provider) {
  if (provider === 'springsui') {
    const info = await fetchLiquidStakingInfo(SPRING_INFO, grpcClient());
    const totalSui = Number(info.storage.totalSuiSupply) / 1e9;
    const totalLst = Number(info.lstTreasuryCap.totalSupply.value) / 1e9;
    const rate = totalSui > 0 ? totalLst / totalSui : 0;
    return [{ provider, id: 'SUI', coinType: SUI, symbol: 'SUI', decimals: 9, rate: null, rateKind: 'APY',
      rateBasis: 'No protocol-published sSUI APY exists; yield accrues in the exchange rate below',
      baseRate: null, baseRateKind: 'APR', rewardRate: null, rewardNote: 'Yield accrues in the sSUI exchange rate; annual rate not quantified here',
      exchangeRate: rate, receiptType: SSUI, receiptSymbol: 'sSUI', minimumRaw: '1',
      availableLiquidity: null, withdrawTerms: 'Instant redemption via SIP-33; fresh simulation required.',
      source: 'SpringSui LST object (gRPC)', updatedAt: nowIso() }];
  }
  if (provider === 'metastable') {
    return [{ provider, id: 'SUI', coinType: SUI, symbol: 'SUI', decimals: 9, rate: null, rateKind: 'APY',
      rateBasis: 'No protocol-published mSUI APY exists; value accrues in the vault exchange rate',
      baseRate: null, baseRateKind: 'APR', rewardRate: null, rewardNote: 'Yield accrues in the mSUI exchange rate; annual rate not quantified here',
      exchangeRate: null, receiptType: MSUI, receiptSymbol: 'mSUI', minimumRaw: '1',
      availableLiquidity: null, withdrawTerms: 'Burn mSUI for SUI minus the dynamic 0.01–1% fee; fresh simulation required.',
      source: 'Metastable SDK registry path (SUI as deposit asset)', updatedAt: nowIso() }];
  }
  if (provider === 'volo') {
    const apy = await lstApy('volo');
    return [{ provider, id: 'SUI', coinType: SUI, symbol: 'SUI', decimals: 9, rate: apy, rateKind: 'APY',
      rateBasis: apy == null ? 'Exchange rate is NOT an annual yield; no verified APY provided here' : 'NAVI open API vSUI stats — trailing staking APY, variable',
      baseRate: null, baseRateKind: 'APR', rewardRate: null, rewardNote: 'Yield accrues in the vSUI exchange rate; annual rate not quantified here',
      exchangeRate: null, receiptType: CERT, receiptSymbol: 'vSUI', minimumRaw: '100000000',
      availableLiquidity: null, withdrawTerms: 'Instant redemption via Volo pool; fresh simulation required.',
      source: 'Volo stake_pool objects (verified on-chain)', updatedAt: nowIso() }];
  }
  fail('INVALID_PROVIDER');
}

/* ------------------------------- positions ------------------------------ */

async function receiptPosition(wallet, provider, receiptType, receiptSymbol, underlying) {
  const { total } = await lstBalance(wallet, receiptType);
  if (total <= 0n) return [];
  const raw = String(total);
  return [{ id: receiptSymbol, provider, marketId: 'SUI', asset: 'SUI', coinType: SUI, inputType: receiptType,
    decimals: 9, amountRaw: raw, amountHuman: rawHuman(raw, 9),
    underlyingHuman: underlying ? rawHuman(String(total * BigInt(Math.round(underlying * 1e6)) / 1000000n), 9) : null,
    withdrawUnit: receiptSymbol, debt: false, health: null, canWithdraw: true,
    risk: 'Liquid staking: validator, smart-contract, exchange-rate and withdrawal liquidity risks',
    source: 'Wallet receipt-token balance (live read)', updatedAt: nowIso() }];
}

export async function jpPositions(wallet, provider) {
  if (provider === 'springsui') {
    const info = await fetchLiquidStakingInfo(SPRING_INFO, grpcClient());
    const totalSui = Number(info.storage.totalSuiSupply) / 1e9;
    const totalLst = Number(info.lstTreasuryCap.totalSupply.value) / 1e9;
    const rate = totalSui > 0 ? totalLst / totalSui : 0;
    return { complete: true, positions: await receiptPosition(wallet, provider, SSUI, 'sSUI', rate || null) };
  }
  if (provider === 'metastable') {
    return { complete: true, positions: await receiptPosition(wallet, provider, MSUI, 'mSUI', null) };
  }
  if (provider === 'volo') {
    return { complete: true, positions: await receiptPosition(wallet, provider, CERT, 'vSUI', null) };
  }
  fail('INVALID_PROVIDER');
}

/* -------------------------------- deposit ------------------------------- */

export async function jpDeposit(tx, wallet, provider, market, o) {
  const { inputCoin, fromCoinType, amountMist } = o;
  if (provider === 'springsui') {
    const lst = await LstClient.initialize(grpcClient(), SPRING_INFO);
    const out = lst.mint(tx, inputCoin);
    const res = out && (out.$kind === 'NestedResult' ? out : out);
    if (res) tx.transferObjects([res], tx.pure.address(wallet));
    return { transaction: tx, coin: null, receiptSymbol: 'sSUI', note: 'Minted sSUI at the live exchange rate; instant redemption via SIP-33.' };
  }
  if (provider === 'volo') {
    if (BigInt(amountMist) < 100000000n) fail('INVALID_AMOUNT', 'Volo minimum stake is 0.1 SUI.');
    // stake_entry transfers the vSUI receipt to the sender internally
    // (same pattern as protocol-execution voloBuild: no result to forward).
    tx.moveCall({ target: `${VOLO.package}::stake_pool::stake_entry`,
      arguments: [tx.object(VOLO.pool), tx.object(VOLO.metadata), tx.object('0x5'), inputCoin] });
    return { transaction: tx, coin: null, receiptSymbol: 'vSUI', note: 'Staked SUI for vSUI (min 0.1 SUI); instant redemption.' };
  }
  if (provider === 'metastable') {
    // The SDK selects wallet coins itself, so this path is SUI-direct only:
    // inputCoin must be untouched (no prior swap leg consumed it).
    if (canon(fromCoinType) !== SUI) {
      fail('INVALID_ACTION', 'mSUI mints direct from SUI only — use Swap-only mode first, then mint.');
    }
    const sdk = new MetastableSDK({ suiClient: jsonClient() });
    const human = rawHuman(String(amountMist), 9);
    await sdk.buildMintTx({ mCoin: MSUI, coin: SUI, amountIn: Number(human), walletAddress: wallet, tx });
    return { transaction: tx, coin: null, receiptSymbol: 'mSUI', note: 'Minted mSUI at the on-chain price feed; deposit fee 0%.' };
  }
  fail('INVALID_PROVIDER');
}

/* ------------------------------- withdraw ------------------------------- */

export async function jpWithdraw(tx, wallet, provider, position, market, amountMist) {
  const amount = BigInt(amountMist);
  if (provider === 'springsui') {
    const { coins, total } = await lstBalance(wallet, SSUI);
    if (total < amount) fail('INSUFFICIENT_BALANCE', 'sSUI balance insufficient.');
    const ids = coins.map((c) => tx.object(c.coinObjectId));
    if (ids.length > 1) tx.mergeCoins(ids[0], ids.slice(1));
    const [coin] = tx.splitCoins(ids[0], [tx.pure.u64(amount)]);
    const lst = await LstClient.initialize(grpcClient(), SPRING_INFO);
    const out = lst.redeem(tx, coin);
    const res = out && (out.$kind === 'NestedResult' ? out : out);
    if (res) tx.transferObjects([res], tx.pure.address(wallet));
    return { transaction: tx, coin: null, note: 'Redeemed sSUI for SUI instantly (SIP-33).' };
  }
  if (provider === 'metastable') {
    const sdk = new MetastableSDK({ suiClient: jsonClient() });
    const { total } = await lstBalance(wallet, MSUI);
    if (total < amount) fail('INSUFFICIENT_BALANCE', 'mSUI balance insufficient.');
    const human = rawHuman(String(amount), 9);
    await sdk.buildBurnTx({ mCoin: MSUI, coin: SUI, amountIn: Number(human), walletAddress: wallet, tx });
    return { transaction: tx, coin: null, note: 'Burned mSUI for SUI minus the dynamic 0.01–1% fee.' };
  }
  if (provider === 'volo') {
    const { coins, total } = await lstBalance(wallet, CERT);
    if (total < amount) fail('INSUFFICIENT_BALANCE', 'vSUI balance insufficient.');
    const ids = coins.map((c) => tx.object(c.coinObjectId));
    if (ids.length > 1) tx.mergeCoins(ids[0], ids.slice(1));
    const [coin] = tx.splitCoins(ids[0], [tx.pure.u64(amount)]);
    // unstake_entry sends the redeemed SUI to the sender internally.
    tx.moveCall({ target: `${VOLO.package}::stake_pool::unstake_entry`,
      arguments: [tx.object(VOLO.pool), tx.object(VOLO.metadata), tx.object('0x5'), coin] });
    return { transaction: tx, coin: null, note: 'Redeemed vSUI for SUI instantly.' };
  }
  fail('INVALID_PROVIDER');
}
