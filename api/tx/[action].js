// /api/tx/<action> — status | tracker-tick (PATCH /api/tx handled in index.js via method).
// NOTE: PATCH /api/tx (transition) is served by api/tx.js fallback below.
import { handler, requireQuery } from '../_lib/http.js';
import { suiAdapter } from '../_lib/adapters.js';
import { TX, getTransactionByDigest, transitionTransaction, trackPendingOnce, settleReferralForTx, isValidDigest, isWalletAddress, recordDigest } from '../_lib/services.js';
import { getPool } from '../_lib/pg.js';
import { NETWORK } from '../_lib/adapters.js';

function explorerUrl(digest) {
  return `https://suiscan.xyz/${NETWORK}/tx/${encodeURIComponent(digest)}`;
}

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').pop();

  if (action === 'status') {
    const digest = requireQuery(url, 'digest');
    if (!isValidDigest(digest)) throw Object.assign(new Error('INVALID_DIGEST'), { code: 'INVALID_DIGEST' });
    // Self-heal: a client may be polling a signed digest that never reached
    // POST /api/tx/submit (request dropped / tab closed). Registering it here
    // guarantees the background tracker picks it up instead of losing it.
    let tx = await getTransactionByDigest(digest).catch(() => null);
    if (!tx) {
      const wallet = url.searchParams.get('wallet');
      if (isWalletAddress(wallet)) {
        try {
          tx = await recordDigest({
            digest, wallet,
            action: url.searchParams.get('action') || 'swap',
            provider: url.searchParams.get('provider') || null,
          });
        } catch (e) { tx = null; }
      }
    }
    try {
      const res2 = await suiAdapter.getTransactionStatus(digest);
      if (tx && ['submitted', 'pending'].includes(tx.status)) {
        if (res2.status === 'confirmed') {
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
      // Unknown to RPC yet → still pending (never assume success).
      return { status: 'pending', digest, explorerUrl: explorerUrl(digest), message: 'Pending confirmation on chain' };
    }
  }

  if (action === 'tracker-tick') {
    if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
    const tracked = await trackPendingOnce((digest) => suiAdapter.getTransactionStatus(digest));
    return { tracked };
  }

  return { error: 'NOT_FOUND', message: 'Unknown tx action.', status: 404 };
});
