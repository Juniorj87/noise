// NOISE HUB API — plain Node http router, zero framework deps.
import { createServer } from 'node:http';
import { db, uid } from './db.js';
import { sui, simulate } from './sui.js';
import { NETWORK } from './sui.js';
import { cetusAdapter, aftermathAdapter, deepbookAdapter, deepbookOpenOrders, suiAdapter, listProtocols, deepLink, compareRoutes, coinType } from './adapters.js';
import {
  getReferralStats, getReferralActivity, getLeaderboard, getRevenueSeries,
  getNetworkStats, getRevenueSummary, getReconciliationExpected,
} from './referral-analytics.js';
import { NOISE_HUB_REVENUE_WALLET, reconcileRevenue } from '../../shared/logic.js';
import {
  FEES, FeeEngine, feeBreakdown, attributeReferral, referralReward, referralPolicyFor, REFERRAL_POLICIES,
  logActivity, recordRevenue, createAutomation, setAutomationStatus,
  schedulerTick, parseAutomationNL, aiTools, aiChat, testAiConnection, saveMemory,
  AI_PROVIDERS, startScheduler,
  TX, createTransaction, getTransaction, getTransactionByDigest, transitionTransaction,
  recordDigest, trackPendingOnce, startTracker, registerReferralCode, settleReferralForTx,
  ACTIONS, PROVIDERS, isWalletAddress, isPositiveAmount, isValidBps, isValidDigest,
  cached, invalidateCache, rateLimit, withBreaker, markHealth, notify,
} from './services.js';

startScheduler();
startTracker();

const DEFAULT_ALLOWED_ORIGINS = [
  'https://app.noisehub.xyz',
  'https://noisehub.xyz',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];
const ENV_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = ENV_ALLOWED_ORIGINS.length ? ENV_ALLOWED_ORIGINS : DEFAULT_ALLOWED_ORIGINS;

const PORT = Number(process.env.PORT || 3001);
const ADMIN_KEY = process.env.ADMIN_KEY || '';

function getCorsOrigin(req) {
  try {
    const asked = req && req.headers && req.headers.origin;
    if (!asked) return ALLOWED_ORIGINS[0];
    if (ALLOWED_ORIGINS.includes(asked)) return asked;
    return 'null';
  } catch {
    return 'null';
  }
}

export function explorerUrl(digest) {
  if (!digest) return null;
  const net = sui.network === 'testnet' ? 'testnet' : 'mainnet';
  return `https://suiscan.xyz/${net}/tx/${encodeURIComponent(digest)}`;
}

