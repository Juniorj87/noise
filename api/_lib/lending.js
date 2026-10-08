import { boundedGasPayment } from './gas-payment.js';
// Shared execution builders: Transfer + Suilend + NAVI + Haedal + Aftermath-swap-build.
// One pipeline for all of them: validate -> preflight -> build unsigned PTB ->
// serialize (b64) -> devInspect simulate -> wallet signs -> track. Nothing here
// signs or submits. Normalized errors only (see normalizeLendingError).
import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import {
  SuilendClient,
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
} from '@suilend/sdk';
import { parseReserve, parseObligation } from '@suilend/sdk/parsers';
import { positiveU64, safeSdkAmount, rateFromSupplies, suilendRewardDescriptors } from '../../shared/execution-math.js';
import { SuiDataProvider, GRPC_URL as CONFIG_GRPC_URL, RPC_URL } from './sui-provider.js';
import { normalizeStructTag } from '@mysten/sui/utils';
import {
  getPools as naviSdkPools,
  getPool as naviSdkPool,
  updateOraclePriceBeforeUserOperationPTB as naviSdkOracle,
  getLendingPositions as naviSdkPositions,
  getHealthFactor as naviSdkHealth,
  getUserAvailableLendingRewards as naviSdkRewards,
  depositCoinPTB as naviSdkDeposit,
  withdrawCoinPTB as naviSdkWithdraw,
  borrowCoinPTB as naviSdkBorrow,
  repayCoinPTB as naviSdkRepay,
  claimLendingRewardsPTB as naviSdkClaim,
} from '@naviprotocol/lending';
import { Aftermath } from 'aftermath-ts-sdk';
import { getRawClient, NETWORK } from './sui-provider.js';
import { getPlatformFee, validateFeeRecipient } from './fee-engine.js';

const MAINNET = (NETWORK || 'mainnet') === 'mainnet';
const GRPC_URL = CONFIG_GRPC_URL;
const JSON_URL = RPC_URL;
function requireMainnet() {
  if (!MAINNET) throw err('MARKET_UNAVAILABLE', 'This protocol adapter is mainnet-only; cross-network execution is blocked.');
}

let _grpc = null;
export function grpcClient() {
  if (MAINNET) {
    try {
      const raw = getRawClient();
      if (raw && raw.type === 'grpc' && raw.client) return raw.client;
    } catch { /* fall through to a fresh client */ }
  }
  if (!_grpc) _grpc = new SuiGrpcClient({ network: MAINNET ? 'mainnet' : 'testnet', baseUrl: GRPC_URL });
  return _grpc;
}

let _json = null;
export function jsonClient() {
  // Read-only serialization + devInspect transport. The wallet submits via its own transport.
  if (!_json) _json = new SuiJsonRpcClient({ url: JSON_URL });
  return _json;
}

export function isWalletAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{64}$/.test(a);
}

function err(code, message) {
  return Object.assign(new Error(code + (message ? ': ' + message : '')), { code });
}

/** Map any provider/SDK failure to the shared error vocabulary (§52). */
export function normalizeLendingError(e, fallback = 'BUILD_FAILED') {
  const m = String(e?.message || e || '').toLowerCase();
  if (e?.code && /^(INVALID_AMOUNT|INSUFFICIENT_BALANCE|INSUFFICIENT_COLLATERAL|HEALTH_FACTOR_TOO_LOW|MARKET_UNAVAILABLE|NO_OBLIGATION|NO_POSITION|QUOTE_FAILED|BUILD_FAILED|SIMULATION_FAILED|USER_REJECTED|PROVIDER_UNAVAILABLE|NETWORK_ERROR|INVALID_ACTION|INVALID_WALLET|INVALID_RECIPIENT)$/.test(e.code)) return e;
  if (/invalid.*(wallet|address)|0x[0-9a-f]{1,63}[^0-9a-f]/i.test(m) && /address/.test(m)) return err('INVALID_WALLET', 'Wallet address looks invalid.');
  if (/insufficient.*(balance|fund|coin)|not enough/.test(m)) return err('INSUFFICIENT_BALANCE', 'Balance is insufficient for this amount + gas.');
  if (/health|ltv|collateral/.test(m)) return err('HEALTH_FACTOR_TOO_LOW', 'Operation would breach the health factor.');
  if (/no obligation|obligation.*not found|account cap.*not found/.test(m)) return err('NO_OBLIGATION', 'No lending position found — supply collateral first.');
  if (/deprecated/.test(m)) return err('MARKET_UNAVAILABLE', 'This market was deprecated by the provider.');
  if (/timeout|abort|econn|enotfound|fetch failed|network/.test(m)) return err('NETWORK_ERROR', 'Provider unreachable — retry in a moment.');
  return err(fallback, String(e?.message || e).slice(0, 220));
}

export async function toBytes64(tx, sender, suiSpendMist = 0n) {
  tx.setSenderIfNotSet(sender);
  await boundedGasPayment(tx, sender, jsonClient(), suiSpendMist);
  const bytes = await tx.build({ client: SuiDataProvider.rawClient() });
  return Buffer.from(bytes).toString('base64');
}

/** devInspect dry-run over the exact bytes the wallet would sign. Read-only. */
export async function devInspectB64(txBytesB64, sender) {
  if (!isWalletAddress(sender)) throw err('INVALID_WALLET', 'Sender looks invalid.');
  const tx = Transaction.from(Buffer.from(String(txBytesB64), 'base64'));
  if (tx.getData().sender !== sender.toLowerCase()) throw err('INVALID_WALLET', 'Transaction sender does not match the requested wallet.');
  // Full TransactionData bytes require dry-run/simulate, not raw devInspect
  // (which expects TransactionKind). Provider handles both transports.
  const res = await SuiDataProvider.simulateTransaction(txBytesB64, sender);
  return { ok: res.value?.effects?.status?.status === 'success', simulation: res.value };
}

/* ------------------------------- TRANSFER -------------------------------- */

const SUI_TYPE = '0x2::sui::SUI';

async function pickCoins(owner, coinType, amountMist) {
  const target = positiveU64(amountMist);
  const coins = [];
  let total = 0n, cursor = null;
  do {
    const page = await jsonClient().getCoins({ owner, coinType, cursor, limit: 50 });
    for (const c of page?.data || []) {
      if (BigInt(c.balance || 0) <= 0n) continue;
      coins.push(c); total += BigInt(c.balance);
      if (total >= target) return { coins, total };
    }
    if (!page.hasNextPage) break;
    if (!page.nextCursor || page.nextCursor === cursor) throw err('PROVIDER_UNAVAILABLE', 'Coin pagination cursor is invalid.');
    cursor = page.nextCursor;
  } while (cursor);
  return { coins, total };
}

/**
 * Plain Sui coin transfer PTB (unsigned). Supports only assets Noise knows
 * (coinType allowlist enforced by the caller via coinType()).
 */
export async function transferBuild({ sender, coinType, amountMist, recipient }) {
  if (!isWalletAddress(sender)) throw err('INVALID_WALLET', 'Sender looks invalid.');
  if (!isWalletAddress(recipient)) throw err('INVALID_RECIPIENT', 'Recipient looks invalid.');
  const amount = positiveU64(amountMist);
  if (amount <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const tx = new Transaction();
  if (coinType === SUI_TYPE) {
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    tx.transferObjects([coin], tx.pure.address(recipient));
  } else {
    const { coins, total } = await pickCoins(sender, coinType, amount).catch((e) => { throw normalizeLendingError(e); });
    if (total < amount) throw err('INSUFFICIENT_BALANCE', `Need ${amount} but wallet holds ${total}.`);
    const ids = coins.map((c) => tx.object(c.coinObjectId));
    if (ids.length > 1) tx.mergeCoins(ids[0], ids.slice(1));
    const [coin] = tx.splitCoins(ids[0], [tx.pure.u64(amount)]);
    tx.transferObjects([coin], tx.pure.address(recipient));
  }
  const txBytes = await toBytes64(tx, sender, coinType === SUI_TYPE ? amount : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amount), recipient } };
}

