// /api/ai/<action> — tools | providers | test (GET tools/providers, POST test).
// POST /api/ai — chat; keys env-only; answers grounded in live tools.
import { handler, readJson } from '../http.js';
import { AI_PROVIDERS, testAiConnection } from '../providers.js';
import { aiChat } from '../ai.js';

export default handler(async (req, res, url) => {
  if (url.pathname === '/api/ai' && req.method === 'POST') {
    const b = await readJson(req);
    if (!b.message) return { error: 'MISSING_MESSAGE', message: 'message is required.', status: 400 };
    return await aiChat(b);
  }

  const action = url.pathname.split('/').pop();

  if (action === 'tools') {
    return { tools: ['getCapital', 'getBalances', 'getEarnApy', 'getDeepBookMarkets', 'getPredictMarkets', 'llmChat'] };
  }
  if (action === 'providers') {
    return {
      providers: Object.entries(AI_PROVIDERS).map(([name, p]) => ({
        name, style: p.style, keyEnv: p.keyEnv,
        configured: Boolean(process.env[p.keyEnv] || (name === (process.env.AI_PROVIDER || '') && (process.env.AI_API_KEY || process.env.LLM_API_KEY))),
        docs: p.docs,
      })),
      active: process.env.AI_PROVIDER || 'openrouter',
      fallback: process.env.AI_FALLBACK_PROVIDER || null,
    };
  }
  if (action === 'test') {
    if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
    const b = await readJson(req);
    if (!b.provider) return { error: 'MISSING_PROVIDER', message: 'provider is required.', status: 400 };
    try {
      return await testAiConnection(b);
    } catch (e) {
      return { error: e.code || 'AI_UNAVAILABLE', detail: String(e.message || e).slice(0, 200), status: 502 };
    }
  }
  return { error: 'NOT_FOUND', message: 'Unknown ai action.', status: 404 };
});
