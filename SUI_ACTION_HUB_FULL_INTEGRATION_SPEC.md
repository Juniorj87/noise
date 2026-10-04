# Sui Action Hub — FULL ECOSYSTEM INTEGRATION / EXECUTION SPEC
## Master task for an implementation LLM

> **IMPORTANT:** This document is an implementation specification. Do not answer with a mockup, concept, or list of ideas. Inspect the existing project, preserve the current UI, research the current Sui ecosystem, implement real integrations, and deliver a working product.
>
> The goal is to turn the existing Sui Action Hub interface into a real non-custodial execution and aggregation layer over the Sui ecosystem.

---

# 1. PRODUCT GOAL

Build a non-custodial Sui Action Hub where a user connects a Sui wallet and can discover, inspect, execute, monitor, and automate actions across the Sui ecosystem from one interface.

The user should not have to open ten different protocol websites to:

- swap tokens;
- buy/sell tokens;
- stake/unstake;
- liquid stake/un-stake;
- deposit/withdraw yield;
- supply/withdraw lending assets;
- borrow/repay;
- add/remove liquidity;
- claim rewards;
- trade on order books;
- bridge assets;
- manage supported NFT actions;
- inspect portfolio and DeFi positions;
- discover new protocols, pools, tokens and opportunities;
- create automations;
- ask an AI assistant about their real current wallet/protocol data.

This is NOT a wallet/custody product.

The platform must NEVER receive or store seed phrases/private keys.

The user's wallet signs transactions.

---

# 2. EXISTING PRODUCT SECTIONS

Keep the current visual language and concise interface.

The application should contain:

- `/app` → Capital
- `/app/discover` → Discover
- `/app/earn` → Earn
- `/app/actions` → Actions
- `/app/automation` → Automation
- `/app/activity` → Activity
- `/app/ai` → AI assistant
- `/app/token/:id` → token detail
- `/app/settings` → settings

The existing UI is intentionally concise and should remain concise.

Do NOT fill every screen with huge text.

Instead add:

- expandable "How it works";
- "Learn more";
- protocol detail drawers;
- transaction detail;
- risk/disclosure sections;
- tooltips;
- advanced details on demand.

The user should understand the important information without being overwhelmed.

---

# 3. CRITICAL RULE: RESEARCH BEFORE IMPLEMENTING

The Sui ecosystem changes quickly.

Before coding integrations:

1. Inspect the existing codebase.
2. Inventory current integrations.
3. Search the CURRENT official documentation for Sui and each protocol.
4. Identify official:
   - APIs;
   - SDKs;
   - TypeScript packages;
   - Move packages;
   - transaction builders;
   - quote endpoints;
   - indexers;
   - RPC requirements;
   - WebSocket/event APIs;
   - public REST APIs;
   - referral programs;
   - affiliate programs;
   - supported actions;
   - mainnet/testnet status;
   - rate limits;
   - fees.
5. Prefer official documentation and official GitHub repositories.
6. Do not rely on old blog posts when current documentation exists.
7. Record the date each integration was last verified.

DO NOT blindly try to "connect every website".

For each ecosystem project classify it:

- `LIVE_EXECUTION`
- `READ_ONLY`
- `DISCOVERY_ONLY`
- `DEEP_LINK_ONLY`
- `UNAVAILABLE`

Only claim an action is supported when there is a real technical path.

Never create fake successful transactions.

Never fabricate APY, TVL, liquidity, rewards, quotes, balances or protocol support.

---

# 4. ECOSYSTEM COVERAGE

Build an extensible protocol registry.

The implementation must investigate and integrate relevant Sui protocols across:

## Trading / Swap

Examples to investigate and integrate where technically available:

- Cetus
- Aftermath
- DeepBook
- Bluefin
- Turbos
- Kriya
- FlowX
- other current Sui DEXs / aggregators

Cetus must be visibly attributed when used:

`Best route via Cetus`

or

`Swap via Cetus`

Do the same for every provider.

## Lending / Borrowing

Investigate current official integrations such as:

- NAVI
- Suilend
- Scallop
- Bucket
- other current Sui lending protocols

Actions:

- supply;
- withdraw;
- borrow;
- repay;
- claim rewards;
- inspect position;
- inspect health/liquidation information where available.

## Staking / Liquid Staking

Investigate:

- native Sui staking;
- validator delegation;
- liquid staking providers;
- Aftermath;
- Haedal;
- Volo;
- SpringSui;
- other current providers.

Actions:

- stake;
- unstake;
- liquid stake;
- redeem/unstake liquid positions where supported;
- inspect validator/provider data;
- inspect expected rewards.

## Yield / Earn

Investigate current Sui yield protocols/vaults/strategies.

Actions:

- deposit;
- withdraw;
- claim;
- inspect APY/APR;
- inspect TVL;
- inspect rewards;
- inspect lock/withdrawal conditions;
- inspect protocol fees;
- inspect risks.

## Liquidity

Investigate current DEX liquidity systems.

Actions:

- add liquidity;
- remove liquidity;
- collect fees/rewards;
- inspect LP positions;
- inspect pool TVL;
- inspect fee tier;
- inspect APR/APY where available;
- concentrated liquidity ranges where supported.

## Order Books / Perpetuals / Trading

Investigate:

- DeepBook;
- Bluefin;
- other current Sui trading venues.

Where supported:

- market order;
- limit order;
- cancel;
- open orders;
- positions;
- collateral;
- margin;
- funding information.

Do not expose unsupported actions.

## Bridges

Investigate current official/active Sui bridge providers.

Support:

- source chain;
- destination chain;
- asset;
- quote;
- bridge fee;
- estimated received amount;
- transaction status.

