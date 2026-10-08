// Sui RPC layer — @mysten/sui. Mainnet/testnet strictly separated (§39).
// Single source of truth: NETWORK is resolved here; adapters import it — never re-derive.
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';

export const NETWORK = (process.env.SUI_NETWORK || 'mainnet').toLowerCase() === 'testnet' ? 'testnet' : 'mainnet';
const RPC_URL = process.env.SUI_RPC_URL || (NETWORK === 'testnet' ? 'https://fullnode.testnet.sui.io:443' : 'https://sui-rpc.publicnode.com');

function makeClient(network, url) {
  if (url) return new SuiJsonRpcClient({ url });
  return new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(network) });
}

export const sui = {
  network: NETWORK,
  client: makeClient(NETWORK, RPC_URL),
  testClient: null,
  rpcUrl: RPC_URL,
};

export function testClient() {
  if (!sui.testClient) sui.testClient = makeClient('testnet', undefined);
  return sui.testClient;
}

export async function getBalances(wallet) {
  return sui.client.getAllBalances({ owner: wallet });
}

export async function getStakes(wallet) {
  return sui.client.getStakes({ owner: wallet });
}

export async function getOwnedObjects(wallet, limit = 50) {
  const res = await sui.client.getOwnedObjects({
    owner: wallet,
    filter: null,
    options: { showType: true },
    limit,
  });
  return res.data ?? [];
}

/**
 * Real simulation path: devInspectTransactionBlock (§7 lifecycle).
 * devInspect expects TransactionKind bytes — convert full tx bytes first.
 */
export async function simulate(txBytes, sender) {
  const { Transaction } = await import('@mysten/sui/transactions');
  const tx = Transaction.from(Buffer.from(String(txBytes), 'base64'));
  if (tx.getData().sender !== sender.toLowerCase()) throw Object.assign(new Error('Transaction sender mismatch'), { code: 'INVALID_WALLET' });
  return sui.client.dryRunTransactionBlock({ transactionBlock: Buffer.from(String(txBytes), 'base64') });
}
