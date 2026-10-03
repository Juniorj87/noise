// Pure DeepBook trading logic — shared by SQLite dev server and Vercel API.
// Integer/base-unit arithmetic only: prices are integers scaled by 1e9
// (DeepBook FLOAT_SCALAR), quantities integers in base-coin base units.
// No floating-point money math in validation or normalization.
export const FLOAT_SCALAR = 1_000_000_000; // price scale used by DeepBook contracts

/**
 * DeepBook order.status (on-chain u8) → user-facing status.
 * On-chain enum: LIVE = 0, FILLED = 1, CANCELED = 2, EXPIRED = 3.
 * PARTIALLY_FILLED is DERIVED: LIVE + filled_quantity > 0 (see resolveOrderStatus).
 * Transaction success ≠ order filled.
 */
export const DEEPBOOK_ORDER_STATUS = {
  0: 'OPEN',
  1: 'FILLED',
  2: 'CANCELLED',
  3: 'EXPIRED',
};
export function orderStatusFromChain(status) {
  return DEEPBOOK_ORDER_STATUS[Number(status)] || 'UNKNOWN';
}
/** Resolve final UI status from a raw on-chain order record. */
export function resolveOrderStatus(rawStatus, filledQuantity) {
  let status = orderStatusFromChain(rawStatus);
  if (status === 'OPEN' && Number(filledQuantity) > 0) status = 'PARTIALLY_FILLED';
  return status;
}
/** Order is still resting on the book. */
export function isOpenStatus(status) {
  return status === 'OPEN' || status === 'PARTIALLY_FILLED';
}

/**
 * Normalize a human price to an integer of tickSize units (integer math, BigInt).
 * Returns { ok, value (BigInt ticks), normalized (number), error }.
 * 1.23456 with tickSize 0.0001 → 12346 ticks → normalized 1.2346 (rounds to
 * nearest tick half-up using the FULL fractional input, never truncates silently).
 */
export function normalizePriceToTick(priceStr, tickSize) {
  const s = String(priceStr ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s) || !(Number(s) > 0)) {
    return { ok: false, error: 'INVALID_PRICE' };
  }
  const [intPart, frac = ''] = s.split('.');
  const tickDecimals = decimalsOfNumber(tickSize);
  const tickNum = Number(String(tickSize).replace('.', ''));
  if (!Number.isFinite(tickNum) || tickNum <= 0 || tickDecimals < 0) {
    return { ok: false, error: 'INVALID_TICK_SIZE' };
  }
  const scaled = BigInt(intPart + frac); // full precision, scale = frac.length
  const tickScaled = BigInt(tickNum);
  if (tickScaled === 0n) return { ok: false, error: 'INVALID_TICK_SIZE' };
  const diff = frac.length - tickDecimals;
  let ticks;
  if (diff <= 0) {
    ticks = BigInt(intPart + frac + '0'.repeat(-diff)); // exact, no rounding needed
  } else {
    // Round half-up on the dropped remainder: q + (2r >= divisor ? 1 : 0).
    const divisor = 10n ** BigInt(diff);
    const q = scaled / divisor;
    const r = scaled % divisor;
    ticks = q + (r * 2n >= divisor ? 1n : 0n);
  }
  if (ticks <= 0n) return { ok: false, error: 'INVALID_PRICE' };
  const normalized = Number(ticks * tickScaled) / 10 ** tickDecimals;
  return { ok: true, value: ticks, normalized };
}

/**
 * Normalize a human quantity to an integer of lotSize units (integer math, BigInt).
 * Truncates toward zero (never rounds a quantity up).
 */
export function normalizeQuantityToLot(qtyStr, lotSize) {
  const s = String(qtyStr ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s) || !(Number(s) > 0)) {
    return { ok: false, error: 'INVALID_QUANTITY' };
  }
  const [intPart, frac = ''] = s.split('.');
  const lotDecimals = decimalsOfNumber(lotSize);
  const lotNum = Number(String(lotSize).replace('.', ''));
  if (!Number.isFinite(lotNum) || lotNum <= 0 || lotDecimals < 0) {
    return { ok: false, error: 'INVALID_LOT_SIZE' };
  }
  const fracTrunc = (frac + '0'.repeat(lotDecimals)).slice(0, lotDecimals);
  const scaled = BigInt(intPart + fracTrunc); // truncated, never rounded up
  const lotScaled = BigInt(lotNum);
  if (lotScaled === 0n) return { ok: false, error: 'INVALID_LOT_SIZE' };
  const lots = scaled / lotScaled; // floor
  if (lots <= 0n) return { ok: false, error: 'QUANTITY_BELOW_LOT' };
  const normalized = Number(lots * lotScaled) / 10 ** lotDecimals;
  return { ok: true, value: lots, normalized };
}