function send(res, code, body, req) {
  const origin = getCorsOrigin(req);
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const routes = {
  'GET /api/health': async () => {
    const providers = db.prepare('SELECT provider,status,latency_ms,checked_at FROM provider_health').all();
    return { ok: true, network: sui.network, time: new Date().toISOString(), providers };
  },

  'GET /api/protocols': async () => ({ protocols: listProtocols() }),

  'GET /api/capital': async (_, url) => {
    const wallet = url.searchParams.get('wallet');
    if (!wallet) return { error: 'MISSING_WALLET', code: 400 };
    const forceRefresh = url.searchParams.get('refresh') === 'true';
    if (forceRefresh) invalidateCache('capital:' + wallet);
    const data = await withBreaker('sui-rpc', () =>
      cached('capital:' + wallet, 30_000, () => suiAdapter.getCapital(wallet), forceRefresh));
    markHealth('sui-rpc', 'LIVE');
    return { ...data, noDoubleCount: true };
  },

  'GET /api/quote': async (_, url) => {
    const from = (url.searchParams.get('from') || '').toUpperCase();
    const to = (url.searchParams.get('to') || '').toUpperCase();
    const amount = Number(url.searchParams.get('amount') || 0);
    const decimals = Number(url.searchParams.get('decimals') || 9);
    if (!from || !to || !(amount > 0)) return { error: 'INVALID_QUOTE_REQUEST', code: 400 };
    const amountMist = Math.round(amount * 10 ** decimals);
    try {
      const t = Date.now();
      const q = await withBreaker('cetus', () =>
        cached(`quote:${from}:${to}:${amountMist}`, 15_000,
          () => cetusAdapter.getQuote({ from, to, amountMist })));
      markHealth('cetus', 'LIVE', Date.now() - t);
      const minReceived = Number(q.amountOut) * 0.995;
      return { ...q, minReceived: String(Math.floor(minReceived)), fees: feeBreakdown(amount, 'swap') };
    } catch (e) {
      markHealth('cetus', 'UNAVAILABLE');
      return { error: e.code || 'PROVIDER_UNAVAILABLE', fallback: deepLink('cetus', { from, to }), code: 502 };
    }
  },

  'POST /api/activity': async (req) => {
    const b = await readJson(req);
    if (!b.wallet || !b.action) return { error: 'INVALID_ACTIVITY', code: 400 };
    return { id: logActivity(b) };
  },
  'GET /api/activity': async (_, url) => {
    const wallet = url.searchParams.get('wallet');
    if (!wallet) return { error: 'MISSING_WALLET', code: 400 };
    const txRows = db.prepare('SELECT * FROM transactions WHERE wallet = ? ORDER BY created_at DESC LIMIT 100').all(wallet);
    const actRows = db.prepare("SELECT * FROM activities WHERE wallet = ? AND action NOT IN ('swap','stake','supply','trade') ORDER BY created_at DESC LIMIT 50").all(wallet);
    const items = [
      ...txRows.map((t) => ({
        id: t.id,
        wallet: t.wallet,
        sender: t.wallet,
        action: t.action,
        provider: t.provider,
        asset: t.input_asset && t.output_asset ? `${t.input_asset} → ${t.output_asset}` : (t.input_asset || t.output_asset || ''),
        amount: t.input_amount || '',
        input_asset: t.input_asset,
        input_amount: t.input_amount,
        output_asset: t.output_asset,
        expected_output: t.expected_output,
        actual_output: t.actual_output,
        protocol_fee: t.protocol_fee,
        provider_fee: t.provider_fee,
        platform_fee: t.platform_fee,
        gas: t.gas,
        fees_json: t.fees_json,
        digest: t.digest,
        status: t.status,
        failure_reason: t.failure_reason,
        source: t.source || t.origin || 'manual',
        created_at: t.created_at,
        updated_at: t.updated_at,
        explorerUrl: explorerUrl(t.digest),
      })),
      ...actRows.map((a) => ({
        id: a.id,
        wallet: a.wallet,
        sender: a.wallet,
        action: a.action,
        provider: a.provider,
        asset: a.asset || '',
        amount: a.amount || '',
        fees_json: a.fees_json,
        digest: a.digest,
        status: a.status,
        source: a.origin || 'manual',
        created_at: a.created_at,
        updated_at: a.created_at,
        explorerUrl: explorerUrl(a.digest),
      })),
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 100);
    return { items, network: sui.network };
  },

  /* Swap build: backend builds PTB, wallet signs — never custody (§4). */
  'POST /api/swap/build': async (req) => {
    const b = await readJson(req);
    const { from, to, amountMist, sender, slippage = 0.01 } = b;
    if (!from || !to || !(Number(amountMist) > 0) || !Number.isFinite(Number(amountMist))) {
      return { error: 'INVALID_BUILD_REQUEST', code: 400 };
    }
    if (!isWalletAddress(sender)) return { error: 'INVALID_WALLET', code: 400 };
    if (!(Number(slippage) >= 0 && Number(slippage) < 1)) return { error: 'INVALID_SLIPPAGE', code: 400 };
    try {
      const [{ AggregatorClient }, { Transaction }] = await Promise.all([
        import('@cetusprotocol/aggregator-sdk'),
        import('@mysten/sui/transactions'),
      ]);
      const client = new AggregatorClient({ env: NETWORK === 'testnet' ? 1 : 0 });
      const router = await withBreaker('cetus', () =>
        client.findRouters({
          from: coinType(String(from).toUpperCase()),
          target: coinType(String(to).toUpperCase()),
          amount: BigInt(amountMist),
          byAmountIn: true,
        }));
      if (!router || router.insufficientLiquidity) return { error: 'INSUFFICIENT_LIQUIDITY', code: 400 };
      const txb = new Transaction();
      txb.setSender(sender);
      await client.fastRouterSwap({ router, txb, slippage: Number(slippage) });
      const bytes = await txb.build({ client: sui.client });
      const txBytes = Buffer.from(bytes).toString('base64');
      const sim = await simulate(txBytes, sender).catch((e) => ({ error: 'SIMULATION_FAILED', detail: String(e.message || e).slice(0, 200) }));
      let gasEst = null;
      if (sim && sim.effects && sim.effects.gasUsed) {
        const gu = sim.effects.gasUsed;
        gasEst = String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0)));
      }
      markHealth('cetus', 'LIVE');
      return {
        provider: 'Cetus', quoteId: router.quoteID ?? null,
        amountOut: String(router.amountOut ?? 0),
        txBytes, simulation: sim, gasEst, builtAt: new Date().toISOString(),
      };
    } catch (e) {
      markHealth('cetus', 'UNAVAILABLE');
      return { error: e.code || 'BUILD_FAILED', detail: String(e.message || e).slice(0, 200), code: 502 };
    }
  },

  'POST /api/sui': async (req) => {
    // RPC proxy + real simulation. Body: { method: 'simulate', txBytes, sender }
    const b = await readJson(req);
    if (b.method === 'simulate' && b.txBytes && b.sender) {
      return { simulation: await simulate(b.txBytes, b.sender) };
    }
    return { error: 'UNSUPPORTED_SUI_METHOD', code: 400 };
  },

  'GET /api/automation': async (_, url) => {
    const wallet = url.searchParams.get('wallet');
    const rows = wallet
      ? db.prepare('SELECT * FROM automations WHERE wallet = ? ORDER BY created_at DESC').all(wallet)
      : db.prepare('SELECT * FROM automations ORDER BY created_at DESC LIMIT 100').all();
    return { items: rows };
  },
  'POST /api/automation': async (req) => {
    const b = await readJson(req);
    if (!isWalletAddress(b.wallet)) return { error: 'INVALID_WALLET', code: 400 };
    if (!b.title) return { error: 'INVALID_AUTOMATION', code: 400 };
    const trigger = b.trigger || parseAutomationNL(b.title).trigger;
    const allowedTriggers = ['SCHEDULE', 'PRICE_ABOVE', 'REWARD_THRESHOLD', 'MANUAL'];
    if (!trigger || !allowedTriggers.includes(trigger.type)) return { error: 'UNSUPPORTED_TRIGGER', code: 400 };
    const action = b.action || parseAutomationNL(b.title).action || { type: 'NOTIFY' };
    try {
      return { automation: createAutomation({ ...b, trigger, action }) };
    } catch (e) { return { error: e.code || 'INVALID_AUTOMATION', code: 400 }; }
  },
  'POST /api/automation-status': async (req) => {
    const b = await readJson(req);
    try { setAutomationStatus(b.id, b.status, b.wallet || null); return { ok: true }; }
    catch (e) { return { error: e.code || 'INVALID_STATUS', code: e.code === 'NOT_AUTOMATION_OWNER' ? 403 : 400 }; }
  },
  'GET /api/automation-runs': async (_, url) => {
    const id = url.searchParams.get('id');
    return { items: db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 50').all(id) };
  },
  'POST /api/scheduler-tick': async () => schedulerTick(),

  'GET /api/referral': async (_, url) => {
    const wallet = url.searchParams.get('wallet');
    if (wallet) {
      if (!isWalletAddress(wallet)) return { error: 'INVALID_WALLET', code: 400 };
      const own = db.prepare('SELECT code FROM referrals WHERE referrer_wallet = ? ORDER BY created_at ASC LIMIT 1').get(wallet);
      const stats = getReferralStats(wallet);
      const lb = getLeaderboard({ period: 'all', metric: 'earned', limit: 1, viewer: wallet });
      return {
        wallet,
        referral: own ? { code: own.code, link: 'https://noisehub.xyz/?ref=' + own.code } : null,
        stats: {
          referred: stats.referred, active: stats.active,
          eligibleRevenue: stats.eligibleRevenue, earned: stats.earned,
          pending: stats.pending, paid: stats.paid,
          retained: stats.retained, conversion: stats.conversion,
        },
        rank: lb.viewer ? { position: lb.viewer.rank, total: lb.viewer.total } : { position: null, total: 0 },
        rate: FEES.refRate, windowDays: FEES.refWindowDays,
        updatedAt: stats.updatedAt, source: 'Noise accounting',
      };
    }
    const code = url.searchParams.get('code');
    const row = db.prepare('SELECT * FROM referrals WHERE code = ?').get(code);
    if (!row) return { error: 'UNKNOWN_CODE', code: 404 };
    const rewards = db.prepare('SELECT COALESCE(SUM(CAST(amount AS REAL)),0) AS total FROM referral_rewards WHERE referral_id = ?').get(row.id);
    return { referral: row, earned: rewards.total, rate: FEES.refRate, windowDays: FEES.refWindowDays };
  },
  'GET /api/referral/stats': async (_, url) => {
    const wallet = url.searchParams.get('wallet');
    if (!isWalletAddress(wallet)) return { error: 'INVALID_WALLET', code: 400 };
    const own = db.prepare('SELECT code FROM referrals WHERE referrer_wallet = ? ORDER BY created_at ASC LIMIT 1').get(wallet);
    const stats = getReferralStats(wallet);
    const lb = getLeaderboard({ period: 'all', metric: 'earned', limit: 1, viewer: wallet });
    return {
      wallet,
      referral: own ? { code: own.code, link: 'https://noisehub.xyz/?ref=' + own.code } : null,
      stats: {
        referred: stats.referred, active: stats.active,
        eligibleRevenue: stats.eligibleRevenue, earned: stats.earned,
        pending: stats.pending, paid: stats.paid,
        retained: stats.retained, conversion: stats.conversion,
      },
      rank: lb.viewer ? { position: lb.viewer.rank, total: lb.viewer.total } : { position: null, total: 0 },
      rate: FEES.refRate, windowDays: FEES.refWindowDays,
      updatedAt: stats.updatedAt, source: 'Noise accounting',
    };
  },
  'GET /api/referral/activity': async (_, url) => {
    const wallet = url.searchParams.get('wallet');
    if (!isWalletAddress(wallet)) return { error: 'INVALID_WALLET', code: 400 };
    return { items: getReferralActivity(wallet, url.searchParams.get('limit') || 25), updatedAt: new Date().toISOString(), source: 'Noise accounting' };
  },
  'GET /api/referral/leaderboard': async (_, url) => {
    if (String(process.env.LEADERBOARD_ENABLED || 'true') === 'false') return { error: 'LEADERBOARD_DISABLED', code: 503 };
    return getLeaderboard({
      period: url.searchParams.get('period') || 'all',
      metric: url.searchParams.get('metric') || 'earned',
      limit: url.searchParams.get('limit') || 50,
      viewer: url.searchParams.get('wallet') || null,
    });
  },
  'GET /api/referral/rank': async (_, url) => {
    const wallet = url.searchParams.get('wallet');
    if (!isWalletAddress(wallet)) return { error: 'INVALID_WALLET', code: 400 };
    const lb = getLeaderboard({ period: 'all', metric: 'earned', limit: 1, viewer: wallet });
    return { ...(lb.viewer || { rank: null }), updatedAt: lb.updatedAt, source: lb.source };
  },
  'GET /api/referral/revenue': async (_, url) => {
    const wallet = url.searchParams.get('wallet') || null;
    if (wallet && !isWalletAddress(wallet)) return { error: 'INVALID_WALLET', code: 400 };
    return getRevenueSeries({ wallet, range: url.searchParams.get('range') || '30d' });
  },
  'GET /api/referral/network': async () => getNetworkStats(),
  'POST /api/referral/claim': async (req) => {
    const b = await readJson(req);
    if (!isWalletAddress(b.wallet)) return { error: 'INVALID_WALLET', code: 400 };
    if (String(process.env.PAYOUT_ENABLED || 'false') !== 'true') {
      return { error: 'PAYOUT_DISABLED', message: 'Claiming coming soon — rewards are tracked and safe.', code: 501 };
    }
    const stats = getReferralStats(b.wallet);
    const min = Number(process.env.MIN_PAYOUT || 1);
    if (!(Number(stats.pending) >= min)) return { error: 'BELOW_MINIMUM', message: `Minimum payout is $${min}.`, code: 400 };
    const id = uid('pay');
    db.prepare(`INSERT INTO referral_payouts (id, referrer, amount, asset, destination, status) VALUES (?,?,?,?,?,?)`)
      .run(id, b.wallet, String(stats.pending), 'USDC', b.wallet, 'pending');
    return { ok: true, payoutId: id, amount: stats.pending, status: 'pending' };
  },
  'GET /api/revenue/summary': async () => getRevenueSummary(),
  'GET /api/revenue/wallet': async () => {
    const wallet = process.env.NOISE_HUB_REVENUE_WALLET || NOISE_HUB_REVENUE_WALLET;
    let balance = null;
    try {
      const cap = await suiAdapter.getCapital(wallet);
      const suiCoin = (cap.coins || []).find((c) => String(c.coinType) === '0x2::sui::SUI');
      if (suiCoin) balance = String(Number(suiCoin.totalBalance || 0) / 1e9);
    } catch { /* observed-unavailable */ }
    return {
      wallet, balance, balanceAsset: 'SUI', source: 'Sui',
      updatedAt: new Date().toISOString(),
      coverage: balance === null ? 'observed-unavailable' : 'partial-scan',
      note: 'On-chain balance is settlement/verification only — accounting truth is the Noise database.',
    };
  },
  'GET /api/revenue/reconciliation': async () => {
    const { expectedIn, paidOut } = getReconciliationExpected();
    // Dev server performs no history scan: honest PENDING until observed on-chain.
    const rec = reconcileRevenue({ expectedIn, paidOut, observed: null });
    return {
      ...rec, wallet: process.env.NOISE_HUB_REVENUE_WALLET || NOISE_HUB_REVENUE_WALLET,
      expectedNote: 'DB accounting truth (eligible Noise Hub revenue minus paid rewards)',
      observedNote: 'No wallet scan on dev server — configure production reconciliation for observed values',
      source: 'Noise accounting', updatedAt: new Date().toISOString(),
    };
  },
  'POST /api/referral/attribute': async (req) => {
    const b = await readJson(req);
    if (!isWalletAddress(b.wallet)) return { error: 'INVALID_WALLET', code: 400 };
    const r = attributeReferral(b.code, b.wallet);
    return r.ok ? r : { ...r, code: 400 };
  },
  'POST /api/referral/register': async (req) => {
    const b = await readJson(req);
    try { return { referral: registerReferralCode(b.code, b.wallet) }; }
    catch (e) { return { error: e.code || 'INVALID_CODE', code: 400 }; }
  },
  'POST /api/referral/reward': async (req) => {
    // Settles ONLY for confirmed on-chain transactions with eligible revenue (§12, §18).
    const b = await readJson(req);
    if (!b.digest || !isValidDigest(b.digest)) return { error: 'INVALID_DIGEST', code: 400 };
    const tx = getTransactionByDigest(b.digest);
    if (!tx || tx.status !== 'confirmed') return { error: 'NO_CONFIRMED_TX', code: 409 };
    const settled = settleReferralForTx(tx);
    return { ...settled, digest: b.digest };
  },

  'POST /api/ai': async (req) => {
    const b = await readJson(req);
    if (!b.message) return { error: 'MISSING_MESSAGE', code: 400 };
    try { return await aiChat(b); }
    catch (e) { return { error: e.code || 'AI_UNAVAILABLE', code: 502 }; }
  },
  'GET /api/ai-tools': async () => ({ tools: Object.keys(aiTools) }),
  'GET /api/ai-providers': async () => ({
    providers: Object.entries(AI_PROVIDERS).map(([name, p]) => ({
      name, style: p.style, keyEnv: p.keyEnv,
      configured: Boolean(process.env[p.keyEnv] || (name === (process.env.AI_PROVIDER || '') && (process.env.AI_API_KEY || process.env.LLM_API_KEY))),
      docs: p.docs,
    })),
    active: process.env.AI_PROVIDER || 'openrouter',
    fallback: process.env.AI_FALLBACK_PROVIDER || null,
  }),
  'POST /api/ai/test': async (req) => {
    const b = await readJson(req);
    if (!b.provider) return { error: 'MISSING_PROVIDER', code: 400 };
    try { return await testAiConnection(b); }
    catch (e) { return { error: e.code || 'AI_UNAVAILABLE', detail: String(e.message || e).slice(0, 200), code: 502 }; }
  },
  'GET /api/memory': async (_, url) => {
    const wallet = url.searchParams.get('wallet');
    if (!wallet) return { error: 'MISSING_WALLET', code: 400 };
    return { items: db.prepare('SELECT id,category,content_cipher AS content,created_at FROM memory_records WHERE wallet = ? ORDER BY created_at DESC').all(wallet) };
  },
  'POST /api/memory': async (req) => {
    const b = await readJson(req);
    if (!isWalletAddress(b.wallet) || !b.category || !b.content) return { error: 'INVALID_MEMORY', code: 400 };
    try { return saveMemory(b); }
    catch (e) { return { error: e.code || 'INVALID_MEMORY', code: 400 }; }
  },
  'POST /api/memory-delete': async (req) => {
    const b = await readJson(req);
    if (b.all) { db.prepare('DELETE FROM memory_records WHERE wallet = ?').run(b.wallet); return { ok: true, cleared: true }; }
    if (!b.id) return { error: 'MISSING_ID', code: 400 };
    db.prepare('DELETE FROM memory_records WHERE id = ? AND wallet = ?').run(b.id, b.wallet);
    return { ok: true };
  },

  /* Multi-provider quotes + transparent comparison (§7-8). */
  'GET /api/quotes': async (_, url) => {
    const from = (url.searchParams.get('from') || '').toUpperCase();
    const to = (url.searchParams.get('to') || '').toUpperCase();
    const amount = Number(url.searchParams.get('amount') || 0);
    const decimals = Number(url.searchParams.get('decimals') || 9);
    if (!from || !to || !(amount > 0)) return { error: 'INVALID_QUOTE_REQUEST', code: 400 };
    let amountMist;
    try { coinType(from); coinType(to); amountMist = Math.round(amount * 10 ** decimals); }
    catch (e) { return { error: e.code || 'UNSUPPORTED_ASSET', code: 400 }; }
    const t = Date.now();
    const [cetus, aftermath] = await Promise.allSettled([
      withBreaker('cetus', () => cached(`quote:cetus:${from}:${to}:${amountMist}`, 15_000,
        () => cetusAdapter.getQuote({ from, to, amountMist }))),
      withBreaker('aftermath', () => cached(`quote:af:${from}:${to}:${amountMist}`, 15_000,
        () => aftermathAdapter.getQuote({ from, to, amountMist }))),
    ]);
    const ok = [], failed = [];
    if (cetus.status === 'fulfilled') { ok.push(cetus.value); markHealth('cetus', 'LIVE', Date.now() - t); }
    else { failed.push({ provider: 'Cetus', error: cetus.reason?.code || 'PROVIDER_UNAVAILABLE' }); markHealth('cetus', 'UNAVAILABLE'); }
    if (aftermath.status === 'fulfilled') { ok.push(aftermath.value); markHealth('aftermath', 'LIVE', Date.now() - t); }
    else { failed.push({ provider: 'Aftermath Router', error: aftermath.reason?.code || 'PROVIDER_UNAVAILABLE' }); markHealth('aftermath', 'UNAVAILABLE'); }
    if (!ok.length) return { error: 'ALL_PROVIDERS_UNAVAILABLE', failed, fallback: deepLink('cetus', { from, to }), code: 502 };
    const compared = compareRoutes(ok, { platformFee: FeeEngine.calculatePlatformFee(amount, 'swap'), gasEst: 0 });
    return { ...compared, failed, fees: feeBreakdown(amount, 'swap') };
  },

  /* Live prices with source envelope (§2, §30). */
  'GET /api/prices': async (_, url) => {
    const symbols = (url.searchParams.get('coins') || 'SUI,USDC').split(',').map((s) => s.trim().toUpperCase());
    const types = [];
    for (const s of symbols) { try { types.push(coinType(s)); } catch { /* skip unknown honestly */ } }
    if (!types.length) return { error: 'UNSUPPORTED_ASSET', code: 400 };
    try {
      const data = await withBreaker('aftermath', () =>
        cached('prices:' + types.join(','), 30_000, () => aftermathAdapter.getPrices(types)));
      markHealth('aftermath', 'LIVE');
      return data;
    } catch (e) { markHealth('aftermath', 'UNAVAILABLE'); return { error: 'PROVIDER_UNAVAILABLE', code: 502 }; }
  },

  /* Aftermath data surfaces (all live, source-attributed). */
  'GET /api/aftermath/staking-apy': async () => {
    try {
      return await withBreaker('aftermath', () =>
        cached('af:staking-apy', 300_000, () => aftermathAdapter.getStakingApy()));
    } catch (e) { return { error: 'PROVIDER_UNAVAILABLE', code: 502 }; }
  },
  'GET /api/aftermath/rewards': async (_, url) => {
    const wallet = url.searchParams.get('wallet');
    if (!wallet) return { error: 'MISSING_WALLET', code: 400 };
    try {
      return await withBreaker('aftermath', () =>
        cached('af:rewards:' + wallet, 60_000, () => aftermathAdapter.getClaimableRewards(wallet)));
    } catch (e) { return { error: 'PROVIDER_UNAVAILABLE', code: 502 }; }
  },

  'GET /api/prices-info': async (_, url) => {
    const symbols = (url.searchParams.get('coins') || 'SUI,USDC').split(',').map((s) => s.trim().toUpperCase());
    const types = [];
    for (const s of symbols) { try { types.push(coinType(s)); } catch { /* skip unknown honestly */ } }
    if (!types.length) return { error: 'UNSUPPORTED_ASSET', code: 400 };
    try {
      return await withBreaker('aftermath', () =>
        cached('priceinfo:' + types.join(','), 60_000, () => aftermathAdapter.getPriceInfo(types)));
    } catch (e) { return { error: 'PROVIDER_UNAVAILABLE', code: 502 }; }
  },
  'GET /api/aftermath/pools': async (_, url) => {
    const limit = Math.min(Number(url.searchParams.get('limit') || 12), 50);
    try {
      return await withBreaker('aftermath', () =>
        cached('af:pools:' + limit, 90_000, () => aftermathAdapter.getPoolSummaries(limit)));
    } catch (e) { return { error: 'PROVIDER_UNAVAILABLE', code: 502 }; }
  },
  'GET /api/aftermath/lp': async (_, url) => {
    const wallet = url.searchParams.get('wallet');
    if (!wallet) return { error: 'MISSING_WALLET', code: 400 };
    try {
      return await withBreaker('aftermath', () =>
        cached('af:lp:' + wallet, 60_000, () => aftermathAdapter.getOwnedLp(wallet)));
    } catch (e) { return { error: 'PROVIDER_UNAVAILABLE', code: 502 }; }
  },

  /* DeepBook markets + orderbook (live). */
  'GET /api/trade/markets': async () => {
    try {
      const pools = deepbookAdapter.pools();
      const mids = await Promise.allSettled(pools.slice(0, 8).map(async (p) => ({
        ...p, mid: await withBreaker('deepbook', () => cached('db:mid:' + p.name, 20_000, () => deepbookAdapter.midPrice(p.name))),
      })));
      markHealth('deepbook', 'LIVE');
      return {
        markets: mids.filter((m) => m.status === 'fulfilled').map((m) => m.value),
        failed: mids.filter((m) => m.status === 'rejected').length,
      };
    } catch (e) { markHealth('deepbook', 'UNAVAILABLE'); return { error: 'PROVIDER_UNAVAILABLE', code: 502 }; }
  },
  'GET /api/trade/orderbook': async (_, url) => {
    const pool = url.searchParams.get('pool') || 'SUI_USDC';
    const ticks = Math.min(Number(url.searchParams.get('ticks') || 5), 20);
    try {
      return await withBreaker('deepbook', () =>
        cached(`db:ob:${pool}:${ticks}`, 10_000, () => deepbookAdapter.orderbook(pool, ticks)));
    } catch (e) { return { error: e.code || 'PROVIDER_UNAVAILABLE', code: 502 }; }
  },
  /* Open orders for a connected wallet (needs its balance managers — honest requirement). */
  'GET /api/trade/orders': async (_, url) => {
    const wallet = url.searchParams.get('wallet');
    const pool = url.searchParams.get('pool') || 'SUI_USDC';
    if (!isWalletAddress(wallet)) return { error: 'INVALID_WALLET', code: 400 };
    try {
      return await withBreaker('deepbook', () =>
        cached(`db:orders:${wallet}:${pool}`, 20_000, () => deepbookOpenOrders(wallet, pool)));
    } catch (e) { return { error: e.code || 'PROVIDER_UNAVAILABLE', code: 502 }; }
  },

  /* Transaction status — poll until confirmed/failed, never assume (§20). */
  'GET /api/tx/status': async (_, url) => {
    const digest = url.searchParams.get('digest');
    if (!digest) return { error: 'MISSING_DIGEST', code: 400 };
    try {
      const res = await suiAdapter.getTransactionStatus(digest);
      const tx = getTransactionByDigest(digest);
      if (tx && ['submitted', 'pending'].includes(tx.status)) {
        if (res.status === 'confirmed') {
          if (tx.status === TX.SUBMITTED) transitionTransaction(tx.id, TX.PENDING, {});
          const fin = transitionTransaction(tx.id, TX.CONFIRMED, {
            gas: res.gas || tx.gas,
            actual_output: res.actualOutput || tx.actual_output,
          });
          invalidateCache('capital:' + tx.wallet);
          settleReferralForTx(fin);
        } else if (res.status === 'failed') {
          const cur = tx.status === TX.SUBMITTED ? transitionTransaction(tx.id, TX.PENDING, {}) : tx;
          transitionTransaction(cur.id, TX.FAILED, {
            failure_reason: res.failureReason || 'Failed on-chain',
            gas: res.gas || cur.gas,
          });
        }
      }
      return { ...res, explorerUrl: explorerUrl(digest) };
    } catch (e) {
      return { status: 'pending', digest, explorerUrl: explorerUrl(digest), message: 'Pending confirmation on chain' };
    }
  },

  /* Transaction lifecycle persistence (§2-3): digest unique, no duplicates. */
  'POST /api/tx': async (req) => {
    const b = await readJson(req);
    if (!isWalletAddress(b.wallet)) return { error: 'INVALID_WALLET', code: 400 };
    if (b.action && !ACTIONS.includes(String(b.action).toLowerCase())) return { error: 'UNSUPPORTED_ACTION', code: 400 };
    if (b.provider) {
      const pkey = String(b.provider).toLowerCase().replace(/[^a-z]/g, '');
      const aliases = { cetusrouter: 'cetus', aftermath: 'aftermath', suinative: 'sui-native' };
      const norm = aliases[pkey] || pkey;
      if (!['cetus', 'aftermath', 'aftermath-router', 'aftermath-perps', 'deepbook', 'sui-native', 'navi', 'suilend', 'hub'].includes(norm)) {
        return { error: 'UNSUPPORTED_PROVIDER', code: 400 };
      }
    }
    try { return { tx: createTransaction(b) }; }
    catch (e) { return { error: e.code || 'INVALID_TX', code: 400 }; }
  },
  'GET /api/tx': async (_, url) => {
    const id = url.searchParams.get('id');
    const digest = url.searchParams.get('digest');
    const wallet = url.searchParams.get('wallet');
    if (id) {
      const t = getTransaction(id);
      return t ? { tx: { ...t, sender: t.wallet, explorerUrl: explorerUrl(t.digest) } } : { error: 'TX_NOT_FOUND', code: 404 };
    }
    if (digest) {
      const t = getTransactionByDigest(digest);
      return t ? { tx: { ...t, sender: t.wallet, explorerUrl: explorerUrl(t.digest) } } : { error: 'TX_NOT_FOUND', code: 404 };
    }
    if (wallet) {
      if (!isWalletAddress(wallet)) return { error: 'INVALID_WALLET', code: 400 };
      const rows = db.prepare('SELECT * FROM transactions WHERE wallet = ? ORDER BY created_at DESC LIMIT 100').all(wallet);
      return { items: rows.map((t) => ({ ...t, sender: t.wallet, explorerUrl: explorerUrl(t.digest) })) };
    }
    return { error: 'MISSING_ID', code: 400 };
  },
  'PATCH /api/tx': async (req) => {
    const b = await readJson(req);
    if (!b.id || !b.to) return { error: 'MISSING_ID', code: 400 };
    const extra = b.extra || {};
    // Digest changes are only allowed via /api/tx/submit (validates + dedupes).
    // Caller may attach identity/fee detail to its own record, never a digest.
    if (extra.digest !== undefined && getTransaction(b.id)?.digest !== extra.digest) {
      delete extra.digest;
    }
    try { return { tx: transitionTransaction(b.id, String(b.to).toLowerCase(), extra) }; }
    catch (e) {
      const code = e.code === 'TX_FINAL' ? 409 : (e.code === 'TX_NOT_FOUND' ? 404 : 400);
      return { error: e.code || 'TX_TRANSITION_FAILED', code };
    }
  },
  'POST /api/tx/submit': async (req) => {
    const b = await readJson(req);
    if (!isValidDigest(b.digest)) return { error: 'INVALID_DIGEST', code: 400 };
    if (!isWalletAddress(b.wallet)) return { error: 'INVALID_WALLET', code: 400 };
    try { return { tx: recordDigest(b) }; }
    catch (e) { return { error: e.code || 'TX_SUBMIT_FAILED', code: 400 }; }
  },
  'POST /api/tracker-tick': async () => ({ tracked: await trackPendingOnce() }),

  'GET /api/notifications': async (_, url) => {
    const wallet = url.searchParams.get('wallet');
    return { items: db.prepare('SELECT * FROM notifications WHERE wallet = ? ORDER BY created_at DESC LIMIT 50').all(wallet) };
  },
  'POST /api/notifications': async (req) => {
    const b = await readJson(req);
    if (!b.wallet || !b.title) return { error: 'INVALID_NOTIFICATION', code: 400 };
    return { id: notify(b.wallet, b.title, b.body || '', b.channel || 'in-app') };
  },

  'GET /api/suins': async (_, url) => {
    const address = url.searchParams.get('address');
    if (!address || !isWalletAddress(address)) return { error: 'INVALID_WALLET', code: 400 };
    try {
      const res = await withBreaker('sui-rpc', () =>
        cached('suins:' + address, 300_000, () => sui.client.resolveNameServiceNames({ address })));
      const name = (res && Array.isArray(res.data) && res.data[0]) || null;
      return { address, name, source: 'Sui RPC (resolveNameServiceNames)' };
    } catch (e) {
      return { address, name: null, source: 'Sui RPC', error: String(e.message || e).slice(0, 100) };
    }
  },

  'GET /api/admin/summary': async (_, _url, headers) => {
    if (!ADMIN_KEY || headers['x-admin-key'] !== ADMIN_KEY) return { error: 'UNAUTHORIZED', code: 401 };
    const revenue = db.prepare('SELECT COALESCE(SUM(CAST(net_revenue AS REAL)),0) AS total FROM revenue_entries').get();
    const failed = db.prepare("SELECT COUNT(*) AS c FROM activities WHERE status IN ('failed','rejected')").all();
    return {
      revenueNet: revenue.total,
      failedActivity: failed,
      protocols: listProtocols(),
      fees: { swapBps: FEES.swapBps, earnBps: FEES.earnBps, refRate: FEES.refRate, note: 'env defaults; runtime overrides via POST /api/admin/fees' },
      referralPolicies: REFERRAL_POLICIES,
      health: db.prepare('SELECT * FROM provider_health').all(),
    };
  },
  'POST /api/admin/fees': async (req, _url, headers) => {
    if (!ADMIN_KEY || headers['x-admin-key'] !== ADMIN_KEY) return { error: 'UNAUTHORIZED', code: 401 };
    const b = await readJson(req);
    if (b.swapBps != null) {
      const v = Number(b.swapBps);
      if (!(v >= 0 && v <= 100)) return { error: 'INVALID_BPS', code: 400 };
      FEES.swapBps = v;
    }
    if (b.earnBps != null) {
      const v = Number(b.earnBps);
      if (!(v >= 0 && v <= 100)) return { error: 'INVALID_BPS', code: 400 };
      FEES.earnBps = v;
    }
    return { ok: true, fees: { swapBps: FEES.swapBps, earnBps: FEES.earnBps } };
  },
  'POST /api/admin/protocol': async (req, _url, headers) => {
    if (!ADMIN_KEY || headers['x-admin-key'] !== ADMIN_KEY) return { error: 'UNAUTHORIZED', code: 401 };
    const b = await readJson(req);
    db.prepare('UPDATE protocols SET enabled = ?, status = ? WHERE id = ?')
      .run(b.enabled ? 1 : 0, b.status || 'MAINTENANCE', b.id);
    return { ok: true };
  },
  'GET /api/admin/referral': async (_, _url, headers) => {
    if (!ADMIN_KEY || headers['x-admin-key'] !== ADMIN_KEY) return { error: 'UNAUTHORIZED', code: 401 };
    return {
      controls: {
        referralRate: FEES.refRate, refWindowDays: FEES.refWindowDays,
        minPayout: Number(process.env.MIN_PAYOUT || 1),
        payoutEnabled: String(process.env.PAYOUT_ENABLED || 'false') === 'true',
        leaderboardEnabled: String(process.env.LEADERBOARD_ENABLED || 'true') !== 'false',
      },
      summary: getRevenueSummary(),
      pendingPayouts: db.prepare("SELECT COUNT(*) AS c FROM referral_payouts WHERE status = 'pending'").get()?.c ?? 0,
      revenueWallet: process.env.NOISE_HUB_REVENUE_WALLET || NOISE_HUB_REVENUE_WALLET,
    };
  },
  'POST /api/admin/referral': async (req, _url, headers) => {
    if (!ADMIN_KEY || headers['x-admin-key'] !== ADMIN_KEY) return { error: 'UNAUTHORIZED', code: 401 };
    const b = await readJson(req);
    if (b.referralRate != null) {
      const v = Number(b.referralRate);
      if (!(v >= 0 && v <= 100)) return { error: 'INVALID_RATE', code: 400 };
      FEES.refRate = v; // runtime override; persisted via env in production config
    }
    return { ok: true, refRate: FEES.refRate };
  },
  'GET /api/admin/revenue': async (_, _url, headers) => {
    if (!ADMIN_KEY || headers['x-admin-key'] !== ADMIN_KEY) return { error: 'UNAUTHORIZED', code: 401 };
    return getRevenueSummary();
  },
  'GET /api/admin/reconciliation': async (_, _url, headers) => {
    if (!ADMIN_KEY || headers['x-admin-key'] !== ADMIN_KEY) return { error: 'UNAUTHORIZED', code: 401 };
    const { expectedIn, paidOut } = getReconciliationExpected();
    return {
      ...reconcileRevenue({ expectedIn, paidOut, observed: null }),
      wallet: process.env.NOISE_HUB_REVENUE_WALLET || NOISE_HUB_REVENUE_WALLET,
      source: 'Noise accounting', updatedAt: new Date().toISOString(),
    };
  },
  'POST /api/admin/payout': async (req, _url, headers) => {
    if (!ADMIN_KEY || headers['x-admin-key'] !== ADMIN_KEY) return { error: 'UNAUTHORIZED', code: 401 };
    const b = await readJson(req);
    if (!b.payoutId || !b.txDigest) return { error: 'INVALID_REQUEST', code: 400 };
    const pay = db.prepare('SELECT * FROM referral_payouts WHERE id = ?').get(b.payoutId);
    if (!pay) return { error: 'NOT_FOUND', code: 404 };
    if (pay.status === 'confirmed') return { ok: true, already: true };
    db.prepare("UPDATE referral_payouts SET status = 'confirmed', tx_digest = ?, confirmed_at = datetime('now') WHERE id = ?")
      .run(String(b.txDigest).slice(0, 200), b.payoutId);
    try {
      db.prepare(`UPDATE referral_rewards SET status = 'paid', paid_at = datetime('now'), tx_digest = ?
        WHERE status IN ('pending','confirmed') AND COALESCE(referrer,
          (SELECT referrer_wallet FROM referrals r WHERE r.id = referral_rewards.referral_id)) = ?`)
        .run(String(b.txDigest).slice(0, 200), pay.referrer);
    } catch {
      db.prepare(`UPDATE referral_rewards SET status = 'paid' WHERE status IN ('pending','confirmed')
        AND referral_id IN (SELECT id FROM referrals WHERE referrer_wallet = ?)`)
        .run(pay.referrer);
    }
    return { ok: true, payoutId: b.payoutId };
  },
};

