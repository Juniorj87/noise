import { rankRoutes } from '../../shared/route-ranking.js';
// Protocol adapter layer. Verified live 2026-09-30 / 2026-10-01.
// Cetus: REAL quotes via @cetusprotocol/aggregator-sdk V3.
// Aftermath: REAL quotes/prices/rewards via official REST + staking APY via SDK.
// DeepBook: REAL midPrice + L2 orderbook via @mysten/deepbook-v3.
// Sui native: REAL reads via @mysten/sui.
// NAVI/Suilend: BLOCKED (reasons in audit) — honest statuses, no fake calls.
import { AggregatorClient } from '@cetusprotocol/aggregator-sdk';
import { Aftermath } from 'aftermath-ts-sdk';
import { DeepBookClient, mainnetPools, testnetPools } from '@mysten/deepbook-v3';
import { db } from './db.js';
import { sui, NETWORK, getBalances, getStakes } from './sui.js';
import { normalizePool } from '../../shared/earn-normalize.js';

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

/** Standard freshness envelope (§30). */
export function envelope(value, source, sourceUrl, confidence = 'high') {
  const updatedAt = new Date().toISOString();
  return { value, source, sourceUrl, updatedAt, freshness: 'live', confidence };
}

export function coinType(sym, network = sui.network) {
  const upper = (sym || '').toUpperCase();
  const netTypes = COIN_TYPES[network] || COIN_TYPES.mainnet;
  const t = netTypes[upper];
  if (!t) {
    const err = new Error('UNSUPPORTED_ASSET');
    err.code = 'UNSUPPORTED_ASSET';
    throw err;
  }
  return t;
}

// Providers follow the single NETWORK source — no cross-network execution path.
const cetusClient = new AggregatorClient({ env: NETWORK === 'testnet' ? 1 : 0 });
const aftermath = new Aftermath(NETWORK === 'testnet' ? 'TESTNET' : 'MAINNET');

function deepBook() {
  return new DeepBookClient({
    client: sui.client,
    address: '0x0000000000000000000000000000000000000000000000000000000000000000',
    network: sui.network,
  });
}

export { cetusAdapter } from '../../api/_lib/adapters.js';

