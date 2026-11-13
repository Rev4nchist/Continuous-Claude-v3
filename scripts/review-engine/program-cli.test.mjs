// End-to-end tests for scripts/review-engine/program.mjs. Each test runs the real CLI with spawnSync (argv array, no shell).
// Live-mode tests copy program.mjs and lib/ into a temp git repo, so the self-check compares real blob ids.
// Temp folders are named re-cli-<label>-<random>, with no space; a space in a path is covered by the seed --out file name.
// Every folder is removed by after() and again by an exit handler, so a failed or interrupted run leaves none (a hard kill still can).
// Run: node --test scripts/review-engine/program-cli.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dbTarget, EXTRA } from './lib/source.mjs';
import { main } from './program.mjs';
import { row, edge, ev, life } from './fixtures/rows.fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'map.fixture.md');
const FIXTURE_TEXT = readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n');
const SCRATCH_URL = 'postgresql://u:p@localhost:5432/lanes_pr1_ab12cd34';
const LIVE_URL = 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';
const dirs = [];

const TEMP_PREFIX = 're-cli-';
const REAL_ROOT = join(HERE, '..', '..');
const tempDir = (label) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `${TEMP_PREFIX}${label}-`)));
  dirs.push(dir);
  return dir;
};
const cleanup = () => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); };
after(cleanup);
process.on('exit', cleanup);

// The parent env minus every GIT_* variable, so a run inside a git hook cannot reach the real repo (T5).
// Also minus the three database URL variables, the session id and the board override (A2): no run here inherits a database by accident.
const AMBIENT = ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL', 'CLAUDE_CODE_SESSION_ID', 'LANE_PROJECT'];
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_') && !AMBIENT.includes(k)));

const git = (repo, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const put = (repo, rel, text) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
};

// A temp repo on main with the program, its libs and the fixture map. extra: { relPath: text } committed too.
function makeRepo(label, extra = {}) {
  const repo = tempDir(label);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'true');
  mkdirSync(join(repo, 'scripts', 'review-engine'), { recursive: true });
  cpSync(join(HERE, 'program.mjs'), join(repo, 'scripts', 'review-engine', 'program.mjs'));
  cpSync(join(HERE, 'lib'), join(repo, 'scripts', 'review-engine', 'lib'), { recursive: true });
  // The files outside scripts/review-engine that the live self-check compares (EXTRA), so a live run in the temp repo passes.
  for (const rel of EXTRA) put(repo, rel, readFileSync(join(REAL_ROOT, rel), 'utf8'));
  put(repo, 'docs/review-engine/map.md', FIXTURE_TEXT);
  for (const [rel, text] of Object.entries(extra)) put(repo, rel, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

// Run program.mjs from a repo (or a worktree) with cwd set to it.
function run(repo, args, env = {}) {
  const prog = join(repo, 'scripts', 'review-engine', 'program.mjs');
  const r = spawnSync(process.execPath, [prog, ...args], { cwd: repo, encoding: 'utf8', env: { ...cleanEnv(), ...env } });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr, first: r.stdout.split(/\r?\n/)[0], all: `${r.stdout}\n${r.stderr}` };
}

// Test mode, with the fixture file as the map. Works from any repo, so a dirty program file does not matter.
const testRun = (repo, args) => run(repo, [...args, '--test-mode', '--map', FIXTURE, '--repo', repo]);

const mainSha = (repo) => git(repo, 'rev-parse', 'main');
const readOnly = makeRepo('live');

// ---- live mode: self-check and map source

test('C1 live mode with equal files: exit 0, first line names the main sha', () => {
  const r = run(readOnly, ['check', '--table']);
  assert.equal(r.code, 0, r.all);
  assert.equal(r.first, `map main@${mainSha(readOnly).slice(0, 12)} docs/review-engine/map.md`);
  assert.match(r.out, /RESULT pass \(0 errors\)/);
});

test('C2 program.mjs edited: exit 3 and the file is named', () => {
  const repo = makeRepo('c2');
  appendFileSync(join(repo, 'scripts/review-engine/program.mjs'), '\n// edited\n');
  const r = run(repo, ['check', '--table']);
  assert.equal(r.code, 3);
  assert.match(r.err, /scripts\/review-engine\/program\.mjs/);
  assert.match(r.err, /README\.md/);
});

test('C3 only lib/map-parse.mjs edited: exit 3', () => {
  const repo = makeRepo('c3');
  appendFileSync(join(repo, 'scripts/review-engine/lib/map-parse.mjs'), '\n// edited\n');
  const r = run(repo, ['check', '--table']);
  assert.equal(r.code, 3);
  assert.match(r.err, /lib\/map-parse\.mjs/);
});

test('C4 core.autocrlf=true and a CRLF working file: not refused (blob ids, not bytes)', () => {
  const repo = makeRepo('c4');
  const file = join(repo, 'scripts/review-engine/program.mjs');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
  const r = run(repo, ['check', '--table']);
  assert.equal(r.code, 0, r.all);
});

test('C5 a module that is absent on main: exit 3', () => {
  const repo = makeRepo('c5');
  put(repo, 'scripts/review-engine/lib/extra.mjs', 'export const x = 1;\n');
  const r = run(repo, ['check', '--table']);
  assert.equal(r.code, 3);
  assert.match(r.err, /lib\/extra\.mjs/);
  assert.match(r.err, /not on main/);
});

test('C6 live mode in a linked worktree: exit 3 with the worktree message', () => {
  const repo = makeRepo('c6');
  const wt = `${repo}-wt`;
  dirs.push(wt);
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
  const r = run(wt, ['check', '--table']);
  assert.equal(r.code, 3);
  assert.match(r.err, /linked worktree/);
  assert.match(r.err, /primary checkout/);
});

test('C7 --map, --map-ref and --repo without --test-mode: exit 3', () => {
  for (const flag of [['--map', FIXTURE], ['--map-ref', 'main'], ['--repo', readOnly]]) {
    const r = run(readOnly, ['check', '--table', ...flag]);
    assert.equal(r.code, 3, `${flag[0]}: ${r.all}`);
    assert.match(r.err, /--test-mode/);
  }
});

// ---- test mode

test('C8 test mode: banner on line 1, testMode true in JSON, self-check skipped on a dirty program', () => {
  const repo = makeRepo('c8');
  appendFileSync(join(repo, 'scripts/review-engine/program.mjs'), '\n// edited\n');
  const text = testRun(repo, ['check', '--table']);
  assert.equal(text.code, 0, text.all);
  assert.equal(text.first, `TEST MODE: self-check skipped; map file ${FIXTURE}`);
  const json = JSON.parse(testRun(repo, ['check', '--table', '--json']).out);
  assert.equal(json.testMode, true);
  assert.equal(json.mapSource.kind, 'file');
  assert.match(json.mapSource.sha256, /^[0-9a-f]{64}$/);
});

test('C8b test mode with --map-ref reads the map from git and names the sha', () => {
  const r = run(readOnly, ['check', '--table', '--test-mode', '--map-ref', 'main', '--repo', readOnly]);
  assert.equal(r.code, 0, r.all);
  assert.equal(r.first, `TEST MODE: self-check skipped; map main@${mainSha(readOnly).slice(0, 12)} docs/review-engine/map.md`);
});

test('C8c --map and --map-ref together: exit 2', () => {
  const r = run(readOnly, ['check', '--table', '--test-mode', '--map', FIXTURE, '--map-ref', 'main']);
  assert.equal(r.code, 2);
});

