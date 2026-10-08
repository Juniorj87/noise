# Noise Hub

Non-custodial Sui interface: supported swaps, lending, staking, LP/vault operations and embedded official Wormhole bridge. Original black/blue visual language retained; mobile overflow and font inconsistencies repaired.

**Current release:** read `AUDIT_REPORT_RU.md`, `RUN_AND_DEPLOY_RU.md`, `PUBLIC_COVERAGE.json` and `PRODUCT_REVIEW_RU.md`. Public catalogue has 20 scoped entries (launchpad/perps removed), not full execution coverage for every original protocol. Unsupported public products were removed. Internal legacy records/code are not launch promises.

## Run

Node 24 recommended (>=22).

```bash
npm ci
npm run build
npm test
npm run dev
```

In another terminal:

```bash
python3 -m http.server 3000 --bind 127.0.0.1 --directory public
```

Open http://127.0.0.1:3000/app.html. Local API port 3001. Production: Vercel configuration plus your own PostgreSQL and server-side environment. No deployment to the original domain was performed.

## Validation

271 automated tests and 19 live integration tests passed. New evidence: 6 unsigned deposit/atomic-entry simulations, 3 primitive exit roundtrips, 18 chain metadata checks and 16 additional-token route quotes. Earlier 19 unsigned scenarios are separate historical evidence. This does not certify every advertised operation with a funded wallet or every bridge route. No transactions were signed/submitted. PostgreSQL production configuration was not tested.

Evidence in `audit/`: execution reports, current fee recipient balance, build/test logs, UI checks and screenshots. Release file hashes in `RELEASE_SHA256.json` exclude that manifest itself.

## Fees and custody

Default fee-bearing router swaps: 2 bps (0.02%) from input asset. Actual recipient and transfer leg are returned by builders; simulation confirmed 20,000 MIST to the project recipient for a 0.1 SUI Cetus swap. No historical revenue receipt was established. Earn/bridge/LP/DeepBook fees are not represented as collected Noise router fees. Only user wallets sign; never supply private keys to this server.

Wormhole Connect 6.0.0 is self-hosted under assets/wormhole with its license. The widget handles cross-chain wallet review/signing/history; no signed cross-chain E2E was performed.

## Public registry

`shared/registry.js` separates original internal records from `PUBLIC_PROTOCOL_IDS`/`publicProtocols`. Regenerate UI mirror after changes:

```bash
node scripts/gen-ui-registry.mjs
npm run build
npm test
```

Do not advertise unimplemented capabilities. Supported scope and excluded entries are listed in PUBLIC_COVERAGE.json.

## Task-first release

`app.html#journey`: atomic swap → deposit into Suilend/NAVI/Kai, on-chain receipt recovery, real positions/risk, separately reviewed withdrawal. Never auto-signs. WAL/NS plus 16 other curated mainnet assets; not a market-cap ranking.

AI Assistant, Referral and Leaderboard remain available in secondary/contextual tools. Launchpad/perps discovery is removed. AI actual model responses require server-side key + AI_MODEL (Gemini: AI_PROVIDER=gemini, GOOGLE_AI_API_KEY). Without configuration, live-tools responses are explicitly labelled, not simulated LLM chat. No real paid/model-key E2E was tested.

Referral ownership and assignment require wallet personal-message proof. Stats reflect real invitation attribution and verified post-attribution Workflows, not earnings. Ranking uses successful receipts for prepared Noise digests. No payouts or rewards are promised. PostgreSQL required for production persistence; only local SQLite tested.

## Current task-first interface
Start → Swap a token / Place funds / Positions & exit. More contains advanced services; Community contains invitations and confirmed activity. SuiPump and Perpsplexity are not public products.
Core placement now supports Suilend, NAVI, Kai, Scallop liquid lending shares and Haedal liquid staking. Comparison separates reported APR/APY, base rates, known incentives, unknown rewards, fees and exit conditions. Review shows input, minimum swap output, receipt coin, estimated gas, Noise fee and provider-specific exit rules. Technical details are collapsible. Inline assistant is explicitly rules-based when no server model is configured.
New evidence: `audit/tasks-execution.json`, `tasks-exits.json`, `tasks-ui.json`, `tasks-edge-ui.json`. Scallop direct/atomic entries and share redemption; Haedal stake, instant exit and delayed-ticket request were simulated without signing. An existing matured-ticket claim was NOT tested. No independent security audit or funded-wallet end-to-end run occurred.
`app.html` is the real application source, not a standalone offline artifact: use the assets and API in the ZIP and the local launch instructions.