export const aftermathAdapter = {
  id: 'aftermath',
  // Honest split: live DATA + QUOTE only. No build/simulate/execute path is wired.
  capabilities: { read: true, quote: true, build: true, simulate: true, execute: true, rewards: true, referral: true },
  /** REAL quote — official Smart Order Router REST. */
  async buildSwap({from,to,amountMist,sender,slippage}) {
    const {aftermathSwapBuild} = await import('../../api/_lib/lending.js');
    return aftermathSwapBuild({wallet:sender,fromType:coinType(from),toType:coinType(to),amountMist,slippage});
  },
  async getQuote({ from, to, amountMist }) {
    const fromType = coinType(from);
    const toType = coinType(to);
    const q = await afPost('/api/router/trade-route', {
      coinInType: fromType, coinOutType: toType, coinInAmount: String(amountMist),
    });
    const out = BigInt(q.coinOut?.amount?.replace?.('n', '') ?? q.coinOut?.amount ?? 0);
    const best = (q.routes ?? []).map((r) => ({
      protocols: (r.paths ?? []).map((p) => p.protocolName),
      portion: r.portion,
      amountOut: r.coinOut?.amount,
      spotPrice: r.spotPrice,
    }));
    return {
      provider: 'Aftermath Router',
      quoteId: null,
      amountIn: String(amountMist),
      amountOut: String(out),
      spotPrice: q.spotPrice,
      netTradeFeePercentage: q.netTradeFeePercentage,
      routes: best,
      protocolFee: 0, // router charges no protocol fee (verified docs)
      insufficientLiquidity: !q.routes?.length,
      fetchedAt: new Date().toISOString(),
    };
  },
  /** REAL prices — official Prices REST. */
  async getPrices(coinTypes) {
    const m = await afPost('/api/prices', { coinTypes });
    return envelope(m, 'Aftermath Prices', 'https://docs.aftermath.finance/for-developers/api/rest-api/prices');
  },
  /** REAL staking APY — official SDK (decimal RATIO, never percent). */
  async getStakingApy() {
    const apy = await aftermath.Staking().getApy({});
    const env = envelope(apy, 'Aftermath Staking SDK', 'https://docs.aftermath.finance/liquid-staking-afsui/fees');
    return { ...env, kind: 'apy', unit: 'ratio', basis: 'provider' };
  },
  /** REAL claimable rewards. */
  async getClaimableRewards(wallet) {
    const r = await afPost('/api/rewards/claimable', { walletAddress: wallet });
    return envelope(r.rewards ?? r, 'Aftermath Rewards API', 'https://docs.aftermath.finance/for-developers/api/rest-api/auxiliary-endpoints');
  },
  /** REAL 24h price info (price + change %). */
  async getPriceInfo(coins) {
    const m = await afPost('/api/price-info', { coins });
    return envelope(m, 'Aftermath Prices', 'https://docs.aftermath.finance/for-developers/api/rest-api/prices');
  },
  /** REAL pool summaries: TVL + 24h volume/fees + APR. */
  async getPoolSummaries(limit = 12) {
    const all = await afPost('/api/pools/summary', { poolIds: null }, 25000);
    const updatedAt = new Date().toISOString();
    const rows = (Array.isArray(all) ? all : [])
      .map((s) => normalizePool({
        name: s.pool?.name, poolId: s.pool?.objectId,
        tvl: s.stats?.tvl, volume24h: s.stats?.volume,
        fees24h: s.stats?.fees, apr: s.stats?.apr,
        lpPrice: s.stats?.lpPrice,
      }, { source: 'Aftermath Pools', updatedAt }))
      .filter((p) => p.tvl !== null && p.tvl > 0)
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, limit);
    return envelope(rows, 'Aftermath Pools API', 'https://docs.aftermath.finance/for-developers/api/rest-api/pools');
  },
  /** REAL LP positions for a wallet. */
  async getOwnedLp(wallet) {
    const r = await afPost('/api/pools/owned-lp-coins', { walletAddress: wallet });
    return envelope(Array.isArray(r) ? r : [], 'Aftermath Pools API', 'https://docs.aftermath.finance/for-developers/api/rest-api/pools');
  },
  /** REAL verified-coin universe (cache heavily — ~MBs). */
  async getVerifiedCoins() {
    const r = await fetch(AF_BASE + '/api/coins/verified');
    if (!r.ok) throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE' });
    return r.json();
  },
};

export const deepbookAdapter = {
  id: 'deepbook',
  capabilities: { read: true, quote: true, build: false, simulate: true, execute: false, rewards: false, referral: false },
  pools() {
    const isTest = NETWORK === 'testnet';
    const poolMap = isTest ? (testnetPools ?? {}) : (mainnetPools ?? {});
    return Object.entries(poolMap).map(([name, p]) => ({
      name, address: p.address, base: p.baseCoin, quote: p.quoteCoin,
      source: isTest ? 'DeepBook SDK testnetPools' : 'DeepBook SDK mainnetPools',
    }));
  },
  /** REAL mid price. */
  async midPrice(pool) {
    const v = await deepBook().midPrice(pool);
    return envelope(Number(v), 'DeepBook SDK', 'https://docs.sui.io');
  },
  /** REAL L2 orderbook ticks. */
  async orderbook(pool, ticks = 5) {
    const b = await deepBook().getLevel2TicksFromMid(pool, ticks);
    return envelope(b, 'DeepBook SDK', 'https://docs.sui.io');
  },
};

