# PRODUCTION READINESS — Sui Action Hub (app.noisehub.xyz)

## ADDENDUM 2026-10-02 — Action Hub 2.0 (verified today)

- **Data layer:** `SuiDataProvider` (`api/_lib/sui-provider.js`) — gRPC primary
  (`SuiGrpcClient({ network, baseUrl })`, method translation + normalization +
  balance pagination), JSON-RPC legacy fallback. Live-verified: gRPC balances
  (50 rows incl. pagination), reference gas, 24 DeepBook spot markets + L2.
- **Predict:** rewritten on real `PredictClient` (was `DeepBookClient` +
  `require()` in ESM + placeholder mainnet package id). Live-verified:
  underlyings from chain config = `[BTC]`, 0 active windows right now
  (honest empty, UI handles it). Chain quote → build → simulate → sign for
  mint/redeem/claim; fee components exact from simulated events.
- **Spot:** dynamic market list (no hardcoded triple), 12s auto-refresh with
  Updated/Stale labels, per-market taker/maker fees (no hardcoded "2 bps"),
  mobile Book/Trade/Orders tabs.
- **Fees:** platform leg collected as a real PTB leg on SUI-input swaps when
  enabled; otherwise engine-disabled and UI shows $0.00. Predict/spot show
  $0.00 with the reason (no separate debit / no safe PTB leg).
- **Tx registry:** `predict_mint/redeem/claim`, `spot/limit/market/cancel`
  actions + `deepbook-predict` provider admitted; referral policies for both
  (rate 0, verified); settlement still confirmed-only.
- **Discover:** SuiPump live (674 tokens, Newest/Trades/Volume/Progress/
  Graduated filters, source-labeled cards, detail modal, no recommendations);
  Perpsplexity live venue-status read (`backingMarkets`, empty internal list
  → honest DEEP_LINK, never scraped).
- **Capital:** optional `positions=true` adds DeepBook orders + Predict
  positions, provider-isolated; Positions table links to Trade managers.
- **AI:** Predict/fee/discovery answers from live tools with Source/Updated.
- **Automation:** new notify triggers (PRICE_BELOW, ORDER_FILLED,
  PREDICT_EXPIRY/PROBABILITY, POSITION_CHANGED, APY_ABOVE) + NL parsing.
- **Tests:** 98/98 (`npm test` in `server/`, incl. 10 new hub2 tests).
- **Docs:** ARCHITECTURE/FEES/TRADE/PREDICT/DISCOVER/SECURITY.md +
  docs.html (fee table, Predict, full FAQ) + README/env/deploy updates.

**Date:** 2026-10-01 · **Stack:** Node 22+, zero-framework `node:http` API, `node:sqlite` (WAL), `@mysten/sui` 2.33.2, `@cetusprotocol/aggregator-sdk` 1.7.3, `aftermath-ts-sdk` 5.1.1, `@mysten/deepbook-v3` 2.6.4
**Method:** every claim below is backed by a test run, a live probe, or a code inspection performed today. Items not verified are marked `NOT VERIFIED`. No claims of "production ready" beyond what is listed here.

---

## PASS — verified

### Tests
- `npm test` → **41/41 pass** (fees, referral policies, tx state machine incl. final-state freeze, digest dedup, rejected/failed/explired paths, automation ownership + expiry + revoke, security validators, AI registry honesty).
- `npm run test:integration` → **10/10 pass**, all live: health, capital reads, Cetus+Aftermath quote comparison, source envelopes, staking APY, pools TVL/APR, DeepBook markets + L2 orderbook, real `swap/build` (txBytes + devInspect simulation), rewards honesty, unsupported-asset rejection.
- Baseline before changes: 35/35 + 10/10 — identical plus 6 new hardening tests after changes.

