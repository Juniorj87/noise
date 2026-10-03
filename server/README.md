# NOISE HUB API

Non-custodial backend for the NOISE HUB frontend. Node 22+, SQLite built-in
(`node:sqlite`) — no native addons. Two real SDKs: `@mysten/sui`, `@cetusprotocol/aggregator-sdk`.

```bash
cd server
npm install
npm test
npm start            # PORT=3001, DB_PATH=./data/hub.db
```

Env (see root `.env.example`):

```env
PORT=3001
DB_PATH=./data/hub.db
SUI_NETWORK=mainnet
SUI_RPC_URL=https://sui-rpc.publicnode.com
CETUS_API_URL=https://api-sui.cetus.zone
LLM_API_KEY=            # optional — AI provider passthrough
LLM_MODEL=
ADMIN_KEY=change-me     # required for /api/admin/*
PLATFORM_SWAP_FEE_BPS=20
PLATFORM_EARN_FEE_BPS=0
REFERRAL_DEFAULT_RATE=30
REFERRAL_WINDOW_DAYS=30
```

Never commits secrets. Never handles private keys or seeds.
