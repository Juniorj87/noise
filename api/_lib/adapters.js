import { ASSET_BY_SYMBOL } from '../../shared/assets.js';
import { venueConfig, assertVenueRouter } from '../../shared/routed-venues.js';
import { swapFeeInput } from './fee-engine.js';
import { rankRoutes } from '../../shared/route-ranking.js';
// Protocol adapters for API mode — same SDK usage as server/src/adapters.js,
// module-level singletons (safe: stateless clients, network from env only).
import { AggregatorClient } from '@cetusprotocol/aggregator-sdk';
import { Aftermath } from 'aftermath-ts-sdk';
import { SuiDataProvider, NETWORK } from './sui-provider.js';
import { normalizePool } from '../../shared/earn-normalize.js';

export { NETWORK };

// Use SuiDataProvider for all Sui data access (gRPC primary, JSON-RPC fallback)
export const sui = {
  network: NETWORK,
  provider: SuiDataProvider,
  getClientInfo: () => SuiDataProvider.getClientInfo(),
  // Convenience methods that delegate to provider
  getBalance: (owner, coinType) => SuiDataProvider.getBalance(owner, coinType),
  getBalances: (owner) => SuiDataProvider.getBalances(owner),
  getObjects: (owner, options) => SuiDataProvider.getObjects(owner, options),
  getStakes: (owner) => SuiDataProvider.getStakes(owner),
  getTransaction: (digest, options) => SuiDataProvider.getTransaction(digest, options),
  getTransactions: (filter, cursor, limit) => SuiDataProvider.getTransactions(filter, cursor, limit),
  getEvents: (query, cursor, limit) => SuiDataProvider.getEvents(query, cursor, limit),
  getCoinMetadata: (coinType) => SuiDataProvider.getCoinMetadata(coinType),
  getDynamicFields: (objectId, cursor, limit) => SuiDataProvider.getDynamicFields(objectId, cursor, limit),
  simulateTransaction: (txBlock, sender) => SuiDataProvider.simulateTransaction(txBlock, sender),
  getReferenceGasPrice: () => SuiDataProvider.getReferenceGasPrice(),
};

const COIN_TYPES = {
  mainnet: {
    SUI: '0x2::sui::SUI',
    CETUS: '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS',
    DEEP: '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
    USDC: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    NAVX: '0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX',
  },
  testnet: {
    SUI: '0x2::sui::SUI',
    USDC: '0xa1ec7fc00a6f40db9693ad1415d880f9812549d9f497dbdac7ba39a37721074::usdc::USDC',
  },
};

const AF_BASE = process.env.AFTERMATH_API_URL || 'https://aftermath.finance';

export function coinType(sym, network = NETWORK) {
  const upper = (sym || '').toUpperCase();
  const t = network==='mainnet' ? ASSET_BY_SYMBOL[upper]?.coinType : (COIN_TYPES[network] || {})[upper];
  if (!t) throw Object.assign(new Error('UNSUPPORTED_ASSET'), { code: 'UNSUPPORTED_ASSET' });
  return t;
}

const cetusClient = new AggregatorClient({ env: NETWORK === 'testnet' ? 1 : 0 });
const aftermath = new Aftermath(NETWORK === 'testnet' ? 'TESTNET' : 'MAINNET');

async function afPost(path, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(AF_BASE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!r.ok) {
      const err = new Error('AF_' + r.status);
      err.code = r.status === 400 ? 'INVALID_REQUEST' : 'PROVIDER_UNAVAILABLE';
      throw err;
    }
    return r.json();
  } finally { clearTimeout(t); }
}

export function envelope(value, source, sourceUrl, confidence = 'high') {
  return { value, source, sourceUrl, updatedAt: new Date().toISOString(), freshness: 'live', confidence };
}

/* Aggregator route lookup with ONE retry on transient failures only.
 * findRouters is a pure read, so retrying is safe; deterministic outcomes
 * (insufficient liquidity, invalid/unsupported input, venue substitution)
 * are never retried. */
