// GET/POST /api/cron/tx-tracker — serverless replacement for startTracker().
// One pass: pending/submitted → check Sui RPC → update status/gas/actual output
// → settle referral ONLY on confirmed → expire stale. Guarded by CRON_SECRET.
import { handler } from '../_lib/http.js';
import { checkSecret, dbConfigured, cronConfigured } from '../_lib/pg.js';
import { trackPendingOnce, refreshDeepbookOpenOrders } from '../_lib/services.js';
import { suiAdapter } from '../_lib/adapters.js';
import { deepbookAdapter } from '../_lib/deepbook.js';

export default handler(async (req) => {
  if (!cronConfigured()) {
    return { error: 'CRON_NOT_CONFIGURED', message: 'CRON_SECRET must be configured — tracker stays closed.', status: 503 };
  }
  if (!checkSecret(req)) {
    return { error: 'UNAUTHORIZED', message: 'Invalid cron secret.', status: 401 };
  }
  if (!dbConfigured()) {
    return { ok: true, skipped: 'DATABASE_URL not configured — nothing to track.' };
  }
  // Provider-based status (gRPC primary) — never a deprecated raw client.
  const tracked = await trackPendingOnce((digest) => suiAdapter.getTransactionStatus(digest));
  // DeepBook orders: order status ≠ tx status — resting orders are re-read from
  // the chain each pass; fills/status updated, off-book orders finalized.
  const orders = await refreshDeepbookOpenOrders((wallet, market) =>
    deepbookAdapter.getOpenOrders(wallet, market)).catch((e) => ({ error: String(e.message || e).slice(0, 200) }));
  return { ok: true, tracked, orders, at: new Date().toISOString() };
}, { limit: 30 });
