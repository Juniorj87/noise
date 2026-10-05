// /api/skills — GET registry (+ per-wallet enable state); POST /api/skills/toggle.
// Skills can read data, build transactions and REQUEST a signature — never a
// private key and never auto-sign (spec §36-37, §73-74).
import { handler, readJson } from '../http.js';
import { allSkills, skillCounts, skillIsSafe, SKILL_PERMISSIONS } from '../../../shared/skills.js';
import { isWalletAddress } from '../services.js';
import { getPool, ensureSchema } from '../pg.js';

const FORBIDDEN = ['private-key', 'auto-sign'];

export default handler(async (req, res, url) => {
  const action = url.pathname.split('/').pop();

  if (req.method === 'POST' || action === 'toggle') {
    const b = await readJson(req);
    if (!isWalletAddress(b.wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    if (!b.skill || !allSkills().some((s) => s.id === b.skill)) {
      return { error: 'INVALID_SKILL', message: 'Unknown skill.', status: 400 };
    }
    await ensureSchema();
    await getPool().query(
      `INSERT INTO permissions (wallet, scope, granted) VALUES ($1,$2,$3)
       ON CONFLICT (wallet, scope) DO UPDATE SET granted = EXCLUDED.granted, updated_at = now()`,
      [b.wallet, 'skill:' + b.skill, b.enabled ? 1 : 0]);
    return { ok: true, skill: b.skill, enabled: Boolean(b.enabled) };
  }

  const wallet = url.searchParams.get('wallet');
  const granted = {};
  if (wallet) {
    if (!isWalletAddress(wallet)) throw Object.assign(new Error('INVALID_WALLET'), { code: 'INVALID_WALLET' });
    await ensureSchema();
    const rows = (await getPool().query(
      "SELECT scope, granted FROM permissions WHERE wallet = $1 AND scope LIKE 'skill:%'", [wallet])).rows;
    for (const r of rows) granted[r.scope] = Number(r.granted) === 1;
  }
  const skills = allSkills().map((s) => ({
    ...s,
    enabled: wallet ? Boolean(granted['skill:' + s.id]) : false,
    safe: skillIsSafe(s),
  }));
  return {
    skills,
    counts: skillCounts(),
    permissionModel: { allowed: SKILL_PERMISSIONS, forbidden: FORBIDDEN },
    updatedAt: new Date().toISOString(),
    source: 'Noise skill registry',
  };
});
