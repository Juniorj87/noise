// Unified API router for Vercel deployment (spec Hobby plan <= 12 functions).
import activityHandler from './handlers/activity.js';
import capitalHandler from './handlers/capital.js';
import healthHandler from './handlers/health.js';
import pricesHandler from './handlers/prices.js';
import quoteHandler from './handlers/quote.js';
import suiHandler from './handlers/sui.js';
import swapHandler from './handlers/swap.js';
import adminHandler from './handlers/admin.js';
import aftermathHandler from './handlers/aftermath.js';
import aiHandler from './handlers/ai.js';
import automationHandler from './handlers/automation.js';
import cronHandler from './handlers/cron.js';
import earnHandler from './handlers/earn.js';
import feesHandler from './handlers/fees.js';
import memoryHandler from './handlers/memory.js';
import providersHandler from './handlers/providers.js';
import skillsHandler from './handlers/skills.js';
import referralHandler from './handlers/referral.js';
import revenueHandler from './handlers/revenue.js';
import tradeHandler from './handlers/trade.js';
import txHandler from './handlers/tx.js';
import { json } from './http.js';

export async function handleRequest(req, res) {
  const rawUrl = req.url || '/';
  const url = new URL(rawUrl, 'http://localhost');
  let pathname = url.pathname.replace(/\/+$/, '') || '/';

  // Support Vercel catch-all parameter rewrites
  if ((!pathname.startsWith('/api') || pathname === '/api') && req.query?.route) {
    const parts = Array.isArray(req.query.route) ? req.query.route : [req.query.route];
    pathname = '/api/' + parts.join('/');
  }

  if (pathname === '/health' || pathname === '/api/health') return healthHandler(req, res);
  if (pathname === '/api/protocols') return activityHandler(req, res);
  if (pathname === '/api/providers' || pathname.startsWith('/api/providers/')) return providersHandler(req, res);
  if (pathname === '/api/skills' || pathname.startsWith('/api/skills/')) return skillsHandler(req, res);
  if (pathname === '/api/activity' || pathname.startsWith('/api/activity/')) return activityHandler(req, res);
  if (pathname === '/api/capital' || pathname === '/api/notifications' || pathname.startsWith('/api/capital/') || pathname.startsWith('/api/notifications/')) return capitalHandler(req, res);
  if (pathname === '/api/prices' || pathname === '/api/prices-info' || pathname.startsWith('/api/prices/')) return pricesHandler(req, res);
  if (pathname === '/api/quote' || pathname === '/api/quotes' || pathname.startsWith('/api/quote/') || pathname.startsWith('/api/quotes/')) return quoteHandler(req, res);
  if (pathname === '/api/sui' || pathname === '/api/suins' || pathname.startsWith('/api/sui/') || pathname.startsWith('/api/suins/')) return suiHandler(req, res);
  if (pathname === '/api/swap' || pathname.startsWith('/api/swap/')) return swapHandler(req, res);
  if (pathname.startsWith('/api/trade')) return tradeHandler(req, res);
  if (pathname.startsWith('/api/earn')) return earnHandler(req, res);
  if (pathname.startsWith('/api/aftermath')) return aftermathHandler(req, res);
  if (pathname.startsWith('/api/fees')) return feesHandler(req, res);
  if (pathname.startsWith('/api/referral')) return referralHandler(req, res);
  if (pathname.startsWith('/api/revenue')) return revenueHandler(req, res);
  if (pathname.startsWith('/api/scheduler-tick') || pathname.startsWith('/api/cron-tick')) return cronHandler(req, res);
  if (pathname.startsWith('/api/automation')) return automationHandler(req, res);
  if (pathname.startsWith('/api/cron')) return cronHandler(req, res);
  if (pathname.startsWith('/api/memory')) return memoryHandler(req, res);
  if (pathname.startsWith('/api/ai')) return aiHandler(req, res);
  if (pathname.startsWith('/api/admin')) return adminHandler(req, res);
  if (pathname.startsWith('/api/tx')) return txHandler(req, res);

  if (pathname === '/api' || pathname === '') {
    return json(res, 200, { ok: true, name: 'Noise Hub API', routes: ['/api/health', '/api/capital', '/api/quote', '/api/swap', '/api/trade', '/api/earn'] }, req);
  }

  return json(res, 404, { error: 'NOT_FOUND', message: `Route ${pathname} not found.` }, req);
}
export default handleRequest;
