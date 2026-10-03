# PREDICT — DeepBook Predict integration

Official SDK: `@mysten/deepbook-v3/predict` (`PredictClient`, `cost`,
`pricing`). Docs: DeepBook Trader/Builder Hub + Predict SDK docs.

## Market model (official)

Binary instrument: **asset + strike + expiry + UP/DOWN**, automatic on-chain
settlement. Market selector = `MarketDescriptor`:

```js
{ underlying, expiryMs, side: 'up' | 'down' | 'range',
  strike: number | 'reference', marketId? }
```

- Underlyings come from `getConfig(network).underlyings` — today mainnet
  exposes **BTC only**. The UI renders exactly what the chain config offers.
- `read.markets()` → active expiry windows with `mintPaused`,
  `referencePrice`, tick/admission-tick sizes. Status: ACTIVE / PAUSED /
  EXPIRED. Untradable windows render `Trading unavailable` with reason;
  expired windows refuse submission.
- `strike: 'reference'` trades the on-chain anchor (Polymarket-style:
  derived from the previous-window oracle observation). Custom numeric
  strikes must respect the admission grid or the chain aborts
  (`EInvalidAdmissionTick`) — validated before build.

## Pricing pipeline (official)

Local `cost.mintCost / mintCostForBudget` = fast preview only. Before every
build the adapter takes a **chain quote** (`read.quoteMint`,
`read.quoteMintCost`, `read.quoteRedeem`) — simulated events, `feesExact`.
Local preview can never see chain state, backing, or paused flags.

Fee components shown only when the market applies them: premium, trading
fee, subsidy, builder fee, penalty, inventory impact/rebate, network gas,
Action Hub fee ($0.00 — no separate debit without a registered builder
code). Fee policy is per-market state (`SHIPPED_FEE_POLICY` is an SDK
default/template, never a production constant).

Limits enforced up front: `POSITION_LOT_SIZE` (0.01), `MIN_PREMIUM`
(1.00 USDC), `MAX_QUANTITY_LOTS`.

## Position lifecycle

Mint (quantity or budget) → `read.positions` → live redeem where the
protocol allows (`quoteRedeem` + `redeemLiveProceeds` economics: gross,
fees, penalty, impact rebate, net) → `claimSettled` only where the protocol
exposes it; otherwise the UI states that settlement is automatic on-chain.
Positions surface in Capital, Activity (`PREDICT_MINT / REDEEM / CLAIM /
SETTLEMENT`), AI tools, and read-only automation triggers
(expiry / probability crossing notifications — execution only with explicit
permission + wallet approval).
