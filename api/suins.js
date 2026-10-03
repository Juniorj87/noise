// GET /api/suins?address= — SuiNS resolution; failure never blocks.
// Uses the @mysten/suins SDK over the provider raw client. When resolution is
// impossible through the current transport: honest fallback { name: null } —
// never a fake name, never a TypeError.
import { handler, requireQuery } from './_lib/http.js';
import { sui } from './_lib/adapters.js';
import { isWalletAddress } from './_lib/services.js';
import { cached, withBreaker } from './_lib/util.js';

async function resolveName(address) {
  const client = sui.provider.rawClient();
  // 1) legacy JSON-RPC surface, when the active client still exposes it.
  if (client && typeof client.resolveNameServiceNames === 'function') {
    const res = await client.resolveNameServiceNames({ address });
    return (res && Array.isArray(res.data) && res.data[0]) || null;
  }
  // 2) official SuiNS SDK over any BaseClient.
  try {
    const { SuiNameServiceClient } = await import('@mysten/suins');
    const svc = new SuiNameServiceClient({ client, network: sui.network });
    if (typeof svc.getName === 'function') {
      const out = await svc.getName(address);
      return (out && (out.name || out.defaultName)) || null;
    }
    if (typeof svc.resolveNameServiceNames === 'function') {
      const res = await svc.resolveNameServiceNames({ address });
      return (res && Array.isArray(res.data) && res.data[0]) || null;
    }
  } catch {
    // fall through to honest null
  }
  return null;
}

export default handler(async (req, res, url) => {
  const address = requireQuery(url, 'address');
  if (!isWalletAddress(address)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  try {
    const name = await withBreaker('sui-rpc', () =>
      cached('suins:' + address, 300_000, () => resolveName(address)));
    return { address, name: name || null, source: name ? 'SuiNS' : 'SuiNS (unavailable — honest null)' };
  } catch (e) {
    return { address, name: null, source: 'SuiNS', error: String(e.message || e).slice(0, 100) };
  }
});
