// /api/memory — GET list per wallet; POST save consent-gated preference.
import { handler, readJson, requireQuery } from '../_lib/http.js';
import { saveMemory, isWalletAddress } from '../_lib/services.js';
import { getPool, ensureSchema } from '../_lib/pg.js';

export default handler(async (req, res, url) => {
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
