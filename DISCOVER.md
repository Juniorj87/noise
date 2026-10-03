# DISCOVER — ecosystem discovery layer

Discover = find / research / compare. Trade = execute. Never mixed, never
"buy this" language — factual metrics only (volume, liquidity, holders, age,
trades, price change).

## Sources (each card labels its source)

- **SuiPump** (`/api/discover/suipump/*`, public REST, no key): permissionless
  launchpad — name, symbol, address (`tokenType` + `curveId`), price
  (`last_price`), 24h volume, liquidity (`reserve_sui`), trades/buys/sells,
  bonding progress (`reserve/grad_threshold`), graduation flag, age.
  Filters: Newest, Trades, Volume 24h, Progress, Graduated — applied only to
  fields the source provides; market cap shows `Unavailable` when the feed
  omits it. Failover: `SuiPump temporarily unavailable`, other sources keep
  working.
- **Perpsplexity** (`/api/discover/perpsplexity/markets`): a perpetuals
  venue, not a launchpad. Researched 2026-10-02 — no public token-discovery
  API exists (only an undocumented internal `/api/markets` returning empty
  items). The hub live-reads venue status (backing markets, availability)
  and deep-links execution (`DEEP_LINK`, "leaves hub"). Never scraped.
- **Pools / Tokens / Protocols**: Aftermath prices/pools (TVL/APR/volume),
  DeepBook markets — same envelope
  `{ value, source, sourceUrl, updatedAt, freshness, confidence }`.

## Token detail

Merges available sources per asset (price, mcap, liquidity, 24h volume,
source list) and offers only really supported actions (Swap/Buy/Sell where
the hub has a route; otherwise provider deep link). Untrusted metadata is
validated (address format) and never flows into transaction recipients.
Public discovery endpoints are rate-limited + cached + deduplicated.
