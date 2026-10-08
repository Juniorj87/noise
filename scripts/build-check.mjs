// Static frontend — nothing to compile. Fails fast if the serverless layer has syntax errors.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, depth = 0) {
  if (depth > 4) return;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, depth + 1);
    else if (/\.(js|mjs)$/.test(e)) files.push(p);
  }
}
const files = [];
walk('api', 0);
let bad = 0;
import { pathToFileURL } from 'node:url';
for (const f of files) {
  try { await import(pathToFileURL(join(process.cwd(), f)).href); }
  catch (e) {
    console.error('IMPORT_FAILED', f, e.code || e.name, String(e.message).slice(0, 200)); bad++;
  }
}
if (bad) { console.error(bad + ' file(s) with syntax errors'); process.exit(1); }
console.log('build check OK — static frontend, ' + files.length + ' serverless modules parse');

// Check inline frontend JavaScript syntax without executing UI code.
const { readFileSync } = await import('node:fs');
const { spawnSync } = await import('node:child_process');
for (const html of ['index.html', 'app.html', 'docs.html', 'admin.html']) {
  const text = readFileSync(html, 'utf8');
  for (const match of text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/src\s*=/.test(match[1]) || !match[2].trim()) continue;
    if (/importmap|application\/(?:ld\+)?json/.test(match[1])) { JSON.parse(match[2]); continue; }
    const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: match[2], encoding: 'utf8' });
    if (checked.status !== 0) { console.error('FRONTEND_SYNTAX', html, checked.stderr); process.exit(1); }
  }
}
console.log('Inline frontend scripts parse successfully');

// Prepare public/ directory for static frontend deployment
import { mkdirSync, cpSync, existsSync, writeFileSync } from 'node:fs';

const publicDir = join(process.cwd(), 'public');
if (!existsSync(publicDir)) {
  mkdirSync(publicDir, { recursive: true });
}
for (const f of ['index.html', 'app.html', 'docs.html', 'admin.html']) {
  const p = join(process.cwd(), f);
  if (existsSync(p)) cpSync(p, join(publicDir, f));
}
const assetsDir = join(process.cwd(), 'assets');
if (existsSync(assetsDir)) {
  cpSync(assetsDir, join(publicDir, 'assets'), { recursive: true });
}
// Emit the canonical ProtocolRegistry as a static artifact (single source of truth).
const { serializeRegistry } = await import('../shared/registry.js');
writeFileSync(join(publicDir, 'registry.json'), serializeRegistry());
console.log('public/registry.json written');
console.log('public directory prepared successfully');

mkdirSync(join(publicDir,'shared'),{recursive:true});
cpSync('shared/journey-model.js',join(publicDir,'shared/journey-model.js'));
