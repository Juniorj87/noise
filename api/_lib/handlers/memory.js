// /api/memory — GET list per wallet; POST save; DELETE remove one or all (owner-scoped).
// /api/memory/search — owner-scoped keyword search over the Noise memory index.
// /api/memory/store — alias of POST save.
// /api/memory/delete — alias of DELETE one/all.
// /api/memory-delete — legacy POST delete path used by the Security page.
// /api/memory/export — owner-scoped JSON export (no secrets — writes are gated).
// /api/memory/status — counts for the AI Assistant memory panel (real only).
import { handler, readJson, requireQuery } from '../http.js';
import { saveMemory, searchMemory, memoryStats, isWalletAddress } from '../services.js';
import { getPool, ensureSchema } from '../pg.js';

async function listMemories(wallet) {
  await ensureSchema();
  try {
    return (await getPool().query(
      "SELECT id, category, content_cipher AS content, created_at FROM memory_records WHERE wallet = $1 AND (status IS NULL OR status = 'active') ORDER BY created_at DESC",
      [wallet])).rows;
  } catch {
    return (await getPool().query(
      'SELECT id, category, content_cipher AS content, created_at FROM memory_records WHERE wallet = $1 ORDER BY created_at DESC',
      [wallet])).rows;
  }
}

export default handler(async (req, res, url) => {
  const parts = url.pathname.split('/').filter(Boolean);
  const action = parts[parts.length - 1];

  if (action === 'search') {
    const wallet = url.searchParams.get('wallet');
    if (!wallet || !isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    const q = url.searchParams.get('q') || url.searchParams.get('query') || '';
    const items = await searchMemory({ wallet, query: q, limit: url.searchParams.get('limit') || 8 });
    return { items, query: q, updatedAt: new Date().toISOString(), source: 'Noise memory index' };
  }

  if (action === 'export') {
    const wallet = url.searchParams.get('wallet');
    if (!wallet || !isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    const items = await listMemories(wallet);
    return { wallet, items, exportedAt: new Date().toISOString(), source: 'Noise memory index' };
  }

  if (action === 'status') {
    const wallet = url.searchParams.get('wallet');
    if (!wallet || !isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    const stats = await memoryStats(wallet);
    return {
      wallet,
      hasRecords: stats.total > 0,
      total: stats.total,
      lastSync: stats.lastSync,
      storage: 'Noise database',
      updatedAt: new Date().toISOString(), source: 'Noise memory index',
    };
  }

  if (req.method === 'DELETE' || action === 'delete' || action === 'memory-delete') {
    const b = req.method === 'DELETE' ? await readJson(req) : (req.method === 'POST' ? await readJson(req) : Object.fromEntries(url.searchParams.entries()));
    const wallet = b.wallet || url.searchParams.get('wallet');
    if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    await ensureSchema();
    const pool = getPool();
    if (b.all === true || b.all === 'true') {
      try {
        await pool.query("UPDATE memory_records SET status = 'deleted' WHERE wallet = $1", [wallet]);
      } catch {
        await pool.query('DELETE FROM memory_records WHERE wallet = $1', [wallet]);
      }
      return { ok: true, cleared: true };
    }
    const id = b.id || url.searchParams.get('id');
    if (!id) return { error: 'MISSING_ID', message: 'Provide id or all=true.', status: 400 };
    try {
      await pool.query("UPDATE memory_records SET status = 'deleted' WHERE id = $1 AND wallet = $2", [id, wallet]);
    } catch {
      await pool.query('DELETE FROM memory_records WHERE id = $1 AND wallet = $2', [id, wallet]);
    }
    return { ok: true };
  }
  if (req.method === 'POST' || action === 'store') {
    const b = req.method === 'POST' ? await readJson(req) : {};
    const wallet = b.wallet || url.searchParams.get('wallet');
    if (!isWalletAddress(wallet) || !b.category || !b.content) {
      return { error: 'INVALID_MEMORY', message: 'wallet, category and content are required.', status: 400 };
    }
    return await saveMemory({ wallet, category: b.category, content: b.content, namespace: b.namespace });
  }
  const wallet = requireQuery(url, 'wallet');
  if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  const items = await listMemories(wallet);
  return { items };
});