### Transaction lifecycle (§1–6)
- Formal state machine in SQLite (`transactions`): created → quoted → built → simulating → ready_to_sign / simulation_failed → awaiting_wallet → signed → submitted → pending → confirmed / failed / rejected / expired. Final states are frozen (`TX_FINAL`); illegal jumps rejected (`TX_BAD_TRANSITION`); retry loop only simulation_failed → simulating.
- Record persisted **before** the build call — a browser close mid-build still leaves an auditable row.
- Digest recorded at submit (`/api/tx/submit`), unique index — a digest can never create two records.
- Background tracker (`startTracker`, 15s) polls `sui_getTransactionBlock` (showEffects + showBalanceChanges), writes real gas and **actual output from balance changes only**, settles referral **only on confirmed** tx, expires stale rows after 30 min of no update, and **resumes automatically after server restart** (verified by restart-recovery test on real DB rows).
- `PATCH /api/tx` cannot inject/overwrite a digest; status changes to final states return 409 with the record intact.
- Rejections surface both via `signAndExecute` throwing AND via the wallet-standard rejection event (`onRejected` → status `rejected`, tracker stops).
- Activity page renders from the server ledger (`GET /api/activity`, 100 latest) with status pills (pending/confirmed/failed/rejected), digest + explorer deep link, fees, gas, failure reason; click opens full detail modal (sender, provider, in/out, expected vs actual output, hub fee, gas in MIST and SUI, failure reason, created/updated). Honest empty state when no history. Survives browser refresh and backend restart (SQLite, not localStorage).
- Capital invalidation on confirmation + manual Refresh button + "Updated Xs ago" ticker.

### Fees & referrals (§11–12)
- FeeEngine: protocol / provider / platform (bps, admin-overridable, default 20 bps swap / 0 earn) / network / total; referral allocation shown as **from hub revenue, not an extra user charge**.
- Per-protocol ReferralPolicy (`cetus: 0`, `aftermath-router: 0`, `aftermath-perps: 10/5`, default `0 unverified`) — no universal 30%.
- Settlement happens **only** after chain-confirmed status, only when eligible platform revenue > 0, unique per digest (DB unique indexes), self-referral / circular / expired-window all blocked — covered by unit tests.

### Automation (§7–8)
- Authoritative records in SQLite; scheduler reloads active automations on restart; expiry evaluated per tick.
- Ownership enforced: `/api/automation-status` rejects status changes from a different wallet (403 `NOT_AUTOMATION_OWNER`).
- Permissions: `allowedActions` allowlist enforced by `checkAutomationPermission`; NL creation defaults to `allowedActions: ['notify']` — **no arbitrary AI execution path exists** (scheduler only evaluates triggers and writes audit runs; execution requires build → simulation → permission check → wallet approval).
- Frontend applies server verdict first; server rejections roll back local state with a readable toast.

### Network separation & config (§13–14)
- `NETWORK` resolved once in `sui.js` from `SUI_NETWORK` (default `mainnet`); Cetus (`env 0/1`), Aftermath (`MAINNET`/`TESTNET`), DeepBook pool maps and coin-type tables all derive from it. Testnet coin table present for testnet runs; no cross-network execution path found in code review.
- CORS: strict origin allowlist (`app.noisehub.xyz`, `noisehub.xyz`, localhost dev), `Vary: Origin`, other origins get `null`. Rate limit 120 req/min per IP+route. All inputs validated server-side (wallet regex, amount > 0, bps 0–100, digest format, action/provider allowlists).
- Secrets: env-only (`ADMIN_KEY`, LLM keys); admin routes check `X-Admin-Key` server-side; `/api/ai/test` uses a submitted key **once** and never persists it; admin UI keeps the key in `sessionStorage` of its own tab. Secrets scan of shipped frontend/backend source: clean (regex for `sk-`, long API-key literals, AKIA*, non-empty ADMIN_KEY). No `.env` committed.
- Explorer links and health endpoint expose the active network.

### Data honesty (§20–21)
- No-fake sweep over `server/src`, `server/test`, `app.html`, `admin.html`, `index.html`, `docs.html`: no TODO/FIXME, no mock/fake/demo data paths (matches are comments stating "no fake calls", HTML input `placeholder` attributes, and a test fixture named FAKE that asserts UNSUPPORTED_ASSET rejection). All APY/TVL/prices/balances come from live SDK/REST/RPC with source + updatedAt envelopes; unpriced assets show "Price unavailable".

