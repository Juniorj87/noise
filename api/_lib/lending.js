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
import {
  getPools as naviSdkPools,
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
const GRPC_URL = process.env.SUI_GRPC_URL || 'https://fullnode.mainnet.sui.io:443';
const JSON_URL = process.env.SUI_RPC_URL || 'https://sui-rpc.publicnode.com';

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

async function toBytes64(tx, sender) {
  tx.setSenderIfNotSet(sender);
  const bytes = await tx.build({ client: jsonClient() });
  return Buffer.from(bytes).toString('base64');
}

/** devInspect dry-run over the exact bytes the wallet would sign. Read-only. */
export async function devInspectB64(txBytesB64, sender) {
  const raw = Buffer.from(String(txBytesB64), 'base64');
  const res = await jsonClient().devInspectTransactionBlock({ transactionBlock: raw, sender });
  const ok = res?.effects?.status?.status === 'success';
  return { ok, simulation: res };
}

/* ------------------------------- TRANSFER -------------------------------- */

const SUI_TYPE = '0x2::sui::SUI';

async function pickCoins(owner, coinType, amountMist) {
  const page = await jsonClient().getCoins({ owner, coinType });
  const coins = (page?.data || []).filter((c) => BigInt(c.balance || 0) > 0n);
  const total = coins.reduce((a, c) => a + BigInt(c.balance || 0), 0n);
  return { coins, total };
}

/**
 * Plain Sui coin transfer PTB (unsigned). Supports only assets Noise knows
 * (coinType allowlist enforced by the caller via coinType()).
 */
export async function transferBuild({ sender, coinType, amountMist, recipient }) {
  if (!isWalletAddress(sender)) throw err('INVALID_WALLET', 'Sender looks invalid.');
  if (!isWalletAddress(recipient)) throw err('INVALID_RECIPIENT', 'Recipient looks invalid.');
  const amount = BigInt(amountMist || 0);
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
  const txBytes = await toBytes64(tx, sender).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amount), recipient } };
}

/* ------------------------------- SUILEND --------------------------------- */

let _suilend = null;
export async function suilendClient() {
  if (!_suilend) _suilend = await SuilendClient.initialize(LENDING_MARKET_ID, LENDING_MARKET_TYPE, grpcClient());
  return _suilend;
}

export async function suilendMarkets() {
  const c = await suilendClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  return c.lendingMarket.reserves.map((r) => ({
    coinType: typeof r.coinType === 'string' ? r.coinType : (r.coinType?.name ?? String(r.coinType?.typeName ?? '')),
    decimals: r.mintDecimals ?? null,
    depositApr: r.depositAprPercent != null ? Number(r.depositAprPercent) : null,
    borrowApr: r.borrowAprPercent != null ? Number(r.borrowAprPercent) : null,
    available: r.availableAmount != null ? String(r.availableAmount) : null,
    source: 'Suilend SDK (gRPC)',
  }));
}

export async function suilendPosition(wallet) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const g = grpcClient();
  const caps = await SuilendClient.getObligationOwnerCaps(wallet, [LENDING_MARKET_TYPE], g)
    .catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const out = [];
  for (const cap of caps || []) {
    try {
      const ob = await SuilendClient.getObligation(cap.obligationId, [LENDING_MARKET_TYPE], g);
      out.push({
        obligationId: cap.obligationId,
        capId: cap.id,
        deposits: (ob.deposits || []).map((d) => ({ coinType: d.coinType, amount: String(d.depositedAmount ?? d.amount ?? 0) })),
        borrows: (ob.borrows || []).map((b) => ({ coinType: b.coinType, amount: String(b.borrowedAmount ?? b.amount ?? 0) })),
        health: ob.health != null ? Number(ob.health) : null,
      });
    } catch { /* one bad obligation must not kill the list */ }
  }
  return { obligations: out, source: 'Suilend SDK (gRPC)', updatedAt: new Date().toISOString() };
}

async function suilendCapOrThrow(wallet) {
  const caps = await SuilendClient.getObligationOwnerCaps(wallet, [LENDING_MARKET_TYPE], grpcClient())
    .catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  if (!caps || !caps.length) throw err('NO_OBLIGATION', 'No Suilend obligation — supply collateral first.');
  return caps[0];
}

