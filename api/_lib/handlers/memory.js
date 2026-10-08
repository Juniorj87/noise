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
import { issueChallenge, openSession, requireSession, closeSessions } from '../memory-auth.js';

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

export function memoryTokenOf(req, url, body) {
  return req.headers?.['x-memory-token'] || (body && body.memToken) || (url && url.searchParams.get('memToken')) || null;
}

export async function memoryWallet(req, url, body, wallet) {
  return requireSession(req, url, body, () => wallet);
}

export default handler(async (req, res, url) => {
  const parts = url.pathname.split('/').filter(Boolean);
  const action = parts[parts.length - 1];

  /* Public: ownership-proof handshake (no token needed). */
  if (action === 'challenge' && req.method === 'POST') {
    const b = await readJson(req).catch(() => ({}));
    try {
      const r = await issueChallenge(b.wallet);
      return { ...r, source: 'Noise memory auth' };
    } catch (e) {
      return { error: e.code || 'INVALID_WALLET', message: 'Provide a valid 0x… wallet.', status: 400 };
    }
  }
  if (action === 'session' && req.method === 'POST') {
    const b = await readJson(req).catch(() => ({}));
    try {
      const r = await openSession(b.wallet, b.message, b.signature);
      return { ...r, source: 'Noise memory auth' };
    } catch (e) {
      const status = e.code === 'MEMORY_AUTH_REQUIRED' ? 401 : 400;
      return { error: e.code || 'BAD_SIGNATURE', message: 'Signature check failed — sign the exact challenge message in your wallet.', status };
    }
  }
  if (action === 'logout' && req.method === 'POST') {
    const b = await readJson(req).catch(() => ({}));
    if (b.wallet && isWalletAddress(b.wallet)) await closeSessions(b.wallet);
    return { ok: true };
  }

  const body = (req.method === 'POST' || req.method === 'DELETE') ? await readJson(req).catch(() => ({})) : {};

  if (action === 'search') {
    const wallet = url.searchParams.get('wallet') || body.wallet;
    try {
      await requireSession(req, url, body, wallet);
    } catch (e) {
      return { error: 'MEMORY_AUTH_REQUIRED', message: 'Sign the memory challenge in your wallet first.', status: 401 };
    }
    const q = url.searchParams.get('q') || url.searchParams.get('query') || body.q || '';
    const items = await searchMemory({ wallet, query: q, limit: url.searchParams.get('limit') || body.limit || 8 });
    return { items, query: q, updatedAt: new Date().toISOString(), source: 'Noise memory index' };
  }

  if (action === 'export') {
    const wallet = url.searchParams.get('wallet') || body.wallet;
    try {
      await requireSession(req, url, body, wallet);
    } catch (e) {
      return { error: 'MEMORY_AUTH_REQUIRED', message: 'Sign the memory challenge in your wallet first.', status: 401 };
    }
    const items = await listMemories(wallet);
    return { wallet, items, exportedAt: new Date().toISOString(), source: 'Noise memory index' };
  }

  if (action === 'status') {
    const wallet = url.searchParams.get('wallet') || body.wallet;
    try {
      await requireSession(req, url, body, wallet);
    } catch (e) {
      return { error: 'MEMORY_AUTH_REQUIRED', message: 'Sign the memory challenge in your wallet first.', status: 401 };
    }
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
    const b2 = req.method === 'DELETE' ? body : (req.method === 'POST' ? body : Object.fromEntries(url.searchParams.entries()));
    const wallet = b2.wallet || url.searchParams.get('wallet');
    try {
      await requireSession(req, url, b2, wallet);
    } catch (e) {
      return { error: 'MEMORY_AUTH_REQUIRED', message: 'Sign the memory challenge in your wallet first.', status: 401 };
    }
    await ensureSchema();
    const pool = getPool();
    if (b2.all === true || b2.all === 'true') {
      try {
        await pool.query("UPDATE memory_records SET status = 'deleted' WHERE wallet = $1", [wallet]);
      } catch {
        await pool.query('DELETE FROM memory_records WHERE wallet = $1', [wallet]);
      }
      return { ok: true, cleared: true };
    }
    const id = b2.id || url.searchParams.get('id');
    if (!id) return { error: 'MISSING_ID', message: 'Provide id or all=true.', status: 400 };
    try {
      await pool.query("UPDATE memory_records SET status = 'deleted' WHERE id = $1 AND wallet = $2", [id, wallet]);
    } catch {
      await pool.query('DELETE FROM memory_records WHERE id = $1 AND wallet = $2', [id, wallet]);
    }
    return { ok: true };
  }
  if (req.method === 'POST' || action === 'store') {
    const wallet = body.wallet || url.searchParams.get('wallet');
    try {
      await requireSession(req, url, body, wallet);
    } catch (e) {
      return { error: 'MEMORY_AUTH_REQUIRED', message: 'Sign the memory challenge in your wallet first.', status: 401 };
    }
    if (!isWalletAddress(wallet) || !body.category || !body.content) {
      return { error: 'INVALID_MEMORY', message: 'wallet, category and content are required.', status: 400 };
    }
    return await saveMemory({ wallet, category: body.category, content: body.content, namespace: body.namespace });
  }
  const wallet = requireQuery(url, 'wallet');
  try {
    await requireSession(req, url, body, wallet);
  } catch (e) {
    return { error: 'MEMORY_AUTH_REQUIRED', message: 'Sign the memory challenge in your wallet first.', status: 401 };
  }
  const items = await listMemories(wallet);
  return { items };
});