If a provider does not expose direct execution APIs, provide discovery/deep-link integration instead.

## NFTs

Investigate current Sui NFT marketplaces and protocols.

Where technically possible:

- discover;
- inspect;
- buy;
- sell;
- transfer;
- list;
- cancel listing;
- claim;
- collection analytics.

If execution cannot safely be integrated, keep it read-only/deep-link rather than inventing support.

---

# 5. UNIVERSAL PROTOCOL ADAPTER ARCHITECTURE

Do NOT put protocol-specific logic directly into UI components.

Create an adapter layer such as:

`/integrations/{protocol}`

Each adapter should expose normalized capabilities.

Example:

```ts
interface ProtocolAdapter {
  id: string;
  name: string;
  chain: "sui";
  status: ProtocolStatus;

  getCapabilities(): Capability[];
  getMetadata(): ProtocolMetadata;

  getQuotes?(request): Promise<Quote[]>;
  getMarkets?(request): Promise<Market[]>;
  getPools?(request): Promise<Pool[]>;
  getPositions?(wallet): Promise<Position[]>;
  getBalances?(wallet): Promise<Balance[]>;
  getRewards?(wallet): Promise<Reward[]>;
  getOpportunities?(request): Promise<Opportunity[]>;

  buildAction?(request): Promise<TransactionPlan>;
  simulateAction?(plan): Promise<SimulationResult>;

  getTransactionStatus?(txDigest): Promise<TransactionStatus>;
}
```

Normalize all providers into common internal types.

Examples:

- `Token`
- `Balance`
- `Pool`
- `Position`
- `Opportunity`
- `Quote`
- `Reward`
- `LendingMarket`
- `StakePosition`
- `LiquidityPosition`
- `Order`
- `TransactionPlan`
- `SimulationResult`
- `ProtocolMetadata`

This makes the UI independent of individual protocols.

---

# 6. PROTOCOL REGISTRY

Create a registry containing:

```ts
{
  id,
  name,
  category,
  website,
  docs,
  github,
  status,
  capabilities,
  supportedChains,
  supportedAssets,
  feeModel,
  referralSupport,
  lastVerifiedAt
}
```

Status values:

- `LIVE_EXECUTION`
- `PARTIAL`
- `READ_ONLY`
- `DISCOVERY_ONLY`
- `DEEP_LINK_ONLY`
- `UNAVAILABLE`
- `MAINTENANCE`

The UI must use this registry.

Do not hardcode "supported" labels throughout the frontend.

---

# 7. CAPITAL SECTION

Capital is the user's unified Sui financial overview.

Show:

- wallet assets;
- fungible token balances;
- SUI;
- stablecoins;
- DeFi positions;
- staking;
- liquid staking;
- lending;
- borrowed assets;
- LP positions;
- rewards;
- open orders;
- supported NFT value;
- other protocol positions discovered from official/indexer data.

Important:

## DO NOT DOUBLE COUNT

If a token is deposited into a protocol, do not count it both as:

- free wallet balance;
- deposited position.

Create a normalized position model.

Example:

```text
Wallet:
100 SUI

Lending:
300 USDC supplied

Liquid staking:
50 SUI represented by afSUI

LP:
$1,200 position

Rewards:
$14.32
```

Show:

- Total Portfolio Value
- Available
- DeFi
- Staked
- Rewards
- Borrowed
- Net value where calculation is reliable

Every value should have:

- timestamp;
- source;
- freshness state.

If price is unavailable:

`Price unavailable`

Do not invent a value.

---

# 8. SWAP

Swap must be REAL.

User selects:

- input token;
- output token;
- amount;
- slippage.

System obtains real quotes from supported providers.

Display:

- provider;
- route;
- expected output;
- minimum received;
- price impact;
- network fee estimate;
- provider fee;
- platform fee;
- total cost;
- quote timestamp.

Example:

```text
Swap

100 SUI → USDC

Best route via Cetus

Expected: 352.41 USDC
Minimum received: 350.65 USDC
Price impact: 0.18%

Protocol fee: $0.00
Platform fee: $0.25
Network: ~$0.01

Total: ...
```

Provider attribution is mandatory.

Do not hide that the transaction is executed through another protocol.

---

# 9. ACTIONS SECTION

Actions is the universal execution layer.

Group actions:

## MOVE

- Swap
- Buy
- Sell
- Bridge
- Transfer where supported

## GROW

- Earn
- Supply
- Stake
- Liquid stake
- Add liquidity

## MANAGE

- Withdraw
- Unstake
- Borrow
- Repay
- Remove liquidity
- Claim rewards
- Cancel orders

Every action must follow:

```text
Select action
→ select provider
→ select asset
→ enter amount
→ fetch live data
→ show fees
→ show expected result
→ show risks
→ simulate
→ review
→ wallet confirmation
→ submit
→ track
→ final result
```

---

# 10. EARN — MUST SUPPORT REAL DEPOSITS

The current Earn page cannot only display APY percentages.

An opportunity must be actionable.

Example:

```text
USDC Earn

6.2% APY
TVL $4.8M

Via XYZ Protocol

[Deposit]
```

Clicking Deposit opens:

1. amount;
2. available balance;
3. protocol;
4. current APY;
5. estimated earnings;
6. protocol fees;
7. platform fee if applicable;
8. withdrawal conditions;
9. lock period if any;
10. risk information;
11. simulation;
12. wallet confirmation.

## MANDATORY CUSTODY DISCLOSURE

Before confirmation, prominently display:

> **Your funds will be deposited into XYZ Protocol's smart contracts. Sui Action Hub does not custody your funds.**