export async function suilendSupply({ wallet, coinType, amountMist }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
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
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist), firstSupply: !caps.length } };
}

export async function suilendWithdraw({ wallet, coinType, amountMist }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
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
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
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
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await suilendClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const cap = await suilendCapOrThrow(wallet);
  const tx = new Transaction();
  try {
    await c.repayIntoObligation(wallet, obligationId || cap.obligationId, coinType, String(amountMist), tx);
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist), obligationId: obligationId || cap.obligationId } };
}

export async function suilendClaim({ wallet }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const c = await suilendClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const cap = await suilendCapOrThrow(wallet);
  const tx = new Transaction();
  try {
    // Claim-all shape follows the SDK tutorial (rewards list resolved per obligation at build time).
    const res = await c.claimRewardsAndSendToUser?.(wallet, tx.object(cap.id), cap.obligationId, tx);
    if (!res) throw err('INVALID_ACTION', 'No claimable rewards entry resolved for this obligation.');
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { obligationId: cap.obligationId } };
}

/* -------------------------------- NAVI ----------------------------------- */

function naviPoolId(pool) {
  return pool?.id ?? pool?.poolId ?? pool;
}

export async function naviMarkets() {
  const pools = await naviSdkPools({}).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  // Raw on-chain rates are ray-scaled internals — no APY is derived without a
  // verified scale. Liquidity/minimum/LTV are plain values and safe to show.
  return (pools || []).map((p) => ({
    id: p.id,
    coinType: p.coinType || p.suiCoinType || null,
    symbol: p.token?.symbol || p.symbol || null,
    decimals: p.token?.decimals ?? null,
    price: p.token?.price ?? p.oracle?.price ?? null,
    leftSupply: p.leftSupply ?? null,
    availableBorrow: p.availableBorrow ?? null,
    minimumAmount: p.minimumAmount ?? null,
    ltv: p.ltvValue ?? p.ltv ?? null,
    incentives: p.supplyIncentiveApyInfo ?? p.borrowIncentiveApyInfo ?? null,
    deprecated: Boolean(p.isDeprecated || (p.deprecatedAt && Date.now() > p.deprecatedAt)),
    source: 'NAVI Lending SDK (gRPC)',
  }));
}

export async function naviPosition(wallet) {
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
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const rewards = await naviSdkRewards(wallet, {}).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  return { rewards: rewards || [], source: 'NAVI Lending SDK', updatedAt: new Date().toISOString() };
}

async function naviCoinInput(tx, sender, coinType, amountMist) {
  if (coinType === SUI_TYPE) {
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
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const tx = new Transaction();
  try {
    const coin = await naviCoinInput(tx, wallet, coinType, amountMist);
    await naviSdkDeposit(tx, pool ?? coinType, coin, { amount: Number(amountMist) });
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist) } };
}

export async function naviWithdraw({ wallet, coinType, amountMist, pool }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const tx = new Transaction();
  try {
    const out = await naviSdkWithdraw(tx, pool ?? coinType, Number(amountMist), {});
    if (out) tx.transferObjects([out], tx.pure.address(wallet));
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist) } };
}

export async function naviBorrow({ wallet, coinType, amountMist, pool }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const tx = new Transaction();
  try {
    const out = await naviSdkBorrow(tx, pool ?? coinType, Number(amountMist), {});
    if (out) tx.transferObjects([out], tx.pure.address(wallet));
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist) } };
}

export async function naviRepay({ wallet, coinType, amountMist, pool }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const tx = new Transaction();
  try {
    const coin = await naviCoinInput(tx, wallet, coinType, amountMist);
    await naviSdkRepay(tx, pool ?? coinType, coin, { amount: Number(amountMist) });
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist) } };
}

