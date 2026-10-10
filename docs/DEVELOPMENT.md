# Development

Supplementary setup notes for contributors. This is not the product description — see the root [README](../README.md).

## Prerequisites

- Node.js ≥ 22 (24 recommended).
- A PostgreSQL connection string for production-like persistence; local dev falls back to SQLite.
- Copy `.env.example` to `.env` and fill values locally. Never commit `.env`.

## Commands

```bash
npm ci
npm run build        # static + serverless parse checks, registry mirror
npm test             # server unit tests
npm run test:api     # API route tests
npm run dev          # local API (port 3001)
```

Live checks (read mainnet, build unsigned transactions, never sign):

```bash
npm run audit:reads
npm run audit:builds
npm run audit:journey
```

## PostgreSQL test profile (never production)

`npm run test:pg` requires a SEPARATE test database. It writes test rows and
runs the automation tick — pointing it at production would pollute ledger,
referral, and automation tables.

1. Create an isolated database: a fresh Neon branch (recommended — instant,
   copy-on-write, deletable) or `createdb noise_test` on a local Postgres.
   Never reuse the production connection string.
2. `TEST_DATABASE_URL=postgres://user:password@host/dbname_test?sslmode=require`
3. Run: `npm run test:pg` (the suite sets `NODE_ENV=test` itself so `pg.js`
   routes at `TEST_DATABASE_URL`; without it the suite skips honestly).
4. Advanced override (only if you fully understand the risk):
   `PG_ALLOW_DATABASE_URL_TESTS=1` lets the suite use `DATABASE_URL`.
   Do not set this against production.

## Conventions

- Fail-closed errors with stable codes (`NO_ROUTE`, `SIMULATION_FAILED`, `INVALID_AMOUNT`, …).
- Live reads only; when a provider is unreachable, report unavailable — never interpolate or invent.
- Exchange rates are not yields; rewards unknown ≠ zero.
- Every new transaction builder needs a simulation test before it is wired into the UI.
- Keep PRs small and verifiable; do not bundle unrelated changes.

## Frontend

`app.html` is the app source; `assets/journey.js` and `assets/tasks.js` drive the flows. Inline scripts must keep parsing under `npm run build`.