Also:

> APY is variable and may change. Depositing funds into third-party protocols involves smart-contract, protocol, liquidity and market risks.

Never imply that Action Hub itself holds the funds.

If the protocol is not audited or risk information is unavailable, do not invent safety claims.

---

# 11. EARN MATHEMATICS

For a simple estimate:

```text
estimatedAnnualYield =
  principal * apy
```

For an estimated period:

```text
estimatedYield =
  principal * apy * days / 365
```

For compounding where the protocol actually compounds:

```text
futureValue =
  principal * (1 + apy / periodsPerYear) ^ periods
```

Clearly label these as estimates.

Do not present estimated APY as guaranteed return.

If APY comes from an external provider, store:

```text
apy
apySource
apyTimestamp
```

If the protocol has reward emissions, separate:

- base yield;
- incentive yield;
- total displayed APY.

Do not double count reward components.

---

# 12. LENDING

Support real lending actions where official transaction paths exist.

For each market:

- asset;
- supply APY;
- borrow APY;
- liquidity;
- utilization;
- collateral factor;
- liquidation threshold;
- health factor where applicable;
- rewards;
- protocol;
- fees.

Actions:

- Supply
- Withdraw
- Borrow
- Repay
- Claim rewards

Before Borrow:

show:

```text
Collateral
Borrowed
Health Factor
Liquidation Threshold
Estimated Health After Borrow
```

Never allow the frontend to claim a position is safe without calculating from current protocol data.

---

# 13. STAKING

Support:

- native Sui staking;
- validator selection;
- stake;
- unstake;
- rewards;
- liquid staking providers.

Show:

- validator/provider;
- current APY/reward rate if available;
- commission;
- lock/unbonding period;
- expected result;
- fees.

For liquid staking:

```text
Stake 100 SUI
→ receive provider liquid staking token
```

Clearly explain:

> You receive a liquid staking asset representing your position in the external protocol.

---

# 14. LIQUIDITY

Support where provider transaction builders are available:

- add liquidity;
- remove liquidity;
- collect fees;
- inspect position;
- inspect range;
- inspect pool;
- inspect rewards.

Display:

- token pair;
- pool;
- provider;
- TVL;
- fee tier;
- APR/APY if available;
- current position;
- estimated fees;
- price range for concentrated liquidity.

For impermanent loss:

do not make fake predictions.

If calculating it, clearly label it as a model/estimate.

---

# 15. DEEPBOOK / ORDER BOOK

Where supported:

- markets;
- order book;
- bids;
- asks;
- spread;
- market order;
- limit order;
- cancel;
- open orders;
- trade history.

All numbers must be live or timestamped.

---

# 16. BRIDGE

Create a unified bridge action:

```text
From
To
Asset
Amount
Provider
Estimated receive
Bridge fee
Network fee
ETA
```

Show provider attribution.

Do not claim finality or ETA without provider data.

---

# 17. DISCOVER

Discover is not a generic news feed.

It should aggregate factual on-chain/ecosystem information:

## Tokens

- new tokens;
- volume;
- liquidity;
- holders;
- age;
- price;
- price change;
- market cap where reliable;
- liquidity;
- source.

## Pools

- new pools;
- liquidity;
- volume;
- APR where available;
- provider.

## Protocols

- new/current protocols;
- supported actions;
- TVL where reliable;
- ecosystem category;
- links;
- integration status.

## Opportunities

- new earn opportunities;
- staking;
- liquidity;
- rewards;
- campaigns if officially verified.

## Activity

- unusual volume;
- new markets;
- large on-chain activity where data source supports it.

Do not tell users:

`BUY THIS`

or

`THIS WILL PUMP`

The product should surface information and available actions.

---

# 18. AUTOMATION

The current concept:

```text
AUTOMATION

Make Sui work for you.

EXISTING AUTOMATIONS

Monitor SUI price
ACTIVE
When SUI > $5
Notify me

Find better yield
ACTIVE
Every Monday
Check available opportunities

Auto-claim rewards
ACTIVE
When rewards available
Claim automatically
```

This must become REAL.

Automations must use the same integration layer as the rest of the app.

Examples:

## Monitoring

- SUI price
- token price
- pool APY
- lending APY
- health factor
- staking rewards
- liquidity position
- new token
- new pool
- new opportunity

## Notification

- browser notification;
- email if implemented;
- Telegram/Discord integration only if configured;
- in-app notification.

## Execution

Where technically possible:

- claim rewards;
- rebalance;
- stake;
- unstake;
- withdraw;
- repay;
- swap;
- add/remove liquidity;
- other explicitly authorized actions.

---

# 19. AUTOMATION SAFETY MODEL

AI must NEVER receive private keys.

AI must NEVER have arbitrary wallet signing access.

Architecture:

```text
User instruction
↓
AI API
↓
Structured Intent
↓
Validation
↓
Permission Engine
↓
Scheduler / Event Listener
↓
Protocol Adapter
↓
Transaction Builder
↓
Simulation
↓
Permission Check
↓
Wallet Signing / Authorized Execution
↓
Result
```

Default mode:

`MONITOR + NOTIFY`

Higher-risk execution requires explicit permission.

Example:

```text
Auto-claim rewards

Protocol: XYZ
Action: Claim
Maximum per execution: $50
Daily maximum: $200
Expires: 30 days

[Enable]
```

User must be able to:

- pause;
- revoke;
- edit;
- inspect history.

Every automated execution gets an audit record.

---

# 20. AUTOMATION ENGINE

Create:

```ts
Automation {
  id;
  wallet;
  trigger;
  conditions;
  action;
  protocol;
  limits;
  permissions;
  schedule;
  status;
  expiresAt;
  createdAt;
  updatedAt;
}
```

