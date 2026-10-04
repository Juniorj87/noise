# ACTION_HUB_INTEGRATION_AUDIT.md
**Date:** 2026-09-30 · **Scope:** full app (landing, app, docs, server) · **Rule:** no invented data

All package versions verified via npm registry. All doc URLs fetched and read.
Anything not verified below is marked `UNVERIFIED` — never assumed.

---

## A. Current implementation (what actually works today)

**Frontend (`index.html`, `app.html`, `docs.html`)**
- Landing + app + docs share one visual language (Space Grotesk + Inter, `#0a0a0a` / `#0066ff`).
- Open App entry via single `HUB_APP_URL` constant (local `app.html`, prod `https://app.noisehub.xyz`).
- No-fake sweep done: every visible control acts or is labelled
  (`LIVE` / `READ ONLY` / `DEEP LINK` / `COMING SOON` pills); fake `simulation: PASS`
  claims removed; no dead buttons (earn cards → deposit review, token BUY/SELL →
  swap, Claim → claim review, NFT → read-only panel, settings rows routed).
- GSAP CDN failsafe: content always visible, no frozen gray blocks.
- Capital: real `suix_getAllBalances` + `suix_getStakes` + `suix_getOwnedObjects`
  via working RPC (`https://sui-rpc.publicnode.com` — `fullnode.mainnet.sui.io`
  JSON-RPC is **deprecated**, verified by direct probe), USD via CoinGecko,
  no double counting, `Price unavailable` for unpriced assets.
- Referral page: `https://noisehub.sui/?ref=<code>`, generated + custom codes,
  30-day window, anti-abuse checks (client-side).
- AI: local tool-router over live hub data with Source/Updated (no LLM yet).
- Automation: NL → structured intent, limits/expiry/revoke, localStorage,
  audit runs.

**Backend (`server/`, Node 22+, SQLite, `npm test` 11/11 passing)**
- Routes: `/api/health /protocols /capital /quote /activity /sui (simulate) /
  automation* /scheduler-tick /referral* /ai /ai-tools /notifications /admin/*`.
- Real quote path: Cetus Aggregator V3 `router_v3/find_routes` via
  `@cetusprotocol/aggregator-sdk@1.7.3` (verified installed).
- Real simulation path: `sui_devInspectTransactionBlock` via `@mysten/sui@2.33.2`
  (`SuiJsonRpcClient` from `@mysten/sui/jsonRpc` — `SuiClient` export no longer
  exists in this version, verified by import probe).
- Scheduler tick, fee/referral math (unit-tested), revenue ledger tables,
  rate limiting, per-provider circuit breaker, admin summary (ADMIN_KEY).

---

## B. Missing integrations (complete list)

1. Wallet signing/execution (dapp-kit `signAndExecute`, tx builders per protocol).
2. Aftermath Router as second quote source + Pools/Staking/Farms/DCA/Limit/Perps/NFT-AMM reads.
3. NAVI / Suilend / Aftermath / DeepBook method-level SDK calls (packages verified, methods pending).
4. Pool/whale/discovery indexer (live APY/TVL/volume/holders).
5. Lending positions, LP positions, open orders, bridge quotes, gas estimates, tx-status tracking.
6. LLM provider connection (abstraction exists, key flow exists, no provider called yet).
7. Seal/Walrus/Walrus Memory SDK wiring (`@mysten/seal@1.4.17`, `@mysten/walrus@1.2.32` verified on npm, not installed).
8. SuiNS resolution (`@mysten/suins@2.0.13` verified, not installed).
9. NFT marketplace execution, bridge execution, Bluefin/Turbos/Kriya/FlowX execution.
10. Email/Telegram/push notifications (in-app table exists).
11. Referral server-side attribution running against real revenue (tables exist, no settled revenue yet).
12. E2E tests on testnet, mainnet config review, production deploy.

---

## C. Protocol matrix (status + WHY)

