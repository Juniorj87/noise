// /api/tx — POST create record; GET by id | digest | wallet; PATCH transition.
// PATCH can never inject a digest: /api/tx/submit is the only digest writer.
import { handler, readJson } from '../_lib/http.js';
import { ACTIONS, PROVIDERS, createTransaction, getTransaction, getTransactionByDigest, transitionTransaction, isWalletAddress, isValidDigest } from '../_lib/services.js';
import { NETWORK } from '../_lib/adapters.js';

function explorerUrl(digest) {
  if (!digest) return null;
  return `https://suiscan.xyz/${NETWORK}/tx/${encodeURIComponent(digest)}`;
}

function normalizeProvider(p) {
  if (!p) return null;
  const pkey = String(p).toLowerCase().replace(/[^a-z]/g, '');
  const aliases = { cetusrouter: 'cetus', cetus: 'cetus', aftermath: 'aftermath-router', aftermathrouter: 'aftermath-router', suinative: 'sui-native', deepbook: 'deepbook', deepbookpredict: 'deepbook-predict' };
  const norm = aliases[pkey] || pkey;
  if (!PROVIDERS.includes(norm)) {
    throw Object.assign(new Error('UNSUPPORTED_PROVIDER'), { code: 'UNSUPPORTED_PROVIDER' });
  }
  return norm;
}

export default handler(async (req, res, url) => {
  if (req.method === 'POST') {
    const b = await readJson(req);
    if (!isWalletAddress(b.wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    if (b.action && !ACTIONS.includes(String(b.action).toLowerCase())) {
      throw Object.assign(new Error('UNSUPPORTED_ACTION'), { code: 'UNSUPPORTED_ACTION' });
    }
    normalizeProvider(b.provider);
    return { tx: await createTransaction(b) };
  }

  if (req.method === 'PATCH') {
    const b = await readJson(req);
    if (!b.id || !b.to) return { error: 'MISSING_ID', message: 'Provide id and target state.', status: 400 };
    const extra = b.extra || {};
    if (extra.digest !== undefined && (await getTransaction(b.id))?.digest !== extra.digest) {
      delete extra.digest;
    }
    return { tx: await transitionTransaction(b.id, String(b.to).toLowerCase(), extra) };
  }

  // GET
  const id = url.searchParams.get('id');
  const digest = url.searchParams.get('digest');
  const wallet = url.searchParams.get('wallet');
  if (id) {
    const t = await getTransaction(id);
    if (!t) return { error: 'TX_NOT_FOUND', message: 'No transaction with this id.', status: 404 };
    return { tx: { ...t, sender: t.wallet, explorerUrl: explorerUrl(t.digest) } };
  }
  if (digest) {
    if (!isValidDigest(digest)) throw Object.assign(new Error('INVALID_DIGEST'), { code: 'INVALID_DIGEST' });
    const t = await getTransactionByDigest(digest);
    if (!t) return { error: 'TX_NOT_FOUND', message: 'No transaction with this digest.', status: 404 };
    return { tx: { ...t, sender: t.wallet, explorerUrl: explorerUrl(t.digest) } };
  }
  if (wallet) {
    if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    const { getPool, ensureSchema } = await import('../_lib/pg.js');
    const rows = (await getPool().query('SELECT * FROM transactions WHERE wallet = $1 ORDER BY created_at DESC LIMIT 100', [wallet])).rows;
    return { items: rows.map((t) => ({ ...t, sender: t.wallet, explorerUrl: explorerUrl(t.digest) })) };
  }
  return { error: 'MISSING_ID', message: 'Provide id, digest or wallet.', status: 400 };
});
