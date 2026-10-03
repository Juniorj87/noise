// /api/notifications — GET list; POST create (in-app channel).
import { handler, readJson, requireQuery } from './_lib/http.js';
import { uid } from './_lib/services.js';
import { getPool, ensureSchema } from './_lib/pg.js';

export default handler(async (req, res, url) => {
  if (req.method === 'POST') {
    const b = await readJson(req);
    if (!b.wallet || !b.title) return { error: 'INVALID_NOTIFICATION', message: 'wallet and title are required.', status: 400 };
    await ensureSchema();
    const id = uid('ntf');
    await getPool().query('INSERT INTO notifications (id, wallet, channel, title, body) VALUES ($1,$2,$3,$4,$5)',
      [id, b.wallet, b.channel || 'in-app', b.title, b.body || '']);
    return { id };
  }
  const wallet = requireQuery(url, 'wallet');
  await ensureSchema();
  const items = (await getPool().query('SELECT * FROM notifications WHERE wallet = $1 ORDER BY created_at DESC LIMIT 50', [wallet])).rows;
  return { items };
});