test('check --table prints the counts and examined lines; --json has both', () => {
  const r = testRun(readOnly, ['check', '--table']);
  assert.match(r.out, /^check --table: 7 lanes, 1 external, 1 dropped, 7 edges, 5 held$/m);
  assert.match(r.out, /^examined: ownerChains 2, ownerPhrases 1, overlapPairs 4, deps 7, heldTokens 6, sections 8, rows 7, dropped 1, chainUnparsed 0, packs 0$/m);
  assert.match(r.out, /^NOTE owns-exempt /m);
  const json = JSON.parse(testRun(readOnly, ['check', '--table', '--json']).out);
  assert.deepEqual(json.counts, { lanes: 7, externals: 1, dropped: 1, edges: 7, held: 5 });
  assert.equal(json.examined.deps, 7);
  assert.equal(json.ok, true);
  assert.equal(json.verb, 'check --table');
});

test('a lint error gives exit 1 and a FAIL line with the map line', () => {
  const dir = tempDir('lint');
  const bad = join(dir, 'bad map.md');
  writeFileSync(bad, FIXTURE_TEXT.replace('fx-base, fx-ext |', 'fx-base, fx-nope |'));
  const r = run(readOnly, ['check', '--table', '--test-mode', '--map', bad, '--repo', readOnly]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^FAIL dep-unknown .*fx-nope.* \[map\.md:\d+\]$/m);
  assert.match(r.out, /^RESULT fail \(\d+ errors\)$/m);
});

// ---- seed-file

test('seed-file --out writes the object form, marks the notes, prints the summary (path with a space)', () => {
  const dir = tempDir('seed');
  const out = join(dir, 'seed items.json');
  const r = testRun(readOnly, ['seed-file', '--out', out]);
  assert.equal(r.code, 0, r.all);
  const seed = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(seed), ['lanes', 'edges']);
  assert.equal(seed.lanes.length, 7);
  assert.equal(seed.edges.length, 7);
  assert.ok(seed.lanes.every((i) => i.note.startsWith('TEST MODE seed; ') && i.track === 'review-engine' && i.state === 'blocked' && !('band' in i)));
  assert.match(r.out, /^seed-file: 7 lanes, 7 edges -> .*seed items\.json \(map file .*\); dropped, close by hand: fx-gone$/m);
  assert.match(r.first, /^TEST MODE: self-check skipped/);
});

test('seed-file without --out: stdout is only the object, the banner goes to stderr, and the real parser validated it (no note)', () => {
  const r = testRun(readOnly, ['seed-file', '--project', 'other-board']);
  assert.equal(r.code, 0, r.all);
  const seed = JSON.parse(r.out);
  assert.ok(Array.isArray(seed.lanes) && seed.lanes.length === 7 && Array.isArray(seed.edges));
  assert.ok(seed.lanes.every((i) => i.project === 'other-board'));
  assert.match(r.err, /TEST MODE: self-check skipped/);
  assert.doesNotMatch(r.all, /not validated/);
});

test('S6 a lint-error map: seed-file exits 1 and writes no file', () => {
  const dir = tempDir('s6');
  const bad = join(dir, 'bad.md');
  const out = join(dir, 'never.json');
  writeFileSync(bad, FIXTURE_TEXT.replace('fx-base, fx-ext |', 'fx-base, fx-nope |'));
  const r = run(readOnly, ['seed-file', '--test-mode', '--map', bad, '--repo', readOnly, '--out', out]);
  assert.equal(r.code, 1);
  assert.equal(existsSync(out), false);
  assert.match(r.all, /FAIL dep-unknown/);
});

test('S10 seed-file --edges-out is gone: exit 2 (the object form carries the edges)', () => {
  const r = run(readOnly, ['seed-file', '--edges-out', join(tempDir('s10'), 'edges.json'), '--test-mode', '--map', FIXTURE]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown flag '--edges-out'/);
});

// ---- the database verbs: refusals that must come before any database connection (A2)
// Every run here pins the three URL variables to a closed port, so a refusal that is missing would show as a connection error.

