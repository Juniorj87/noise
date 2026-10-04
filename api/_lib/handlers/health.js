// GET /api/health — liveness + provider health (DB-backed when configured).
import { handler } from '../http.js';
import { NETWORK, sui } from '../adapters.js';
import { dbConfigured, getPool, ensureSchema } from '../pg.js';

export default handler(async () => {
  let providers = [];
  if (dbConfigured()) {
    try {
      await ensureSchema();
      providers = (await getPool().query('SELECT provider, status, latency_ms, checked_at FROM provider_health')).rows;
    } catch { providers = []; }
  }
  const rpc = sui.rpcUrl ? sui.rpcUrl.replace(/^https:\/\//, '') : (sui.getClientInfo?.()?.rpcUrl?.replace(/^https:\/\//, '') || 'sui-rpc');
  return { ok: true, network: NETWORK, rpc, db: dbConfigured() ? 'postgres' : 'not-configured', time: new Date().toISOString(), providers };
});
