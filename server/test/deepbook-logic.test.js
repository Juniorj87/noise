// Unit tests — pure DeepBook logic (shared/deepbook-logic.js): status mapping,
// integer-math tick/lot normalization, validation, book-based execution estimate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOAT_SCALAR, DEEPBOOK_ORDER_STATUS, orderStatusFromChain, resolveOrderStatus, isOpenStatus,
  normalizePriceToTick, normalizeQuantityToLot, isValidTick, isValidLot,
  validateLimitOrder, validateMarketOrder, estimateExecutionFromBook, makeClientOrderId,
} from '../../shared/deepbook-logic.js';

/* ---------- status mapping (on-chain enum LIVE=0, FILLED=1, CANCELED=2, EXPIRED=3) ---------- */

test('order status: raw enum maps 0..3, unknown stays UNKNOWN', () => {
  assert.equal(orderStatusFromChain(0), 'OPEN');
  assert.equal(orderStatusFromChain(1), 'FILLED');
  assert.equal(orderStatusFromChain(2), 'CANCELLED');
  assert.equal(orderStatusFromChain(3), 'EXPIRED');
  assert.equal(orderStatusFromChain(7), 'UNKNOWN');
  assert.deepEqual(Object.keys(DEEPBOOK_ORDER_STATUS).map(Number).sort(), [0, 1, 2, 3]);
});

test('PARTIALLY_FILLED is derived: LIVE(0) + filled>0, never a raw enum value', () => {
  assert.equal(resolveOrderStatus(0, 0), 'OPEN');
  assert.equal(resolveOrderStatus(0, '5'), 'PARTIALLY_FILLED');
  assert.equal(resolveOrderStatus(1, 5), 'FILLED');
  assert.equal(resolveOrderStatus(2, 0), 'CANCELLED');
  assert.equal(resolveOrderStatus(3, 0), 'EXPIRED');
});

test('isOpenStatus: only resting orders (OPEN, PARTIALLY_FILLED)', () => {
  assert.equal(isOpenStatus('OPEN'), true);
  assert.equal(isOpenStatus('PARTIALLY_FILLED'), true);
  assert.equal(isOpenStatus('FILLED'), false);
  assert.equal(isOpenStatus('CANCELLED'), false);
  assert.equal(isOpenStatus('EXPIRED'), false);
  assert.equal(isOpenStatus('UNKNOWN'), false);
});

/* ---------- price normalization to tick (integer math, half-up) ---------- */

test('price normalized to tick: 1.23456 @ tick 0.0001 → 12346 ticks → 1.2346 (half-up)', () => {
  const r = normalizePriceToTick('1.23456', 0.0001);
  assert.equal(r.ok, true);
  assert.equal(r.value, 12346n);
  assert.equal(r.normalized, 1.2346);
});

test('price already on tick stays unchanged', () => {
  const r = normalizePriceToTick('1.2345', 0.0001);
  assert.equal(r.ok, true);
  assert.equal(r.value, 12345n);
  assert.equal(r.normalized, 1.2345);
});

test('price off-tick fails explicit tick check', () => {
  assert.equal(isValidTick(1.23456, 0.0001), false);
  assert.equal(isValidTick(1.2345, 0.0001), true);
});

test('bad price inputs rejected', () => {
  assert.equal(normalizePriceToTick('abc', 0.0001).ok, false);
  assert.equal(normalizePriceToTick('-1', 0.0001).error, 'INVALID_PRICE');
  assert.equal(normalizePriceToTick('0', 0.0001).error, 'INVALID_PRICE');
  assert.equal(normalizePriceToTick('1.5', 0).error, 'INVALID_TICK_SIZE');
  assert.equal(normalizePriceToTick(null, 0.0001).error, 'INVALID_PRICE');
});

test('comma decimal separator accepted', () => {
  const r = normalizePriceToTick('1,2345', 0.0001);
  assert.equal(r.ok, true);
  assert.equal(r.normalized, 1.2345);
});

test('high precision never silently invented: >1e9 rounding stays integer-safe', () => {
  const r = normalizePriceToTick('0.0000050001', 0.00001);
  assert.equal(r.ok, true);
  assert.equal(r.value, 1n); // rounds to nearest tick, half-up
  assert.equal(r.normalized, 0.00001);
});

/* ---------- quantity normalization to lot (integer math, truncation) ---------- */

test('quantity truncated to lot: 10.999 @ lot 0.1 → 109 lots → 10.9 (never rounds up)', () => {
  const r = normalizeQuantityToLot('10.999', 0.1);
  assert.equal(r.ok, true);
  assert.equal(r.value, 109n);
  assert.equal(r.normalized, 10.9);
});

test('quantity below one lot rejected', () => {
  const r = normalizeQuantityToLot('0.05', 0.1);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'QUANTITY_BELOW_LOT');
});