const DEAD = 'postgresql://u:secretpw@127.0.0.1:1/lanes_pr1_ab12cd34';
const DEAD_ENV = { CONTINUOUS_CLAUDE_DB_URL: DEAD, DATABASE_URL: DEAD, OPC_POSTGRES_URL: DEAD };
const R9 = join(HERE, 'fixtures', 'r9-map.fixture.md');
// The program of this checkout, run in place (test mode only).
const runReal = (args, env = {}) => {
  const r = spawnSync(process.execPath, [join(HERE, 'program.mjs'), ...args], { cwd: HERE, encoding: 'utf8', env: { ...cleanEnv(), ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}
${r.stderr}` };
};
const DB_VERBS = [['ready', '--as', 'sess-1'], ['status'], ['sync-board'], ['check', '--board'], ['check', '--claims'], ['check', '--orphans']];

test('C9 each database verb in live mode with a changed program file: exit 3 before any database work', () => {
  // Runs database verbs in live mode on purpose: the self-check refuses before any connection, and the env points at a closed port.
  const repo = makeRepo('c9');
  appendFileSync(join(repo, 'scripts/review-engine/program.mjs'), '\n// edited\n');
  for (const args of DB_VERBS) {
    const r = run(repo, args, DEAD_ENV);
    assert.equal(r.code, 3, `${args.join(' ')}: ${r.all}`);
    assert.match(r.err, /not the one on main/);
    assert.doesNotMatch(r.all, /secretpw/);
  }
});

test('C9b ready in live mode from a linked worktree: exit 3 by the self-check, no connection', () => {
  // Runs a database verb in live mode on purpose: the self-check refuses before any connection, and the env points at a closed port.
  const repo = makeRepo('c9b');
  const wt = `${repo}-wt`;
  dirs.push(wt);
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-ready');
  const r = run(wt, ['ready', '--as', 'sess-1'], DEAD_ENV);
  assert.equal(r.code, 3, r.all);
  assert.match(r.err, /linked worktree/);
});

test('C9c test mode with no database URL: every database verb exits 3 and names the variable', () => {
  for (const args of DB_VERBS) {
    const r = run(readOnly, [...args, '--test-mode', '--map', R9, '--repo', readOnly]);
    assert.equal(r.code, 3, `${args.join(' ')}: ${r.all}`);
    assert.match(r.err, /CONTINUOUS_CLAUDE_DB_URL/);
  }
});

test('C9d test mode with a live URL or a lanes_x name: exit 3, and no password in the text', () => {
  for (const url of [LIVE_URL, 'postgresql://u:secretpw@localhost:5432/lanes_x']) {
    for (const args of DB_VERBS) {
      // The real program, run in place (test mode only): no temp repo is needed to reach dbTarget.
      const r = runReal([...args, '--test-mode', '--map', R9, '--repo', readOnly], { CONTINUOUS_CLAUDE_DB_URL: url });
      assert.equal(r.code, 3, `${args.join(' ')} ${url}: ${r.all}`);
      assert.doesNotMatch(r.all, /claude_dev|secretpw/);
    }
  }
});

test('C9e --decisions and --lane-cli without --test-mode: exit 3 for the verbs that read them', () => {
  // Runs database verbs in live mode on purpose: the flag guard refuses before any connection, and the env points at a closed port.
  for (const args of [['status', '--decisions', R9], ['sync-board', '--apply', '--as', 's', '--lane-cli', R9], ['ready', '--as', 's', '--lane-cli', R9]]) {
    const r = run(readOnly, args, DEAD_ENV);
    assert.equal(r.code, 3, `${args.join(' ')}: ${r.all}`);
    assert.match(r.err, /needs --test-mode/);
  }
});

test('C9f no session id: sync-board --apply and ready exit 2, before any database work', () => {
  const base = ['--test-mode', '--map', R9, '--repo', readOnly];
  const apply = run(readOnly, ['sync-board', '--apply', ...base], DEAD_ENV);
  assert.equal(apply.code, 2, apply.all);
  assert.match(apply.err, /--as|CLAUDE_CODE_SESSION_ID/);
  const ready = run(readOnly, ['ready', ...base], DEAD_ENV);
  assert.equal(ready.code, 2, ready.all);
  assert.match(ready.err, /ready needs CLAUDE_CODE_SESSION_ID or --as <session>/);
});

test('C9g ready on a map with no Cursor eval slot bullet: exit 1 "map fact missing", before any database work', () => {
  const r = run(readOnly, ['ready', '--as', 's', '--test-mode', '--map', FIXTURE, '--repo', readOnly], DEAD_ENV);
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /map fact missing: Cursor eval slot bullet/);
});

test('C9h --project must be a board key; a bad one is a usage error', () => {
  const r = run(readOnly, ['status', '--project', 'Bad Key', '--test-mode', '--map', R9], DEAD_ENV);
  assert.equal(r.code, 2, r.all);
});

test('R9 the dummy map passes check --table and has the program facts', () => {
  const r = run(readOnly, ['check', '--table', '--test-mode', '--map', R9, '--repo', readOnly]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^check --table: 6 lanes, 1 external, 0 dropped, 3 edges, 1 held$/m);
  assert.match(r.out, /packs 1/);
});

// ---- check --diff

const TOOL_BODY = Array.from({ length: 12 }, (_, i) => `export const line${i} = ${i};`).join('\n');

function branchWith(repo, name, files) {
  git(repo, 'checkout', '-q', '-b', name);
  for (const [rel, text] of Object.entries(files)) put(repo, rel, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', name);
  git(repo, 'checkout', '-q', 'main');
}

const diffRun = (repo, lane, extra = []) => testRun(repo, ['check', '--diff', lane, ...extra]);

test('C10 check --diff, every file inside Owns: exit 0 and diff-clean', () => {
  const repo = makeRepo('c10');
  branchWith(repo, 're/fx-base', { 'fixture/tool.mjs': TOOL_BODY, 'fixture/tool.test.mjs': 'x\n' });
  const r = diffRun(repo, 'fx-base');
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^RESULT diff-clean$/m);
});

test('C11 check --diff, a file outside Owns: exit 1 and the file is named', () => {
  const repo = makeRepo('c11');
  branchWith(repo, 're/fx-base', { 'fixture/tool.mjs': TOOL_BODY, 'src/other.mjs': 'x\n' });
  const r = diffRun(repo, 'fx-base');
  assert.equal(r.code, 1);
  assert.match(r.out, /^OUTSIDE src\/other\.mjs$/m);
  assert.match(r.out, /^RESULT diff-outside-owns 1$/m);
  assert.doesNotMatch(r.out, /OUTSIDE fixture\/tool\.mjs/);
});

test('C12 a file moved from outside Owns into Owns still flags the old path', () => {
  const repo = makeRepo('c12', { 'other/x.mjs': TOOL_BODY });
  git(repo, 'checkout', '-q', '-b', 're/fx-base');
  mkdirSync(join(repo, 'fixture'), { recursive: true });
  git(repo, 'mv', 'other/x.mjs', 'fixture/tool.mjs');
  git(repo, 'commit', '-q', '-m', 'move');
  git(repo, 'checkout', '-q', 'main');
  const r = diffRun(repo, 'fx-base');
  assert.equal(r.code, 1, r.all);
  assert.match(r.out, /^OUTSIDE other\/x\.mjs$/m);
});

test('C13 a glob entry matches a nested file and not a sibling prefix', () => {
  const repo = makeRepo('c13');
  branchWith(repo, 're/fx-top', { 'fixture/out/a/b/c.json': '{}\n' });
  assert.equal(diffRun(repo, 'fx-top').code, 0);
  branchWith(repo, 're/fx-top-b', { 'fixture/outer.txt': 'x\n' });
  const r = diffRun(repo, 'fx-top', ['--branch', 're/fx-top-b']);
  assert.equal(r.code, 1);
  assert.match(r.out, /^OUTSIDE fixture\/outer\.txt$/m);
});

test('C13b a lane with Owns: none has every file outside', () => {
  const repo = makeRepo('c13b');
  branchWith(repo, 're/fx-holder', { 'fixture/a.mjs': 'x\n' });
  const r = diffRun(repo, 'fx-holder');
  assert.equal(r.code, 1);
  assert.match(r.out, /^OUTSIDE fixture\/a\.mjs$/m);
});

test('C14 an unknown lane gives exit 2, and so does a missing branch', () => {
  const repo = makeRepo('c14');
  const unknown = diffRun(repo, 'fx-nope');
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /fx-nope/);
  const missing = diffRun(repo, 'fx-base');
  assert.equal(missing.code, 2);
  assert.match(missing.err, /branch 're\/fx-base' not found; pass --branch/);
});

// ---- usage

test('C15 an unknown verb or flag gives exit 2 with usage; a flag for another verb does too', () => {
  for (const args of [['frob'], ['check', '--nope'], ['check', '--table', '--out', 'x'], ['check', '--diff'], ['check', '--table', '--board'], ['check', '--branch', 'x'], []]) {
    const r = run(readOnly, args);
    assert.equal(r.code, 2, `args: ${args.join(' ')}\n${r.all}`);
    assert.match(r.err, /usage/i);
  }
});

// ---- dbTarget seam

test('C16 dbTarget: test mode accepts only a scratch database from CONTINUOUS_CLAUDE_DB_URL', async () => {
  // The real name rule: prefix lanes_pr1_ and ^lanes_pr1_[a-z0-9_]+$ (scripts/coordination/scratch-db.mjs). Each case breaks one half.
  const named = (name) => ({ CONTINUOUS_CLAUDE_DB_URL: `postgresql://u:p@localhost:5432/${name}` });
  const refused = async (env) => assert.rejects(dbTarget({ testMode: true, env }), (e) => {
    assert.equal(e.exitCode, 3);
    assert.doesNotMatch(e.message, /claude_dev/);
    return true;
  });
  await refused({});
  await refused({ CONTINUOUS_CLAUDE_DB_URL: LIVE_URL });
  await refused({ DATABASE_URL: SCRATCH_URL });
  await refused(named('lanes_x'));
  await refused(named('lanes_pr1_'));
  await refused(named('lanes_pr1_AB'));
  assert.equal(await dbTarget({ testMode: true, env: { CONTINUOUS_CLAUDE_DB_URL: SCRATCH_URL } }), SCRATCH_URL);
});

test('C16b dbTarget in live mode follows the lane.mjs chain', async () => {
  assert.equal(await dbTarget({ testMode: false, env: { CONTINUOUS_CLAUDE_DB_URL: 'postgresql://a/b', DATABASE_URL: 'postgresql://c/d' } }), 'postgresql://a/b');
  assert.equal(await dbTarget({ testMode: false, env: { DATABASE_URL: 'postgresql://c/d' } }), 'postgresql://c/d');
});

// ---- C1 (review fixes): the --diff output, seed failures, flag forms

const sha12 = (repo, ref) => git(repo, 'rev-parse', ref).slice(0, 12);

test('C6 check --diff prints the file count and both SHAs on the line after the banner', () => {
  const repo = makeRepo('c6a');
  branchWith(repo, 're/fx-base', { 'fixture/tool.mjs': TOOL_BODY, 'fixture/tool.test.mjs': 'x\n' });
  const r = diffRun(repo, 'fx-base');
  assert.equal(r.code, 0, r.all);
  assert.equal(r.out.split(/\r?\n/)[1], `files: 2 base ${sha12(repo, 'main')} branch ${sha12(repo, 're/fx-base')}`);
});

test('C6b an empty diff is not a pass: exit 1 and RESULT diff-empty (--branch main, and a branch at the base)', () => {
  const repo = makeRepo('c6b');
  git(repo, 'branch', 're/fx-base');
  for (const extra of [[], ['--branch', 'main']]) {
    const r = diffRun(repo, 'fx-base', extra);
    assert.equal(r.code, 1, r.all);
    assert.match(r.out, /^files: 0 base [0-9a-f]{12} branch [0-9a-f]{12}$/m);
    assert.match(r.out, /^RESULT diff-empty$/m);
    assert.doesNotMatch(r.out, /diff-clean/);
  }
  const json = JSON.parse(diffRun(repo, 'fx-base', ['--json']).out);
  assert.equal(json.ok, false);
  assert.equal(json.result, 'diff-empty');
  assert.deepEqual(json.files, []);
});

test('C12 git diff gets the resolved SHAs and "--": a path named like the range is not ambiguous', () => {
  const repo = makeRepo('c12b');
  branchWith(repo, 're/fx-base', { 'fixture/tool.mjs': TOOL_BODY });
  const base = git(repo, 'rev-parse', 'main');
  const tip = git(repo, 'rev-parse', 're/fx-base');
  // Paths that git would read as the revision range itself (branch name form, then SHA form).
  put(repo, `${base}...re/fx-base`, 'x\n');
  put(repo, `${base}...${tip}/x.txt`, 'x\n');
  const r = diffRun(repo, 'fx-base');
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^RESULT diff-clean$/m);
});

