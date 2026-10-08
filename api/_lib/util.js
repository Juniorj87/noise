// Cache / rate-limit / circuit-breaker / health — instance-local only.
// No authoritative in-memory state (spec §38): everything durable lives in Postgres.
const cache = new Map();

export function cached(key, ttlMs, fn, forceRefresh = false) {
  const hit = cache.get(key);
  const now = Date.now();
  if (!forceRefresh && hit && now - hit.at < ttlMs) return hit.value;
  return Promise.resolve(fn()).then((v) => { cache.set(key, { at: now, value: v }); return v; });
}

export function cacheSize() { return cache.size; }

export function invalidateCache(prefixOrKey) {
  for (const k of cache.keys()) {
    if (k === prefixOrKey || k.startsWith(prefixOrKey)) cache.delete(k);
  }
}

const buckets = new Map();

/* Client IP that cannot be trivially spoofed: platform-set x-real-ip wins;
 * otherwise the LAST X-Forwarded-For hop (added by the closest trusted
 * proxy), never the attacker-controlled first entry. Dev/direct connections
 * fall back to the socket address. */
export function clientIp(req) {
  try {
    const real = String(req.headers?.['x-real-ip'] || '').trim();
    if (real) return real.split(',')[0].trim();
    const xff = String(req.headers?.['x-forwarded-for'] || '').trim();
    if (xff) {
      const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
    return req.socket?.remoteAddress || 'anon';
  } catch {
    return 'anon';
  }
}

export function rateLimit(key, max = 60, windowMs = 60_000) {
  const now = Date.now();
  const b = buckets.get(key) || { count: 0, reset: now + windowMs };
  if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
  b.count += 1;
  buckets.set(key, b);
  // Bound memory: drop expired buckets once the table grows large.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (now > v.reset) buckets.delete(k);
      if (buckets.size <= 4000) break;
    }
  }
  return { allowed: b.count <= max, remaining: Math.max(0, max - b.count) };
}

/** Health snapshot of every provider the circuit breaker has seen (spec #3).
 *  OPERATIONAL · DEGRADED (recent failures) · OFFLINE (breaker open). */
export function providerHealth() {
  const now = Date.now();
  const out = [];
  for (const [provider, b] of breakers.entries()) {
    const open = now < (b.openUntil || 0);
    out.push({
      provider,
      status: open ? 'OFFLINE' : (b.fails > 0 ? 'DEGRADED' : 'OPERATIONAL'),
      fails: b.fails || 0,
      latencyMs: b.latencyMs ?? null,
      retryAt: open ? new Date(b.openUntil).toISOString() : null,
    });
  }
  return out.sort((a, c) => a.provider.localeCompare(c.provider));
}

const breakers = new Map();
export async function withBreaker(provider, fn, timeoutMs = 12000) {
  const b = breakers.get(provider) || { fails: 0, openUntil: 0 };
  if (Date.now() < b.openUntil) {
    throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE' });
  }
  const t = Date.now();
  try {
    const v = await Promise.race([
      Promise.resolve(fn()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('PROVIDER_TIMEOUT')), timeoutMs)),
    ]);
    breakers.set(provider, { fails: 0, openUntil: 0, latencyMs: Date.now() - t });
    return v;
  } catch (e) {
    console.error(`[breaker:${provider}] ${e?.message || e}`);
    b.fails += 1;
    if (b.fails >= 3) b.openUntil = Date.now() + 60_000;
    breakers.set(provider, b);
    throw e.code ? e : Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE' });
  }
}