/* ------------------------------- SUILEND --------------------------------- */

let _suilend = null, _suilendAt = 0, _suilendLoading = null;
export async function suilendClient() {
  requireMainnet();
  if (_suilend && Date.now() - _suilendAt < 30_000) return _suilend;
  if (!_suilendLoading) {
    _suilendLoading = SuilendClient.initialize(LENDING_MARKET_ID, LENDING_MARKET_TYPE, grpcClient())
      .then(c => { _suilend = c; _suilendAt = Date.now(); return c; })
      .finally(() => { _suilendLoading = null; });
  }
  return _suilendLoading;
}

/* Suilend gRPC returns RAW on-chain reserve structs: the enriched fields the
 * SDK's own types advertise (depositAprPercent, utilizationPercent, token…) do
 * not exist on them, which is why every market used to report null APR. The
 * SDK ships `parseReserve(reserve, coinMetadataMap)` to do that enrichment —
 * use it, and synthesise the coin metadata it needs (reserve + reward coins)
 * instead of inventing numbers. A Proxy default keeps a malformed entry from
 * killing the whole list; such a row reports aprSource: unavailable. */
function rawReserveCoinType(r) {
  const n = r?.coinType?.name ?? r?.coinType?.typeName ?? r?.coinType;
  return n == null ? null : String(n);
}

async function suilendMetadataMap(reserves) {
  const meta = {}, types = new Set();
  for (const r of reserves || []) {
    const ct = normalizeStructTag(rawReserveCoinType(r));
    const label = ct.split('::').pop();
    meta[ct] = { coinType: ct, decimals: Number(r.mintDecimals), symbol: label, name: label, iconUrl: null, description: '' };
    for (const manager of [r.depositsPoolRewardManager, r.borrowsPoolRewardManager]) {
      for (const reward of manager?.poolRewards || []) if (reward) types.add(normalizeStructTag(reward.coinType.name));
    }
  }
  await Promise.all([...types].filter(ct => !meta[ct]).map(async ct => {
    const result = await grpcClient().getCoinMetadata({ coinType: ct });
    const m = result.coinMetadata;
    if (!m || !Number.isInteger(m.decimals)) throw err('PROVIDER_UNAVAILABLE', 'Reward coin metadata unavailable; refusing to guess decimals.');
    meta[ct] = { ...m, coinType: ct };
  }));
  return meta;
}
async function suilendParsedReserves(c) {
  const reserves = c.lendingMarket.reserves || [];
  const meta = await suilendMetadataMap(reserves);
  return Object.fromEntries(reserves.map(raw => { const p = parseReserve(raw, meta); return [p.coinType, p]; }));
}

export async function suilendMarkets() {
  const c = await suilendClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const reserves = c.lendingMarket.reserves || [];
  const meta = await suilendMetadataMap(reserves);
  const updatedAt = new Date(_suilendAt).toISOString();
  const pct = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null; };
  return reserves.map((raw) => {
    let r = null;
    try { r = parseReserve(raw, meta); } catch { r = null; }
    const coinType = (r && typeof r.coinType === 'string' ? r.coinType : rawReserveCoinType(raw)) || '';
    return {
      coinType,
      symbol: r?.token?.symbol ?? (coinType ? coinType.split('::').filter(Boolean).pop() : null),
      decimals: r?.mintDecimals ?? raw?.mintDecimals ?? null,
      // Percent units (e.g. 0.97 = 0.97% APR), straight from the on-chain curve.
      depositApr: pct(r?.depositAprPercent),
      borrowApr: pct(r?.borrowAprPercent),
      utilization: pct(r?.utilizationPercent),
      available: r ? String(r.availableAmount) : (raw?.availableAmount != null ? String(raw.availableAmount) : null),
      aprSource: r ? 'Suilend SDK parseReserve (on-chain interest-rate curve)' : 'unavailable — SDK could not parse this reserve',
      source: 'Suilend SDK (gRPC)',
      rateKind: 'apr', rateUnit: 'percent', rateBasis: 'base-interest-only', updatedAt,
    };
  });
}

export async function suilendPosition(wallet) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const c = await suilendClient();
  const reserves = await suilendParsedReserves(c);
  const caps = await SuilendClient.getObligationOwnerCaps(wallet, [LENDING_MARKET_TYPE], grpcClient());
  const obligations = [], errors = [];
  for (const cap of caps || []) {
    try {
      const raw = await SuilendClient.getObligation(cap.obligationId, [LENDING_MARKET_TYPE], grpcClient());
      const ob = parseObligation(raw, reserves);
      const health = ob.weightedBorrowsUsd.gt(0) ? Number(ob.unhealthyBorrowValueUsd.div(ob.weightedBorrowsUsd)) : null;
      obligations.push({ obligationId: cap.obligationId, capId: cap.id,
        deposits: ob.deposits.map(d => ({ coinType: d.coinType, amount: d.depositedAmount.toFixed(), amountUnit: 'token', amountUsd: d.depositedAmountUsd.toFixed() })),
        borrows: ob.borrows.map(b => ({ coinType: b.coinType, amount: b.borrowedAmount.toFixed(), amountUnit: 'token', amountUsd: b.borrowedAmountUsd.toFixed() })),
        health, healthBasis: 'liquidation-threshold / weighted-debt',
        depositedUsd: ob.depositedAmountUsd.toFixed(), borrowedUsd: ob.borrowedAmountUsd.toFixed(),
        netValueUsd: ob.netValueUsd.toFixed() });
    } catch (e) { errors.push({ obligationId: cap.obligationId, error: normalizeLendingError(e, 'PROVIDER_UNAVAILABLE').code }); }
  }
  return { obligations, errors, complete: errors.length === 0, source: 'Suilend SDK parseObligation (gRPC)', updatedAt: new Date().toISOString() };
}

async function suilendCapOrThrow(wallet) {
  const caps = await SuilendClient.getObligationOwnerCaps(wallet, [LENDING_MARKET_TYPE], grpcClient())
    .catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  if (!caps || !caps.length) throw err('NO_OBLIGATION', 'No Suilend obligation — supply collateral first.');
  return caps[0];
}

export async function suilendSupply({ wallet, coinType, amountMist }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await suilendClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const tx = new Transaction();
  let caps = [];
  try { caps = await SuilendClient.getObligationOwnerCaps(wallet, [LENDING_MARKET_TYPE], grpcClient()); }
  catch (e) { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); }
  try {
    if (caps.length) {
      await c.depositIntoObligation(wallet, coinType, String(amountMist), tx, tx.object(caps[0].id));
    } else {
      // First supply: create the obligation, deposit through it, then keep the OwnerCap.
      const cap = c.createObligation(tx);
      await c.depositIntoObligation(wallet, coinType, String(amountMist), tx, cap);
      tx.transferObjects([cap], tx.pure.address(wallet));
    }
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist), firstSupply: !caps.length } };
}

export async function suilendWithdraw({ wallet, coinType, amountMist }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await suilendClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const cap = await suilendCapOrThrow(wallet);
  const tx = new Transaction();
  try {
    await c.withdrawAndSendToUser(wallet, tx.object(cap.id), cap.obligationId, coinType, String(amountMist), tx);
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist), obligationId: cap.obligationId } };
}

export async function suilendBorrow({ wallet, coinType, amountMist }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await suilendClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const cap = await suilendCapOrThrow(wallet);
  const tx = new Transaction();
  try {
    const ob = await SuilendClient.getObligation(cap.obligationId, [LENDING_MARKET_TYPE], grpcClient());
    await c.refreshAll(tx, ob);
    await c.borrowAndSendToUser(wallet, tx.object(cap.id), cap.obligationId, coinType, String(amountMist), tx);
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist), obligationId: cap.obligationId } };
}

