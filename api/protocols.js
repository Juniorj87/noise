// GET /api/protocols — live protocol registry from Postgres.
import { handler } from './_lib/http.js';
import { listProtocols } from './_lib/adapters.js';

export default handler(async () => ({ protocols: await listProtocols() }));
