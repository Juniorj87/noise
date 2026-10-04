// POST /api/fees/config — set fee configuration (admin only)
// GET /api/fees/config — get all fee configurations (admin only)
// POST /api/fees/calculate — calculate platform fee for an action
import { handler, readJson, requireAdmin } from '../http.js';
import { setFeeConfig, getAllFeeConfigs, getPlatformFee, calculateFeeBreakdown } from '../fee-engine.js';

export default handler(async (req, res, url) => {
  if (url.pathname === '/api/fees/calculate') {
    if (req.method !== 'POST') {
      return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
    }

    const body = await readJson(req);
    const { action, provider, instrument, amount, asset, protocolFee, providerFee, networkFee } = body;

    if (!amount || Number(amount) <= 0) {
      return { error: 'INVALID_AMOUNT', message: 'Amount must be greater than 0.', status: 400 };
    }

    if (action && provider) {
      const platformFee = await getPlatformFee({ action, provider, instrument, amount, asset });
      return { platformFee };
    }

    if (protocolFee !== undefined || providerFee !== undefined || networkFee !== undefined) {
      const breakdown = await calculateFeeBreakdown({
        protocolFee,
        providerFee,
        networkFee,
        action,
        provider,
        instrument,
        amount,
        asset,
      });
      return breakdown;
    }

    return { error: 'INVALID_REQUEST', message: 'Provide either (action, provider) for platform fee or (protocolFee, providerFee, networkFee) for full breakdown.', status: 400 };
  }

  requireAdmin(req);

  if (req.method === 'POST') {
    const body = await readJson(req);
    const { scope, provider, action, instrument, bps, recipient } = body;

    if (bps !== undefined && (typeof bps !== 'number' || bps < 0 || bps > 10000)) {
      return { error: 'INVALID_BPS', message: 'BPS must be between 0 and 10000 (0-100%).', status: 400 };
    }

    if (recipient && !/^0x[a-fA-F0-9]{40,}$/.test(recipient)) {
      return { error: 'INVALID_RECIPIENT', message: 'Invalid Sui wallet address.', status: 400 };
    }

    const result = await setFeeConfig({ scope, provider, action, instrument, bps, recipient });
    return result;
  }

  if (req.method === 'GET') {
    const configs = await getAllFeeConfigs();
    return { configs };
  }

  return { error: 'INVALID_REQUEST', message: 'Method not allowed.', status: 405 };
});