export async function naviClaim({ wallet }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const rewards = await naviSdkRewards(wallet, {}).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  if (!rewards || !rewards.length) throw err('NO_POSITION', 'No claimable NAVI rewards for this wallet.');
  const tx = new Transaction();
  try {
    await naviSdkClaim(tx, rewards, { customCoinReceive: { type: 'transfer', transfer: wallet } });
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
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
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const [rate, balances, objects] = await Promise.all([
    haedalRate().catch(() => null),
    jsonClient().getAllBalances({ owner: wallet }).catch(() => []),
    jsonClient().getOwnedObjects({ owner: wallet, options: { showType: true }, limit: 50 }).catch(() => ({ data: [] })),
  ]);
  const hasui = (balances || []).filter((b) => /::hasui::/i.test(b.coinType || ''));
  const tickets = ((objects && objects.data) || []).filter((o) => {
    const t = o?.data?.objectType || o?.data?.type || '';
    return /unstaketicket|withdrawticket|claim/i.test(t);
  }).map((o) => ({ id: o?.data?.objectId, type: o?.data?.objectType || o?.data?.type }));
  return {
    rate: rate?.rate ?? null,
    hasui: hasui.map((b) => ({ coinType: b.coinType, balance: String(b.totalBalance) })),
    pendingTickets: tickets,
    source: 'Sui RPC + Haedal staking object',
    updatedAt: new Date().toISOString(),
  };
}

export async function haedalStakeBuild({ wallet, amountMist, validator }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  // Official interface: validator 0x0 = Haedal auto-distribution. An explicit
  // active validator may be passed instead; Noise never invents one.
  const val = validator && validator !== HAEDAL.autoValidator ? validator : HAEDAL.autoValidator;
  if (val !== HAEDAL.autoValidator && !isWalletAddress(val)) throw err('INVALID_ACTION', 'Validator address malformed.');
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
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
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  const minOut = Math.floor(Number(amountMist) / (rate.rate || 1));
  return { txBytes, meta: { amountMist: String(amountMist), minReceivedHasui: String(minOut), rate: rate.rate, validator } };
}

export async function haedalUnstakeInstantBuild({ wallet, hasuiMist, hasuiType }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(hasuiMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const type = hasuiType || (await haedalPosition(wallet).catch(() => null))?.hasui?.[0]?.coinType;
  if (!type) throw err('NO_POSITION', 'No haSUI balance found for this wallet.');
  const { coins, total } = await pickCoins(wallet, type, hasuiMist).catch((e) => { throw normalizeLendingError(e); });
  if (total < BigInt(hasuiMist)) throw err('INSUFFICIENT_BALANCE', 'haSUI balance insufficient.');
  const tx = new Transaction();
  const ids = coins.map((c) => tx.object(c.coinObjectId));
  if (ids.length > 1) tx.mergeCoins(ids[0], ids.slice(1));
  const [coin] = tx.splitCoins(ids[0], [tx.pure.u64(BigInt(hasuiMist))]);
  // Returns Coin<SUI> (9% service fee per official docs; may fail on low vault liquidity).
  const [sui] = tx.moveCall({
    target: `${HAEDAL.stakingPkg}::staking::request_unstake_instant_v2`,
    arguments: [tx.object(HAEDAL.sysStateObj), tx.object(HAEDAL.stakingObj), coin],
  });
  tx.transferObjects([sui], tx.pure.address(wallet));
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { hasuiMist: String(hasuiMist), mode: 'instant (9% fee, may fail on low liquidity)' } };
}

export async function haedalUnstakeRequestBuild({ wallet, hasuiMist, hasuiType }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(hasuiMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const type = hasuiType || (await haedalPosition(wallet).catch(() => null))?.hasui?.[0]?.coinType;
  if (!type) throw err('NO_POSITION', 'No haSUI balance found for this wallet.');
  const { coins, total } = await pickCoins(wallet, type, hasuiMist).catch((e) => { throw normalizeLendingError(e); });
  if (total < BigInt(hasuiMist)) throw err('INSUFFICIENT_BALANCE', 'haSUI balance insufficient.');
  const tx = new Transaction();
  const ids = coins.map((c) => tx.object(c.coinObjectId));
  if (ids.length > 1) tx.mergeCoins(ids[0], ids.slice(1));
  const [coin] = tx.splitCoins(ids[0], [tx.pure.u64(BigInt(hasuiMist))]);
  // Returns UnstakeTicket — claimable via claim_v2 after 1-2 epochs.
  const [ticket] = tx.moveCall({
    target: `${HAEDAL.stakingPkg}::staking::request_unstake_delay`,
    arguments: [tx.object(HAEDAL.stakingObj), tx.object(HAEDAL.clockObj), coin],
  });
  tx.transferObjects([ticket], tx.pure.address(wallet));
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { hasuiMist: String(hasuiMist), mode: 'delayed (1-2 epochs, then claim)' } };
}

export async function haedalClaimBuild({ wallet, ticketId }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (!/^0x[0-9a-fA-F]{64}$/.test(ticketId || '')) throw err('INVALID_ACTION', 'Unstake ticket object id required.');
  const tx = new Transaction();
  const [sui] = tx.moveCall({
    target: `${HAEDAL.stakingPkg}::staking::claim_v2`,
    arguments: [tx.object(HAEDAL.sysStateObj), tx.object(HAEDAL.stakingObj), tx.object(ticketId)],
  });
  tx.transferObjects([sui], tx.pure.address(wallet));
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
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
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const key = String(poolKey || 'SUI_USDC').toUpperCase();
  const pre = await marginPreflight(key).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  if (!pre.marginEnabled) throw err('MARKET_UNAVAILABLE', key + ' is not margin-enabled on-chain.');
  const tx = new Transaction();
  try {
    tx.add(marginClient(wallet).deepbook.marginManager.newMarginManager(key));
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
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
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (!(Number(amountHuman) > 0)) throw err('INVALID_AMOUNT', 'Amount must be positive.');
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
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { mCoin, coinType, amountHuman: String(amountHuman) } };
}

export async function mstableBurn({ wallet, mCoin, coinType, amountHuman, minOut }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (!(Number(amountHuman) > 0)) throw err('INVALID_AMOUNT', 'Amount must be positive.');
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
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { mCoin, coinType, amountHuman: String(amountHuman), feeNote: 'dynamic 0.01–1%' } };
}

