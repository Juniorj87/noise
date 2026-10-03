// DeepBook Predict adapter — official @mysten/deepbook-v3/predict SDK.
//
// Uses PredictClient (NOT DeepBookClient): read.markets/market/price/pricer/
// quoteMint/quoteMintCost/quoteRedeem/positions + tx.mint/mintAmount/redeem/
// claimSettled. Local math via cost.* is the fast preview layer; every build
// is preceded by a chain quote (read.quoteMint / read.quoteRedeem) because
// local cost cannot see chain state, backing, or paused flags.
//
// Market addressing: { underlying, expiryMs, side, strike } (MarketDescriptor).
// Mainnet underlyings come from getConfig('mainnet').underlyings — never
// hardcoded (today: BTC only).
//
// Referral note: Predict referral/builder revenue is a split of protocol
// proceeds, never an extra trader debit. Without a registered builder code the
// Action Hub platform fee leg is disabled and reported as $0.00 (honest:
// displayed fee === actual transaction).

import { PredictClient, getConfig, cost } from '@mysten/deepbook-v3/predict';
import { sui, NETWORK } from './adapters.js';

function predictClient() {
  return new PredictClient({ client: sui.provider.rawClient(), network: NETWORK });
}

function cfg() {
  return getConfig(NETWORK);
}

export function predictUnderlyings() {
  return Object.keys(cfg().underlyings || {});
}

export function predictConstants() {
  return {
    // raw USDC units (6 decimals): lot 0.01 USDC, min premium 1 USDC
    positionLotSize: String(cost.POSITION_LOT_SIZE ?? 10000n).replace('n', ''),
    minPremium: String(cost.MIN_PREMIUM ?? 1000000n).replace('n', ''),
    maxQuantityLots: String(cost.MAX_QUANTITY_LOTS ?? 4294967295n).replace('n', ''),
    quoteCoinType: cfg().quoteCoinType,
  };
}

export function marketStatus(expiryMs, mintPaused) {
  const ms = Number(expiryMs);
  if (Number.isFinite(ms) && ms <= Date.now()) return 'EXPIRED';
  if (mintPaused) return 'PAUSED';
  return 'ACTIVE';
}

