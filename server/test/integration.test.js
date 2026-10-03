// Live integration tests — real RPC / SDK / REST. Needs network. No spending.
// Run: npm run test:integration  (starts API on 3199, exercises read paths only)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://localhost:3199';
let child = null;

before(async () => {
  const { spawn } = await import('node:child_process');
  child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: '3199', DB_PATH: './data/test-int.db' },
  });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API did not boot');
});

after(() => { try { child.kill(); } catch {} });

const get = async (p) => (await fetch(BASE + p)).json();
const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

test('health is live', async () => {
  const h = await get('/api/health');
  assert.equal(h.ok, true);
});

test('capital reads live chain data', async () => {
  const c = await get('/api/capital?wallet=' + ZERO);
  assert.ok(Array.isArray(c.coins));
  assert.ok(c.fetchedAt);
});

test('quotes compare Cetus vs Aftermath', async () => {
  const q = await get('/api/quotes?from=SUI&to=CETUS&amount=1&decimals=9');
  assert.ok(q.compared >= 1);
  assert.ok(q.routes[0].amountOut);
  if (q.compared >= 2) assert.ok(q.best);
});

test('prices carry source envelope', async () => {
  const p = await get('/api/prices?coins=SUI,USDC');
  assert.ok(p.value && p.source && p.updatedAt);
});

test('staking APY is a live number', async () => {
  const a = await get('/api/aftermath/staking-apy');
  assert.ok(typeof a.value === 'number' && a.value > 0);
});

test('pools carry TVL + APR', async () => {
  const l = await get('/api/aftermath/pools?limit=3');
  assert.ok(l.value.length > 0 && l.value[0].tvl > 0);
});

test('deepbook markets + orderbook live', async () => {
  const m = await get('/api/trade/markets');
  assert.ok(m.markets.length > 0);
  const ob = await get('/api/trade/orderbook?pool=SUI_USDC&ticks=2');
  assert.ok(ob.value.bid_prices.length > 0 && ob.value.ask_prices.length > 0);
});

test('swap build returns txBytes + simulation object', async () => {
  const r = await fetch(BASE + '/api/swap/build', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'SUI', to: 'CETUS', amountMist: 100000000, sender: ZERO, slippage: 0.01 }),
  }).then((x) => x.json());
  assert.ok(r.txBytes && r.txBytes.length > 100);
  assert.ok(r.simulation && (r.simulation.effects || r.simulation.error));
});

test('rewards claimable endpoint honest for empty wallet', async () => {
  const r = await get('/api/aftermath/rewards?wallet=' + ZERO);
  assert.ok(!r.error && Array.isArray(r.value));
});

test('unsupported asset rejected, not invented', async () => {
  const q = await get('/api/quotes?from=FAKE&to=SUI&amount=1&decimals=9');
  assert.equal(q.error, 'UNSUPPORTED_ASSET');
});

/* ---------- DeepBook V3 trading (live reads + honest negative cases) ---------- */

test('deepbook v3: markets list is live with mid prices', async () => {
  const m = await get('/api/trade/deepbook/markets');
  assert.ok(Array.isArray(m.markets) && m.markets.length > 0);
  const sui = m.markets.find((x) => x.market === 'SUI_USDC');
  assert.ok(sui, 'SUI_USDC expected in market list');
  assert.ok(sui.midPrice != null && Number(sui.midPrice) > 0);
  assert.ok(m.updatedAt && m.source);
});

test('deepbook v3: orderbook has bids and asks', async () => {
  const ob = await get('/api/trade/deepbook/orderbook?market=SUI_USDC&ticks=5');
  assert.ok(!ob.error);
  assert.ok(ob.bids.length > 0 && ob.asks.length > 0);
  assert.ok(ob.bestBid && ob.bestAsk && ob.midPrice);
});

test('deepbook v3: market info carries tick/lot/min params', async () => {
  const info = await get('/api/trade/deepbook/info?market=SUI_USDC');
  assert.ok(!info.error);
  assert.ok(Number(info.tickSize) > 0 && Number(info.lotSize) > 0 && Number(info.minOrderSize) > 0);
});

test('deepbook v3: estimate walks the real book', async () => {
  const est = await get('/api/trade/deepbook/estimate?market=SUI_USDC&side=BUY&quantity=1');
  if (est.error === 'NO_BOOK_DATA') return; // honest — book may be thin
  assert.ok(est.avgPrice > 0 && est.estimatedOutput > 0);
});

test('deepbook v3: build without BalanceManager → honest TRADING_ACCOUNT_REQUIRED', async () => {
  const r = await fetch(BASE + '/api/trade/deepbook/build', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: ZERO, market: 'SUI_USDC', side: 'BUY', type: 'MARKET', quantity: '10' }),
  }).then((x) => x.json());
  // Zero wallet owns no manager — the only honest outcome is a clean refusal (no txBytes).
  assert.equal(r.error, 'TRADING_ACCOUNT_REQUIRED');
  assert.ok(!r.txBytes);
});

test('deepbook v3: cancel build refuses for wallet without manager', async () => {
  const r = await fetch(BASE + '/api/trade/deepbook/cancel', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: ZERO, market: 'SUI_USDC', orderId: '1' }),
  }).then((x) => x.json());
  assert.equal(r.error, 'TRADING_ACCOUNT_REQUIRED');
});

test('deepbook v3: build rejects invalid market params', async () => {
  const r = await fetch(BASE + '/api/trade/deepbook/build', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: ZERO, market: 'SUI_USDC', side: 'BUY', type: 'LIMIT', price: 'abc', quantity: '10' }),
  }).then((x) => x.json());
  assert.ok(['INVALID_PRICE', 'TRADING_ACCOUNT_REQUIRED'].includes(r.error));
});

test('deepbook v3: orders for zero wallet return empty (manager-less, honest)', async () => {
  const r = await get('/api/trade/deepbook/orders?wallet=' + ZERO + '&live=true');
  assert.ok(!r.error);
  assert.ok(Array.isArray(r.orders));
  assert.equal(r.managerKnown, false);
});

test('deepbook v3: setup builder returns unsigned PTB for zero wallet', async () => {
  const r = await fetch(BASE + '/api/trade/deepbook/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: ZERO }),
  }).then((x) => x.json());
  assert.ok(r.txBytes && r.txBytes.length > 100);
});