/* -------------------------------- TURBOS ---------------------------------- */

import { TurbosSdk, Network as TurbosNetwork } from 'turbos-clmm-sdk';

let _turbos = null;
function turbosSdk() {
  if (!_turbos) _turbos = new TurbosSdk(TurbosNetwork.mainnet);
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
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
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
      const out = row ? Number(a2b ? (row.amount_b ?? 0) : (row.amount_a ?? 0)) : 0;
      if (out > 0 && (!best || out > best.out)) best = { out, pool: p.id };
    } catch { /* one bad pool must not kill the quote */ }
  }
  if (!best) throw err('QUOTE_FAILED', 'Turbos could not price this amount.');
  return { provider: 'Turbos', amountOut: String(Math.floor(best.out)), pool: best.pool, source: 'Turbos SDK (computeSwapResult)' };
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
  const q = await scallopQuery().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  let m;
  try { m = await q.getMarketPools(); }
  catch (e) { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); }
  const rows = [];
  for (const [side, group] of Object.entries(m || {})) {
    for (const [name, p] of Object.entries(group || {})) {
      rows.push({
        name, side,
        coinType: p.coinType || null,
        symbol: p.symbol || name,
        price: p.coinPrice ?? null,
        supplyApr: p.supplyApr ?? p.supplyAPY ?? null,
        borrowApr: p.borrowApr ?? p.borrowAPY ?? null,
      });
    }
  }
  return { markets: rows, source: 'Scallop SDK (query)', updatedAt: new Date().toISOString() };
}

export async function scallopPositions(wallet) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const q = await scallopQuery(wallet).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  try {
    const [obligations, portfolio] = await Promise.all([
      q.getObligations(wallet).catch(() => []),
      q.getUserPortfolio({ walletAddress: wallet }).catch(() => null),
    ]);
    return { obligations: obligations || [], portfolio, source: 'Scallop SDK (query)', updatedAt: new Date().toISOString() };
  } catch (e) { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); }
}

/* -------------------------------- BUCKET ---------------------------------- */

import { BucketClient } from '@bucket-protocol/sdk';

let _bucket = null;
export async function bucketClient() {
  if (!_bucket) {
    const grpc = new SuiGrpcClient({ network: 'mainnet', baseUrl: GRPC_URL });
    _bucket = await BucketClient.initialize({ suiClient: grpc, network: 'mainnet' });
  }
  return _bucket;
}

