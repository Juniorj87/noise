// DeepBook order persistence (PostgreSQL). The DB row is a server-side record;
// the CHAIN is always authoritative for order state — rows are refreshed from
// the chain (getOrderNormalized / accountOpenOrders) and never treated as the
// source of truth. Off-book orders become CLOSED (outcome lives on chain), the
// hub never guesses between FILLED and CANCELLED without evidence.
import { randomBytes } from 'node:crypto';
import { getPool, ensureSchema } from './pg.js';
import { resolveOrderStatus } from '../../shared/deepbook-logic.js';

const uid = (prefix = 'dbord') => prefix + '_' + Date.now().toString(36) + randomBytes(4).toString('hex');

/** Insert or update a recorded order. Unique key: (wallet, market, order_id). */
export async function upsertDeepbookOrder(o) {
  await ensureSchema();
  const pool = getPool();
  if (!o.wallet || !o.market || !o.side || o.quantity === undefined) {
    throw Object.assign(new Error('INVALID_ORDER_RECORD'), { code: 'INVALID_REQUEST' });
  }
  const id = uid();
  await pool.query(
    `INSERT INTO deepbook_orders (id, wallet, market, order_id, side, type, price, quantity, filled_quantity, status, tx_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (wallet, market, order_id) DO UPDATE SET
       price = EXCLUDED.price,
       quantity = EXCLUDED.quantity,
       filled_quantity = EXCLUDED.filled_quantity,
       status = EXCLUDED.status,
       tx_digest = COALESCE(EXCLUDED.tx_digest, deepbook_orders.tx_digest),
       updated_at = now()`,
    [id, o.wallet, o.market, o.orderId || null, o.side, o.type || 'LIMIT',
      o.price != null ? String(o.price) : null, String(o.quantity),
      String(o.filledQuantity ?? 0), o.status || 'OPEN', o.txDigest || null]);
  const row = o.orderId
    ? (await pool.query('SELECT * FROM deepbook_orders WHERE wallet = $1 AND market = $2 AND order_id = $3', [o.wallet, o.market, o.orderId])).rows[0]
    : (await pool.query('SELECT * FROM deepbook_orders WHERE id = $1', [id])).rows[0];
  return row;
}

/**
 * Update a recorded order from chain data (tracker refresh).
 * `orderId` links an unassigned row (placed order appears on the book).
 * Final statuses are never overwritten.
 */
export async function updateDeepbookOrderStatus(wallet, market, orderId, { status, filledQuantity, txDigest, newOrderId } = {}) {
  await ensureSchema();
  const pool = getPool();
  const sets = ['updated_at = now()'];
  const vals = [];
  let n = 1;
  if (status !== undefined) { sets.push(`status = $${n}`); vals.push(status); n++; }
  if (filledQuantity !== undefined) { sets.push(`filled_quantity = $${n}`); vals.push(String(filledQuantity)); n++; }
  if (txDigest) { sets.push(`tx_digest = $${n}`); vals.push(txDigest); n++; }
  if (newOrderId) { sets.push(`order_id = $${n}`); vals.push(String(newOrderId)); n++; }
  vals.push(wallet, market, orderId);
  const r = await pool.query(
    `UPDATE deepbook_orders SET ${sets.join(', ')}
     WHERE wallet = $${n} AND market = $${n + 1} AND order_id = $${n + 2}
       AND status NOT IN ('FILLED','CANCELLED','EXPIRED','CLOSED')
     RETURNING *`,
    vals);
  return r.rows[0] || null;
}

/** Recorded orders for a wallet (optionally per market / only resting ones). */
export async function listDeepbookOrders({ wallet, market = null, openOnly = false, limit = 100 }) {
  await ensureSchema();
  const pool = getPool();
  const where = ['wallet = $1'];
  const vals = [wallet];
  if (market) { where.push(`market = $${vals.length + 1}`); vals.push(market); }
  if (openOnly) where.push(`status IN ('OPEN','PARTIALLY_FILLED')`);
  vals.push(Math.min(Number(limit) || 100, 500));
  const r = await pool.query(
    `SELECT * FROM deepbook_orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${vals.length}`,
    vals);
  return r.rows;
}

