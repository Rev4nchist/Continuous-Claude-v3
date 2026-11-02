// Tests for prove-check.mjs. Run: node --test scripts/checks/prove-check.test.mjs
// The harness proves a check with a fire at the pre-fix SHA P and no fire at the fix SHA F.
// Each test names the source change that breaks it. A fire counts only when a failing
// line matches the row's fireMatch. An import or compile error is not a fire.
//
// Ways the harness can fail, one test each:
//   PC0 a good proof (fire at P, clean at F) is reported ok. Without it, every "not ok" test below is vacuous.
//   PC1 a P run that passes is reported ok.
//       breaks it: compare P to "no-fire" instead of "fire" in judge()
//   PC2 a P run that dies on an import or compile error is read as a fire.
//       breaks it: count any non-zero exit as a fire, or test fireMatch before the broken-run markers
//   PC3 an F run that still fires is reported ok, or the F run is skipped, or P runs twice.
//       breaks it: skip the F run, or pass the P tree to the F run
//   PC4 an F run that dies on an import error is read as "no fire" (a clean F that proves nothing).
//       breaks it: treat a broken F run as no-fire
//   PC5 a row with an empty or invalid fireMatch (which would fire on every run) is accepted.
//       breaks it: drop the checks in validateRow()
//   PC6 zero rows is reported as a pass (a vacuous gate).
//       breaks it: return 0 when the row list is empty
//   PC7 a passing test whose title equals fireMatch is read as a fire.
//       breaks it: test fireMatch against the whole output, not against failing lines only
//   PC8 a Semgrep result for another rule, or none, is read as a fire; a scan error is read as clean.
//       breaks it: parse results without check_id, or ignore the errors array
//   PC9 the real pipeline: git archive of P and F, copy, run, artifact (end to end, temp repo).
//       breaks it: archive the same sha for both phases, or skip the copy step
//   PC10 a fix that does not fix (F still fires) exits 1 through the real CLI.
//       breaks it: exit 0 whatever the verdicts are
//   PC11 a run that exits non-zero with no output (docker exit 125), or a Semgrep row with no JSON, is read as clean.
//       breaks it: drop the "exit != 0 and no failing line" or the "Semgrep row printed no JSON" check
//   PC12 a Semgrep hit is matched by line number only, so a fix that moves the line reads as clean.
//       breaks it: ignore row.fireText
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRowLock, rowLockPath, classifyRun, validateRow, judge, proveRow, substitute, realDeps, InputError } from './prove-check.mjs';

const SCRIPT = fileURLToPath(new URL('./prove-check.mjs', import.meta.url));
const SHIPPED_PROOFS = fileURLToPath(new URL('./proofs.json', import.meta.url));

const ROW = {
  major: '#9',
  check: 'demo',
  pre: 'P',
  fix: 'F',
  paths: ['src'],
  copy: [],
  cmd: ['{node}', 'check.mjs'],
  fireMatch: 'FAIL add',
  expect: { pre: 'fire', fix: 'no-fire' },
};
const run = (code, stdout, stderr = '') => ({ code, stdout, stderr });
const FIRE = run(1, 'TAP version 13\nnot ok 1 - FAIL add\n');
const CLEAN = run(0, 'TAP version 13\nok 1 - FAIL add\n');

/** Fake deps: buildTree names a tree after the ref, runCmd records which tree it ran in. */
function fakes(outputs) {
  const calls = [];
  return {
    calls,
    buildTree: (row, ref) => ({ ref, sha: ref, tree: `/t/${ref}`, copied: [] }),
    runCmd: (row, tree) => {
      calls.push(tree);
      return outputs[tree];
    },
  };
}

test('PC0 fire at P and clean at F is a passing proof, and the fire line is named', () => {
  const d = fakes({ '/t/P': FIRE, '/t/F': CLEAN });
  const r = proveRow(ROW, d);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.pre.verdict, 'fire');
  assert.equal(r.pre.fireLine, 'not ok 1 - FAIL add');
  assert.equal(r.fix.verdict, 'no-fire');
});

test('PC1 a P run that passes is a proof FAIL', () => {
  const r = judge(ROW, CLEAN, CLEAN);
  assert.equal(r.ok, false);
  assert.equal(r.pre.verdict, 'no-fire');
  assert.match(r.reasons.join('\n'), /pre-fix run did not fire/);
});