Triggers:

- price;
- APY;
- reward availability;
- time;
- schedule;
- protocol event;
- balance;
- health factor;
- new opportunity.

Example:

```json
{
  "trigger": {
    "type": "PRICE_ABOVE",
    "asset": "SUI",
    "value": 5
  },
  "action": {
    "type": "NOTIFY"
  }
}
```

Execution automation:

```json
{
  "trigger": {
    "type": "REWARD_AVAILABLE",
    "protocol": "example"
  },
  "action": {
    "type": "CLAIM_REWARD"
  },
  "limits": {
    "maxPerExecutionUsd": 50,
    "maxDailyUsd": 200
  }
}
```

---

# 21. DOES AUTOMATION NEED AN AI API?

YES, for natural-language automation.

But AI is NOT the automation engine.

AI converts:

> "Every Monday check if there is a better USDC yield and tell me"

into structured intent:

```json
{
  "trigger": {
    "type": "SCHEDULE",
    "cron": "0 9 * * 1"
  },
  "task": {
    "type": "COMPARE_EARN"
  },
  "asset": "USDC",
  "output": "NOTIFY"
}
```

For:

> "If my rewards are above $10, claim them"

AI produces:

```json
{
  "trigger": {
    "type": "REWARD_THRESHOLD",
    "valueUsd": 10
  },
  "action": {
    "type": "CLAIM_REWARDS"
  }
}
```

Then normal deterministic code validates and executes it.

AI should NOT construct arbitrary Move calls directly.

---

# 22. AI SECTION

Add `/app/ai`.

The AI must answer using LIVE backend tools.

Create tools such as:

```ts
getPortfolio()
getBalances()
getEarnOpportunities()
getLendingMarkets()
getStakingOptions()
getLiquidityPositions()
getTokenData(token)
getProtocolDetails(protocol)
getActivity()
getRewards()
getOpenOrders()
buildAction(intent)
simulateAction(action)
compareEarn(asset)
```

Example user:

> "Where is my USDC?"

AI should inspect actual data.

Example:

> "What can I do with my 500 USDC?"

AI should inspect:

- wallet;
- lending;
- earn;
- liquidity;
- current opportunities.

It should return factual options with:

- protocol;
- APY;
- TVL;
- fees;
- risk/disclosure;
- timestamp.

Never hallucinate.

Every live data answer should have:

`Source: XYZ`
`Updated: ...`

AI model provider must be configurable via server environment.

Do not hardcode one AI provider.

---

# 23. AI SECURITY

Protocol metadata, token metadata, descriptions and external text are untrusted input.

Protect against prompt injection.

The AI must not:

- expose secrets;
- access private keys;
- bypass permission checks;
- create arbitrary transactions;
- ignore platform policy;
- claim unavailable integrations exist.

All transaction creation goes through deterministic backend validation.

---

# 24. ACTION COMPOSER

Users should be able to compose multi-step actions.

Example:

```text
Swap 100 USDC → SUI
↓
Stake SUI
↓
Deposit liquid staking token into Earn
```

Represent as:

```text
Action Plan
1. Swap
2. Stake
3. Deposit
```

Before execution:

- show each step;
- provider;
- asset;
- expected output;
- fees;
- risks;
- simulation status.

Do not promise one atomic transaction unless the actual Sui transaction can safely be built atomically.

If separate signatures/transactions are required, show them separately.

---

# 25. SIMULATION

Before any supported transaction:

1. Build transaction.
2. Simulate where possible.
3. Check:
   - expected balance changes;
   - gas;
   - failure;
   - minimum received;
   - protocol requirements;
   - object/version issues;
   - slippage;
   - allowance/authorization requirements.
4. Show result to user.
5. Request wallet signature.

If simulation is unavailable:

`Simulation unavailable — review carefully before signing.`

Never fake a simulation result.

---

# 26. FEES / COMMISSION MODEL

Implement a configurable Fee Engine.

Do NOT blindly charge every action.

The exact fee must be configurable by admin and provider.

Suggested starting framework:

## Swap

Potential platform fee:

`0.10%–0.25%`

Only charge after verifying provider economics and competitive impact.

## Earn

Prefer a transparent platform fee or revenue-share model.

If the protocol pays referral/revenue share, do not additionally hide a user fee unless explicitly justified.

Show:

```text
Protocol APY: 6.20%
Platform fee: 0.20%
Estimated net APY: 6.00%
```

Only use this formula when the fee actually affects yield in that way.

Otherwise show the fee separately.

## Lending

Prefer protocol referral/revenue-share where available.

Do not automatically add a user fee.

## Staking

Prefer provider referral/revenue share.

If a platform fee exists, show it before signing.

## Bridge

Use provider referral economics where available.

Otherwise transparent platform fee if technically/legal/business appropriate.

## NFT

Only charge if the integration supports it and economics are clear.

## Automation

Monitoring/notifications can be free.

Execution automation can use:

- platform fee;
- provider revenue share;
- subscription;
- hybrid.

Start with configurable infrastructure rather than hardcoding one business model.

---

# 27. FEE CALCULATION

Every transaction must produce:

```ts
FeeBreakdown {
  protocolFee;
  providerFee;
  platformFee;
  networkFee;
  referralShare;
  totalCost;
}
```

Display:

```text
Protocol fee     $0.18
Provider fee     $0.00
Platform fee     $0.25
Network fee      ~$0.01
-----------------------
Total            ~$0.44
```

Never hide the platform fee.

Before confirmation:

```text
You will receive approximately:
X TOKEN

Total estimated cost:
$X

Platform fee:
$X
```