export async function suilendRepay({ wallet, coinType, amountMist, obligationId }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await suilendClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const cap = await suilendCapOrThrow(wallet);
  const tx = new Transaction();
  try {
    await c.repayIntoObligation(wallet, obligationId || cap.obligationId, coinType, String(amountMist), tx);
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist), obligationId: obligationId || cap.obligationId } };
}

export async function suilendClaim({ wallet }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const c = await suilendClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const cap = await suilendCapOrThrow(wallet);
  const tx = new Transaction();
  try {
    // Claim-all shape follows the SDK tutorial (rewards list resolved per obligation at build time).
    const obligation = await SuilendClient.getObligation(cap.obligationId, [LENDING_MARKET_TYPE], grpcClient());
    const rewards = suilendRewardDescriptors(c.lendingMarket.reserves, obligation);
    if (!rewards.length) throw err('NO_POSITION', 'No eligible Suilend rewards for this obligation.');
    c.claimRewardsAndSendToUser(wallet, tx.object(cap.id), rewards, tx);
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { obligationId: cap.obligationId } };
}

/* -------------------------------- NAVI ----------------------------------- */

function numericMetric(v) { return v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); }

function naviPoolId(pool) {
  return pool?.id ?? pool?.poolId ?? pool;
}

export async function naviMarkets() {
  requireMainnet();
  const updatedAt = new Date().toISOString();
  const pools = await naviSdkPools({}).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  // Raw on-chain rates are ray-scaled internals — no APY is derived without a
  // verified scale. Liquidity/minimum/LTV are plain values and safe to show.
  return (pools || []).map((p) => ({
    id: p.id,
    coinType: p.suiCoinType || p.coinType || null,
    symbol: p.token?.symbol || p.symbol || null,
    decimals: p.token?.decimals ?? null,
    price: p.token?.price ?? p.oracle?.price ?? null,
    leftSupply: p.leftSupply ?? null,
    availableBorrow: p.availableBorrow ?? null,
    minimumAmount: p.minimumAmount ?? null,
    ltv: p.ltvValue ?? p.ltv ?? null,
    supplyApr: numericMetric(p.supplyIncentiveApyInfo?.vaultApr),
    borrowApr: numericMetric(p.borrowIncentiveApyInfo?.vaultApr),
    supplyApy: numericMetric(p.supplyIncentiveApyInfo?.apy),
    borrowApy: numericMetric(p.borrowIncentiveApyInfo?.apy),
    rateUnit: 'percent', rateBasis: 'NAVI provider fields; APR and APY are separate',
    supplyIncentives: p.supplyIncentiveApyInfo ?? null,
    borrowIncentives: p.borrowIncentiveApyInfo ?? null,
    incentives: p.supplyIncentiveApyInfo ?? null,
    updatedAt,
    deprecated: Boolean(p.isDeprecated || (p.deprecatedAt && Date.now() > p.deprecatedAt)),
    source: 'NAVI Lending SDK (gRPC)',
  }));
}

export async function naviPosition(wallet) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const [positions, hf] = await Promise.all([
    naviSdkPositions(wallet, {}).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); }),
    naviSdkHealth(wallet, {}).catch(() => null),
  ]);
  return {
    positions: positions || [],
    healthFactor: hf != null ? Number(hf) : null,
    source: 'NAVI Lending SDK (gRPC)',
    updatedAt: new Date().toISOString(),
  };
}

export async function naviRewards(wallet) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const rewards = await naviSdkRewards(wallet, {}).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  return { rewards: rewards || [], source: 'NAVI Lending SDK', updatedAt: new Date().toISOString() };
}

export async function naviCoinInput(tx, sender, coinType, amountMist) {
  if (normalizeStructTag(coinType) === normalizeStructTag(SUI_TYPE)) {
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(amountMist))]);
    return coin;
  }
  const { coins, total } = await pickCoins(sender, coinType, amountMist).catch((e) => { throw normalizeLendingError(e); });
  if (total < BigInt(amountMist)) throw err('INSUFFICIENT_BALANCE', `Need ${amountMist} but wallet holds ${total}.`);
  const ids = coins.map((c) => tx.object(c.coinObjectId));
  if (ids.length > 1) tx.mergeCoins(ids[0], ids.slice(1));
  const [coin] = tx.splitCoins(ids[0], [tx.pure.u64(BigInt(amountMist))]);
  return coin;
}

export async function naviSupply({ wallet, coinType, amountMist, pool }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const tx = new Transaction();
  try {
    const coin = await naviCoinInput(tx, wallet, coinType, amountMist);
    await naviSdkDeposit(tx, pool ?? coinType, coin, { amount: tx.pure.u64(positiveU64(amountMist)) });
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist) } };
}

export async function naviWithdraw({ wallet, coinType, amountMist, pool }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const tx = new Transaction();
  try {
    await refreshNaviOracle(tx,wallet,pool??coinType);
    const out = await naviSdkWithdraw(tx, pool ?? coinType, tx.pure.u64(positiveU64(amountMist)), {});
    if (out) tx.transferObjects([out], tx.pure.address(wallet));
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist) } };
}

export async function naviBorrow({ wallet, coinType, amountMist, pool }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const tx = new Transaction();
  try {
    await refreshNaviOracle(tx,wallet,pool??coinType);
    const out = await naviSdkBorrow(tx, pool ?? coinType, tx.pure.u64(positiveU64(amountMist)), {});
    if (out) tx.transferObjects([out], tx.pure.address(wallet));
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist) } };
}

export async function naviRepay({ wallet, coinType, amountMist, pool }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const tx = new Transaction();
  try {
    const coin = await naviCoinInput(tx, wallet, coinType, amountMist);
    await naviSdkRepay(tx, pool ?? coinType, coin, { amount: tx.pure.u64(positiveU64(amountMist)) });
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist) } };
}

export async function naviClaim({ wallet }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const rewards = await naviSdkRewards(wallet, {}).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  if (!rewards || !rewards.length) throw err('NO_POSITION', 'No claimable NAVI rewards for this wallet.');
  const tx = new Transaction();
  try {
    await naviSdkClaim(tx, rewards, { customCoinReceive: { type: 'transfer', transfer: wallet } });
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { rewards: rewards.length } };
}

/* -------------------------------- HAEDAL ---------------------------------- */

export const HAEDAL = {
  // Official haedal-protocol-interface repo (mainnet). The documented
  // 0x1d56::interface package aborts in staking::assert_version against the
  // current Staking object (verified on-chain 2026-10-06) — stake goes through
  // the latest upgraded staking package instead, returning Coin<HASUI>.
  interfacePkg: '0x1d56b8ec33c3fae897eb7bb1acb79914e8152faed614868928e684c25c8b198d',
  stakingPkg: '0x126e4cfb051cad744706df590ec399e8c02b6feae195c35b8b496280d5442a62',
  stakingObj: '0x47b224762220393057ebf4f70501b6e657c3e56684737568439a04f80849b2ca',
  clockObj: '0x6',
  sysStateObj: '0x5',
  autoValidator: '0x0000000000000000000000000000000000000000000000000000000000000000',
};

