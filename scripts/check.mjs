// Pre-open-source self check: syntax + sensitive strings + package.json fields
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgs = join(root, 'packages');
const BAD = ['25437', 'dsh12345', 'BEGIN PRIVATE KEY', 'sk-', 'ghp_'];
let fail = 0;

for (const name of readdirSync(pkgs)) {
  const dir = join(pkgs, name);
  if (!existsSync(join(dir, 'package.json'))) continue;
  const j = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const k of ['name', 'version', 'description', 'license', 'repository', 'files']) {
    if (!j[k]) { console.log('MISSING package.json field', k, 'in', name); fail++; }
  }
  if (!existsSync(join(dir, 'README.md'))) { console.log('MISSING README.md in', name); fail++; }
  const lib = join(dir, 'lib');
  if (!existsSync(lib)) continue;
  for (const f of readdirSync(lib)) {
    if (!f.endsWith('.js')) continue;
    const p = join(lib, f);
    try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); }
    catch (e) { console.log('SYNTAX FAIL', name + '/' + f, String(e.stderr || e).slice(0, 200)); fail++; }
    const txt = readFileSync(p, 'utf8');
    for (const b of BAD) if (txt.includes(b)) { console.log('SENSITIVE', b, 'in', name + '/' + f); fail++; }
  }
}
console.log(fail ? 'CHECK FAILED: ' + fail : 'CHECK OK');
process.exit(fail ? 1 : 0);