export async function bucketMarkets() {
  const c = await bucketClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const [collaterals, supply, savings] = await Promise.all([
    c.getAllCollateralTypes().catch(() => []),
    c.getUsdbSupply().catch(() => null),
    c.getAllSavingPoolObjects().catch(() => []),
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
      c.getUserPositions(wallet).catch(() => c.getAccountPositions(wallet).catch(() => [])),
      c.getUserSavings(wallet).catch(() => c.getAccountSavings(wallet).catch(() => [])),
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
  const info = await fetchLiquidStakingInfo(SPRING_LST, grpcClient()).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const totalSui = Number(info.storage.totalSuiSupply) / 1e9;
  const totalLst = Number(info.lstTreasuryCap.totalSupply.value) / 1e9;
  const rate = totalSui > 0 ? totalLst / totalSui : 0;
  return { rate, totalSui, totalLst, source: 'SpringSui LST object (gRPC)', updatedAt: new Date().toISOString() };
}

export async function springsuiMint({ wallet, amountMist }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const lst = await LstClient.initialize(grpcClient(), SPRING_LST).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(amountMist))]);
  let out;
  try { out = lst.mint(tx, coin); } catch (e) { throw normalizeLendingError(e); }
  try {
    const res = out && (out.$kind === 'NestedResult' ? out : (Array.isArray(out) ? out[0] : out));
    if (res) tx.transferObjects([res], tx.pure.address(wallet));
  } catch { /* mint may already send to sender */ }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { amountMist: String(amountMist) } };
}

export async function springsuiRedeem({ wallet, ssuiObjectId, amountMist }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  const lst = await LstClient.initialize(grpcClient(), SPRING_LST).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const tx = new Transaction();
  try {
    let lstInput = ssuiObjectId ? tx.object(ssuiObjectId) : null;
    if (!lstInput) {
      const page = await jsonClient().getCoins({ owner: wallet, coinType: SPRING_LST.type }).catch(() => null);
      const first = page?.data?.[0];
      if (!first) throw err('NO_POSITION', 'No sSUI balance found for this wallet.');
      lstInput = tx.object(first.coinObjectId);
    }
    const out = lst.redeem(tx, lstInput);
    const res = out && (out.$kind === 'NestedResult' ? out : (Array.isArray(out) ? out[0] : out));
    if (res) tx.transferObjects([res], tx.pure.address(wallet));
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { ssuiObjectId: ssuiObjectId || 'auto' } };
}

/* --------------------------- SCALLOP BUILDS ------------------------------- */

async function scallopClient(wallet) {
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
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await scallopClient(wallet).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  let tx;
  try { tx = await c.lendingService.supply(String(coinName).toLowerCase(), Number(amountMist), false, wallet); }
  catch (e) { throw normalizeLendingError(e); }
  const txBytes = await scallopTxBytes(tx, wallet);
  return { txBytes, meta: { coinName, amountMist: String(amountMist) } };
}

export async function scallopWithdraw({ wallet, coinName, amountMist }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await scallopClient(wallet).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  let tx;
  try { tx = await c.lendingService.withdraw(String(coinName).toLowerCase(), Number(amountMist), false, wallet); }
  catch (e) { throw normalizeLendingError(e); }
  const txBytes = await scallopTxBytes(tx, wallet);
  return { txBytes, meta: { coinName, amountMist: String(amountMist) } };
}

export async function scallopBorrow({ wallet, coinName, amountMist, obligationId, obligationKey }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await scallopClient(wallet).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  let ob = obligationId ? { id: obligationId, key: obligationKey } : null;
  if (!ob) {
    const raw = await scallopObligation(wallet);
    ob = { id: raw.id || raw.obligationId, key: raw.key || raw.obligationKey || raw.obligationKeyId };
  }
  if (!ob.id || !ob.key) throw err('NO_OBLIGATION', 'Obligation id/key unreadable — open one on the venue first.');
  let tx;
  try { tx = await c.borrowService.borrow(String(coinName).toLowerCase(), Number(amountMist), false, ob.id, ob.key, wallet); }
  catch (e) { throw normalizeLendingError(e); }
  const txBytes = await scallopTxBytes(tx, wallet);
  return { txBytes, meta: { coinName, amountMist: String(amountMist), obligationId: ob.id } };
}

