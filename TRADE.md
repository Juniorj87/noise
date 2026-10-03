# TRADE — Spot / Predict / Margin

Trade = the market venue. Actions = what the user wants to do. Never mixed.

- Trade → Spot: DeepBook V3 order book (`/api/trade/*`, `/api/trade/deepbook/*`).
- Trade → Predict: DeepBook Predict binary markets (see PREDICT.md).
- Trade → Margin: Coming Soon — no execution path is presented as live.
- Actions → Swap: Cetus Aggregator V3 + Aftermath Router, compared by
  **effective output** (`quotedOut − protocolFee − providerFee − hubFee −
  gasEst`), best label only when ≥1 live quote compared.

## Spot flow

Discovery is never hardcoded: the market dropdown loads
`GET /api/trade/markets`. Header shows Last (= mid), Best Bid/Ask, Spread;
24h Change/Volume read `Unavailable` (the SDK publishes no ticker — never 0).

Order book: real L2 ticks, auto-refresh ~12s, `Updated just now / Xs ago /
Stale data`. Order entry: Market/Limit, Buy/Sell, tick/lot/min validation
(integer math, `shared/deepbook-logic.js`). Market orders show a book-based
estimate (avg price, impact, depth coverage, thin-book warning).

Open orders resolve per wallet BalanceManager (`accountOpenOrders +
getOrderNormalized`) with Cancel. No manager → `TRADING_ACCOUNT_REQUIRED`
with a one-time `setup-account` PTB (user-owned, shared).

Every build: validate → build → **simulate (gate)** → fee review → wallet
sign → submit → track → confirmed/failed → Activity. `simulation_failed`
blocks signing.
