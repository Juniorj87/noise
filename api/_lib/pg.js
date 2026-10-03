// Serverless Postgres layer (spec §6, §22, §34). Production: any Postgres via
// DATABASE_URL (Neon recommended — pooled connection string). No filesystem DB,
// no busy loops; schema auto-applied once per cold start.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pool = null;
let schemaReady = null;

export function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw Object.assign(new Error('DATABASE_URL_NOT_CONFIGURED'), { code: 'DB_NOT_CONFIGURED', status: 503 });
    pool = new pg.Pool({
      connectionString: url,
      max: 3,                      // serverless-safe ceiling per instance
      idleTimeoutMillis: 15_000,
      connectionTimeoutMillis: 10_000,
      ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
    });
    pool.on('error', (e) => console.error('[pg] idle client error:', String(e.message || e).slice(0, 200)));
  }
  return pool;
}

export function ensureSchema() {
  if (!schemaReady) {
    const ddl = readFileSync(join(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
    schemaReady = getPool().query(ddl).then(() => {
      seedProtocols();
      return true;
    }).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

async function seedProtocols() {
  const rows = [
    ['cetus', 'Cetus', 'swap', 'https://app.cetus.zone', 'https://cetus-1.gitbook.io/cetus-developer-docs', 'LIVE_EXECUTION', '["quote","build-tx","simulate","execute"]', 'pool fee + platform bps', 'partner closed to new teams → policy 0'],
    ['sui-native', 'Sui Native Staking', 'staking', 'https://sui.io', 'https://docs.sui.io', 'PARTIAL', '["read","simulate"]', 'validator commission', '—'],
    ['navi', 'NAVI', 'lending', 'https://naviprotocol.io', 'https://docs.naviprotocol.io', 'BLOCKED', '[]', 'referral-share first', 'terms unverified → policy 0'],
    ['suilend', 'Suilend', 'lending', 'https://suilend.fi', 'https://docs.suilend.fi', 'BLOCKED', '[]', 'referral-share first', 'terms unverified → policy 0'],
    ['aftermath', 'Aftermath', 'swap/lst', 'https://aftermath.finance', 'https://docs.aftermath.finance', 'PARTIAL', '["quote","prices","pools","rewards","staking-apy"]', 'router: no protocol fee; pools 0.30%/0.10% + 0.005%', 'perps 10%/5%; router 2.5% of integrator fee'],
    ['deepbook', 'DeepBook', 'trading', 'https://deepbook.tech', 'https://docs.sui.io', 'PARTIAL', '["markets","orderbook"]', 'verify', '—'],
    ['turbos', 'Turbos', 'swap', 'https://turbos.finance', 'https://docs.turbos.finance', 'DEEP_LINK_ONLY', '["pools"]', 'verify', 'verify'],
    ['haedal', 'Haedal', 'lst', 'https://haedal.xyz', 'https://docs.haedal.xyz', 'READ_ONLY', '["stake-quote","positions"]', 'verify', 'verify'],
    ['bluefin', 'Bluefin', 'trading', 'https://bluefin.io', 'https://docs.bluefin.io', 'DEEP_LINK_ONLY', '["markets"]', 'verify', 'verify'],
    ['scallop', 'Scallop', 'lending', 'https://scallop.io', 'https://docs.scallop.io', 'DEEP_LINK_ONLY', '["markets"]', 'verify', 'verify'],
    ['volo', 'Volo', 'lst', 'https://volo.fi', 'https://docs.volo.fi', 'DEEP_LINK_ONLY', '["pools"]', 'verify', 'verify'],
  ];
  for (const r of rows) {
    await getPool().query(
      `INSERT INTO protocols (id,name,category,website,docs,status,capabilities,fee_model,referral_support,last_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()::text)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status, last_verified=now()::text`,
      r);
  }
}

/** DB-backed admin config (runtime fee overrides survive cold starts). */
export async function getConfig(key, fallback = null) {
  await ensureSchema();
  const r = await getPool().query('SELECT value FROM config WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : fallback;
}

export async function setConfig(key, value) {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, String(value)]);
}

/** Optional shared secret: gate cron + mutating endpoints when set. */
export function cronConfigured() {
  return Boolean(process.env.CRON_SECRET);
}
export function checkSecret(req, name = 'CRON_SECRET') {
  const secret = process.env[name];
  // Production rule: without a configured secret the endpoint stays CLOSED.
  // Callers must check cronConfigured() first and answer 503, never 200-open.
  if (!secret) return false;
  // Header-only auth. The legacy `?secret=` query path is removed: URLs leak
  // into logs / history, headers do not.
  const auth = req.headers.authorization || '';
  const headerSecret = req.headers['x-cron-secret']
    || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
  return headerSecret === secret;
}

/** True when the deployment has no DATABASE_URL (local SQLite fallback active). */
export function dbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}
