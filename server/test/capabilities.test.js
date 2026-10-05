// Action capability tests (production capability fix) + UI mirror sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTION_CAPABILITIES, CAP_STATES, isExecutable, executionStatus, uiCapabilities } from '../../shared/capabilities.js';
import { aftermathAdapter } from '../../api/_lib/adapters.js';

test('every action declares all five stages with a valid state', () => {
  for (const [id, c] of Object.entries(ACTION_CAPABILITIES)) {
    for (const stage of ['data', 'quote', 'build', 'simulate', 'execute']) {
      assert.ok(c[stage] !== undefined, `${id}.${stage} missing`);
      assert.ok(c[stage] === '—' || CAP_STATES.includes(c[stage]), `${id}.${stage} bad state ${c[stage]}`);
    }
  }
});

test('execution is only allowed when execute === LIVE', () => {
  assert.equal(isExecutable('swap'), true);
  assert.equal(isExecutable('stake'), true);
  assert.equal(isExecutable('predict_mint'), true);
  assert.equal(isExecutable('supply'), false);
  assert.equal(isExecutable('borrow'), false);
  assert.equal(isExecutable('repay'), false);
  assert.equal(isExecutable('withdraw'), false);
  assert.equal(isExecutable('claim'), false);
  assert.equal(isExecutable('liquidity'), false);
  assert.equal(isExecutable('transfer'), false);
  assert.equal(isExecutable('unknown_action'), false);
});

test('READ_ONLY / UNAVAILABLE actions are correctly blocked', () => {
  for (const id of Object.keys(ACTION_CAPABILITIES)) {
    const st = executionStatus(id);
    if (st !== 'LIVE') assert.equal(isExecutable(id), false, `${id} must be blocked`);
  }
});

test('Aftermath capability split: quote live, build/execute not wired', () => {
  assert.equal(aftermathAdapter.capabilities.quote, true);
  assert.equal(aftermathAdapter.capabilities.build, false);
  assert.equal(aftermathAdapter.capabilities.simulate, false);
  assert.equal(aftermathAdapter.capabilities.execute, false);
});

test('ui sync: app.html ACTION_CAPABILITIES equals uiCapabilities()', () => {
  const html = readFileSync(new URL('../../app.html', import.meta.url), 'utf8');
  const block = html.match(/\/\* CAP_JSON_START \*\/([\s\S]*?)\/\* CAP_JSON_END \*\//);
  assert.ok(block, 'CAP_JSON markers missing from app.html');
  const m = block[1].match(/window\.ACTION_CAPABILITIES = (\{[\s\S]*\});/);
  assert.ok(m, 'ACTION_CAPABILITIES JSON not found');
  assert.deepEqual(JSON.parse(m[1]), uiCapabilities(), 'mirror drifted — run node scripts/gen-ui-registry.mjs');
});

test('UI gate: openReview is guarded by capability.execute', () => {
  const html = readFileSync(new URL('../../app.html', import.meta.url), 'utf8');
  assert.match(html, /cap\.execute !== 'LIVE'\) \{ showProviderGate/, 'openReview must gate on execute');
  assert.match(html, /function showProviderGate/, 'showProviderGate must exist');
});
