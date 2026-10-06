// shared/skills.js — Noise Skill Registry (spec §36-37, §73).
//
// A "skill" is a capability Noise can attach to a workflow. It NEVER receives a
// private key and can NEVER auto-sign. The strongest permission a skill can hold
// is: read data, build an (unsigned) transaction, and REQUEST a wallet signature
// that the user must approve. Enforced by test.
export const SKILL_PERMISSIONS = ['read-data', 'build-transaction', 'request-signature'];

export function skill(entry) {
  return {
    id: entry.id,
    name: entry.name,
    purpose: entry.purpose,
    status: entry.status,                 // AVAILABLE | COMING_SOON
    dataAccess: entry.dataAccess || [],   // read-only data sources
    executionAccess: entry.executionAccess || [], // build/request-signature only
    permissions: entry.permissions || [],
    requires: entry.requires || [],       // e.g. ['deepbook']
    never: ['private-key', 'auto-sign'],
    docs: entry.docs || '',
  };
}

export const SKILLS = [
  skill({
    id: 'sui_memory', name: 'Noise Memory', status: 'AVAILABLE',
    purpose: 'Store your preferences and AI context (consent-gated) in the Noise database and return them to Noise.',
    dataAccess: ['memory_records (owner-scoped)'], executionAccess: [],
    permissions: ['read-data'],
    docs: '/app/ai',
  }),
  skill({
    id: 'deepbook_market_data', name: 'DeepBook Market Data', status: 'AVAILABLE',
    purpose: 'Read DeepBook markets, mid price and L2 order book.',
    dataAccess: ['DeepBook v3 SDK'], executionAccess: [],
    permissions: ['read-data'], docs: 'https://docs.sui.io/standards/deepbookv3',
  }),
  skill({
    id: 'sui_portfolio', name: 'Sui Portfolio', status: 'AVAILABLE',
    purpose: 'Read balances, stakes and objects for the connected wallet.',
    dataAccess: ['Sui RPC'], executionAccess: [],
    permissions: ['read-data'], docs: 'https://docs.sui.io',
  }),
  skill({
    id: 'sui_ecosystem', name: 'Sui Ecosystem', status: 'AVAILABLE',
    purpose: 'Read the Noise protocol registry: status, capabilities, fees and docs for every Sui protocol.',
    dataAccess: ['Noise ProtocolRegistry'], executionAccess: [],
    permissions: ['read-data'], docs: '/app/discover',
  }),
  skill({
    id: 'personal_preferences', name: 'Personal Preferences', status: 'AVAILABLE',
    purpose: 'Recall your saved preferences and workflow context (owner-scoped, consent-gated) to personalize answers.',
    dataAccess: ['memory_records (owner-scoped)'], executionAccess: [],
    permissions: ['read-data'],
    docs: '/app/ai',
  }),
  skill({
    id: 'trading_research', name: 'Trading Research', status: 'AVAILABLE',
    purpose: 'Read live DeepBook markets/order books and SuiPump discovery data for research. Never executes.',
    dataAccess: ['DeepBook v3 SDK', 'SuiPump API'], executionAccess: [],
    permissions: ['read-data'], docs: '/app/trade',
  }),
  skill({
    id: 'suipump_discovery', name: 'SuiPump Discovery', status: 'AVAILABLE',
    purpose: 'Read launchpad tokens: price, volume, trades, bonding progress.',
    dataAccess: ['SuiPump API'], executionAccess: [],
    permissions: ['read-data'], docs: '/app/discover',
  }),
  skill({
    id: 'swap_quote', name: 'Swap Quote', status: 'AVAILABLE',
    purpose: 'Compare swap quotes across live providers (Cetus, Aftermath…).',
    dataAccess: ['Cetus Aggregator', 'Aftermath REST'], executionAccess: [],
    permissions: ['read-data'], docs: '/app/actions',
  }),
  skill({
    id: 'swap_build', name: 'Swap Build', status: 'AVAILABLE',
    purpose: 'Build and simulate an unsigned swap PTB, then request your wallet signature.',
    dataAccess: [], executionAccess: ['Cetus'],
    permissions: ['build-transaction', 'request-signature'], docs: '/app/actions',
  }),
  skill({
    id: 'native_staking', name: 'Native Staking', status: 'AVAILABLE',
    purpose: 'Build and simulate unsigned Sui native stake/unstake transactions.',
    dataAccess: ['Sui RPC'], executionAccess: ['Sui native'],
    permissions: ['build-transaction', 'request-signature'], docs: '/app/earn',
  }),
  skill({
    id: 'referral_analytics', name: 'Referral Analytics', status: 'AVAILABLE',
    purpose: 'Read your referral stats, revenue and leaderboard position.',
    dataAccess: ['Noise accounting'], executionAccess: [],
    permissions: ['read-data'], docs: '/app/referral',
  }),
  skill({
    id: 'ai_assistant', name: 'AI Assistant', status: 'AVAILABLE',
    purpose: 'Answer questions from live tools; prepare actions but never sign.',
    dataAccess: ['live tools'], executionAccess: [],
    permissions: ['read-data'], docs: '/app/ai',
  }),
];

export function allSkills() { return SKILLS.slice(); }
export function getSkill(id) { return SKILLS.find((s) => s.id === id) || null; }
export function availableSkills() { return SKILLS.filter((s) => s.status === 'AVAILABLE'); }
export function skillCounts() {
  const out = { AVAILABLE: 0, COMING_SOON: 0 };
  for (const s of SKILLS) out[s.status] = (out[s.status] || 0) + 1;
  return out;
}
/** A skill is only as powerful as its granted permissions; keys are never grantable. */
export function skillIsSafe(s) {
  return s.never.includes('private-key') && s.never.includes('auto-sign')
    && s.permissions.every((p) => SKILL_PERMISSIONS.includes(p));
}
