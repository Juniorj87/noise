// SuiDataProvider — unified Sui data layer.
//
// Primary transport: Sui gRPC (SuiGrpcClient, baseUrl). JSON-RPC is deprecated
// on Sui Foundation endpoints since 2026-07-27; a third-party JSON-RPC URL
// (e.g. publicnode) remains available as legacy fallback for local dev only.
//
// Both transports are normalized to one JSON-RPC-compatible shape so the rest
// of the app never branches on transport. Every method returns an envelope:
// { value, source, sourceUrl, updatedAt, freshness, confidence }
//
// gRPC notes (@mysten/sui 2.33.x):
// - ctor: new SuiGrpcClient({ network, baseUrl })  (NOT { url }).
// - listBalances({owner}) -> { balances:[{coinType,coinBalance,addressBalance,balance}] }
// - getReferenceGasPrice() -> { referenceGasPrice: "123" }
// - simulateTransaction({ transaction: Transaction|bytes, include }) ->
//   { $kind:'Transaction', Transaction:{ status:{success}, ... } }
// - Stakes: no suix_getStakes on gRPC; derived from StakedSui owned objects.

import { fromBase58, toHex } from '@mysten/sui/utils';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';

export const NETWORK = (process.env.SUI_NETWORK || 'mainnet').toLowerCase() === 'testnet' ? 'testnet' : 'mainnet';

const GRPC_BASE_URL =
  process.env.SUI_GRPC_URL ||
  (NETWORK === 'testnet' ? 'https://fullnode.testnet.sui.io' : 'https://fullnode.mainnet.sui.io');

// Legacy JSON-RPC fallback (third-party providers still serve it; Foundation
// fullnode JSON-RPC is deprecated — never use it as default).
const RPC_URL =
  process.env.SUI_RPC_URL ||
  (NETWORK === 'testnet'
    ? 'https://sui-testnet-rpc.publicnode.com'
    : 'https://sui-rpc.publicnode.com');

export const GRAPHQL_URL =
  process.env.SUI_GRAPHQL_URL ||
  (NETWORK === 'testnet'
    ? 'https://graphql.testnet.sui.io/graphql'
    : 'https://graphql.mainnet.sui.io/graphql');

const TRANSPORT_TYPE = (process.env.SUI_TRANSPORT || 'grpc').toLowerCase();
const USE_GRPC = TRANSPORT_TYPE !== 'jsonrpc' && TRANSPORT_TYPE !== 'legacy';

export const GRPC_URL = GRPC_BASE_URL;
export { RPC_URL, TRANSPORT_TYPE };

const DOCS_GRPC = 'https://docs.sui.io/references/fullnode/rpc';
const DOCS_MIGRATION = 'https://docs.sui.io/develop/accessing-data/json-rpc-migration';

let grpcClient = null;
let jsonRpcClient = null;

export function getRawClient() {
  if (USE_GRPC) {
    if (!grpcClient) grpcClient = new SuiGrpcClient({ network: NETWORK, baseUrl: GRPC_BASE_URL });
    return { client: grpcClient, type: 'grpc', url: GRPC_BASE_URL };
  }
  if (!jsonRpcClient) jsonRpcClient = new SuiJsonRpcClient({ url: RPC_URL });
  return { client: jsonRpcClient, type: 'jsonrpc', url: RPC_URL };
}

/** Test hook: reset cached singleton clients (lets tests switch transports). */
export function __resetClients() {
  grpcClient = null;
  jsonRpcClient = null;
}

function envelope(value, source, confidence = 'high') {
  return {
    value,
    source,
    sourceUrl: USE_GRPC ? DOCS_GRPC : DOCS_MIGRATION,
    updatedAt: new Date().toISOString(),
    freshness: 'live',
    confidence,
  };
}