test('T4 check --diff --json: ok, both names, both SHAs, the files and the outside list', () => {
  const repo = makeRepo('t4d');
  branchWith(repo, 're/fx-base', { 'fixture/tool.mjs': TOOL_BODY, 'src/other.mjs': 'x\n' });
  const r = diffRun(repo, 'fx-base', ['--json']);
  assert.equal(r.code, 1, r.all);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, false);
  assert.equal(j.verb, 'check --diff');
  assert.equal(j.testMode, true);
  assert.deepEqual([j.lane, j.branch, j.base], ['fx-base', 're/fx-base', 'main']);
  assert.equal(j.baseSha, git(repo, 'rev-parse', 'main'));
  assert.equal(j.branchSha, git(repo, 'rev-parse', 're/fx-base'));
  assert.deepEqual(j.files, ['fixture/tool.mjs', 'src/other.mjs']);
  assert.deepEqual(j.outside, ['src/other.mjs']);
  assert.equal(j.result, 'diff-outside-owns');
});

test('T4 a missing --base ref gives exit 2 and names the flag', () => {
  const repo = makeRepo('t4b');
  git(repo, 'branch', 're/fx-base');
  const r = diffRun(repo, 'fx-base', ['--base', 'no-such-ref']);
  assert.equal(r.code, 2);
  assert.match(r.err, /base 'no-such-ref' not found; pass --base/);
});

test('T4 the --flag=value form works for --map, --repo, --out and --project', () => {
  const dir = tempDir('t4eq');
  const out = join(dir, 'eq.json');
  const table = run(readOnly, ['check', '--table', '--test-mode', `--map=${FIXTURE}`, `--repo=${readOnly}`]);
  assert.equal(table.code, 0, table.all);
  const seed = run(readOnly, ['seed-file', '--test-mode', `--map=${FIXTURE}`, `--out=${out}`, '--project=eq-board']);
  assert.equal(seed.code, 0, seed.all);
  assert.ok(JSON.parse(readFileSync(out, 'utf8')).lanes.every((i) => i.project === 'eq-board'));
});

test('T4 seed-file --out --json: ok, the written path, counts and the dropped ids', () => {
  const out = join(tempDir('t4s'), 'seed.json');
  const r = testRun(readOnly, ['seed-file', '--out', out, '--json']);
  assert.equal(r.code, 0, r.all);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.equal(j.verb, 'seed-file');
  assert.equal(j.testMode, true);
  assert.equal(j.out, out);
  assert.equal(j.items, 7);
  assert.equal(j.edges, 7);
  assert.deepEqual(j.dropped, ['fx-gone']);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).lanes.length, 7);
});

const BAD_MAP = FIXTURE_TEXT.replace('fx-base, fx-ext |', 'fx-base, fx-nope |');

function badMapFile(label) {
  const bad = join(tempDir(label), 'bad.md');
  writeFileSync(bad, BAD_MAP);
  return bad;
}

test('T4 seed-file lint failure without --out: stdout stays empty, the report is on stderr, exit 1', () => {
  const r = run(readOnly, ['seed-file', '--test-mode', '--map', badMapFile('t4f'), '--repo', readOnly]);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /^FAIL dep-unknown .*fx-nope/m);
  assert.match(r.err, /^RESULT fail \(\d+ errors\)$/m);
});

test('C13 seed-file lint failure with --json: a JSON report with ok false and the errors', () => {
  const bad = badMapFile('c13a');
  const out = join(dirname(bad), 'never.json');
  const r = run(readOnly, ['seed-file', '--test-mode', '--map', bad, '--repo', readOnly, '--out', out, '--json']);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, false);
  assert.equal(j.verb, 'seed-file');
  assert.ok(j.errors.some((e) => e.rule === 'dep-unknown'));
  assert.equal(existsSync(out), false);
  assert.equal(j.staleOut, false);
});

test('C13 a lint failure leaves an old --out file unchanged and says it is stale', () => {
  const bad = badMapFile('c13b');
  const out = join(dirname(bad), 'old.json');
  writeFileSync(out, 'OLD\n');
  const args = ['seed-file', '--test-mode', '--map', bad, '--repo', readOnly, '--out', out];
  const text = run(readOnly, args);
  assert.equal(text.code, 1);
  assert.match(text.out, /^FAIL seed-file: .*old\.json.* left unchanged.* stale/m);
  assert.equal(readFileSync(out, 'utf8'), 'OLD\n');
  assert.equal(JSON.parse(run(readOnly, [...args, '--json']).out).staleOut, true);
  const fresh = run(readOnly, ['seed-file', '--test-mode', '--map', bad, '--repo', readOnly, '--out', join(dirname(bad), 'none.json')]);
  assert.doesNotMatch(fresh.out, /stale/);
});

// ---- seed-file: rank, pack branch, and the parser seam (A3)