export async function haedalRate() {
  requireMainnet();
  const tx = new Transaction();
  tx.moveCall({
    target: `${HAEDAL.stakingPkg}::staking::get_exchange_rate`,
    arguments: [tx.object(HAEDAL.stakingObj)],
  });
  const res = await jsonClient().devInspectTransactionBlock({
    transactionBlock: Buffer.from(await tx.build({ client: jsonClient(), onlyTransactionKind: true })),
    sender: '0x0000000000000000000000000000000000000000000000000000000000000001',
  }).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const ret = res?.results?.[0]?.returnValues?.[0]?.[0];
  // Sui BCS u64 is little-endian.
  const rawRate = ret ? Buffer.from(ret).readBigUInt64LE(0) : null;
  if (rawRate == null) throw err('PROVIDER_UNAVAILABLE', 'Haedal exchange rate unreadable.');
  return { rateRaw: String(rawRate), rate: Number(rawRate) / 1e6, source: 'Haedal staking::get_exchange_rate (devInspect)' };
}

export async function haedalPosition(wallet) {
  requireMainnet(); if (!isWalletAddress(wallet)) throw err('INVALID_WALLET','Wallet looks invalid.');
  const type='0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI',c=jsonClient();
  const [rate,balances]=await Promise.all([haedalRate(),c.getAllBalances({owner:wallet})]);
  const hasui=balances.filter(b=>normalizeStructTag(b.coinType)===type),tickets=[];let cursor=null;
  for(let n=0;n<20;n++){const page=await c.getOwnedObjects({owner:wallet,cursor,filter:{StructType:type.split('::')[0]+'::staking::UnstakeTicket'},options:{showType:true},limit:50});for(const o of page.data||[]){if(o.error)throw err('PROVIDER_UNAVAILABLE','Incomplete owned objects read');if(o.data?.type===type.split('::')[0]+'::staking::UnstakeTicket')tickets.push({id:o.data.objectId,type:o.data.type});}if(!page.hasNextPage)break;if(!page.nextCursor||n===19)throw err('PROVIDER_UNAVAILABLE','Incomplete ticket pagination');cursor=page.nextCursor;}
  return{rate:rate.rate,hasui:hasui.map(b=>({coinType:b.coinType,balance:String(b.totalBalance)})),pendingTickets:tickets,source:'Sui RPC + Haedal rate; paginated owned tickets',updatedAt:new Date().toISOString()};
}

export async function haedalStakeBuild({ wallet, amountMist, validator }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  // Official interface: validator 0x0 = Haedal auto-distribution. An explicit
  // active validator may be passed instead; Noise never invents one.
  const val = validator && validator !== HAEDAL.autoValidator ? validator : HAEDAL.autoValidator;
  if (val !== HAEDAL.autoValidator && !isWalletAddress(val)) throw err('INVALID_ACTION', 'Validator address malformed.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  // Verified on-chain: below 1 SUI the package aborts (code 4) — reject early, not generic.
  if (BigInt(amountMist) < 1_000_000_000n) throw err('INVALID_AMOUNT', 'Haedal minimum stake is 1 SUI.');
  const rate = await haedalRate().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(amountMist))]);
  // request_stake_coin returns Coin<HASUI> — transfer it to the sender.
  const [hasui] = tx.moveCall({
    target: `${HAEDAL.stakingPkg}::staking::request_stake_coin`,
    arguments: [tx.object(HAEDAL.sysStateObj), tx.object(HAEDAL.stakingObj), coin, tx.pure.address(val)],
  });
  tx.transferObjects([hasui], tx.pure.address(wallet));
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  const minOut = Math.floor(safeSdkAmount(amountMist) / (rate.rate || 1));
  return { txBytes, meta: { amountMist: String(amountMist), minReceivedHasui: String(minOut), rate: rate.rate, validator } };
}

export async function haedalUnstakeInstantBuild({ wallet, hasuiMist, hasuiType }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(hasuiMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const type = hasuiType || (await haedalPosition(wallet))?.hasui?.[0]?.coinType;
  if(type && normalizeStructTag(type)!=='0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI')throw err('INVALID_ACTION','Expected the official Haedal receipt coin type.');
  if (!type) throw err('NO_POSITION', 'No haSUI balance found for this wallet.');
  const { coins, total } = await pickCoins(wallet, type, hasuiMist).catch((e) => { throw normalizeLendingError(e); });
  if (total < BigInt(hasuiMist)) throw err('INSUFFICIENT_BALANCE', 'haSUI balance insufficient.');
  const tx = new Transaction();
  const ids = coins.map((c) => tx.object(c.coinObjectId));
  if (ids.length > 1) tx.mergeCoins(ids[0], ids.slice(1));
  const [coin] = tx.splitCoins(ids[0], [tx.pure.u64(BigInt(hasuiMist))]);
  // Current ABI returns nothing; the protocol transfers SUI to the sender. Protocol fee/liquidity apply.
  tx.moveCall({
    target: `${HAEDAL.stakingPkg}::staking::request_unstake_instant_v2`,
    arguments: [tx.object(HAEDAL.sysStateObj), tx.object(HAEDAL.stakingObj), coin],
  });
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { hasuiMist: String(hasuiMist), mode: 'instant (protocol fee applies; may fail on low liquidity)' } };
}

export async function haedalUnstakeRequestBuild({ wallet, hasuiMist, hasuiType }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(hasuiMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const type = hasuiType || (await haedalPosition(wallet))?.hasui?.[0]?.coinType;
  if(type && normalizeStructTag(type)!=='0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI')throw err('INVALID_ACTION','Expected the official Haedal receipt coin type.');
  if (!type) throw err('NO_POSITION', 'No haSUI balance found for this wallet.');
  const { coins, total } = await pickCoins(wallet, type, hasuiMist).catch((e) => { throw normalizeLendingError(e); });
  if (total < BigInt(hasuiMist)) throw err('INSUFFICIENT_BALANCE', 'haSUI balance insufficient.');
  const tx = new Transaction();
  const ids = coins.map((c) => tx.object(c.coinObjectId));
  if (ids.length > 1) tx.mergeCoins(ids[0], ids.slice(1));
  const [coin] = tx.splitCoins(ids[0], [tx.pure.u64(BigInt(hasuiMist))]);
  // Current ABI transfers UnstakeTicket to sender internally; claim after protocol unlock.
  tx.moveCall({
    target: `${HAEDAL.stakingPkg}::staking::request_unstake_delay`,
    arguments: [tx.object(HAEDAL.stakingObj), tx.object(HAEDAL.clockObj), coin],
  });
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { hasuiMist: String(hasuiMist), mode: 'delayed (protocol unlock, then separate claim)' } };
}

export async function haedalClaimBuild({ wallet, ticketId }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (!/^0x[0-9a-fA-F]{64}$/.test(ticketId || '')) throw err('INVALID_ACTION', 'Unstake ticket object id required.');
  const owned=await jsonClient().getObject({id:ticketId,options:{showOwner:true,showType:true}});
  if(owned.data?.owner?.AddressOwner?.toLowerCase()!==wallet.toLowerCase()||owned.data?.type!=='0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::staking::UnstakeTicket')throw err('NO_POSITION','Expected an owned Haedal unstake ticket.');
  const tx = new Transaction();
  tx.moveCall({
    target: `${HAEDAL.stakingPkg}::staking::claim_v2`,
    arguments: [tx.object(HAEDAL.sysStateObj), tx.object(HAEDAL.stakingObj), tx.object(ticketId)],
  });
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { ticketId } };
}

/* --------------------------- DEEPBOOK MARGIN (P1) ------------------------- */
// Margin is a separate adapter from spot: MarginManager wraps a BalanceManager,
// isolated per pool, Pyth-priced. Wired here: on-chain preflight (enabled +
// margin pool ids) and margin-account creation. Leveraged borrow/trade needs a
// user MarginManager + fresh Pyth feeds — built per-manager after setup E2E.
import { deepbook as deepbookExt, mainnetMarginPools } from '@mysten/deepbook-v3';

function marginClient(address) {
  return grpcClient().$extend(deepbookExt({ address }));
}

const cleanId = (id) => String(id || '').replace(/^0x0x/, '0x');

