// /api/tx — POST create record; GET by id | digest | wallet; PATCH transition.
// POST /api/tx/submit — save digest immediately, dedupe by digest.
// /api/tx/<action> — status | tracker-tick (PATCH /api/tx handled via method).
import { handler, readJson, requireQuery } from '../http.js';
import { ACTIONS, PROVIDERS, createTransaction, getTransaction, getTransactionByDigest, transitionTransaction, isWalletAddress, isValidDigest, trackPendingOnce, settleReferralForTx, recordDigest, authorizeTxPatch, TX } from '../services.js';
import { NETWORK, suiAdapter, sui } from '../adapters.js';
import { fetchTxSender } from '../txstatus.js';
import { getPool } from '../pg.js';

// On-chain sender lookup for digest↔wallet binding. Unknown (not indexed or
// field absent) is never proof — callers treat it as pending, not as failure.
const senderOf = (digest) => fetchTxSender((d, o) => sui.getTransaction(d, o), digest).catch(() => ({ unknown: true }));

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
  const action = url.pathname.split('/').pop();

  if (action === 'submit') {
    if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
    const b = await readJson(req);
    if (!isValidDigest(b.digest)) throw Object.assign(new Error('INVALID_DIGEST'), { code: 'INVALID_DIGEST' });
    if (!isWalletAddress(b.wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    return { tx: await recordDigest(b, { fetchSender: () => senderOf(b.digest) }) };
  }

  if (action === 'status') {
    const digest = requireQuery(url, 'digest');
    if (!isValidDigest(digest)) throw Object.assign(new Error('INVALID_DIGEST'), { code: 'INVALID_DIGEST' });
    let tx = await getTransactionByDigest(digest).catch(() => null);
    if (!tx) {
      const wallet = url.searchParams.get('wallet');
      if (isWalletAddress(wallet)) {
        try {
          tx = await recordDigest({
            digest, wallet,
            action: url.searchParams.get('action') || 'swap',
            provider: url.searchParams.get('provider') || null,
          }, { fetchSender: () => senderOf(digest) });
        } catch (e) { tx = null; }
      }
    }
    try {
      const res2 = await suiAdapter.getTransactionStatus(digest);
      if (tx && ['submitted', 'pending'].includes(tx.status)) {
        if (res2.status === 'confirmed') {
          // Hard gate: never confirm a record against a digest signed by
          // someone else. A mismatch fails the RECORD (not the chain tx) and
          // settles nothing.
          const v = await senderOf(digest);
          if (v.sender && tx.wallet && v.sender.toLowerCase() !== String(tx.wallet).toLowerCase()) {
            const bad = await transitionTransaction(tx.id, TX.FAILED, {
              failure_reason: 'SENDER_MISMATCH: on-chain sender differs from record wallet',
            }).catch(() => tx);
            return { ...res2, association: 'SENDER_MISMATCH', tx: bad, explorerUrl: explorerUrl(digest) };
          }
          if (tx.status === TX.SUBMITTED) await transitionTransaction(tx.id, TX.PENDING, {});
          const fin = await transitionTransaction(tx.id, TX.CONFIRMED, {
            gas: res2.gas || tx.gas,
            actual_output: res2.actualOutput || tx.actual_output,
          });
          await settleReferralForTx(fin);
        } else if (res2.status === 'failed') {
          const cur = tx.status === TX.SUBMITTED ? await transitionTransaction(tx.id, TX.PENDING, {}) : tx;
          await transitionTransaction(cur.id, TX.FAILED, {
            failure_reason: res2.failureReason || 'Failed on-chain',
            gas: res2.gas || cur.gas,
          });
        }
      }
      return { ...res2, explorerUrl: explorerUrl(digest) };
    } catch (e) {
      if (e.code) throw e;
      return { status: 'pending', digest, explorerUrl: explorerUrl(digest), message: 'Pending confirmation on chain' };
    }
  }

  if (action === 'tracker-tick') {
    if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
    const tracked = await trackPendingOnce((digest) => suiAdapter.getTransactionStatus(digest), { fetchSender: senderOf });
    return { tracked };
  }

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
    // Client reports are workflow telemetry only. Authoritative states
    // (submitted/pending/confirmed/failed) require the submit endpoint or
    // chain-grounded tracker paths; financial extras never pass via PATCH.
    const record = b.id ? await getTransaction(b.id).catch(() => null) : null;
    let auth;
    try {
      auth = authorizeTxPatch(record, b);
    } catch (e) {
      return { error: e.code || 'INVALID_REQUEST', message: String(e.message || e.code || 'Invalid patch').slice(0, 200), status: e.status || (e.code === 'TX_NOT_FOUND' ? 404 : 400) };
    }
    return { tx: await transitionTransaction(b.id, auth.to, auth.extra) };
  }

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
    const { ensureSchema } = await import('../pg.js');
    await ensureSchema();
    const rows = (await getPool().query('SELECT * FROM transactions WHERE wallet = $1 ORDER BY created_at DESC LIMIT 100', [wallet])).rows;
    return { items: rows.map((t) => ({ ...t, sender: t.wallet, explorerUrl: explorerUrl(t.digest) })) };
  }
  return { error: 'MISSING_ID', message: 'Provide id, digest or wallet.', status: 400 };
});