const TRANSIENT_ROUTE = /timeout|timed out|econn|enotfound|eai_again|socket|fetch failed|network|429|502|503|504|unavailable|abort|rate.limit/i;
export async function findRoutersResilient(args) {
  try {
    return await cetusClient.findRouters(args);
  } catch (e) {
    const code = String(e?.code || '');
    if (/INSUFFICIENT_LIQUIDITY|INVALID_|UNSUPPORTED_|NO_ROUTE/.test(code)) throw e;
    if (!TRANSIENT_ROUTE.test(String(e?.message || '') + ' ' + code)) throw e;
    await new Promise((r) => setTimeout(r, 500));
    return cetusClient.findRouters(args);
  }
}

export const cetusAdapter = {
  id: 'cetus',
  async getQuote({ from, to, amountMist, venue }) {
    const venueCfg = venueConfig(venue);
    const { net, fee } = await swapFeeInput(amountMist, venue || 'cetus', from, `${from}_${to}`);
    const router = await findRoutersResilient({
      from: coinType(from), target: coinType(to), amount: net, byAmountIn: true,
      ...(venueCfg ? { providers: venueCfg.providers } : {}),
    });
    assertVenueRouter(router, venueCfg);
    if (!router || router.insufficientLiquidity) {
      throw Object.assign(new Error('INSUFFICIENT_LIQUIDITY'), { code: 'INSUFFICIENT_LIQUIDITY' });
    }
    return {
      provider: venueCfg?.name || 'Cetus', venue: venue || 'cetus', quoteId: router.quoteID ?? null,
      amountIn: String(amountMist), routeAmountIn: String(net), feeCollected: fee, amountOut: String(router.amountOut ?? 0),
      paths: (router.paths ?? []).length, protocolFee: 0, insufficientLiquidity: false,
      fetchedAt: new Date().toISOString(),
    };
  },
  async buildSwap({ from, to, amountMist, sender, slippage, venue }) {
    const venueCfg = venueConfig(venue);
    const { net, fee } = await swapFeeInput(amountMist, venue || 'cetus', from, `${from}_${to}`);
    const router = await findRoutersResilient({
      from: coinType(from), target: coinType(to), amount: net, byAmountIn: true,
      ...(venueCfg ? { providers: venueCfg.providers } : {}),
    });
    assertVenueRouter(router, venueCfg);
    if (!router || router.insufficientLiquidity) {
      throw Object.assign(new Error('INSUFFICIENT_LIQUIDITY'), { code: 'INSUFFICIENT_LIQUIDITY' });
    }
    const { Transaction } = await import('@mysten/sui/transactions');
    const txb = new Transaction();
    txb.setSender(sender);
    // Obtain the gross input ONCE. Fee is carved from it, not debited on top.
    const { naviCoinInput, toBytes64 } = await import('./lending.js');
    const inputCoin = await naviCoinInput(txb, sender, coinType(from), amountMist);
    if (fee) {
      const [feeCoin] = txb.splitCoins(inputCoin, [txb.pure.u64(BigInt(fee.amountMist))]);
      txb.transferObjects([feeCoin], txb.pure.address(fee.recipient));
    }
    const outputCoin = await cetusClient.routerSwap({ router, inputCoin, txb, slippage: Number(slippage) });
    txb.transferObjects([outputCoin], txb.pure.address(sender));
    const feeCollected = fee;
    // Preset gas price so txb.build skips a system-state round-trip.
    try {
      const gp = await sui.getReferenceGasPrice();
      if (gp?.value) txb.setGasPrice(BigInt(gp.value));
    } catch { /* build resolves it */ }
    const bytes = Buffer.from(await toBytes64(txb, sender, String(from).toUpperCase() === 'SUI' ? amountMist : 0n), 'base64');
    return { router, provider: venueCfg?.name || 'Cetus', venue: venue || 'cetus', txBytes: Buffer.from(bytes).toString('base64'), feeCollected };
  },
};

/** Honest capability split: Aftermath Router gives live DATA + QUOTE only;
 *  there is no build/simulate/execute path wired in Noise. */
