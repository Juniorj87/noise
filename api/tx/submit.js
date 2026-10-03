// POST /api/tx/submit — save digest immediately, dedupe by digest.
import { handler, readJson } from '../_lib/http.js';
import { isValidDigest, isWalletAddress, recordDigest } from '../_lib/services.js';

export default handler(async (req) => {
  if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
  const b = await readJson(req);
  if (!isValidDigest(b.digest)) throw Object.assign(new Error('INVALID_DIGEST'), { code: 'INVALID_DIGEST' });
  if (!isWalletAddress(b.wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  return { tx: await recordDigest(b) };
});