| Protocol | Cat | Live data | Quote | Build | Sim | Exec | Rewards | Referral | Fees (verified) | Status + reason |
|---|---|---|---|---|---|---|---|---|---|---|
| Cetus / Agg V3 | swap | via quote | YES (SDK 1.7.3) | milestone | devInspect | milestone | — | **0 (partner closed to new teams** — Typeform-only, [partner-swap](https://cetus-1.gitbook.io/cetus-developer-docs/developer/via-sdk/features-available/partner-swap.md)) | pool fee varies | LIVE_EXECUTION (quotes) |
| Sui native | staking | YES (RPC) | — | milestone | devInspect | milestone | accrue on-chain | — | validator commission | LIVE_EXECUTION (reads) |
| Aftermath spot/router | swap | REST trade-route/prices | YES (REST, multi-venue: SuiSwap/Cetus/CetusDlmm/…) | via Cetus PTB today; AF add-trade next | devInspect | wallet signs | farms API | router: 2.5% of integrator fee (see F) | router: no protocol fee | LIVE_EXECUTION (quotes, compared vs Cetus) |
| Aftermath pools | liquidity | REST summary: 1859 pools, TVL/vol/APR live | — | milestone | devInspect | milestone | claimable+harvest APIs | per-pool config | 0.30% uncorrelated / 0.10% stable + 0.005% protocol | LIVE (data) |
| Aftermath perps | perps | REST native/ccxt/WS (unwired) | — | milestone | devInspect | milestone | points | 10% <$100M / 5% ≥$100M + Builder Codes (≤1%, user-approved) | maker −0.005%, taker 0.045% @T0 | READ_ONLY |
| Aftermath staking/afSUI | LST | staking APY 0.0143 live (SDK) | — | milestone | devInspect | milestone | staking APR | product-specific, unverified | verify | LIVE (data) |
| Aftermath farms | yield | SDK `Farms` surface verified, reads unwired | — | milestone | devInspect | milestone | harvest API | unverified | verify | READ_ONLY |
| Aftermath DCA / limit | automation | REST dca-and-limit-orders (unwired) | — | milestone | devInspect | milestone | — | — | per product | READ_ONLY |
| Aftermath NFT AMM | nft | docs only | — | — | — | — | — | — | verify | DISCOVERY_ONLY (GameFi infra, no marketplace commitment found) |
| NAVI | lending | BLOCKED: SDK hardcodes deprecated `fullnode.mainnet.sui.io` RPC (no injection point found in dist); `getPoolInfo` arg format undocumented (`assetId` throw) | — | — | devInspect | — | — | 0 | verify | BLOCKED (SDK-side; retry when navi-sdk updates transport) |
| Suilend | lending | BLOCKED: `SuilendClient.initialize(id, type, grpcClient)` needs gRPC client shape; `SuiGrpcClient({url})` ctor accepted but initialize throws on arg shape (`endsWith` of undefined) | — | — | devInspect | — | — | 0 | verify | BLOCKED (transport shape unverified; REST alternative unknown) |
| SpringSui (Suilend) | LST | [integration docs](https://docs.suilend.fi/springsui/springsui-integration.md) | — | milestone | — | milestone | — | unverified → 0 | verify | DISCOVERY_ONLY |
| STEAMM (Suilend) | amm/launch | [dev guide](https://docs.suilend.fi/steamm-developer-integration-guide.md) | — | — | — | — | — | unverified → 0 | verify | DISCOVERY_ONLY |
| DeepBook V3 | trading | SDK `DeepBookClient` (`@mysten/deepbook-v3@2.6.4`): 8 markets incl. SUI_USDC, midPrice + L2 ticks live; openOrders needs user's balanceManager (correct per-wallet requirement) | orderbook | milestone (needs manager) | devInspect | wallet signs | — | — | DEEP fee model, verify per pool | LIVE (data) |
| Bluefin | trading | UNVERIFIED (no official SDK package confirmed) | — | — | — | — | — | unverified → 0 | verify | DEEP_LINK_ONLY |
| Turbos | swap | UNVERIFIED (npm name `turbos-sdk`/`@turbos-clmm/turbos-sdk` not found) | via Cetus agg | — | — | — | — | unverified → 0 | verify | DEEP_LINK_ONLY |
| Kriya / FlowX / Metastable / Obric | swap | reachable as Cetus-agg providers | via Cetus agg | — | — | — | — | unverified → 0 | verify | DISCOVERY_ONLY (routed, not direct) |
| Haedal / Volo | LST | UNVERIFIED method-level | via Cetus agg | — | — | — | — | unverified → 0 | verify | DISCOVERY_ONLY |
| Scallop / Bucket | lending | UNVERIFIED method-level | — | — | — | — | — | unverified → 0 | verify | DEEP_LINK_ONLY |
| Wormhole (+Portal) | bridge | UNVERIFIED (no quote API key flow confirmed) | — | — | — | — | — | unverified → 0 | provider fee | DEEP_LINK_ONLY |
| TradePort / other NFT mkt | nft | UNVERIFIED | — | — | — | — | — | — | — | UNAVAILABLE (no integration researched yet) |
| Launchpads / bonding | discovery | UNVERIFIED | — | — | — | — | — | — | — | UNAVAILABLE (research queued) |
| Prediction / payments / RWA / DePIN / identity | — | out of scope until core execution lands | — | — | — | — | — | — | — | UNAVAILABLE (queued, §5-other) |

---

## D. Real data sources (per metric)

| Metric | Source (verified) | Endpoint / method | Freshness |
|---|---|---|---|
| Wallet balances | Sui RPC (publicnode) | `suix_getAllBalances` | 30s cache, timestamped |
| Stakes/validators | Sui RPC | `suix_getStakes` | 30s cache |
| Owned objects/NFT count | Sui RPC | `suix_getOwnedObjects` | per load |
| SUI/USDC/DEEP USD | CoinGecko | `/simple/price` | 5-min cache |
| Any coin/LP USD + 24h % | Aftermath REST | `POST aftermath.finance/api/prices`, `/api/price-info` | per request (to wire) |
| Swap quote | Cetus Agg V3 | `router_v3/find_routes` via SDK 1.7.3 | 15s cache, quoteId |
| Pool stats/TVL/volume | Aftermath REST | `/api/.../pools` | per request (to wire) |
| Staking metrics | Aftermath REST | `/staking` | per request (to wire) |
| Perps markets/orders | Aftermath REST/WS | `/native`, `/ccxt`, websockets | per request (to wire) |
| Lending markets | NAVI/Suilend SDKs (pending) | `NAVISDKClient`, `SuilendClient` | UNWIRED |
| Simulation | Sui RPC | `devInspectTransactionBlock` | at signing |
| Gas estimate | Sui RPC (via devInspect effects) | same | at signing |
| Tx status | Sui RPC | `sui_getTransactionBlock` (to wire) | poll |
| Holders/buyers, bridge quotes, farming APR | UNVERIFIED | — | show `N/A` until sourced |

Envelope (to adopt in API + UI): `{ value, source, sourceUrl, updatedAt, freshness, confidence }`.

---

## E. Aftermath deep integration (verified surfaces)

- SDK `aftermath-ts-sdk@5.1.1`: `Aftermath, AftermathApi, Router, Pools, Pool, Staking,
  Farms, Perpetuals(+Account/Market/Vault/Order*), NftAmm, ReferralVault, DCA/Limit
  product docs, Prices, Coin, UsersData` — 59 exports confirmed by import probe.
- REST (`https://aftermath.finance`): prices, price-info, pools, staking, native
  perps, ccxt, dca-and-limit-orders, builder-codes (register/config/tx-build),
  auxiliary (rewards, referrals, router), websockets, auth for rate limits.
- Products mappable 1:1 to hub sections: Router→Swap quotes (#13 decision below),
  Pools→Liquidity, Staking/afSUI→Staking, Farms→Earn rewards, DCA/Limit→Automation
  execution, Perpetuals→Trading, NFT-AMM→NFT read-only, ReferralVault→referrals,
  Prices→data router.
- Referral relationships are on-chain associable; economics differ per product (F).

## F. Referral economics (real numbers + sources)

- **Aftermath router:** no protocol fee; optional per-swap platform (integrator) fee;
  **Aftermath retains 2.5% of that fee**. Source: [router fees](https://docs.aftermath.finance/trade/smart-order-router/fees.md).
- **Aftermath pools:** 0.30% uncorrelated / 0.10% stable trade fee + 0.005% protocol
  fee (traders pay; LPs free to enter/exit). Source: [pools fees](https://docs.aftermath.finance/pools/fees.md).
- **Aftermath perps:** tiered maker/taker (T0: −0.005% / 0.045%, Growth Mode live);
  referral 10% <$100M referee volume, 5% above; referee discount 5%/2%.
  Source: [perps fees](https://docs.aftermath.finance/perpetuals/architecture/fees.md),
  [perps referrals](https://docs.aftermath.finance/perpetuals/referrals.md).
- **Aftermath Builder Codes:** integrator fee on filled notional, user-approved cap,
  hard cap 1.00%, registration = one global `integratorId`, no vault/claim step.
  Source: [builder codes](https://docs.aftermath.finance/perpetuals/architecture/builder-codes-front-end-fee.md).
- **Cetus:** partner program closed to new teams (Typeform application), AccountCap
  claim model, incompatible with latest split smart-router. → eligible revenue `0`
  until partnership. Source: [partner swap](https://cetus-1.gitbook.io/cetus-developer-docs/developer/via-sdk/features-available/partner-swap.md).
- **NAVI / Suilend / others:** no public partner-fee schedule found → `0` until terms.
- **Consequence:** universal 30% is removed as a promise. Replaced by per-protocol
  `ReferralPolicy` (G + server `referralReward(eligible)` already computes against
  eligible revenue only). Until a policy is verified, UI must show `Referral: 0 /
  unverified` — code change queued (§L step 3).

## G. Action Hub fee proposal (researched, NOT a guess)

- Facts: Aftermath router protocol fee = 0 (hub keeps 97.5% of any integrator fee
  it sets); Aftermath pools protocol overhead = 0.005%; Cetus partner revenue = 0
  for now; pool trade fees users already pay = 0.10–0.30%.
- Proposal: **launch default 0 bps platform fee** (max distribution, referral story
  honest: rewards only where eligible revenue exists), with per-provider configurable
  `platformFeeBps` + optional Aftermath integrator fee up to **10 bps (0.10%)** —
  below pool trade fees, visible pre-sign, 2.5% of it to Aftermath automatically.
- Why not 20 bps blindly: no partner revenue offsets it on Cetus; 0.20% exceeds the
  only verified integrator economics we can actually collect. Owner decides before
  mainnet; engine already supports any bps value.
- UI before signing always shows: protocol / provider / hub fee / referral
  allocation / gas / total (fields exist in FeeEngine + Review modal).

## H. AI architecture

- Providers (all OpenAI-compatible except Anthropic/Gemini natives, all with
  user-chosen model, key server-side only):
  `OpenRouter https://openrouter.ai/api/v1/chat/completions` ·
  `OpenAI https://api.openai.com/v1/chat/completions` ·
  `Anthropic https://api.anthropic.com/v1/messages` ·
  `Gemini https://generativelanguage.googleapis.com/v1beta/...:generateContent` ·
  `Custom (OpenAI-compatible URL)`.
- Settings UI (queued, §L): provider select, key input (→ env preferred,
  never plaintext DB — store only `configured:true`), model field, **Test Connection**
  (calls provider `models` list endpoint, shows latency), primary + fallback chain,
  auto-fallback with `AI unavailable [Retry]` state.
- Tools (server `aiTools` + frontend router converge on):
  getPortfolio/Balances/TokenData/Earn/Lending/Staking/Liquidity/Rewards/Activity/
  OpenOrders/ProtocolDetails/SwapQuote/BridgeQuote/CompareRoutes/CompareEarn/
  BuildAction(= backend quote+build preview)/SimulateAction(= devInspect).
- Guardrails: system prompt pins tools + Source/Updated; untrusted protocol text
  sanitized; no keys, no arbitrary Move, no direct sign; automation only via
  permissioned intents (§31–32 JSON + validation + scheduler + wallet approval).

## I. Memory architecture

- `Memory = user context` (preferences, protocol/risk/notify/workflow prefs with
  [Save]/[Don't save] consent). `Live APIs = facts`. Resolver merges: preference
  selects provider, live data fills numbers; stale memory never overrides live.
- Backend `memory_records(content_cipher)` + Seal (`@mysten/seal@1.4.17`) encrypt →
  Walrus (`@mysten/walrus@1.2.32`) blob → reference stored; enable/view/delete/clear
  already in Security UI; chain resolution `suins` (`@mysten/suins@2.0.13`) for
  `noisehub.sui` display names pending install.
- Never stored: seeds, keys, passwords, API secrets, signatures.

## J. Routing architecture (decision, documented)

- **Use both, with defined roles:** Cetus Aggregator V3 SDK = primary quote source
  (already integrated, 20+ routed venues incl. DeepBookV3/Turbos/Kriya/FlowX/Scallop/
  Bluefin via enum list) — no duplicated routing logic. Aftermath Router = independent
  second source for `compareRoutes()` (different venue set + `deviationRatio` guard).
- `compareRoutes()` ranks by **effective output** =
  `quotedOut − protocolFee − providerFee − platformFee − gasEst`, penalized by
  `priceImpact` and `deviationRatio`, tie-break on reliability (breaker state).
  `Best execution` label only when ≥1 live quote compared.
- Raw provider detail (paths, packages, quoteId) retained per quote for audit.

## K. Security

- Non-custodial flow enforced in code: backend has no key handling; `/api/sui`
  accepts only `{txBytes,sender}` for simulation; signing happens in wallet via
  dapp-kit (milestone).
- Isolation: per-provider timeouts/breakers/rate limits; one dead provider never
  blocks Capital (Promise-settled reads).
- Validation: zod-style manual checks on all inputs (amount>0, allowlisted actions,
  bps bounds); automation limits server-enforced + wallet-approval for execution.
- Secrets: env only (`ADMIN_KEY`, `LLM_*`); plaintext-DB storage banned in review.
- Pending: dependency audit (`npm audit`), testnet E2E, auth review, secrets scan.

## L. Implementation order (exact)

1. Referral honesty patch: per-protocol `ReferralPolicy` table + UI `0/unverified`
   default; keep 30% only as legacy fallback constant (flagged).
2. Fee default 0 bps + per-provider `platformFeeBps` config + Review shows referral
   allocation line (fields exist).
3. Aftermath REST wiring (prices → data router envelope; pools → Discover;
   staking → Earn/Staking) + `compareRoutes()` second source.
4. Method-level SDK calls: NAVI markets/positions, Suilend reserves/obligations,
   DeepBook orderbook/open orders, Aftermath farms rewards/claims.
5. dapp-kit connect + signAndExecute for Cetus `fastRouterSwap` (testnet first).
6. AI settings UI (providers/keys/test/fallback) + server provider switch.
7. Seal/Walrus Memory + SuiNS install + wire.
8. Scheduler persistence/cron + email/Telegram + tx-status tracker + indexer.
9. Admin UI page + notifications center + E2E/security audit + mainnet review.

---

## M. Progress log 2026-10-01 (verified, no claims without proof)

- Wallet: wallet-standard module (`@wallet-standard/app` via importmap, connect/disconnect/events, `sui:signAndExecuteTransaction`) replaces legacy `window.suiWallet` code. Keys never leave wallet. Browser verification pending (needs a real wallet extension — cannot be clicked headless).
- Swap E2E UI: `/api/quotes` comparison rendered (Cetus vs Aftermath, effective output, best only when compared); Review → `POST /api/swap/build` (Cetus `fastRouterSwap` → txBytes) → devInspect simulation shown (gas + SUCCESS/FAIL gate; FAILED blocks signing) → wallet signs → digest → `GET /api/tx/status` polling → Confirmed/Failed → Activity + explorer link + capital refresh + referral reward recorded (policy rate).
- devInspect chain proven live: SUI→CETUS swap simulated `status: success` with real gas + Turbos/Momentum/CetusDLMM route events.
- Aftermath REST wired: prices, price-info (24h %), pools summary (1859 pools), owned LP, claimable rewards. SDK `Staking().getApy()` = 0.01433 live. SDK Router calls fail in Node (BigInt transport) → REST used instead (documented).
- DeepBook: 8 markets, midPrice + L2 live (SUI_USDC 1.16784/1.16792). Orders need balanceManager (per-wallet, correct).
- NAVI/Suilend: BLOCKED with exact reasons (table §C). Lending UI shows UNAVAILABLE + deep-links, no invented APY.
- Discover/Earn/Capital/Positions/Token/Activity/Automations: static fake rows removed; all render from live endpoints with Source/Updated or Unavailable.
- AI: local router rewritten — every number from a live call; backend LLM abstraction (openrouter/openai/anthropic/gemini/custom) + `/api/ai/test` + Settings UI (key used once, never stored). Memory: consent-gated CRUD wired to backend; slippage preference saved → applied to Swap. Seal/Walrus: NOT wired (needs funded objects + publisher endpoints — packages known, install deferred to avoid dead weight).
- SuiNS: `@mysten/suins` installed; `SuinsClient` needs CoreClient transport (JSON-RPC client lacks `.core`; gRPC shape unverified) → BLOCKED with reason; UI falls back to short address (no fake names).
- Referral: universal 30% removed from UI/docs; per-protocol policy table live (`cetus:0`, `aftermath-perps:10/5`, default 0 unverified); reward recorded only on real revenue events; `?ref=` attribution wired.
- Fees: FeeEngine methods per spec (`calculateProtocolFee/ProviderFee/PlatformFee/ReferralReward/NetworkFee/Total/NetPlatformRevenue`); admin runtime bps override; Review shows referral allocation.
- Admin UI (`admin.html`): key in sessionStorage only; summary, protocols toggle, fees editor, health. Not linked from public app.
- Tests: unit 16/16 (fees, referral incl. policy, validation, NL parse, compare, envelope, no-double-count); integration 10/10 live (health, capital, quotes-compare, prices, staking APY, pools, markets, orderbook, swap-build+sim, rewards, unsupported-asset rejection).
- Testnet automated funding BLOCKED: faucet endpoints (`/gas`, `/v1/gas`) return 404/Cannot POST. E2E signing path therefore manual: connect testnet wallet with test SUI → quote → build → simulate → sign → confirm → activity (checklist, not automated).
- Security: `npm audit` → 11 vulns, all inside `navi-sdk` transitive deps (dev-only vite/vitest, solana web3.js) with "No fix available" upstream; none on exercised code paths (NAVI reads blocked, SDK only imported). Secrets scan: clean (only docs copy + forbidden-word list).
- USDC coin type verified: `0xdba3…900e7::usdc::USDC` (from Aftermath docs, confirmed live in quotes).
- Remaining manual verifications: wallet click-flow in a real browser; mainnet review; production deploy/CORS; hosted notification channels.
