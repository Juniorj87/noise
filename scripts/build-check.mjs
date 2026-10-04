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
for (const f of files) {
  try { await import(join(process.cwd(), f).replaceAll('\\', '/')); }
  catch (e) {
    // _lib modules have no default export side effects; only real syntax/parse errors throw TypeError-free
    if (String(e.message || e).includes('SyntaxError') || e instanceof SyntaxError) { console.error('SYNTAX', f, e.message); bad++; }
  }
}
if (bad) { console.error(bad + ' file(s) with syntax errors'); process.exit(1); }
console.log('build check OK — static frontend, ' + files.length + ' serverless modules parse');

// Prepare public/ directory for static frontend deployment
import { mkdirSync, cpSync, existsSync } from 'node:fs';

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
console.log('public directory prepared successfully');
