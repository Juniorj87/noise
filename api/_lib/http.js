// HTTP helpers for Vercel Node functions: strict CORS, safe JSON errors,
// body parsing, rate limiting (spec §19, §32, §33).
import { rateLimit } from './util.js';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://app.noisehub.xyz',
  'https://noisehub.xyz',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

function envOrigins() {
  return (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function extraOrigins() {
  // Vercel preview deployments: allow *.vercel.app when explicitly enabled.
  return (process.env.ALLOW_PREVIEW_ORIGINS || '').toLowerCase() === 'true';
}

export function corsOrigin(req) {
  try {
    const asked = req.headers?.origin;
    const list = [...envOrigins(), ...DEFAULT_ALLOWED_ORIGINS];
    if (!asked) return list[0];
    if (list.includes(asked)) return asked;
    if (extraOrigins() && /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(asked)) return asked;
    return 'null';
  } catch {
    return 'null';
  }
}

export function json(res, status, body, req) {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', corsOrigin(req));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key, X-Cron-Secret, Authorization');
  res.end(data);
}

export function readJson(req, limitBytes = 256 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { resolve({}); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
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
      const rl = rateLimit((req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'anon') + '|' + url.pathname, limit);
      if (!rl.allowed) return json(res, 429, { error: 'RATE_LIMITED', message: 'Too many requests — slow down and retry shortly.' }, req);
      const out = await fn(req, res, url);
      if (!res.writableEnded) json(res, out && out.status ? out.status : 200, out, req);
    } catch (e) {
      const code = e.code || 'INTERNAL';
      const safe = ['INVALID_WALLET', 'INVALID_AMOUNT', 'INVALID_BPS', 'INVALID_DIGEST', 'INVALID_CODE', 'INVALID_TX', 'INVALID_OBJECT_ID',
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
