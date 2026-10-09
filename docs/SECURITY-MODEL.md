# Security model

Non-custodial transaction authorization for Noise Hub, verified against the implementation (`app.html` wallet layer, `api/_lib/*` builders, `api/_lib/handlers/*`). Last verified against code: 2026-10-09.

## Principles

1. **Noise Hub is not a custodial wallet.** It holds no funds, creates no accounts, and cannot move assets.
2. **Standard wallet connection.** Wallets connect over the open Wallet Standard (`standard:connect`). Any Sui-compatible wallet works (Slush, Suiet, Phantom, OKX). There are no per-wallet SDKs and no custom key handling in page code.
3. **Keys stay in the wallet.** Private keys and recovery phrases remain solely under wallet control. Noise Hub does not request, collect, transmit, or store seed phrases or private keys — verified by codebase scan: no `Keypair`, `secretKey`, `mnemonic`, or seed handling outside server-side `ADMIN_KEY`/`CRON_SECRET` env gates and an explicit forbidden-content filter that refuses seed-like text in user preferences.
4. **Authorization happens in the wallet.** Every state-changing action ends in the wallet's own `sui:signAndExecuteTransaction` prompt. The backend produces unsigned bytes only.
5. **AI cannot authorize.** AI components receive user-displayed facts and return text. They hold no wallet session, no keys, and no signing path; AI output never substitutes the wallet prompt.
6. **Reviewable before signing.** Amounts, routes, minimum received, receipt assets, fees + recipient, gas estimates, exit conditions, and expiry are rendered before authorization wherever the flow supports it.
7. **Simulation is not a guarantee.** `devInspect` pre-flight checks the exact bytes against current state, but liquidity, object versions, and balances can shift before signing. A passed simulation can still fail on chain.
8. **On-chain transactions can be irreversible.** There is no hub-side undo. Failed or unwanted outcomes must be handled through the protocols themselves.
9. **Third parties carry their own risk.** Protocols, RPC providers, indexers, price APIs, the bridge widget, and wallet extensions are outside hub control and can fail or misbehave independently.

## What the hub stores

- **Browser `localStorage`**: UX state only — connected address, last operation journal. No key material.
- **Server database**: public addresses, transaction digests, referral attribution, rankings, automation intents. Nothing that can move funds.
- **Server environment** (never committed): `DATABASE_URL`, `ADMIN_KEY`, `CRON_SECRET`, optional AI provider keys, fee-recipient address (public). Template: `.env.example` (placeholders only).

## What is explicitly NOT claimed

- No independent security audit has been performed.
- Nothing is described as risk-free; fund safety is not guaranteed.
- Simulations and unsigned-build evidence (`audit/`) are engineering checks, not certifications and not funded end-to-end tests.
- No bug bounty program exists.

## Sensitive-action checklist (implemented)

- Re-simulation immediately before invoking the wallet.
- Digest equality check between reviewed plan and wallet response.
- 60-second review expiry; rebuild on selection or account change.
- Failed simulations block signing; rejections stop tracking; digest mismatches are never auto-resubmitted.
- Referral attribution requires an explicit personal-message signature (consent), not a silent cookie.

See [SECURITY.md](../SECURITY.md) for reporting vulnerabilities.
