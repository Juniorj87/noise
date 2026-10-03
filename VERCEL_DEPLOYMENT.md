# VERCEL DEPLOYMENT — Sui Action Hub → app.noisehub.xyz

Concrete steps. No VPS, no always-on Node process. Static frontend + serverless
functions (`/api/*`) + PostgreSQL (Neon) + two cron jobs.

---

## 1. Push to GitHub

```bash
git init                 # if not already a repo
git add .
git commit -m "Action Hub: Vercel production architecture"
git branch -M main
git remote add origin https://github.com/<you>/noisehub.git
git push -u origin main
```

Check before pushing: `.env` is **not** committed (no real keys in git).

## 2. Create the database (Neon)

1. Open the Neon setup link: https://index.trygravity.ai/go/af824d0f-aa6a-4d90-988f-a4ffc4fb7ba6
   (or console.neon.tech → New Project).
2. Region: pick the one closest to your Vercel region (e.g. `aws-us-east-1`).
3. Copy the **Pooled connection** string (Connection Details → check "Pooled").
   It looks like `postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require`.

The schema (`database/schema.sql`) is applied **automatically** on the first API
call — no manual migration step. (You can also run it manually:
`psql "$DATABASE_URL" -f database/schema.sql`.)

## 3. Import the project into Vercel

1. vercel.com → **Add New… → Project** → select the GitHub repo.
2. Framework Preset: **Other** (it is a static frontend + API functions — no build needed).
3. Build Command: *(empty)* · Output Directory: *(empty — repo root is static)*.
4. Install Command: `npm install` (default).

## 4. Environment Variables

Vercel → Project → Settings → Environment Variables (add for **Production**, Preview, Development):

| Key | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Neon pooled connection string | from step 2 |
| `ADMIN_KEY` | long random string | `openssl rand -hex 24` |
| `CRON_SECRET` | long random string | protects the two cron endpoints |
| `SUI_NETWORK` | `mainnet` | production; `testnet` for test runs |
| `SUI_TRANSPORT` | `grpc` | production data layer (unified `SuiDataProvider`) |
| `SUI_GRPC_URL` | *(empty = built-in)* | override only; default `https://fullnode.mainnet.sui.io` |
| `SUI_RPC_URL` | e.g. `https://sui-rpc.publicnode.com` | legacy JSON-RPC fallback only — never `fullnode.mainnet.sui.io` (deprecated) |
| `ACTION_HUB_FEE_RECIPIENT` | *(empty = disabled)* | valid `0x…` Sui address; platform fee is disabled without it |
| `ACTION_HUB_DEFAULT_FEE_BPS` | `0` | default platform fee; per-provider overrides via admin |
| `ALLOWED_ORIGINS` | `https://app.noisehub.xyz,https://noisehub.xyz` | strict CORS |
| `AI_PROVIDER` | `openrouter` | + its key below (optional) |
| `OPENROUTER_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | your key | server-side only |
| `PLATFORM_SWAP_FEE_BPS` | `20` | optional, runtime-overridable via admin |
| `PLATFORM_EARN_FEE_BPS` | `0` | optional |

Secrets (`ADMIN_KEY`, `CRON_SECRET`, `*_API_KEY`, `DATABASE_URL`) are **never**
exposed to the frontend — all of them are read only inside serverless functions.

## 5. Function settings (dashboard)

Settings → Functions:
- **Maximum Function Execution Timeout: 60s** — required for `/api/swap`
  (route finding + PTB build + devInspect on-chain simulation).

## 6. Deploy

Click **Deploy**. First deploy builds static files + 30 serverless functions
(they share `api/_lib`). Verify in the deploy log: no build errors.

## 7. Configure the domain

1. Vercel → Project → Settings → Domains → **Add** `app.noisehub.xyz`.
2. DNS (at your registrar): add the record Vercel suggests —
   `CNAME app → cname.vercel-dns.com` (or the A/ALIAS record it shows).
3. Wait for the certificate (automatic, ~1–2 min).

Landing `noisehub.xyz` (optional): deploy `index.html` the same way as a second
project, or serve it from the same deployment and point the apex domain to it.

## 8. Redeploy

After env var or domain changes: **Deployments → ⋯ → Redeploy** (env vars apply
only to new deployments).

## 9. Verify (5-minute checklist)

| Check | How | Expected |
|---|---|---|
| Site | open `https://app.noisehub.xyz` | app loads, no console errors |
| Health | open `/api/health` | `{"ok":true,"network":"mainnet","db":"postgres"}` |
| Quotes | open `/api/quotes?from=SUI&to=USDC&amount=1` | `routes` with Cetus/Aftermath |
| Capital | connect wallet → Capital page | live balances, Source: Sui RPC |
| Swap E2E | quote → Review → Build & Simulate → sign in wallet | digest → CONFIRMED → Activity row |
| Persistence | refresh browser, restart nothing | Activity row remains (Postgres) |
| Trade Predict | open Trade → Predict | live windows from chain config (BTC today), quote → Review → sign |
| Discover | open Discover → SuiPump | live tokens with source + metrics; Perpsplexity shows live venue status + deep link |
| Cron auth | `curl https://app.noisehub.xyz/api/cron/tx-tracker` | `401 UNAUTHORIZED` (wrong secret) or `503 CRON_NOT_CONFIGURED` (secret unset — endpoint stays closed) |
| Cron auth w/ secret | `curl -H "Authorization: Bearer $CRON_SECRET" …/api/cron/tx-tracker` | `{"ok":true,…}` |
| Admin | open `/admin`, enter ADMIN_KEY | summary loads; wrong key → `UNAUTHORIZED` |

## 10. Cron behaviour

`vercel.json` defines:
- `/api/cron/tx-tracker` — every 5 min: pending/submitted transactions → Sui RPC →
  `confirmed`/`failed`/`expired`, real gas + actual output, referral settled only on confirmed.
- `/api/cron/automation` — every 10 min: evaluate ACTIVE automations, write audit runs, expire.

Plan limits: **Hobby** allows cron **once per day** (still fine — the frontend
`/api/tx/status` polling finalizes transactions live; cron is the safety net).
**Pro** runs the configured schedules. Both endpoints reject requests without the
`Authorization: Bearer $CRON_SECRET` (or `X-Cron-Secret`) header. The legacy
`?secret=` query path is removed — secrets in URLs leak into logs/history.
Without `CRON_SECRET` set, both endpoints answer `503 CRON_NOT_CONFIGURED`
(closed, never public). Functions run `maxDuration: 60s / 1024 MB`; on Hobby the
platform may clamp duration — tracker passes are idempotent, a clamped run is
picked up by the next tick.

## Local development

```bash
npm install
npm run dev          # legacy all-in-one Node server (SQLite) on http://localhost:3001
# or full parity with production:
vercel dev           # serverless functions + static frontend on http://localhost:3000
npm test             # 41 unit/tx tests (SQLite adapter)
npm run test:api     # API-mode tests (no DB needed)
DATABASE_URL=postgres://… npm run test:pg   # Postgres adapter tests (needs a DB)
```

Frontend on localhost automatically targets `http://localhost:3001`; on any
deployed domain it targets same-origin `/api`. No hardcoded hosts anywhere.