// Live mode: lane-seed-file.mjs is in EXTRA, so a missing copy is refused by the self-check (exit 3) before the seam can say exit 5.
// The seam's own exit 5 for a missing module (live mode) is pinned in contract-seam.test.mjs C5.
test('S13 seed-file in live mode with lane-seed-file.mjs missing locally: exit 3 names the file, nothing written', () => {
  const repo = makeRepo('s13');
  rmSync(join(repo, 'scripts/coordination/lane-seed-file.mjs'));
  const out = join(tempDir('s13o'), 'never.json');
  const r = run(repo, ['seed-file', '--out', out]);
  assert.equal(r.code, 3, r.all);
  assert.match(r.err, /scripts\/coordination\/lane-seed-file\.mjs is missing locally/);
  assert.equal(existsSync(out), false);
});

test('S13b seed-file in test mode with the seam pointed at a missing module: a note, and the file is written', async () => {
  const out = join(tempDir('s13b'), 'seed.json');
  const seedUrl = pathToFileURL(join(tempDir('s13bm'), 'no-such-module.mjs')).href;
  const r = await main(['seed-file', '--out', out, '--test-mode', '--map', FIXTURE, '--repo', readOnly], HERE, { seedUrl });
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.match(r.out.join('\n'), /^NOTE seed-file: not validated \(scripts\/coordination\/lane-seed-file\.mjs is not on this branch yet\)$/m);
  assert.equal(existsSync(out), true);
});

test('S13d live mode ignores the seam override: io.seedUrl cannot point the validation at another module', async () => {
  const repo = makeRepo('s13d');
  const out = join(tempDir('s13do'), 'seed.json');
  const seedUrl = pathToFileURL(join(tempDir('s13dm'), 'no-such-module.mjs')).href;
  const r = await main(['seed-file', '--out', out], join(repo, 'scripts', 'review-engine'), { seedUrl });
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.doesNotMatch(r.out.join('\n'), /not validated/);
  assert.equal(existsSync(out), true);
});

test('S13c seed-file validates with the real parser in test mode and in live mode: exit 0, the file is written, no note', () => {
  for (const [label, args] of [['test', (o) => ['seed-file', '--out', o, '--test-mode', '--map', FIXTURE, '--repo', readOnly]], ['live', (o) => ['seed-file', '--out', o]]]) {
    const out = join(tempDir(`s13c-${label}`), 'seed.json');
    const r = run(readOnly, args(out));
    assert.equal(r.code, 0, `${label}: ${r.all}`);
    assert.doesNotMatch(r.all, /not validated/);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).lanes.length, 7);
  }
});

test('F7 a file of the EXTRA list edited in the repo: exit 3 in live mode, and the file is named', () => {
  assert.equal(EXTRA.length, 6, 'not vacuous');
  for (const rel of EXTRA) {
    const repo = makeRepo('f7');
    appendFileSync(join(repo, rel), '\n// edited\n');
    const r = run(repo, ['check', '--table']);
    assert.equal(r.code, 3, `${rel}: ${r.all}`);
    assert.ok(r.err.includes(`${rel} differs from main`), `${rel}: ${r.err}`);
  }
});

function seedWithRank(rank) {
  const dir = tempDir('rank');
  const file = join(dir, 'rank.json');
  writeFileSync(file, JSON.stringify(rank));
  return { dir, out: join(dir, 'seed.json'), file };
}

test('S4d seed-file --rank: priority only for ranked Waves lanes, a note for an external, no band', () => {
  const { out, file } = seedWithRank({ 'fx-base': 5, 'fx-ext': 7 });
  const r = testRun(readOnly, ['seed-file', '--out', out, '--rank', file]);
  assert.equal(r.code, 0, r.all);
  const lanes = JSON.parse(readFileSync(out, 'utf8')).lanes;
  assert.deepEqual(lanes.filter((l) => 'priority' in l).map((l) => [l.id, l.priority]), [['fx-base', 5]]);
  assert.ok(lanes.every((l) => !('band' in l)));
  assert.match(r.out, /^NOTE rank 7 for fx-ext is not written: externals are not seed items$/m);
  assert.match(r.out, /ranked 1/);
});

test('S4e seed-file --rank with an unknown lane or an unreadable file: exit 2, nothing written', () => {
  const bad = seedWithRank({ 'fx-nope': 5 });
  const r = testRun(readOnly, ['seed-file', '--out', bad.out, '--rank', bad.file]);
  assert.equal(r.code, 2, r.all);
  assert.match(r.err, /fx-nope/);
  assert.equal(existsSync(bad.out), false);
  const missing = testRun(readOnly, ['seed-file', '--rank', join(bad.dir, 'none.json')]);
  assert.equal(missing.code, 2, missing.all);
});

test('S11 seed-file on a map with a Pack line: both pack lanes get the pack branch', () => {
  const out = join(tempDir('s11'), 'seed.json');
  const r = run(readOnly, ['seed-file', '--test-mode', '--map', R9, '--repo', readOnly, '--out', out]);
  assert.equal(r.code, 0, r.all);
  const seed = JSON.parse(readFileSync(out, 'utf8'));
  const branch = (id) => seed.lanes.find((l) => l.id === id).branch;
  assert.deepEqual(['re-dummy-2', 're-dummy-3', 're-dummy-1'].map(branch), ['re/re-dummy-2', 're/re-dummy-2', 're/re-dummy-1']);
  assert.equal(seed.lanes.length, 6);
  assert.equal(seed.edges.length, 3);
});

// ---- check --diff with a pack (D1, D2)

const R9_DIFF = (repo, lane, extra = []) => run(repo, ['check', '--diff', lane, '--test-mode', '--map', R9, '--repo', repo, ...extra]);

test('D1 check --diff on a pack: the union of the Owns lists is clean, and a pack note names the lanes', () => {
  const repo = makeRepo('d1');
  branchWith(repo, 're/re-dummy-2', { 'dummy/two.mjs': 'x\n', 'dummy/three.mjs': 'y\n' });
  const r = R9_DIFF(repo, 're-dummy-2');
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^NOTE pack: re-dummy-2, re-dummy-3 \(union of Owns\)$/m);
  assert.match(r.out, /^RESULT diff-clean$/m);
  branchWith(repo, 're/re-other', { 'dummy/two.mjs': 'x\n', 'dummy/elsewhere.mjs': 'z\n' });
  const out = R9_DIFF(repo, 're-dummy-2', ['--branch', 're/re-other']);
  assert.equal(out.code, 1, out.all);
  assert.match(out.out, /^OUTSIDE dummy\/elsewhere\.mjs$/m);
});

test('D2 check --diff for the second pack lane takes the pack branch by default; --json lists the lanes', () => {
  const repo = makeRepo('d2');
  branchWith(repo, 're/re-dummy-2', { 'dummy/three.mjs': 'y\n' });
  const r = R9_DIFF(repo, 're-dummy-3', ['--json']);
  assert.equal(r.code, 0, r.all);
  const j = JSON.parse(r.out);
  assert.equal(j.branch, 're/re-dummy-2');
  assert.deepEqual(j.lanes, ['re-dummy-2', 're-dummy-3']);
  const single = R9_DIFF(repo, 're-dummy-1');
  assert.equal(single.code, 2, 'a lane with no pack still defaults to re/<id>');
  assert.match(single.err, /branch 're\/re-dummy-1' not found/);
});

