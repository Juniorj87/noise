// HTTP helpers for Vercel Node functions: strict CORS, safe JSON errors,
// body parsing, rate limiting (spec §19, §32, §33).
import { rateLimit, clientIp } from './util.js';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://noisesui.vercel.app',
  'https://app.noisehub.xyz',
  'https://noisehub.xyz',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

/* In production the localhost defaults are NEVER active: only the two public
 * origins (or an explicit ALLOWED_ORIGINS list) are accepted. */
const PROD_DEFAULT_ORIGINS = ['https://noisesui.vercel.app', 'https://app.noisehub.xyz', 'https://noisehub.xyz'];

function envOrigins() {
  return (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function extraOrigins() {
  // Vercel preview deployments: allow *.vercel.app when explicitly enabled.
  return (process.env.ALLOW_PREVIEW_ORIGINS || '').toLowerCase() === 'true';
}

function isProduction() {
  return (process.env.VERCEL_ENV || process.env.NODE_ENV || '').toLowerCase() === 'production';
}

export function corsOrigin(req) {
  // Unknown origins get NO ACAO header (never the literal string "null").
  try {
    const asked = req.headers?.origin;
    const env = envOrigins();
    const list = isProduction()
      ? (env.length ? env : PROD_DEFAULT_ORIGINS)
      : [...env, ...DEFAULT_ALLOWED_ORIGINS];
    if (!asked) return list[0] || null;
    if (list.includes(asked)) return asked;
    if (extraOrigins() && /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(asked)) return asked;
    return null;
  } catch {
    return null;
  }
}

export function json(res, status, body, req) {
  const data = JSON.stringify(body, (_, value) => typeof value === 'bigint' ? value.toString() : value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const origin = corsOrigin(req);
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key, X-Cron-Secret, Authorization');
  res.end(data);
}

const READ_JSON = Symbol('noiseReadJson');

/**
 * Parse a JSON body AT MOST ONCE per request. A second call returns the first
 * promise — re-attaching stream listeners to an already-consumed request would
 * hang forever (no further 'end' event).
 *
 * Fail-closed contract (financial endpoints depend on it):
 * - empty body (no bytes) → {} — handlers validate required fields themselves;
 * - malformed JSON → throws INVALID_JSON (400), never a silent {};
 * - over-limit body → throws BODY_TOO_LARGE (413), connection destroyed;
 * - a truncated stream is parsed if possible, else INVALID_JSON.
 *
 * Two production facts shape this function:
 * 1. The platform may pre-parse the body (req.body). Prefer it when present.
 * 2. req.complete means fully RECEIVED, not consumed — buffered data must still
 *    be read. Only req.readableEnded means there is nothing left to read.
 *    Short-circuiting on `complete` silently drops every POST body whose bytes
 *    arrived before the function ran (production cold starts).
 */
export function readJson(req, limitBytes = 256 * 1024) {
  if (req[READ_JSON]) return req[READ_JSON];
  const invalid = () => Object.assign(new Error('Request body is not valid JSON'), { code: 'INVALID_JSON' });
  const tooLarge = () => Object.assign(new Error('Request body exceeds 256KB limit'), { code: 'BODY_TOO_LARGE', status: 413 });
  const p = new Promise((resolve, reject) => {
    // The platform may expose a pre-parsed body. Note: on Vercel, merely
    // READING req.body can throw a platform 'Invalid JSON' error for malformed
    // payloads — map it to our INVALID_JSON instead of leaking a 500.
    let pre;
    try {
      pre = req.body;
    } catch { return reject(invalid()); }
    if (pre !== undefined && pre !== null) {
      if (typeof pre === 'string') {
        if (!pre.trim()) return resolve({});
        try {
          const v = JSON.parse(pre);
          return (v && typeof v === 'object') ? resolve(v) : reject(invalid());
        } catch { return reject(invalid()); }
      }
      if (typeof pre === 'object') {
        // The app-level size limit applies to pre-parsed bodies too.
        let size = -1;
        try { size = Buffer.byteLength(JSON.stringify(pre), 'utf8'); } catch { return reject(invalid()); }
        if (size >= 0 && size > limitBytes) return reject(tooLarge());
        return resolve(pre);
      }
      return reject(invalid());
    }
    if (req.readableEnded) return resolve({});
    const chunks = [];
    let size = 0, done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    const parseChunks = () => {
      if (!chunks.length) return finish({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return (v && typeof v === 'object') ? finish(v) : fail(invalid());
      } catch { return fail(invalid()); }
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { fail(tooLarge()); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', parseChunks);
    req.on('error', parseChunks);
  });
  req[READ_JSON] = p;
  // A rejection must never become an unhandled rejection for callers that
  // attached .catch themselves — the cached promise carries it normally.
  p.catch(() => {});
  return p;
}

/**
 * Wrap a route handler with CORS preflight, rate limit and safe error mapping.
 * Errors never leak stack traces, paths, env vars or DB credentials (§33).
 */
export function handler(fn, { limit = 120 } = {}) {
  return async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return json(res, 204, {}, req);
      const url = new URL(req.url, 'http://localhost');
      const rl = rateLimit(clientIp(req) + '|' + url.pathname, limit);
      if (!rl.allowed) return json(res, 429, { error: 'RATE_LIMITED', message: 'Too many requests — slow down and retry shortly.' }, req);
      const out = await fn(req, res, url);
      // Only a NUMERIC status selects the HTTP code — payloads may carry a
      // string `status` of their own (e.g. reconciliation MATCHED/PENDING).
      const httpStatus = Number.isInteger(out && out.status) ? out.status : 200;
      if (!res.writableEnded) json(res, httpStatus, out, req);
    } catch (e) {
      const code = e.code || 'INTERNAL';
      const safe = ['INVALID_WALLET', 'INVALID_AMOUNT', 'INVALID_BPS', 'INVALID_DIGEST', 'INVALID_CODE', 'INVALID_TX', 'INVALID_OBJECT_ID',
        'INVALID_JSON', 'BODY_TOO_LARGE',
        'UNSUPPORTED_ACTION', 'UNSUPPORTED_PROVIDER', 'UNSUPPORTED_ASSET', 'UNSUPPORTED_SUI_METHOD', 'INVALID_REQUEST',
        'MISSING_WALLET', 'MISSING_ID', 'MISSING_DIGEST', 'MISSING_MESSAGE', 'MISSING_PROVIDER', 'MISSING_CODE',
        'TX_NOT_FOUND', 'TX_NOT_FOUND_ON_CHAIN', 'TX_FINAL', 'TX_BAD_TRANSITION', 'TX_TRANSITION_FAILED', 'INVALID_STATUS', 'AUTOMATION_NOT_FOUND',
        'NOT_AUTOMATION_OWNER', 'INVALID_AUTOMATION', 'UNSUPPORTED_TRIGGER', 'LIMIT_INCONSISTENT', 'LIMIT_PER_EXECUTION_INVALID',
        'LIMIT_DAILY_INVALID', 'INVALID_ACTIVITY', 'INVALID_MEMORY', 'FORBIDDEN_CONTENT', 'INVALID_CATEGORY',
        'UNAUTHORIZED', 'CRON_NOT_CONFIGURED', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'INSUFFICIENT_LIQUIDITY',
        'ALL_PROVIDERS_UNAVAILABLE', 'NO_CONFIRMED_TX', 'INVALID_NOTIFICATION', 'AI_UNAVAILABLE', 'LLM_UNAVAILABLE', 'DB_NOT_CONFIGURED',
        'DB_UNAVAILABLE', 'INVALID_BUILD_REQUEST', 'INVALID_SLIPPAGE', 'INVALID_QUOTE_REQUEST', 'INVALID_QUANTITY', 'INVALID_SPEND',
        'INVALID_REDEEM', 'INVALID_SIDE', 'INVALID_STRIKE', 'INVALID_RANGE', 'INVALID_MARKET', 'UNKNOWN_UNDERLYING',
        'MARKET_EXPIRED', 'MARKET_PAUSED', 'MARKET_UNAVAILABLE', 'QUOTE_FAILED', 'BUILD_FAILED', 'SIMULATION_FAILED',
        'PREVIEW_FAILED', 'CODE_TAKEN', 'NO_API_KEY', 'NO_MODEL', 'NO_BASE_URL'];
      console.error('[api]', code, String(e.message || e).slice(0, 300));
      // Known application errors → 400/502 with their code; only truly unknown
      // faults become 500, and internals (stacks, paths, secrets) never leak.
      const unavailable = ['PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'ALL_PROVIDERS_UNAVAILABLE', 'AI_UNAVAILABLE', 'LLM_UNAVAILABLE', 'DB_UNAVAILABLE', 'DB_NOT_CONFIGURED', 'BUILD_FAILED', 'QUOTE_FAILED', 'SIMULATION_FAILED', 'MARKET_UNAVAILABLE'];
      const status = e.status || (code === 'UNAUTHORIZED' ? 401 : code === 'CRON_NOT_CONFIGURED' ? 503 : unavailable.includes(code) ? 502 : safe.includes(code) ? 400 : 500);
      json(res, status, { error: code, message: safe.includes(code) ? String(e.message || code) : 'Internal error — nothing was signed or sent. Try again shortly.' }, req);
    }
  };
}

/** Reject non-admin callers without leaking whether ADMIN_KEY is set. */
export function requireAdmin(req) {
  const key = process.env.ADMIN_KEY;
  if (!key || req.headers['x-admin-key'] !== key) {
    throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED', status: 401 });
  }
}

export function requireQuery(url, name) {
  const v = url.searchParams.get(name);
  if (!v) throw Object.assign(new Error('MISSING_' + name.toUpperCase()), { code: 'MISSING_' + name.toUpperCase() });
  return v;
}
