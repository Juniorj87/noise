// Skill Registry + SwapProvider registry tests (spec §36-37, §7-12, #3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allSkills, skillCounts, skillIsSafe, SKILL_PERMISSIONS } from '../../shared/skills.js';
import { swapProviders, quotableSwapProviders } from '../../shared/swap-providers.js';
import { getProtocol } from '../../shared/registry.js';
import providersHandler from '../../api/_lib/handlers/providers.js';
import skillsHandler from '../../api/_lib/handlers/skills.js';

function mockRes() {
  const out = { statusCode: 0, headers: {}, body: '', ended: false };
  return {
    setHeader(k, v) { out.headers[k] = v; },
    end(d) { out.body = d; out.ended = true; },
    get statusCode() { return out.statusCode; },
    set statusCode(v) { out.statusCode = v; },
    get writableEnded() { return out.ended; },
    _out: out,
  };
}
function mockReq(method, url) {
  return { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}

test('skills: unique ids, valid status, never the same as another skill', () => {
  const ids = new Set();
  for (const s of allSkills()) {
    assert.ok(!ids.has(s.id), `duplicate skill ${s.id}`);
    ids.add(s.id);
    assert.ok(['AVAILABLE', 'COMING_SOON'].includes(s.status), `${s.id}: bad status`);
    assert.ok(s.name && s.purpose, `${s.id}: name/purpose required`);
  }
});

test('skills: permission model forbids private key and auto-sign on every skill', () => {
  for (const s of allSkills()) {
    assert.ok(skillIsSafe(s), `${s.id} is not safe`);
    assert.ok(s.never.includes('private-key') && s.never.includes('auto-sign'), `${s.id}: never-list`);
    for (const p of s.permissions) assert.ok(SKILL_PERMISSIONS.includes(p), `${s.id}: bad permission ${p}`);
  }
});

test('skills: COMING_SOON skills hold no permissions and declare a dependency', () => {
  for (const s of allSkills().filter((x) => x.status === 'COMING_SOON')) {
    assert.equal(s.permissions.length, 0, `${s.id}: coming-soon must hold no permissions`);
    assert.ok(s.requires.length > 0, `${s.id}: should declare requires[]`);
  }
});

test('skills: counts sum to registry length', () => {
  const c = skillCounts();
  assert.equal((c.AVAILABLE || 0) + (c.COMING_SOON || 0), allSkills().length);
});

test('swap providers: every provider exists in the ecosystem registry', () => {
  for (const p of swapProviders()) assert.ok(getProtocol(p.id), `swap provider ${p.id} missing from registry`);
});

test('swap providers: quotable providers are LIVE or PARTIAL, never DISCOVER', () => {
  for (const p of quotableSwapProviders()) {
    const r = getProtocol(p.id);
    assert.ok(['LIVE', 'PARTIAL'].includes(r.status), `${p.id}: quotable but registry says ${r.status}`);
  }
});

test('swap providers: buildable implies the registry claims execution', () => {
  for (const p of swapProviders()) {
    if (p.build) assert.equal(getProtocol(p.id).capability.execution, true, `${p.id}: build true but no execution`);
  }
});

test('swap providers: non-quotable providers carry an explicit reason (no fake quotes)', () => {
  for (const p of swapProviders()) {
    if (!p.quote) assert.ok(p.reason && p.reason.length > 2, `${p.id}: must state a reason`);
  }
});

/* ---- /api/providers + /api/skills run without a DB (no wallet) ---- */

test('GET /api/providers returns swap availability + summary, no fake quotes', async () => {
  const res = mockRes();
  await providersHandler(mockReq('GET', '/api/providers'), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res._out.body);
  assert.equal(body.swap.length, swapProviders().length);
  assert.ok(body.swapSummary.unavailable.length >= 1, 'unavailable providers must be reported');
  for (const p of body.swap) {
    if (p.available === false && !p.quote) assert.ok(p.reason, `${p.id}: reason required`);
  }
  assert.ok(body.ecosystem.LIVE >= 1);
});

test('GET /api/skills (no wallet) returns registry + permission model, no keys', async () => {
  const res = mockRes();
  await skillsHandler(mockReq('GET', '/api/skills'), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res._out.body);
  assert.equal(body.skills.length, allSkills().length);
  assert.deepEqual(body.permissionModel.forbidden, ['private-key', 'auto-sign']);
  for (const s of body.skills) {
    assert.equal(s.enabled, false);
    assert.equal(s.safe, true);
  }
});