test('bad quantity inputs rejected', () => {
  assert.equal(normalizeQuantityToLot('x', 0.1).error, 'INVALID_QUANTITY');
  assert.equal(normalizeQuantityToLot('5', 0).error, 'INVALID_LOT_SIZE');
  assert.equal(normalizeQuantityToLot('', 0.1).error, 'INVALID_QUANTITY');
});

test('isValidLot passes only on-lot quantities', () => {
  assert.equal(isValidLot(10.9, 0.1), true);
  assert.equal(isValidLot(10.999, 0.1), false);
});

/* ---------- order validation against real pool params ---------- */

test('limit order: valid order returns normalized price/qty with integer tick/lot values', () => {
  const r = validateLimitOrder({ price: '1.23456', quantity: '150', tickSize: 0.00001, lotSize: 0.1, minSize: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.price, 1.23456);
  assert.equal(r.quantity, 150);
  assert.equal(r.priceTicks, 123456n);
  assert.equal(r.quantityLots, 1500n);
});

test('limit order: below min order size rejected with honest code', () => {
  const r = validateLimitOrder({ price: '1.2', quantity: '0.5', tickSize: 0.00001, lotSize: 0.1, minSize: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BELOW_MIN_ORDER_SIZE');
});

test('limit order: garbage price maps to INVALID_PRICE not a crash', () => {
  const r = validateLimitOrder({ price: 'oops', quantity: '150', tickSize: 0.00001, lotSize: 0.1, minSize: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'INVALID_PRICE');
});

test('limit order: invalid market params (minSize=0) rejected', () => {
  const r = validateLimitOrder({ price: '1.2', quantity: '150', tickSize: 0.00001, lotSize: 0.1, minSize: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'INVALID_MARKET_PARAMS');
});

test('market order: valid quantity normalized to lots', () => {
  const r = validateMarketOrder({ quantity: '12.34', lotSize: 0.1, minSize: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.quantity, 12.3);
  assert.equal(r.quantityLots, 123n);
});

test('market order: below min size rejected', () => {
  const r = validateMarketOrder({ quantity: '0.9', lotSize: 0.1, minSize: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BELOW_MIN_ORDER_SIZE');
});

/* ---------- book-based execution estimate (no invented numbers) ---------- */

test('market BUY estimate walks real asks in order', () => {
  const est = estimateExecutionFromBook({
    side: 'BUY', quantity: 15,
    bids: [[1.15, 100]], asks: [[1.16, 10], [1.17, 10], [1.18, 100]], midPrice: 1.16,
  });
  assert.equal(est.ok, true);
  assert.equal(est.filledQuantity, 15);
  assert.equal(est.fullyFilled, true);
  // 10*1.16 + 5*1.17 = 17.45; avg = 17.45/15
  assert.ok(Math.abs(est.estimatedOutput - 17.45) < 1e-9);
  assert.ok(Math.abs(est.avgPrice - 17.45 / 15) < 1e-9);
  assert.ok(est.priceImpactPct > 0); // BUY above mid
});

test('market SELL estimate walks real bids below mid', () => {
  const est = estimateExecutionFromBook({
    side: 'SELL', quantity: 10,
    bids: [[1.15, 100]], asks: [[1.2, 100]], midPrice: 1.16,
  });
  assert.equal(est.ok, true);
  assert.ok(Math.abs(est.estimatedOutput - 11.5) < 1e-9);
  assert.ok(est.priceImpactPct < 0); // SELL below mid
});

test('insufficient depth: partial fill reported honestly', () => {
  const est = estimateExecutionFromBook({
    side: 'BUY', quantity: 100,
    bids: [], asks: [[1.16, 10]], midPrice: 1.16,
  });
  assert.equal(est.ok, true);
  assert.equal(est.filledQuantity, 10);
  assert.equal(est.fullyFilled, false);
  assert.equal(est.unfilledQuantity, 90);
  assert.ok(est.depthCoveragePct < 100);
});

test('no book data → NO_BOOK_DATA, never a fabricated price', () => {
  assert.equal(estimateExecutionFromBook({ side: 'BUY', quantity: 1, bids: [], asks: [], midPrice: 1 }).error, 'NO_BOOK_DATA');
  assert.equal(estimateExecutionFromBook({ side: 'BUY', quantity: 0, bids: [[1, 1]], asks: [[1, 1]] }).ok, false);
});

/* ---------- client order id ---------- */

test('client order id: numeric string, u64-safe, unique enough per call', () => {
  const a = makeClientOrderId();
  const b = makeClientOrderId();
  assert.match(a, /^\d+$/);
  assert.ok(BigInt(a) < 2n ** 64n);
  assert.notEqual(a, b);
});

test('FLOAT_SCALAR matches DeepBook 1e9 price scale', () => {
  assert.equal(FLOAT_SCALAR, 1_000_000_000);
});
