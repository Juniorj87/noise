// /api/automation/<action> — status (owner-checked) | runs | tick (POST).
import { handler, readJson, requireQuery } from '../_lib/http.js';
import { setAutomationStatus, automationTick, isWalletAddress } from '../_lib/services.js';
import { getPool, ensureSchema } from '../_lib/pg.js';

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').pop();

  if (action === 'status') {
    if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
    const b = await readJson(req);
    try {
      await setAutomationStatus(b.id, b.status, b.wallet || null);
      return { ok: true };
    } catch (e) {
      if (e.code === 'NOT_AUTOMATION_OWNER') return { error: e.code, message: 'Only the automation owner can change its status.', status: 403 };
      if (e.code === 'AUTOMATION_NOT_FOUND') return { error: e.code, message: 'Automation not found.', status: 404 };
      return { error: e.code || 'INVALID_STATUS', message: 'Invalid status transition.', status: 400 };
    }
  }

  if (action === 'runs') {
    const id = requireQuery(url, 'id');
    await ensureSchema();
    const rows = (await getPool().query('SELECT * FROM automation_runs WHERE automation_id = $1 ORDER BY created_at DESC LIMIT 50', [id])).rows;
    return { items: rows };
  }

  if (action === 'tick') {
    if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
    return await automationTick();
  }

  return { error: 'NOT_FOUND', message: 'Unknown automation action.', status: 404 };
});
