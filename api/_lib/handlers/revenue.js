// /api/revenue/summary — totals + by protocol + by action (admin or public totals).
// /api/revenue/reconciliation — DB expected vs revenue-wallet observed.
// /api/revenue/wallet — revenue wallet monitor (balance, inbound, last activity).
import { handler } from '../http.js';
import { getPool, ensureSchema } from '../pg.js';
import { getRevenueSummary } from '../referral-analytics.js';
import { scanRevenueWallet, getReconciliation, getRevenueWallet } from '../revenue-wallet.js';

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').filter(Boolean).pop();
  if (action === 'summary') {
    await ensureSchema();
    return getRevenueSummary(getPool());
  }
  if (action === 'reconciliation') {
    return getReconciliation();
  }
  if (action === 'wallet') {
    const scan = await scanRevenueWallet();
    return { ...scan, revenueWallet: getRevenueWallet() };
  }
  return { error: 'NOT_FOUND', message: 'Unknown revenue action.', status: 404 };
});