export const aftermathAdapter = {
  id: 'aftermath',
  capabilities: { read: true, quote: true, build: true, simulate: true, execute: true, rewards: true },
  async buildSwap({from,to,amountMist,sender,slippage}) {
    const {aftermathSwapBuild} = await import('./lending.js');
    return aftermathSwapBuild({wallet:sender,fromType:coinType(from),toType:coinType(to),amountMist,slippage});
  },
  async getQuote({ from, to, amountMist }) {
    const { net, fee } = await swapFeeInput(amountMist, 'aftermath', from, `${from}_${to}`);
    const q = await afPost('/api/router/trade-route', {
      coinInType: coinType(from), coinOutType: coinType(to), coinInAmount: String(net),
    });
    const out = BigInt(q.coinOut?.amount?.replace?.('n', '') ?? q.coinOut?.amount ?? 0);
    return {
      provider: 'Aftermath Router', quoteId: null,
      amountIn: String(amountMist), routeAmountIn: String(net), feeCollected: fee, amountOut: String(out),
      spotPrice: q.spotPrice, netTradeFeePercentage: q.netTradeFeePercentage,
      routes: (q.routes ?? []).map((r) => ({
        protocols: (r.paths ?? []).map((p) => p.protocolName), portion: r.portion,
        amountOut: r.coinOut?.amount, spotPrice: r.spotPrice,
      })),
      protocolFee: 0, insufficientLiquidity: !q.routes?.length,
      fetchedAt: new Date().toISOString(),
    };
  },
  async getPrices(types) {
    return envelope(await afPost('/api/prices', { coinTypes: types }), 'Aftermath Prices', 'https://docs.aftermath.finance/for-developers/api/rest-api/prices');
  },
  async getPriceInfo(coins) {
    return envelope(await afPost('/api/price-info', { coins }), 'Aftermath Prices', 'https://docs.aftermath.finance/for-developers/api/rest-api/prices');
  },
  async getStakingApy() {
    // Aftermath SDK returns a decimal RATIO (0.0143 = 1.43% APY) — never a
    // percent. Unit metadata travels with the value so no caller can confuse
    // ratio with percent or APY with APR.
    const env = await envelope(await aftermath.Staking().getApy({}), 'Aftermath Staking SDK', 'https://docs.aftermath.finance/liquid-staking-afsui/fees');
    return { ...env, kind: 'apy', unit: 'ratio', basis: 'provider' };
  },
  async getClaimableRewards(wallet) {
    const r = await afPost('/api/rewards/claimable', { walletAddress: wallet });
    return envelope(r.rewards ?? r, 'Aftermath Rewards API', 'https://docs.aftermath.finance/for-developers/api/rest-api/auxiliary-endpoints');
  },
  async getPoolSummaries(limit = 12) {
    const all = await afPost('/api/pools/summary', { poolIds: null }, 25000);
    const updatedAt = new Date().toISOString();
    const rows = (Array.isArray(all) ? all : [])
      .map((s) => normalizePool({
        name: s.pool?.name, poolId: s.pool?.objectId,
        tvl: s.stats?.tvl, volume24h: s.stats?.volume,
        fees24h: s.stats?.fees, apr: s.stats?.apr, lpPrice: s.stats?.lpPrice,
      }, { source: 'Aftermath Pools', updatedAt }))
      .filter((p) => p.tvl !== null && p.tvl > 0)
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, limit);
    return envelope(rows, 'Aftermath Pools API', 'https://docs.aftermath.finance/for-developers/api/rest-api/pools');
  },
  async getOwnedLp(wallet) {
    const r = await afPost('/api/pools/owned-lp-coins', { walletAddress: wallet });
    return envelope(Array.isArray(r) ? r : [], 'Aftermath Pools API', 'https://docs.aftermath.finance/for-developers/api/rest-api/pools');
  },
};

// DeepBook spot execution lives in ./deepbook.js (canonical adapter with
// balance-manager flow, validation and tx builders). The read-only helpers
// below are kept for quote/compare call sites; open orders resolve through
// ./deepbook.js so there is exactly one execution path.
export { deepbookAdapter } from './deepbook.js';

export async function deepbookOpenOrders(wallet, pool) {
  const { deepbookAdapter } = await import('./deepbook.js');
  const pools = pool ? [pool] : undefined;
  const out = [];
  for (const p of pools || []) {
    const rows = await deepbookAdapter.getOpenOrders(wallet, p).catch(() => []);
    out.push(...rows);
  }
  if (!pool) {
    const rows = await deepbookAdapter.getOpenOrders(wallet).catch(() => []);
    out.push(...rows);
  }
  return envelope(out, 'DeepBook SDK', 'https://docs.sui.io');
}