test('PC2 a P run that dies on an import or compile error is a proof FAIL, never a fire', () => {
  const broken = [
    run(1, '', "Error: Cannot find module './lib.mjs'\n"),
    run(1, '', "SyntaxError: The requested module './lib.mjs' does not provide an export named 'add'\n"),
    run(1, '', 'tests\\corpus.test.ts:\n(fail) the file did not load\n  cannot import "../x.mjs": it is outside the plugin\'s folder\n'),
    run(1, '', "x.ts(3,9): error TS2305: Module './lib' has no exported member 'add'.\n"),
    run(1, '', "'add' is not exported by lib.mjs\n"),
    run(1, '', 'Error: No tests found.\n'),
  ];
  for (const p of broken) {
    const r = judge(ROW, p, CLEAN);
    assert.equal(r.ok, false, JSON.stringify(p));
    assert.equal(r.pre.verdict, 'broken', JSON.stringify(p));
  }
  // the failing line and the import error in one run: the run is still broken
  const both = run(1, 'not ok 1 - FAIL add\n', "Error: Cannot find module './lib.mjs'\n");
  assert.equal(judge(ROW, both, CLEAN).pre.verdict, 'broken');
  // a dead spawn (Docker missing, timeout) is broken, not a fire
  const spawnFail = { code: null, stdout: '', stderr: '', error: 'spawn ENOENT' };
  assert.equal(judge(ROW, spawnFail, CLEAN).pre.verdict, 'broken');
});

test('PC3 an F run that still fires is a proof FAIL, and F runs in the F tree', () => {
  const d = fakes({ '/t/P': FIRE, '/t/F': FIRE });
  const r = proveRow(ROW, d);
  assert.equal(r.ok, false);
  assert.equal(r.fix.verdict, 'fire');
  assert.match(r.reasons.join('\n'), /fix run still fires/);
  assert.deepEqual(d.calls, ['/t/P', '/t/F'], 'one run in the P tree, then one in the F tree');
});

test('PC4 an F run that dies on an import error is a proof FAIL, not a clean F', () => {
  const r = judge(ROW, FIRE, run(1, '', "Error: Cannot find module './lib.mjs'\n"));
  assert.equal(r.ok, false);
  assert.equal(r.fix.verdict, 'broken');
});

test('PC5 a row that would fire on every run is refused', () => {
  const bad = [
    { ...ROW, fireMatch: '' },
    { ...ROW, fireMatch: undefined },
    { ...ROW, fireMatch: '(' },
    { ...ROW, fireMatch: '.*' }, // matches the empty string, so it matches every line
    { ...ROW, cmd: [] },
    { ...ROW, paths: [] },
    { ...ROW, pre: '' },
    { ...ROW, expect: { pre: 'no-fire', fix: 'fire' } },
  ];
  for (const row of bad) assert.throws(() => validateRow(row), InputError, JSON.stringify(row));
  assert.doesNotThrow(() => validateRow(ROW));
});

