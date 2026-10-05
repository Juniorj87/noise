# Noise

> One place to interact with the Sui ecosystem.

![Built on Sui](https://img.shields.io/badge/Built_on-Sui-0066ff)
![Non-custodial](https://img.shields.io/badge/Custody-Non--custodial-0a0a0a)
![Open source](https://img.shields.io/badge/Open-Development-00c853)

<p>
  <img src="assets/logo.svg" alt="noise" width="180" />
</p>

Noise is a non-custodial interface for interacting with the Sui ecosystem.

It brings supported trading, earning, capital management, discovery and on-chain actions into one place, while keeping transaction signing under the user's wallet.

---

## Why Noise

Sui has a growing ecosystem of protocols, applications and opportunities.

Users often have to move between multiple interfaces to perform relatively simple actions.

Noise is being built to make that experience more unified.

---

## What we are building

- **Capital** — your assets and positions in one view.
- **Discover** — what is happening across the ecosystem.
- **Earn** — ways to put capital to work.
- **Trade** — spot and prediction markets.
- **Actions** — complex on-chain actions made simple.
- **Automation** — rules that watch the market for you.
- **Activity** — a clear record of what happened.
- **AI assistance** — answers grounded in live data.

---

## Sui ecosystem

The full, honest ecosystem registry lives in [`shared/registry.js`](shared/registry.js)
(35 protocols, one source of truth) and drives the app's Discover → Ecosystem view.
Every protocol carries one status:

- **LIVE** — Noise can perform every action it advertises.
- **PARTIAL** — part of the surface works (e.g. live data, no execution yet).
- **DISCOVER** — ecosystem discovery / deep link; no execution in Noise.
- **COMING SOON** — surface planned; execution intentionally disabled.

Live execution today: Sui native staking, Cetus swap, DeepBook spot + Predict,
SuiPump discovery. Everything else is labelled honestly — no fake integrations.

Regenerate the in-app mirror after editing the registry: `node scripts/gen-ui-registry.mjs`
(the build and `server/test/registry.test.js` fail if the mirror drifts).

Two companion registries keep behaviour honest:

- **SwapProvider registry** (`shared/swap-providers.js`) — which providers can quote/build.
  A provider without an adapter is listed with a reason, never a fabricated rate (`/api/providers`).
- **Skill registry** (`shared/skills.js`) — capabilities with a strict permission model:
  read-data · build-transaction · request-signature. Never a private key, never auto-sign (`/api/skills`).

---

## Non-custodial

Noise does not hold user funds or private keys.

Users remain in control of their wallets and approve supported transactions through their wallet.

---

## Open development

Noise is being built openly.

This repository contains the actual project code used to develop Noise.

We believe infrastructure and applications should be easier to inspect, understand and verify.

The repository is public so developers, ecosystem participants and users can see what we are building and how the project evolves.

---

## Status

Noise is actively being developed.

Current focus:

- Sui ecosystem aggregation
- Trading
- Capital
- On-chain actions
- Yield
- Automation
- AI-assisted interaction

---

## Links

Website:
https://noisehub.xyz

GitHub:
https://github.com/Juniorj87/noise
