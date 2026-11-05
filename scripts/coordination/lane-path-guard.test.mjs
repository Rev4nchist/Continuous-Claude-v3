// Tests for the relative-path ratchet (lane-path-guard.mjs).
//
// What the guard protects: model-run text that says `node scripts/coordination/lane.mjs ...` fails in every project
// that is not CCv3, and runs a stale copy inside a worktree. The shim path is the only form that works everywhere.
//
// How the guard can fail, one test each:
//   - a count that rises above the baseline passes silently (the ratchet does not ratchet)
//   - an equal count fails (it must pass: old debt is allowed, new debt is not)
//   - an absolute, home or /continuous-claude/ path counts as a bare one (false positive, then every fix looks like a loss)
//   - a bare mention in a new file (not in the baseline) is ignored (baseline default must be 0)
//   - text outside the scope (docs/, a hooks __tests__ file) counts
//   - --update raises a baseline, or hides a rise
//   - a file in scope is never read (the scan is vacuous): the result must carry the number of files scanned
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countBare, scanRepo, checkLanePaths, updateBaseline } from './lane-path-guard.mjs';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'lane-path-guard.mjs');
const BARE = 'node scripts/coordination/lane.mjs board';

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'lane-path-guard-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const baselineFile = (dir, files) => {
  const f = join(dir, 'baseline.json');
  writeFileSync(f, JSON.stringify({ files }));
  return f;
};

test('countBare counts a bare relative path and ignores absolute, home and primary-checkout forms', () => {
  assert.equal(countBare(BARE), 1);
  assert.equal(countBare('`scripts/coordination/lane.mjs`'), 1);
  assert.equal(countBare('"scripts/coordination/lane.mjs"'), 1);
  assert.equal(countBare('<code>scripts/coordination/lane.mjs</code>'), 1);
  assert.equal(countBare('run ./scripts/coordination/lane.mjs now'), 1);
  assert.equal(countBare('node ../scripts/coordination/lane.mjs board'), 1);
  assert.equal(countBare('node ../../scripts/coordination/lane.mjs board'), 1);
  assert.equal(countBare('node ..\\scripts\\coordination\\lane.mjs board'), 1);
  assert.equal(countBare('scripts\\coordination\\lane.mjs'), 1);
  assert.equal(countBare('node C:/Users/dkhay/continuous-claude/scripts/coordination/lane.mjs board'), 0);
  assert.equal(countBare('node C:\\Users\\dkhay\\continuous-claude\\scripts\\coordination\\lane.mjs board'), 0);
  assert.equal(countBare('node /c/Users/dkhay/continuous-claude/scripts/coordination/lane.mjs'), 0);
  assert.equal(countBare('node $HOME/continuous-claude/scripts/coordination/lane.mjs'), 0);
  assert.equal(countBare('node ~/continuous-claude/scripts/coordination/lane.mjs'), 0);
  assert.equal(countBare('node <primary>/scripts/coordination/lane.mjs'), 0);
  assert.equal(countBare('node /continuous-claude/scripts/coordination/lane.mjs'), 0);
});

test('countBare does not count other scripts and counts every occurrence on a line', () => {
  assert.equal(countBare('scripts/coordination/lane-board.mjs and scripts/coordination/render-board.mjs'), 0);
  assert.equal(countBare('scripts/coordination/lane.mjs, then scripts/coordination/lane.mjs again'), 2);
});

test('scanRepo reads the scoped files only and reports how many files it read', () => {
  const dir = repo({
    'CLAUDE.md': BARE,
    'CONTEXT.md': 'nothing',
    '.claude/skills/a/SKILL.md': `${BARE}\n${BARE}`,
    '.claude/skills/a/other.md': BARE, // not SKILL.md: out of scope
    '.claude/rules-src/r.md': BARE,
    '.claude/rules-ondemand/o.md': BARE,
    '.claude/hooks/src/h.ts': `// ${BARE}`,
    '.claude/hooks/src/__tests__/h.test.ts': BARE, // excluded
    'docs/old.md': BARE, // out of scope
    'thoughts/x.md': BARE,
  });
  const r = scanRepo(dir);
  assert.deepEqual(Object.fromEntries(r.counts), {
    'CLAUDE.md': 1,
    '.claude/skills/a/SKILL.md': 2,
    '.claude/rules-src/r.md': 1,
    '.claude/rules-ondemand/o.md': 1,
    '.claude/hooks/src/h.ts': 1,
  });
  assert.equal(r.scanned, 6,'CLAUDE.md, CONTEXT.md, SKILL.md, rules-src, rules-ondemand and the hook source were read');
});

