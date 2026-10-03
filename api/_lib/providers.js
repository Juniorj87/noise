// AI provider registry — identical to server/src/services.js. Keys resolve from
// env only; test-key is used once per request and never stored (spec §10, §11).
export const AI_PROVIDERS = {
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', style: 'openai', keyEnv: 'OPENROUTER_API_KEY', docs: 'https://openrouter.ai/docs' },
  openai: { url: 'https://api.openai.com/v1/chat/completions', style: 'openai', keyEnv: 'OPENAI_API_KEY', docs: 'https://platform.openai.com/docs' },
  custom: { url: process.env.AI_BASE_URL || '', style: 'openai', keyEnv: 'AI_API_KEY', docs: '' },
  anthropic: { url: 'https://api.anthropic.com/v1/messages', style: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', docs: 'https://docs.anthropic.com' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models', style: 'gemini', keyEnv: 'GOOGLE_AI_API_KEY', docs: 'https://ai.google.dev' },
};

export function aiConfig(name) {
  const p = AI_PROVIDERS[name] || AI_PROVIDERS.openrouter;
  const key = process.env[p.keyEnv] || (name === (process.env.AI_PROVIDER || '') ? (process.env.AI_API_KEY || process.env.LLM_API_KEY) : null);
  return { ...p, name, key: key || null, model: process.env.AI_MODEL || '' };
}

export async function testAiConnection({ provider, model, apiKey }) {
  const cfg = { ...(AI_PROVIDERS[provider] || AI_PROVIDERS.openrouter), name: provider, key: apiKey || null, model: model || '' };
  const t = Date.now();
  const useModel = model || cfg.model;
  if (!cfg.key) throw Object.assign(new Error('NO_API_KEY'), { code: 'NO_API_KEY' });
  if (!useModel) throw Object.assign(new Error('NO_MODEL'), { code: 'NO_MODEL' });
  let answer = '';
  if (cfg.style === 'openai') {
    if (!cfg.url) throw Object.assign(new Error('NO_BASE_URL'), { code: 'NO_BASE_URL' });
    const r = await fetch(cfg.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({ model: useModel, messages: [{ role: 'user', content: 'Reply with: ok' }] }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw Object.assign(new Error('LLM_' + r.status), { code: 'LLM_UNAVAILABLE' });
    answer = (await r.json())?.choices?.[0]?.message?.content ?? '';
  } else if (cfg.style === 'anthropic') {
    const r = await fetch(cfg.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: useModel, max_tokens: 32, messages: [{ role: 'user', content: 'Reply with: ok' }] }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw Object.assign(new Error('LLM_' + r.status), { code: 'LLM_UNAVAILABLE' });
    answer = ((await r.json())?.content ?? []).map((c) => c.text || '').join('');
  } else {
    const r = await fetch(`${cfg.url}/${useModel}:generateContent?key=${encodeURIComponent(cfg.key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with: ok' }] }] }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw Object.assign(new Error('LLM_' + r.status), { code: 'LLM_UNAVAILABLE' });
    answer = ((await r.json())?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text || '').join('');
  }
  return { ok: true, latencyMs: Date.now() - t, preview: String(answer).slice(0, 80) };
}
