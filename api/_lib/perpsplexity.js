// Perpsplexity adapter — perpetuals venue on Sui (perpsplexity.app).
//
// Researched 2026-10-02: the site is a Next.js app with no documented public
// token-discovery API. The only JSON surface found is the undocumented
// internal `/api/markets` route, which currently returns empty `items` with a
// `backingMarkets` list — not a stable discovery source, so we do NOT build
// token discovery on it (no fragile scraping per product rules).
//
// Honest integration: live-read /api/markets for venue status (backing
// markets, item availability) + DEEP_LINK for execution. If the venue later
// publishes a stable API, this adapter is the single place to wire it.

const BASE = 'https://perpsplexity.app';

async function fetchJson(path, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + path, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP_' + r.status);
    return r.json();
  } finally {
    clearTimeout(t);
  }
}

export const perpsplexityAdapter = {
  id: 'perpsplexity',

  /**
   * Live venue status: which backing markets the venue reports + whether its
   * internal list currently exposes tradeable items. Token discovery is NOT
   * offered — status is DEEP_LINK with a live-checked venue note.
   */
  async getMarkets() {
    try {
      const data = await fetchJson('/api/markets');
      const items = Array.isArray(data?.items) ? data.items : [];
      const backing = Array.isArray(data?.backingMarkets) ? data.backingMarkets : [];
      return {
        markets: items,
        backingMarkets: backing,
        venueOnline: true,
        note: items.length
          ? 'Perpsplexity lists tradeable perps markets — open the venue to trade.'
          : 'Perpsplexity exposes no public token-discovery feed (internal list is empty); trading happens on the venue itself.',
        source: 'Perpsplexity venue (live /api/markets read)',
        sourceUrl: 'https://perpsplexity.app',
        deepLink: 'https://perpsplexity.app',
        status: items.length ? 'READ_ONLY' : 'DEEP_LINK',
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      console.error('[perpsplexity] getMarkets failed:', String(e?.message || e).slice(0, 200));
      return {
        markets: [],
        backingMarkets: [],
        venueOnline: null, // unknown — network read failed, not a venue verdict
        note: 'Perpsplexity venue unreachable from the hub right now; try the venue directly.',
        source: 'Perpsplexity venue',
        sourceUrl: 'https://perpsplexity.app',
        deepLink: 'https://perpsplexity.app',
        status: 'DEEP_LINK',
        updatedAt: new Date().toISOString(),
      };
    }
  },

  /** Token discovery is not a Perpsplexity product — honest empty + deep link. */
  async getTokens() {
    const m = await this.getMarkets();
    return {
      tokens: [],
      ...m,
      note: 'Perpsplexity is a perpetuals venue, not a token launchpad — no token list exists here. Token discovery lives under SuiPump.',
    };
  },
};
