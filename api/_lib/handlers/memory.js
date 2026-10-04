// /api/memory — GET list per wallet; POST save; DELETE remove one or all (owner-scoped).
import { handler, readJson, requireQuery } from '../http.js';
import { saveMemory, isWalletAddress } from '../services.js';
import { getPool, ensureSchema } from '../pg.js';

export default handler(async (req, res, url) => {
  if (req.method === 'DELETE') {
    const b = await readJson(req);
    if (!isWalletAddress(b.wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    await ensureSchema();
    const pool = getPool();
    if (b.all) {
      await pool.query('DELETE FROM memory_records WHERE wallet = $1', [b.wallet]);
      return { ok: true, cleared: true };
    }
    if (!b.id) return { error: 'MISSING_ID', message: 'Provide id or all=true.', status: 400 };
    await pool.query('DELETE FROM memory_records WHERE id = $1 AND wallet = $2', [b.id, b.wallet]);
    return { ok: true };
  }
  if (req.method === 'POST') {
    const b = await readJson(req);
    if (!isWalletAddress(b.wallet) || !b.category || !b.content) {
      return { error: 'INVALID_MEMORY', message: 'wallet, category and content are required.', status: 400 };
    }
    return await saveMemory(b);
  }
  const wallet = requireQuery(url, 'wallet');
  if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  await ensureSchema();
  const items = (await getPool().query('SELECT id, category, content_cipher AS content, created_at FROM memory_records WHERE wallet = $1 ORDER BY created_at DESC', [wallet])).rows;
  return { items };
});
