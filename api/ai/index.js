// POST /api/ai — chat; keys env-only; answers grounded in live tools.
import { handler, readJson } from '../_lib/http.js';
import { aiChat } from '../_lib/ai.js';

export default handler(async (req) => {
  if (req.method !== 'POST') return { error: 'INVALID_REQUEST', message: 'POST required.', status: 400 };
  const b = await readJson(req);
  if (!b.message) return { error: 'MISSING_MESSAGE', message: 'message is required.', status: 400 };
  return await aiChat(b);
});
