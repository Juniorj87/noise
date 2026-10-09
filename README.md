# Noise Hub

**Sui without the noise.**

A non-custodial interface for discovering and interacting with the Sui ecosystem through a unified experience.

Noise Hub brings portfolio overview, token swaps, lending, liquid staking, vaults, DeepBook spot and prediction-market trading, and an embedded Wormhole bridge into one place. The hub prepares and simulates every transaction — your wallet alone authorizes and signs it.

Live application: **https://noisesui.vercel.app**

## Core principles

- **Non-custodial.** Private keys never leave your wallet. The hub cannot move funds.
- **Review before sign.** Amounts, routes, fees, and exit conditions are shown before authorization.
- **Live data or nothing.** Rates and balances come from on-chain reads. When a read fails, the UI says so instead of inventing a number.
- **Atomic entries.** Swap + deposit execute as one transaction: either everything applies or everything reverts (network gas excepted).
- **No invented yield.** Reported APR/APY figures are shown as reported, never summed into a fictional total.

## How Noise Hub works

1. You pick an intent — swap a token, place funds, manage a position, trade on DeepBook.
2. The backend resolves the intent into a protocol-specific operation and fetches live quotes or market state.
3. You review the complete plan: input, minimum received, fees, gas estimate, exit conditions.
4. The backend builds the unsigned transaction and simulates it against current mainnet state. A failed simulation blocks signing.
5. Your wallet prompts for signature. The hub never signs, never submits on your behalf, and never sees your keys.
6. Execution happens in your wallet; the hub polls the on-chain receipt and updates activity, positions, and rankings.

Details: [docs/TRANSACTION-FLOW.md](docs/TRANSACTION-FLOW.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Non-custodial security model

- Noise Hub is not a wallet and holds no funds.
- Wallets connect over the open Wallet Standard (`standard:connect`, `sui:signAndExecuteTransaction`). Any compatible Sui wallet works — Slush, Suiet, Phantom, OKX.
- The wallet retains sole control of private keys and recovery phrases. Noise Hub does not request, collect, transmit, or store them. The preferences store actively refuses seed-like content.
- AI assistance is read-only context plus optional server-side language models. It cannot sign and cannot authorize transactions.
- Simulation is a pre-flight check, not a guarantee: on-chain transactions can fail and can be irreversible.

Full model: [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) · Report an issue: [SECURITY.md](SECURITY.md)

## Architecture overview

Static frontend (`app.html` + `assets/`) talks to Vercel serverless API routes (`api/`), which use protocol adapters (`api/_lib/`) over Sui JSON-RPC/gRPC plus provider SDKs and REST APIs. PostgreSQL persists the operation ledger, referral attribution, and rankings. A scheduler evaluates automation intents — it never signs.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Ecosystem integrations and capability status

| Area | Status | Notes |
|---|---|---|
| Token swaps (Cetus aggregator, Aftermath, Turbos; FlowX / Momentum / Bluefin / Turbos routed venues) | LIVE | Quote → build → simulate → wallet sign. Failed simulations block signing. |
| Atomic place-funds (Suilend, NAVI, Kai, Scallop, Haedal, SpringSui, Metastable mSUI, Volo) | LIVE | Swap + deposit in one signature; mSUI mints direct from SUI only. |
| Lending supply / borrow / repay / claim (Suilend, NAVI, Scallop) | LIVE | Advanced actions UI; health-gated exits. |
| Liquid staking (Haedal, SpringSui, Volo, Aftermath afSUI, Sui native) | LIVE | Instant and ticket-based exits where the protocol defines them. |
| DeepBook V3 spot | LIVE | Live book, order placement through your BalanceManager. |
| DeepBook Predict | LIVE | Market discovery, mint / redeem / claim builds with simulation. |
| DeepBook margin | COMING SOON | Builders exist; UI hidden. |
| STEAMM liquidity pools | LIVE | Dual-asset LP in the liquidity UI; excluded from single-asset flows by design. |
| Bucket PSM swaps | LIVE | Low-fee stable swaps. Broader Bucket lending: PARTIAL. |
| Wormhole bridge (self-hosted Connect widget) | PARTIAL | Widget integrated; no signed end-to-end transfer performed by the team. |
| Portfolio, positions, activity ledger | LIVE | Live reads; no double counting; failures reported, not zeroed. |
| Automation (intents, limits, scheduler) | PARTIAL | Evaluates and notifies; every execution still needs wallet approval. |
| AI assistance | PARTIAL | Live-tools router works without keys; LLM answers need a server-side key. |
| Referrals / leaderboard | LIVE | Invitation attribution and confirmed-workflow ranking. No payouts (disabled by design). |
| Bluefin market data | READ_ONLY | Markets, depth, tickers. No perps integration. |
| Kriya, Seal/Walrus, perps grids | UNAVAILABLE | Sunset / intentionally not installed / not connected. |

Verified matrix: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)

## Current implementation status and limitations

- Unsigned builds and simulations are verified continuously (see `audit/`), but they are not funded-wallet end-to-end tests.
- A review is valid for 60 seconds; expired or changed selections must be rebuilt.
- No independent security audit has been performed. Nothing here is a safety guarantee or investment advice.
- Production persistence requires PostgreSQL; only local SQLite is covered by automated tests.

## Technology stack

- Frontend: dependency-free HTML/JS with Wallet Standard (`@wallet-standard/app`) and Sui SDK via CDN import map.
- Backend: Node.js serverless functions, Sui JSON-RPC/gRPC, DeepBook V3 SDK, Scallop / Suilend / NAVI / Kai / Aftermath / Turbos / SpringSui / Metastable SDKs.
- Data: PostgreSQL (Neon) in production, SQLite locally. Cron jobs for tracking and automation.
- Hosting: Vercel. No funds, keys, or secrets live in the repository.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system architecture.
- [docs/TRANSACTION-FLOW.md](docs/TRANSACTION-FLOW.md) — transaction lifecycle.
- [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) — non-custodial model.
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) — verified integration matrix.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — supplementary developer setup.
- [CHANGELOG.md](CHANGELOG.md) — release history from Git.

## Security reporting

See [SECURITY.md](SECURITY.md). Do not open public issues with exploit details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Small, verifiable changes only: live reads, fail-closed errors, no invented numbers, tests for new builders.

## License

No license has been chosen yet — all rights reserved by default until the owner adds one. Do not reuse this code commercially until that decision is published.