---

# 28. REFERRAL SYSTEM

Implement a first-class referral system.

Each user gets:

```text
Referral ID
Referral Code
Referral Link
```

Example:

```text
https://example.com/?ref=ABC123
```

Track:

```text
referrer
referredUser
action
protocol
grossPlatformRevenue
eligibleRevenue
referralRate
referralReward
timestamp
txDigest
```

Important:

Referral calculations must NOT double count.

Example:

```text
User performs swap

Platform fee = $1.00
Referral rate = 30%

Referrer reward = $0.30
Platform retained = $0.70
```

If provider revenue share is used:

```text
Provider revenue share = $1.00

Referrer share = 30% of eligible revenue
```

Define exact accounting source.

Do not pay referral rewards from protocol funds unless explicitly supported by provider terms.

---

# 29. REFERRAL DASHBOARD

User can see:

```text
Referrals
42

Active
17

Eligible revenue
$84.20

Your referral share
$25.26

Pending
$...
Claimed
$...
```

Show:

- referral link;
- referred users count;
- eligible actions;
- generated revenue;
- earned amount;
- pending amount;
- claimed amount.

Do not expose other users' private wallet data.

---

# 30. REFERRAL ATTRIBUTION

Use:

- referral code;
- signed wallet attribution where appropriate;
- server-side attribution;
- action/transaction records.

Define an attribution window.

Example:

`30 days`

Make it configurable.

Prevent obvious abuse:

- self-referral;
- circular referrals;
- duplicate reward claims;
- fake volume;
- bot-generated referrals;
- manipulation.

---

# 31. ACTIVITY

Activity must aggregate all Action Hub actions.

Show:

- timestamp;
- action;
- asset;
- amount;
- provider;
- fee;
- platform fee;
- status;
- tx digest;
- automation/manual;
- referral information where relevant.

Statuses:

- pending;
- submitted;
- confirmed;
- failed;
- expired.

Click opens transaction details.

---

# 32. DISCOVERY DATA SOURCES

Use official APIs/SDKs/indexers/RPC where available.

For each source implement:

- caching;
- timestamps;
- rate limits;
- retry;
- exponential backoff;
- provider timeout;
- stale-data detection;
- circuit breaker;
- error state.

If provider API is down:

show:

`Provider temporarily unavailable`

not fake data.

---

# 33. DATA FRESHNESS

Every dynamic object should carry:

```ts
{
  source,
  fetchedAt,
  expiresAt?,
  isStale
}
```

Examples:

Quote: seconds

Token price: seconds/minutes

APY: minutes

TVL: minutes/hours depending on source

Protocol metadata: hours/day

The UI should visibly mark stale data when necessary.

---

# 34. MAINNET / TESTNET

Strictly separate:

- mainnet;
- testnet;
- development.

Never allow testnet addresses or packages to accidentally appear in mainnet execution.

Every protocol integration must define environment-specific:

- package IDs;
- object IDs;
- endpoints;
- API URLs;
- configuration.

---

# 35. WALLET INTEGRATION

Use the current Sui wallet ecosystem / wallet standard available at implementation time.

Support signing through the user's wallet.

Never request:

- seed phrase;
- private key;
- raw secret key.

The backend can prepare transactions but cannot silently sign them.

---

# 36. SECURITY

Mandatory:

- no custody;
- no private keys;
- no seed phrases;
- server-side secrets in environment variables;
- strict API authentication;
- rate limiting;
- audit logs;
- input validation;
- transaction simulation;
- permission checks;
- automation limits;
- daily execution limits;
- maximum transaction limits;
- expiration of automation permissions;
- revoke button;
- pause all automations;
- provider circuit breaker.

---

# 37. AUTOMATION PERMISSION MATRIX

Create explicit permission scopes.

Example:

```text
READ_PORTFOLIO
READ_PRICES
READ_EARN
READ_LENDING
READ_REWARDS

NOTIFY

PREPARE_SWAP
EXECUTE_SWAP

EXECUTE_CLAIM
EXECUTE_STAKE
EXECUTE_UNSTAKE
EXECUTE_DEPOSIT
EXECUTE_WITHDRAW
EXECUTE_REPAY
```

Dangerous permissions require:

- explicit user confirmation;
- protocol;
- action;
- asset;
- maximum amount;
- frequency;
- expiry;
- revoke.

---

# 38. INFORMATION / EDUCATION LAYER

Current pages are concise. Keep that.

Add expandable information.

Example Earn:

### How it works

`Your funds are deposited directly into XYZ Protocol's smart contracts.`

### Where are my funds?

`They remain controlled by the protocol's smart contracts and your wallet/position. Action Hub does not custody them.`

### What can change?

`APY, rewards, liquidity and protocol conditions can change.`

### Risks

- smart-contract risk;
- market risk;
- liquidity risk;
- protocol risk;
- impermanent loss where applicable.

Do not make unsupported security claims.

---

# 39. PROVIDER ATTRIBUTION

Every action must show the provider.

Examples:

```text
Swap via Cetus
Earn via NAVI
Stake via Aftermath
Supply via Suilend
Trade via DeepBook
```

The user should always know where the actual funds/action go.

---

# 40. PROVIDER DETAILS

Every provider page/drawer:

- name;
- logo;
- category;
- website;
- docs;
- supported actions;
- integration status;
- current data;
- fees;
- referral availability;
- last verified timestamp.

---

# 41. ADMIN PANEL

Build internal configuration for:

## Protocols

- enable/disable;
- maintenance;
- capabilities;
- API configuration;
- featured;
- priority.

## Fees

