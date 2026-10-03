// /api/automation — GET list (wallet required), POST create with validation.
import { handler, readJson, requireQuery } from '../_lib/http.js';
import { createAutomation, parseAutomationNL, isWalletAddress } from '../_lib/services.js';
import { getPool, ensureSchema } from '../_lib/pg.js';

// Notify-only triggers are safe: evaluation writes audit runs, execution of
// any value-moving action additionally requires explicit permission + wallet
// approval at run time. Predict triggers are read-only monitors.
const ALLOWED_TRIGGERS = ['SCHEDULE', 'PRICE_ABOVE', 'PRICE_BELOW', 'ORDER_FILLED',
  'PREDICT_EXPIRY', 'PREDICT_PROBABILITY_ABOVE', 'PREDICT_PROBABILITY_BELOW',
  'POSITION_CHANGED', 'REWARD_THRESHOLD', 'APY_ABOVE', 'MANUAL'];

export default handler(async (req, res, url) => {
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