### AI (§16–17)
- Provider registry: OpenRouter / OpenAI / Anthropic / Gemini / Custom (OpenAI-compatible) with fallback chain; keys server-side only; test-connection endpoint with latency; conversation persistence.
- Live-tool router answers portfolio/balance/earn/protocol/activity questions from real endpoints with `Source … Updated …` provenance; system prompt forbids inventing APY/TVL/prices/balances and forbids signing. **Real LLM provider call: NOT VERIFIED** — requires a user-supplied API key (none present in repo; by design).

### Memory / Seal / Walrus / SuiNS (§17–19)
- Memory = consent-gated preferences CRUD with forbidden-content list (seed/privatekey/password/secret/mnemonic). **Seal/Walrus: NOT CONFIGURED —** packages known, no funded objects/publisher endpoints; nothing falsely claims encryption. Ordinary Walrus storage is not presented as private anywhere.
- SuiNS: resolution attempted via Sui RPC `resolveNameServiceNames` with graceful fallback to short address; failure never blocks the app; names are never faked.

### Security audit result (§15)
- npm audit: **11 vulnerabilities (2 critical, 1 high, 8 moderate) — all inside `navi-sdk` transitive dependencies** (`vitest`/`vite` dev tooling it bundles, `@solana/web3.js`, `@mayanfinance/swap-sdk`, `jayson→uuid`). Verified `src/` and `test/` contain **zero imports** of navi-sdk/solana/vitest — exposure is install-time only, NAVI is BLOCKED at SDK level (hardcodes deprecated RPC). No fix available upstream; upgrading blind risks breaking the pinned Sui stack. Decision: keep `navi-sdk` for future NAVI support or drop it in a dedicated cleanup; do not blanket-upgrade.
- No private key / seed / signing on backend anywhere (grep-verified); `/api/sui` simulation accepts only txBytes+sender; wallet signs only user-approved PTBs after successful devInspect.

---

## FAIL — actual remaining problems

1. **Real wallet E2E on testnet: NOT VERIFIED.** Testnet faucet endpoints return 404/Cannot POST (documented in audit §M), so automated funding is impossible; final sign-click requires a human with a funded Sui testnet wallet. Exact manual steps below.
2. **npm audit: 11 vulnerabilities** (see Security audit result) — all dev-only via navi-sdk transitive deps, no upstream fix. Unresolved by choice (do not break Sui stack).
3. **HTTPS/TLS termination not verifiable from this environment** — depends on the hosting layer in front of `node:http`. Reverse proxy config must set `ALLOWED_ORIGINS=https://app.noisehub.xyz` and forward `X-Forwarded-*` if used.

## BLOCKED — external limitations (exact reasons)

- **NAVI reads:** `navi-sdk` hardcodes deprecated `fullnode.mainnet.sui.io` RPC, no injection point in dist; `getPoolInfo` arg format undocumented.
- **Suilend reads:** `SuilendClient.initialize(id, type, grpcClient)` requires gRPC client shape; documented construction throws (`endsWith` of undefined).
- **Real LLM verification:** no API key in repo (correct); needs operator key via env or Settings UI test.
- **Testnet automated funding:** faucet endpoints unreachable (404) — E2E signing must be manual.
- **SuiNS full client:** `SuinsClient` requires CoreClient transport (`client.core`) absent from JSON-RPC client; RPC-level name resolution used instead.

## READ ONLY (intentionally not executable, labelled in UI)

- Aftermath perps / farms / DCA / limit orders — data surfaces live, execution not integrated.
- NAVI / Suilend / Scallop lending markets (blocked SDKs above).
- NFT marketplace execution; Haedal/Volo LST quote surfaces; pool indexer (market tab).

## DEEP LINK (execution delegated to provider site, labelled "leaves hub")

- Bluefin, Turbos, Kriya/FlowX (reachable only as Cetus-agg venues), Wormhole/Portal bridge, TradePort NFT, Cetus/Aftermath direct UIs as quote-failure fallback.