export const suiAdapter = {
  id: 'sui-native',
  async getCapital(wallet) {
    const [balancesEnv, stakesEnv] = await Promise.all([
      sui.getBalances(wallet),
      sui.getStakes(wallet),
    ]);
    const balances = balancesEnv.value;
    const stakes = stakesEnv.value;
    const stakedMist = (stakes ?? []).reduce((a, s) => a + (s.stakes ?? []).reduce((x, y) => x + Number(y.principal || 0), 0), 0);
    // Return direct data without envelope for backward compatibility with cached layer
    return { wallet, network: NETWORK, coins: balances ?? [], stakes: stakes ?? [], stakedMist, fetchedAt: new Date().toISOString() };
  },
  async getTransactionStatus(digest) {
    const txEnv = await sui.getTransaction(digest);
    const tx = txEnv.value;
    const status = tx.effects?.status?.status === 'success' ? 'confirmed' : 'failed';
    const gu = tx.effects?.gasUsed;
    const gas = gu ? String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0))) : null;
    let actualOutput = null;
    if (Array.isArray(tx.balanceChanges)) {
      const pos = tx.balanceChanges.filter((bc) => Number(bc.amount) > 0);
      if (pos.length > 0) actualOutput = pos.map((p) => `${p.amount} (${p.coinType})`).join(', ');
    }
    return { digest, status, checkpoint: tx.checkpoint ?? null, timestamp: tx.timestampMs ?? null,
      failureReason: tx.effects?.status?.error || null, gas, actualOutput };
  },
};

/** Simulation via SuiDataProvider (gRPC primary, JSON-RPC legacy).
 *  Accepts base64 tx bytes + sender; returns a devInspect-compatible result
 *  on both transports (see sui-provider.js normalization). */
export async function simulate(txBytes, sender) {
  const result = await sui.provider.simulateTransaction(String(txBytes), sender);
  return result.value;
}

export function compareRoutes(quotes, options = {}) { return rankRoutes(quotes, options); }

export async function listProtocols() {
  const {publicProtocols}=await import('../../shared/registry.js');
  return publicProtocols().map(p=>({...p,capabilities:p.actions,enabled:1}));
}

export function deepLink(providerId, ctx = {}) {
  return (async () => {
    const { getPool, ensureSchema } = await import('./pg.js');
    await ensureSchema();
    const p = (await getPool().query('SELECT * FROM protocols WHERE id = $1', [providerId])).rows[0];
    if (!p) return null;
    return { provider: p.name, url: p.website, leavesHub: true, context: ctx, note: 'Execution leaves NOISE HUB — provider integration is ' + p.status };
  })();
}

/** Swap inside a larger PTB. No output transfer: the caller consumes the Coin. */
export async function cetusSwapCoin({txb,inputCoin,fromType,toType,amountMist,fromSymbol,toSymbol,slippageBps}){
  if(!Number.isInteger(slippageBps)||slippageBps<1||slippageBps>300)throw Object.assign(new Error('INVALID_SLIPPAGE'),{code:'INVALID_SLIPPAGE'});
  const{net,fee}=await swapFeeInput(amountMist,'cetus',fromSymbol,`${fromSymbol}_${toSymbol}`);
  const router=await findRoutersResilient({from:fromType,target:toType,amount:net,byAmountIn:true});
  if(!router||router.insufficientLiquidity||!router.paths?.length||BigInt(router.amountOut||0)<=0n)throw Object.assign(new Error('No executable DEX route for this asset and amount'),{code:'NO_ROUTE'});
  if(fee){const[f]=txb.splitCoins(inputCoin,[txb.pure.u64(BigInt(fee.amountMist))]);txb.transferObjects([f],txb.pure.address(fee.recipient));}
  const outputCoin=await cetusClient.routerSwap({router,inputCoin,txb,slippage:slippageBps/10000});
  return{outputCoin,quote:{provider:'Cetus Aggregator',quoteId:router.quoteID||null,amountIn:String(amountMist),routeAmountIn:String(net),expectedOutput:String(router.amountOut),minOutput:String(BigInt(router.amountOut)*BigInt(10000-slippageBps)/10000n),feeCollected:fee,routeProviders:[...new Set(router.paths.flatMap(p=>(p.path||p.paths||[p]).map(x=>x.provider)).filter(Boolean))]}};
}
