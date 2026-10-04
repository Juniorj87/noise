// /api/activity — POST log; GET server-authoritative ledger (transactions + activities).
// GET /api/protocols — live protocol registry from Postgres.
import { handler, readJson, requireQuery } from '../http.js';
import { logActivity, isWalletAddress } from '../services.js';
import { NETWORK, listProtocols } from '../adapters.js';
import { getPool, ensureSchema, dbConfigured } from '../pg.js';

function explorerUrl(digest) {
  if (!digest) return null;
  return `https://suiscan.xyz/${NETWORK}/tx/${encodeURIComponent(digest)}`;
}

export default handler(async (req, res, url) => {
  if (url.pathname === '/api/protocols') {
    return { protocols: await listProtocols() };
  }
  if (req.method === 'POST') {
    const b = await readJson(req);
    if (!b.wallet || !b.action) return { error: 'INVALID_ACTIVITY', message: 'wallet and action are required.', status: 400 };
    return { id: await logActivity(b) };
  }
  const wallet = requireQuery(url, 'wallet');
  if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  await ensureSchema();
  const pool = getPool();
  const txRows = (await pool.query('SELECT * FROM transactions WHERE wallet = $1 ORDER BY created_at DESC LIMIT 100', [wallet])).rows;
  const actRows = (await pool.query("SELECT * FROM activities WHERE wallet = $1 AND action NOT IN ('swap','stake','supply','trade') ORDER BY created_at DESC LIMIT 50", [wallet])).rows;
  const items = [
    ...txRows.map((t) => ({
      id: t.id, wallet: t.wallet, sender: t.wallet, action: t.action, provider: t.provider,
      asset: t.input_asset && t.output_asset ? `${t.input_asset} → ${t.output_asset}` : (t.input_asset || t.output_asset || ''),
      amount: t.input_amount || '',
      input_asset: t.input_asset, input_amount: t.input_amount, output_asset: t.output_asset,
      expected_output: t.expected_output, actual_output: t.actual_output,
      protocol_fee: t.protocol_fee, provider_fee: t.provider_fee, platform_fee: t.platform_fee,
      gas: t.gas, fees_json: t.fees_json, digest: t.digest, status: t.status,
      failure_reason: t.failure_reason, source: t.source || 'manual',
      created_at: t.created_at, updated_at: t.updated_at, explorerUrl: explorerUrl(t.digest),
    })),
    ...actRows.map((a) => ({
      id: a.id, wallet: a.wallet, sender: a.wallet, action: a.action, provider: a.provider,
      asset: a.asset || '', amount: a.amount || '', fees_json: a.fees_json,
      digest: a.digest, status: a.status, source: a.origin || 'manual',
      created_at: a.created_at, updated_at: a.created_at, explorerUrl: explorerUrl(a.digest),
    })),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 100);
  return { items, network: NETWORK, db: dbConfigured() ? 'postgres' : 'memory' };
});
