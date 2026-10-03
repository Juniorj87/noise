// Shared fetch of on-chain tx status (used by /api/tx/status and the cron tracker).
//
// Works through the SuiDataProvider envelope (gRPC primary, JSON-RPC fallback),
// so it never depends on a deprecated raw `sui.client` shape.
//
// Returns one of:
//   { status: 'confirmed', ... }  — effects status success
//   { status: 'failed', ... }     — effects status failure (explicit on-chain fail)
//   { status: 'pending', ... }    — digest unknown to the node YET (never a failure)
// Throws PROVIDER_UNAVAILABLE / NOT_FOUND variants for transport problems so the
// caller (trackPendingOnce) can decide retry vs expire. Absence of confirmation
// is NEVER reported as failure here.
export async function fetchTxBlockStatus(providerOrClient, digest) {
  let tx;
  try {
    if (providerOrClient && typeof providerOrClient.getTransaction === 'function') {
      // SuiDataProvider-style (envelope) or suiAdapter-style (plain).
      const out = await providerOrClient.getTransaction(digest);
      tx = out && out.value !== undefined ? out.value : out;
    } else if (providerOrClient && typeof providerOrClient.getTransactionBlock === 'function') {
      // Legacy JSON-RPC client shape (kept for tests / local dev).
      tx = await providerOrClient.getTransactionBlock({ digest, options: { showEffects: true, showBalanceChanges: true } });
    } else {
      throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE' });
    }
  } catch (e) {
    if (isNotFound(e)) {
      const err = new Error('TX_NOT_FOUND_ON_CHAIN');
      err.code = 'TX_NOT_FOUND_ON_CHAIN';
      err.pending = true;
      throw err;
    }
    if (e && (e.code === 'PROVIDER_UNAVAILABLE' || e.code === 'PROVIDER_TIMEOUT')) throw e;
    // Transient transport problem — the tracker must retry, never fail the tx.
    const err = new Error(String((e && e.message) || e).slice(0, 200));
    err.code = 'PROVIDER_UNAVAILABLE';
    err.transient = true;
    throw err;
  }

  const st = tx && tx.effects && tx.effects.status && tx.effects.status.status;
  const gu = tx && tx.effects && tx.effects.gasUsed;
  const gas = gu ? String(Math.max(0, Number(gu.computationCost || 0) + Number(gu.storageCost || 0) - Number(gu.storageRebate || 0))) : null;
  let actualOutput = null;
  if (Array.isArray(tx.balanceChanges)) {
    const pos = tx.balanceChanges.filter((bc) => Number(bc.amount) > 0);
    if (pos.length > 0) actualOutput = pos.map((p) => `${p.amount} (${p.coinType})`).join(', ');
  }
  if (st === 'success') return { status: 'confirmed', checkpoint: tx.checkpoint ?? null, gas, actualOutput };
  if (st === 'failure') return { status: 'failed', failureReason: String((tx.effects && tx.effects.status && tx.effects.status.error) || 'unknown').slice(0, 300), gas };
  // Node answered but has no effects yet (e.g. checkpoint not yet cut) → pending.
  return { status: 'pending', checkpoint: tx.checkpoint ?? null, gas };
}

function isNotFound(e) {
  if (!e) return false;
  if (e.code === 'TX_NOT_FOUND_ON_CHAIN' || e.code === 'TX_NOT_FOUND') return true;
  const m = String((e && e.message) || e).toLowerCase();
  return /not found|could not find|no transaction|unknown digest|does not exist/.test(m);
}
