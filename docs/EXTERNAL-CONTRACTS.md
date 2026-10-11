# External Move contracts

Pinned third-party contract references used by Noise Hub builders, reviewed 2026-10-10. This is a pinning inventory, not an independent smart-contract audit.

## Verification status per protocol

| Protocol | Pinned IDs (ours) | Entry points called | ID source | Cross-check |
|---|---|---|---|---|
| Haedal | staking pkg `0x126e…b5442a62`, staking obj `0x47b2…80849b2ca`, HASUI type `0xbde4…::hasui::HASUI`, ticket `…::staking::UnstakeTicket` | `staking::get_exchange_rate`, `request_stake_coin`, `request_unstake_instant_v2`, `request_unstake_delay`, `claim_v2` | Hardcoded | Matches official `haedal-protocol-interface` repo (package, staking ID, same entries) |
| Volo (NAVI) | package `0x68d2…dae20`, pool `0x2d91…587840e5`, metadata `0x680c…8dfde389a60`, CERT type `0x549e…::cert::CERT` | `stake_pool::stake_entry`, `stake_pool::unstake_entry` | Hardcoded | Matches Volo API reference + Navi SDK defaults (`packageId`, `poolId`); arg order matches official snippet; entry functions transfer receipts to sender internally |
| SpringSui | LST obj `0x15ed…ad394f6b`, type `0x8355…::spring_sui::SPRING_SUI`, weightHook `0xbbaf…890f1f144` | via `LstClient.mint/redeem` | Hardcoded IDs, calls inside `@suilend/springsui-sdk` | IDs match Suilend SpringSui integration docs |
| Suilend | market/type IDs | deposit/withdraw/borrow/repay/claim | Inside `@suilend/sdk` (`LENDING_MARKET_ID/TYPE`) | SDK-pinned, not independently reviewed |
| NAVI lending | pool IDs dynamic | deposit/withdraw/borrow/repay/claim PTBs | Inside `@naviprotocol/lending` | SDK-pinned, not independently reviewed |
| Scallop | addressId `695fcdc084f790c04eb068dc` | supply/withdraw/borrow/repay via builder | Inside `@scallop-io/sui-scallop-sdk` | SDK-pinned, not independently reviewed |
| Metastable | vault/coin IDs | `buildMintTx`/`buildBurnTx` | Inside `metastable-ts-sdk` (`M_SUI` etc.) | SDK-pinned, not independently reviewed |
| Kai | vault object IDs | `deposit`/`withdraw` | Inside `@kunalabs-io/kai` | SDK-pinned, not independently reviewed |
| Aftermath | pool/object IDs | Router trade route, staking txs | Inside `aftermath-ts-sdk` + REST | SDK-pinned, not independently reviewed |
| Cetus/Turbos venues | coin types (SUI/CETUS/DEEP/USDC/NAVX) | `findRouters`/`routerSwap` | Inside `@cetusprotocol/aggregator-sdk` | SDK-pinned, not independently reviewed |
| DeepBook spot/margin/Predict | pool addresses, margin pool IDs | place/cancel/order, margin manager, mint/redeem/claim | Inside `@mysten/deepbook-v3` (+predict) | SDK-pinned, not independently reviewed |
| STEAMM | `packages.steamm.packageId` | quote/deposit/redeem liquidity | Inside `@suilend/steamm-sdk` (`MAINNET_CONFIG`) | SDK-pinned, not independently reviewed |
| Bucket | collateral/pool IDs | PSM swap builds | Inside `@bucket-protocol/sdk` | SDK-pinned, not independently reviewed |
| Sui native | `0x3::sui_system::request_add_stake`, `request_withdraw_stake`, `0x5` system state | stake/unstake | Hardcoded (Sui framework) | Framework addresses; behavior defined by Sui itself |
| Sui framework utils | `0x2::coin::{into_balance,from_balance,value}`, `0x2::sui::SUI`, clock `0x6` | coin plumbing in composed PTBs | Hardcoded (Sui framework) | Framework addresses |

Duplicate pins exist in two modules (`VOLO` in `protocol-execution.js` + `journey-providers.js`; `SPRING_LST` in `lending.js` + `journey-providers.js`). Values verified identical; consolidation is deferred to avoid touching working execution paths.

## Explicit limitations (out of scope)

- No Move bytecode or source audit was performed for any third-party package. “Works via SDK” is not a contract audit.
- Upgradeability: Sui packages are immutable only if the upgrade cap was destroyed — this was NOT verified per protocol. A protocol upgrade (or SDK major bump changing pinned IDs) can silently change behavior; the simulation gate and review screen remain the last line of defense.
- Object IDs (pools, vaults, metadata) are live objects: they can be mutated by their owners through legitimate protocol operations. Reads are always fresh; never cached across review and signing.
- If Noise Hub ever ships its own Move contracts, they require a separate on-chain audit. None exist in this repository.