export async function marginPreflight(poolKey) {
  requireMainnet();
  const key = String(poolKey || 'SUI_USDC').toUpperCase();
  const db = marginClient('0x0000000000000000000000000000000000000000000000000000000000000001').deepbook;
  const enabled = await db.isPoolEnabledForMargin(key).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  if (!enabled) return { poolKey: key, marginEnabled: false, source: 'DeepBook Margin SDK (gRPC)' };
  const [base, quote] = await Promise.all([
    db.getBaseMarginPoolId(key).catch(() => null),
    db.getQuoteMarginPoolId(key).catch(() => null),
  ]);
  return {
    poolKey: key,
    marginEnabled: true,
    baseMarginPoolId: cleanId(base),
    quoteMarginPoolId: cleanId(quote),
    lendingPools: Object.keys(mainnetMarginPools || {}),
    source: 'DeepBook Margin SDK (gRPC)',
    updatedAt: new Date().toISOString(),
  };
}

export async function marginSetupBuild({ wallet, poolKey }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const key = String(poolKey || 'SUI_USDC').toUpperCase();
  const pre = await marginPreflight(key).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  if (!pre.marginEnabled) throw err('MARKET_UNAVAILABLE', key + ' is not margin-enabled on-chain.');
  const tx = new Transaction();
  try {
    tx.add(marginClient(wallet).deepbook.marginManager.newMarginManager(key));
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { poolKey: key, baseMarginPoolId: pre.baseMarginPoolId, quoteMarginPoolId: pre.quoteMarginPoolId } };
}

/* ----------------- ECOSYSTEM LAYER 2: yields, dexes, perps -----------------
   Metastable (mUSD/mSUI vaults) · Turbos (CLMM pools + quotes) · Bluefin perps
   (public market data) · Scallop (lending markets + positions) · Bucket (CDP /
   savings / PSM) · SpringSui (sSUI stake) · Volo (stats via NAVI open API).
   Same rules: validate -> preflight -> unsigned PTB -> simulate -> wallet. */

/* ------------------------------- METASTABLE ------------------------------- */

import { MetastableSDK, M_USD, M_SUI, M_BTC, M_ETH } from 'metastable-ts-sdk';

const MSTABLE_VAULTS = [M_USD, M_SUI, M_BTC, M_ETH].filter(Boolean);

let _mstable = null;
function mstableSdk() {
  if (!_mstable) _mstable = new MetastableSDK({ suiClient: jsonClient() });
  return _mstable;
}

export async function mstableVaults() {
  requireMainnet();
  const sdk = mstableSdk();
  const out = [];
  for (const m of MSTABLE_VAULTS) {
    try {
      const v = await sdk.fetchVault({ mCoin: m.coin });
      out.push({
        mCoin: m.coin,
        supply: String(v.supply ?? 0),
        decimals: v.metaCoinDecimals ?? 9,
        assets: Object.entries(v.coins || {}).map(([coinType, c]) => ({
          coinType,
          decimals: c.decimals ?? null,
          depositCap: c.depositCap != null ? String(c.depositCap) : null,
          totalDeposits: c.totalDeposits != null ? String(c.totalDeposits) : null,
        })),
        source: 'Metastable SDK (vault read)',
      });
    } catch (e) { out.push({ mCoin: m.coin, error: 'PROVIDER_UNAVAILABLE' }); }
  }
  return { vaults: out, updatedAt: new Date().toISOString() };
}

function mstableCoinId(input) {
  const s = String(input || '').toUpperCase();
  const bySym = { MUSD: M_USD, MSUI: M_SUI, MBTC: M_BTC, METH: M_ETH };
  if (bySym[s]) return bySym[s].coin;
  for (const m of [M_USD, M_SUI, M_BTC, M_ETH]) {
    if (m && (m.coin === input || String(m.coin).toLowerCase() === String(input).toLowerCase())) return m.coin;
  }
  throw err('INVALID_ACTION', 'Unknown meta coin. Supported: mUSD, mSUI, mBTC, mETH.');
}

export async function mstableMint({ wallet, mCoin, coinType, amountHuman, minOut }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (!Number.isFinite(Number(amountHuman)) || !(Number(amountHuman) > 0)) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const sdk = mstableSdk();
  const mId = mstableCoinId(mCoin);
  // mSUI uses the registry path (no oracle key needed). mUSD/mBTC/mETH need a
  // Pyth Hermes feed, and the bundled SDK has no API-key support (Hermes 401s).
  let tx;
  try {
    tx = await sdk.buildMintTx({
      mCoin: mId, coin: coinType, amountIn: Number(amountHuman), walletAddress: wallet,
      ...(minOut != null ? { minAmountOut: Number(minOut) } : {}),
    });
  } catch (e) {
    if (/401|unauthorized/i.test(String(e?.message || e))) {
      throw err('PROVIDER_UNAVAILABLE', 'This vault needs a Pyth price feed and the price endpoint requires access unavailable to the hub — mint mSUI (registry path) or use the venue.');
    }
    throw normalizeLendingError(e);
  }
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { mCoin, coinType, amountHuman: String(amountHuman) } };
}

export async function mstableBurn({ wallet, mCoin, coinType, amountHuman, minOut }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (!Number.isFinite(Number(amountHuman)) || !(Number(amountHuman) > 0)) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const sdk = mstableSdk();
  const mId = mstableCoinId(mCoin);
  let tx;
  try {
    tx = await sdk.buildBurnTx({
      mCoin: mId, coin: coinType, amountIn: Number(amountHuman), walletAddress: wallet,
      ...(minOut != null ? { minAmountOut: Number(minOut) } : {}),
    });
  } catch (e) {
    if (/401|unauthorized/i.test(String(e?.message || e))) {
      throw err('PROVIDER_UNAVAILABLE', 'This vault needs a Pyth price feed unavailable to the hub — burn mSUI (registry path) or use the venue.');
    }
    throw normalizeLendingError(e);
  }
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { mCoin, coinType, amountHuman: String(amountHuman), feeNote: 'dynamic 0.01–1%' } };
}

/* -------------------------------- TURBOS ---------------------------------- */

import { TurbosSdk, Network as TurbosNetwork } from 'turbos-clmm-sdk';

let _turbos = null;
export function turbosSdk() {
  if (!_turbos) _turbos = new TurbosSdk(TurbosNetwork.mainnet, grpcClient());
  return _turbos;
}

function turbosAddr(t) {
  // 0x2 == 0x000...002 — compare normalized, never raw.
  return String(t || '').toLowerCase().split('::').map((seg, i) => (i === 0 ? '0x' + seg.slice(2).replace(/^0+(?=[0-9a-f])/i, '') : seg)).join('::');
}

function turbosTypes(p) {
  // Prefer the parsed types array; fall back to the Pool<A,B,Fee> struct tag.
  if (Array.isArray(p.types) && p.types.length >= 2) return [p.types[0], p.types[1]];
  const m = String(p.type || '').match(/Pool<\s*(.*?)\s*,\s*(.*?)\s*,/);
  if (m) return [m[1].trim(), m[2].trim()];
  return [null, null];
}

const TURBOS_API = 'https://api.turbos.finance';

async function turbosRest(path, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(TURBOS_API + path, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw Object.assign(new Error('HTTP_' + r.status), { code: 'PROVIDER_UNAVAILABLE' });
    return r.json();
  } catch (e) {
    throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE');
  } finally { clearTimeout(t); }
}