- fee by action;
- fee by provider;
- fixed fee;
- percentage;
- min/max;
- enable/disable.

## Referrals

- default percentage;
- provider-specific percentage;
- attribution window;
- minimum payout;
- fraud flags.

## Automation

- allowed action types;
- maximum limits;
- global emergency pause.

## AI

- model provider;
- model;
- rate limit;
- token budget;
- system prompt;
- tool permissions.

---

# 42. REVENUE ACCOUNTING

Create internal ledger records.

Example:

```ts
RevenueEntry {
  id;
  txDigest;
  wallet;
  action;
  provider;
  protocolFee;
  platformFee;
  providerRevenueShare;
  referralReward;
  netPlatformRevenue;
  timestamp;
}
```

Formula:

```text
netPlatformRevenue =
  platformRevenue
  + providerRevenueShare
  - referralReward
  - applicable costs
```

Do not confuse:

- protocol fee;
- provider fee;
- platform fee;
- gas;
- referral payout.

They are separate accounting categories.

---

# 43. UX FOR CONFIRMATION

Every action ends with a Review screen.

Example:

```text
REVIEW SWAP

100 SUI
→
352.41 USDC

Via Cetus

Minimum received:
350.65 USDC

Protocol fee:
$0.00

Platform fee:
$0.25

Network:
~$0.01

[Cancel]
[Confirm in Wallet]
```

Earn:

```text
DEPOSIT

500 USDC
→ XYZ Protocol

Current APY:
6.2%

Estimated annual yield:
$31.00

Platform fee:
$...

IMPORTANT

Your funds will be deposited into XYZ Protocol's
smart contracts. Sui Action Hub does not custody
your funds.

APY is variable.
Protocol risks apply.

[Cancel]
[Confirm in Wallet]
```

---

# 44. ERROR HANDLING

Every adapter must return normalized errors.

Examples:

```text
INSUFFICIENT_BALANCE
SLIPPAGE_EXCEEDED
QUOTE_EXPIRED
SIMULATION_FAILED
PROVIDER_UNAVAILABLE
UNSUPPORTED_ASSET
UNSUPPORTED_ACTION
USER_REJECTED
NETWORK_ERROR
OBJECT_CONFLICT
RATE_LIMITED
```

Show human-readable explanation.

Do not show raw stack traces to normal users.

Keep detailed errors in logs.

---

# 45. API DESIGN

Suggested backend:

```text
/api/capital
/api/discover
/api/tokens
/api/pools
/api/earn
/api/lending
/api/staking
/api/liquidity
/api/swaps/quote
/api/swaps/build
/api/actions/build
/api/actions/simulate
/api/actions/execute
/api/activity
/api/automation
/api/referrals
/api/fees
/api/protocols
/api/ai
```

AI endpoint must use tools rather than direct database hallucination.

---

# 46. AI TOOL ROUTER

Example:

```ts
const tools = {
  getPortfolio,
  getBalances,
  getEarnOpportunities,
  getLendingMarkets,
  getStakingOptions,
  getLiquidityPositions,
  getTokenData,
  getProtocolDetails,
  getActivity,
  getRewards,
  compareEarn,
  buildAction,
  simulateAction
};
```

The AI can call tools.

Tool results are authoritative.

The model cannot invent values that are absent from tool results.

---

# 47. AI RESPONSE FORMAT

For action recommendations, use:

```text
Option 1
Protocol: XYZ
APY: 6.2%
TVL: $...
Fees: ...
Risk/disclosure: ...
Updated: ...
[Open]

Option 2
...
```

Do not use fabricated rankings.

Do not state:

`This is guaranteed`

`Best forever`

`Risk-free`

---

# 48. DISCOVERY RANKING

If ranking opportunities, use transparent factual metrics.

Example:

```text
volume24h
liquidity
age
apy
tvl
activity
verified
```

Document the formula.

Do not present a hidden score as objective truth.

If a score is used:

`Opportunity score`

must have a visible methodology.

---

# 49. SEARCH / INDEXING

The user should be able to search:

- token;
- protocol;
- pool;
- market;
- position;
- action.

Example:

`USDC`

returns:

- wallet balance;
- Earn;
- Lending;
- Pools;
- Swap routes;
- Activity.

---

# 50. ONE UNIFIED ACTION MODEL

All providers eventually map into:

```ts
Action {
  id;
  type;
  provider;
  wallet;
  inputAssets;
  outputAssets;
  fees;
  simulation;
  transaction;
  status;
  createdAt;
}
```

Action types:

```text
SWAP
BUY
SELL
STAKE
UNSTAKE
LIQUID_STAKE
REDEEM_LST
DEPOSIT
WITHDRAW
SUPPLY
BORROW
REPAY
ADD_LIQUIDITY
REMOVE_LIQUIDITY
CLAIM
PLACE_ORDER
CANCEL_ORDER
BRIDGE
TRANSFER
NFT_BUY
NFT_SELL
NFT_TRANSFER
```

Only expose types actually implemented.

---

# 51. NO FAKE INTEGRATIONS

This is critical.

Forbidden:

- fake API responses;
- hardcoded APY;
- fake balances;
- fake transaction hashes;
- fake provider status;
- fake "successful" deposits;
- UI buttons that do nothing;
- fake automation execution;
- simulated success presented as real.

If an integration cannot be implemented:

show:

`Discovery only`

or

`Coming through provider integration`

or hide execution.

---

# 52. PERFORMANCE

Because the dashboard aggregates many protocols:

- parallelize independent requests;
- cache protocol metadata;
- cache slow-changing data;
- lazy-load expensive pages;
- avoid blocking Capital on one failed provider;
- use timeouts;
- use Promise.allSettled-like behavior;
- render available data progressively.

