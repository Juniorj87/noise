// GET /api/health — liveness + provider health (DB-backed when configured).
import { handler } from './_lib/http.js';
import { NETWORK, sui } from './_lib/adapters.js';
import { dbConfigured, getPool, ensureSchema } from './_lib/pg.js';

export default handler(async () => {
  let providers = [];
  if (dbConfigured()) {
    try {
      await ensureSchema();
      providers = (await getPool().query('SELECT provider, status, latency_ms, checked_at FROM provider_health')).rows;
    } catch { providers = []; }
  }
  return { ok: true, network: NETWORK, rpc: sui.rpcUrl.replace(/^https:\/\//, ''), db: dbConfigured() ? 'postgres' : 'not-configured', time: new Date().toISOString(), providers };
});
