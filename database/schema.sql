-- Sui Action Hub — PostgreSQL schema (Vercel/Neon production).
-- Ported 1:1 from server/src/db.js (SQLite). No business-logic changes.
-- Applied automatically on first API call (api/_lib/pg.js → ensureSchema) or manually via psql.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  chain TEXT NOT NULL DEFAULT 'sui',
  network TEXT NOT NULL DEFAULT 'mainnet',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tokens (
  coin_type TEXT PRIMARY KEY,
  symbol TEXT, decimals INTEGER, coingecko_id TEXT, updated_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS protocols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL, category TEXT NOT NULL,
  website TEXT, docs TEXT, status TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  fee_model TEXT, referral_support TEXT,
  last_verified TEXT, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  protocol_id TEXT NOT NULL REFERENCES protocols(id),
  asset TEXT NOT NULL, apy REAL, apy_source TEXT, apy_at TIMESTAMPTZ,
  tvl TEXT, kind TEXT NOT NULL DEFAULT 'earn',
  conditions TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL, protocol_id TEXT, kind TEXT NOT NULL,
  asset TEXT, amount TEXT, value_usd TEXT,
  source TEXT NOT NULL DEFAULT 'rpc',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL, action TEXT NOT NULL, provider TEXT,
  input_asset TEXT, input_amount TEXT, output_asset TEXT, output_amount TEXT,
  fees_json TEXT, digest TEXT, status TEXT NOT NULL DEFAULT 'pending',
  origin TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_output TEXT, actual_output TEXT,
  protocol_fee TEXT, provider_fee TEXT, platform_fee TEXT,
  gas TEXT, failure_reason TEXT, source TEXT, updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tx_wallet ON transactions(wallet);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_digest_unique ON transactions(digest);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL, action TEXT NOT NULL, provider TEXT,
  asset TEXT, amount TEXT, fees_json TEXT, digest TEXT,
  status TEXT NOT NULL DEFAULT 'submitted', origin TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_act_wallet ON activities(wallet);

CREATE TABLE IF NOT EXISTS fees (
  id TEXT PRIMARY KEY,
  tx_id TEXT REFERENCES transactions(id),
  protocol_fee TEXT, provider_fee TEXT, platform_fee TEXT,
  network_fee TEXT, total TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS revenue_entries (
  id TEXT PRIMARY KEY,
  tx_id TEXT, wallet TEXT, action TEXT, provider TEXT, digest TEXT,
  platform_fee TEXT, provider_share TEXT, referral_reward TEXT,
  net_revenue TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  referrer_wallet TEXT, referred_wallet TEXT, eligible_revenue TEXT,
  referral_rate TEXT, gross_revenue TEXT,
  gross_amount TEXT, gross_asset TEXT NOT NULL DEFAULT 'USDC',
  status TEXT NOT NULL DEFAULT 'confirmed', confirmed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rev_digest_unique ON revenue_entries(digest);

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE, referrer_wallet TEXT,
  referred_wallet TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TEXT, updated_at TIMESTAMPTZ,
  attributed_at TIMESTAMPTZ, source TEXT, status TEXT NOT NULL DEFAULT 'attributed'
);
CREATE TABLE IF NOT EXISTS referral_rewards (
  id TEXT PRIMARY KEY,
  referral_id TEXT REFERENCES referrals(id),
  revenue_id TEXT REFERENCES revenue_entries(id),
  referrer TEXT, amount TEXT NOT NULL, asset TEXT NOT NULL DEFAULT 'USDC',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ, tx_digest TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rew_revenue_unique ON referral_rewards(revenue_id);

-- Payout intents (stage 1: record only — no auto-send, no private key anywhere).
-- Settlement happens via a dedicated signer in stage 2; here we only track.
CREATE TABLE IF NOT EXISTS referral_payouts (
  id TEXT PRIMARY KEY,
  referrer TEXT NOT NULL,
  amount TEXT NOT NULL, asset TEXT NOT NULL DEFAULT 'USDC',
  destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_digest TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);

-- On-chain reconciliation audit (DB expected vs revenue-wallet observed).
CREATE TABLE IF NOT EXISTS revenue_reconciliation (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL DEFAULT 'all',
  expected TEXT NOT NULL, received TEXT NOT NULL, difference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail TEXT
);

-- One row per attributed wallet: a single code/link can attribute MANY wallets.
-- First attribution wins — it is never overwritten (server-side, see services).
CREATE TABLE IF NOT EXISTS referral_attributions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  referrer TEXT,
  referred_wallet TEXT NOT NULL UNIQUE,
  attributed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT,
  status TEXT NOT NULL DEFAULT 'attributed'
);
-- Backfill legacy single-slot rows (idempotent — rerunnable on every deploy).
INSERT INTO referral_attributions (id, code, referrer, referred_wallet, attributed_at, status)
SELECT 'att_' || substr(r.id, 1, 40), r.code, r.referrer_wallet, r.referred_wallet, r.created_at, 'attributed'
FROM referrals r
WHERE r.referred_wallet IS NOT NULL AND r.referrer_wallet IS NOT NULL
ON CONFLICT (referred_wallet) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referrals(referrer_wallet);
CREATE INDEX IF NOT EXISTS idx_ref_referred ON referrals(referred_wallet);
CREATE INDEX IF NOT EXISTS idx_ref_status ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_attr_code ON referral_attributions(code);
CREATE INDEX IF NOT EXISTS idx_attr_referrer ON referral_attributions(referrer);
CREATE INDEX IF NOT EXISTS idx_attr_status ON referral_attributions(status);
CREATE INDEX IF NOT EXISTS idx_rew_referrer ON referral_rewards(referrer);
CREATE INDEX IF NOT EXISTS idx_rew_status ON referral_rewards(status);
CREATE INDEX IF NOT EXISTS idx_payout_referrer ON referral_payouts(referrer);
CREATE INDEX IF NOT EXISTS idx_payout_status ON referral_payouts(status);
CREATE INDEX IF NOT EXISTS idx_rev_referrer ON revenue_entries(referrer_wallet);
CREATE INDEX IF NOT EXISTS idx_rev_provider ON revenue_entries(provider);
CREATE INDEX IF NOT EXISTS idx_rev_action ON revenue_entries(action);
CREATE INDEX IF NOT EXISTS idx_rev_created ON revenue_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_rev_status ON revenue_entries(status);
CREATE INDEX IF NOT EXISTS idx_tx_provider ON transactions(provider);
CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL, title TEXT NOT NULL,
  trigger_json TEXT NOT NULL, action_json TEXT NOT NULL,
  max_per_execution_usd REAL NOT NULL, max_daily_usd REAL NOT NULL,
  expires_at TEXT, status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  type TEXT, intent TEXT, protocol TEXT, conditions_json TEXT, limits_json TEXT,
  updated_at TIMESTAMPTZ, last_run_at TIMESTAMPTZ, next_run_at TIMESTAMPTZ,
  last_result TEXT, failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_auto_wallet ON automations(wallet);
CREATE INDEX IF NOT EXISTS idx_auto_status ON automations(status);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id),
  result TEXT NOT NULL, detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_runs_auto ON automation_runs(automation_id);

CREATE TABLE IF NOT EXISTS permissions (
  wallet TEXT NOT NULL, scope TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, scope)
);
CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT PRIMARY KEY,
  wallet TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
  tools_json TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memory_records (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL, category TEXT NOT NULL,
  content_cipher TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'in-app',
  title TEXT NOT NULL, body TEXT, read INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL, latency_ms INTEGER,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DeepBook orders: server-side record; order status is resolved from the chain and
-- is distinct from transaction status. (wallet, order_id, market) unique — no dupes.
CREATE TABLE IF NOT EXISTS deepbook_orders (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  market TEXT NOT NULL,
  order_id TEXT,
  side TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'LIMIT',
  price TEXT,
  quantity TEXT NOT NULL,
  filled_quantity TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'OPEN',
  tx_digest TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dborders_unique ON deepbook_orders(wallet, market, order_id);
CREATE INDEX IF NOT EXISTS idx_dborders_wallet ON deepbook_orders(wallet);
CREATE INDEX IF NOT EXISTS idx_dborders_status ON deepbook_orders(status);
CREATE INDEX IF NOT EXISTS idx_dborders_pending ON deepbook_orders(wallet, market) WHERE status IN ('OPEN','PARTIALLY_FILLED');
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fee configuration indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_config_fee_prefix ON config(key) WHERE key LIKE 'fee:%';
