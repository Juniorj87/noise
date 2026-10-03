// POST /api/memory/delete — remove one record or clear all (owner-scoped).
import { handler, readJson } from '../_lib/http.js';
import { isWalletAddress } from '../_lib/services.js';
import { getPool, ensureSchema } from '../_lib/pg.js';

export default handler(async (req) => {
  if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
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
});
