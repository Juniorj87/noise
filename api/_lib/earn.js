// Earn/Staking library — native Sui staking (sui_system) and Aftermath
// liquid staking (afSUI). All tx helpers only BUILD unsigned PTBs:
// the wallet signs, the backend never does (spec §5, §16).
// Amounts are raw MIST integers (1 SUI = 1_000_000_000 MIST) — integer
// math only, no float money (spec §15).
import { Aftermath } from 'aftermath-ts-sdk';
import { sui, NETWORK } from './adapters.js';

export const SUI_TYPE = '0x2::sui::SUI';
export const SUI_SYSTEM_STATE = '0x0000000000000000000000000000000000000000000000000000000000000006';
export const MIN_STAKE_MIST = 1_000_000_000n;   // 1 SUI — on-chain minimum
export const MIN_UNSTAKE_MIST = 1_000_000_000n; // 1 SUI / 1 afSUI
const U64_MAX = 18446744073709551615n;

/** Fullnode that serves gRPC-web (required by the Aftermath SDK tx builders).
 *  Live-verified: only fullnode.mainnet.sui.io:443 answers gRPC-web;
 *  publicnode does not. JSON-RPC reads keep using the configured RPC_URL. */
const FULLNODE_GRPC_URL = NETWORK === 'testnet'
  ? 'https://fullnode.testnet.sui.io:443'
  : 'https://fullnode.mainnet.sui.io:443';

/* ---------- pure helpers (unit-tested) ---------- */

/** Parse a raw MIST amount. Accepts digit strings (any u64 size) or safe
 *  integers. Returns BigInt or null — never a float, never a silent coerce. */
