// POST /api/sui — RPC proxy limited to simulation of user-approved tx bytes.
// GET /api/suins?address= — SuiNS resolution; failure never blocks.
import { handler, readJson, requireQuery } from '../http.js';
import { simulate, sui } from '../adapters.js';
import { isWalletAddress } from '../services.js';
import { cached, withBreaker } from '../util.js';

async function resolveName(address) {
  const client = sui.provider.rawClient();
  if (client && typeof client.resolveNameServiceNames === 'function') {
    const res = await client.resolveNameServiceNames({ address });
    return (res && Array.isArray(res.data) && res.data[0]) || null;
  }
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
    return null;
  }
  return null;
}

export default handler(async (req, res, url) => {
  if (req.method === 'GET' && url.pathname === '/api/suins') {
    const address = requireQuery(url, 'address');
    if (!isWalletAddress(address)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    try {
      const name = await withBreaker('sui-rpc', () =>
        cached('suins:' + address, 300_000, () => resolveName(address)));
      return { address, name: name || null, source: name ? 'SuiNS' : 'SuiNS (unavailable — honest null)' };
    } catch (e) {
      return { address, name: null, source: 'SuiNS', error: String(e.message || e).slice(0, 100) };
    }
  }
  if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
  const b = await readJson(req);
  if (b.method === 'simulate' && b.txBytes && b.sender && isWalletAddress(b.sender)) {
    return { simulation: await simulate(b.txBytes, b.sender) };
  }
  return { error: 'UNSUPPORTED_SUI_METHOD', message: 'Only method=simulate with txBytes and a valid sender is allowed.', status: 400 };
});