If Cetus is down, Capital must still load.

---

# 53. OBSERVABILITY

Add:

- structured logs;
- provider latency;
- error rates;
- integration health;
- transaction failure rate;
- quote failure rate;
- automation failures;
- AI tool errors.

Admin should see:

```text
Cetus
Healthy
Quote latency: 180ms
Errors: 0.4%
```

---

# 54. TESTING

Create:

## Unit tests

- fee calculations;
- referral calculations;
- APY estimates;
- position normalization;
- balance aggregation;
- duplicate prevention;
- automation parsing;
- permission validation.

## Integration tests

For each provider:

- quote;
- build transaction;
- simulation;
- read positions;
- read rewards.

## E2E

At minimum:

1. connect wallet;
2. Capital loads;
3. Discover loads;
4. Swap quote;
5. Earn opportunity;
6. Earn deposit flow;
7. staking flow;
8. lending flow;
9. activity;
10. automation creation;
11. AI tool call;
12. referral attribution.

Use testnet/devnet where available.

Do not run real-money destructive tests automatically.

---

# 55. IMPLEMENTATION ORDER

Follow this order.

## Phase 1 — Audit

- inspect existing project;
- identify framework;
- identify backend;
- identify wallet integration;
- identify current UI;
- identify existing APIs.

## Phase 2 — Ecosystem Registry

Create protocol registry and integration matrix.

## Phase 3 — Core Data Layer

Implement normalized:

- tokens;
- balances;
- prices;
- positions;
- providers.

## Phase 4 — Capital

Build reliable aggregation.

## Phase 5 — Swap

Integrate real providers, starting with the strongest official SDK/API paths.

Cetus must be explicitly supported if current official integration permits it.

## Phase 6 — Actions

Build universal Action model.

## Phase 7 — Earn

Implement real deposits/withdrawals and disclosures.

## Phase 8 — Staking

Native + liquid staking.

## Phase 9 — Lending

Supply/withdraw/borrow/repay/rewards.

## Phase 10 — Liquidity

Add/remove/manage.

## Phase 11 — DeepBook / Trading

Order books and supported actions.

## Phase 12 — Bridge

Current supported bridge providers.

## Phase 13 — Discover

Tokens/pools/protocols/opportunities.

## Phase 14 — Automation

Scheduler/event system + permissions.

## Phase 15 — AI

Tool-based live AI.

## Phase 16 — Referrals

Attribution + revenue ledger.

## Phase 17 — Activity

Unified history.

## Phase 18 — Admin

Protocols/fees/referrals/AI/automation controls.

## Phase 19 — Hardening

Security, rate limits, tests, monitoring, error handling.

---

# 56. ENVIRONMENT CONFIGURATION

Create `.env.example`.

Do not commit secrets.

Possible variables:

```env
SUI_NETWORK=mainnet
SUI_RPC_URL=
SUI_INDEXER_URL=

CETUS_API_URL=
AFTERMATH_API_URL=
DEEPBOOK_CONFIG=
BLUEFIN_API_URL=

NAVI_API_URL=
SUILEND_API_URL=
SCALLOP_API_URL=

AI_PROVIDER=
AI_API_KEY=
AI_MODEL=

REFERRAL_DEFAULT_RATE=
PLATFORM_SWAP_FEE_BPS=
PLATFORM_EARN_FEE_BPS=

AUTOMATION_ENABLED=
```

Only add variables for providers actually used.

---

# 57. FEE MATH

Use basis points internally.

```text
1 bps = 0.01%
100 bps = 1%
```

For percentage fee:

```text
fee = amount * feeBps / 10000
```

Example:

```text
1000 USDC
25 bps
= 1000 * 25 / 10000
= 2.50 USDC
```

Use integer-safe decimal math.

Never use floating point for financial accounting.

Use a decimal library or integer smallest units.

---

# 58. REFERRAL MATH

Example:

```text
Platform fee = $2.50
Referral rate = 30%

Referral reward =
$2.50 * 0.30
= $0.75

Platform retained =
$2.50 - $0.75
= $1.75
```

Store exact source values.

Never round intermediate accounting calculations unnecessarily.

Round only at presentation/payment boundaries.

---

# 59. EARN MATH EXAMPLE

If:

```text
principal = $1000
APY = 6.2%
```

Simple annual estimate:

```text
$1000 * 0.062 = $62
```

If platform fee is 20 bps and actually charged against principal:

```text
fee = $1000 * 0.002 = $2
```

Then display exactly what the fee applies to.

Do NOT automatically subtract a platform fee from APY unless the protocol/business model really works that way.

---

# 60. TRANSACTION COST MATH

Separate:

```text
gross output
protocol fee
provider fee
platform fee
gas
net output
```

For swaps:

```text
net received =
quoted output
- applicable fees
```

Only subtract a fee if it is actually charged in that transaction.

---

# 61. REVENUE SOURCES

The platform can potentially earn from:

1. transparent platform fees;
2. protocol referral/revenue share;
3. swap routing revenue;
4. bridge referral revenue;
5. lending/earn referral revenue;
6. automation execution fees;
7. optional subscription later.

Do not force monetization where it damages the product.

Make all rates configurable.

---

# 62. IMPORTANT LEGAL / BUSINESS IMPLEMENTATION NOTE

The implementation must not make legal/regulatory claims.

Before public launch, the owner should review:

- fee model;
- referral program;
- affiliate agreements;
- disclosures;
- jurisdictions;
- tax/accounting requirements;
- protocol terms.

The LLM should implement transparent mechanics, not invent legal conclusions.

---

# 63. DEEP LINK FALLBACK