// ---- the database verbs in process, with an injected reader (fake io) and a fake lane CLI (Z6-Z10)
// main(argv, scriptDir, io): io = { env, open(url) -> reader, fresh(url) -> { lanes(board, ids) -> Map, end() } }. No database runs here.


const R9_IDS = ['re-dummy-1', 're-dummy-2', 're-dummy-3', 're-dummy-4', 're-dummy-5', 're-dummy-6', 'ext-dummy'];
const R9_EDGES = ['re-dummy-2', 're-dummy-3', 're-dummy-6'].map((id) => edge(id, 're-dummy-1'));
const OPEN_DEP = new Set(['re-dummy-2', 're-dummy-3', 're-dummy-6']);
const r9Rows = (over = {}) => R9_IDS.map((id) => row(id, { open_dep: OPEN_DEP.has(id), ...(over[id] ?? {}) }));

function fakeLaneCli({ failOn = null } = {}) {
  const dir = tempDir('fakecli');
  const file = join(dir, 'fake-lane.mjs');
  const log = join(dir, 'calls.jsonl');
  writeFileSync(file, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), session: process.env.CLAUDE_CODE_SESSION_ID, urls: [process.env.CONTINUOUS_CLAUDE_DB_URL, process.env.DATABASE_URL, process.env.OPC_POSTGRES_URL] }) + '\\n');
