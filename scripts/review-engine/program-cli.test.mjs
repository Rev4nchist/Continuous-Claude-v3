// End-to-end tests for scripts/review-engine/program.mjs. Each test runs the real CLI with spawnSync (argv array, no shell).
// Live-mode tests copy program.mjs and lib/ into a temp git repo, so the self-check compares real blob ids.
// The temp folder names hold a space, to cover Windows paths. Run: node --test scripts/review-engine/program-cli.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbTarget } from './lib/source.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'map.fixture.md');
const FIXTURE_TEXT = readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n');
const SCRATCH_URL = 'postgresql://u:p@localhost:5432/lanes_pr1_ab12cd34';
const LIVE_URL = 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';
const dirs = [];

const tempDir = (label) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `re cli ${label} `)));
  dirs.push(dir);
  return dir;
};
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

// The parent env minus every GIT_* variable, so a run inside a git hook cannot reach the real repo (T5).
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));

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
  const wt = `${repo} wt`;
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
  assert.match(r.out, /^examined: ownerChains 2, ownerPhrases 1, overlapPairs 4, deps 7, heldTokens 6, sections 8, rows 7, dropped 1, chainUnparsed 0$/m);
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

test('seed-file --out writes the array, marks the notes, prints the summary (path with a space)', () => {
  const dir = tempDir('seed');
  const out = join(dir, 'seed items.json');
  const r = testRun(readOnly, ['seed-file', '--out', out]);
  assert.equal(r.code, 0, r.all);
  const items = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(items.length, 7);
  assert.ok(items.every((i) => i.note.startsWith('TEST MODE seed; ')));
  assert.match(r.out, /^seed-file: 7 items -> .*seed items\.json \(map file .*\); dropped, close by hand: fx-gone; edges: 7 computed, not written \(part 2\)$/m);
  assert.match(r.first, /^TEST MODE: self-check skipped/);
});

test('seed-file without --out: stdout is only the array, the banner goes to stderr', () => {
  const r = testRun(readOnly, ['seed-file', '--project', 'other-board']);
  assert.equal(r.code, 0, r.all);
  const items = JSON.parse(r.out);
  assert.ok(Array.isArray(items) && items.length === 7);
  assert.ok(items.every((i) => i.project === 'other-board'));
  assert.match(r.err, /TEST MODE: self-check skipped/);
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

test('S10 seed-file --edges-out: exit 5, part 2', () => {
  const r = run(readOnly, ['seed-file', '--edges-out', join(tempDir('s10'), 'edges.json'), '--test-mode', '--map', FIXTURE]);
  assert.equal(r.code, 5);
  assert.match(r.err, /part 2/);
});

// ---- part 2 stubs

test('C9 each part 2 verb exits 5 and says part 2, even when the self-check would refuse', () => {
  const repo = makeRepo('c9');
  appendFileSync(join(repo, 'scripts/review-engine/program.mjs'), '\n// edited\n');
  const verbs = [['ready'], ['status'], ['sync-board'], ['sync-board', '--apply'], ['check', '--board'], ['check', '--claims'], ['check', '--orphans']];
  for (const args of verbs) {
    const r = run(repo, args);
    assert.equal(r.code, 5, args.join(' '));
    assert.match(r.err, /part 2/);
    assert.match(r.err, /Nothing was read or written/);
  }
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
  assert.ok(JSON.parse(readFileSync(out, 'utf8')).every((i) => i.project === 'eq-board'));
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
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).length, 7);
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
