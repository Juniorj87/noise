// /api/referral/<action> — register | attribute | reward (POST).
// Reward settles ONLY for confirmed on-chain transactions with eligible revenue.
import { handler, readJson } from '../_lib/http.js';
import { registerReferralCode, attributeReferral, settleReferralForTx, getTransactionByDigest, isValidDigest, isWalletAddress } from '../_lib/services.js';

export default handler(async (req, res, url) => {
  if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
  const action = url.pathname.split('/').pop();
  const b = await readJson(req);

  if (action === 'register') {
    return { referral: await registerReferralCode(b.code, b.wallet) };
  }
  if (action === 'attribute') {
    if (!isWalletAddress(b.wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    const r = await attributeReferral(b.code, b.wallet);
    return r.ok ? r : { ...r, status: 400 };
  }
  if (action === 'reward') {
    if (!b.digest || !isValidDigest(b.digest)) throw Object.assign(new Error('INVALID_DIGEST'), { code: 'INVALID_DIGEST' });
    const tx = await getTransactionByDigest(b.digest);
    if (!tx || tx.status !== 'confirmed') {
      return { error: 'NO_CONFIRMED_TX', message: 'Referral rewards settle only after on-chain confirmation.', status: 409 };
    }
    return { ...await settleReferralForTx(tx), digest: b.digest };
  }
  return { error: 'NOT_FOUND', message: 'Unknown referral action.', status: 404 };
});
