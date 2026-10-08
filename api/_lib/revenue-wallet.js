// NOISE_HUB_REVENUE_WALLET monitor — settlement/verification layer only.
// The DB is the accounting truth; this scan only verifies on-chain settlement.
// Transport: existing SuiDataProvider (gRPC path) — no new RPC abstraction.
// The address is PUBLIC; no private key / seed / mnemonic exists anywhere here.
import { NOISE_HUB_REVENUE_WALLET, reconcileRevenue } from '../../shared/logic.js';
import { SuiDataProvider } from './sui-provider.js';
import { getPool, ensureSchema, getConfig } from './pg.js';
import { cached } from './util.js';
import { getReconciliationExpected } from './referral-analytics.js';

export function getRevenueWallet() {
  return process.env.ACTION_HUB_FEE_RECIPIENT
    || process.env.NOISE_HUB_REVENUE_WALLET
    || NOISE_HUB_REVENUE_WALLET;
}

const SUI_COIN = '0x2::sui::SUI';
const normType = t => String(t || '').replace(/^0x0*2::/, '0x2::');
const normAddress = a => String(a || '').toLowerCase();

export function sumSuiInbound(balanceChanges, wallet = getRevenueWallet()) {
  let total = 0n;
  for (const bc of balanceChanges || []) {
    try {
      if (normType(bc?.coinType) !== SUI_COIN) continue;
      const owner = bc.address || (typeof bc.owner === 'string' ? bc.owner : bc.owner?.AddressOwner || bc.owner?.addressOwner);
      if (normAddress(owner) !== normAddress(wallet)) continue;
      const amt = BigInt(bc.amount ?? 0);
      if (amt > 0n) total += amt;
    } catch { /* skip malformed entries */ }
  }
  return total;
}

/** Best-effort scan of inbound transfers to the revenue wallet (SUI only). */
export async function scanRevenueWallet() {
  const {getFeeConfig}=await import('./fee-engine.js');
  const wallet=(await getFeeConfig('swap')).recipient || getRevenueWallet();
  return cached('revenue-wallet:' + wallet, 300_000, async () => {
    const out = {
      wallet, balance: null, balanceAsset: 'SUI',
      inboundTxs: 0, receivedSui: '0', lastActivity: null,
      source: 'Sui', updatedAt: new Date().toISOString(), coverage: 'partial-scan', verifiedCommission: null, observedNote: 'Recipient-only inbound SUI transfers; not proven Noise commissions. Last 50 transactions, not all-time revenue.',
    };
    try {
      const [bal, txs] = await Promise.all([
        SuiDataProvider.getBalances(wallet).catch(() => null),
        SuiDataProvider.getTransactions({ ToAddress: wallet }, null, 50).catch(() => null),
      ]);
      if(!bal&&!txs){out.coverage='observed-unavailable';return out;}
      const rows = bal?.value && Array.isArray(bal.value) ? bal.value : [];
      const sui = rows.find((b) => normType(b.coinType) === SUI_COIN);
      if (sui) out.balance = String(Number(sui.totalBalance || 0) / 1e9);
      const list = txs?.value?.data ?? txs?.value?.transactions ?? [];
      out.inboundTxs = Array.isArray(list) ? list.length : 0;
      let sum = 0n;
      let last = null;
      for (const t of list || []) {
        sum += sumSuiInbound(t.balanceChanges || t.balance_changes || [], wallet);
        const ts = t.timestampMs || t.timestamp || null;
        if (ts && (!last || String(ts) > String(last))) last = ts;
        if (!last && (t.digest || t.transactionDigest)) last = t.digest || t.transactionDigest;
      }
      out.receivedSui = String(Number(sum) / 1e9);
      out.lastActivity = last;
    } catch {
      out.coverage = 'observed-unavailable';
    }
    return out;
  });
}

/** Reconciliation: DB-expected vs wallet-observed. Persists an audit row. */
export async function getReconciliation() {
  await ensureSchema();
  const pool = getPool();
  const { expectedIn, paidOut } = await getReconciliationExpected(pool);
  const scan = await scanRevenueWallet();
  // Observed is a partial SUI-only scan: it can confirm receipt, never deny it.
  // MATCHED only when the scan covers enough history; otherwise PENDING.
  const observed = null; // Different coverage/assets + no proven fee provenance: never MATCHED.
  const rec = reconcileRevenue({ expectedIn, paidOut, observed, tolerance: 0.05 });
  const status = observed === null ? 'PENDING' : rec.status;
  const id = 'rec_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8);
  try {
    await pool.query(
      `INSERT INTO revenue_reconciliation (id, period, expected, received, difference, status, detail)
       VALUES ($1,'all',$2,$3,$4,$5,$6)`,
      [id, rec.expected, rec.received ?? 'n/a', rec.difference ?? 'n/a', status,
        JSON.stringify({ wallet: scan.wallet, coverage: scan.coverage, at: scan.updatedAt }).slice(0, 1000)]);
  } catch { /* audit row is best-effort */ }
  return {
    ...rec, status,
    wallet: scan.wallet, balance: scan.balance, lastActivity: scan.lastActivity,
    expectedNote: 'DB accounting truth (eligible Noise Hub revenue minus paid rewards)',
    observedNote: 'Recipient-only partial SUI transfers. Fee provenance unverified; reconciliation remains PENDING.',
    source: 'Noise accounting + Sui', updatedAt: new Date().toISOString(),
  };
}
