// AI chat layer for API mode — identical provider chain + live-tool fallback
// answers as server/src/services.js aiChat. Keys stay server-side (spec §10).
import { AI_PROVIDERS, aiConfig } from './providers.js';
import { suiAdapter, aftermathAdapter } from './adapters.js';
import { deepbookAdapter } from './deepbook.js';

async function callProvider(cfg, { model, messages }) {
  const useModel = model || cfg.model;
  if (!cfg.key) throw Object.assign(new Error('NO_API_KEY'), { code: 'NO_API_KEY' });
  if (!useModel) throw Object.assign(new Error('NO_MODEL'), { code: 'NO_MODEL' });
  if (cfg.style === 'openai') {
    if (!cfg.url) throw Object.assign(new Error('NO_BASE_URL'), { code: 'NO_BASE_URL' });
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({ model: useModel, messages }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw Object.assign(new Error('LLM_' + r.status), { code: 'LLM_UNAVAILABLE' });
    const j = await r.json();
    return j.choices?.[0]?.message?.content ?? 'LLM_EMPTY';
  }
  if (cfg.style === 'anthropic') {
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: useModel, max_tokens: 1024, system: messages[0]?.content || '', messages: messages.slice(1) }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw Object.assign(new Error('LLM_' + r.status), { code: 'LLM_UNAVAILABLE' });
    const j = await r.json();
    return j.content?.map((c) => c.text || '').join('') || 'LLM_EMPTY';
  }
  const r = await fetch(`${cfg.url}/${useModel}:generateContent?key=${encodeURIComponent(cfg.key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: messages.map((m) => m.content).join('\n') }] }] }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw Object.assign(new Error('LLM_' + r.status), { code: 'LLM_UNAVAILABLE' });
  const j = await r.json();
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || 'LLM_EMPTY';
}

export { AI_PROVIDERS };

export async function aiChat({ wallet, message, history = [], provider, model }) {
  const toolHint = 'Live tools: getCapital, getBalances, getEarnApy, getDeepBookMarkets, getPredictMarkets, llmChat. Trading actions are NEVER executed by AI — the user signs every order in their wallet.';
  await persistConversation(wallet, 'user', String(message).slice(0, 4000));

  // Memory → AI: owner-scoped recall from the Noise memory index (consent-gated
  // at write; secrets are rejected at write and never reach the index).
  let memoriesUsed = [];
  let memoryOn = false;
  if (wallet && /^0x[0-9a-fA-F]{64}$/.test(String(wallet))) {
    try {
      const { getPool, ensureSchema } = await import('./pg.js');
      await ensureSchema();
      let rows = [];
      try {
        rows = (await getPool().query(
          "SELECT id, category, content_cipher AS content FROM memory_records WHERE wallet = $1 AND (status IS NULL OR status = 'active') ORDER BY created_at DESC LIMIT 200",
          [wallet])).rows;
      } catch {
        rows = (await getPool().query(
          'SELECT id, category, content_cipher AS content FROM memory_records WHERE wallet = $1 ORDER BY created_at DESC LIMIT 200',
          [wallet])).rows;
      }
      memoryOn = rows.length > 0;
      const tokens = String(message || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2).slice(0, 12);
      const scored = rows.map((r) => {
        const hay = String(r.content || '').toLowerCase();
        let s = 0;
        for (const t of tokens) if (hay.includes(t)) s += 1;
        return { ...r, s };
      }).filter((r) => r.s).sort((a, b) => b.s - a.s).slice(0, 3);
      memoriesUsed = scored.map((r) => ({ id: r.id, category: r.category, content: String(r.content).slice(0, 280) }));
    } catch { /* memory recall is best-effort, never blocks the answer */ }
  }

  const msgLower = String(message || '').toLowerCase();
  const capital = wallet ? await suiAdapter.getCapital(wallet).catch(() => null) : null;
  const nowIso = new Date().toISOString();

  let fallbackAnswer = '';
  let fallbackSource = 'hub-tools';

  if (msgLower.includes('sui balance') || (msgLower.includes('balance') && msgLower.includes('sui') && !msgLower.includes('usdc'))) {
    if (capital) {
      const suiCoin = (capital.coins || []).find((c) => c.coinType === '0x2::sui::SUI' || c.coinType.endsWith('::sui::SUI'));
      const amt = suiCoin ? Number(suiCoin.totalBalance) / 1e9 : 0;
      const staked = Number(capital.stakedMist || 0) / 1e9;
      fallbackAnswer = `Your SUI balance is ${amt.toFixed(4)} SUI (available in wallet). In addition, you have ${staked.toFixed(4)} SUI staked with validators. Source: Sui RPC (suix_getAllBalances + suix_getStakes) · Updated: ${nowIso}`;
      fallbackSource = 'sui-rpc';
    } else {
      fallbackAnswer = `Connect your wallet to see your live SUI balance. SUI is the native gas and staking token on Sui network. Source: Sui RPC · Updated: ${nowIso}`;
    }
  } else if (msgLower.includes('usdc') && (msgLower.includes('balance') || msgLower.includes('have') || msgLower.includes('how much') || msgLower.includes('where'))) {
    if (capital) {
      const usdcCoin = (capital.coins || []).find((c) => c.coinType.toLowerCase().includes('::usdc::usdc'));
      const amt = usdcCoin ? Number(usdcCoin.totalBalance) / 1e6 : 0;
      fallbackAnswer = `Your USDC balance is ${amt.toFixed(4)} USDC. Source: Sui RPC (suix_getAllBalances) · Updated: ${nowIso}`;
      fallbackSource = 'sui-rpc';
    } else {
      fallbackAnswer = `Connect your wallet to see your live USDC balance. Source: Sui RPC · Updated: ${nowIso}`;
    }
  } else if (msgLower.includes('earning') || msgLower.includes('opportunities') || msgLower.includes('yield') || (msgLower.includes('earn') && !msgLower.includes('what can i do'))) {
    let afApy = 'unavailable';
    try {
      const a = await aftermathAdapter.getStakingApy();
      if (a && a.value != null) afApy = (Number(a.value) * 100).toFixed(2) + '%';
    } catch {}
    fallbackAnswer = `Current live earning opportunities on Sui:\n1. Aftermath Liquid Staking (afSUI): ${afApy} APY (live SDK read).\n2. Native Sui Validator Staking (accrues on-chain via Sui system staking).\nLending markets on NAVI and Suilend are READ ONLY / UNAVAILABLE due to upstream transport limitations. No yields are fabricated.\nSource: Aftermath Staking SDK + Sui RPC · Updated: ${nowIso}`;
    fallbackSource = 'aftermath-staking+sui-rpc';
  } else if (msgLower.includes('what can i do with my sui') || (msgLower.includes('what') && msgLower.includes('do') && msgLower.includes('sui'))) {
    let afApy = 'unavailable';
    try {
      const a = await aftermathAdapter.getStakingApy();
      if (a && a.value != null) afApy = (Number(a.value) * 100).toFixed(2) + '%';
    } catch {}
    const suiBal = capital ? ((capital.coins || []).find((c) => c.coinType.endsWith('::sui::SUI'))?.totalBalance / 1e9 || 0).toFixed(4) : null;
    fallbackAnswer = `With your SUI${suiBal ? ` (${suiBal} SUI available)` : ''}, you can:\n1. Native Staking via Sui system staking.\n2. Liquid Staking: mint afSUI on Aftermath (${afApy} APY, live).\n3. Swap SUI for USDC via Cetus Aggregator V3 / Aftermath Router with quote comparison.\n4. Liquidity: deposit into AMM pools.\n5. Automate notification/threshold triggers.\nNote: Hub never custodies funds. All actions require wallet signature after real devInspect simulation.\nSource: Noise Hub Core Protocols · Updated: ${nowIso}`;
    fallbackSource = 'hub-registry';
  } else if ((msgLower.includes('deepbook') || msgLower.includes('order book') || msgLower.includes('orderbook')) && (msgLower.includes('price') || msgLower.includes('market') || msgLower.includes('book') || msgLower.includes('trade') || msgLower.includes('liquidity'))) {
    const mkts = await deepbookAdapter.getMarkets().catch(() => null);
    if (mkts && mkts.length) {
      const lines = mkts.slice(0, 5).map((m) => `${m.market}: mid ${m.midPrice ?? 'unavailable'}${m.bestBid != null ? `, bid ${m.bestBid}` : ''}${m.bestAsk != null ? `, ask ${m.bestAsk}` : ''}`);
      fallbackAnswer = `Live DeepBook V3 markets:\n${lines.join('\n')}\nPlace orders on the Trade page — orders are signed by you in your wallet; the assistant cannot and will not place trades.\nSource: DeepBook SDK (midPrice, getLevel2TicksFromMid) · Updated: ${nowIso}`;
      fallbackSource = 'deepbook-sdk';
    } else {
      fallbackAnswer = `DeepBook markets are temporarily unavailable (RPC unreachable). Nothing is estimated.\nSource: DeepBook SDK · Updated: ${nowIso}`;
    }
  } else if (msgLower.includes('predict') && (msgLower.includes('market') || msgLower.includes('position') || msgLower.includes('probability') || msgLower.includes('up') || msgLower.includes('down') || msgLower.includes('binary'))) {
    try {
      const { deepbookPredictAdapter } = await import('./deepbook-predict.js');
      const r = await deepbookPredictAdapter.getMarkets().catch(() => null);
      if (r && r.markets && r.markets.length) {
        const live = r.markets.filter((m) => m.tradable).slice(0, 6);
        const lines = live.map((m) => `${m.underlying || m.id.slice(0, 10) + '…'} expires ${new Date(m.expiryTimestamp).toLocaleString()} (${m.status})`);
        fallbackAnswer = `Live DeepBook Predict windows${live.length ? '' : ' (none tradable right now)'}:\n${lines.join('\n') || 'No tradable windows at this moment.'}\nUP pays if the asset settles above strike, DOWN if below. Mint on the Trade → Predict page — you sign in your wallet; the assistant cannot trade.\nSource: DeepBook Predict SDK (live) · Updated: ${nowIso}`;
      } else {
        fallbackAnswer = `DeepBook Predict markets are temporarily unavailable or have no active windows. Nothing is estimated.\nSource: DeepBook Predict SDK · Updated: ${nowIso}`;
      }
      fallbackSource = 'deepbook-predict-sdk';
    } catch {
      fallbackAnswer = `DeepBook Predict lookup failed — provider unreachable. Nothing is estimated.\nSource: DeepBook Predict SDK · Updated: ${nowIso}`;
      fallbackSource = 'deepbook-predict-sdk';
    }
  } else if ((msgLower.includes('fee') && (msgLower.includes('hub') || msgLower.includes('cost') || msgLower.includes('charge') || msgLower.includes('how'))) || msgLower.includes('how does action hub make money')) {
          fallbackAnswer = `How Noise Hub makes money: on supported actions the hub may add a transparent service fee (Noise Hub fee), shown before signing alongside protocol, provider and network fees. It is collected only as a real transaction leg — if collection is not possible the displayed fee is $0.00, never fake accounting. Referral rewards are paid from eligible hub revenue, never as an extra charge to you. The fee recipient is server-side configuration, never user input.\nSource: Noise Hub fee engine · Updated: ${nowIso}`;
    fallbackSource = 'fee-engine';
  } else if (msgLower.includes('new') && (msgLower.includes('token') || msgLower.includes('coin') || msgLower.includes('launch') || msgLower.includes('trend'))) {
    fallbackAnswer = `Newest tokens come from live discovery (SuiPump launchpad feed) on the Discover page — each card shows its source, price, market cap, liquidity and volume where the source provides them. Discovery never recommends purchases; it shows factual metrics only. Perpsplexity is a perpetuals venue, linked as a deep link rather than token discovery.\nSource: SuiPump public API · Updated: ${nowIso}`;
    fallbackSource = 'discover';
  } else if (capital) {
    fallbackAnswer = `Wallet ${wallet.slice(0, 10)}…: ${capital.coins.length} coin types found. Staked mist: ${capital.stakedMist}. Live tools: balances, earn, staking APY, quotes, orderbook. Source: Sui RPC · Updated: ${nowIso}`;
  } else {
      fallbackAnswer = `Noise Hub Assistant: connect a wallet for live capital and balances. Ask: "Show my SUI balance", "How much USDC do I have?", "Find current earning opportunities", or "What can I do with my SUI?". Source: Noise Hub Router · Updated: ${nowIso}`;
  }

  const sys = 'You are NOISE HUB assistant. ' + toolHint +
    ' Never invent balances, APY, TVL, prices, fees, capabilities or transaction status. Say Unavailable when data is missing. Always cite Source + Updated. You cannot sign anything.\n\n' +
    (memoriesUsed.length
      ? 'Saved user context (owner-scoped Noise Memory — preferences only, never secrets):\n' +
        memoriesUsed.map((m) => `- [${m.category}] ${m.content}`).join('\n') +
        '\nUse it when relevant and say which saved preference you used.\n\n'
      : '') +
    'Verified live facts:\n' + fallbackAnswer;

  const chain = [provider || process.env.AI_PROVIDER || 'openrouter', process.env.AI_FALLBACK_PROVIDER || null].filter(Boolean);
  let lastErr = null;
  for (const name of chain) {
    try {
      const answer = await callProvider(aiConfig(name), { model, messages: [{ role: 'system', content: sys }, ...history.slice(-10), { role: 'user', content: String(message).slice(0, 4000) }] });
      await persistConversation(wallet, 'assistant', String(answer).slice(0, 8000));
      return { answer, source: 'llm:' + name + ':' + (model || aiConfig(name).model), updated: new Date().toISOString(), memory: { on: memoryOn, used: memoriesUsed.length, items: memoriesUsed } };
    } catch (e) { lastErr = e; }
  }
  if (lastErr && !['NO_API_KEY', 'NO_MODEL', 'NO_BASE_URL'].includes(lastErr.code)) {
    throw Object.assign(new Error('AI_UNAVAILABLE'), { code: 'AI_UNAVAILABLE', status: 502 });
  }
  await persistConversation(wallet, 'assistant', fallbackAnswer);
  return { answer: fallbackAnswer, source: fallbackSource, updated: nowIso, memory: { on: memoryOn, used: memoriesUsed.length, items: memoriesUsed } };
}

async function persistConversation(wallet, role, content) {
  try {
    const { getPool, ensureSchema } = await import('./pg.js');
    const { uid } = await import('./services.js');
    await ensureSchema();
    await getPool().query('INSERT INTO ai_conversations (id, wallet, role, content) VALUES ($1,$2,$3,$4)', [uid('ai'), wallet || null, role, content]);
  } catch { /* conversation log is best-effort, never blocks the answer */ }
}