/** Normalize bigint-containing SDK structs for JSON transport. */
function norm(o) {
  return JSON.parse(
    JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

export function toMarketDescriptor({ underlying, expiryMs, side = 'up', strike = 'reference', marketId, lower, upper }) {
  if (!underlying || expiryMs == null) {
    throw Object.assign(new Error('INVALID_MARKET'), {
      code: 'INVALID_MARKET',
      message: 'underlying and expiryMs are required',
    });
  }
  const known = predictUnderlyings();
  if (!known.includes(underlying)) {
    throw Object.assign(new Error('UNKNOWN_UNDERLYING'), {
      code: 'UNKNOWN_UNDERLYING',
      message: `Unknown underlying ${underlying}. Available: ${known.join(', ') || 'none'}`,
    });
  }
  const m = { underlying, expiryMs: BigInt(expiryMs) };
  if (marketId) m.marketId = marketId;
  if (side === 'range') {
    if (!Number.isFinite(Number(lower)) || !Number.isFinite(Number(upper))) {
      throw Object.assign(new Error('INVALID_RANGE'), { code: 'INVALID_RANGE', message: 'range needs numeric lower + upper' });
    }
    m.side = 'range';
    m.lower = Number(lower);
    m.upper = Number(upper);
  } else {
    if (side !== 'up' && side !== 'down') {
      throw Object.assign(new Error('INVALID_SIDE'), { code: 'INVALID_SIDE', message: "side must be 'up', 'down' or 'range'" });
    }
    m.side = side;
    m.strike = strike === 'reference' ? 'reference' : Number(strike);
    if (m.strike !== 'reference' && !Number.isFinite(m.strike)) {
      throw Object.assign(new Error('INVALID_STRIKE'), { code: 'INVALID_STRIKE', message: 'strike must be a number or "reference"' });
    }
  }
  return m;
}

/** Defense-in-depth: backend rejects unbuildable markets even when the
 *  frontend already blocks them. Never rely on chain-quote failure alone. */
export async function assertMarketBuildable({ underlying, expiryMs, marketId } = {}) {
  const expiry = Number(expiryMs);
  if (!underlying || !Number.isFinite(expiry)) {
    throw Object.assign(new Error('INVALID_MARKET'), { code: 'INVALID_MARKET', message: 'underlying and a numeric expiryMs are required' });
  }
  if (expiry <= Date.now()) {
    throw Object.assign(new Error('MARKET_EXPIRED'), { code: 'MARKET_EXPIRED', message: 'Market expired — minting is closed' });
  }
  try {
    const c = predictClient();
    const summary = await c.read.market({ underlying, expiryMs });
    if (summary) {
      if (summary.mintPaused) {
        throw Object.assign(new Error('MARKET_PAUSED'), { code: 'MARKET_PAUSED', message: 'Market paused — minting is halted' });
      }
      const sExp = Number(summary.expiryMs);
      if (Number.isFinite(sExp) && sExp <= Date.now()) {
        throw Object.assign(new Error('MARKET_EXPIRED'), { code: 'MARKET_EXPIRED', message: 'Market expired on-chain' });
      }
    }
  } catch (e) {
    if (e && (e.code === 'MARKET_EXPIRED' || e.code === 'MARKET_PAUSED' || e.code === 'INVALID_MARKET')) throw e;
    // Market-state read failed (provider hiccup) — do NOT invent tradability.
    // The subsequent chain quote is authoritative; surface unavailability.
    throw Object.assign(new Error('MARKET_UNAVAILABLE'), { code: 'MARKET_UNAVAILABLE', message: 'Market state unavailable — cannot verify tradability' });
  }
  void marketId;
}

export const deepbookPredictAdapter = {
  id: 'deepbook-predict',

  /** All active expiry markets with underlying attribution + status. */
  async getMarkets() {
    const c = predictClient();
    const underlyings = predictUnderlyings();
    let active;
    try {
      active = await c.read.markets();
    } catch (e) {
      console.error('[deepbook-predict] read.markets failed:', String(e?.message || e).slice(0, 300));
      throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'DeepBook Predict markets temporarily unavailable',
      });
    }
    // Attribute each market id to its underlying via deterministic resolution.
    const markets = [];
    for (const m of active || []) {
      let underlying = null;
      for (const u of underlyings) {
        try {
          const summary = await c.read.market({ underlying: u, expiryMs: m.expiryMs });
          if (summary && summary.id === m.id) {
            underlying = u;
            break;
          }
        } catch { /* try next underlying */ }
      }
      markets.push({
        id: m.id,
        underlying, // null if unattributable — UI shows the id, never a guessed asset
        expiryMs: String(m.expiryMs),
        expiryTimestamp: Number(m.expiryMs),
        status: marketStatus(m.expiryMs, m.mintPaused),
        marketState: m.mintPaused ? 'PAUSED' : 'OPEN',
        tickSize: m.tickSize,
        admissionTickSize: m.admissionTickSize,
        referencePrice: m.referencePrice,
        tradable: underlying != null && !m.mintPaused && Number(m.expiryMs) > Date.now(),
      });
    }
    return {
      underlyings,
      markets: norm(markets),
      constants: predictConstants(),
      source: 'DeepBook Predict SDK (PredictClient.read.markets)',
      sourceUrl: 'https://docs.sui.io/onchain-finance/deepbook',
      updatedAt: new Date().toISOString(),
    };
  },

  /** Single market summary + live UP/DOWN probability at the strike. */
  async getMarket({ underlying, expiryMs, side = 'up', strike = 'reference', marketId }) {
    const c = predictClient();
    const desc = toMarketDescriptor({ underlying, expiryMs, side: 'range' === side ? 'range' : side, strike, marketId });
    // keep side/strike only when relevant for price lookup below
    const base = marketId ? { underlying, expiryMs, marketId } : { underlying, expiryMs };
    let summary;
    try {
      summary = await c.read.market(base);
    } catch (e) {
      console.error('[deepbook-predict] read.market failed:', String(e?.message || e).slice(0, 300));
      throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE', message: 'Market state unavailable' });
    }
    if (!summary) return { market: null, note: 'No market for this underlying + expiry' };
    let probability = null;
    let probabilityError = null;
    try {
      const priceDesc = desc.side === 'range'
        ? { ...base, side: 'range', lower: desc.lower, upper: desc.upper }
        : { ...base, side: desc.side === 'down' ? 'down' : 'up', strike: desc.strike };
      probability = await c.read.price(priceDesc);
    } catch (e) {
      // reference price may not be seeded yet — honest unavailable, not zero
      probabilityError = String(e?.message || e).slice(0, 200);
    }
    const now = Date.now();
    const expiry = Number(summary.expiryMs);
    return {
      market: norm({
        ...summary,
        underlying,
        expiryTimestamp: expiry,
        timeToExpiryMs: Number.isFinite(expiry) ? Math.max(0, expiry - now) : null,
        status: marketStatus(summary.expiryMs, summary.mintPaused),
        tradable: !summary.mintPaused && Number.isFinite(expiry) && expiry > now,
        side: desc.side,
        strike: desc.strike ?? null,
      }),
      probability: probability ? norm(probability) : null,
      probabilityUnavailable: probability ? null : (probabilityError || 'Reference price not seeded yet'),
      source: 'DeepBook Predict SDK (read.market + read.price)',
      updatedAt: new Date().toISOString(),
    };
  },

  /** Local fast preview via official cost.* math (NOT a chain quote). */
  previewMintCost({ probabilities, quantity, expiryMs, nowMs }) {
    try {
      const q = cost.mintCost({
        probabilities,
        quantity,
        fees: cost.SHIPPED_FEE_POLICY,
        expiryMs: BigInt(expiryMs),
        nowMs: BigInt(nowMs ?? Date.now()),
      });
      return { preview: norm(q), exact: false, note: 'Local estimate only — confirm with chain quote before building.' };
    } catch (e) {
      return { error: String(e?.message || e).slice(0, 300), code: 'PREVIEW_FAILED' };
    }
  },

  /** Chain quote for mint — exact fee components from simulation events. */
  async quoteMint({ wallet, underlying, expiryMs, side = 'up', strike = 'reference', quantity, maxCost, maxProbability, marketId, lower, upper }) {
    const c = predictClient();
    const m = toMarketDescriptor({ underlying, expiryMs, side, strike, marketId, lower, upper });
    if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
      throw Object.assign(new Error('INVALID_QUANTITY'), { code: 'INVALID_QUANTITY', message: 'quantity (payout, USDC) must be > 0' });
    }
    try {
      const q = await c.read.quoteMint(wallet, m, {
        quantity: Number(quantity),
        maxCost: maxCost != null ? Number(maxCost) : undefined,
        maxProbability: maxProbability != null ? Number(maxProbability) : undefined,
      });
      const n = norm(q);
      return {
        quote: {
          premium: n.premium,
          entryProbability: n.entryProbability,
          quantity: n.quantity,
          totalCost: n.cost,
          tradingFee: n.fees?.tradingFee,
          subsidy: n.fees?.subsidy,
          builderFee: n.fees?.builderFee,
          penalty: n.fees?.penalty,
          inventoryImpact: n.fees?.inventoryImpact,
          feesExact: true,
        },
        market: { underlying, expiryMs: String(expiryMs), side: m.side, strike: m.strike ?? { lower: m.lower, upper: m.upper } },
        source: 'DeepBook Predict SDK (read.quoteMint — simulated, exact)',
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      console.error('[deepbook-predict] quoteMint failed:', String(e?.message || e).slice(0, 300));
      throw Object.assign(new Error('QUOTE_FAILED'), { code: 'QUOTE_FAILED', message: String(e?.message || e).slice(0, 300) });
    }
  },

  /** Chain quote for mint-by-budget (spend premium budget, floor quantity). */
  async quoteMintBudget({ wallet, underlying, expiryMs, side = 'up', strike = 'reference', spend, minQuantity, maxCost, marketId }) {
    const c = predictClient();
    const m = toMarketDescriptor({ underlying, expiryMs, side, strike, marketId });
    if (!Number.isFinite(Number(spend)) || Number(spend) <= 0) {
      throw Object.assign(new Error('INVALID_SPEND'), { code: 'INVALID_SPEND', message: 'spend (USDC budget) must be > 0' });
    }
    try {
      const q = await c.read.quoteMintCost(wallet, m, {
        spend: Number(spend),
        minQuantity: Number(minQuantity ?? 0),
        maxCost: maxCost != null ? Number(maxCost) : undefined,
      });
      const n = norm(q);
      return {
        quote: {
          premium: n.premium,
          entryProbability: n.entryProbability,
          quantity: n.quantity,
          totalCost: n.cost,
          tradingFee: n.fees?.tradingFee,
          subsidy: n.fees?.subsidy,
          builderFee: n.fees?.builderFee,
          penalty: n.fees?.penalty,
          inventoryImpact: n.fees?.inventoryImpact,
          feesExact: true,
        },
        market: { underlying, expiryMs: String(expiryMs), side: m.side, strike: m.strike },
        source: 'DeepBook Predict SDK (read.quoteMintCost — simulated, exact)',
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      console.error('[deepbook-predict] quoteMintCost failed:', String(e?.message || e).slice(0, 300));
      throw Object.assign(new Error('QUOTE_FAILED'), { code: 'QUOTE_FAILED', message: String(e?.message || e).slice(0, 300) });
    }
  },

  /** Build unsigned mint PTB (wallet signs). Requires a fresh chain quote first — caller passes it for comparison. */
  async buildMint({ wallet, underlying, expiryMs, side = 'up', strike = 'reference', quantity, maxCost, maxProbability, marketId, lower, upper }) {
    if (side !== 'up' && side !== 'down' && side !== 'range') {
      throw Object.assign(new Error('INVALID_SIDE'), { code: 'INVALID_SIDE', message: "side must be 'up', 'down' or 'range'" });
    }
    await assertMarketBuildable({ underlying, expiryMs, marketId });
    const c = predictClient();
    const m = toMarketDescriptor({ underlying, expiryMs, side, strike, marketId, lower, upper });
    // Fresh chain quote BEFORE build (local preview cannot see chain state).
    const quote = await this.quoteMint({ wallet, underlying, expiryMs, side, strike, quantity, maxCost, maxProbability, marketId, lower, upper });
    let tx;
    try {
      tx = await c.tx.mint(wallet, m, {
        quantity: Number(quantity),
        maxCost: maxCost != null ? Number(maxCost) : undefined,
        maxProbability: maxProbability != null ? Number(maxProbability) : undefined,
      });
    } catch (e) {
      console.error('[deepbook-predict] tx.mint failed:', String(e?.message || e).slice(0, 300));
      return { error: String(e?.message || e).slice(0, 300), code: 'BUILD_FAILED' };
    }
    try {
      tx.setSenderIfNotSet(wallet);
      const bytes = await tx.build({ client: sui.provider.rawClient() });
      return {
        txBytes: Buffer.from(bytes).toString('base64'),
        quote: quote.quote,
        market: quote.market,
        feeNote: 'Predict protocol fees are exact (simulated). Noise Hub platform fee: $0.00 (no builder code configured — referral/builder revenue only via official builder-code split when configured).',
        source: 'DeepBook Predict SDK (tx.mint)',
      };
    } catch (e) {
      console.error('[deepbook-predict] mint build failed:', String(e?.message || e).slice(0, 300));
      return { error: String(e?.message || e).slice(0, 300), code: 'BUILD_FAILED' };
    }
  },

  /** Build unsigned mint-by-budget PTB. */
  async buildMintBudget({ wallet, underlying, expiryMs, side = 'up', strike = 'reference', spend, minQuantity, maxCost, marketId }) {
    if (side !== 'up' && side !== 'down') {
      throw Object.assign(new Error('INVALID_SIDE'), { code: 'INVALID_SIDE', message: "side must be 'up' or 'down'" });
    }
    await assertMarketBuildable({ underlying, expiryMs, marketId });
    const c = predictClient();
    const m = toMarketDescriptor({ underlying, expiryMs, side, strike, marketId });
    const quote = await this.quoteMintBudget({ wallet, underlying, expiryMs, side, strike, spend, minQuantity, maxCost, marketId });
    let tx;
    try {
      tx = await c.tx.mintAmount(wallet, m, {
        spend: Number(spend),
        minQuantity: Number(minQuantity ?? 0),
        maxCost: maxCost != null ? Number(maxCost) : undefined,
      });
    } catch (e) {
      return { error: String(e?.message || e).slice(0, 300), code: 'BUILD_FAILED' };
    }
    try {
      tx.setSenderIfNotSet(wallet);
      const bytes = await tx.build({ client: sui.provider.rawClient() });
      return {
        txBytes: Buffer.from(bytes).toString('base64'),
        quote: quote.quote,
        market: quote.market,
        feeNote: 'Predict protocol fees are exact (simulated). Noise Hub platform fee: $0.00 (no builder code configured).',
        source: 'DeepBook Predict SDK (tx.mintAmount)',
      };
    } catch (e) {
      return { error: String(e?.message || e).slice(0, 300), code: 'BUILD_FAILED' };
    }
  },

  /** Chain quote for redeem (live position exit). */
  async quoteRedeem({ wallet, underlying, expiryMs, orderId, quantity, marketId }) {
    const c = predictClient();
    if (orderId == null || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
      throw Object.assign(new Error('INVALID_REDEEM'), { code: 'INVALID_REDEEM', message: 'orderId and quantity > 0 are required' });
    }
    const m = marketId ? { underlying, expiryMs: BigInt(expiryMs), marketId } : { underlying, expiryMs: BigInt(expiryMs) };
    try {
      const q = await c.read.quoteRedeem(wallet, m, { orderId: BigInt(orderId), quantity: Number(quantity) });
      const n = norm(q);
      return {
        quote: {
          grossProceeds: n.gross,
          netProceeds: n.proceeds,
          tradingFee: n.fees?.tradingFee,
          builderFee: n.fees?.builderFee,
          penalty: n.fees?.penalty,
          impactRebate: n.fees?.inventoryImpactRebate,
          quantityClosed: n.quantityClosed,
          remaining: n.remaining,
          feesExact: true,
        },
        source: 'DeepBook Predict SDK (read.quoteRedeem — simulated, exact)',
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      console.error('[deepbook-predict] quoteRedeem failed:', String(e?.message || e).slice(0, 300));
      throw Object.assign(new Error('QUOTE_FAILED'), { code: 'QUOTE_FAILED', message: String(e?.message || e).slice(0, 300) });
    }
  },

  /** Build unsigned redeem PTB. Redeem is the exit path: it stays allowed on
   *  paused markets (users must be able to leave), but never on an invalid
   *  market descriptor. */
  async buildRedeem({ wallet, underlying, expiryMs, orderId, quantity, marketId }) {
    if (!underlying || !Number.isFinite(Number(expiryMs))) {
      throw Object.assign(new Error('INVALID_MARKET'), { code: 'INVALID_MARKET', message: 'underlying and a numeric expiryMs are required' });
    }
    const c = predictClient();
    const quote = await this.quoteRedeem({ wallet, underlying, expiryMs, orderId, quantity, marketId });
    const m = marketId ? { underlying, expiryMs: BigInt(expiryMs), marketId } : { underlying, expiryMs: BigInt(expiryMs) };
    let tx;
    try {
      tx = await c.tx.redeem(wallet, m, { orderId: BigInt(orderId), quantity: Number(quantity) });
    } catch (e) {
      return { error: String(e?.message || e).slice(0, 300), code: 'BUILD_FAILED' };
    }
    try {
      tx.setSenderIfNotSet(wallet);
      const bytes = await tx.build({ client: sui.provider.rawClient() });
      return {
        txBytes: Buffer.from(bytes).toString('base64'),
        quote: quote.quote,
        source: 'DeepBook Predict SDK (tx.redeem)',
      };
    } catch (e) {
      return { error: String(e?.message || e).slice(0, 300), code: 'BUILD_FAILED' };
    }
  },

  /** Build unsigned claim-settled PTB (separate settlement path when the market settled). */
  async buildClaim({ wallet, underlying, expiryMs, orderId, marketId }) {
    const c = predictClient();
    if (orderId == null) return { error: 'orderId is required', code: 'INVALID_REQUEST' };
    const m = marketId ? { underlying, expiryMs: BigInt(expiryMs), marketId } : { underlying, expiryMs: BigInt(expiryMs) };
    let tx;
    try {
      tx = await c.tx.claimSettled(wallet, m, { orderId: BigInt(orderId) });
    } catch (e) {
      return { error: String(e?.message || e).slice(0, 300), code: 'BUILD_FAILED' };
    }
    try {
      tx.setSenderIfNotSet(wallet);
      const bytes = await tx.build({ client: sui.provider.rawClient() });
      return { txBytes: Buffer.from(bytes).toString('base64'), source: 'DeepBook Predict SDK (tx.claimSettled)' };
    } catch (e) {
      return { error: String(e?.message || e).slice(0, 300), code: 'BUILD_FAILED' };
    }
  },

  /** Live positions for an owner (empty array = no positions, never an error). */
  async getPositions(wallet) {
    const c = predictClient();
    try {
      const positions = await c.read.positions(wallet);
      return {
        positions: norm(positions || []).map((p) => ({
          orderId: p.orderId ?? p.order_id ?? null,
          marketId: p.marketId ?? p.market_id ?? null,
          underlying: p.underlying ?? null,
          expiryMs: p.expiryMs != null ? String(p.expiryMs) : null,
          side: p.side ?? null,
          strike: p.strike ?? null,
          quantity: p.quantity ?? null,
          entryCost: p.entryCost ?? p.entry_cost ?? null,
          entryProbability: p.entryProbability ?? null,
          status: p.status ?? 'OPEN',
        })),
        source: 'DeepBook Predict SDK (read.positions)',
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      console.error('[deepbook-predict] getPositions failed:', String(e?.message || e).slice(0, 300));
      throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE', message: 'Positions unavailable' });
    }
  },

  /** Predict account USDC balance (margin backing for mints). */
  async getBalance(wallet) {
    const c = predictClient();
    try {
      const bal = await c.read.balance(wallet);
      return { balance: norm(bal), asset: 'USDC', source: 'DeepBook Predict SDK (read.balance)', updatedAt: new Date().toISOString() };
    } catch (e) {
      throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE', message: 'Predict balance unavailable' });
    }
  },
};
