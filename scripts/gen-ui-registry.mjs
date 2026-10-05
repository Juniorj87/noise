// Regenerates the app.html registry mirror from the single source of truth
// (shared/registry.js). Idempotent: operates on the REGISTRY_JSON_START/END
// markers and the CAP_MATRIX line injected the first time.
//
//   node scripts/gen-ui-registry.mjs
//
// server/test/registry.test.js fails if the mirror drifts from the registry.
import { readFileSync, writeFileSync } from 'node:fs';
import { uiRegistry, capabilityMatrix } from '../shared/registry.js';
import { uiCapabilities } from '../shared/capabilities.js';

const path = process.argv[2] || 'app.html';
let s = readFileSync(path, 'utf8');

const json = JSON.stringify(uiRegistry());
const capJson = JSON.stringify(Object.fromEntries(capabilityMatrix().map((r) => [r.id, r])));

const startRe = /(\/\* REGISTRY_JSON_START \*\/\r?\n)[^\n]*(\r?\n\s*\/\* REGISTRY_JSON_END \*\/)/;
if (!startRe.test(s)) throw new Error(`${path}: REGISTRY_JSON markers not found — run the initial injection first.`);
s = s.replace(startRe, (m, a, b) => a + '        const REGISTRY = ' + json + ';' + b);

const capRe = /(window\.CAP_MATRIX = )[^\n]*;/;
if (capRe.test(s)) s = s.replace(capRe, (m, a) => a + capJson + ';');

// Action capability table mirrored between CAP_JSON markers.
const acJson = JSON.stringify(uiCapabilities());
const acRe = /(\/\* CAP_JSON_START \*\/\r?\n)[^\n]*(\r?\n\s*\/\* CAP_JSON_END \*\/)/;
if (!acRe.test(s)) throw new Error(`${path}: CAP_JSON markers not found — add them once after REGISTRY_JSON_END.`);
s = s.replace(acRe, (m, a, b) => a + '        window.ACTION_CAPABILITIES = ' + acJson + ';' + b);

writeFileSync(path, s);
console.log(`${path}: registry mirror regenerated (${uiRegistry().length} protocols, ${Object.keys(uiCapabilities()).length} actions)`);
