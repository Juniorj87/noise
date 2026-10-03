// POST /api/fees/config — set fee configuration (admin only)
// GET /api/fees/config — get all fee configurations (admin only)
import { handler, readJson } from '../_lib/http.js';
import { setFeeConfig, getAllFeeConfigs } from '../_lib/fee-engine.js';
import { validateAdminKey } from '../_lib/services.js';

export default handler(async (req, res, url) => {
  const adminKey = req.headers.get('x-admin-key');
  if (!validateAdminKey(adminKey)) {
    return { error: 'UNAUTHORIZED', message: 'Invalid or missing admin key.', status: 401 };
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const { scope, provider, action, instrument, bps, recipient } = body;

    if (bps !== undefined && (typeof bps !== 'number' || bps < 0 || bps > 10000)) {
      return { error: 'INVALID_BPS', message: 'BPS must be between 0 and 10000 (0-100%).', status: 400 };
    }

    if (recipient && !/^0x[a-fA-F0-9]{40,}$/.test(recipient)) {
      return { error: 'INVALID_RECIPIENT', message: 'Invalid Sui wallet address.', status: 400 };
    }

    const result = await setFeeConfig({ scope, provider, action, instrument, bps, recipient, adminKey });
    return result;
  }

  if (req.method === 'GET') {
    const configs = await getAllFeeConfigs();
    return { configs };
  }

  return { error: 'INVALID_REQUEST', message: 'Method not allowed.', status: 405 };
});
