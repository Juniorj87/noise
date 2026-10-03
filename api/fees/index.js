// POST /api/fees/calculate — calculate platform fee for an action
import { handler, readJson } from '../_lib/http.js';
import { getPlatformFee, calculateFeeBreakdown } from '../_lib/fee-engine.js';

export default handler(async (req) => {
  if (req.method !== 'POST') {
    return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
  }

  const body = await readJson(req);
  const { action, provider, instrument, amount, asset, protocolFee, providerFee, networkFee } = body;

  if (!amount || Number(amount) <= 0) {
    return { error: 'INVALID_AMOUNT', message: 'Amount must be greater than 0.', status: 400 };
  }

  // Calculate platform fee only
  if (action && provider) {
    const platformFee = await getPlatformFee({ action, provider, instrument, amount, asset });
    return { platformFee };
  }

  // Calculate full fee breakdown
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
});
