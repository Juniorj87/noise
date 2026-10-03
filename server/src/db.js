// SQLite persistence (node:sqlite, zero native deps). Spec §5.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const DB_PATH = process.env.DB_PATH || './data/hub.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  chain TEXT NOT NULL DEFAULT 'sui',
  network TEXT NOT NULL DEFAULT 'mainnet',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tokens (
  coin_type TEXT PRIMARY KEY,
  symbol TEXT, decimals INTEGER, coingecko_id TEXT, updated_at TEXT
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
  asset TEXT NOT NULL, apy REAL, apy_source TEXT, apy_at TEXT,
  tvl TEXT, kind TEXT NOT NULL DEFAULT 'earn',
  conditions TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL, protocol_id TEXT, kind TEXT NOT NULL,
  asset TEXT, amount TEXT, value_usd TEXT,
  source TEXT NOT NULL DEFAULT 'rpc',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL, action TEXT NOT NULL, provider TEXT,
  input_asset TEXT, input_amount TEXT, output_asset TEXT, output_amount TEXT,
  fees_json TEXT, digest TEXT, status TEXT NOT NULL DEFAULT 'pending',
  origin TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_wallet ON transactions(wallet);
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL, action TEXT NOT NULL, provider TEXT,
  asset TEXT, amount TEXT, fees_json TEXT, digest TEXT,
  status TEXT NOT NULL DEFAULT 'submitted', origin TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_act_wallet ON activities(wallet);
CREATE TABLE IF NOT EXISTS fees (
  id TEXT PRIMARY KEY,
  tx_id TEXT REFERENCES transactions(id),
  protocol_fee TEXT, provider_fee TEXT, platform_fee TEXT,
  network_fee TEXT, total TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS revenue_entries (
  id TEXT PRIMARY KEY,
  tx_id TEXT, wallet TEXT, action TEXT, provider TEXT, digest TEXT,
  platform_fee TEXT, provider_share TEXT, referral_reward TEXT,
  net_revenue TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE, referrer_wallet TEXT,
  referred_wallet TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS referral_rewards (
  id TEXT PRIMARY KEY,
  referral_id TEXT REFERENCES referrals(id),
  revenue_id TEXT REFERENCES revenue_entries(id),
  amount TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL, title TEXT NOT NULL,
  trigger_json TEXT NOT NULL, action_json TEXT NOT NULL,
  max_per_execution_usd REAL NOT NULL, max_daily_usd REAL NOT NULL,
  expires_at TEXT, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id),
  result TEXT NOT NULL, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS permissions (
  wallet TEXT NOT NULL, scope TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (wallet, scope)
);
CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT PRIMARY KEY,
  wallet TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
  tools_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memory_records (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL, category TEXT NOT NULL,
  content_cipher TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'in-app',
  title TEXT NOT NULL, body TEXT, read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL, latency_ms INTEGER,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

db.exec(SCHEMA);

/* ---- Migrations for pre-existing DB files (CREATE TABLE IF NOT EXISTS won't alter them) ---- */
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
function ensureColumn(table, ddl) {
  const col = ddl.trim().split(/\s+/)[0];
  if (!columnExists(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
// transactions: full lifecycle fields (§3)
['expected_output TEXT', 'actual_output TEXT', 'protocol_fee TEXT', 'provider_fee TEXT',
 'platform_fee TEXT', 'gas TEXT', 'failure_reason TEXT', 'source TEXT',
 'updated_at TEXT',
].forEach((ddl) => ensureColumn('transactions', ddl));
db.exec(`UPDATE transactions SET source = 'manual' WHERE source IS NULL`);
db.exec(`UPDATE transactions SET updated_at = created_at WHERE updated_at IS NULL`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_digest_unique ON transactions(digest)');
db.exec('CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status)');
// automations: run bookkeeping & persistence (§7)
['type TEXT', 'intent TEXT', 'protocol TEXT', 'conditions_json TEXT', 'limits_json TEXT',
 'updated_at TEXT', 'last_run_at TEXT', 'next_run_at TEXT', 'last_result TEXT', 'failure_reason TEXT',
].forEach((ddl) => ensureColumn('automations', ddl));
db.exec(`UPDATE automations SET updated_at = created_at WHERE updated_at IS NULL`);
db.exec('CREATE INDEX IF NOT EXISTS idx_auto_wallet ON automations(wallet)');
db.exec('CREATE INDEX IF NOT EXISTS idx_auto_status ON automations(status)');

// revenue & referrals: attribution hardening (§12, §32)
['referrer_wallet TEXT', 'referred_wallet TEXT', 'eligible_revenue TEXT',
 'referral_rate TEXT', 'gross_revenue TEXT',
].forEach((ddl) => ensureColumn('revenue_entries', ddl));
ensureColumn('referrals', 'updated_at TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_rev_digest_unique ON revenue_entries(digest)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_rew_revenue_unique ON referral_rewards(revenue_id)');

const SEED = [
  ['cetus', 'Cetus', 'swap', 'https://app.cetus.zone', 'https://cetus-1.gitbook.io/cetus-developer-docs', 'LIVE_EXECUTION', '["quote","build-tx","simulate","execute"]', 'pool fee + platform bps', 'partner closed to new teams → policy 0', '2026-10-01'],
  ['sui-native', 'Sui Native Staking', 'staking', 'https://sui.io', 'https://docs.sui.io', 'PARTIAL', '["read","simulate"]', 'validator commission', '—', '2026-10-01'],
  ['navi', 'NAVI', 'lending', 'https://naviprotocol.io', 'https://docs.naviprotocol.io', 'BLOCKED', '[]', 'referral-share first', 'terms unverified → policy 0', '2026-10-01'],
  ['suilend', 'Suilend', 'lending', 'https://suilend.fi', 'https://docs.suilend.fi', 'BLOCKED', '[]', 'referral-share first', 'terms unverified → policy 0', '2026-10-01'],
  ['aftermath', 'Aftermath', 'swap/lst', 'https://aftermath.finance', 'https://docs.aftermath.finance', 'PARTIAL', '["quote","prices","pools","rewards","staking-apy"]', 'router: no protocol fee; pools 0.30%/0.10% + 0.005%', 'perps 10%/5%; router 2.5% of integrator fee', '2026-10-01'],
  ['deepbook', 'DeepBook', 'trading', 'https://deepbook.tech', 'https://docs.sui.io', 'PARTIAL', '["markets","orderbook"]', 'verify', '—', '2026-10-01'],
  ['turbos', 'Turbos', 'swap', 'https://turbos.finance', 'https://docs.turbos.finance', 'DEEP_LINK_ONLY', '["pools"]', 'verify', 'verify', '2026-09-30'],
  ['haedal', 'Haedal', 'lst', 'https://haedal.xyz', 'https://docs.haedal.xyz', 'READ_ONLY', '["stake-quote","positions"]', 'verify', 'verify', '2026-09-30'],
  ['bluefin', 'Bluefin', 'trading', 'https://bluefin.io', 'https://docs.bluefin.io', 'DEEP_LINK_ONLY', '["markets"]', 'verify', 'verify', '2026-09-30'],
  ['scallop', 'Scallop', 'lending', 'https://scallop.io', 'https://docs.scallop.io', 'DEEP_LINK_ONLY', '["markets"]', 'verify', 'verify', '2026-09-30'],
  ['volo', 'Volo', 'lst', 'https://volo.fi', 'https://docs.volo.fi', 'DEEP_LINK_ONLY', '["pools"]', 'verify', 'verify', '2026-09-30'],
];
const upsert = db.prepare(`INSERT INTO protocols
  (id,name,category,website,docs,status,capabilities,fee_model,referral_support,last_verified)
  VALUES (?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, status=excluded.status, last_verified=excluded.last_verified`);
for (const row of SEED) upsert.run(...row);

export function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + randomBytes(4).toString('hex');
}
