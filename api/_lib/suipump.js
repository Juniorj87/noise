// SuiPump discovery adapter — permissionless token launchpad on Sui.
// Uses official public read-only API (no key required).
// Documentation: https://suipump.org/integrations
//
// No invented data — all responses are live chain reads via their API.

const BASE_URL = 'https://suipump-main-web.onrender.com';

export const suipumpAdapter = {
  id: 'suipump',

  /**
   * Get all tokens ever launched, newest first.
   * Returns live chain data including bonding curve state.
   */
  async getTokens() {
    try {
      const response = await fetch(`${BASE_URL}/tokens`, {signal:AbortSignal.timeout(20000)});
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const tokens = await response.json();
      return {
        tokens: (()=>{if(!Array.isArray(tokens))throw new Error("Invalid token-list response");return tokens;})(),
        source: 'SuiPump live indexer API (not independently verified metrics)',
        sourceUrl: 'https://suipump.org/integrations',
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      console.error('[suipump] getTokens failed:', e);
      throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE', message: 'SuiPump API unavailable' });
    }
  },

  /**
   * Get per-curve stats including bonding curve state.
   */
  async getTokenStats(curveId) {
    try {
      const response = await fetch(`${BASE_URL}/token/${curveId}/stats`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const stats = await response.json();
      return {
        stats,
        source: 'SuiPump live indexer API (not independently verified metrics)',
        sourceUrl: 'https://suipump.org/integrations',
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      console.error('[suipump] getTokenStats failed:', e);
      throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE', message: 'Token stats unavailable' });
    }
  },

  /**
   * Get bonding curve supply from TreasuryCap on-chain.
   */
  async getCurveSupply(curveId) {
    try {
      const response = await fetch(`${BASE_URL}/curve/${curveId}/supply`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const supply = await response.json();
      return {
        supply,
        source: 'SuiPump Public API (TreasuryCap read)',
        sourceUrl: 'https://suipump.org/integrations',
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      console.error('[suipump] getCurveSupply failed:', e);
      throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE', message: 'Curve supply unavailable' });
    }
  },

  /**
   * Get trades feed for a specific token.
   */
  async getTrades(curveId, limit = 50) {
    try {
      const response = await fetch(`${BASE_URL}/token/${curveId}/trades?limit=${limit}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const trades = await response.json();
      return {
        trades: Array.isArray(trades) ? trades : [],
        source: 'SuiPump Public API (chain events)',
        sourceUrl: 'https://suipump.org/integrations',
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      console.error('[suipump] getTrades failed:', e);
      throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE', message: 'Trades unavailable' });
    }
  },
};