if (process.argv[3] === ${JSON.stringify(failOn)}) { process.stderr.write('boom postgresql://u:pw@h/db\\n'); process.exit(1); }
`);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { file, calls };
}

// fresh.lanes answers from the rows, except a lane the fake CLI was asked to move (it is backlog then) and the overrides.
function fakeIo(data = {}, cli = null) {
  const opened = [];
  const eventCalls = [];
  let ended = 0;
  const stateOf =(id, over) => {
    if (over[id]) return over[id];
    const moved = (cli?.calls() ?? []).some((c) => c.argv[1] === id && c.argv[2] === 'backlog');
    return { state: moved ? 'backlog' : 'blocked', owner: null };
  };
  return {
    opened,
    eventCalls,
    get ended() { return ended; },
    env: { CONTINUOUS_CLAUDE_DB_URL: SCRATCH_URL, ...(data.env ?? {}) },
    async open(url) {
      opened.push(url);
      return {
        hasLaneDep: async () => data.laneDep ?? true,
        board: async () => data.rows ?? r9Rows(),
        foreign: async () => data.foreign ?? [],
        edges: async () => data.edges ?? R9_EDGES,
        programSeed: async () => ('seed' in data ? data.seed : 100),
        events: async (board, ids) => { eventCalls.push({ board, ids }); return data.events ?? []; },
        end: async () => { ended += 1; },
      };
    },
    async fresh() {
      return { lanes: async (board, ids) => new Map(ids.map((id) => [id, stateOf(id, data.fresh ?? {})])), end: async () => {} };
    },
  };
}

const inProc = (args, io, extra = []) => main([...args, '--test-mode', '--map', R9, '--repo', readOnly, ...extra], HERE, io);

test('Z6 sync-board dry run (HOLD): moves only the open-dependency lanes and never calls the lane CLI', async () => {
  const cli = fakeLaneCli();
  const r = await inProc(['sync-board'], fakeIo({}, cli), ['--lane-cli', cli.file]);
  assert.equal(r.code, 0, r.err.join('\n'));
  const out = r.out.join('\n');
  assert.match(out, /^MOVE re-dummy-2 blocked -> backlog \(open-dependency\)$/m);
  assert.match(out, /^MOVE re-dummy-3 blocked -> backlog \(open-dependency\)$/m);
  assert.match(out, /^STAY re-dummy-1 waits for GO$/m);
  assert.match(out, /^STAY re-dummy-6 held seat-hold$/m);
  assert.match(out, /^STAY ext-dummy waits for GO$/m);
  assert.match(out, /^RESULT dry-run 2 moves$/m);
  assert.equal(cli.calls().length, 0);
});

test('Z6b sync-board --apply: one child per move in id order, argv exact, session and the scratch URL in all three variables', async () => {
  const cli = fakeLaneCli();
  const io = fakeIo({}, cli);
  const r = await inProc(['sync-board', '--apply', '--as', 'sess-1'], io, ['--lane-cli', cli.file]);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.match(r.out.join('\n'), /^RESULT applied 2 moves, 0 skipped$/m);
  const calls = cli.calls();
  assert.deepEqual(calls.map((c) => c.argv), [
    ['state', 're-dummy-2', 'backlog', '--if-state', 'blocked', '--reason', 'program.mjs sync-board --apply', '--project', 'continuous-claude'],
    ['state', 're-dummy-3', 'backlog', '--if-state', 'blocked', '--reason', 'program.mjs sync-board --apply', '--project', 'continuous-claude'],
  ]);
  assert.ok(calls.every((c) => c.session === 'sess-1' && c.urls.every((u) => u === SCRATCH_URL)));
  assert.ok(calls.every((c) => !c.argv.includes('--note')), 'Z9: state --note would replace the stored note');
});

test('Z6c sync-board --apply takes the board from --project and the session from the environment', async () => {
  const cli = fakeLaneCli();
  const io = fakeIo({}, cli);
  io.env.CLAUDE_CODE_SESSION_ID = 'env-sess';
  const r = await inProc(['sync-board', '--apply', '--project', 'zz-board'], io, ['--lane-cli', cli.file]);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.deepEqual(cli.calls().map((c) => [c.argv[c.argv.indexOf('--project') + 1], c.session]), [['zz-board', 'env-sess'], ['zz-board', 'env-sess']]);
});

test('Z7 a failing child: exit 1, the FAIL line names the lane with the URL masked, later moves do not run', async () => {
  const cli = fakeLaneCli({ failOn: 're-dummy-2' });
  const r = await inProc(['sync-board', '--apply', '--as', 'sess-1'], fakeIo({}, cli), ['--lane-cli', cli.file]);
  assert.equal(r.code, 1);
  const all = [...r.out, ...r.err].join('\n');
  assert.match(all, /^FAIL re-dummy-2 lane\.mjs exit 1: boom postgresql:\/\/\*\*\*@h\/db$/m);
  assert.doesNotMatch(all, /pw@/);
  assert.equal(cli.calls().length, 1);
});

test('Z8 the lane changed since the plan: SKIP, the child is not called for it', async () => {
  const cli = fakeLaneCli();
  const fresh = { 're-dummy-3': { state: 'active', owner: 'someone' } };
  const r = await inProc(['sync-board', '--apply', '--as', 'sess-1'], fakeIo({ fresh }, cli), ['--lane-cli', cli.file]);
  assert.equal(r.code, 0, r.err.join('\n'));
  const out = r.out.join('\n');
  assert.match(out, /^SKIP re-dummy-3 changed since the plan$/m);
  assert.match(out, /^RESULT applied 1 moves, 1 skipped$/m);
  assert.deepEqual(cli.calls().map((c) => c.argv[1]), ['re-dummy-2']);
});

test('Z8b the read-back disagrees after a write: FAIL verify and exit 1', async () => {
  const cli = fakeLaneCli();
  const fresh = { 're-dummy-2': { state: 'blocked', owner: null } };
  const io = fakeIo({}, cli);
  const real = io.fresh;
  let reads = 0;
  io.fresh = async () => {
    const f = await real();
    return { ...f, lanes: async (board, ids) => (++reads <= 2 ? f.lanes(board, ids) : new Map(ids.map((id) => [id, fresh[id] ?? { state: 'backlog', owner: null }]))) };
  };
  const r = await inProc(['sync-board', '--apply', '--as', 'sess-1'], io, ['--lane-cli', cli.file]);
  assert.equal(r.code, 1);
  assert.match([...r.out, ...r.err].join('\n'), /^FAIL verify re-dummy-2 state blocked$/m);
});

test('Z10 sync-board refuses before any write: no stored edges, or no program seed event (exit 3)', async () => {
  for (const [data, text] of [[{ edges: [] }, /no stored edges for the map lanes; run the seed first/], [{ seed: null }, /no program seed event on board continuous-claude; run the seed first/]]) {
    const cli = fakeLaneCli();
    const r = await inProc(['sync-board', '--apply', '--as', 'sess-1'], fakeIo(data, cli), ['--lane-cli', cli.file]);
    assert.equal(r.code, 3, r.err.join('\n'));
    assert.match(r.err.join('\n'), text);
    assert.equal(cli.calls().length, 0);
  }
});

test('Z3 a plan with an error (stored edges differ from the map) writes nothing, even with --apply', async () => {
  const cli = fakeLaneCli();
  const edges = [...R9_EDGES, edge('re-dummy-2', 're-dummy-4')];
  const r = await inProc(['sync-board', '--apply', '--as', 'sess-1'], fakeIo({ edges }, cli), ['--lane-cli', cli.file]);
  assert.equal(r.code, 1);
  assert.match(r.out.join('\n'), /^FAIL edges-differ re-dummy-2: stored \[re-dummy-1, re-dummy-4\], map \[re-dummy-1\]$/m);
  assert.equal(cli.calls().length, 0);
});

test('Z11 a database without migration 0006: exit 1 with the migration named, and the reader is closed', async () => {
  const io = fakeIo({ laneDep: false });
  const r = await inProc(['check', '--board'], io);
  assert.equal(r.code, 1);
  assert.equal(io.ended, 1, 'the snapshot reader is closed even when the verb refuses');
  assert.match(r.err.join('\n'), /migration 0006 \(lane_dep\) is not applied/);
});

test('H1 the reader gets the checked scratch URL, never a different one', async () => {
  const io = fakeIo();
  await inProc(['status'], io);
  assert.deepEqual(io.opened, [SCRATCH_URL]);
  assert.equal(io.ended, 1);
});

test('Y12 ready prints the claimable lanes and the cap line; --json has the pinned keys', async () => {
  const rows = r9Rows({ 're-dummy-1': { state: 'backlog' }, 're-dummy-4': { state: 'backlog' } });
  const text = await inProc(['ready', '--as', 'sess-1'], fakeIo({ rows }));
  assert.equal(text.code, 0, text.err.join('\n'));
  const out = text.out.join('\n');
  assert.match(out, /^ready: board continuous-claude, caller sess-1, mode worker, cap 0\/5 units, slot free$/m);
  assert.match(out, /^READY re-dummy-1 /m);
  assert.match(out, /^READY re-dummy-4 .*spends$/m);
  const j = JSON.parse((await inProc(['ready', '--as', 'sess-1', '--json'], fakeIo({ rows }))).out.join('\n'));
  assert.deepEqual(Object.keys(j).sort(), ['board', 'caller', 'cap', 'heldBack', 'mapSource', 'mode', 'notInMap', 'ok', 'ready', 'result', 'slot', 'testMode', 'verb', 'waitingOnDave', 'warnings'].sort());
  assert.equal(j.verb, 'ready');
  assert.deepEqual(j.ready.map((x) => x.id), ['re-dummy-1', 're-dummy-4']);
});

test('Y8 ready for a caller that holds a re- lane: exit 3 and the REFUSED line on stderr', async () => {
  const rows = r9Rows({ 're-dummy-1': { state: 'active', owner_session_id: 'sess-1' } });
  const r = await inProc(['ready', '--as', 'sess-1'], fakeIo({ rows }));
  assert.equal(r.code, 3);
  assert.match(r.err.join('\n'), /^REFUSED ready -- you hold re-dummy-1; one re- lane per session/m);
});

test('B1 check --board: a done lane with no merged SHA and the cards that are missing fail', async () => {
  const rows = [row('re-dummy-1', { state: 'done' })];
  const r = await inProc(['check', '--board'], fakeIo({ rows, edges: [] }));
  assert.equal(r.code, 1);
  const out = r.out.join('\n');
  assert.match(out, /^FAIL done-not-met re-dummy-1 /m);
  assert.match(out, /^FAIL no-card re-dummy-2 /m);
  assert.match(out, /^RESULT fail \(\d+ errors\)$/m);
});

test('K1 check --claims: a claim before the dependency merged fails; the floor is the program seed', async () => {
  const events = [ev(101, 're-dummy-2', 'claimed', { state: 'active' }, { session_id: 'sess-9' })];
  const r = await inProc(['check', '--claims'], fakeIo({ events, rows: r9Rows() }));
  assert.equal(r.code, 1, r.out.join('\n'));
  const out = r.out.join('\n');
  assert.match(out, /^floor: event 100 \(program seed\)$/m);
  assert.match(out, /^FAIL claim-open-dep re-dummy-2 event 101 waits on re-dummy-1$/m);
  const none = await inProc(['check', '--claims'], fakeIo({ seed: null, events: [] }));
  assert.match(none.out.join('\n'), /^NOTE no program seed event; judging all claims$/m);
  const since = await inProc(['check', '--claims'], fakeIo({ events }), ['--since', '101']);
  assert.equal(since.code, 0, since.out.join('\n'));
  assert.match(since.out.join('\n'), /^floor: event 101 \(--since\)$/m);
});

test('K1b check --claims asks the event reader for the events of the chosen board only (F4)', async () => {
  const io = fakeIo({});
  await inProc(['check', '--claims'], io, ['--project', 'other-board']);
  assert.equal(io.eventCalls.length, 1);
  assert.equal(io.eventCalls[0].board, 'other-board');
  assert.ok(io.eventCalls[0].ids.includes('re-dummy-1'));
  const dflt = fakeIo({});
  await inProc(['check', '--claims'], dflt);
  assert.equal(dflt.eventCalls[0].board, 'continuous-claude');
});

test('O1 check --orphans: a dead seat holder is an empty seat and exit 1; a live one is exit 0', async () => {
  const dead = [row('re-program', { state: 'active', owner_session_id: 'abcd1234-aaaa', reclaimable: true }), ...r9Rows()];
  const r = await inProc(['check', '--orphans'], fakeIo({ rows: dead }));
  assert.equal(r.code, 1);
  assert.match(r.out.join('\n'), /^seat: no live holder since /m);
  const live = [row('re-program', { state: 'active', owner_session_id: 'abcd1234-aaaa' }), ...r9Rows()];
  const ok = await inProc(['check', '--orphans'], fakeIo({ rows: live }));
  assert.equal(ok.code, 0, ok.out.join('\n'));
  assert.match(ok.out.join('\n'), /^seat: re-program held live by abcd1234$/m);
});

test('T1 status: always exit 0, the next decision point comes from --decisions, JSON has the B.8 keys', async () => {
  const file = join(tempDir('dec'), 'decisions.md');
  writeFileSync(file, '# D\n\n### DP1 (first)\n\n1. DECIDED yes\n\n### DP2 (second)\n\n1. open one\n2. NOT ASKED\n3. open two\n');
  const r = await inProc(['status', '--json'], fakeIo(), ['--decisions', file]);
  assert.equal(r.code, 0, r.err.join('\n'));
  const j = JSON.parse(r.out.join('\n'));
  assert.deepEqual(['ok', 'verb', 'testMode', 'mapSource', 'board', 'go', 'counts', 'waves', 'lanes', 'cap', 'slot', 'nextDecisionPoint'].filter((k) => !(k in j)), []);
  assert.deepEqual(j.nextDecisionPoint.open, ['DP2.1', 'DP2.3']);
  assert.equal(j.counts.lanes, 7);
  const text = await inProc(['status'], fakeIo());
  assert.match(text.out.join('\n'), /^status: board continuous-claude, 7 lanes, program state HOLD$/m);
});

test('U1 an error text from the driver never carries a database URL with its password', async () => {
  const io = fakeIo();
  io.open = async () => { throw new Error('cannot connect to postgresql://u:topsecret@h:5432/lanes_pr1_ab12cd34: refused'); };
  const r = await inProc(['status'], io);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err.join('\n'), /topsecret/);
  assert.match(r.err.join('\n'), /postgresql:\/\/\*\*\*@h:5432\/lanes_pr1_ab12cd34/);
});

// ---- a map that parses but has a lint error still gives a board answer (the real map has one today)

test('L1 status and check --board on a map with a lint error: they answer, and a NOTE names the lint count', async () => {
  const bad = join(tempDir('l1'), 'lint.md');
  writeFileSync(bad, readFileSync(R9, 'utf8').replace('| 1 | `re-dummy-3` | P3 | re-dummy-1 |', '| 1 | `re-dummy-3` | P3 | re-dummy-nope |'));
  assert.equal(run(readOnly, ['check', '--table', '--test-mode', '--map', bad, '--repo', readOnly]).code, 1, 'the map must have a lint error for this test');
  const argv = (verb) => [...verb, '--test-mode', '--map', bad, '--repo', readOnly];
  const status = await main(argv(['status']), HERE, fakeIo());
  assert.equal(status.code, 0, status.err.join('\n'));
  assert.match(status.out.join('\n'), /^NOTE the map has \d+ lint errors; run check --table$/m);
  const board = await main(argv(['check', '--board']), HERE, fakeIo({ rows: [] }));
  assert.equal(board.code, 1, 'no card exists: a board failure, not a refusal to run');
  assert.match(board.out.join('\n'), /^FAIL no-card re-dummy-1 /m);
});

test('L1b sync-board on a map with a lint error: the dry run answers with a NOTE, --apply refuses with exit 1 and opens no connection', async () => {
  const bad = join(tempDir('l1b'), 'lint.md');
  writeFileSync(bad, readFileSync(R9, 'utf8').replace('| 1 | `re-dummy-3` | P3 | re-dummy-1 |', '| 1 | `re-dummy-3` | P3 | re-dummy-nope |'));
  const argv = (extra) => ['sync-board', ...extra, '--test-mode', '--map', bad, '--repo', readOnly, '--as', 'zz-l1b'];
  let opened = 0;
  const io = fakeIo();
  const open = io.open;
  io.open = async (...a) => { opened += 1; return open(...a); };
  const applied = await main(argv(['--apply']), HERE, io);
  assert.equal(applied.code, 1, applied.out.join('\n'));
  assert.match(applied.err.join('\n'), /sync-board --apply: the map has \d+ lint errors; nothing written/);
  assert.equal(opened, 0, 'no database connection before the refusal');
});

test('L2 a map that does not parse (no Waves table) stops every board verb with exit 1 and no connection', async () => {
  const none = join(tempDir('l2'), 'none.md');
  writeFileSync(none, '# nothing here\n');
  const io = fakeIo();
  const r = await main(['status', '--test-mode', '--map', none, '--repo', readOnly], HERE, io);
  assert.equal(r.code, 1);
  assert.match(r.err.join('\n'), /the map does not parse/);
  assert.deepEqual(io.opened, []);
});

test('L3 status with an unreadable --decisions file: exit 2 and no connection', async () => {
  const io = fakeIo();
  const r = await inProc(['status'], io, ['--decisions', join(tempDir('l3'), 'nope.md')]);
  assert.equal(r.code, 2);
  assert.deepEqual(io.opened, []);
});

// ---- check --board reads the first-parent files of a landed SHA from git

test('B4 check --board: a merged SHA that touches the lane Owns passes, one that touches none fails sha-no-owns', async () => {
  const repo = makeRepo('b4');
  put(repo, 'dummy/one.mjs', 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'owns file');
  const inOwns = git(repo, 'rev-parse', 'HEAD');
  put(repo, 'other/x.mjs', 'y\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'other file');
  const outside = git(repo, 'rev-parse', 'HEAD');
  const done = (sha) => [row('re-dummy-1', { state: 'done', met: true, landed_sha: sha, last_life: life(9, 'done', { state: 'done', merged: sha }) })];
  const board = (sha) => main(['check', '--board', '--test-mode', '--map', R9, '--repo', repo], HERE, fakeIo({ rows: done(sha), edges: [] }));
  const good = (await board(inOwns)).out.join('\n');
  assert.doesNotMatch(good, /sha-no-owns|sha-unchecked/);
  const bad = (await board(outside)).out.join('\n');
  assert.match(bad, /^FAIL sha-no-owns re-dummy-1 /m);
  const unknown = (await board('ab'.repeat(20))).out.join('\n');
  assert.match(unknown, /^NOTE sha-unchecked re-dummy-1 /m, 'a SHA that git cannot read is a note, not an error');
});

// ---- seed-file with a parser present (S12, S12b)

const FAKE_SEED_FILE = (cycle) => `export function parseSeedFile(data) { return { lanes: data.lanes, edges: data.edges, dropped: 0 }; }
export function findCycle() { return ${cycle}; }
`;

test('S12 seed-file with a parser that finds a cycle: exit 1, the cycle is printed, no file is written', () => {
  const repo = makeRepo('s12', { 'scripts/coordination/lane-seed-file.mjs': FAKE_SEED_FILE("['fx-a', 'fx-b', 'fx-a']") });
  const out = join(tempDir('s12o'), 'never.json');
  const r = testRun(repo, ['seed-file', '--out', out]);
  assert.equal(r.code, 1, r.all);
  assert.match(r.out, /^FAIL seed-file: cycle fx-a -> fx-b -> fx-a$/m);
  assert.equal(existsSync(out), false);
});

test('S12b seed-file with a clean parser: exit 0, the file is written, and no "not validated" note', () => {
  const repo = makeRepo('s12b', { 'scripts/coordination/lane-seed-file.mjs': FAKE_SEED_FILE('null') });
  const out = join(tempDir('s12bo'), 'seed.json');
  const r = testRun(repo, ['seed-file', '--out', out]);
  assert.equal(r.code, 0, r.all);
  assert.doesNotMatch(r.all, /not validated/);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).lanes.length, 7);
});

test('T5 GIT_* variables of the parent do not reach git in the tests', () => {
  const repo = makeRepo('t5');
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(tempDir('t5gd'), 'no-such-git-dir');
  try {
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    const r = run(repo, ['check', '--table', '--test-mode', '--map-ref', 'main', '--repo', repo]);
    assert.equal(r.code, 0, r.all);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});
