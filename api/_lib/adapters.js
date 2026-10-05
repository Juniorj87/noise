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
    DEEP: '0xdeeb7a4662eec9c6963f0cfaa815e05d736414b9d381233c00c0de098c74e::deep::DEEP',
    USDC: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    NAVX: '0xa99b8952d4f7d947ea77fe0ecdcc9e5fc9bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX',
  },
  testnet: {
    SUI: '0x2::sui::SUI',
    USDC: '0xa1ec7fc00a6f40db9693ad1415d880f9812549d9f497dbdac7ba39a37721074::usdc::USDC',
  },
};

const AF_BASE = process.env.AFTERMATH_API_URL || 'https://aftermath.finance';

export function coinType(sym, network = NETWORK) {
  const upper = (sym || '').toUpperCase();
  const t = (COIN_TYPES[network] || COIN_TYPES.mainnet)[upper];
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

export const cetusAdapter = {
  id: 'cetus',
  async getQuote({ from, to, amountMist }) {
    const router = await cetusClient.findRouters({
      from: coinType(from), target: coinType(to), amount: BigInt(amountMist), byAmountIn: true,
    });
    if (!router || router.insufficientLiquidity) {
      throw Object.assign(new Error('INSUFFICIENT_LIQUIDITY'), { code: 'INSUFFICIENT_LIQUIDITY' });
    }
    return {
      provider: 'Cetus', quoteId: router.quoteID ?? null,
      amountIn: String(router.amountIn ?? amountMist), amountOut: String(router.amountOut ?? 0),
      paths: (router.paths ?? []).length, protocolFee: 0, insufficientLiquidity: false,
      fetchedAt: new Date().toISOString(),
    };
  },
  async buildSwap({ from, to, amountMist, sender, slippage }) {
    const router = await cetusClient.findRouters({
      from: coinType(from), target: coinType(to), amount: BigInt(amountMist), byAmountIn: true,
    });
    if (!router || router.insufficientLiquidity) {
      throw Object.assign(new Error('INSUFFICIENT_LIQUIDITY'), { code: 'INSUFFICIENT_LIQUIDITY' });
    }
    const { Transaction } = await import('@mysten/sui/transactions');
    const txb = new Transaction();
    txb.setSender(sender);
    await cetusClient.fastRouterSwap({ router, txb, slippage: Number(slippage) });
    // Action Hub platform fee — collected ONLY as a real PTB leg, and only
    // when it is safe: SUI-funded input lets us split from the gas coin.
    // Otherwise the fee stays disabled and is reported as $0.00 (honest:
    // displayed fee === actual transaction).
    let feeCollected = null;
    try {
      const { getPlatformFee, validateFeeRecipient } = await import('./fee-engine.js');
      const fee = await getPlatformFee({ action: 'swap', provider: 'cetus', instrument: `${from}_${to}`, amount: amountMist, asset: from });
      if (fee?.enabled && fee.recipient && validateFeeRecipient(fee.recipient).valid && String(from).toUpperCase() === 'SUI') {
        const feeMist = (BigInt(amountMist) * BigInt(fee.bps)) / 10000n;
        if (feeMist > 0n) {
          const [feeCoin] = txb.splitCoins(txb.gas, [feeMist]);
          txb.transferObjects([feeCoin], fee.recipient);
          const { toHumanUnits, feeDisplay } = await import('./fee-engine.js');
          const human = toHumanUnits(String(feeMist), String(from).toUpperCase());
          feeCollected = { amountMist: String(feeMist), amountSui: human, display: feeDisplay(human, String(from).toUpperCase()), recipient: fee.recipient, bps: fee.bps };
        }
      }
    } catch (e) {
      console.error('[cetus] platform fee leg skipped:', String(e?.message || e).slice(0, 200));
    }
    // Preset gas price so txb.build skips a system-state round-trip.
    try {
      const gp = await sui.getReferenceGasPrice();
      if (gp?.value) txb.setGasPrice(BigInt(gp.value));
    } catch { /* build resolves it */ }
    const bytes = await txb.build({ client: sui.provider.rawClient() });
    return { router, txBytes: Buffer.from(bytes).toString('base64'), feeCollected };
  },
};

/** Honest capability split: Aftermath Router gives live DATA + QUOTE only;
 *  there is no build/simulate/execute path wired in Noise. */
export const aftermathAdapter = {
  id: 'aftermath',
  capabilities: { read: true, quote: true, build: false, simulate: false, execute: false, rewards: true },
  async getQuote({ from, to, amountMist }) {
    const q = await afPost('/api/router/trade-route', {
      coinInType: coinType(from), coinOutType: coinType(to), coinInAmount: String(amountMist),
    });
    const out = BigInt(q.coinOut?.amount?.replace?.('n', '') ?? q.coinOut?.amount ?? 0);
    return {
      provider: 'Aftermath Router', quoteId: null,
      amountIn: String(amountMist), amountOut: String(out),
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

export function compareRoutes(quotes, { platformFee = 0, gasEst = 0 } = {}) {
  const live = (quotes ?? []).filter((q) => q && !q.error && BigInt(q.amountOut ?? 0) > 0n);
  const ranked = live.map((q) => {
    const out = Number(q.amountOut);
    const effective = out - Number(q.protocolFee ?? 0) - Number(q.providerFee ?? 0) - platformFee - gasEst;
    return { ...q, effectiveOutput: effective };
  }).sort((a, b) => b.effectiveOutput - a.effectiveOutput);
  return { compared: live.length, best: ranked[0]?.provider ?? null, routes: ranked, at: new Date().toISOString() };
}

export function listProtocols() {
  return (async () => {
    const { getPool, ensureSchema } = await import('./pg.js');
    await ensureSchema();
    const r = await getPool().query('SELECT * FROM protocols WHERE enabled = 1 ORDER BY name');
    return r.rows.map((p) => ({ ...p, capabilities: JSON.parse(p.capabilities || '[]') }));
  })();
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