function decimalsOfNumber(n) {
  const s = String(n);
  const i = s.indexOf('.');
  return i === -1 ? 0 : (s.length - i - 1);
}

/** price must be a multiple of tickSize (post-normalization always true); explicit check helper. */
export function isValidTick(priceNormalized, tickSize) {
  const r = normalizePriceToTick(priceNormalized, tickSize);
  return r.ok && Math.abs(r.normalized - Number(priceNormalized)) < 1e-12;
}
export function isValidLot(qtyNormalized, lotSize) {
  const r = normalizeQuantityToLot(qtyNormalized, lotSize);
  return r.ok && Math.abs(r.normalized - Number(qtyNormalized)) < 1e-12;
}

/**
 * Validate a limit order against pool params (tickSize, lotSize, minSize).
 * params: { tickSize, lotSize, minSize } — human units from poolBookParams.
 * Returns { ok } or { ok:false, error } with codes matching spec §18.
 */
export function validateLimitOrder({ price, quantity, tickSize, lotSize, minSize }) {
  const p = normalizePriceToTick(price, tickSize);
  if (!p.ok) return { ok: false, error: p.error === 'INVALID_PRICE' ? 'INVALID_PRICE' : 'INVALID_TICK_SIZE' };
  const q = normalizeQuantityToLot(quantity, lotSize);
  if (!q.ok) return { ok: false, error: q.error === 'INVALID_QUANTITY' ? 'INVALID_QUANTITY' : 'INVALID_LOT_SIZE' };
  if (!(Number(minSize) > 0)) return { ok: false, error: 'INVALID_MARKET_PARAMS' };
  if (q.normalized < Number(minSize)) return { ok: false, error: 'BELOW_MIN_ORDER_SIZE' };
  return {
    ok: true,
    price: p.normalized,
    quantity: q.normalized,
    priceTicks: p.value,
    quantityLots: q.value,
  };
}

/**
 * Validate a market order (quantity only; price comes from the book).
 * Returns { ok, quantity, quantityLots } or { ok:false, error }.
 */
export function validateMarketOrder({ quantity, lotSize, minSize }) {
  const q = normalizeQuantityToLot(quantity, lotSize);
  if (!q.ok) return { ok: false, error: q.error === 'INVALID_QUANTITY' ? 'INVALID_QUANTITY' : 'INVALID_LOT_SIZE' };
  if (!(Number(minSize) > 0)) return { ok: false, error: 'INVALID_MARKET_PARAMS' };
  if (q.normalized < Number(minSize)) return { ok: false, error: 'BELOW_MIN_ORDER_SIZE' };
  return { ok: true, quantity: q.normalized, quantityLots: q.value };
}

/** Estimated output + price impact from a real level-2 book (no invented numbers). */
export function estimateExecutionFromBook({ side, quantity, bids, asks, midPrice }) {
  const book = side === 'BUY' ? (asks || []) : (bids || []);
  if (!book.length || !(Number(quantity) > 0)) {
    return { ok: false, error: 'NO_BOOK_DATA' };
  }
  let remaining = Number(quantity);
  let proceeds = 0;
  let bestPrice = null;
  let consumed = 0;
  for (const [price, qty] of book) {
    const p = Number(price), q = Number(qty);
    if (!(p > 0) || !(q > 0)) continue;
    if (bestPrice === null) bestPrice = p;
    const take = Math.min(remaining, q);
    proceeds += take * p;
    consumed += take;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (consumed <= 0) return { ok: false, error: 'NO_BOOK_DATA' };
  const avgPrice = proceeds / consumed;
  const filledPct = (consumed / Number(quantity)) * 100;
  const impactPct = bestPrice > 0 && Number(midPrice) > 0
    ? ((avgPrice - (side === 'BUY' ? Number(midPrice) : Number(midPrice))) / Number(midPrice)) * 100
    : null;
  return {
    ok: true,
    filledQuantity: consumed,
    unfilledQuantity: Math.max(0, Number(quantity) - consumed),
    fullyFilled: remaining <= 0,
    bestPrice,
    avgPrice,
    estimatedOutput: proceeds,
    depthCoveragePct: filledPct,
    priceImpactPct: impactPct,
  };
}

/** Client order id: deterministic-ish unique u64-ish string (for clientOrderId param). */
export function makeClientOrderId() {
  return String((Date.now() % 4294967295) * 1000 + Math.floor(Math.random() * 1000));
}
