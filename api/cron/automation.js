// GET/POST /api/cron/automation — serverless replacement for startScheduler().
// One pass: load ACTIVE automations → evaluate conditions → write audit runs →
// expire. NEVER signs, NEVER executes Move — prepare/simulate/notify only (§9).
import { handler } from '../_lib/http.js';
import { checkSecret, dbConfigured, cronConfigured } from '../_lib/pg.js';
import { automationTick } from '../_lib/services.js';

export default handler(async (req) => {
  if (!cronConfigured()) {
    return { error: 'CRON_NOT_CONFIGURED', message: 'CRON_SECRET must be configured — scheduler stays closed.', status: 503 };
  }
  if (!checkSecret(req)) {
    return { error: 'UNAUTHORIZED', message: 'Invalid cron secret.', status: 401 };
  }
  if (!dbConfigured()) {
    return { ok: true, skipped: 'DATABASE_URL not configured — nothing to evaluate.' };
  }
  const result = await automationTick();
  return { ok: true, ...result };
}, { limit: 30 });
