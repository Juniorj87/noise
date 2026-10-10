# Changelog

Derived from Git history. Only shipped, verifiable changes are listed.

## 2026-10-10

- Strict request-body contract: malformed JSON → `400 INVALID_JSON`, oversize → `413 PAYLOAD_TOO_LARGE`, aborted uploads settle without hanging; covered by unit + live-HTTP regression tests.
- Aggregator route lookup retries once on transient failures (never on deterministic illiquidity).
- Earn: all six staking routes selectable, Metastable panel loads, Volo/sSUI panels guard against 0%/NaN.
- PostgreSQL test profile isolated (`TEST_DATABASE_URL`, never production); tx-cycle test scenario documented (no funds moved).

## 2026-10-09

- Place-funds UI covers all 8 atomic providers (Suilend, NAVI, Kai, Scallop, Haedal, SpringSui, Metastable mSUI, Volo) in destination list, comparison cards, and positions.
- Wallet picker lists every detected Sui wallet (Phantom, OKX, Slush, Suiet) instead of a blind default.
- Sidebar: Leaderboard top, Orderbook (DeepBook / Predict) and Referrals as first-class entries.

## 2026-10-08

- Production quotes outage fixed (fee-recipient trimming) with regression test.
- Task-first release verification: landing protocol matrix, canonical SUI matching, missing SDK dependencies.
- Launch fee rate 2 bps (0.02%) with wired revenue wallet.

## 2026-10-07

- Execution pass: Obric removed, AlphaFi/AlphaLend sunset, Metastable / Turbos / Bluefin / Scallop / Bucket / SpringSui / Volo reads + builds live, Turbos as third swap quote, Earn/Discover surfaces.
- UX pass: trade staleness handling, action cards, SuiPump cache + retry.

## 2026-10-06 and earlier

- Pre-execution audit snapshot, live-data pass (APY units, freshness, coverage matrix), canonical app promotion, referral attribution + leaderboard engine, production release baseline.
