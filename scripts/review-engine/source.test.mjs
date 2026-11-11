// Tests for lib/source.mjs: readDoc (decisions.md) and the EXTRA list of the live-mode self-check (amendment A3).
// The EXTRA list is injected by a function parameter only, so no env or flag can widen or narrow it in live mode.
// Failure modes:
//   R1 readDoc reads the live file instead of the map SHA, or reads --decisions in live mode
//   R2 a missing --decisions file is not a usage error; a missing doc at the SHA throws instead of null
//   X1 an EXTRA file that differs from main does not refuse (exit 3)
//   X2 an EXTRA file that is absent locally passes
//   X3 an EXTRA file that is equal fails
//   X5 the default EXTRA list is not the six files of design C.2, or an edited / missing one does not refuse
// Run: node --test scripts/review-engine/source.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRA, MAP_PATH, readDoc, selfCheck } from './lib/source.mjs';

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dirs = [];
const savedGit = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase().startsWith('GIT_')));
for (const k of Object.keys(savedGit)) delete process.env[k];
after(() => {
  Object.assign(process.env, savedGit);
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const git = (repo, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (repo, rel, text) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
};

// A primary checkout on main with one script file, one extra file and a map. Returns { repo, scriptDir, sha }.
function makeRepo(label, files = {}) {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), `re-src-${label}-`)));
  dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  put(repo, 'scripts/review-engine/lib/a.mjs', 'export const a = 1;\n');
  put(repo, 'scripts/shared/extra.mjs', 'export const e = 1;\n');
  put(repo, MAP_PATH, '# map on main\n');
  for (const rel of EXTRA) put(repo, rel, readFileSync(join(REAL_ROOT, rel), 'utf8')); // the real files, so the default list passes
  for (const [rel, text] of Object.entries(files)) put(repo, rel, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return { repo, scriptDir: join(repo, 'scripts', 'review-engine'), sha: git(repo, 'rev-parse', 'main') };
}

// ---- R: readDoc

const DOC = 'docs/review-engine/decisions.md';

test('R1 readDoc reads the doc at the map sha, not the working file', () => {
  const { repo, sha } = makeRepo('doc', { [DOC]: 'on main\n' });
  put(repo, DOC, 'edited later\n');
  const map = { testMode: false, repo, source: { kind: 'git', ref: 'main', sha } };
  assert.equal(readDoc(map, DOC, {}), 'on main\n');
});

test('R1b readDoc: in live mode --decisions is ignored; in test mode it wins over git', () => {
  const { repo, sha } = makeRepo('doc2', { [DOC]: 'on main\n' });
  const file = join(repo, 'dec.md');
  writeFileSync(file, 'from file\n');
  const source = { kind: 'git', ref: 'main', sha };
  assert.equal(readDoc({ testMode: false, repo, source }, DOC, { decisions: file }), 'on main\n');
  assert.equal(readDoc({ testMode: true, repo, source }, DOC, { decisions: file }), 'from file\n');
  assert.equal(readDoc({ testMode: true, repo, source }, DOC, {}), 'on main\n');
});

test('R2 readDoc: a map from a file has no sha, so the doc is null unless --decisions names one', () => {
  const map = { testMode: true, repo: null, source: { kind: 'file', path: 'm.md', sha256: 'x' } };
  assert.equal(readDoc(map, DOC, {}), null);
});

test('R2b readDoc: a doc absent at the sha is null; an unreadable --decisions file is exit 2', () => {
  const { repo, sha } = makeRepo('doc3');
  const git1 = { testMode: false, repo, source: { kind: 'git', ref: 'main', sha } };
  assert.equal(readDoc(git1, DOC, {}), null);
  assert.throws(() => readDoc({ ...git1, testMode: true }, DOC, { decisions: join(repo, 'missing.md') }), (e) => e.exitCode === 2 && /--decisions/.test(e.message));
});

// ---- X: EXTRA in the self-check

const EXTRA_REL = 'scripts/shared/extra.mjs';

test('X3 equal files pass with and without an EXTRA entry', () => {
  const { repo, scriptDir, sha } = makeRepo('x3');
  const slash = (p) => p.replaceAll('\\', '/');
  const same = (got) => assert.deepEqual({ repo: slash(got.repo), sha: got.sha }, { repo: slash(repo), sha });
  same(selfCheck(scriptDir));
  same(selfCheck(scriptDir, [EXTRA_REL]));
  assert.ok(Array.isArray(EXTRA));
});

test('X1 an EXTRA file that differs from main gives exit 3 and names the file', () => {
  const { scriptDir, repo } = makeRepo('x1');
  put(repo, EXTRA_REL, 'export const e = 2;\n');
  assert.equal(selfCheck(scriptDir).sha, selfCheck(scriptDir, []).sha);
  assert.throws(() => selfCheck(scriptDir, [EXTRA_REL]), (e) => e.exitCode === 3 && e.message.includes(`${EXTRA_REL} differs from main`));
});

test('X2 an EXTRA file that is absent locally, or absent on main, gives exit 3', () => {
  const { scriptDir, repo } = makeRepo('x2');
  assert.throws(() => selfCheck(scriptDir, ['scripts/shared/nope.mjs']), (e) => e.exitCode === 3 && /scripts\/shared\/nope\.mjs is (missing|not on main)/.test(e.message));
  put(repo, 'scripts/shared/new.mjs', 'export const n = 1;\n');
  assert.throws(() => selfCheck(scriptDir, ['scripts/shared/new.mjs']), (e) => e.exitCode === 3 && /scripts\/shared\/new\.mjs is not on main/.test(e.message));
});

test('X5 the default EXTRA list is the six design C.2 files, and an edited one gives exit 3 with the file named (F7)', () => {
  assert.deepEqual([...EXTRA].sort(), [
    'scripts/coordination/lane-dep.mjs', 'scripts/coordination/lane-seed-file.mjs', 'scripts/coordination/lane-sort.mjs',
    'scripts/coordination/lane.mjs', 'scripts/coordination/scratch-db.mjs', 'scripts/lib/resolve-deps.mjs',
  ]);
  for (const rel of EXTRA) {
    const { scriptDir, repo } = makeRepo('x5');
    assert.doesNotThrow(() => selfCheck(scriptDir), rel);
    put(repo, rel, `${readFileSync(join(repo, rel), 'utf8')}\n// edited\n`);
    assert.throws(() => selfCheck(scriptDir), (e) => e.exitCode === 3 && e.message.includes(`${rel} differs from main`), rel);
  }
});

test('X5b a default EXTRA file that is absent locally gives exit 3 with the file named', () => {
  const { scriptDir, repo } = makeRepo('x5b');
  rmSync(join(repo, 'scripts/coordination/lane-dep.mjs'));
  assert.throws(() => selfCheck(scriptDir), (e) => e.exitCode === 3 && e.message.includes('scripts/coordination/lane-dep.mjs is missing locally'));
});

test('X4 a script file that differs still refuses, with or without EXTRA', () => {
  const { scriptDir, repo } = makeRepo('x4');
  put(repo, 'scripts/review-engine/lib/a.mjs', 'export const a = 2;\n');
  assert.throws(() => selfCheck(scriptDir), (e) => e.exitCode === 3 && /lib\/a\.mjs differs from main/.test(e.message));
  assert.throws(() => selfCheck(scriptDir, [EXTRA_REL]), (e) => e.exitCode === 3);
});
