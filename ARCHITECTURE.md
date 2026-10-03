# ARCHITECTURE — Sui Action Hub 2.0

Execution + aggregation layer over Sui protocols. Same-origin Vercel
serverless API + Neon PostgreSQL. No Next.js rewrite, no separate VPS.

```
wallet → Capital → Discover / Trade / Actions → quote → build → simulate
  → fee review → wallet sign → submit → tracker → confirmed → Activity
       ↘ Automation (same adapters, permissions, simulation)
       ↘ AI (same live data + builders, wallet signs)
```

## Data transport (production)

`api/_lib/sui-provider.js` — `SuiDataProvider`, the single transport owner:

- Primary: Sui gRPC (`SuiGrpcClient({ network, baseUrl })`, methods
  `listBalances / listOwnedObjects / getBalance / getCoinMetadata /
  getTransaction / simulateTransaction / getReferenceGasPrice /
  getChainIdentifier`), normalized to JSON-RPC-compatible shapes.
- Fallback: legacy JSON-RPC via third-party URL (`SUI_TRANSPORT=jsonrpc`,
  local dev only). Foundation JSON-RPC is never used in production.
- Stakes on gRPC derive from `StakedSui` owned objects (validator mapping
  needs an indexer — `validatorAddress: null`, never faked).

`assertNetworkConsistency()` gates every provider against `SUI_NETWORK`.

## Provider adapters (`api/_lib/`)

| Adapter | Reads | Quote | Build | Simulate | Execute |
|---|---|---|---|---|---|
| cetus (Aggregator V3 SDK) | yes | yes | `fastRouterSwap` | yes | wallet |
| aftermath (REST + SDK) | yes | yes (router) | via Cetus PTB | yes | wallet |
| deepbook (`deepbook.js`, SDK 2.6.x) | markets/L2/info/orders | book estimate | limit/market/cancel/setup | yes | wallet |
| deepbook-predict (`deepbook-predict.js`, PredictClient) | markets/market/price/positions/balance | chain quoteMint/quoteRedeem | mint/mintAmount/redeem/claimSettled | yes | wallet |
| suipump (public REST) | tokens/stats/supply/trades | — | — | — | venue |
| perpsplexity | venue status (live) | — | — | — | deep link |
| navi / suilend | BLOCKED (SDK transport, documented) | — | — | — | — |

One unified transaction engine: `created → building → simulating →
ready_to_sign / simulation_failed → signing → submitted → confirmed /
failed / rejected / expired`. `simulation_failed` never reaches a wallet.

## Fee collection rule

Displayed fee === actual transaction. The platform leg is appended to the
PTB only when safe (SUI-funded swap today); otherwise the engine reports
disabled and the UI shows $0.00. Revenue + referral settle only on
`confirmed` with actual hub revenue (see FEES.md).

## Isolation

Per-provider timeout / retry / circuit breaker (`api/_lib/util.js`).
One dead provider degrades its own section; Capital/Discover/Trade keep
working with `PROVIDER_UNAVAILABLE` + Retry. Execution quotes are never
cached long; discovery/markets are (5–30s, timestamped).
