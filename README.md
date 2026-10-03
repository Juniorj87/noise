# Sui Action Hub (NOISE HUB)

Non-custodial Sui execution hub: connect a wallet, get live quotes (Cetus
Aggregator V3 + Aftermath Router), trade DeepBook Spot + Predict with
simulated on-chain quotes, build + simulate + sign real transactions, track
them to chain confirmation, discover SuiPump launches, keep
Activity/Automations in PostgreSQL. **The backend never holds keys and never signs.**

Production data runs over **Sui gRPC** (`SuiDataProvider`, `SUI_TRANSPORT=grpc`
default); legacy JSON-RPC is a local-dev fallback only. See
[ARCHITECTURE.md](ARCHITECTURE.md), [TRADE.md](TRADE.md),
[PREDICT.md](PREDICT.md), [DISCOVER.md](DISCOVER.md), [FEES.md](FEES.md),
[SECURITY.md](SECURITY.md).

**Architecture (production):**

```
GitHub → Vercel (static frontend + /api serverless functions)
       → PostgreSQL (Neon, DATABASE_URL)
       → Sui RPC / Cetus / Aftermath / DeepBook (server-side, env-configured)
       → https://app.noisehub.xyz
```

Deployment steps: see **[VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md)**.

## Local development

```bash
npm install

# Option A — legacy all-in-one Node server (SQLite, zero setup):
npm run dev            # http://localhost:3001 — open app.html via a static server or vercel dev

# Option B — same architecture as production:
vercel dev             # http://localhost:3000 — needs DATABASE_URL in .env

# Tests
npm test               # 41 tests: fees, referrals, tx machine, automations, security (SQLite adapter)
npm run test:integration   # 10 live tests: real RPC/SDK/REST (needs network)
npm run test:api       # API-mode tests: cron auth, safe errors, CORS (no DB needed)
```

The legacy SQLite server (`server/`) is the **dev adapter**. Production runs the
Vercel functions in `api/` and never touches `node src/server.js`.

## Environment variables

Full template: [`.env.example`](.env.example). Sections:

| Section | Keys |
|---|---|
| NETWORK | `SUI_NETWORK` (`mainnet` default / `testnet`), `SUI_TRANSPORT` (`grpc` default), `SUI_GRPC_URL`, `SUI_GRAPHQL_URL`, `SUI_RPC_URL` (legacy fallback) |
| DATABASE | `DATABASE_URL` (PostgreSQL; **required in production**) |
| ADMIN | `ADMIN_KEY` (all `/api/admin/*`) |
| AI | `AI_PROVIDER`, `AI_FALLBACK_PROVIDER`, `AI_MODEL`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AI_BASE_URL`, `AI_API_KEY` |
| APP | `APP_URL`, `ALLOWED_ORIGINS`, `ALLOW_PREVIEW_ORIGINS` |
| CRON | `CRON_SECRET` (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`) |
| BUSINESS | `PLATFORM_SWAP_FEE_BPS`, `PLATFORM_EARN_FEE_BPS`, `REFERRAL_DEFAULT_RATE`, `REFERRAL_WINDOW_DAYS` |
| PROVIDERS | `AFTERMATH_API_URL` (optional override) |

Secrets live only in the server environment. The frontend receives answers, tx
bytes and status — never keys, never `ADMIN_KEY`, never `DATABASE_URL`.

## Database setup

- **Production:** any PostgreSQL. Recommended: [Neon](https://neon.tech) (serverless,
  pooled connections, free tier). Copy the **pooled** connection string into `DATABASE_URL`.
- Schema: `database/schema.sql` — applied automatically on the first API call
  (idempotent). Tables: transactions (+ lifecycle, unique digest), activities,
  automations (+ runs), referrals + revenue ledger + rewards (unique per digest),
  memory, ai_conversations, notifications, provider_health, config.
- **Local dev (adapter only):** `server/` uses SQLite (`DB_PATH=./data/hub.db`).
  SQLite is never used in production.
- Connection handling: `pg.Pool` (max 3/instance) cached across warm invocations;
  schema bootstrap runs once per cold start.

## Vercel deployment

See **[VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md)** — 10 concrete steps from
`git push` to a verified production domain. Summary: import repo (framework
"Other", no build) → add env vars → set Function timeout 60s → deploy → domain
`app.noisehub.xyz` → verify with the built-in checklist.

## Domain setup

- App: `https://app.noisehub.xyz` (same-origin `/api` — no CORS needed in production).
- Landing: `https://noisehub.xyz` (in CORS allowlist for read endpoints).
- Vercel preview deployments: set `ALLOW_PREVIEW_ORIGINS=true` to allow `*.vercel.app` origins.

## Cron (serverless-safe)

No `setInterval` in production. Two scheduled functions in `vercel.json`:

| Endpoint | Schedule | Does |
|---|---|---|
| `/api/cron/tx-tracker` | `*/5 * * * *` | polls pending txs on Sui RPC → confirmed/failed/expired, records gas + actual output, settles referral **only on confirmed** |
| `/api/cron/automation` | `*/10 * * * *` | evaluates ACTIVE automations, writes audit runs, expires old ones; **never signs** |

Both check `Authorization: Bearer $CRON_SECRET` (or `X-Cron-Secret`). Hobby-plan
cron runs daily — the frontend also finalizes state via `/api/tx/status`, cron is
the recovery net.

## Admin

- UI: `/admin` (deliberately not linked from the public app).
- Auth: `ADMIN_KEY` env var, sent as `X-Admin-Key` header by the admin page.
  Wrong/missing key → `401 UNAUTHORIZED` on every `/api/admin/*` call.
- Can: read summary (revenue, fees, policies, provider health), toggle fee bps
  (persisted in the `config` table), enable/disable protocols.
- The key is never stored in the page beyond `sessionStorage` of that tab.

## AI providers

OpenRouter / OpenAI / Anthropic / Gemini / Custom (OpenAI-compatible), with a
primary → fallback chain. Keys are server-side env vars; the Settings UI's
"Test connection" uses a user key **once** and never persists it. Answers are
grounded in live hub tools (balances, prices, staking APY, activity) with
`Source … Updated …` provenance; the system prompt forbids inventing APY/TVL/
balances and forbids signing.

## Sui network

One switch: `SUI_NETWORK=mainnet|testnet`. Cetus env, Aftermath network,
DeepBook pool maps and coin-type tables all derive from it — no cross-network
paths. Explorer links follow the active network (`suiscan.xyz/{network}`). RPC
default: `https://sui-rpc.publicnode.com` (`fullnode.mainnet.sui.io` is deprecated).

## Production configuration

- **API:** same-origin `/api/*` (serverless functions, Node 22 runtime, 60s max duration).
- **CORS:** strict allowlist; `*` is never used.
- **Errors:** `{ "error": "CODE", "message": "human-readable" }` — no stack traces,
  paths, or env values in responses (details only in server logs).
- **Rate limit:** per-IP+route token bucket per warm instance (120/min).
- **Persistence:** everything durable in PostgreSQL; instance memory holds only
  caches/breakers.
- **Security:** backend never signs; `/api/sui` is simulation-only; automation
  execution requires explicit per-action permission + wallet approval at run time.
- **Verified state:** see [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).
