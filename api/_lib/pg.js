// Serverless Postgres layer (spec §6, §22, §34). Production: any Postgres via
// DATABASE_URL (Neon recommended — pooled connection string). No filesystem DB,
// no busy loops; schema auto-applied once per cold start.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOLS } from '../../shared/registry.js';

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
    // The seed MUST be awaited: a fire-and-forget seed can silently fail or be
    // cut off when the instance is reused, leaving /api/protocols stale (it
    // served an 11-row legacy registry while the canonical registry has 32).
    schemaReady = getPool().query(ddl)
      .then(() => seedProtocols())
      .then(() => true)
      .catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// Seed derives from the single canonical registry (shared/registry.js).
// Unified status vocabulary: LIVE / PARTIAL / DISCOVER / COMING_SOON.
// Upsert repairs EVERY canonical field (not just name/status), and legacy rows
// that are no longer in the registry are disabled so they never surface as
// live protocols.
async function seedProtocols() {
  const rows = PROTOCOLS.map((x) => [
    x.id, x.name, x.category, x.url, x.docs, x.status,
    JSON.stringify(x.actions), x.fee, x.ref, x.last,
  ]);
  const pool = getPool();
  for (const r of rows) {
    await pool.query(
      `INSERT INTO protocols (id,name,category,website,docs,status,capabilities,fee_model,referral_support,last_verified,enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, category=EXCLUDED.category, website=EXCLUDED.website,
         docs=EXCLUDED.docs, status=EXCLUDED.status, capabilities=EXCLUDED.capabilities,
         fee_model=EXCLUDED.fee_model, referral_support=EXCLUDED.referral_support,
         last_verified=$10, enabled=1`,
      r);
  }
  // Retire (do not delete) rows that are no longer part of the canonical
  // registry: keeps history, removes them from listProtocols() (enabled = 1).
  const ids = PROTOCOLS.map((x) => x.id);
  await pool.query(
    'UPDATE protocols SET enabled = 0 WHERE NOT (id = ANY($1::text[]))',
    [ids]);
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