export async function turbosPools(limit = 50) {
  requireMainnet();
  // Fast curated REST (TVL/volume/APR included) — the full SDK scan is ~2 min.
  const n = Math.min(Math.max(Number(limit) || 50, 10), 100);
  const j = await turbosRest('/pools?page=1&pageSize=' + n);
  const rows = Array.isArray(j?.result) ? j.result : [];
  return rows
    .filter((p) => p.unlocked !== false)
    .map((p) => ({
      id: p.pool_id || p.id,
      coinA: p.coin_type_a || null,
      coinB: p.coin_type_b || null,
      symbolA: p.coin_symbol_a || null,
      symbolB: p.coin_symbol_b || null,
      fee: p.fee ?? null,
      liquidity: p.liquidity != null ? String(p.liquidity) : null,
      tvlUsd: p.liquidity_usd ?? null,
      volume24hUsd: p.volume_24h_usd ?? null,
      apr: p.apr ?? p.fee_apr ?? null,
      source: 'Turbos REST (curated pools)',
    }))
    .filter((p) => p.coinA && p.coinB);
}

export async function turbosQuote({ fromType, toType, amountMist }) {
  requireMainnet();
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const norm = turbosAddr;
  // Candidate pools from fast REST, priced on-chain via the SDK.
  const j = await turbosRest('/pools?page=1&pageSize=100').catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const match = (Array.isArray(j?.result) ? j.result : [])
    .map((p) => ({ id: p.pool_id, coinA: p.coin_type_a, coinB: p.coin_type_b, liquidity: p.liquidity != null ? String(p.liquidity) : '0' }))
    .filter((p) => p.id && p.coinA && p.coinB && p.liquidity !== '0' && (
      (norm(p.coinA) === norm(fromType) && norm(p.coinB) === norm(toType)) ||
      (norm(p.coinA) === norm(toType) && norm(p.coinB) === norm(fromType))));
  if (!match.length) throw err('QUOTE_FAILED', 'No liquid Turbos pool for this pair.');
  const sdk = turbosSdk();
  let best = null;
  for (const p of match.slice(0, 8)) {
    try {
      const a2b = norm(p.coinA) === norm(fromType);
      const r = await sdk.trade.computeSwapResult({
        pools: [{ pool: p.id, a2b }],
        address: '0x0000000000000000000000000000000000000000000000000000000000000001',
        amountSpecified: String(amountMist),
        amountSpecifiedIsInput: true,
      });
      // Exact-in: output is amount_b when a→b, amount_a otherwise.
      const row = r && r[0];
      const out = row ? BigInt(a2b ? (row.amount_b ?? 0) : (row.amount_a ?? 0)) : 0n;
      if (out > 0 && (!best || out > best.out)) best = { out, pool: p.id, a2b, nextTickIndex: sdk.math.bitsToNumber(row.tick_current_index.bits), amountA: row.amount_a, amountB: row.amount_b };
    } catch { /* one bad pool must not kill the quote */ }
  }
  if (!best) throw err('QUOTE_FAILED', 'Turbos could not price this amount.');
  return { provider: 'Turbos', amountOut: String(best.out), pool: best.pool, a2b: best.a2b, nextTickIndex: best.nextTickIndex, amountA: best.amountA, amountB: best.amountB, source: 'Turbos SDK (computeSwapResult)' };
}

/* -------------------------------- BLUEFIN --------------------------------- */

const BLUEFIN_BASE = 'https://api.sui-prod.bluefin.io/v1';

async function bluefinGet(path, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(BLUEFIN_BASE + path, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw Object.assign(new Error('HTTP_' + r.status), { code: 'PROVIDER_UNAVAILABLE' });
    return r.json();
  } catch (e) {
    throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE');
  } finally { clearTimeout(t); }
}

export async function bluefinMarkets() {
  requireMainnet();
  const info = await bluefinGet('/exchange/info');
  const markets = info?.markets || info?.data?.markets || [];
  return {
    markets: markets.map((m) => ({
      symbol: m.symbol, status: m.status,
      base: m.baseAssetSymbol || m.baseAssetName || null,
      tickSize: m.tickSizeE9 != null ? String(m.tickSizeE9) : null,
      minQty: m.minOrderQuantityE9 != null ? String(m.minOrderQuantityE9) : null,
    })),
    assets: (info?.assets || info?.data?.assets || []).map((a) => ({ symbol: a.symbol, decimals: a.decimals ?? null })),
    source: 'Bluefin Pro API (public market data)',
    updatedAt: new Date().toISOString(),
  };
}

export async function bluefinDepth(symbol, limit = 20) {
  requireMainnet();
  const d = await bluefinGet('/exchange/depth?symbol=' + encodeURIComponent(symbol) + '&limit=' + Math.min(Number(limit) || 20, 100));
  const px = (e9) => (Number(e9) / 1e9).toString();
  return {
    symbol,
    bid: d.bestBidPriceE9 != null ? px(d.bestBidPriceE9) : null,
    ask: d.bestAskPriceE9 != null ? px(d.bestAskPriceE9) : null,
    bids: (d.bidsE9 || []).slice(0, 20).map(([p, q]) => [px(p), px(q)]),
    asks: (d.asksE9 || []).slice(0, 20).map(([p, q]) => [px(p), px(q)]),
    updatedAt: d.updatedAtMillis ? new Date(Number(d.updatedAtMillis)).toISOString() : new Date().toISOString(),
    source: 'Bluefin Pro API (public orderbook)',
  };
}

export async function bluefinTickers() {
  requireMainnet();
  const t = await bluefinGet('/exchange/tickers');
  const rows = Array.isArray(t) ? t : (t.tickers || t.data || []);
  return {
    tickers: rows.map((x) => ({
      symbol: x.symbol,
      last: x.closePrice24hrE9 != null ? String(Number(x.closePrice24hrE9) / 1e9) : null,
      bid: x.bestBidPriceE9 != null ? String(Number(x.bestBidPriceE9) / 1e9) : null,
      ask: x.bestAskPriceE9 != null ? String(Number(x.bestAskPriceE9) / 1e9) : null,
    })),
    source: 'Bluefin Pro API (public tickers)',
    updatedAt: new Date().toISOString(),
  };
}

/* -------------------------------- SCALLOP --------------------------------- */

import { Scallop } from '@scallop-io/sui-scallop-sdk';

const SCALLOP_ADDRESS_ID = '695fcdc084f790c04eb068dc';

async function scallopQuery(wallet) {
  const sdk = new Scallop({
    addressId: SCALLOP_ADDRESS_ID, network: 'mainnet',
    fullnodeUrl: 'https://fullnode.mainnet.sui.io:443',
    walletAddress: wallet || '0x0000000000000000000000000000000000000000000000000000000000000001',
  });
  return sdk.createScallopQuery();
}

export async function scallopMarkets() {
  requireMainnet();
  const q = await scallopQuery().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  let m;
  try { m = await q.getMarketPools(); }
  catch (e) { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); }
  const pct = v => { const n = numericMetric(v); return n === null ? null : n * 100; };
  const rows = Object.entries(m?.pools || {}).map(([name, p]) => ({
    name, side: 'pools', coinType: p.coinType || null, symbol: p.symbol || name,
    decimals: p.coinDecimal, price: numericMetric(p.coinPrice),
    supplyApr: pct(p.supplyApr), borrowApr: pct(p.borrowApr),
    supplyApy: pct(p.supplyApy), borrowApy: pct(p.borrowApy),
    rateUnit: 'percent', available: numericMetric(p.supplyCoin) === null || numericMetric(p.borrowCoin) === null ? null : p.supplyCoin - p.borrowCoin,
  }));
  return { markets: rows, collaterals: m?.collaterals || {}, source: 'Scallop SDK (query)', updatedAt: new Date().toISOString() };
}

export async function scallopPositions(wallet) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const q = await scallopQuery(wallet).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  try {
    const [obligations, portfolio] = await Promise.all([
      q.getObligations(wallet),
      q.getUserPortfolio({ walletAddress: wallet }),
    ]);
    return { obligations: obligations || [], portfolio, source: 'Scallop SDK (query)', updatedAt: new Date().toISOString() };
  } catch (e) { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); }
}

