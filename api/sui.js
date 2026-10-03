// POST /api/sui — RPC proxy limited to simulation of user-approved tx bytes.
import { handler, readJson } from './_lib/http.js';
import { simulate } from './_lib/adapters.js';
import { isWalletAddress } from './_lib/services.js';

export default handler(async (req) => {
  if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
  const b = await readJson(req);
  if (b.method === 'simulate' && b.txBytes && b.sender && isWalletAddress(b.sender)) {
    return { simulation: await simulate(b.txBytes, b.sender) };
  }
  return { error: 'UNSUPPORTED_SUI_METHOD', message: 'Only method=simulate with txBytes and a valid sender is allowed.', status: 400 };
});