async function withRetry(fn, maxRetries = 2, delayMs = 1000) {
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = String(e?.message || e);
      if (i < maxRetries && /429|timeout|network|econn|fetch failed|temporarily/i.test(msg)) {
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

const tag = () => `Sui ${USE_GRPC ? 'gRPC' : 'JSON-RPC'} Client`;

// ---- normalization helpers (gRPC -> JSON-RPC-compatible shapes) ----

function normBalancesGrpc(res) {
  return (res?.balances || []).map((b) => {
    const coin = String(b.coinBalance || 0);
    const addr = String(b.addressBalance || 0);
    let total;
    try {
      total = String(BigInt(coin) + BigInt(addr));
    } catch {
      total = coin;
    }
    return {
      coinType: b.coinType,
      coinObjectCount: 0, // not reported by gRPC; 0 = unknown, never displayed as fact
      totalBalance: total,
      lockedBalance: {},
    };
  });
}

function normObjectsGrpc(res) {
  const objs = res?.objects || [];
  return {
    data: objs.map((o) => ({
      data: {
        objectId: o.objectId,
        version: o.version,
        digest: o.digest,
        type: o.type,
        owner: o.owner,
        content: o.content ?? o.json ?? null,
        previousTransaction: o.previousTransaction,
        display: o.display,
      },
    })),
    nextCursor: res?.cursor ?? null,
    hasNextPage: !!res?.hasNextPage,
  };
}

/** Extract principal (u64) from a StakedSui object json/content defensively. */
function stakedPrincipal(o) {
  const j = o?.json ?? o?.content;
  try {
    const f = j?.fields ?? j?.value?.fields ?? j;
    const p = f?.principal ?? f?.value?.principal;
    if (p != null) return String(p);
  } catch { /* fall through */ }
  return null;
}

function stakedPoolId(o) {
  const j = o?.json ?? o?.content;
  try {
    const f = j?.fields ?? j?.value?.fields ?? j;
    const p = f?.pool_id ?? f?.poolId ?? f?.value?.pool_id;
    if (p != null) return String(p);
  } catch { /* fall through */ }
  return null;
}

export const SuiDataProvider = {
  getClientInfo() {
    const { type, url } = getRawClient();
    return { network: NETWORK, transport: type, url };
  },

  /** Raw underlying client for SDKs that accept any BaseClient (DeepBook, Predict). */
  rawClient() {
    return getRawClient().client;
  },

  async getBalance(owner, coinType) {
    if (USE_GRPC) {
      const { client } = getRawClient();
      const res = await withRetry(() => client.getBalance({ owner, coinType }));
      const b = res?.balance || {};
      const coin = String(b.coinBalance || b.balance || 0);
      const addr = String(b.addressBalance || 0);
      let total = coin;
      try {
        total = String(BigInt(coin) + BigInt(addr));
      } catch { /* keep coin */ }
      return envelope(
        { coinType: b.coinType || coinType, coinObjectCount: 0, totalBalance: total, lockedBalance: {} },
        tag(),
      );
    }
    const { client } = getRawClient();
    const res = await withRetry(() => client.getBalance({ owner, coinType }));
    return envelope(res, tag());
  },

  async getBalances(owner) {
    if (USE_GRPC) {
      const { client } = getRawClient();
      // listBalances pages — walk cursors so large wallets are complete.
      const all = [];
      let cursor = null;
      for (let page = 0; page < 5; page++) {
        const res = await withRetry(() => client.listBalances({ owner, cursor, limit: 100 }));
        all.push(...(res?.balances || []));
        cursor = res?.cursor || null;
        if (!res?.hasNextPage || !cursor) break;
      }
      return envelope(normBalancesGrpc({ balances: all }), tag());
    }
    const { client } = getRawClient();
    const res = await withRetry(() => client.getAllBalances({ owner }));
    return envelope(res, tag());
  },

  async getObjects(owner, options = {}) {
    if (USE_GRPC) {
      const { client } = getRawClient();
      const res = await withRetry(() =>
        client.listOwnedObjects({
          owner,
          limit: options.limit || 50,
          cursor: options.cursor || null,
          include: { content: true, json: true },
        }),
      );
      return envelope(normObjectsGrpc(res), tag());
    }
    const { client } = getRawClient();
    const res = await withRetry(() =>
      client.getOwnedObjects({ owner, options: { showContent: true, showType: true, ...options } }),
    );
    return envelope(res, tag());
  },

  /** Stakes normalized to suix_getStakes shape. gRPC derives from StakedSui objects. */
  async getStakes(owner) {
    // Owned StakedSui objects alone do not prove Active status or reward amount.
    // This legacy method is still available on the configured third-party RPC.
    if (!jsonRpcClient) jsonRpcClient = new SuiJsonRpcClient({ url: RPC_URL });
    const res = await withRetry(() => jsonRpcClient.getStakes({ owner }));
    return envelope(res, 'Sui JSON-RPC staking state (configured RPC)');
  },

  async getTransaction(digest, options = {}) {
    if (USE_GRPC) {
      const { client } = getRawClient();
      const res = await withRetry(() =>
        client.getTransaction({
          digest,
          include: {
            transaction: true,
            effects: true,
            events: !!options.showEvents,
            balanceChanges: true,
          },
        }),
      );
      return envelope(normGrpcTx(res), tag());
    }
    const { client } = getRawClient();
    const res = await withRetry(() =>
      client.getTransactionBlock({
        digest,
        options: {
          showEffects: true,
          showBalanceChanges: true,
          showEvents: !!options.showEvents,
          showInput: false,
          showObjectChanges: false,
          ...options,
        },
      }),
    );
    return envelope(res, tag());
  },

  async getTransactions(filter = {}, cursor = null, limit = 20) {
    const { client, type } = getRawClient();
    if (type === 'grpc') {
      const res = await withRetry(() => client.listTransactions({ filter, cursor, limit }));
      return envelope(res, tag());
    }
    const res = await withRetry(() =>
      client.queryTransactionBlocks({
        filter,
        cursor,
        limit,
        options: { showEffects: true, showBalanceChanges: true },
      }),
    );
    return envelope(res, tag());
  },

  async getEvents(query, cursor = null, limit = 50) {
    const { client, type } = getRawClient();
    if (type === 'grpc') {
      const res = await withRetry(() => client.listEvents({ filter: query, cursor, limit }));
      return envelope(res, tag());
    }
    const res = await withRetry(() => client.queryEvents({ query, cursor, limit }));
    return envelope(res, tag());
  },

  async getCoinMetadata(coinType) {
    if (USE_GRPC) {
      const { client } = getRawClient();
      const res = await withRetry(() => client.getCoinMetadata({ coinType }));
      const m = res?.coinMetadata || null;
      return envelope(
        m ? { decimals: m.decimals ?? 0, name: m.name ?? '', symbol: m.symbol ?? '', description: m.description ?? '', iconUrl: m.iconUrl ?? null, id: m.id ?? null } : null,
        tag(),
        m ? 'high' : 'low',
      );
    }
    const { client } = getRawClient();
    const res = await withRetry(() => client.getCoinMetadata({ coinType }));
    return envelope(res, tag(), res ? 'high' : 'low');
  },

  async getDynamicFields(objectId, cursor = null, limit = 50) {
    const { client, type } = getRawClient();
    if (type === 'grpc') {
      const res = await withRetry(() => client.listDynamicFields({ parentId: objectId, cursor, limit }));
      return envelope(res, tag());
    }
    const res = await withRetry(() => client.getDynamicFields({ parentId: objectId, cursor, limit }));
    return envelope(res, tag());
  },

  /**
   * Simulate a transaction. Accepts a Transaction instance OR base64 bytes.
   * Returns devInspect-compatible: { effects:{ status:{status,error}, gasUsed },
   *   events, balanceChanges } so all callers keep working on both transports.
   */
  async simulateTransaction(txInput, sender) {
    await assertNetworkConsistency();
    const { client, type } = getRawClient();
    if (type === 'grpc') {
      const { Transaction } = await import('@mysten/sui/transactions');
      let tx = txInput;
      if (typeof txInput === 'string' || txInput instanceof Uint8Array) {
        const bytes = typeof txInput === 'string' ? Buffer.from(txInput, 'base64') : txInput;
        tx = Transaction.from(bytes);
        if (sender) tx.setSenderIfNotSet(sender);
      }
      const res = await withRetry(() =>
        client.simulateTransaction({ transaction: tx, include: { effects: true, events: true, balanceChanges: true } }),
      );
      return envelope(normGrpcSim(res), tag());
    }
    // Full TransactionData dry-run validates gas and exact signable bytes.
    // devInspect is for TransactionKind and may bypass normal gas checks.
    const { Transaction } = await import('@mysten/sui/transactions');
    const tx = typeof txInput === 'string' || txInput instanceof Uint8Array
      ? Transaction.from(typeof txInput === 'string' ? Buffer.from(txInput, 'base64') : txInput) : txInput;
    if (sender && tx.getData().sender && tx.getData().sender !== sender.toLowerCase()) throw Object.assign(new Error('Transaction sender mismatch'), { code: 'INVALID_WALLET' });
    if (sender) tx.setSenderIfNotSet(sender);
    const fullBytes = await tx.build({ client });
    const res = await withRetry(() => client.dryRunTransactionBlock({ transactionBlock: fullBytes }));
    return envelope(res, tag());
  },

  async getReferenceGasPrice() {
    if (USE_GRPC) {
      const { client } = getRawClient();
      const res = await withRetry(() => client.getReferenceGasPrice());
      return envelope(String(res?.referenceGasPrice ?? ''), tag());
    }
    const { client } = getRawClient();
    const res = await withRetry(() => client.getReferenceGasPrice());
    return envelope(res, tag());
  },

  async getLatestCheckpoint() {
    const { client, type } = getRawClient();
    if (type === 'grpc') {
      const res = await withRetry(() => client.getLatestCheckpoint?.() ?? client.ledgerService?.getCheckpoint?.({ sequenceNumber: undefined }));
      return envelope(res ?? null, tag(), res ? 'high' : 'low');
    }
    const res = await withRetry(() => client.getLatestCheckpointSequenceNumber());
    return envelope(res, tag());
  },

  async getChainIdentifier() {
    const { client } = getRawClient();
    const res = await withRetry(() => client.getChainIdentifier());
    return envelope(normalizeChainIdentifier(typeof res === 'string' ? res : res?.chainIdentifier), tag());
  },
};

/** Normalize gRPC getTransaction to { effects:{status:{status,error},gasUsed}, balanceChanges, ... } */
function normGrpcTx(res) {
  if (!res || typeof res !== 'object') return res;
  const t = res.Transaction ?? res.transaction ?? res;
  const eff = t.effects ?? t.Effects ?? null;
  const status = t.status ?? eff?.status ?? null;
  const ok = status?.success ?? status?.status === 'success';
  const gas = eff?.gasUsed ?? t.gasUsed ?? null;
  return {
    digest: t.digest ?? res.digest ?? null,
    effects: {
      status: { status: ok ? 'success' : 'failure', error: status?.error ?? null },
      gasUsed: gas
        ? {
            computationCost: String(gas.computationCost ?? gas.computation ?? 0),
            storageCost: String(gas.storageCost ?? gas.storage ?? 0),
            storageRebate: String(gas.storageRebate ?? gas.storageRebate ?? 0),
          }
        : null,
    },
    balanceChanges: t.balanceChanges ?? t.balance_changes ?? null,
    events: t.events ?? null,
    checkpoint: t.checkpoint ?? null,
    timestampMs: t.timestampMs ?? t.timestamp ?? null,
    _raw: res,
  };
}

/** Normalize gRPC simulateTransaction result to devInspect-compatible shape. */
function normGrpcSim(res) {
  if (!res || typeof res !== 'object') return res;
  const t = res.Transaction ?? res.transaction ?? res;
  const status = t.status ?? null;
  const ok = status?.success === true;
  const eff = t.effects ?? null;
  const gas = eff?.gasUsed ?? null;
  const gasUsed = gas
    ? {
        computationCost: String(gas.computationCost ?? gas.computation ?? 0),
        storageCost: String(gas.storageCost ?? gas.storage ?? 0),
        storageRebate: String(gas.storageRebate ?? 0),
      }
    : null;
  return {
    effects: { status: { status: ok ? 'success' : 'failure', error: status?.error ?? null }, gasUsed },
    events: t.events ?? [],
    balanceChanges: t.balanceChanges ?? [],
    commandResults: res.commandResults ?? [],
    _transport: 'grpc',
  };
}

export function normalizeChainIdentifier(value) {
  const s = String(value || '');
  if (/^[0-9a-f]{8}$/i.test(s)) return s.toLowerCase();
  try { const bytes = fromBase58(s); return bytes.length === 32 ? toHex(bytes).slice(0, 8) : null; }
  catch { return null; }
}
let canonicalChainPromise = null, canonicalChainAt = 0;
export async function assertNetworkConsistency(providerNetworks = {}) {
  if (!canonicalChainPromise || Date.now() - canonicalChainAt > 300_000) {
    canonicalChainAt = Date.now();
    const canonical = new SuiGrpcClient({ network: NETWORK, baseUrl: `https://fullnode.${NETWORK}.sui.io` });
    canonicalChainPromise = canonical.getChainIdentifier().then(r => normalizeChainIdentifier(r.chainIdentifier));
    canonicalChainPromise.catch(() => { canonicalChainPromise = null; });
  }
  const [actual, expected] = await Promise.all([SuiDataProvider.getChainIdentifier(), canonicalChainPromise]);
  const expectedChain = NETWORK;
  if (!expected || !actual.value || actual.value !== expected) {
    throw Object.assign(new Error('Configured RPC belongs to a different network; signing blocked.'), { code: 'NETWORK_MISMATCH' });
  }
  for (const [provider, network] of Object.entries(providerNetworks || {})) {
    if (network && String(network).toLowerCase() !== expectedChain) {
      throw Object.assign(new Error('PROVIDER_NETWORK_MISMATCH'), {
        code: 'PROVIDER_NETWORK_MISMATCH',
        message: `Provider ${provider} network ${network} does not match Sui network ${expectedChain}`,
      });
    }
  }
  return { ok: true, network: expectedChain, chainId: actual.value };
}