## MAINNET CHECKLIST (verify before flipping mainnet traffic)

| Item | State |
|---|---|
| RPC | `SUI_RPC_URL=https://sui-rpc.publicnode.com` (fullnode.mainnet JSON-RPC is deprecated — do not use) |
| Package/contract IDs | Only official coin types in `COIN_TYPES.mainnet` (SUI/USDC/CETUS/DEEP/NAVX); Cetus Aggregator env=0; Aftermath MAINNET; DeepBook `mainnetPools`. No inferred IDs. |
| Wallet | wallet-standard, `sui:mainnet` chain default; testnet chain only when `SUI_NETWORK=testnet` |
| Quote | Cetus Agg V3 + Aftermath router, compared by effective output |
| Build | `/api/swap/build` (Cetus `fastRouterSwap`), sender-validated |
| Simulation | devInspect gate — FAILED blocks signing (tested) |
| Sign/execute | wallet-only, backend never signs |
| Tx status | tracker + `GET /api/tx/status` — chain is the source of truth |
| Activity | SQLite ledger, explorer `suiscan.xyz/mainnet` |
| Capital | `suix_getAllBalances` + `suix_getStakes`, no double count |
| Fees | FeeEngine + admin bps override (decide final bps **before** mainnet) |
| Referral | per-protocol policy, settle on confirmed only |
| Admin | `ADMIN_KEY` required on all `/api/admin/*`; keep admin.html off public links |
| CORS | `ALLOWED_ORIGINS=https://app.noisehub.xyz` in prod env |
| HTTPS | terminating proxy required (see FAIL #3) |
| Secrets | env only; never in frontend bundle; `.env` gitignored |

## DEPLOYMENT STEPS (app.noisehub.xyz)

1. `cd server && npm ci && npm test && npm run test:integration` — must be 41/41 + 10/10.
2. Serve `index.html` / `app.html` / `docs.html` via HTTPS at `app.noisehub.xyz`; proxy `/api/*` (or absolute URL) to `node src/server.js` with `PORT`, `DB_PATH` on persistent volume, `ADMIN_KEY`, `SUI_NETWORK=mainnet`, `ALLOWED_ORIGINS=https://app.noisehub.xyz`.
3. Verify `/api/health` → `{"ok":true,"network":"mainnet"…}`; confirm CORS from the prod origin; confirm a quote, a simulation, tx status, and Activity persistence across a backend restart.
4. `ADMIN_KEY`, `OPENROUTER_API_KEY` etc. only in the server environment. Never expose to client JS.

## EXACT MANUAL WALLET TEST (the one click automation cannot do)

1. Install **Slush** (or Sui Wallet), switch it to **TESTNET**, fund ≥ 2 SUI from the Discord/`#testnet-faucet` channel (CLI faucet returns 404 today).
2. Open the app → Connect → approve in wallet → verify address matches `0x…` shown in wallet.
3. Capital shows live balances (Source: Sui RPC). Open Swap: SUI → USDC, amount `0.5`.
4. Get quotes → both providers compared → Review → **Build & Simulate** → expect `READY TO SIGN — devInspect SUCCESS` with real gas.
5. Click **Sign & Execute in Wallet** → approve in wallet popup → digest appears → wait for `CONFIRMED on Sui network` with explorer link.
6. Verify: Activity shows confirmed row (click it — details + explorer); Capital refreshed (USDC appeared, SUI minus amount+gas); refresh browser — row persists; **restart the backend** — row + automations persist.
7. Failure paths to spot-check: amount 0 (inline INVALID_AMOUNT), unsupported token (UNSUPPORTED_ASSET), decline in wallet (REJECTED pill, no pending row), simulation failure (signing blocked message, no wallet popup).

## NOT VERIFIED (explicit)

- Real wallet signature click-through in a browser (needs human + funded testnet wallet — steps above).
- Real LLM provider round-trip (needs operator API key).
- Production TLS/CORS behavior behind the actual host's proxy.
- DeepBook open orders with a real BalanceManager (needs a wallet that has registered one; endpoint is live and returns honest empty/blocked states otherwise).
