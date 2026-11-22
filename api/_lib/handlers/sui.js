// POST /api/sui — RPC proxy limited to simulation of user-approved tx bytes.
// GET /api/suins?address= — SuiNS resolution; failure never blocks.
import { handler, readJson, requireQuery } from '../http.js';
import { simulate, sui, STRUCT_TAG } from '../adapters.js';
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
  // GET /api/token?type=0x…::module::TYPE — on-chain coin metadata for tokens
  // the UI imports by contract. No metadata → not tradeable (fail closed).
  if (req.method === 'GET' && (url.pathname === '/api/token' || url.pathname.startsWith('/api/token/'))) {
    const type = String(url.searchParams.get('type') || '').trim();
    if (!STRUCT_TAG.test(type)) {
      return { error: 'INVALID_COIN_TYPE', message: 'Provide a full coin type: 0x…::module::TYPE.', status: 400 };
    }
    const env = await withBreaker('sui-rpc', () => cached('coinmeta:' + type, 600_000, () => sui.getCoinMetadata(type)));
    const meta = (env && env.value) || env;
    const decimals = Number(meta && meta.decimals);
    if (!meta || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      return { error: 'NO_COIN_METADATA', message: 'Sui RPC returned no coin metadata for this type — it cannot be traded safely.', status: 404 };
    }
    const symbol = String(meta.symbol || '').trim();
    if (!symbol) return { error: 'NO_COIN_METADATA', message: 'Coin has no on-chain symbol.', status: 404 };
    return {
      coinType: type, symbol, name: String(meta.name || symbol), decimals,
      iconUrl: meta.iconUrl || null, source: 'Sui RPC coin metadata', verified: true,
    };
  }
  if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
  const b = await readJson(req);
  if (b.method === 'simulate' && b.txBytes && b.sender && isWalletAddress(b.sender)) {
    return { simulation: await simulate(b.txBytes, b.sender) };
  }
  return { error: 'UNSUPPORTED_SUI_METHOD', message: 'Only method=simulate with txBytes and a valid sender is allowed.', status: 400 };
});