export async function scallopRepay({ wallet, coinName, amountMist, obligationId, obligationKey }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await scallopClient(wallet).catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  let ob = obligationId ? { id: obligationId, key: obligationKey } : null;
  if (!ob) {
    const raw = await scallopObligation(wallet);
    ob = { id: raw.id || raw.obligationId, key: raw.key || raw.obligationKey || raw.obligationKeyId };
  }
  if (!ob.id || !ob.key) throw err('NO_OBLIGATION', 'Obligation id/key unreadable — open one on the venue first.');
  let tx;
  try { tx = await c.borrowService.repay(String(coinName).toLowerCase(), Number(amountMist), false, ob.id, ob.key, wallet); }
  catch (e) { throw normalizeLendingError(e); }
  const txBytes = await scallopTxBytes(tx, wallet);
  return { txBytes, meta: { coinName, amountMist: String(amountMist), obligationId: ob.id } };
}

/* ---------------------------- BUCKET BUILDS -------------------------------- */

export async function bucketPsmSwap({ wallet, coinType, amountMist, dir }) {
  if (!isWalletAddress(wallet)) throw err('INVALID_WALLET', 'Wallet looks invalid.');
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const c = await bucketClient().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const tx = new Transaction();
  let out;
  try {
    out = dir === 'out'
      ? await c.buildPSMSwapOutTransaction(tx, { coinType, usdbCoinOrAmount: Number(amountMist) })
      : await c.buildPSMSwapInTransaction(tx, { coinType, inputCoinOrAmount: Number(amountMist) });
    if (out) tx.transferObjects([out], tx.pure.address(wallet));
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return { txBytes, meta: { coinType, amountMist: String(amountMist), dir: dir || 'in' } };
}

/* --------------------------------- VOLO ----------------------------------- */

export async function voloStats() {
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
async function aftermathSdk() {
  if (!_af) _af = await Aftermath.create?.({ network: MAINNET ? 'MAINNET' : 'TESTNET' });
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
  if (BigInt(amountMist || 0) <= 0n) throw err('INVALID_AMOUNT', 'Amount must be positive.');
  const af = await aftermathSdk().catch((e) => { throw normalizeLendingError(e, 'PROVIDER_UNAVAILABLE'); });
  const router = af.Router();
  const route = await router.getCompleteTradeRouteGivenAmountIn({
    coinInType: fromType, coinOutType: toType, coinInAmount: BigInt(amountMist),
  }).catch((e) => { throw normalizeLendingError(e, 'QUOTE_FAILED'); });
  if (!route || !route.coinOut) throw err('QUOTE_FAILED', 'Aftermath returned no route.');
  let tx = new Transaction();
  tx.setSenderIfNotSet(wallet);
  const fee = await getPlatformFee({ action: 'swap', provider: 'aftermath', instrument: `${fromType}_${toType}`, amount: amountMist, asset: fromType }).catch(() => null);
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
  if (fee?.enabled && fee.recipient && validateFeeRecipient(fee.recipient).valid && Number(feeBps || 0) > 0) {
    const feeMist = (BigInt(amountMist) * BigInt(Number(feeBps))) / 10000n;
    if (feeMist > 0n) {
      const [feeCoin] = tx.splitCoins(coinIn, [tx.pure.u64(feeMist)]);
      tx.transferObjects([feeCoin], tx.pure.address(fee.recipient));
      feeCollected = { amountMist: String(feeMist), recipient: fee.recipient, bps: Number(feeBps) };
    }
  }
  try {
    // The router may return an extended tx — always serialize what it returns.
    const r = await router.addTransactionForCompleteTradeRoute({
      tx, completeRoute: route, slippage: Number(slippage || 0.01), walletAddress: wallet, coinInId: coinIn,
    });
    tx = r.tx || tx;
    if (r.coinOutId) tx.transferObjects([r.coinOutId], wallet);
  } catch (e) { throw normalizeLendingError(e); }
  const txBytes = await toBytes64(tx, wallet).catch((e) => { throw normalizeLendingError(e); });
  return {
    txBytes,
    meta: {
      amountOut: String(route.coinOut?.amount ?? 0),
      spotPrice: route.spotPrice ?? null,
      feeCollected,
    },
  };
}
