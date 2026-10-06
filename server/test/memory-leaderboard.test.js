// Memory / Leaderboard pass tests.
// Real-data honesty: no fake users, no invented metrics.
// SQLite dev DB with unique wallets per run + full cleanup. No network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Isolate this suite's SQLite dev DB so `npm test` never writes fixture
// wallets into the app's dev leaderboard (which must show real accounting only).
process.env.DB_PATH = './data/test-memory-leaderboard.db';

const RUN = Date.now().toString(36) + randomBytes(3).toString('hex');
const TEST_WALLETS = new Set();
const W = (n) => {
  const w = '0x' + n.toString(16).padStart(62, '0') + RUN.replace(/[^0-9a-f]/gi, 'a').slice(0, 2).padEnd(2, 'a');
  TEST_WALLETS.add(w);
  return w;
};

let S, A, L, db;
before(async () => {
  S = await import('../src/services.js');
  A = await import('../src/referral-analytics.js');
  L = await import('../../shared/logic.js');
  db = (await import('../src/db.js')).db;
});

const MEM_IDS = [];
after(() => {
  try {
    for (const id of MEM_IDS) db.prepare('DELETE FROM memory_records WHERE id = ?').run(id);
    for (const w of TEST_WALLETS) {
      db.prepare('DELETE FROM referral_attributions WHERE referrer = ? OR referred_wallet = ?').run(w, w);
    }
  } catch { /* best-effort */ }
});

/* ---------- leaderboard ---------- */
test('leaderboard: referrals metric orders by attributed count, deterministic ties', () => {
  const rows = [
    { wallet: W(201), referred: 3, activeReferrals: 1, eligibleRevenue: '10', earned: '1' },
    { wallet: W(202), referred: 7, activeReferrals: 0, eligibleRevenue: '0', earned: '0' },
    { wallet: W(203), referred: 7, activeReferrals: 2, eligibleRevenue: '5', earned: '0.5' },
  ];
  const sorted = [...rows].sort(L.leaderboardComparator('referrals'));
  assert.equal(sorted[0].referred, 7);
  assert.equal(sorted[1].referred, 7);
  // Tie on referred=7 → higher earned first (deterministic).
  assert.ok(Number(sorted[0].earned) >= Number(sorted[1].earned));
});

test('leaderboard: viewer position resolves; unknown wallet gets rank null, never fake rank', async () => {
  const lb = await A.getLeaderboard({ period: 'all', metric: 'earned', limit: 50, viewer: W(299) });
  assert.ok(lb.total >= 0);
  if (lb.viewer) assert.equal(lb.viewer.rank, null);
});

test('leaderboard: no fake users — every row wallet is a truncated real address', async () => {
  const lb = await A.getLeaderboard({ period: 'all', metric: 'earned', limit: 50 });
  for (const it of lb.items) {
    assert.match(it.wallet, /^0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/i);
  }
});

test('leaderboard: volume has no verified source — stays COMING_SOON', () => {
  assert.equal(L.LEADERBOARD_VOLUME_STATUS, 'COMING_SOON');
});

/* ---------- memory ---------- */
test('memory: create + search + ownership isolation', () => {
  const alice = W(301), bob = W(302);
  const m1 = S.saveMemory({ wallet: alice, category: 'preference', content: 'I prefer DeepBook for SUI/USDC' });
  const m2 = S.saveMemory({ wallet: alice, category: 'protocol-preference', content: 'Use Cetus aggregator for swaps' });
  MEM_IDS.push(m1.id, m2.id);
  const hits = S.searchMemory({ wallet: alice, query: 'deepbook SUI/USDC' });
  assert.ok(hits.some((h) => h.id === m1.id));
  const bobHits = S.searchMemory({ wallet: bob, query: 'deepbook' });
  assert.ok(!bobHits.some((h) => h.id === m1.id), 'owner-scoped: bob must not see alice memories');
});

test('memory: encryption state recorded; status active', () => {
  const alice = W(303);
  const m = S.saveMemory({ wallet: alice, category: 'workflow-preference', content: 'Notify me on Monday yields' });
  MEM_IDS.push(m.id);
  const row = db.prepare('SELECT status, encryption, owner FROM memory_records WHERE id = ?').get(m.id);
  assert.equal(row.status, 'active');
  assert.equal(row.owner, alice);
  assert.equal(row.encryption, 'local');
});

test('memory: deletion removes from index', () => {
  const alice = W(304);
  const m = S.saveMemory({ wallet: alice, category: 'preference', content: 'Temporary note alpha' });
  MEM_IDS.push(m.id);
  db.prepare("UPDATE memory_records SET status = 'deleted' WHERE id = ?").run(m.id);
  const hits = S.searchMemory({ wallet: alice, query: 'temporary alpha' });
  assert.ok(!hits.some((h) => h.id === m.id));
});

/* ---------- security ---------- */
test('security: private key / seed / password / secret never stored', () => {
  const w = W(307);
  for (const bad of [
    'my private key suiprivkey123',
    'seed phrase twelve words here',
    'recovery phrase backup words',
    'wallet password hunter2',
    'api key AKIA123456',
  ]) {
    assert.throws(() => S.saveMemory({ wallet: w, category: 'preference', content: bad }), /FORBIDDEN_CONTENT/);
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM memory_records WHERE wallet = ?').get(w).c;
  assert.equal(count, 0);
});

test('security: secret scan helper catches key kinds', () => {
  assert.equal(L.findSecretKind('my private key ...'), 'private-key');
  assert.equal(L.findSecretKind('seed phrase backup'), 'seed-phrase');
  assert.equal(L.findSecretKind('my password is x'), 'password');
  assert.equal(L.findSecretKind('I prefer DeepBook for SUI/USDC'), null);
});