test('a count that rises above the baseline fails and names the file', () => {
  const dir = repo({ 'CLAUDE.md': `${BARE}\n${BARE}` });
  const r = checkLanePaths({ repo: dir, baselinePath: baselineFile(dir, { 'CLAUDE.md': 1 }) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.over, [{ file: 'CLAUDE.md', count: 2, baseline: 1 }]);
  assert.equal(r.total, 2);
});

test('an equal count passes, and so does a lower one', () => {
  const dir = repo({ 'CLAUDE.md': BARE, 'AGENTS.md': 'clean' });
  const base = baselineFile(dir, { 'CLAUDE.md': 1, 'AGENTS.md': 3 });
  const r = checkLanePaths({ repo: dir, baselinePath: base });
  assert.equal(r.ok, true);
  assert.deepEqual(r.over, []);
  assert.equal(r.total, 1);
});

test('a bare mention in a file the baseline does not list is a rise from 0', () => {
  const dir = repo({ '.claude/rules-src/new.md': BARE });
  const r = checkLanePaths({ repo: dir, baselinePath: baselineFile(dir, {}) });
  assert.equal(r.ok, false);
  assert.equal(r.over[0].file, '.claude/rules-src/new.md');
  assert.equal(r.over[0].baseline, 0);
});

test('an absolute path never counts, so replacing a bare path with the shim path lowers the count', () => {
  const dir = repo({ 'CLAUDE.md': 'node C:/Users/dkhay/.claude/scripts/lane.mjs board and node C:/Users/dkhay/continuous-claude/scripts/coordination/lane.mjs' });
  const r = checkLanePaths({ repo: dir, baselinePath: baselineFile(dir, { 'CLAUDE.md': 1 }) });
  assert.equal(r.ok, true);
  assert.equal(r.total, 0);
});

test('a missing baseline file is reported, not treated as an empty baseline that passes', () => {
  const dir = repo({ 'CLAUDE.md': 'clean' });
  const r = checkLanePaths({ repo: dir, baselinePath: join(dir, 'none.json') });
  assert.equal(r.ok, false);
  assert.equal(r.baselineMissing, true);
});

test('updateBaseline lowers counts, drops zeros, and refuses a rise', () => {
  const dir = repo({ 'CLAUDE.md': BARE, 'AGENTS.md': 'clean' });
  const base = baselineFile(dir, { 'CLAUDE.md': 3, 'AGENTS.md': 2 });
  const u = updateBaseline({ repo: dir, baselinePath: base });
  assert.equal(u.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(base, 'utf8')).files, { 'CLAUDE.md': 1 });

  writeFileSync(join(dir, 'CLAUDE.md'), `${BARE}\n${BARE}`);
  const before = readFileSync(base, 'utf8');
  const refused = updateBaseline({ repo: dir, baselinePath: base });
  assert.equal(refused.ok, false);
  assert.equal(readFileSync(base, 'utf8'), before, 'a refused update must not write');
});

test('updateBaseline creates a missing baseline from the current counts, once', () => {
  const dir = repo({ 'CLAUDE.md': BARE });
  const base = join(dir, 'new-baseline.json');
  const u = updateBaseline({ repo: dir, baselinePath: base });
  assert.equal(u.ok, true);
  assert.ok(existsSync(base));
  assert.deepEqual(JSON.parse(readFileSync(base, 'utf8')).files, { 'CLAUDE.md': 1 });
});

test('CLI: exit 0 at baseline, exit 1 over it, and --update rewrites downward only', () => {
  const dir = repo({ 'CLAUDE.md': BARE });
  const base = baselineFile(dir, { 'CLAUDE.md': 1 });
  const run = (...a) => spawnSync(process.execPath, [GUARD, '--repo', dir, '--baseline', base, ...a], { encoding: 'utf8', windowsHide: true });
  const ok = run();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /lane-path-guard: 1 bare/);
  writeFileSync(join(dir, 'CLAUDE.md'), `${BARE}\n${BARE}`);
  const bad = run();
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stdout + bad.stderr, /CLAUDE\.md/);
  const upd = run('--update');
  assert.equal(upd.status, 1, 'an update cannot hide a rise');
});