If an official protocol does not provide safe programmatic transaction execution:

provide:

```text
Open on XYZ
```

with:

- correct provider URL;
- current asset/pool context where supported;
- clear indication that execution leaves Action Hub.

This is preferable to a fake integration.

---

# 64. INTEGRATION MATRIX

Generate a machine-readable matrix:

| Provider | Category | Read | Quote | Build TX | Simulate | Execute | Rewards | Referral | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| Cetus | Swap | ✓ | ✓ | ✓/verify | ✓/verify | ✓/verify | — | verify | LIVE/PARTIAL |
| Aftermath | Swap | ✓ | ✓ | ✓/verify | ✓/verify | ✓/verify | — | verify | ... |
| DeepBook | Trading | ✓ | ✓ | ✓ | ✓ | ✓ | — | verify | ... |
| NAVI | Lending | ✓ | — | ✓/verify | ✓/verify | ✓/verify | ✓ | verify | ... |
| Suilend | Lending | ✓ | — | ✓/verify | ✓/verify | ✓/verify | ✓ | verify | ... |

The actual values MUST be filled only after current official verification.

---

# 65. FINAL ACCEPTANCE TEST

The implementation is NOT finished when the UI looks good.

It is finished when:

- wallet connects;
- Capital displays real data;
- protocols are dynamically integrated;
- Swap returns real quotes;
- provider is shown;
- transaction can be built;
- transaction can be simulated where possible;
- wallet signs;
- Activity records result;
- Earn shows real opportunities;
- Earn deposit actually works for supported protocols;
- mandatory custody disclosure appears;
- Staking works where supported;
- Lending works where supported;
- Liquidity works where supported;
- DeepBook/trading works where supported;
- Bridge works where supported;
- Discover shows real current data;
- Automation reads the same live data;
- automation permissions work;
- automation can notify;
- authorized automation can execute supported actions;
- AI reads live tools;
- AI does not hallucinate;
- referrals are attributed;
- fees are calculated correctly;
- admin can configure fees/providers;
- failed providers do not break the entire app;
- no seed/private key is ever requested;
- no fake data exists.

---

# 66. REQUIRED DELIVERABLE FROM THE IMPLEMENTATION LLM

At the end, produce:

## A. Code

All implemented integrations and infrastructure.

## B. Integration report

For every protocol:

```text
Protocol
Category
Official docs
SDK/API
Supported actions
Implemented actions
Read-only actions
Unsupported actions
Referral availability
Fee information
Last verified
Known limitations
```

## C. Configuration

`.env.example`

## D. Database/schema changes

Explain all new tables/models.

## E. API documentation

List all backend endpoints.

## F. Automation documentation

Explain:

- triggers;
- permissions;
- execution limits;
- revoke;
- scheduler;
- event listeners.

## G. AI documentation

Explain:

- model provider;
- tools;
- prompts;
- validation;
- security;
- live data sources.

## H. Fee documentation

Explain every fee and mathematical formula.

## I. Referral documentation

Explain:

- attribution;
- rates;
- eligible revenue;
- payout;
- anti-abuse.

## J. Testing report

Show:

- tests run;
- pass/fail;
- integration status;
- known limitations.

---

# 67. FINAL PRODUCT PRINCIPLE

The entire product should feel like:

```text
I have assets
↓
What can I do?
↓
Show me real options
↓
Show me who provides them
↓
Show me fees
↓
Show me where my funds go
↓
Show me risks
↓
Simulate
↓
Let me sign
↓
Track the result
↓
Let me automate it
```

The user should not need to understand every Sui protocol.

Action Hub becomes the execution and aggregation layer over the ecosystem while protocols remain the actual underlying infrastructure.

---

# 68. NON-NEGOTIABLE RULES

1. No fake integrations.
2. No fake transactions.
3. No fake APY.
4. No fake balances.
5. No seed phrases.
6. No private-key custody.
7. No hidden platform fees.
8. Always show the actual provider.
9. Always disclose where deposited funds are held.
10. APY must be marked variable.
11. AI cannot bypass deterministic validation.
12. Automation requires explicit permissions.
13. Users can revoke automation.
14. Provider downtime must not break the entire app.
15. Current official documentation must be checked before claiming integration support.
16. Unsupported functionality must be marked unsupported/read-only/deep-link.
17. Financial calculations must use safe decimal/integer arithmetic.
18. Never double count portfolio positions.
19. Every dynamic data source needs freshness information.
20. Existing UI should be preserved unless a change materially improves usability.
21. Keep primary screens concise; put deeper explanations behind expandable UI.
22. Do not hardcode one AI provider.
23. Do not hardcode protocol fees if the provider can change them.
24. Build the system so new Sui protocols can be added as adapters without rewriting the frontend.
25. The same normalized integration layer must power Capital, Discover, Earn, Actions, Automation, Activity and AI.

---

# 69. IMPLEMENTATION COMMAND

Start by auditing the current repository and producing a short implementation map.

Then immediately begin implementation.

Do not spend the entire task writing theoretical documentation.

Do not create mock integrations when a real integration is possible.

Do not stop after frontend work.

Work through the full stack:

```text
UI
→ API
→ integration adapter
→ official SDK/API/RPC/indexer
→ transaction builder
→ simulation
→ wallet signing
→ transaction tracking
→ activity
→ automation
→ AI tools
→ fee accounting
→ referral accounting
```

At every stage, prefer a smaller number of REAL working integrations over a large number of fake buttons.

However, the final architecture must make it straightforward to continuously add the rest of the Sui ecosystem through adapters.

**The end goal is a real Sui Action Hub, not a dashboard mockup.**
