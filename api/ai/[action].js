// /api/ai/<action> — tools | providers | test (GET tools/providers, POST test).
import { handler, readJson } from '../_lib/http.js';
import { AI_PROVIDERS, testAiConnection } from '../_lib/providers.js';

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').pop();

  if (action === 'tools') {
    // Grounded in api/_lib/ai.js aiChat — only live reads the assistant
    // actually performs. No fake tools: spot/predict execution, fee writes,
    // orders and automation control are NOT assistant tools (wallet-signed
    // flows only). Discovery text is static guidance, not a live tool.
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
      return await testAiConnection(b); // key used once, never stored (§11)
    } catch (e) {
      return { error: e.code || 'AI_UNAVAILABLE', detail: String(e.message || e).slice(0, 200), status: 502 };
    }
  }
  return { error: 'NOT_FOUND', message: 'Unknown ai action.', status: 404 };
});