test('PC6 zero rows is exit 2 with a "no rows" line, not a pass (the shipped proofs.json, real CLI)', () => {
  const shipped = JSON.parse(readFileSync(SHIPPED_PROOFS, 'utf8'));
  assert.ok(Array.isArray(shipped.rows), 'proofs.json holds a rows array');
  // a check name no row will ever use, so this stays a "no rows" test after the c1, c2 and c5 rows land
  const r = spawnSync(process.execPath, [SCRIPT, '--check', 'no-such-check'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /no rows/i);
});

test('PC7 only a failing line fires: a passing test with the same title does not', () => {
  const row = { ...ROW, fireMatch: 'corpus R57' };
  const cases = [
    // [output, fires]
    ['(fail) next steps corpus > corpus R57 em dash\n', true],
    ['(pass) next steps corpus > corpus R57 em dash\n', false],
    ['not ok 3 - corpus R57\n', true],
    ['ok 3 - corpus R57\n', false],
    ['  ✖ corpus R57 (2ms)\n', true],
    ['  ✔ corpus R57 (2ms)\n', false],
    ['  ✘  4 e2e\\x.spec.ts:22:3 › corpus R57 (10ms)\n', true],
    ['  ✓  4 e2e\\x.spec.ts:22:3 › corpus R57 (10ms)\n', false],
    ['  1) e2e\\x.spec.ts:22:3 › corpus R57\n', true],
  ];
  for (const [stdout, fires] of cases) {
    const v = classifyRun(row, run(fires ? 1 : 0, stdout));
    assert.equal(v.verdict, fires ? 'fire' : 'no-fire', JSON.stringify(stdout));
  }
  // a failing line for a different test does not fire this row
  assert.equal(classifyRun(row, run(1, 'not ok 2 - corpus R58\n')).verdict, 'no-fire');
});

test('PC8 Semgrep: only a result of the named rule fires; a scan error is broken', () => {
  const row = { ...ROW, fireMatch: 'ccv3-graphql-connection-no-pageinfo scripts/github/review-status\\.mjs:12$' };
  const res = (id, file, line) => ({ check_id: id, path: file, start: { line } });
  const out = (results, errors = []) => run(0, JSON.stringify({ results, errors }));
  const hit = out([res('rules.ccv3-graphql-connection-no-pageinfo', 'scripts/github/review-status.mjs', 12)]);
  const v = classifyRun(row, hit);
  assert.equal(v.verdict, 'fire');
  assert.equal(v.fireLine, 'rules.ccv3-graphql-connection-no-pageinfo scripts/github/review-status.mjs:12');
  // another rule, another file, another line, and no result at all: no fire (exit code 0 in every case)
  const misses = [
    out([res('rules.ccv3-argv-index-as-path', 'scripts/github/review-status.mjs', 12)]),
    out([res('rules.ccv3-graphql-connection-no-pageinfo', 'scripts/github/other.mjs', 12)]),
    out([res('rules.ccv3-graphql-connection-no-pageinfo', 'scripts/github/review-status.mjs', 13)]),
    out([]),
  ];
  for (const m of misses) assert.equal(classifyRun(row, m).verdict, 'no-fire', m.stdout);
  // a rule that failed to load or a file that failed to parse: broken, even with exit 0
  const err = out([], [{ level: 'error', type: 'Rule parse error', message: 'bad rule' }]);
  assert.equal(classifyRun(row, err).verdict, 'broken');
});

test('PC11 a run that exits non-zero with no failing line, or a Semgrep row with no JSON, is broken, never a clean fix', () => {
  // docker exit 125 (daemon down, bad mount) prints nothing on stdout
  assert.equal(classifyRun(ROW, run(125, '', '')).verdict, 'broken');
  assert.equal(judge(ROW, FIRE, run(125, '', '')).ok, false);
  const sgRow = { ...ROW, cmd: ['{docker}', 'run', '{image}', 'semgrep', 'scan', '--json'], fireMatch: 'rule-x a\\.mjs:\\d+$' };
  // a Semgrep row whose run printed no JSON did not scan anything, even with exit 0
  assert.equal(classifyRun(sgRow, run(0, '')).verdict, 'broken');
  assert.equal(classifyRun(sgRow, run(0, 'Error response from daemon')).verdict, 'broken');
  // still a clean fix: a non-zero exit that names a different failing test, and a Semgrep JSON with no results
  assert.equal(classifyRun(ROW, run(1, 'not ok 2 - other\n')).verdict, 'no-fire');
  assert.equal(classifyRun(sgRow, run(0, JSON.stringify({ results: [], errors: [] }))).verdict, 'no-fire');
});

test('PC12 fireText: a Semgrep hit fires only when its source line matches, so a moved line cannot pass a fix', () => {
  const tree = mkdtempSync(path.join(tmpdir(), 'pc12-'));
  mkdirSync(path.join(tree, 'src'), { recursive: true });
  writeFileSync(path.join(tree, 'src', 'a.mjs'), 'const OTHER_QUERY = 1;\nconst COMMENTS_QUERY = 2;\n');
  const row = { ...ROW, cmd: ['semgrep', '--json'], fireMatch: 'rule-x src/a\\.mjs:\\d+$', fireText: '^const COMMENTS_QUERY = ' };
  const at = (line) => ({ ...run(0, JSON.stringify({ results: [{ check_id: 'rule-x', path: 'src/a.mjs', start: { line } }], errors: [] })), tree });
  assert.equal(classifyRun(row, at(2)).verdict, 'fire');
  assert.equal(classifyRun(row, at(1)).verdict, 'no-fire');
  // a hit whose source line cannot be read proves nothing
  assert.equal(classifyRun(row, { ...at(2), tree: path.join(tree, 'missing') }).verdict, 'broken');
  assert.throws(() => validateRow({ ...row, fireText: '(' }), InputError);
  assert.throws(() => validateRow({ ...row, fireText: '.*' }), InputError);
  assert.throws(() => validateRow({ ...ROW, fireText: 'x' }), /Semgrep/);
});

test('PC15 a row whose tree is held by a live run is a setup error, and nothing is built or run', () => {
  const calls = [];
  const deps = {
    acquire: () => { throw new Error('tree is in use by pid 4242'); },
    buildTree: (row, ref) => { calls.push(ref); return { ref, sha: ref, tree: `/t/${ref}`, copied: [] }; },
    runCmd: () => { calls.push('run'); return FIRE; },
  };
  const r = proveRow(ROW, deps);
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /setup error: tree is in use/);
  assert.deepEqual(calls, []);
  // the lock is released after a run, also when the run throws
  let released = 0;
  const d2 = { ...fakes({ '/t/P': FIRE, '/t/F': CLEAN }), acquire: () => () => { released += 1; } };
  assert.equal(proveRow(ROW, d2).ok, true);
  const d3 = { ...d2, runCmd: () => { throw new Error('spawn failed'); } };
  assert.equal(proveRow(ROW, d3).ok, false);
  assert.equal(released, 2);
});

