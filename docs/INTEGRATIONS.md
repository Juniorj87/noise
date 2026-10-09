# Integrations

Verified against `shared/registry.js`, `api/_lib/*` builders, and the UI on 2026-10-09. Status scale: `LIVE` (implemented and verified) · `PARTIAL` (some functionality) · `READ_ONLY` (view without execution) · `COMING SOON` (planned, partially present) · `UNAVAILABLE` (not available, reason given).

`LIVE` below means unsigned PTB builds plus `devInspect` simulations verified against mainnet — the team has not performed funded-wallet execution for these paths. Registry entries marked `PARTIAL` carry the same verified builds with the same funded-run caveat; a few registry notes predate the October execution passes (Kai, Metastable scope) and are flagged inline rather than silently rewritten, since the registry also drives the in-app Discover page.

| Protocol / component | Purpose | Data | Transaction build | Execution status |
|---|---|---|---|---|
| Sui network (JSON-RPC / gRPC) | Settlement, reads, simulation | Balances, objects, stakes, checkpoints | — (base layer) | LIVE |
| Sui native staking | Validator staking | Validators, delegations, system state | `nativeStakeTx`, `nativeUnstakeTx` + simulation | LIVE |
| Cetus aggregator | Swap routing + execution | Routers, quotes | `cetusSwapCoin`, router swap + simulation | LIVE |
| Aftermath | Swaps, pools, afSUI staking | Prices, pools, rewards, staking APY | `aftermathSwapBuild`, `liquidStakeTx`/`liquidUnstakeTx` + simulation | LIVE |
| Turbos | Swaps, pool data | Pools, TVL/volume/APR, quotes | `turbosSwapBuild` + simulation | LIVE |
| FlowX / Momentum / Bluefin spot (via Cetus aggregator restricted venues) | Extra swap liquidity | Via aggregator | Via aggregator PTB + simulation | LIVE |
| Bluefin standalone | Market data | Markets, depth, tickers | None (no perps integration) | READ_ONLY |
| NAVI | Lending | Markets, positions, rewards | Supply / withdraw / borrow / repay / claim + journey atomic entries | LIVE |
| Suilend | Lending | Markets, positions | Supply / withdraw / borrow / repay / claim + journey atomic entries | LIVE |
| Scallop | Lending | Markets, positions, pool ratios | Supply / withdraw / borrow / repay + journey share entries | LIVE |
| Haedal | Liquid staking (haSUI) | Exchange rate, tickets | Stake / instant exit / delayed ticket / claim + journey entries | LIVE |
| SpringSui | Liquid staking (sSUI) | Exchange rate | Mint / redeem (SIP-33) + journey entries | LIVE |
| Volo | Liquid staking (vSUI) | Pool state, stats | Stake / unstake (min 0.1 SUI) + journey entries | LIVE |
| Metastable mSUI | LST vault | Vault state, caps, fees | Mint / burn, **SUI-direct only** (SDK selects wallet coins); mUSD/mBTC/mETH need a Pyth key the bundled SDK cannot pass — blocked | LIVE |
| Kai | Strategy vaults | Vault state, share math | Deposit / redeem + journey entries (registry note predates the Kai SDK integration) | LIVE |
| Bucket | Lending data, stable swaps | Markets, positions, PSM pools | PSM swap build; broader lending via reads | PARTIAL |
| STEAMM | Dual-asset liquidity pools | Pools, events | LP deposit / withdraw PTBs (advanced UI; excluded from single-asset flows by design) | LIVE |
| DeepBook V3 spot | Order-book trading | Markets, L2 book, open orders | Spot orders via user BalanceManager + simulation | LIVE |
| DeepBook Predict | Prediction markets | Market discovery, status | Mint / redeem / claim + simulation | LIVE |
| DeepBook margin | Margin trading | Preflight reads | Builders exist but are unwired (no API route); UI tab hidden | COMING SOON |
| Wormhole Connect (self-hosted widget) | Bridging | Widget routes | In-widget (provider-side); no signed end-to-end transfer performed by the team | PARTIAL |
| Prices (Aftermath, CoinGecko) | USD.basename views | Prices, 24h change | — | LIVE (data) |
| SuiNS | Address names | Name resolution | — (display only, falls back to short address) | PARTIAL |
| Automation | Intents, limits, scheduler | Intent evaluation, run records | None automatic — every execution needs wallet approval | PARTIAL |
| AI assistance | Explanations, live context | Live-tools router (no key needed) | None — text only; LLM answers need a server-side key | PARTIAL |
| Referrals / leaderboard | Attribution, ranking | Invitation + receipt accounting | None monetary — payouts disabled by design (`PAYOUT_ENABLED=false`) | LIVE (non-monetary) |
| SuiPump | Launchpad token metrics | Tokens, prices, bonding-curve state (read-only API) | None — factual metrics only, no recommendations | READ_ONLY |
| Bluefin Perps / Perpsplexity | Perpetuals data | Reads exist in code | No executable product surface (hidden in UI) | UNAVAILABLE |
| Registry DISCOVER-only entries (Typus, Sudo, Nemo, AlphaLend, AlphaFi, Kriya, Sui Bridge) | Discovery listings | None verified | None — Kriya sunset; others deep links only where the domain answers (Nemo link disabled: dead domain) | UNAVAILABLE |
| Seal / Walrus | — | — | Intentionally not installed | UNAVAILABLE |
| Perps grids / launchpad | — | — | Not connected; out of scope | UNAVAILABLE |

Notes:

- A protocol appearing in price lists or search results is **not** evidence of execution support — only the Transaction-build column counts.
- LST exchange rates are **not** annual yields; the UI labels them as such and never sums rates into a total.
- mSUI cross-asset (swap + mint in one transaction) is unsupported by the Metastable SDK's coin selection; the UI routes users through swap-then-mint instead of failing silently.
- Evidence for builds and reads is stored under `audit/` (JSON + screenshots). It documents engineering checks, not a security audit.