export function parseMistAmount(v) {
  if (typeof v === 'string' && /^\d{1,39}$/.test(v)) {
    const b = BigInt(v);
    return b <= U64_MAX ? b : null;
  }
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

/** Hub fee preview for the review screen. Earn platform fee defaults to 0 bps
 *  (feeConfig earnBps); protocol fees are surfaced with their source. */
export function earnFeePreview({ amountSui, earnBps = 0, protocolFeeRatio = 0, protocolFeeBasis = null }) {
  const a = Number(amountSui || 0);
  const platform = Math.round((a * Number(earnBps) / 10000) * 1e6) / 1e6;
  const protocol = protocolFeeRatio > 0 ? Math.round(a * Number(protocolFeeRatio) * 1e6) / 1e6 : 0;
  const out = {
    platformFee: platform,
    protocolFee: protocol,
    networkFee: 0.01,
    total: Math.round((platform + protocol + 0.01) * 1e6) / 1e6,
  };
  if (protocolFeeBasis) out.protocolFeeBasis = protocolFeeBasis;
  return out;
}

/** Normalize SuiSystemStateSummary validators + merge chain APYs. Pure. */
export function normalizeValidators(state, apysRaw) {
  const apyMap = new Map();
  for (const a of apysRaw?.apys ?? []) {
    if (!a || !a.address) continue;
    apyMap.set(String(a.address).toLowerCase(), Number(a.apy ?? 0));
  }
  return (state?.activeValidators ?? []).map((v) => ({
    suiAddress: v.suiAddress,
    name: v.name || null,
    description: v.description || null,
    projectUrl: v.projectUrl || null,
    imageUrl: v.imageUrl || null,
    commissionRate: v.commissionRate ?? null,
    nextEpochCommissionRate: v.nextEpochCommissionRate ?? null,
    votingPower: v.votingPower ?? null,
    stakingPoolSuiBalance: v.stakingPoolSuiBalance ?? null,
    poolTokenBalance: v.poolTokenBalance ?? null,
    stakingPoolId: v.stakingPoolId ?? null,
    gasPrice: v.gasPrice ?? null,
    apy: apyMap.get(String(v.suiAddress).toLowerCase()) ?? null,
  })).sort((a, b) => Number(b.stakingPoolSuiBalance || 0) - Number(a.stakingPoolSuiBalance || 0));
}

/** Normalize DelegatedStake[] (getStakes) into plain rows. Pure. */
export function normalizeDelegations(delegations) {
  const rows = [];
  let stakedMist = 0n;
  for (const d of delegations ?? []) {
    for (const s of d.stakes ?? []) {
      const principal = BigInt(s.principal || 0);
      stakedMist += principal;
      rows.push({
        stakedSuiId: s.stakedSuiId,
        validatorAddress: d.validatorAddress,
        stakingPool: d.stakingPool,
        principal: principal.toString(),
        stakeRequestEpoch: s.stakeRequestEpoch?.toString() ?? null,
        stakeActiveEpoch: s.stakeActiveEpoch?.toString() ?? null,
        status: s.status, // 'Pending' | 'Active' | 'Unstaked'
        estimatedReward: s.status === 'Active' ? (s.estimatedReward ?? '0') : '0',
      });
    }
  }
  return { rows, stakedMist: stakedMist.toString() };
}

/** PTB build client: the raw underlying client (gRPC or legacy JSON-RPC).
 *  Never `sui.client` (removed) — always through the provider abstraction. */
function buildClient() {
  return sui.provider.rawClient();
}

/** Legacy JSON-RPC reads (system state, validator APY, suix stakes).
 *  gRPC has no equivalent surface; the configured JSON-RPC URL stays the
 *  authoritative fallback for THESE reads only. Throws PROVIDER_UNAVAILABLE
 *  honestly when unreachable — never invented data. */
async function legacyReads() {
  const raw = buildClient();
  if (raw && typeof raw.getLatestSuiSystemState === 'function') return raw;
  const { SuiJsonRpcClient } = await import('@mysten/sui/jsonRpc');
  const { RPC_URL } = await import('./sui-provider.js');
  return new SuiJsonRpcClient({ url: RPC_URL });
}

/* ---------- native Sui staking PTB builders ---------- */

/** request_add_stake(Coin<SUI>, validator) against the shared SuiSystemState (0x6).
 *  The Coin<SUI> intent resolves against the wallet balance at build time and
 *  fails honestly with "Insufficient balance …" when the wallet cannot cover it. */
export async function nativeStakeTx(wallet, validator, mist) {
  const { Transaction } = await import('@mysten/sui/transactions');
  const txb = new Transaction();
  txb.setSender(wallet);
  const suiCoin = txb.coin({ type: SUI_TYPE, balance: mist });
  txb.moveCall({
    target: '0x2::sui_system::request_add_stake',
    arguments: [txb.object(SUI_SYSTEM_STATE), suiCoin, txb.pure.address(validator)],
  });
  const bytes = await txb.build({ client: buildClient() });
  return Buffer.from(bytes).toString('base64');
}

/** request_withdraw_stake(StakedSui) — withdraws principal AND accumulated
 *  rewards in one call. There is no separate claim on native Sui staking;
 *  routes must say so honestly instead of inventing a claim action. */
export async function nativeUnstakeTx(wallet, stakedSuiId) {
  const { Transaction } = await import('@mysten/sui/transactions');
  const txb = new Transaction();
  txb.setSender(wallet);
  txb.moveCall({
    target: '0x2::sui_system::request_withdraw_stake',
    arguments: [txb.object(SUI_SYSTEM_STATE), txb.object(stakedSuiId)],
  });
  const bytes = await txb.build({ client: buildClient() });
  return Buffer.from(bytes).toString('base64');
}

/* ---------- chain reads ---------- */

/** Active validators (name, commission, voting power, pool balance) + chain APYs. */
export async function getValidators() {
  const client = await legacyReads();
  const [state, apys] = await Promise.all([
    client.getLatestSuiSystemState(),
    client.getValidatorsApy().catch(() => null),
  ]);
  return {
    validators: normalizeValidators(state, apys),
    epoch: Number(state.epoch),
    epochDurationMs: Number(state.epochDurationMs),
    epochStartTimestampMs: Number(state.epochStartTimestampMs),
    referenceGasPrice: state.referenceGasPrice,
  };
}

/** Native delegated stakes for a wallet (via provider envelope, gRPC-safe). */
export async function getPositions(wallet) {
  const env = await sui.getStakes(wallet);
  const delegations = env.value;
  const { rows, stakedMist } = normalizeDelegations(delegations);
  return {
    delegations: rows,
    stakedMist,
    note: 'Native Sui staking: rewards accrue in each StakedSui object and are withdrawn together with principal (no separate claim transaction).',
  };
}

/** Compact epoch summary. */
export async function systemState() {
  const client = await legacyReads();
  const s = await client.getLatestSuiSystemState();
  return {
    epoch: Number(s.epoch),
    epochDurationMs: Number(s.epochDurationMs),
    epochStartTimestampMs: Number(s.epochStartTimestampMs),
    referenceGasPrice: s.referenceGasPrice,
    activeValidatorCount: s.activeValidators?.length ?? 0,
  };
}

/* ---------- Aftermath liquid staking (afSUI) ---------- */

let afApiPromise = null;
/** Lazy singleton for the Aftermath high-level API (async factory). Tx builders
 *  need it (they do gRPC coin selection against FULLNODE_GRPC_URL). */
export function aftermathApi() {
  if (!afApiPromise) {
    afApiPromise = Aftermath.create({
      network: NETWORK === 'testnet' ? 'TESTNET' : 'MAINNET',
      fullnodeUrl: FULLNODE_GRPC_URL,
    });
    // Allow a fresh bootstrap attempt if the first one failed.
    afApiPromise.catch(() => { afApiPromise = null; });
  }
  return afApiPromise;
}

/** afSUI liquid-stake PTB via the Aftermath SDK. Coin selection (gRPC balance
 *  read) happens inside the SDK; the returned Transaction is unsigned. */
export async function liquidStakeTx(wallet, validator, mist) {
  const af = await aftermathApi();
  const tx = await af.Staking().getStakeTransaction({
    walletAddress: wallet,
    suiStakeAmount: mist,
    validatorAddress: validator,
  });
  const bytes = await tx.build({ client: buildClient() });
  return Buffer.from(bytes).toString('base64');
}

/** afSUI liquid-unstake PTB. isAtomic=true → immediate swap back to SUI
 *  (can fail on-chain with "Insufficient Sui Reserves"); isAtomic=false →
 *  queued unstake request processed at the next epoch boundary. */
export async function liquidUnstakeTx(wallet, afSui, isAtomic) {
  const af = await aftermathApi();
  const tx = await af.Staking().getUnstakeTransaction({
    walletAddress: wallet,
    afSuiUnstakeAmount: afSui,
    isAtomic: Boolean(isAtomic),
  });
  const bytes = await tx.build({ client: buildClient() });
  return Buffer.from(bytes).toString('base64');
}

/** Aftermath staking positions (stakes + queued unstakes) for a wallet. */
export async function aftermathPositions(wallet) {
  const af = await aftermathApi();
  const positions = await af.Staking().getStakingPositions({ walletAddress: wallet, cursor: 0, limit: 100 });
  return Array.isArray(positions) ? positions : [];
}

/** Aftermath liquid-staking vault stats: TVL (MIST) + afSUI→SUI exchange rate. */
export async function liquidState() {
  const af = await aftermathApi();
  const [tvlMist, rate, vault] = await Promise.all([
    af.Staking().getSuiTvl(),
    af.Staking().getAfSuiToSuiExchangeRate(),
    af.Staking().getStakedSuiVaultState(),
  ]);
  return { tvlMist: String(tvlMist), afSuiToSuiRate: Number(rate), vaultState: vault };
}
