// /api/automation — GET list (wallet required), POST create with validation.
// /api/automation/<action> — status (owner-checked) | runs | tick (POST).
import { handler, readJson, requireQuery } from '../http.js';
import { createAutomation, parseAutomationNL, isWalletAddress, setAutomationStatus, automationTick } from '../services.js';
import { getPool, ensureSchema } from '../pg.js';

const ALLOWED_TRIGGERS = ['SCHEDULE', 'PRICE_ABOVE', 'PRICE_BELOW', 'ORDER_FILLED',
  'PREDICT_EXPIRY', 'PREDICT_PROBABILITY_ABOVE', 'PREDICT_PROBABILITY_BELOW',
  'POSITION_CHANGED', 'REWARD_THRESHOLD', 'APY_ABOVE', 'MANUAL'];

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

  if (req.method === 'POST') {
    const b = await readJson(req);
    if (!isWalletAddress(b.wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    if (!b.title) throw Object.assign(new Error('INVALID_AUTOMATION'), { code: 'INVALID_AUTOMATION' });
    const parsed = parseAutomationNL(b.title);
    const trigger = b.trigger || parsed.trigger;
    if (!trigger || !ALLOWED_TRIGGERS.includes(trigger.type)) {
      throw Object.assign(new Error('UNSUPPORTED_TRIGGER'), { code: 'UNSUPPORTED_TRIGGER' });
    }
    const action = b.action || parsed.action || { type: 'NOTIFY' };
    return { automation: await createAutomation({ ...b, trigger, action }) };
  }
  const wallet = requireQuery(url, 'wallet');
  if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  await ensureSchema();
  const rows = (await getPool().query('SELECT * FROM automations WHERE wallet = $1 ORDER BY created_at DESC', [wallet])).rows;
  return { items: rows };
});
