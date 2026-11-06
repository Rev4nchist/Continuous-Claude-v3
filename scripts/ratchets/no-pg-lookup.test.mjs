/**
 * no-pg-lookup.test.mjs: the ratchet that keeps new `pg` lookups out of scripts.
 * Each test names the change that breaks it:
 *   P1 every lookup form is found      breaks if a form (call, require, resolve, double quotes) stops matching
 *   P2 no false hit                    breaks if the pattern widens to pg-pool, a comment or a file with no createRequire
 *   P3 failing fixture                 breaks if the scan stops flagging a new copy (exit 1, file:line)
 *   P4 passing fixture                 breaks if a script that uses requireDep is flagged
 *   P5 allowlist                       breaks if the resolver itself is flagged
 *   P6 zero files                      breaks if an empty scan passes
 *   P7 the real repo                   breaks when a new copy lands (the baseline is 0)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOW, findPgLookups, scan } from './no-pg-lookup.mjs';

const RATCHET = path.join(path.dirname(fileURLToPath(import.meta.url)), 'no-pg-lookup.mjs');
const REAL_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const put = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const made = [];
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'nopg-')); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const run = (root) => spawnSync(process.execPath, [RATCHET, '--root', root], { encoding: 'utf8', windowsHide: true });

test('P1: each createRequire lookup form of pg is found, with its line number', () => {
  const forms = [
    "createRequire(pathToFileURL(a)).call(null, 'pg')",
    "createRequire(new URL('x', import.meta.url))('pg')",
    "const require = createRequire(import.meta.url);\nrequire(\"pg\")",
    'createRequire(import.meta.url).resolve(`pg`)',
  ];
  for (const form of forms) assert.ok(findPgLookups(`import { createRequire } from 'node:module';\n${form}\n`).length >= 1, form);
  assert.deepEqual(findPgLookups("x\ncreateRequire(a)('pg')\n"), [2]);
});

test('P2: pg-pool, a comment and a file without createRequire are not hits', () => {
  assert.deepEqual(findPgLookups("createRequire(a)('pg-pool')"), []);
  assert.deepEqual(findPgLookups("// createRequire(a)('pg')\n * createRequire(a)('pg')"), []);
  assert.deepEqual(findPgLookups("const x = lookup('pg');"), [], 'no createRequire in the file');
  assert.deepEqual(findPgLookups("createRequire(a)('typescript')"), []);
});

test('P3: a fixture with a new copy fails the ratchet and names file:line', () => {
  const root = tmp();
  put(path.join(root, 'scripts', 'probe.mjs'), "import { createRequire } from 'node:module';\nconst pg = createRequire(import.meta.url)('pg');\n");
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /scripts\/probe\.mjs:2/);
  assert.match(r.stdout, /RESULT: FAIL/);
});

test('P4: a fixture that uses the resolver passes', () => {
  const root = tmp();
  put(path.join(root, 'scripts', 'probe.mjs'), "import { requireDep } from './lib/resolve-deps.mjs';\nconst pg = requireDep('pg', { repoRoot: '.' });\n");
  const r = run(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /RESULT: PASS/);
  assert.match(r.stdout, /files: 1/);
});

test('P5: the resolver file is on the allowlist and is not flagged even when it holds the pattern', () => {
  assert.ok(ALLOW.has('scripts/lib/resolve-deps.mjs'));
  const root = tmp();
  put(path.join(root, 'scripts', 'lib', 'resolve-deps.mjs'), "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('pg');\n");
  assert.deepEqual(scan(root).hits, []);
});

test('P6: a scan of zero files fails', () => {
  const r = run(tmp());
  assert.equal(r.status, 1);
  assert.match(r.stdout, /scanned 0 files/);
});

test('P7: the real repo has 0 pg lookups outside the allowlist', () => {
  const { files, hits } = scan(REAL_REPO);
  assert.ok(files > 100, `scanned ${files} files`);
  assert.deepEqual(hits, []);
});
