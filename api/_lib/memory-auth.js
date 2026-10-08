// Memory API ownership proof (Postgres/Vercel side).
// Flow: POST /api/memory/challenge {wallet} -> {message, expiresAt}.
// Wallet signs `message` (personal-message, never a transaction).
// POST /api/memory/session {wallet, message, signature} -> {token, expiresAt}.
// All other memory routes require the session token (x-memory-token header,
// memToken body field or ?memToken=) bound to the requested wallet.
// Tokens are stored sha256-hashed, 24h TTL. Nonces are single-use.
import { createHash, randomBytes } from 'node:crypto';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { getPool, ensureSchema } from './pg.js';
import {
  isWalletAddress, buildMemoryChallenge, parseMemoryChallenge,
  MEMORY_CHALLENGE_TTL_MS, MEMORY_SESSION_TTL_MS,
} from '../../shared/logic.js';

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

export async function issueChallenge(wallet) {
  if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  await ensureSchema();
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + MEMORY_CHALLENGE_TTL_MS).toISOString();
  const message = buildMemoryChallenge(wallet, nonce, expiresAt);
  await getPool().query(
    `INSERT INTO memory_challenges (nonce_hash, wallet, expires_at) VALUES ($1, $2, $3)`,
    [sha(message), wallet, expiresAt],
  ).catch(() => {});
  return { message, expiresAt };
}

export async function openSession(wallet, message, signature) {
  if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
  const parsed = parseMemoryChallenge(message);
  if (!parsed || parsed.wallet.toLowerCase() !== String(wallet).toLowerCase()) {
    throw Object.assign(new Error('INVALID_CHALLENGE'), { code: 'INVALID_CHALLENGE' });
  }
  if (Date.now() > new Date(parsed.expiresAt).getTime()) {
    throw Object.assign(new Error('CHALLENGE_EXPIRED'), { code: 'CHALLENGE_EXPIRED' });
  }
  await ensureSchema();
  const pool = getPool();
  const used = await pool.query(`SELECT wallet, expires_at FROM memory_challenges WHERE nonce_hash = $1`, [sha(message)]).catch(() => ({ rows: [] }));
  const row = used.rows && used.rows[0];
  if (!row || String(row.wallet).toLowerCase() !== String(wallet).toLowerCase() || Date.now() > new Date(row.expires_at).getTime()) {
    throw Object.assign(new Error('INVALID_CHALLENGE'), { code: 'INVALID_CHALLENGE' });
  }
  try {
    await verifyPersonalMessageSignature(new TextEncoder().encode(message), signature, { address: wallet });
  } catch {
    throw Object.assign(new Error('BAD_SIGNATURE'), { code: 'BAD_SIGNATURE' });
  }
  await pool.query(`DELETE FROM memory_challenges WHERE nonce_hash = $1`, [sha(message)]).catch(() => {});
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + MEMORY_SESSION_TTL_MS).toISOString();
  await pool.query(
    `INSERT INTO memory_sessions (token_hash, wallet, expires_at) VALUES ($1, $2, $3)`,
    [sha(token), wallet, expiresAt],
  );
  return { token, expiresAt };
}

/* Resolve and validate the session for a request. `getWallet()` extracts the
 * wallet the call claims to act for. Throws 401-shaped errors on mismatch. */
export async function requireSession(req, url, body, getWallet) {
  const token = req.headers?.['x-memory-token'] || (body && body.memToken) || (url && url.searchParams.get('memToken'));
  const wallet = typeof getWallet === 'function' ? getWallet() : getWallet;
  if (!token || !isWalletAddress(wallet)) {
    throw Object.assign(new Error('MEMORY_AUTH_REQUIRED'), { code: 'MEMORY_AUTH_REQUIRED', status: 401 });
  }
  await ensureSchema();
  const r = await getPool().query(`SELECT wallet, expires_at FROM memory_sessions WHERE token_hash = $1`, [sha(String(token))]).catch(() => ({ rows: [] }));
  const row = r.rows && r.rows[0];
  if (!row || String(row.wallet).toLowerCase() !== String(wallet).toLowerCase() || Date.now() > new Date(row.expires_at).getTime()) {
    throw Object.assign(new Error('MEMORY_AUTH_REQUIRED'), { code: 'MEMORY_AUTH_REQUIRED', status: 401 });
  }
  return String(row.wallet);
}

export async function closeSessions(wallet) {
  await ensureSchema();
  await getPool().query(`DELETE FROM memory_sessions WHERE wallet = $1`, [wallet]).catch(() => ({}));
  return { ok: true };
}