export async function deepbookOpenOrders(wallet, pool) {
  const dbClient = new DeepBookClient({
    client: sui.client,
    address: wallet,
    network: sui.network,
  });
  const managers = await dbClient.getBalanceManagerIds(wallet).catch(() => []);
  const out = [];
  for (const m of managers || []) {
    const mid = typeof m === 'string' ? m : (m.id || m.address || m.objectId);
    if (!mid) continue;
    try {
      const orderIds = await dbClient.accountOpenOrders(pool, mid);
      for (const item of (Array.isArray(orderIds) ? orderIds : [])) {
        if (!item) continue;
        if (typeof item === 'object' && item.order_id && item.quantity != null) {
          const encoded = BigInt(item.order_id);
          const isBid = (encoded >> 127n) === 0n;
          const rem = item.remaining_quantity != null ? item.remaining_quantity : (Number(item.quantity) - Number(item.filled_quantity || 0));
          out.push({
            manager: mid, pool,
            orderId: String(item.order_id),
            side: item.side ?? (isBid ? 'bid' : 'ask'),
            price: item.price != null ? String(item.price) : null,
            quantity: String(item.quantity),
            remaining: String(rem),
            status: item.status ?? 'open',
            source: 'DeepBook SDK',
          });
        } else {
          const oid = typeof item === 'object' ? (item.id || item.orderId || item.order_id) : item;
          if (oid != null) {
            try {
              const o = await dbClient.getOrderNormalized(pool, oid).catch(() => null);
              if (o) {
                const encoded = BigInt(o.order_id);
                const isBid = (encoded >> 127n) === 0n;
                const rem = o.remaining_quantity != null ? o.remaining_quantity : (Number(o.quantity) - Number(o.filled_quantity || 0));
                out.push({
                  manager: mid, pool,
                  orderId: String(o.order_id),
                  side: o.side ?? (isBid ? 'bid' : 'ask'),
                  price: o.price != null ? String(o.price) : null,
                  quantity: String(o.quantity),
                  remaining: String(rem),
                  status: o.status ?? 'open',
                  source: 'DeepBook SDK',
                });
              } else {
                out.push({
                  manager: mid, pool,
                  orderId: String(oid),
                  side: 'open',
                  price: null,
                  quantity: null,
                  remaining: null,
                  status: 'open',
                  source: 'DeepBook SDK',
                });
              }
            } catch {
              out.push({
                manager: mid, pool,
                orderId: String(oid),
                side: 'open',
                price: null,
                quantity: null,
                remaining: null,
                status: 'open',
                source: 'DeepBook SDK',
              });
            }
          }
        }
      }
    } catch { /* per-manager failure must not kill the list */ }
  }
  return envelope(out, 'DeepBook SDK', 'https://docs.sui.io');
}

export const suiAdapter = {
  id: 'sui-native',
  capabilities: { read: true, quote: false, build: true, simulate: true, execute: true, rewards: true, referral: false },
  /** REAL reads. No double counting: stakes are positions, not wallet coins. */
  async getCapital(wallet) {
    const [balances, stakes] = await Promise.all([getBalances(wallet), getStakes(wallet)]);
    const stakedMist = (stakes ?? []).reduce(
      (a, s) => a + (s.stakes ?? []).reduce((x, y) => x + Number(y.principal || 0), 0),
      0,
    );
    return {
      wallet,
      network: NETWORK,
      coins: balances ?? [],
      stakes: stakes ?? [],
      stakedMist,
      fetchedAt: new Date().toISOString(),
    };
  },
  /** REAL transaction status — never assume success. */
  async getTransactionStatus(digest) {
    const tx = await sui.client.getTransactionBlock({ digest, options: { showEffects: true, showBalanceChanges: true } });
    const status = tx.effects?.status?.status === 'success' ? 'confirmed' : 'failed';
    const failureReason = tx.effects?.status?.error || null;
    const gu = tx.effects?.gasUsed;
    const gas = gu ? String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0))) : null;
    let actualOutput = null;
    if (Array.isArray(tx.balanceChanges)) {
      const pos = tx.balanceChanges.filter((bc) => Number(bc.amount) > 0);
      if (pos.length > 0) actualOutput = pos.map((p) => `${p.amount} (${p.coinType})`).join(', ');
    }
    return {
      digest,
      status,
      checkpoint: tx.checkpoint ?? null,
      timestamp: tx.timestampMs ?? null,
      failureReason,
      gas,
      actualOutput,
    };
  },
};

/**
 * Unified route comparison (§8). Ranks by effective output:
 * quotedOut − protocolFee − providerFee − platformFee − gasEst,
 * penalized by missing data. 'Best execution' only when ≥1 live quote compared.
 */
export function compareRoutes(quotes, options = {}) { return rankRoutes(quotes, options); }

export async function listProtocols() { const {publicProtocols}=await import('../../shared/registry.js'); return publicProtocols().map(p=>({...p,capabilities:p.actions,enabled:1})); }

/** Deep-link fallback: never fake execution. */
export function deepLink(providerId, ctx = {}) {
  const p = db.prepare('SELECT * FROM protocols WHERE id = ?').get(providerId);
  if (!p) return null;
  return {
    provider: p.name,
    url: p.website,
    leavesHub: true,
    context: ctx,
    note: 'Execution leaves NOISE HUB — provider integration is ' + p.status,
  };
}