/* -------------------------------- BUCKET ---------------------------------- */

import { BucketClient } from '@bucket-protocol/sdk';

let _bucket = null;
export async function bucketClient() {
  requireMainnet();
  if (!_bucket) {
    const grpc = new SuiGrpcClient({ network: 'mainnet', baseUrl: GRPC_URL });
    _bucket = await BucketClient.initialize({ suiClient: grpc, network: 'mainnet' });
  }
  return _bucket;
}

export async function bucketMarkets() {
  const c = await bucketClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const [collaterals, supply, savings] = await Promise.all([
    c.getAllCollateralTypes(),
    c.getUsdbSupply().catch(() => null),
    c.getAllSavingPoolObjects(),
  ]);
  return {
    collaterals: (collaterals || []).map((x) => String(x?.coinType || x?.type || x)).filter(Boolean),
    usdbSupply: supply != null ? String(typeof supply === 'bigint' ? supply : (supply?.supply ?? supply)) : null,
    savingPools: (savings || []).length,
    source: 'Bucket SDK (gRPC)',
    updatedAt: new Date().toISOString(),
  };
}

export async function bucketPositions(wallet) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const c = await bucketClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  try {
    const [positions, savings] = await Promise.all([
      c.getUserPositions({ address: wallet }),
      c.getUserSavings({ address: wallet }),
    ]);
    return { positions: positions || [], savings: savings || [], source: 'Bucket SDK (gRPC)', updatedAt: new Date().toISOString() };
  } catch (e) { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); }
}

/* ------------------------------- SPRINGSUI -------------------------------- */

import { fetchLiquidStakingInfo, LstClient } from '@suilend/springsui-sdk';

export const SPRING_LST = {
  id: '0x15eda7330c8f99c30e430b4d82fd7ab2af3ead4ae17046fcb224aa9bad394f6b',
  type: '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI',
  weightHookId: '0xbbafcb2d7399c0846f8185da3f273ad5b26b3b35993050affa44cfa890f1f144',
};

export async function springsuiRate() {
  requireMainnet();
  const info = await fetchLiquidStakingInfo(SPRING_LST, grpcClient()).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const totalSui = Number(info.storage.totalSuiSupply) / 1e9;
  const totalLst = Number(info.lstTreasuryCap.totalSupply.value) / 1e9;
  const rate = rateFromSupplies(info.storage.totalSuiSupply, info.lstTreasuryCap.totalSupply.value);
  return { rate, rateUnit: 'SUI per sSUI', totalSui, totalLst, source: 'SpringSui LST object (gRPC)', updatedAt: new Date().toISOString() };
}

export async function springsuiMint({ wallet, amountMist }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const lst = await LstClient.initialize(grpcClient(), SPRING_LST).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(amountMist))]);
  let out;
  try { out = lst.mint(tx, coin); } catch (e) { throw normalizeLendingError(e); }
  try {
    const res = out && (out.$kind === 'NestedResult' ? out : (Array.isArray(out) ? out[0] : out));
    if (res) tx.transferObjects([res], tx.pure.address(wallet));
  } catch { /* mint may already send to sender */ }
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { amountMist: String(amountMist) } };
}

export async function springsuiRedeem({ wallet, ssuiObjectId, amountMist }) {
  requireMainnet();
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const lst = await LstClient.initialize(grpcClient(), SPRING_LST).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const tx = new Transaction();
  try {
    const amount = amountMist != null ? positiveU64(amountMist) : null;
    let lstInput = ssuiObjectId ? tx.object(ssuiObjectId) : null;
    if (!lstInput) {
      if (!amount) throw err('INVALID_AMOUNT', 'Specify an sSUI amount or an explicit coin object for full redemption.');
      const selected = await pickCoins(wallet, SPRING_LST.type, amount);
      if (selected.total < amount) throw err('INSUFFICIENT_BALANCE', 'sSUI balance insufficient.');
      const ids = selected.coins.map(c => tx.object(c.coinObjectId));
      if (ids.length > 1) tx.mergeCoins(ids[0], ids.slice(1));
      lstInput = ids[0];
    }
    if (amount) [lstInput] = tx.splitCoins(lstInput, [tx.pure.u64(amount)]);
    const out = lst.redeem(tx, lstInput);
    const res = out && (out.$kind === 'NestedResult' ? out : (Array.isArray(out) ? out[0] : out));
    if (res) tx.transferObjects([res], tx.pure.address(wallet));
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { ssuiObjectId: ssuiObjectId || 'auto' } };
}

/* --------------------------- SCALLOP BUILDS ------------------------------- */

async function scallopClient(wallet) {
  requireMainnet();
  const { Scallop } = await import('@scallop-io/sui-scallop-sdk');
  const sdk = new Scallop({
    addressId: SCALLOP_ADDRESS_ID, network: MAINNET ? 'mainnet' : 'testnet',
    fullnodeUrl: 'https://fullnode.mainnet.sui.io:443',
    walletAddress: wallet,
  });
  return sdk.createScallopClient();
}

function scallopTxBytes(txLike, wallet) {
  // ClientServiceContext returns a raw Sui Transaction when sign=false.
  const tx = txLike && txLike.tx ? txLike.tx : txLike;
  return toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
}

async function scallopObligation(wallet) {
  const q = await scallopQuery(wallet).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const obs = await q.getObligations(wallet).catch(() => []);
  const ob = (obs || [])[0];
  if (!ob) throw err('NO_OBLIGATION', 'No Scallop obligation — supply collateral first.');
  return ob;
}

export async function scallopSupply({ wallet, coinName, amountMist }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await scallopClient(wallet).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  let tx;
  try { tx = await c.lendingService.supply(String(coinName).toLowerCase(), safeSdkAmount(amountMist), false, wallet); }
  catch (e) { throw normalizeLendingError(e); }
  const txBytes = await scallopTxBytes(tx, wallet);
  return { txBytes, meta: { coinName, amountMist: String(amountMist) } };
}

export async function scallopWithdraw({ wallet, coinName, amountMist }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await scallopClient(wallet).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  let tx;
  try { tx = await c.lendingService.withdraw(String(coinName).toLowerCase(), safeSdkAmount(amountMist), false, wallet); }
  catch (e) { throw normalizeLendingError(e); }
  const txBytes = await scallopTxBytes(tx, wallet);
  return { txBytes, meta: { coinName, amountMist: String(amountMist) } };
}

export async function scallopBorrow({ wallet, coinName, amountMist, obligationId, obligationKey }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await scallopClient(wallet).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  let ob = obligationId ? { id: obligationId, key: obligationKey } : null;
  if (!ob) {
    const raw = await scallopObligation(wallet);
    ob = { id: raw.id || raw.obligationId, key: raw.key || raw.obligationKey || raw.obligationKeyId };
  }
  if (!ob.id || !ob.key) throw err('NO_OBLIGATION', 'Obligation id/key unreadable — open one on the venue first.');
  let tx;
  try { tx = await c.borrowService.borrow(String(coinName).toLowerCase(), safeSdkAmount(amountMist), false, ob.id, ob.key, wallet); }
  catch (e) { throw normalizeLendingError(e); }
  const txBytes = await scallopTxBytes(tx, wallet);
  return { txBytes, meta: { coinName, amountMist: String(amountMist), obligationId: ob.id } };
}

export async function scallopRepay({ wallet, coinName, amountMist, obligationId, obligationKey }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await scallopClient(wallet).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  let ob = obligationId ? { id: obligationId, key: obligationKey } : null;
  if (!ob) {
    const raw = await scallopObligation(wallet);
    ob = { id: raw.id || raw.obligationId, key: raw.key || raw.obligationKey || raw.obligationKeyId };
  }
  if (!ob.id || !ob.key) throw err('NO_OBLIGATION', 'Obligation id/key unreadable — open one on the venue first.');
  let tx;
  try { tx = await c.borrowService.repay(String(coinName).toLowerCase(), safeSdkAmount(amountMist), false, ob.id, ob.key, wallet); }
  catch (e) { throw normalizeLendingError(e); }
  const txBytes = await scallopTxBytes(tx, wallet);
  return { txBytes, meta: { coinName, amountMist: String(amountMist), obligationId: ob.id } };
}

