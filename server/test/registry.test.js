// ProtocolRegistry tests (spec §21, §2, §84) — integrity + honesty + UI sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROTOCOLS, STATUS, FILTERS, EXECUTION_ACTIONS,
  statusCounts, capabilityMatrix, uiRegistry, getProtocol, byBucket, searchProtocols,
} from '../../shared/registry.js';

test('registry: every protocol has unique id, valid status/bucket and a name', () => {
  const ids = new Set();
  for (const p of PROTOCOLS) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    assert.ok(STATUS.includes(p.status), `${p.id}: bad status ${p.status}`);
    assert.ok(FILTERS.includes(p.bucket), `${p.id}: bad bucket ${p.bucket}`);
    assert.ok(p.name && p.name.length > 1, `${p.id}: missing name`);
    assert.deepEqual(Object.keys(p.capability).sort(),
      ['data', 'earn', 'execution', 'position', 'swap', 'trade'], `${p.id}: capability shape`);
    for (const [k, v] of Object.entries(p.capability)) assert.equal(typeof v, 'boolean', `${p.id}.${k} must be boolean`);
  }
});

test('registry honesty: execution is only claimed by LIVE protocols', () => {
  for (const p of PROTOCOLS) {
    if (p.capability.execution) assert.equal(p.status, 'LIVE', `${p.id}: execution true but status ${p.status}`);
    if (p.status === 'DISCOVER' || p.status === 'COMING_SOON') {
      assert.equal(p.capability.execution, false, `${p.id}: ${p.status} must not execute`);
    }
  }
});

test('registry honesty: a LIVE protocol advertising execution actions must execute', () => {
  for (const p of PROTOCOLS) {
    const execActions = p.actions.filter((a) => EXECUTION_ACTIONS.includes(a));
    if (p.status === 'LIVE' && execActions.length) {
      assert.equal(p.capability.execution, true, `${p.id}: advertises ${execActions.join(',')} but cannot execute`);
    }
  }
});

test('registry honesty: PARTIAL never claims full execution', () => {
  for (const p of PROTOCOLS.filter((x) => x.status === 'PARTIAL')) {
    assert.equal(p.capability.execution, false, `${p.id}: PARTIAL must not be execution=true`);
  }
});

test('registry: required ecosystem protocols are present', () => {
  const required = [
    'sui', 'sui-native', 'deepbook', 'deepbook-predict', 'deepbook-margin',
    'cetus', 'aftermath', 'turbos', 'flowx', 'momentum', 'kriya',
    'bluefin-spot', 'bluefin-perps', 'navi', 'suilend', 'scallop', 'bucket',
    'haedal', 'volo', 'springsui', 'suipump', 'suibridge', 'wormhole',
    'walrus', 'seal',
  ];
  for (const id of required) assert.ok(getProtocol(id), `missing protocol ${id}`);
});

test('registry: bluefin spot and perps are separate entries', () => {
  assert.ok(getProtocol('bluefin-spot'));
  assert.ok(getProtocol('bluefin-perps'));
  assert.notEqual(getProtocol('bluefin-spot').id, getProtocol('bluefin-perps').id);
});

test('registry: DeepBook is the central Trade liquidity layer (spot live, margin coming)', () => {
  assert.equal(getProtocol('deepbook').status, 'LIVE');
  assert.equal(getProtocol('deepbook').capability.trade, true);
  assert.equal(getProtocol('deepbook-predict').status, 'LIVE');
  assert.equal(getProtocol('deepbook-margin').status, 'COMING_SOON');
});

test('registry: Walrus and Seal are not claimed as live execution', () => {
  for (const id of ['walrus', 'seal']) {
    const p = getProtocol(id);
    assert.equal(p.capability.execution, false);
    assert.ok(['DISCOVER', 'COMING_SOON', 'PARTIAL'].includes(p.status), `${id} must not be LIVE`);
  }
});

test('registry: statusCounts sums to protocol count and matches byStatus', () => {
  const counts = statusCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(total, PROTOCOLS.length);
  for (const st of STATUS) {
    assert.equal(counts[st], PROTOCOLS.filter((p) => p.status === st).length, `count mismatch for ${st}`);
  }
});

test('registry: capability matrix has a row per protocol with boolean cells', () => {
  const rows = capabilityMatrix();
  assert.equal(rows.length, PROTOCOLS.length);
  for (const r of rows) {
    for (const k of ['data', 'swap', 'trade', 'earn', 'position', 'execution']) {
      assert.equal(typeof r[k], 'boolean', `${r.id}.${k}`);
    }
  }
});

test('registry: bucket filter + search behave', () => {
  assert.ok(byBucket('ALL').length === PROTOCOLS.length);
  assert.ok(byBucket('LENDING').every((p) => p.bucket === 'LENDING'));
  assert.ok(searchProtocols('lending').length >= 4);
  assert.ok(searchProtocols('deepbook').some((p) => p.id === 'deepbook'));
});

/* ---- UI mirror sync: app.html must equal shared/registry.js ---- */

function readHtml() {
  return readFileSync(new URL('../../app.html', import.meta.url), 'utf8');
}

test('ui sync: app.html REGISTRY mirror equals uiRegistry()', () => {
  const html = readHtml();
  const block = html.match(/\/\* REGISTRY_JSON_START \*\/([\s\S]*?)\/\* REGISTRY_JSON_END \*\//);
  assert.ok(block, 'REGISTRY_JSON markers missing from app.html');
  const m = block[1].match(/const REGISTRY = (\[[\s\S]*\]);/);
  assert.ok(m, 'REGISTRY JSON not found between markers');
  const ui = JSON.parse(m[1]);
  assert.deepEqual(ui, uiRegistry(), 'app.html mirror drifted — run: node scripts/gen-ui-registry.mjs');
});

test('ui sync: app.html CAP_MATRIX equals capabilityMatrix()', () => {
  const html = readHtml();
  const m = html.match(/window\.CAP_MATRIX = ([^\n]*);/);
  assert.ok(m, 'window.CAP_MATRIX not found in app.html');
  const expected = Object.fromEntries(capabilityMatrix().map((r) => [r.id, r]));
  assert.deepEqual(JSON.parse(m[1]), expected, 'app.html CAP_MATRIX drifted — run: node scripts/gen-ui-registry.mjs');
});
