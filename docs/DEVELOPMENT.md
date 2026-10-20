# Development & Contributor Guide

Supplementary setup notes for contributors. For project overview, architecture, and feature descriptions, see the [README.md](../README.md).

---

## ⚡ Zero-Server Client Development (Recommended)

Noise Hub is designed client-first. For frontend, UI, chart, and Web3 transaction testing, **no backend server or database is required**. The client connects directly to the Sui Mainnet RPC via `@wallet-standard/app` and `@mysten/sui`.

You can preview and test changes instantly using any lightweight static server:

```bash
# Option 1: Python (zero install)
python -m http.server 3000

# Option 2: Node.js npx
npx serve . -p 3000
```
Open `http://localhost:3000/app.html`.

---

## 🛠️ Full-Stack & Serverless Development

If you are modifying or testing the serverless functions under `api/`:

### Prerequisites
- Node.js ≥ 22 (24 recommended).
- Optional: PostgreSQL connection string (Neon or local) if testing the persistent leaderboard/referral layer. Local development automatically falls back to SQLite.
- Copy `.env.example` to `.env` and fill values locally. **Never commit `.env`**.

### Commands

```bash
# Install dependencies
npm ci

# Run static frontend & serverless syntax checks
npm run build

# Run server unit tests
npm test

# Run API route tests
npm run test:api

# Start local serverless runner (optional)
npm run dev
```

### Mainnet Audits & Verification
These scripts inspect live Sui mainnet state and verify unsigned transaction builds:

```bash
npm run audit:reads       # Live RPC queries against verified protocols
npm run audit:builds      # Unsigned transaction block generation
npm run audit:journey     # Multi-step journey verification
```

---

## 🗄️ PostgreSQL Test Profile (Never Production)

`npm run test:pg` requires an isolated test database. It writes test rows and runs automation ticks:

1. Create an isolated database: a fresh Neon branch or `createdb noise_test` locally.
2. Set the test environment variable:
   ```bash
   TEST_DATABASE_URL=postgres://user:password@host/dbname_test?sslmode=require
   ```
3. Run: `npm run test:pg`.

---

## 📐 Engineering Conventions

- **Fail-closed errors:** Use stable error codes (`NO_ROUTE`, `SIMULATION_FAILED`, `INVALID_AMOUNT`, etc.).
- **Live reads only:** When a provider is unreachable, report `UNAVAILABLE` — never invent or interpolate data.
- **Pre-flight simulation:** Every transaction builder must be validated via `devInspect` dry-run before signing.
- **Frontend hygiene:** `app.html` is the source of truth; running `npm run build` synchronizes `public/` and validates all inline script tags.
