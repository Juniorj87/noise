# STATUS.md — NOISE HUB production status (2026-10-01 — SUPERSEDED, kept for history)
> On 2026-10-07 the app was rebuilt around task-first journeys; see `AUDIT_REPORT_RU.md`
> and `PUBLIC_COVERAGE.json` for the current integration state. Entries below describe
> the 2026-10-01 build and may contradict current code (e.g. NAVI/Suilend/Scallop
> lending, Turbos quotes and Predict routes have since been wired live).
Full reasoning: `ACTION_HUB_INTEGRATION_AUDIT.md` (§M progress log).
Scale: `LIVE` · `PARTIAL` · `READ ONLY` · `DEEP LINK` · `COMING SOON` · `BLOCKED`.

## LIVE
- Swap quotes compared: Cetus V3 SDK + Aftermath Router REST (`/api/quotes`,
  effective-output ranking, best only when compared). Verified SUI→CETUS and SUI→USDC.
- Swap build + devInspect simulation (`POST /api/swap/build`): returns txBytes for
  wallet signing; FAILED simulations block signing. Proven `status: success` live.
- Wallet: wallet-standard module (connect/disconnect/events/signAndExecute);
  full swap lifecycle in UI (quote → build → simulate → review → sign → poll
  `/api/tx/status` → activity + explorer + capital refresh). Needs a real wallet
  click-test (cannot be clicked headless).
- Aftermath data: prices, 24h %, 1859 pools (TVL/vol/APR), owned LP, claimable
  rewards, staking APY (0.0143 live). Rendered in Discover/Earn/Capital/Token
  with Source/Updated; gaps show Unavailable.
- DeepBook: 8 markets, midPrice, L2 orderbook live.
- Sui RPC reads: balances/stakes/objects; CoinGecko USD; no double counting.
- Fees: FeeEngine methods per spec; admin runtime bps; Review shows
  protocol/provider/platform/referral/gas/total. Referral: per-protocol policy
  (no universal rate), recorded only on real revenue, `?ref=` attribution wired.
- Activity: live ledger (local + backend), full status set, explorer digests.
  Automations: NL→intent, limits/expiry/pause/resume/revoke, backend persist,
  audit runs. AI: live-tool router (no invented numbers) + multi-provider LLM
  abstraction + Settings (test connection, key-once-never-stored) + fallback.
- Memory: consent-gated prefs wired to backend; slippage pref applied to Swap;
  forbidden content rejected. Admin UI (`admin.html`, sessionStorage key only).
- Tests: unit 16/16, integration 10/10 live. Docs current. Secrets scan clean.

## PARTIAL
- Swap execution: everything except the final user click is proven; signing needs
  a browser wallet (testnet-first checklist in audit).
- AI LLM: provider switch + test work; no key configured → local router serves.
- Automation execution: intents + permissions real; run-time execution requires
  wallet approval (scheduler evaluates, does not sign).
- Revenue ledger: live code path; no settled mainnet revenue yet.

## READ ONLY
- Aftermath farms/DCA/limit/perps surfaces (SDK verified, reads unwired).
- DeepBook open orders (needs user's balanceManager — correct requirement).
- NFT count; email/Telegram/push (in-app table live).

## DEEP LINK
- Turbos, Bluefin, Scallop, Volo, Haedal, Wormhole; Kriya/FlowX/Metastable/Obric
  inside Cetus aggregation; NAVI/Suilend provider sites from Earn.

## COMING SOON
- Cron persistence, hosted notification channels, pool/whale indexer,
  charts/holders, NAVI/Suilend retry on SDK updates, mainnet review, deploy.

## BLOCKED (why)
- NAVI reads: SDK hardcodes deprecated RPC, pool-arg format undocumented.
- Suilend reads: `initialize()` needs unverified gRPC client shape.
- SuiNS resolution: `SuinsClient` needs CoreClient transport (JSON-RPC client
  lacks `.core`); UI falls back to short address, no fake names.
- Seal/Walrus: need funded objects + publisher endpoints; not installed on purpose.
- Automated testnet funding: faucet endpoints 404 (`/gas`, `/v1/gas`).
- Cetus referral revenue: partner program closed → policy 0.
- npm audit: 11 vulns, all in `navi-sdk` transitive dev/solana deps, no fix
  upstream, none on exercised paths.

## Run
`cd server && npm install && npm test && npm run test:integration && npm start`
Frontend: open `app.html` (API at `HUB_API_URL`, default `http://localhost:3001`).