export async function getDeepbookOrder(wallet, market, orderId) {
  await ensureSchema();
  const r = await getPool().query(
    'SELECT * FROM deepbook_orders WHERE wallet = $1 AND market = $2 AND order_id = $3',
    [wallet, market, orderId]);
  return r.rows[0] || null;
}

/**
 * One cron pass over recorded OPEN/PARTIALLY_FILLED orders:
 * - still on the book → update fills/status from the chain;
 * - unassigned row (order_id NULL) + exactly one unlinked chain order → link it;
 * - left the book → status CLOSED (hub never guesses FILLED vs CANCELLED).
 * getOrders: async (wallet, market) => normalized chain orders (adapter).
 */
export async function refreshDeepbookOpenOrders(getOrders) {
  await ensureSchema();
  const pool = getPool();
  const resting = (await pool.query("SELECT DISTINCT wallet, market FROM deepbook_orders WHERE status IN ('OPEN','PARTIALLY_FILLED')")).rows;
  const out = [];
  for (const { wallet, market } of resting) {
    let chainOrders = [];
    try {
      chainOrders = (await getOrders(wallet, market)) || [];
    } catch { continue; } // provider down → retry next tick, honest
    const onBook = new Map(chainOrders.map((o) => [String(o.orderId), o]));
    const linkedIds = new Set(
      (await pool.query('SELECT order_id FROM deepbook_orders WHERE wallet = $1 AND market = $2 AND order_id IS NOT NULL', [wallet, market])).rows
        .map((r) => String(r.order_id)));
    const rows = (await pool.query("SELECT * FROM deepbook_orders WHERE wallet = $1 AND market = $2 AND status IN ('OPEN','PARTIALLY_FILLED')", [wallet, market])).rows;
    const unassigned = rows.filter((r) => !r.order_id);
    for (const row of rows) {
      if (!row.order_id) continue; // handled below
      const chain = onBook.get(String(row.order_id));
      if (chain) {
        const status = chain.status || resolveOrderStatus(chain.rawStatus, chain.filledQuantity);
        if (status !== row.status || String(chain.filledQuantity) !== String(row.filled_quantity)) {
          await updateDeepbookOrderStatus(wallet, market, row.order_id, { status, filledQuantity: chain.filledQuantity });
          out.push({ wallet, market, orderId: row.order_id, status, filled: String(chain.filledQuantity) });
        }
      } else {
        // Left the book: filled or cancelled on chain — the row cannot know which.
        await updateDeepbookOrderStatus(wallet, market, row.order_id, { status: 'CLOSED' });
        out.push({ wallet, market, orderId: row.order_id, status: 'CLOSED', note: 'off-book — outcome on chain' });
      }
    }
    // Link exactly-one unambiguous candidate to an unassigned row (never guess).
    if (unassigned.length === 1) {
      const candidates = chainOrders.filter((o) => !linkedIds.has(String(o.orderId)));
      if (candidates.length === 1) {
        const c = candidates[0];
        await updateDeepbookOrderStatus(wallet, market, '', {
          newOrderId: String(c.orderId),
          status: c.status || 'OPEN',
          filledQuantity: c.filledQuantity ?? 0,
          txDigest: unassigned[0].tx_digest || undefined,
        });
        out.push({ wallet, market, orderId: String(c.orderId), status: 'linked', note: 'unassigned row linked to chain order' });
      }
    }
  }
  return { checked: resting.length, updated: out };
}

export const deepbookDb = {
  upsertDeepbookOrder, updateDeepbookOrderStatus, listDeepbookOrders,
  getDeepbookOrder, refreshDeepbookOpenOrders,
};
