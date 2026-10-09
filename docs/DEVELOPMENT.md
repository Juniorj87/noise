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

## Conventions

- Fail-closed errors with stable codes (`NO_ROUTE`, `SIMULATION_FAILED`, `INVALID_AMOUNT`, …).
- Live reads only; when a provider is unreachable, report unavailable — never interpolate or invent.
- Exchange rates are not yields; rewards unknown ≠ zero.
- Every new transaction builder needs a simulation test before it is wired into the UI.
- Keep PRs small and verifiable; do not bundle unrelated changes.

## Frontend

`app.html` is the app source; `assets/journey.js` and `assets/tasks.js` drive the flows. Inline scripts must keep parsing under `npm run build`.