/* ---------------------------- BUCKET BUILDS -------------------------------- */

export async function bucketPsmSwap({ wallet, coinType, amountMist, dir }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await bucketClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const tx = new Transaction();
  let out;
  try {
    out = dir === 'out'
      ? await c.buildPSMSwapOutTransaction(tx, { coinType, usdbCoinOrAmount: safeSdkAmount(amountMist) })
      : await c.buildPSMSwapInTransaction(tx, { coinType, inputCoinOrAmount: safeSdkAmount(amountMist) });
    if (out) tx.transferObjects([out], tx.pure.address(wallet));
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet, typeof amountMist !== 'undefined' && (typeof coinType === 'undefined' || coinType === SUI_TYPE) ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist), dir: dir || 'in' } };
}

/* --------------------------------- VOLO ----------------------------------- */

export async function voloStats() {
  requireMainnet();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch('https://open-api.naviprotocol.io/api/volo/stats', { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw Object.assign(new Error('HTTP_' + r.status), { code: 'PROVIDER_UNAVAILABLE' });
    const j = await r.json();
    const d = j?.data || {};
    return {
      totalStaked: d.totalStaked ?? null,
      apy: d.apy ?? d.avgApy ?? null,
      validators: (d.validators || []).map((v) => ({ address: v.address, name: v.name || null, apy: v.apy ?? null, staked: v.totalStaked ?? null })),
      source: 'NAVI open API (vSUI stats)',
      updatedAt: new Date().toISOString(),
    };
  } catch (e) { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); }
  finally { clearTimeout(t); }
}

/* --------------------------- AFTERMATH SWAP BUILD ------------------------- */

let _af = null;
export async function aftermathSdk() {
  if (!_af) _af = await Aftermath.create({ network: MAINNET ? 'MAINNET' : 'TESTNET', fullnodeUrl: GRPC_URL });
  if (!_af) {
    const { Aftermath: Af } = await import('aftermath-ts-sdk');
    _af = new Af(MAINNET ? 'MAINNET' : 'TESTNET');
  }
  return _af;
}

/**
 * Aftermath swap execution path (QUOTE already LIVE). Builds the swap INSIDE a
 * Noise-owned tx so the platform fee leg is preserved: fee is split from the
 * input coin first, the remainder feeds the router (documented prefix pattern).
 */
export async function aftermathSwapBuild({ wallet, fromType, toType, amountMist, slippage, feeBps, feeRecipient }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (positiveU64(amountMist) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const af = await aftermathSdk().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const router = af.Router();
  let tx = new Transaction();
  tx.setSenderIfNotSet(wallet);
  const fee = await getPlatformFee({ action: 'swap', provider: 'aftermath', instrument: `${String(fromType).split('::').pop().toUpperCase()}_${String(toType).split('::').pop().toUpperCase()}`, amount: amountMist, asset: fromType });
  let coinIn;
  if (fromType === SUI_TYPE) {
    coinIn = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(amountMist))])[0];
  } else {
    const { coins, total } = await pickCoins(wallet, fromType, amountMist).catch((e) => { throw normalizeLendingError(e); });
    if (total < BigInt(amountMist)) throw err('INSUFFICIENT_BALANCE', 'Balance insufficient.');
    const ids = coins.map((c) => tx.object(c.coinObjectId));
    if (ids.length > 1) tx.mergeCoins(ids[0], ids.slice(1));
    coinIn = tx.splitCoins(ids[0], [tx.pure.u64(BigInt(amountMist))])[0];
  }
  let feeCollected = null;
  if (fee?.enabled && fee.recipient && validateFeeRecipient(fee.recipient).valid && Number(fee.bps || 0) > 0) {
    const feeMist = (BigInt(amountMist) * BigInt(Number(fee.bps))) / 10000n;
    if (feeMist > 0n) {
      const [feeCoin] = tx.splitCoins(coinIn, [tx.pure.u64(feeMist)]);
      tx.transferObjects([feeCoin], tx.pure.address(fee.recipient));
      feeCollected = { amountMist: String(feeMist), recipient: fee.recipient, bps: Number(fee.bps) };
    }
  }
  const routeAmount = positiveU64(amountMist) - BigInt(feeCollected?.amountMist || 0);
  const route = await router.getCompleteTradeRouteGivenAmountIn({
    coinInType: fromType, coinOutType: toType, coinInAmount: routeAmount,
  }).catch(e => { throw normalizeLendingError(e, 'QUOTE_FAILED'); });
  if (!route?.coinOut) throw err('QUOTE_FAILED', 'Aftermath returned no route.');
  try {
    // The router may return an extended tx — always serialize what it returns.
    const r = await router.addTransactionForCompleteTradeRoute({
      tx, completeRoute: route, slippage: Number(slippage ?? 0.01), walletAddress: wallet, coinInId: coinIn,
    });
    tx = r.tx || tx;
    if (r.coinOutId) tx.transferObjects([r.coinOutId], wallet);
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet, fromType === SUI_TYPE ? amountMist : 0n).catch((e) => { throw normalizeLendingError(e); });
  return {
    txBytes,
    meta: {
      amountOut: String(route.coinOut?.amount ?? 0),
      spotPrice: route.spotPrice ?? null,
      feeCollected,
    },
  };
}

/** Composable workflow helpers: use the swap's actual output Coin, not a quote amount. */
export async function journeySuilendDeposit(tx,wallet,coinType,coin,obligationId){
  requireMainnet();const c=await suilendClient();const caps=await SuilendClient.getObligationOwnerCaps(wallet,[LENDING_MARKET_TYPE],grpcClient());
  if(obligationId&&!caps.some(cap=>cap.obligationId===obligationId))throw err('NO_OBLIGATION','Selected obligation is not owned by wallet.');
  const selected=obligationId?caps.find(cap=>cap.obligationId===obligationId):caps[0];const cap=selected?tx.object(selected.id):c.createObligation(tx);
  c.deposit(coin,coinType,cap,tx);if(!selected)tx.transferObjects([cap],tx.pure.address(wallet));return{firstSupply:!selected,obligationId:selected?.obligationId||null};
}
export async function journeySuilendWithdraw(tx,wallet,coinType,amountMist,obligationId){
  requireMainnet();const c=await suilendClient(),caps=await SuilendClient.getObligationOwnerCaps(wallet,[LENDING_MARKET_TYPE],grpcClient());const cap=caps.find(c=>c.obligationId===obligationId);if(!cap)throw err('NO_OBLIGATION','Choose an owned obligation.');
  const[out]=await c.withdraw(tx.object(cap.id),cap.obligationId,coinType,String(positiveU64(amountMist)),tx);return out;
}
export async function journeyNaviDeposit(tx,coinType,coin,pool){requireMainnet();const amount=tx.moveCall({target:'0x2::coin::value',typeArguments:[coinType],arguments:[coin]});await naviSdkDeposit(tx,pool??coinType,coin,{amount});}
export async function refreshNaviOracle(tx,wallet,pool){const p=await naviSdkPool(pool,{client:grpcClient()});await naviSdkOracle(tx,wallet,[p],{client:grpcClient(),throws:true});}
export async function journeyNaviWithdraw(tx,coinType,amountMist,pool,wallet){requireMainnet();await refreshNaviOracle(tx,wallet,pool??coinType);return naviSdkWithdraw(tx,pool??coinType,tx.pure.u64(positiveU64(amountMist)),{});}
