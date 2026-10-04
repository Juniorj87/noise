// GET/POST /api/cron/automation — serverless replacement for startScheduler().
// GET/POST /api/cron/tx-tracker — serverless replacement for startTracker().
import { handler } from '../http.js';
import { checkSecret, dbConfigured, cronConfigured } from '../pg.js';
import { automationTick, trackPendingOnce, refreshDeepbookOpenOrders } from '../services.js';
import { suiAdapter } from '../adapters.js';
import { deepbookAdapter } from '../deepbook.js';

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').pop();

  if (!cronConfigured()) {
    return { error: 'CRON_NOT_CONFIGURED', message: 'CRON_SECRET must be configured.', status: 503 };
  }
  if (!checkSecret(req)) {
    return { error: 'UNAUTHORIZED', message: 'Invalid cron secret.', status: 401 };
  }

  if (action === 'tx-tracker') {
    if (!dbConfigured()) {
      return { ok: true, skipped: 'DATABASE_URL not configured.' };
    }
    const tracked = await trackPendingOnce((digest) => suiAdapter.getTransactionStatus(digest));
    const orders = await refreshDeepbookOpenOrders((wallet, market) =>
      deepbookAdapter.getOpenOrders(wallet, market)).catch((e) => ({ error: String(e.message || e).slice(0, 200) }));
    return { ok: true, tracked, orders, at: new Date().toISOString() };
  }

  if (!dbConfigured()) {
    return { ok: true, skipped: 'DATABASE_URL not configured.' };
  }
  const result = await automationTick();
  return { ok: true, ...result };
}, { limit: 30 });