test('PC16 the real lock: a second acquire of the same row fails while the first holds it, and works after release', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'pc16-'));
  const a = acquireRowLock(repo, ROW);
  assert.throws(() => acquireRowLock(repo, ROW), /in use/);
  a();
  const b = acquireRowLock(repo, ROW);
  b();
  // a lock left by a dead process is refused with the file to delete, never taken over: two runs that both saw the
  // stale lock could each remove the other's fresh lock (CLI fix review of 3bcd46c)
  const lockFile = rowLockPath(repo, ROW);
  mkdirSync(path.dirname(lockFile), { recursive: true });
  writeFileSync(lockFile, '999999999');
  assert.throws(() => acquireRowLock(repo, ROW), (e) => /stale lock/.test(e.message) && e.message.includes(lockFile));
  assert.equal(readFileSync(lockFile, 'utf8'), '999999999');
});

test('PC17 the lock is held until the verdict is read: a fireText hit reads the tree before release', () => {
  const tree = mkdtempSync(path.join(tmpdir(), 'pc17-'));
  mkdirSync(path.join(tree, 'src'), { recursive: true });
  writeFileSync(path.join(tree, 'src', 'a.mjs'), 'const COMMENTS_QUERY = 2;\n');
  const row = { ...ROW, cmd: ['semgrep', '--json'], fireMatch: 'rule-x src/a\\.mjs:\\d+$', fireText: '^const COMMENTS_QUERY = ' };
  const hit = { code: 0, stdout: JSON.stringify({ results: [{ check_id: 'rule-x', path: 'src/a.mjs', start: { line: 1 } }], errors: [] }), stderr: '', tree };
  const none = { code: 0, stdout: JSON.stringify({ results: [], errors: [] }), stderr: '', tree };
  const deps = {
    // release stands for a second run that clears the tree as soon as it gets the lock
    acquire: () => () => rmSync(tree, { recursive: true, force: true }),
    buildTree: (r, ref) => ({ ref, sha: ref, tree, copied: [] }),
    runCmd: (r, t) => (r.pre === 'P' && !deps.seen ? ((deps.seen = true), hit) : none),
  };
  const r = proveRow(row, deps);
  assert.equal(r.pre.verdict, 'fire', JSON.stringify(r.reasons));
  assert.equal(r.ok, true);
});

// ---- end to end: real git archive, real copy, real child process, real CLI --------------------------------------

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A temp repo with a bug commit and a fix commit, and an untracked check script (the "oracle"). */
function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'prove-check-'));
  git(root, 'init', '-q');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'lib.mjs'), 'export const add = (a, b) => a - b;\n');
  git(root, 'add', 'src');
  git(root, 'commit', '-q', '-m', 'bug');
  writeFileSync(path.join(root, 'src', 'lib.mjs'), 'export const add = (a, b) => a + b;\n');
  git(root, 'commit', '-q', '-am', 'fix');
  writeFileSync(
    path.join(root, 'check.mjs'),
    "import { add } from './src/lib.mjs';\nif (add(2, 3) !== 5) { console.log('not ok 1 - FAIL add'); process.exit(1); }\nconsole.log('ok 1 - add');\n",
  );
  return root;
}

function prove(root, rows) {
  writeFileSync(path.join(root, 'proofs.json'), JSON.stringify({ rows }));
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--check', 'demo', '--repo', root, '--proofs', path.join(root, 'proofs.json'), '--date', '2026-11-01'],
    { encoding: 'utf8' },
  );
  return { status: r.status, out: r.stdout + r.stderr };
}

const GOOD_ROW = { ...ROW, pre: 'HEAD~1', fix: 'HEAD', copy: [{ from: 'check.mjs', to: 'check.mjs' }] };

