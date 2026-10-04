# Integration report — Sui Action Hub unified build (2026-09-30)

Style source of truth: Главная (`--bg #0a0a0a`, `--accent #0066ff`, Space Grotesk + Inter).
Dashboard base: дэшборд 2 (correct). Merged from дэшборд 1 (Wallet OS):
AI Agent page → `/app#ai` (monitoring state, execution stream logic → AI tool router),
Security page (permissions ON/OFF, limits, recovery) → `/app#security`,
WHEN/IF/THEN automation form → Automation rule builder,
Approval modal (AI agent request) → `#approvalModal`,
Portfolio chart concept → Capital breakdown + freshness badges.

## Matrix (status = honest technical path, no fakes)

| Provider | Category | Read | Quote | Build TX | Simulate | Execute | Rewards | Referral | Status |
|---|---|---|---|---|---|---|---|---|---|
| Cetus | Swap | ✓ | ✓ best-effort | verify | verify | verify | — | verify | LIVE_EXECUTION |
| Aftermath | Swap/LST | ✓ | ✓ | verify | verify | verify | — | verify | READ_ONLY |
| DeepBook | Trading | ✓ | ✓ | ✓/verify | ✓/verify | ✓/verify | — | — | READ_ONLY |
| Bluefin | Trading | ✓ | — | — | — | — | — | verify | DISCOVERY_ONLY |
| Turbos | Swap | ✓ | — | — | — | — | — | verify | DISCOVERY_ONLY |
| NAVI | Lending | ✓ | — | verify | verify | verify | ✓ | verify | READ_ONLY |
| Suilend | Lending | ✓ | — | verify | verify | verify | ✓ | verify | READ_ONLY |
| Scallop | Lending | ✓ | — | — | — | — | — | verify | DISCOVERY_ONLY |
| Haedal | LST | ✓ | ✓ | verify | verify | verify | ✓ | verify | READ_ONLY |
| Volo | LST | ✓ | — | — | — | — | — | verify | DISCOVERY_ONLY |
| Sui Native | Staking | ✓ | — | ✓ | ✓ | ✓ | ✓ | — | LIVE_EXECUTION |
| Wormhole | Bridge | — | link | — | — | — | — | verify | DEEP_LINK_ONLY |

Live reads implemented now: `suix_getBalance`, `suix_getAllBalances`, `suix_getStakes`
via configured RPC. Quotes: Cetus router attempted live; on failure
`PROVIDER_UNAVAILABLE` + deep-link shown — never a fabricated number.
Unsupported actions hidden or labelled Discovery/Deep-link only.

## Fees / referral math
- `fee = amount × bps / 10000`, integer-safe (×1e6 rounding), rounded only at display.
- Swap platform 20 bps (0.20%), Earn 0 bps default (revenue-share first). Network ~$0.01.
- Referral: reward = eligible × 30%, retained = eligible − reward. Window 30d,
  self/circular/duplicate blocked. No double count.

## Automation / AI / security
- Automation: NL → structured intent (schedule/price/reward triggers) → deterministic
  validate → permission engine (max/exec, daily, expiry, revoke) → scheduler →
  adapter → simulate → sign → audit record. Default MONITOR+NOTIFY.
- AI: tool router (portfolio, balances, earn, lending, staking, liquidity, token,
  protocol, activity, rewards, compare, build, simulate). Prompt-injection guard,
  no keys, no arbitrary Move, provider configurable.
- Non-custodial: backend prepares, wallet signs. Memory: auto-save prefs,
  ask-before-save context, never-save secrets; Seal encrypt + Walrus Memory.

## Files
- `index.html` — landing (Главная + Security/Privacy/marquee, CTA → app.html)
- `app.html` — unified hub: Capital, Discover, Earn, Actions (MOVE/GROW/MANAGE +
  swap/lending/staking/liquidity/trade/bridge/NFT), Automation, Activity, AI,
  Referral, Security (+registry), Settings, token detail, review/approval/protocol modals
- Originals untouched: Главная.html, дэшборд 2.html, дэшборд.html
