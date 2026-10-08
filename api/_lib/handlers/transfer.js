// POST /api/transfer/build — plain Sui coin transfer PTB (unsigned).
// Assets restricted to coins Noise knows (type, decimals, balance).
// Simulated before bytes are returned; the backend never signs.
import { handler, readJson } from '../http.js';
import { normalizeLendingError, devInspectB64, transferBuild, isWalletAddress } from '../lending.js';
import { coinType as knownCoinType } from '../adapters.js';

const STRUCT_TAG = /^0x[0-9a-fA-F]+::[A-Za-z0-9_]+::[A-Za-z0-9_]+$/;

function resolveCoinType(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  try { return knownCoinType(s); } catch { /* not a known symbol — try struct tag */ }
  if (STRUCT_TAG.test(s)) {
    try {
      const known = ['SUI', 'USDC', 'DEEP', 'CETUS', 'NAVX'].map((sym) => knownCoinType(sym));
      if (known.includes(s)) return s;
    } catch { /* fall through */ }
  }
  return null;
}

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').filter(Boolean)[2] || '';
  if (req.method !== 'POST' || action !== 'build') {
    return { error: 'NOT_FOUND', message: 'Known: POST /api/transfer/build.', status: 404 };
  }
  const b = await readJson(req).catch(() => ({}));
  try {
    const type = resolveCoinType(b.coinType || b.asset);
    if (!type) return { error: 'UNSUPPORTED_ASSET', message: 'Supported: SUI, USDC, DEEP, CETUS, NAVX.', status: 400 };
    const r = await transferBuild({ sender: b.sender || b.wallet, coinType: type, amountMist: b.amountMist || b.amount, recipient: b.recipient });
    let sim = null, gasEst = null;
    try {
      const insp = await devInspectB64(r.txBytes, b.sender || b.wallet);
      sim = insp.simulation;
      if (!insp.ok) {
        return { error: 'SIMULATION_FAILED', message: 'Dry run failed: ' + String(sim?.effects?.status?.error || 'failed').slice(0, 200), status: 400 };
      }
      const gu = sim?.effects?.gasUsed;
      if (gu) gasEst = String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0)));
    } catch (e) {
      return { error: 'SIMULATION_FAILED', message: 'Simulation unavailable (' + String(e.message || e).slice(0, 120) + ') — signing blocked for safety. Retry shortly.', status: 400 };
    }
    return { txBytes: r.txBytes, simulation: sim, simulationStatus: 'success', gasEst, meta: r.meta };
  } catch (e) {
    const n = normalizeLendingError(e);
    const status = /INVALID|UNSUPPORTED|NO_|MISSING/.test(n.code) ? 400 : 502;
    return { error: n.code, message: String(n.message || '').slice(0, 300), status };
  }
}, { limit: 60 });
