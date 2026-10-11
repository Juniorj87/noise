# Security model

Non-custodial transaction authorization for Noise Hub, verified against the implementation (`app.html` wallet layer, `api/_lib/*` builders, `api/_lib/handlers/*`). Last verified against code: 2026-10-10.

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

## Transaction integrity — Round 1 (implemented 2026-10-10)

- **Client PATCH is telemetry-only.** `PATCH /api/tx` accepts pre-sign workflow states (`built` … `signed`, `rejected`, `expired`) from the record owner only (wallet injected centrally, matched server-side). Authoritative states (`submitted`/`pending`/`confirmed`/`failed`) are rejected over PATCH; financial extras (fees, outputs, amounts, digests) are stripped. State machine + optimistic-concurrency guard (`TX_CONFLICT` on lost races) enforced in `transitionTransaction`.
- **Digest↔wallet binding is chain-verified.** `recordDigest` and the confirm path compare the on-chain sender against the claimed/record wallet. Proven mismatches fail closed (`SENDER_MISMATCH`, no confirmation, no settlement). Not-yet-indexed digests stay pending; the tracker verifies before any confirmation.
- **Tracker cannot confirm foreign digests.** The cron/tick confirm path enforces the same sender gate before `CONFIRMED` + referral settlement; mismatches fail the record instead.
- **Money fields are sanitized at insert.** Fee/amount/gas values must be finite decimal strings; anything else is rejected, never stored.
- **Automation writes require a signed challenge.** Status changes need a fresh personal-message signature over a server-issued nonce bound to (wallet, automation, target status); nonces are single-use with 5-minute expiry. Run history is owner-scoped. Terminal automation states cannot be reopened.
- **Signing wrapper binds the digest.** Before invoking the wallet, the wrapper hashes the exact reviewed bytes; a wallet response for different bytes throws `DIGEST_MISMATCH` instead of being tracked.
- **No server signing.** No code path constructs signatures or submits on the user's behalf; the submission boundary is the wallet's `signAndExecute` call.

Residual risks: wallet-address + record/automation-ID knowledge remains visible to anyone (addresses and digests are public on-chain data); signature challenges mitigate writes, reads rely on owner-match. External contract bytecode is unaudited — see [EXTERNAL-CONTRACTS.md](EXTERNAL-CONTRACTS.md).

See [SECURITY.md](../SECURITY.md) for reporting vulnerabilities.