/** Run a Vercel route handler against a capturing res shim and
 *  return its JSON body (dev adapter for the exact-match router). */
function vercelShim(route) {
  return async (req2, url2) => {
    const shim = { statusCode: 0, setHeader() {}, end(body) { this._body = body; } };
    await route(req2, shim, url2);
    let body;
    try { body = JSON.parse(shim._body); } catch { body = { error: 'INTERNAL' }; }
    return body && body.error ? { ...body, code: shim.statusCode || 200 } : body;
  };
}

/* Legacy dev action names → canonical production handler actions.
 * The canonical source is api/_lib/handlers/*.js (same code Vercel runs). */
const DEEPBOOK_DEV_ACTION = {
  markets: 'markets', orderbook: 'orderbook', estimate: 'estimate', orders: 'orders',
  build: 'build', cancel: 'cancel', info: 'market', setup: 'setup-account',
};
/** Dev-only compatibility shim: legacy /api/trade/deepbook/* paths are served by
 *  the CANONICAL production trade handler. No production logic is duplicated or
 *  altered here — only path/query translation plus legacy field-name mapping. */
function deepbookDevShim(route) {
  const base = vercelShim(route);
  return async (req2, url2) => {
    const seg = String(url2.pathname.split('/').filter(Boolean).pop() || '');
    const target = DEEPBOOK_DEV_ACTION[seg] || seg;
    const u = new URL(req2.url, 'http://localhost');
    if (target !== seg) u.pathname = u.pathname.replace(/\/[^/]+$/, '/' + target);
    // Canonical estimate/market read `pool`; legacy callers send `market`.
    if ((target === 'estimate' || target === 'market')
      && !u.searchParams.get('pool') && u.searchParams.get('market')) {
      u.searchParams.set('pool', u.searchParams.get('market'));
    }
    req2.url = u.pathname + (u.search ? u.search : '');
    const out = await base(req2, url2);
    if (out && !out.error) {
      if (seg === 'markets' && Array.isArray(out.markets)) {
        out.markets = out.markets.map((m) => ({ ...m, midPrice: m.midPrice ?? m.last ?? null }));
        if (!out.source) out.source = 'DeepBook SDK';
      }
      if (seg === 'orders' && Array.isArray(out.orders) && out.managerKnown === undefined) {
        // Factual derivation via the canonical adapter: a wallet with no
        // BalanceManager objects has no trading account. Dev-server only.
        try {
          const { deepbookAdapter: canon } = await import('../../api/_lib/deepbook.js');
          const w = new URL(req2.url, 'http://localhost').searchParams.get('wallet');
          const ids = w ? await canon.getBalanceManagerIds(w).catch(() => []) : [];
          out.managerKnown = Array.isArray(ids) && ids.length > 0;
        } catch { out.managerKnown = out.orders.length > 0; }
      }
    }
    return out;
  };
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {}, req);
    const url = new URL(req.url, 'http://localhost');
    const key = req.method + ' ' + url.pathname;
    let handler = routes[key];
    // Dev adapters for the CANONICAL production handlers (single implementation,
    // also served by Vercel): run the handler against a capturing res shim,
    // then return its JSON body. Legacy per-route files no longer exist.
    if (!handler && url.pathname.startsWith('/api/trade/deepbook/')) {
      const { default: dbRoute } = await import('../../api/_lib/handlers/trade.js');
      handler = deepbookDevShim(dbRoute);
    }
    if (!handler && url.pathname.startsWith('/api/earn/')) {
      const { default: earnRoute } = await import('../../api/_lib/handlers/earn.js');
      handler = vercelShim(earnRoute);
    }
    if (!handler && url.pathname.startsWith('/api/aftermath/')) {
      const { default: afRoute } = await import('../../api/_lib/handlers/aftermath.js');
      handler = vercelShim(afRoute);
    }
    if (!handler) return send(res, 404, { error: 'NOT_FOUND' }, req);
    const rl = rateLimit(req.socket.remoteAddress + key, 120);
    if (!rl.allowed) return send(res, 429, { error: 'RATE_LIMITED' }, req);
    const out = await handler(req, url, req.headers);
    send(res, out && out.code ? out.code : 200, out, req);
  } catch (e) {
    send(res, 500, { error: 'INTERNAL', detail: String(e.message || e).slice(0, 200) }, req);
  }
});

server.listen(PORT, () => console.log('noise-hub-api on :' + PORT + ' (' + sui.network + ')'));

const shutdown = () => {
  console.log('Shutting down noise-hub-api gracefully...');
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