test('PC9 real pipeline: P is archived and fires, F is archived and is clean, the artifact names both', () => {
  const root = makeRepo();
  try {
    const r = prove(root, [GOOD_ROW]);
    assert.equal(r.status, 0, r.out);
    const art = JSON.parse(readFileSync(path.join(root, '.claude', 'cache', 'e2e', '2026-11-01-prove-demo.json'), 'utf8'));
    assert.equal(art.rows.length, 1);
    const [row] = art.rows;
    assert.equal(row.ok, true);
    assert.equal(row.pre.verdict, 'fire');
    assert.equal(row.pre.fireLine, 'not ok 1 - FAIL add');
    assert.equal(row.fix.verdict, 'no-fire');
    assert.notEqual(row.pre.sha, row.fix.sha, 'two different commits');
    assert.equal(row.pre.sha, git(root, 'rev-parse', 'HEAD~1'));
    assert.equal(row.fix.sha, git(root, 'rev-parse', 'HEAD'));
    // the trees sit under .claude/cache/proof/<sha8>/ and hold the archived source of that commit
    for (const phase of [row.pre, row.fix]) {
      assert.ok(existsSync(phase.tree), phase.tree);
      assert.ok(phase.tree.includes(path.join('proof', phase.sha.slice(0, 8))), phase.tree);
    }
    assert.match(readFileSync(path.join(row.pre.tree, 'src', 'lib.mjs'), 'utf8'), /a - b/);
    assert.match(readFileSync(path.join(row.fix.tree, 'src', 'lib.mjs'), 'utf8'), /a \+ b/);
    assert.ok(row.pre.copied.some((c) => c.to === 'check.mjs' && /^[0-9a-f]{64}$/.test(c.sha256)), 'copy is recorded with a hash');
    assert.ok(existsSync(path.join(root, '.claude', 'cache', 'e2e', '2026-11-01-prove-demo.txt')), 'the .txt log is written');
    assert.match(readFileSync(path.join(root, '.claude', 'cache', 'e2e', '2026-11-01-prove-demo.txt'), 'utf8'), /not ok 1 - FAIL add/);
    assert.deepEqual(readdirSync(path.join(root, 'src')).sort(), ['lib.mjs'], 'the working tree is not touched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PC10 a fix that does not fix exits 1 through the real CLI; a broken row exits 1 too', () => {
  const root = makeRepo();
  try {
    const stillFires = prove(root, [{ ...GOOD_ROW, fix: 'HEAD~1' }]);
    assert.equal(stillFires.status, 1, stillFires.out);
    assert.match(stillFires.out, /FAIL/);
    const noCheck = prove(root, [{ ...GOOD_ROW, copy: [] }]); // check.mjs is not in the archive: Cannot find module
    assert.equal(noCheck.status, 1, noCheck.out);
    assert.match(noCheck.out, /broken/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PC13 {rules} becomes the join of repo/scripts/ratchets/semgrep-ccv3, and no shipped row hard-codes a backslash path', () => {
  // breaks it: put a literal "{repo}\\scripts\\ratchets\\..." back in a proofs.json row, or drop {rules} from substitute()
  const repo = path.join(path.sep, 'home', 'u', 'repo');
  const ctx = { tree: path.join(repo, 't'), repo, node: 'node', docker: 'docker', image: 'img' };
  const [arg] = substitute(['{rules}:/rules:ro'], ctx);
  assert.equal(arg, `${path.join(repo, 'scripts', 'ratchets', 'semgrep-ccv3')}:/rules:ro`);
  const rows = JSON.parse(readFileSync(SHIPPED_PROOFS, 'utf8')).rows.filter((r) => r.cmd.includes('semgrep'));
  assert.ok(rows.length >= 3, `expected the three c2 Semgrep rows, got ${rows.length}`);
  for (const r of rows) {
    assert.ok(r.cmd.includes('{rules}:/rules:ro'), `${r.major}: mount uses {rules}`);
    assert.ok(!r.cmd.some((a) => a.includes('\\')), `${r.major}: no backslash in any cmd argument`);
  }
});

test('PC14 buildTree clears a tree left by an earlier run, so a stale file cannot flip a verdict', () => {
  // breaks it: drop the rmSync before mkdirSync in buildTree()
  const root = makeRepo();
  try {
    const deps = realDeps({ repo: root });
    const first = deps.buildTree(GOOD_ROW, 'HEAD');
    const stale = path.join(first.tree, 'stale-from-earlier-copy-list.mjs');
    writeFileSync(stale, 'export {};\n');
    assert.ok(existsSync(stale));
    const second = deps.buildTree(GOOD_ROW, 'HEAD');
    assert.equal(second.tree, first.tree, 'same tree path is reused');
    assert.ok(!existsSync(stale), 'the stale file is gone');
    assert.ok(existsSync(path.join(second.tree, 'src', 'lib.mjs')), 'the archive is rebuilt');
    assert.ok(existsSync(path.join(second.tree, 'check.mjs')), 'the copy is rebuilt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
