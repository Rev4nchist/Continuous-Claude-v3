// Tests for pre-pr.mjs. Run: node --test scripts/github/pre-pr.test.mjs
//
// How each part can fail, and the test that catches it (written before the code):
//
// Surface table (data)
//   - a gate points at a script that does not exist (renamed, typo)           -> S1
//   - a changed path maps to no gate or the wrong gate                         -> S2..S6
//   - two files of one surface run its gate twice                              -> S7
//   - opc runs pytest on the whole suite, or on a file that was not touched    -> S5
//   - a path that no surface owns runs more than the always gate               -> S8
// summaryLine
//   - the first line is taken, not the runner's summary                        -> M1, M2
// Git preconditions
//   - main passes, a detached HEAD passes                                      -> G1, G2
//   - a dirty or untracked file passes                                         -> G3
//   - a branch behind the base passes, or the output hides that no fetch ran   -> G4
//   - a missing base ref is read as "0 behind"                                 -> G5
// Evidence
//   - a stale GREEN sha passes                                                 -> E2
//   - docs passes when one changed file is not docs, or when nothing changed   -> E4, E5
//   - an empty body passes                                                     -> E1
// CodeRabbit step
//   - a run with --use-credits or --api-key                                    -> C1
//   - a second run for the same head                                           -> C3
//   - a third run on the branch                                                -> C4
//   - a failed run does not use a slot                                         -> C5
//   - awaiting_confirmation or a timeout passes                                -> C6, C7
//   - --skip-cr still calls the runner                                         -> C2
// runPrePr (real git in a temp repo, fake gate runner, fake cr runner)
//   - a stamp is written on a failure, or lacks head/branch/body hash          -> R1, R2
//   - an old stamp survives a failed run                                       -> R2
//   - the CLI step runs after a failed gate (it costs a slot)                  -> R2
//   - the stamp or counter dirties the tree                                    -> R1
//   - no log file                                                              -> R1
//   - the CLI without --body does not exit non-zero                            -> R3
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SURFACES, ALWAYS_GATES, CR_ARGS, CR_RUN_LIMIT, STAMP_REL, gatesFor, summaryLine, checkGit, checkEvidence,
  runCodeRabbit, runPrePr, assertSafeCrArgs, changedFiles, makeGit, notesFor,
  parseAgentStream, parseUsage, crTimeoutMs, defaultCrRunner, CR_USAGE_ARGS,
  killTree, sharedPrDir, crPaths, finishedRuns, logCliMissing, crTimeoutProblem, runGate,
} from './pre-pr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CONFIG = JSON.parse(readFileSync(path.join(REPO_ROOT, 'review-router.config.json'), 'utf8'));

const HEAD = 'a'.repeat(40);

function fakeGit(map) {
  return (args) => {
    const hit = map[args.join(' ')];
    if (hit === undefined) return { status: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` };
    return typeof hit === 'string' ? { status: 0, stdout: hit, stderr: '' } : hit;
  };
}

const ids = (gates) => gates.map((g) => g.id);

// ---------- surface table ----------

test('S1: every node script and cwd named in the surface table exists', async () => {
  const all = [...ALWAYS_GATES, ...SURFACES.flatMap((s) => s.gates ?? [])];
  assert.ok(all.length >= 10, `only ${all.length} gates: the check would be vacuous`);
  for (const g of all) {
    const cwd = path.join(REPO_ROOT, g.cwd ?? '.');
    assert.ok(existsSync(cwd), `${g.id}: cwd ${g.cwd} is missing`);
    for (const a of g.args.filter((x) => /^scripts\/[^*]*\.(mjs|sh)$/.test(x))) {
      assert.ok(existsSync(path.join(cwd, a)), `${g.id}: ${a} is missing`);
    }
    if (g.args.some((x) => x.includes('*'))) {
      const dir = path.join(cwd, path.dirname(g.args.find((x) => x.includes('*'))));
      assert.ok(readdirSync(dir).some((n) => /\.test\.mjs$/.test(n)), `${g.id}: the glob matches no test file`);
    }
  }
});

test('S2: hooks source runs the build with a dist check, vitest and the always gate', async () => {
  const got = gatesFor(['.claude/hooks/src/pre-pr-gate.ts'], REPO_ROOT);
  assert.deepEqual(ids(got).sort(), ['context-budget', 'hooks-build', 'hooks-vitest']);
  const build = got.find((g) => g.id === 'hooks-build');
  assert.ok(build.postCheck.argv.every((a) => a.includes('.claude/hooks/dist')));
  assert.deepEqual(build.postCheck.argv.map((a) => a[0]), ['diff', 'ls-files'], 'content changes and new files; never git status');
});

test('S3: rules, skills, agents each run their own gates', async () => {
  assert.deepEqual(ids(gatesFor(['.claude/rules-ondemand/x.md'], REPO_ROOT)).sort(), ['context-budget', 'ondemand-index', 'rule-router-probe']);
  assert.deepEqual(ids(gatesFor(['.claude/rules-src/x.md'], REPO_ROOT)).sort(), ['context-budget', 'ondemand-index', 'rule-router-probe']);
  assert.deepEqual(ids(gatesFor(['.claude/skills/tdd/SKILL.md'], REPO_ROOT)).sort(), ['audit-skills', 'context-budget']);
  assert.deepEqual(ids(gatesFor(['.claude/agents/kraken.md'], REPO_ROOT)).sort(), ['agent-body', 'agent-model-drift', 'context-budget']);
});

test('S4: scripts/github runs node --test on its test files; the mod runs its validate gate', async () => {
  const gh = gatesFor(['scripts/github/pre-pr.mjs'], REPO_ROOT).find((g) => g.id === 'github-tests');
  assert.equal(gh.cmd, 'node');
  assert.deepEqual(gh.args, ['--test', 'scripts/github/*.test.mjs']);
  const mod = gatesFor(['.claude/plugins/ccv3-mods/hooks/pr-loop/model.ts'], REPO_ROOT);
  assert.ok(ids(mod).includes('mods-validate'));
  assert.ok(mod.find((g) => g.id === 'mods-validate').args.includes('scripts/mods/validate-mods.mjs'));
});

test('S5: opc runs pytest on the touched test files only, relative to opc', async () => {
  const got = gatesFor(['opc/tests/unit/test_a.py', 'opc/src/x.py', 'opc/tests/unit/test_b.py', 'opc/tests/conftest.py'], REPO_ROOT);
  const py = got.find((g) => g.id === 'opc-pytest');
  assert.equal(py.cmd, 'uv');
  assert.deepEqual(py.args, ['run', 'pytest', 'tests/unit/test_a.py', 'tests/unit/test_b.py']);
  assert.equal(py.cwd, 'opc');
  assert.equal(ids(gatesFor(['opc/src/x.py'], REPO_ROOT)).includes('opc-pytest'), false, 'no touched test file: no pytest run');
  // An opc source change with no test change says so: the gap is visible, not silent.
  const note = notesFor(['opc/src/x.py'], CONFIG).find((n) => n.step === 'manual:opc');
  assert.equal(note.status, 'NOTE');
  assert.match(note.detail, /no test file/);
  assert.equal(notesFor(['opc/src/x.py', 'opc/tests/unit/test_a.py'], CONFIG).some((n) => n.step === 'manual:opc'), false);
});

test('S6: the always gate runs for every change set', async () => {
  for (const p of ['README.md', 'docs/a.md', 'scripts/other.mjs']) {
    assert.ok(ids(gatesFor([p], REPO_ROOT)).includes('context-budget'), p);
  }
  const cb = ALWAYS_GATES.find((g) => g.id === 'context-budget');
  assert.deepEqual(cb.args.slice(-2), ['scripts/rules/context-budget-guard.mjs', '--repo'].slice(-2));
});

test('S7: many files of one surface give one gate, and two surfaces do not duplicate a shared gate', async () => {
  const got = gatesFor(['.claude/hooks/src/a.ts', '.claude/hooks/src/b.ts', '.claude/hooks/dist/a.mjs'], REPO_ROOT);
  assert.equal(ids(got).filter((i) => i === 'hooks-vitest').length, 1);
  const both = gatesFor(['.claude/rules-src/a.md', '.claude/rules-ondemand/b.md'], REPO_ROOT);
  assert.equal(ids(both).filter((i) => i === 'ondemand-index').length, 1);
});

test('S8: a path no surface owns runs only the always gate, and gets a NOTE line of its own', async () => {
  assert.deepEqual(ids(gatesFor(['src/random.txt'], REPO_ROOT)), ['context-budget']);
  const notes = notesFor(['src/random.txt', 'tools/other.dat', 'docs/a.md', '.claude/hooks/src/x.ts'], CONFIG);
  const unowned = notes.filter((n) => n.step.startsWith('unowned:'));
  assert.deepEqual(unowned.map((n) => n.step), ['unowned:src/random.txt', 'unowned:tools/other.dat']);
  assert.ok(unowned.every((n) => n.status === 'NOTE' && /no gate/.test(n.detail)));
  // Docs files are not unowned: the docs class needs no gate.
  assert.equal(notes.some((n) => /docs\/a\.md/.test(n.step)), false);
});

test('S9: scripts/rules, skills, agents and ratchets run their own node --test files', async () => {
  const want = {
    'scripts/rules/context-budget-guard.mjs': ['rules-tests', 'scripts/rules/test/*.test.mjs'],
    'scripts/skills/audit-skills.mjs': ['skills-tests', 'scripts/skills/*.test.mjs'],
    'scripts/agents/check-agent-body.mjs': ['agents-tests', 'scripts/agents/*.test.mjs'],
    'scripts/ratchets/scan-ratchet.mjs': ['ratchets-tests', 'scripts/ratchets/*.test.mjs'],
  };
  for (const [file, [id, pattern]] of Object.entries(want)) {
    const g = gatesFor([file], REPO_ROOT).find((x) => x.id === id);
    assert.ok(g, `${file} -> ${id}`);
    assert.deepEqual(g.args, ['--test', pattern]);
  }
});

test('S10: config, registry and always-loaded files get a NOTE row; rules, skills and agents add the claude -p behaviour check', async () => {
  for (const p of ['.coderabbit.yaml', 'review-router.config.json', '.claude/project-registry.json', '.claude/templates/CLAUDE.md.template']) {
    const notes = notesFor([p], CONFIG);
    assert.ok(notes.some((n) => n.status === 'NOTE' && n.step.startsWith('manual:')), p);
    assert.equal(notes.some((n) => n.step.startsWith('unowned:')), false, `${p} is owned by a NOTE row`);
  }
  assert.match(notesFor(['.claude/templates/CLAUDE.md.template'], CONFIG).map((n) => n.detail).join(' '), /context-budget/);
  for (const p of ['.claude/rules-ondemand/x.md', '.claude/rules-src/x.md', '.claude/skills/tdd/SKILL.md', '.claude/agents/kraken.md']) {
    assert.match(notesFor([p], CONFIG).map((n) => n.detail).join(' '), /claude -p/, p);
  }
});

// ---------- summaryLine ----------

test('M1: the summary line is the runner summary, not the first line', async () => {
  const out = 'first noise\n Test Files  3 passed (3)\n      Tests  41 passed (41)\n   Duration  3s\n';
  assert.equal(summaryLine(out), 'Tests  41 passed (41)');
});

test('M2: node --test, budget and plain output', async () => {
  assert.equal(summaryLine('# tests 12\n# pass 12\n# fail 0\n# duration_ms 5\n'), '# fail 0');
  assert.equal(summaryLine('always-loaded: 5 files, 23512 chars (budget 23516)\n'), 'always-loaded: 5 files, 23512 chars (budget 23516)');
  assert.equal(summaryLine('\n\nsome last words\n\n'), 'some last words');
  assert.equal(summaryLine(''), '(no output)');
});

// ---------- git preconditions ----------

const GOOD = { 'branch --show-current': 'feat/x\n', 'diff --name-only': '', 'diff --cached --name-only': '', 'ls-files --others --exclude-standard': '', 'rev-parse --verify --quiet main': `${HEAD}\n`, 'rev-list --count HEAD..main': '0\n' };

test('G1: all good gives three PASS lines, and the behind line says no fetch was done', async () => {
  const r = checkGit(fakeGit(GOOD), 'main');
  assert.deepEqual(r.map((x) => x.status), ['PASS', 'PASS', 'PASS']);
  assert.match(r[2].detail, /no fetch/i);
  assert.match(r[2].detail, /local main/);
});

test('G2: main, the base itself, and a detached HEAD fail the branch check', async () => {
  assert.equal(checkGit(fakeGit({ ...GOOD, 'branch --show-current': 'main\n' }), 'main')[0].status, 'FAIL');
  assert.equal(checkGit(fakeGit({ ...GOOD, 'branch --show-current': 'dev\n' }), 'dev')[0].status, 'FAIL');
  const detached = checkGit(fakeGit({ ...GOOD, 'branch --show-current': '\n' }), 'main')[0];
  assert.equal(detached.status, 'FAIL');
  assert.match(detached.detail, /detached/i);
});

test('G3: an edited, a staged and an untracked file each fail the clean check and are named', async () => {
  const edited = checkGit(fakeGit({ ...GOOD, 'diff --name-only': 'a.txt\n' }), 'main');
  assert.equal(edited[1].status, 'FAIL');
  assert.match(edited[1].detail, /a\.txt/);
  const staged = checkGit(fakeGit({ ...GOOD, 'diff --cached --name-only': 'b.txt\n' }), 'main');
  assert.equal(staged[1].status, 'FAIL');
  assert.match(staged[1].detail, /b\.txt/);
  const untracked = checkGit(fakeGit({ ...GOOD, 'ls-files --others --exclude-standard': 'c.txt\n' }), 'main');
  assert.equal(untracked[1].status, 'FAIL');
  assert.match(untracked[1].detail, /c\.txt/);
  const same = checkGit(fakeGit({ ...GOOD, 'diff --name-only': 'a.txt\n', 'diff --cached --name-only': 'a.txt\n' }), 'main');
  assert.match(same[1].detail, /^1 uncommitted/);
  const broken = checkGit(fakeGit({ ...GOOD, 'diff --name-only': { status: 128, stdout: '', stderr: 'fatal' } }), 'main');
  assert.equal(broken[1].status, 'FAIL');
});

test('G3b: a file whose time changed but whose content did not does not make the tree dirty (real git)', async () => {
  const repo = makeRepo();
  const file = path.join(repo.dir, 'docs', 'a.md');
  writeFileSync(file, readFileSync(file));
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(checkGit(makeGit(repo.dir), 'main')[1].status, 'PASS');
  writeFileSync(file, 'changed\n');
  assert.equal(checkGit(makeGit(repo.dir), 'main')[1].status, 'FAIL');
});

test('G4: behind the base fails with the count', async () => {
  const r = checkGit(fakeGit({ ...GOOD, 'rev-list --count HEAD..main': '3\n' }), 'main');
  assert.equal(r[2].status, 'FAIL');
  assert.match(r[2].detail, /3 commit/);
});

test('G5: a missing base ref fails, never "0 behind"', async () => {
  const r = checkGit(fakeGit({ ...GOOD, 'rev-parse --verify --quiet main': { status: 1, stdout: '', stderr: '' } }), 'main');
  assert.equal(r[2].status, 'FAIL');
  assert.match(r[2].detail, /main/);
  const garbage = checkGit(fakeGit({ ...GOOD, 'rev-list --count HEAD..main': 'oops\n' }), 'main');
  assert.equal(garbage[2].status, 'FAIL');
  assert.match(garbage[2].detail, /cannot count/);
});

// ---------- evidence ----------

const featureBody = (head, redSha = 'b'.repeat(40)) => [
  '## Evidence', '', 'Proof type: feature', '',
  `RED: \`node --test x\` @ ${redSha}`, '```text', 'not ok 1', '```', '',
  `GREEN: \`node --test x\` @ ${head}`, '```text', 'ok 1', '```', '',
].join('\n');

test('E1: an empty body fails with the READY reason text', async () => {
  const r = checkEvidence({ body: '', head: HEAD, paths: ['scripts/x.mjs'], config: CONFIG });
  assert.equal(r.status, 'FAIL');
  assert.match(r.notes.join('\n'), /PR body proof:/);
});

test('E2: GREEN naming another commit fails; GREEN naming the head (full or 7 chars) passes', async () => {
  const bad = checkEvidence({ body: featureBody('c'.repeat(40)), head: HEAD, paths: ['scripts/x.mjs'], config: CONFIG });
  assert.equal(bad.status, 'FAIL');
  assert.match(bad.notes.join('\n'), /GREEN names commit/);
  assert.equal(checkEvidence({ body: featureBody(HEAD), head: HEAD, paths: ['scripts/x.mjs'], config: CONFIG }).status, 'PASS');
  assert.equal(checkEvidence({ body: featureBody(HEAD.slice(0, 7)), head: HEAD, paths: ['scripts/x.mjs'], config: CONFIG }).status, 'PASS');
});

test('E3: a body file path that is unreadable is a FAIL, not a throw', async () => {
  const r = checkEvidence({ body: null, head: HEAD, paths: ['a.md'], config: CONFIG });
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /no PR body text/);
});

test('E4: docs passes only when every changed file is docs', async () => {
  const body = '## Evidence\n\nProof type: docs\n';
  assert.equal(checkEvidence({ body, head: HEAD, paths: ['docs/a.md', 'thoughts/b.md'], config: CONFIG }).status, 'PASS');
  const mixed = checkEvidence({ body, head: HEAD, paths: ['docs/a.md', 'scripts/x.mjs'], config: CONFIG });
  assert.equal(mixed.status, 'FAIL');
  assert.match(mixed.notes.join('\n'), /docs/);
  // A rule file ends in .md but is steering, not docs.
  assert.equal(checkEvidence({ body, head: HEAD, paths: ['.claude/rules-ondemand/pr-review-loop.md'], config: CONFIG }).status, 'FAIL');
});

test('E5: docs with no changed file fails', async () => {
  assert.equal(checkEvidence({ body: 'Proof type: docs\n', head: HEAD, paths: [], config: CONFIG }).status, 'FAIL');
});

test('E6: changedFiles lists the diff against the base and fails on an empty or broken diff', async () => {
  const ok = changedFiles(fakeGit({ 'diff --name-only main...HEAD': 'a.md\nb/c.mjs\n' }), 'main');
  assert.deepEqual(ok.paths, ['a.md', 'b/c.mjs']);
  assert.equal(ok.result.status, 'PASS');
  assert.equal(changedFiles(fakeGit({ 'diff --name-only main...HEAD': '' }), 'main').result.status, 'FAIL');
  assert.equal(changedFiles(fakeGit({ 'diff --name-only main...HEAD': { status: 128, stdout: '', stderr: 'bad' } }), 'main').result.status, 'FAIL');
});

// ---------- CodeRabbit step ----------

// A real-shaped agent stream (cli__agent-mode.md): review_context, status, heartbeat, findings, complete.
const ev = (...objs) => `${objs.map((o) => JSON.stringify(o)).join('\n')}\n`;
const CONTEXT = { type: 'review_context', workingDirectory: '/x', currentBranch: 'feat/x', baseBranch: 'main', expectedDuration: 120 };
const MAJOR = { type: 'finding', severity: 'major', fileName: 'src/a.ts', startLine: 10, endLine: 12, title: 'Null check missing', comment: 'c', codegenInstructions: 'fix it' };
const MINOR = { type: 'finding', severity: 'minor', fileName: 'src/b.ts', startLine: 3, endLine: 3, comment: 'rename this' };
const DONE = { type: 'complete', status: 'review_completed', findings: 2, outcome: 'completed' };
const NDJSON_OK = ev(CONTEXT, { type: 'status', status: 'reviewing' }, { type: 'heartbeat' }, MAJOR, MINOR, DONE);
const USAGE_OK = ev({ type: 'usage', remaining: 5, fullCapacityInMs: 0 });

function crFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'prepr-cr-'));
  const calls = [];
  const usageCalls = [];
  const runner = (opts) => {
    if (opts.args[0] === 'usage') { usageCalls.push(opts); return runner.usage ?? { status: 0, stdout: USAGE_OK, stderr: '' }; }
    calls.push(opts);
    return runner.next ?? { status: 0, stdout: NDJSON_OK, stderr: '' };
  };
  return { root, calls, usageCalls, runner, now: new Date('2026-10-27T10:00:00Z') };
}
const crOpts = (f, extra = {}) => ({ root: f.root, branch: 'feat/x', head: HEAD, base: 'main', now: f.now, runner: f.runner, ...extra });

test('C1: the run uses cr review --agent and never --use-credits or --api-key', async () => {
  const f = crFixture();
  const r = (await runCodeRabbit(crOpts(f)));
  assert.equal(r.status, 'PASS');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args.slice(0, 2), ['review', '--agent']);
  assert.equal(f.calls[0].args.some((a) => /use-credits|api-key/.test(a)), false);
  assert.ok(f.calls[0].timeoutMs >= 15 * 60_000);
  assert.deepEqual(CR_ARGS('main'), ['review', '--agent', '--committed', '--base', 'main']);
  assert.deepEqual(f.calls[0].args, CR_ARGS('main'));
  assert.deepEqual(CR_USAGE_ARGS, ['usage', '--agent']);
  assert.throws(() => assertSafeCrArgs(['usage', '--agent', '--use-credits']), /forbidden/i);
  assert.throws(() => assertSafeCrArgs(['usage']), /forbidden/i);
  assertSafeCrArgs(['usage', '--agent']);
  assertSafeCrArgs(CR_ARGS('main'));
  for (const bad of ['--use-credits', '--api-key', '--api-key=abc', 'code']) {
    assert.throws(() => assertSafeCrArgs(['review', '--agent', bad]), /forbidden/i, bad);
  }
  assertSafeCrArgs(['review', '--agent', '--base', 'main']);
  const out = path.join(f.root, '.claude', 'cache', 'e2e', '2026-10-27-pre-pr-cr-aaaaaaa.txt');
  assert.ok(existsSync(out), 'output saved');
  assert.match(readFileSync(out, 'utf8'), /finding/);
  assert.match(r.detail, /2026-10-27-pre-pr-cr-aaaaaaa\.txt/);
});

test('C2: --skip-cr never calls the runner and says SKIP', async () => {
  const f = crFixture();
  const r = (await runCodeRabbit(crOpts(f, { skip: true })));
  assert.equal(r.status, 'SKIP');
  assert.equal(r.skipReason, 'flag');
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(path.join(f.root, '.claude', 'cache', 'pre-pr')), false, 'no counter written');
});

test('C3: a saved output for the same head is reused: the runner is not called again, even on another day', async () => {
  const f = crFixture();
  (await runCodeRabbit(crOpts(f)));
  const again = (await runCodeRabbit(crOpts(f, { now: new Date('2026-10-29T10:00:00Z') })));
  assert.equal(f.calls.length, 1);
  assert.equal(again.status, 'PASS');
  assert.match(again.detail, /reus/i);
});

test('C4: the third run on one branch is a SKIP with reason cap, with the limit named', async () => {
  const f = crFixture();
  (await runCodeRabbit(crOpts(f, { head: '1'.repeat(40) })));
  (await runCodeRabbit(crOpts(f, { head: '2'.repeat(40) })));
  const third = (await runCodeRabbit(crOpts(f, { head: '3'.repeat(40) })));
  assert.equal(CR_RUN_LIMIT, 2);
  assert.equal(third.status, 'SKIP');
  assert.equal(third.skipReason, 'cap');
  assert.match(third.detail, /2 .*runs|limit/i);
  assert.equal(f.calls.length, 2);
  // Another branch has its own count.
  assert.equal((await runCodeRabbit(crOpts(f, { branch: 'feat/other', head: '4'.repeat(40) }))).status, 'PASS');
  assert.equal(f.calls.length, 3);
});

test('C5: a failed run uses a slot, saves no reusable output, and may be retried within the cap', async () => {
  const f = crFixture();
  f.runner.next = { status: 1, stdout: '', stderr: 'boom' };
  const first = (await runCodeRabbit(crOpts(f)));
  assert.equal(first.status, 'FAIL');
  assert.deepEqual(readdirSync(path.join(f.root, '.claude', 'cache', 'e2e')).filter((n) => /\.txt$/.test(n) && !/failed/.test(n)), []);
  f.runner.next = undefined;
  assert.equal((await runCodeRabbit(crOpts(f))).status, 'PASS');
  assert.equal(f.calls.length, 2);
  // Both slots are used now.
  const capped = (await runCodeRabbit(crOpts(f, { head: '9'.repeat(40) })));
  assert.equal(capped.status, 'SKIP');
  assert.equal(capped.skipReason, 'cap');
  assert.equal(f.calls.length, 2);
});

test('C6: a status or complete record that says awaiting_confirmation or action_required fails even with exit 0', async () => {
  for (const word of ['awaiting_confirmation', 'action_required']) {
    for (const type of ['status', 'complete']) {
      const f = crFixture();
      f.runner.next = { status: 0, stdout: ev(CONTEXT, { type, status: word }, DONE), stderr: '' };
      const r = (await runCodeRabbit(crOpts(f)));
      assert.equal(r.status, 'FAIL', `${type} ${word}`);
      assert.match(r.detail, new RegExp(word));
    }
  }
});

test('C6b: the same words inside a finding, or in raw text, never fail the step', async () => {
  const f = crFixture();
  const quoting = { ...MAJOR, comment: 'the state action_required and awaiting_confirmation are reserved', title: 'status: action_required' };
  f.runner.next = { status: 0, stdout: `${ev(CONTEXT, quoting, DONE)}# a banner that says awaiting_confirmation\n`, stderr: '' };
  const r = (await runCodeRabbit(crOpts(f)));
  assert.equal(r.status, 'PASS', r.detail);
});

test('C7: a timeout fails and uses a slot; a spawn error is a SKIP that uses none (ENOENT/EINVAL cli-missing, other cli-error)', async () => {
  const f = crFixture();
  f.runner.next = { status: null, stdout: 'partial', stderr: '', timedOut: true };
  assert.match((await runCodeRabbit(crOpts(f))).detail, /did not finish|timed out/i);
  const g = crFixture();
  g.runner.next = { status: null, stdout: '', stderr: '', error: 'ENOENT' };
  const gone = (await runCodeRabbit(crOpts(g)));
  assert.equal(gone.status, 'SKIP');
  assert.equal(gone.skipReason, 'cli-missing');
  assert.match(gone.detail, /ENOENT/);
  for (const [code, reason] of [['EINVAL', 'cli-missing'], ['EACCES', 'cli-error'], ['EPERM', 'cli-error']]) {
    const e = crFixture();
    e.runner.next = { status: null, stdout: '', stderr: '', error: `spawn cr ${code}`, errorCode: code };
    const r = await runCodeRabbit(crOpts(e));
    assert.equal(r.skipReason, reason, code);
    assert.equal(JSON.parse(readFileSync(crPaths(e.root, 'feat/x').counter, 'utf8')).runs.length, 0, `${code}: no slot spent`);
  }
  const counters = readdirSync(path.join(g.root, '.claude', 'cache', 'pre-pr')).filter((n) => /^cr-runs-/.test(n));
  const runs = JSON.parse(readFileSync(path.join(g.root, '.claude', 'cache', 'pre-pr', counters[0]), 'utf8')).runs;
  assert.equal(runs.length, 0, 'the process did not start: no slot is spent');
  // Two spawn errors in a row do not reach the cap; a working CLI still runs after them.
  (await runCodeRabbit(crOpts(g, { head: '2'.repeat(40) })));
  (await runCodeRabbit(crOpts(g, { head: '3'.repeat(40) })));
  g.runner.next = undefined;
  assert.equal((await runCodeRabbit(crOpts(g, { head: '4'.repeat(40) }))).status, 'PASS');
  // A kill by the timeout can still leave exit 0 and partial output: it is not a finished review.
  const h = crFixture();
  h.runner.next = { status: 0, stdout: 'partial', stderr: '', timedOut: true };
  assert.equal((await runCodeRabbit(crOpts(h))).status, 'FAIL');
  const none = readdirSync(path.join(h.root, '.claude', 'cache', 'e2e')).filter((n) => !/failed/.test(n));
  assert.deepEqual(none, []);
});

test('C8: a corrupt counter file fails the step and does not run the CLI (a lost count must not unlock runs)', async () => {
  const f = crFixture();
  (await runCodeRabbit(crOpts(f, { head: '1'.repeat(40) })));
  const dir = path.join(f.root, '.claude', 'cache', 'pre-pr');
  const file = path.join(dir, readdirSync(dir).find((n) => /^cr-runs-/.test(n)));
  writeFileSync(file, '{not json');
  const r = (await runCodeRabbit(crOpts(f, { head: '2'.repeat(40) })));
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /unreadable/);
  assert.equal(f.calls.length, 1);
});

test('N1: findings are read by their real field names, grouped by severity, none not counted', async () => {
  const f = crFixture();
  const none = { type: 'finding', severity: 'none', fileName: 'src/c.ts', comment: 'fine' };
  f.runner.next = { status: 0, stdout: ev(CONTEXT, MAJOR, MINOR, none, { ...MINOR, severity: 'critical', fileName: 'src/d.ts', startLine: 1, endLine: 1, comment: undefined, codegenInstructions: 'use a guard' }, { ...DONE, findings: 4 }), stderr: '' };
  const r = (await runCodeRabbit(crOpts(f)));
  assert.equal(r.status, 'PASS');
  assert.match(r.detail, /3 finding/);
  assert.match(r.detail, /1 critical/);
  assert.match(r.detail, /1 major/);
  assert.match(r.detail, /1 minor/);
  assert.doesNotMatch(r.detail, /none/);
  assert.ok(r.notes.some((n) => n.includes('src/a.ts:10-12') && n.includes('Null check missing')), r.notes.join('\n'));
  assert.ok(r.notes.some((n) => n.includes('src/b.ts:3') && n.includes('rename this')), 'the first non-empty of title, comment, codegenInstructions');
  assert.ok(r.notes.some((n) => n.includes('src/d.ts') && n.includes('use a guard')), r.notes.join('\n'));
  assert.ok(r.notes[0].startsWith('critical'), 'worst first');
});

test('N2: a review_skipped complete is a SKIP with reason no-changes', async () => {
  const f = crFixture();
  f.runner.next = { status: 0, stdout: ev(CONTEXT, { type: 'status', status: 'review_skipped' }, { type: 'complete', status: 'review_skipped', findings: 0, message: 'No changes detected' }), stderr: '' };
  const r = (await runCodeRabbit(crOpts(f)));
  assert.equal(r.status, 'SKIP');
  assert.equal(r.skipReason, 'no-changes');
  assert.match(r.detail, /--committed/);
  assert.match(r.detail, /main/);
  // The CLI saw an empty scope: no review was done, so the run is given back like one that never started.
  assert.equal(JSON.parse(readFileSync(crPaths(f.root, 'feat/x').counter, 'utf8')).runs.length, 0);
});

test('N3: a complete with outcome failed, or with unreviewed files, is INCOMPLETE and fails; the findings are kept', async () => {
  for (const extra of [{ outcome: 'failed', message: 'server error' }, { unreviewedFileCount: 3 }]) {
    const f = crFixture();
    f.runner.next = { status: 0, stdout: ev(CONTEXT, MAJOR, { ...DONE, ...extra }), stderr: '' };
    const r = (await runCodeRabbit(crOpts(f)));
    assert.equal(r.status, 'FAIL', JSON.stringify(extra));
    assert.match(r.detail, /INCOMPLETE/);
    assert.ok(r.notes.some((n) => n.includes('src/a.ts')), 'findings kept');
  }
  const ok = crFixture();
  ok.runner.next = { status: 0, stdout: ev(CONTEXT, { ...DONE, outcome: 'completed_with_warnings', unreviewedFileCount: 0 }), stderr: '' };
  assert.equal((await runCodeRabbit(crOpts(ok))).status, 'PASS');
});

test('N4: a stream with no complete event is INCOMPLETE and fails; a non-zero exit does not drop the findings', async () => {
  const a = crFixture();
  a.runner.next = { status: 0, stdout: ev(CONTEXT, MAJOR), stderr: '' };
  const none = (await runCodeRabbit(crOpts(a)));
  assert.equal(none.status, 'FAIL');
  assert.match(none.detail, /INCOMPLETE/);
  assert.match(none.detail, /no complete/);
  assert.ok(none.notes.some((n) => n.includes('src/a.ts')));
  const b = crFixture();
  b.runner.next = { status: 1, stdout: ev(CONTEXT, MAJOR, MINOR, DONE), stderr: 'boom' };
  const bad = (await runCodeRabbit(crOpts(b)));
  assert.equal(bad.status, 'FAIL');
  assert.match(bad.detail, /exit 1/);
  assert.ok(bad.notes.some((n) => n.includes('src/a.ts')) && bad.notes.some((n) => n.includes('src/b.ts')), 'findings kept after a non-zero exit');
  const out = readdirSync(path.join(b.root, '.claude', 'cache', 'e2e')).find((n) => /failed\.txt$/.test(n));
  assert.match(readFileSync(path.join(b.root, '.claude', 'cache', 'e2e', out), 'utf8'), /src\/a\.ts/, 'the stream is saved');
});

test('N5: a reused result is a PASS that says so; an error event fails with its type; unknown events and a save failure are noted', async () => {
  const a = crFixture();
  a.runner.next = { status: 0, stdout: ev(CONTEXT, { ...DONE, reused: true, persistence: { status: 'failed', errorCode: 'EACCES' } }, { type: 'brand_new' }), stderr: '' };
  const reused = (await runCodeRabbit(crOpts(a)));
  assert.equal(reused.status, 'PASS');
  assert.match(reused.detail, /reused result/);
  assert.ok(reused.notes.some((n) => /brand_new/.test(n)), 'unknown event noted');
  assert.ok(reused.notes.some((n) => /save|persist/i.test(n)), 'persistence failure noted');
  const b = crFixture();
  b.runner.next = { status: 1, stdout: ev(CONTEXT, { type: 'error', errorType: 'rate_limit', message: 'wait 12 minutes' }), stderr: '' };
  const err = (await runCodeRabbit(crOpts(b)));
  assert.equal(err.status, 'FAIL');
  assert.match(err.detail, /rate_limit/);
  assert.match(err.detail, /wait 12 minutes/);
});

test('N6: parseAgentStream ignores blank and non-JSON lines and keeps counts', () => {
  const p = parseAgentStream(`banner\n\n${ev(CONTEXT, MAJOR)}{broken\n`);
  assert.equal(p.findings.length, 1);
  assert.equal(p.unparsed, 2);
  assert.equal(p.complete, null);
  assert.equal(p.awaiting, null);
  assert.deepEqual(parseAgentStream(undefined).findings, []);
});

test('P1: cr usage --agent runs first; remaining 0 is a SKIP rate-limited with the wait, and no run is spent', async () => {
  const f = crFixture();
  f.runner.usage = { status: 0, stdout: ev({ type: 'usage', remaining: 0, fullCapacityInMs: 720000 }), stderr: '' };
  const r = (await runCodeRabbit(crOpts(f)));
  assert.equal(r.status, 'SKIP');
  assert.equal(r.skipReason, 'rate-limited');
  assert.equal(r.retryMinutes, 12);
  assert.match(r.detail, /12 min/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.usageCalls.length, 1);
  assert.deepEqual(f.usageCalls[0].args, ['usage', '--agent']);
  const counters = existsSync(path.join(f.root, '.claude', 'cache', 'pre-pr')) ? readdirSync(path.join(f.root, '.claude', 'cache', 'pre-pr')) : [];
  assert.deepEqual(counters, [], 'no counter written: no run spent');
});

test('P2: a cr usage that cannot start is cli-missing (ENOENT/EINVAL); a non-zero exit, a timeout or an auth error is cli-error; neither spends a run', async () => {
  const cases = [
    [{ status: 1, stdout: '', stderr: 'not authenticated' }, 'cli-error'],
    [{ status: 2, stdout: ev({ type: 'error', errorType: 'auth', message: 'sign in' }), stderr: '' }, 'cli-error'],
    [{ status: null, stdout: '', stderr: '', timedOut: true }, 'cli-error'],
    [{ status: null, stdout: '', stderr: '', error: 'spawn cr EACCES', errorCode: 'EACCES' }, 'cli-error'],
    [{ status: null, stdout: '', stderr: '', error: 'spawn cr ENOENT', errorCode: 'ENOENT' }, 'cli-missing'],
    [{ status: null, stdout: '', stderr: '', error: 'spawn cr EINVAL', errorCode: 'EINVAL' }, 'cli-missing'],
  ];
  for (const [usage, reason] of cases) {
    const f = crFixture();
    f.runner.usage = usage;
    const r = (await runCodeRabbit(crOpts(f)));
    assert.equal(r.status, 'SKIP', JSON.stringify(usage));
    assert.equal(r.skipReason, reason, JSON.stringify(usage));
    assert.equal(f.calls.length, 0);
    assert.equal(existsSync(crPaths(f.root, 'feat/x').counter), false, 'no counter written: no run spent');
  }
});

test('P3: a usage report that is not understood does not block the review; remaining above 0 runs it', async () => {
  const a = crFixture();
  a.runner.usage = { status: 0, stdout: 'Included reviews: some text\n', stderr: '' };
  assert.equal((await runCodeRabbit(crOpts(a))).status, 'PASS');
  assert.equal(a.calls.length, 1);
  const b = crFixture();
  assert.equal((await runCodeRabbit(crOpts(b))).status, 'PASS');
  assert.equal(b.usageCalls.length, 1);
});

test('P4: parseUsage reads remaining and the wait', () => {
  assert.deepEqual(parseUsage(ev({ type: 'usage', remaining: 0, fullCapacityInMs: 90_000 })), { remaining: 0, retryMinutes: 2 });
  assert.deepEqual(parseUsage(ev({ type: 'usage', remaining: 3 })), { remaining: 3, retryMinutes: null });
  assert.deepEqual(parseUsage(`${ev({ type: 'heartbeat' })}${ev({ type: 'usage', remaining: 0 })}`), { remaining: 0, retryMinutes: null });
  // The real output of `cr usage --agent` (CLI 0.9.0, 2026-10-27): the counts sit under includedReviews.
  const real = '{"type":"status","phase":"usage","status":"complete","organization":"Rev4nchist","includedReviews":{"state":"available","repository":"Rev4nchist/Continuous-Claude-v3","fullCapacityInMs":0,"limit":10,"remaining":10,"rollingWindowMs":3600000},"billingPeriod":{"state":"available","scope":"user","usageBillingStatus":"inactive","user":"Rev4nchist","reviewsCount":40,"resetsAt":"2026-11-12T01:34:54.000Z"}}\n';
  assert.deepEqual(parseUsage(real), { remaining: 10, retryMinutes: null });
  assert.deepEqual(parseUsage(real.replace('"fullCapacityInMs":0,"limit":10,"remaining":10', '"fullCapacityInMs":2400000,"limit":10,"remaining":0')), { remaining: 0, retryMinutes: 40 });
  assert.equal(parseUsage('nothing here'), null);
  assert.equal(parseUsage(undefined), null);
  assert.equal(parseUsage(ev({ type: 'usage', remaining: 'many' })), null);
});

test('P5: a slow review prints a heartbeat line through log', async () => {
  const f = crFixture();
  const lines = [];
  const runner = (opts) => {
    if (opts.args[0] === 'review') opts.onTick({ elapsedSec: 60, lastEvent: 'heartbeat' });
    return f.runner(opts);
  };
  await runCodeRabbit({ ...crOpts(f), runner, log: (m) => lines.push(m) });
  assert.ok(lines.some((m) => /still running/.test(m) && /60/.test(m) && /heartbeat/.test(m)), lines.join('\n'));
});

test('T1: the review time limit is 30 minutes, set by --cr-timeout-min or PRE_PR_CR_TIMEOUT_MIN; the flag wins; the floor is 15; bad values fall back to 30', () => {
  assert.equal(crTimeoutMs([], {}), 30 * 60_000);
  assert.equal(crTimeoutMs([], { PRE_PR_CR_TIMEOUT_MIN: '45' }), 45 * 60_000);
  assert.equal(crTimeoutMs(['--cr-timeout-min', '20'], { PRE_PR_CR_TIMEOUT_MIN: '45' }), 20 * 60_000);
  assert.equal(crTimeoutMs(['--cr-timeout-min', '15'], {}), 15 * 60_000, '15 is the floor and is allowed');
  for (const low of ['1', '5', '14', '14.9']) {
    assert.equal(crTimeoutMs(['--cr-timeout-min', low], {}), 30 * 60_000, `flag ${low}`);
    assert.equal(crTimeoutMs([], { PRE_PR_CR_TIMEOUT_MIN: low }), 30 * 60_000, `env ${low}`);
  }
  for (const bad of ['0', '-3', 'abc', '']) assert.equal(crTimeoutMs([], { PRE_PR_CR_TIMEOUT_MIN: bad }), 30 * 60_000, bad);
});

test('T1b: a value under 15 is named in a warning, so the fallback is not silent; a good or absent value gives none', () => {
  assert.match(crTimeoutProblem(['--cr-timeout-min', '5'], {}), /at least 15/);
  assert.match(crTimeoutProblem(['--cr-timeout-min', '5'], {}), /30/);
  assert.match(crTimeoutProblem([], { PRE_PR_CR_TIMEOUT_MIN: 'abc' }), /PRE_PR_CR_TIMEOUT_MIN/);
  assert.equal(crTimeoutProblem([], {}), null);
  assert.equal(crTimeoutProblem(['--cr-timeout-min', '15'], {}), null);
  assert.equal(crTimeoutProblem([], { PRE_PR_CR_TIMEOUT_MIN: '45' }), null);
  // The flag wins, so a bad env value behind a good flag is not reported.
  assert.equal(crTimeoutProblem(['--cr-timeout-min', '20'], { PRE_PR_CR_TIMEOUT_MIN: '3' }), null);
});

function fakeCr(source) {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-fakecr-')), 'fake-cr.mjs');
  writeFileSync(file, source);
  return file;
}
const REVIEW = ['review', '--agent', '--committed', '--base', 'main'];
const asFake = (script) => ({ command: process.execPath, prefixArgs: [script], tickMs: 40 });

test('T2: the runner streams the child output to the log file as it arrives, reports ticks with the last event, and returns the exit code', async () => {
  const script = fakeCr(`const L = ${JSON.stringify(['{"type":"review_context"}', '{"type":"heartbeat"}', '{"type":"complete","status":"review_completed"}'])}; let i = 0; const t = setInterval(() => { console.log(L[i++]); if (i === L.length) clearInterval(t); }, 150);`);
  const streamTo = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-stream-')), 'run.txt');
  const ticks = [];
  const r = await defaultCrRunner({ cwd: os.tmpdir(), args: REVIEW, timeoutMs: 20_000, streamTo, onTick: (t) => ticks.push(t) }, asFake(script));
  assert.equal(r.status, 0);
  assert.equal(r.timedOut, false);
  assert.match(r.stdout, /complete/);
  assert.equal(readFileSync(streamTo, 'utf8'), r.stdout, 'the file holds the same stream');
  assert.ok(ticks.length >= 1, 'a tick arrived while the child ran');
  assert.ok(ticks.some((t) => t.lastEvent === 'heartbeat' || t.lastEvent === 'review_context'), JSON.stringify(ticks));
  assert.ok(ticks.every((t) => typeof t.elapsedSec === 'number'));
});

test('T3: the hard timeout kills a child that does not end, and keeps the partial stream', async () => {
  const script = fakeCr('setInterval(() => console.log(\'{"type":"heartbeat"}\'), 40);');
  const streamTo = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-stream-')), 'run.txt');
  const started = Date.now();
  const r = await defaultCrRunner({ cwd: os.tmpdir(), args: REVIEW, timeoutMs: 3000, streamTo }, asFake(script));
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 30_000, 'it returned');
  assert.match(r.stdout, /heartbeat/);
  assert.match(readFileSync(streamTo, 'utf8'), /heartbeat/);
});

// The grandchild is spawned detached: on Windows libuv puts a normal child in a job object that dies with its parent, which
// would hide a missing tree kill. A native exe such as cr.exe has no such job, so the test must break away from it.
test('T5: the hard timeout stops the whole process tree, not only the child (no tree-kill command)', async () => {
  const pidFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-gc-')), 'gc.pid');
  const script = fakeCr(`import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', ${JSON.stringify(pidFile)}], { stdio: 'ignore', detached: true }).unref();
setInterval(() => console.log('{"type":"heartbeat"}'), 100);`);
  const r = await defaultCrRunner({ cwd: os.tmpdir(), args: REVIEW, timeoutMs: 5000 }, { ...asFake(script), killGraceMs: 8000 });
  assert.equal(r.timedOut, true);
  assert.ok(existsSync(pidFile), 'the grandchild started');
  const gc = Number(readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 80 && alive; i += 1) {
    try { process.kill(gc, 0); await sleep(100); } catch { alive = false; }
  }
  assert.equal(alive, false, `grandchild ${gc} is still running`);
  assert.doesNotMatch(readFileSync(path.join(HERE, 'pre-pr.mjs'), 'utf8'), /taskkill/i, 'taskkill /T is forbidden on this machine');
});

test('T6: killTree stops the children first, then the parent, ignores a process that is gone, and kills the group on POSIX', () => {
  const tree = { 10: [11, 12], 11: [13], 12: [], 13: [] };
  const killed = [];
  killTree(10, { platform: 'win32', children: (p) => tree[p] ?? [], kill: (p) => { killed.push(p); if (p === 12) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
  assert.deepEqual(killed, [13, 11, 12, 10]);
  const posix = [];
  killTree(10, { platform: 'linux', kill: (p) => posix.push(p) });
  assert.deepEqual(posix, [-10]);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 424242;
  child.kill = () => {};
  return child;
}
function fakeStream() {
  const s = new EventEmitter();
  s.writes = [];
  s.ended = false;
  s.write = (x) => { s.writes.push(x); return true; };
  s.end = () => { s.ended = true; };
  return s;
}

test('T7: after the runner has settled nothing is written to the stream file; a stream error is recorded and does not stop the run', async () => {
  const child = fakeChild();
  const stream = fakeStream();
  const r = await defaultCrRunner({ cwd: os.tmpdir(), args: REVIEW, timeoutMs: 100, streamTo: 'x' }, { spawnFn: () => child, killer: () => {}, killGraceMs: 50, tickMs: 1000, openStream: () => stream });
  assert.equal(r.timedOut, true);
  assert.equal(stream.ended, true);
  const before = stream.writes.length;
  child.stdout.write('{"type":"heartbeat"}\n');
  await sleep(100);
  assert.equal(stream.writes.length, before, 'no write after the stream ended');

  const child2 = fakeChild();
  const stream2 = fakeStream();
  const run = defaultCrRunner({ cwd: os.tmpdir(), args: REVIEW, timeoutMs: 20_000, streamTo: 'x' }, { spawnFn: () => child2, killer: () => {}, tickMs: 1000, openStream: () => stream2 });
  child2.stdout.write('{"type":"heartbeat"}\n');
  stream2.emit('error', new Error('disk full'));
  await sleep(30);
  child2.emit('close', 0);
  const r2 = await run;
  assert.equal(r2.status, 0);
  assert.match(r2.streamError, /disk full/);
  assert.match(r2.stdout, /heartbeat/);
});

test('T4: a non-zero exit keeps the stdout; a missing binary reports ENOENT; unsafe args are refused before any spawn', async () => {
  const script = fakeCr('console.log(\'{"type":"finding","severity":"major"}\'); process.exit(1);');
  const bad = await defaultCrRunner({ cwd: os.tmpdir(), args: REVIEW, timeoutMs: 20_000 }, asFake(script));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /finding/);
  const gone = await defaultCrRunner({ cwd: os.tmpdir(), args: REVIEW, timeoutMs: 20_000 }, { command: 'definitely-not-a-binary-xyz', prefixArgs: [] });
  assert.equal(gone.errorCode, 'ENOENT');
  assert.ok(gone.error);
  await assert.rejects(() => defaultCrRunner({ cwd: os.tmpdir(), args: ['review', '--use-credits'], timeoutMs: 1000 }, asFake(script)), /forbidden/i);
});

test('B4: a cap reached by runs that never reached a complete event is stamped with 0 finished runs, and the built hook denies it', async () => {
  const repo = withFork(makeRepo());
  const broken = { root: repo.dir, branch: 'feat/x', base: 'main', now: new Date('2026-10-27T09:00:00Z'), runner: (o) => (o.args[0] === 'usage' ? { status: 0, stdout: USAGE_OK, stderr: '' } : { status: 1, stdout: '', stderr: 'crashed' }) };
  await runCodeRabbit({ ...broken, head: '1'.repeat(40) });
  await runCodeRabbit({ ...broken, head: '2'.repeat(40) });
  assert.equal((await prePr(repo)).result.ok, true);
  const stamp = JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8'));
  assert.equal(stamp.cr_skip_reason, 'cap');
  assert.equal(stamp.cr_finished_runs, 0);
  const v = hookVerdict(repo.dir);
  assert.equal(v.allow, false);
  assert.match(v.reason, /finished/);
});

test('B5: a broken CLI (cr usage fails with an exit code) is stamped cli-error and the built hook denies it', async () => {
  const repo = withFork(makeRepo());
  const { result } = await prePr(repo, { crRunner: (o) => (o.args[0] === 'usage' ? { status: 1, stdout: '', stderr: 'not authenticated' } : { status: 0, stdout: NDJSON_OK, stderr: '' }) });
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.equal(JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8')).cr_skip_reason, 'cli-error');
  assert.equal(hookVerdict(repo.dir).allow, false);
});

test('B6: runs that ended awaiting_confirmation, with outcome failed, or with unreviewed files give 0 finished runs, and the built hook denies the resulting cap stamp', async () => {
  const bad = [
    [CONTEXT, { type: 'status', status: 'awaiting_confirmation' }, DONE],
    [CONTEXT, { ...DONE, status: 'action_required' }],
    [CONTEXT, { ...DONE, outcome: 'failed' }],
    [CONTEXT, { ...DONE, unreviewedFileCount: 2 }],
  ];
  for (const events of bad) {
    const repo = withFork(makeRepo());
    const spent = { root: repo.dir, branch: 'feat/x', base: 'main', now: new Date('2026-10-27T09:00:00Z'), runner: (o) => ({ status: 0, stdout: o.args[0] === 'usage' ? USAGE_OK : ev(...events), stderr: '' }) };
    await runCodeRabbit({ ...spent, head: '1'.repeat(40) });
    await runCodeRabbit({ ...spent, head: '2'.repeat(40) });
    assert.equal(finishedRuns(repo.dir, 'feat/x'), 0, JSON.stringify(events));
    assert.equal((await prePr(repo)).result.ok, true);
    const stamp = JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8'));
    assert.equal(stamp.cr_skip_reason, 'cap');
    assert.equal(stamp.cr_finished_runs, 0);
    const v = hookVerdict(repo.dir);
    assert.equal(v.allow, false, JSON.stringify(events));
    assert.match(v.reason, /finished with a PASS/);
  }
});

// ---------- the run lock, the shared counter, finished runs ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

test('L1: a second CodeRabbit step on the same branch while one runs FAILs with the pid and runs nothing; another branch is free; the lock is released at the end', async () => {
  const f = crFixture();
  let release;
  const hold = new Promise((r) => { release = r; });
  const slow = async (opts) => {
    if (opts.args[0] === 'usage') return { status: 0, stdout: USAGE_OK, stderr: '' };
    f.calls.push(opts);
    await hold;
    return { status: 0, stdout: NDJSON_OK, stderr: '' };
  };
  const first = runCodeRabbit({ ...crOpts(f), runner: slow });
  await sleep(100);
  assert.equal(existsSync(crPaths(f.root, 'feat/x').lock), true, 'the lock file is held while the review runs');
  const lock = JSON.parse(readFileSync(crPaths(f.root, 'feat/x').lock, 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.head, HEAD);
  const second = await runCodeRabbit(crOpts(f, { head: '2'.repeat(40) }));
  assert.equal(second.status, 'FAIL');
  assert.match(second.detail, new RegExp(`a CodeRabbit run is in progress \\(pid ${process.pid}`));
  assert.equal(f.calls.length, 1, 'the second step ran no review');
  assert.equal((await runCodeRabbit(crOpts(f, { branch: 'feat/other', head: '3'.repeat(40) }))).status, 'PASS');
  release();
  assert.equal((await first).status, 'PASS');
  assert.equal(existsSync(crPaths(f.root, 'feat/x').lock), false, 'released');
  assert.equal((await runCodeRabbit(crOpts(f, { head: '4'.repeat(40) }))).status, 'PASS');
});

test('L2: a lock whose pid is not alive, or whose body is unreadable, is stale and replaced', async () => {
  const gone = spawn(process.execPath, ['-e', '0']);
  await once(gone, 'exit');
  for (const body of [JSON.stringify({ pid: gone.pid, head: 'old', at: 'x' }), '{not json', JSON.stringify({ head: 'no pid' })]) {
    const f = crFixture();
    const { lock } = crPaths(f.root, 'feat/x');
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, body);
    const r = await runCodeRabbit(crOpts(f));
    assert.equal(r.status, 'PASS', body);
    assert.equal(f.calls.length, 1);
    assert.equal(existsSync(lock), false);
  }
});

test('L5: a lock older than the time limit plus 10 minutes is stale even when its pid is alive; a newer one blocks and its path is named', async () => {
  const old = crFixture();
  const lockOld = crPaths(old.root, 'feat/x').lock;
  mkdirSync(path.dirname(lockOld), { recursive: true });
  writeFileSync(lockOld, JSON.stringify({ pid: process.pid, head: 'old', at: new Date(old.now.getTime() - 41 * 60_000).toISOString() }));
  assert.equal((await runCodeRabbit(crOpts(old))).status, 'PASS', 'older than 30 + 10 minutes: replaced');
  const fresh = crFixture();
  const lockNew = crPaths(fresh.root, 'feat/x').lock;
  mkdirSync(path.dirname(lockNew), { recursive: true });
  writeFileSync(lockNew, JSON.stringify({ pid: process.pid, head: 'new', at: new Date(fresh.now.getTime() - 39 * 60_000).toISOString() }));
  const busy = await runCodeRabbit(crOpts(fresh));
  assert.equal(busy.status, 'FAIL');
  assert.ok(busy.detail.includes(lockNew), busy.detail);
  // The limit follows the time limit given: with a 5 minute limit a 16 minute old lock is stale.
  const short = crFixture();
  const lockShort = crPaths(short.root, 'feat/x').lock;
  mkdirSync(path.dirname(lockShort), { recursive: true });
  writeFileSync(lockShort, JSON.stringify({ pid: process.pid, head: 'x', at: new Date(short.now.getTime() - 16 * 60_000).toISOString() }));
  assert.equal((await runCodeRabbit(crOpts(short, { timeoutMs: 5 * 60_000 }))).status, 'PASS');
});

test('Q2: merging main into the branch keeps the run count and the cap; a rebase rewrites the first own commit and starts a new count', async () => {
  const repo = makeRepo();
  const f = crFixture();
  const run = (head) => runCodeRabbit({ root: repo.dir, branch: 'feat/x', head, base: 'main', now: f.now, runner: f.runner });
  await run('1'.repeat(40));
  await run('2'.repeat(40));
  const before = crPaths(repo.dir, 'feat/x');
  assert.equal(finishedRuns(repo.dir, 'feat/x'), 2);
  git(repo.dir, 'checkout', '-q', 'main');
  writeFileSync(path.join(repo.dir, 'later.txt'), 'later\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'main moved on');
  git(repo.dir, 'checkout', '-q', 'feat/x');
  git(repo.dir, 'merge', '-q', '--no-edit', 'main');
  assert.equal(crPaths(repo.dir, 'feat/x').counter, before.counter, 'a merge of main keeps the counter');
  assert.equal(crPaths(repo.dir, 'feat/x').lock, before.lock, 'and the lock');
  assert.equal(finishedRuns(repo.dir, 'feat/x'), 2);
  assert.equal((await run('3'.repeat(40))).skipReason, 'cap', 'the cap still holds after the merge');
  writeFileSync(path.join(repo.dir, 'more.txt'), 'more\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'more work');
  assert.equal(crPaths(repo.dir, 'feat/x').counter, before.counter, 'more own commits keep it too');
  // A side branch with a much older commit, merged in: the first-parent line decides, so the key does not move.
  const old = { ...process.env, GIT_AUTHOR_DATE: '2001-01-01T00:00:00', GIT_COMMITTER_DATE: '2001-01-01T00:00:00' };
  const gitOld = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo.dir, env: old, encoding: 'utf8', windowsHide: true });
  gitOld('checkout', '-q', '-b', 'side', 'feat/x~2');
  writeFileSync(path.join(repo.dir, 'side.txt'), 'side\n');
  gitOld('add', '.');
  gitOld('commit', '-q', '-m', 'old side work');
  gitOld('checkout', '-q', 'feat/x');
  gitOld('merge', '-q', '--no-edit', 'side');
  assert.equal(crPaths(repo.dir, 'feat/x').counter, before.counter, 'a merge of an older side branch keeps it too');
  git(repo.dir, 'rebase', '-q', 'main');
  assert.notEqual(crPaths(repo.dir, 'feat/x').counter, before.counter, 'a rebase rewrites the first own commit: a new count');
  assert.equal(finishedRuns(repo.dir, 'feat/x'), 0);
});

test('Q1: the run counter is keyed on the branch name and its first own commit: a reused branch name starts with an empty count', async () => {
  const repo = makeRepo();
  const f = crFixture();
  const run = (head) => runCodeRabbit({ root: repo.dir, branch: 'feat/x', head, base: 'main', now: f.now, runner: f.runner });
  await run('1'.repeat(40));
  await run('2'.repeat(40));
  const before = crPaths(repo.dir, 'feat/x').counter;
  assert.equal(finishedRuns(repo.dir, 'feat/x'), 2);
  assert.equal(crPaths(repo.dir, 'feat/x').counter, before, 'stable while the merge-base is the same');
  git(repo.dir, 'branch', 'feat/old', 'feat/x');
  const oldBefore = crPaths(repo.dir, 'feat/old').counter;
  git(repo.dir, 'checkout', '-q', 'main');
  writeFileSync(path.join(repo.dir, 'later.txt'), 'later\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'main moved on');
  git(repo.dir, 'branch', '-f', 'feat/x', 'main');
  assert.notEqual(crPaths(repo.dir, 'feat/x').counter, before);
  assert.equal(crPaths(repo.dir, 'feat/old').counter, oldBefore, 'the merge-base is the branch own, not the checked-out HEAD');
  assert.equal(finishedRuns(repo.dir, 'feat/x'), 0);
  assert.equal((await run('3'.repeat(40))).status, 'PASS', 'not capped by the old branch');
  assert.notEqual(crPaths(repo.dir, 'feat/other').counter, crPaths(repo.dir, 'feat/x').counter);
});

test('N7: a cli-missing SKIP prints a NOTE line and writes one guard-log row; other skips write none', async () => {
  const missing = (o) => (o.args[0] === 'usage' ? { status: null, stdout: '', stderr: '', error: 'spawn cr ENOENT', errorCode: 'ENOENT' } : { status: 0, stdout: NDJSON_OK, stderr: '' });
  const rows = [];
  const { result } = await prePr(makeRepo(), { crRunner: missing, guardLog: (row) => rows.push(row) });
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.ok(result.lines.some((l) => /^NOTE coderabbit:cli-missing - no CLI review ran/.test(l) && /ENOENT/.test(l)), result.lines.join('\n'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hook, 'pre-pr');
  assert.equal(rows[0].decision, 'cli-missing');
  assert.match(rows[0].reason, /ENOENT/);
  const quiet = [];
  await prePr(makeRepo(), { skipCr: true, guardLog: (row) => quiet.push(row) });
  await prePr(makeRepo(), { crRunner: (o) => (o.args[0] === 'usage' ? { status: 1, stdout: '', stderr: 'auth' } : { status: 0, stdout: NDJSON_OK, stderr: '' }), guardLog: (row) => quiet.push(row) });
  assert.equal(quiet.length, 0, 'flag and cli-error write no row');
});

test('N8: logCliMissing appends one JSON row to the file named by CCV3_GUARD_DECISIONS_LOG and never throws', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prepr-glog-'));
  const file = path.join(dir, 'sub', 'guard-decisions.jsonl');
  logCliMissing({ reason: 'cr is not installed (ENOENT)' }, { CCV3_GUARD_DECISIONS_LOG: file });
  logCliMissing({ reason: 'again' }, { CCV3_GUARD_DECISIONS_LOG: file });
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].hook, rows[0].decision, rows[0].tool], ['pre-pr', 'cli-missing', '']);
  assert.match(rows[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(rows[0].reason, /ENOENT/);
  // The log path sits under a plain file, so the folder cannot be made: the call must not throw.
  const plain = path.join(dir, 'plain-file');
  writeFileSync(plain, 'x');
  assert.doesNotThrow(() => logCliMissing({ reason: 'x' }, { CCV3_GUARD_DECISIONS_LOG: path.join(plain, 'g.jsonl') }));
});

test('L3: the lock is released when the runner throws', async () => {
  const f = crFixture();
  const boom = (opts) => { if (opts.args[0] === 'usage') return { status: 0, stdout: USAGE_OK, stderr: '' }; throw new Error('runner blew up'); };
  await assert.rejects(() => runCodeRabbit({ ...crOpts(f), runner: boom }), /runner blew up/);
  assert.equal(existsSync(crPaths(f.root, 'feat/x').lock), false);
});

test('L4: a skip, a reuse and a cap never leave a lock behind, and need none', async () => {
  const f = crFixture();
  await runCodeRabbit(crOpts(f, { skip: true }));
  await runCodeRabbit(crOpts(f));
  await runCodeRabbit(crOpts(f));
  await runCodeRabbit(crOpts(f, { head: '2'.repeat(40) }));
  const capped = await runCodeRabbit(crOpts(f, { head: '3'.repeat(40) }));
  assert.equal(capped.skipReason, 'cap');
  assert.equal(existsSync(crPaths(f.root, 'feat/x').lock), false);
});

test('W1: the counter and the lock live under the git common dir: every worktree of the repo shares them; a plain folder uses its own', async () => {
  const repo = makeRepo();
  const wt = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-wt-')), 'second');
  git(repo.dir, 'worktree', 'add', '-q', '-b', 'feat/y', wt);
  const primary = path.join(repo.dir, '.claude', 'cache', 'pre-pr');
  assert.ok(same(sharedPrDir(repo.dir), primary), sharedPrDir(repo.dir));
  assert.ok(same(sharedPrDir(wt), primary), sharedPrDir(wt));
  const f = crFixture();
  await runCodeRabbit({ root: wt, branch: 'feat/y', head: HEAD, base: 'main', now: f.now, runner: f.runner });
  assert.ok(same(path.dirname(crPaths(wt, 'feat/y').counter), primary));
  assert.equal(existsSync(crPaths(repo.dir, 'feat/y').counter), true, 'the primary checkout sees the run made in the worktree');
  assert.equal(existsSync(path.join(wt, '.claude', 'cache', 'pre-pr')), false, 'nothing is kept in the worktree itself');
  assert.equal(finishedRuns(repo.dir, 'feat/y'), 1);
  const plain = mkdtempSync(path.join(os.tmpdir(), 'prepr-plain-'));
  assert.ok(same(sharedPrDir(plain), path.join(plain, '.claude', 'cache', 'pre-pr')));
  // A subfolder of a repo is not the checkout root: it keeps its own folder, never the repo above it.
  mkdirSync(path.join(repo.dir, 'sub'), { recursive: true });
  assert.ok(same(sharedPrDir(path.join(repo.dir, 'sub')), path.join(repo.dir, 'sub', '.claude', 'cache', 'pre-pr')));
});

test('F1: finishedRuns counts only runs that finished with a PASS; a failed, incomplete or awaiting run does not', async () => {
  const f = crFixture();
  f.runner.next = { status: 1, stdout: '', stderr: 'crashed' };
  await runCodeRabbit(crOpts(f));
  assert.equal(finishedRuns(f.root, 'feat/x'), 0);
  f.runner.next = { status: 0, stdout: ev(CONTEXT, { ...DONE, outcome: 'failed' }), stderr: '' };
  await runCodeRabbit(crOpts(f, { head: '2'.repeat(40) }));
  assert.equal(JSON.parse(readFileSync(crPaths(f.root, 'feat/x').counter, 'utf8')).runs.length, 2);
  assert.equal(finishedRuns(f.root, 'feat/x'), 0, 'a complete event with outcome failed is not a finished review');
  const g = crFixture();
  await runCodeRabbit(crOpts(g));
  assert.equal(finishedRuns(g.root, 'feat/x'), 1, 'a PASS counts');
  assert.equal(finishedRuns(path.join(os.tmpdir(), 'prepr-never-here'), 'feat/x'), 0, 'no counter: 0');
});

test('X1: bad usage exits 2 and an internal error exits 3', () => {
  const run = (cwd, ...args) => spawnSync(process.execPath, [path.join(HERE, 'pre-pr.mjs'), ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(run(os.tmpdir()).status, 2);
  // A git checkout with no review-router.config.json: the config read throws inside the run.
  const repo = makeRepo();
  const body = path.join(repo.dir, '..', `body-${Date.now()}.md`);
  writeFileSync(body, 'Proof type: docs\n');
  const r = run(repo.dir, '--body', body, '--skip-cr');
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /stopped by an error/);
});

// The built hook, fed a stamp that pre-pr.mjs really wrote.
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'dist', 'pre-pr-gate.mjs');
function hookVerdict(repoDir, command = 'gh pr create --fill') {
  const log = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-hooklog-')), 'g.jsonl');
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repoDir, session_id: 't' }), encoding: 'utf8', windowsHide: true, env: { ...process.env, CCV3_GUARD_DECISIONS_LOG: log, SKIP_PRE_PR_GATE: '' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() === '{}' ? { allow: true } : { allow: false, reason: JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason };
}
const withFork = (repo) => { git(repo.dir, 'remote', 'add', 'fork', 'https://github.com/Rev4nchist/Continuous-Claude-v3.git'); return repo; };

test('B1: a stamp written by --skip-cr records reason flag, and the built hook denies it', async () => {
  const repo = withFork(makeRepo());
  const { result } = await prePr(repo, { skipCr: true });
  assert.equal(result.ok, true, result.lines.join('\n'));
  const stamp = JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8'));
  assert.equal(stamp.cr_skipped, true);
  assert.equal(stamp.cr_skip_reason, 'flag');
  const v = hookVerdict(repo.dir);
  assert.equal(v.allow, false);
  assert.match(v.reason, /skipped the CodeRabbit CLI review/);
  assert.match(v.reason, /flag/);
});

test('B2: the same run with the cap reached, or a known rate-limit wait, or no CLI, is allowed by the built hook; a review that ran is allowed', async () => {
  const capped = withFork(makeRepo());
  const spent = { root: capped.dir, branch: 'feat/x', base: 'main', now: new Date('2026-10-27T09:00:00Z'), runner: (o) => ({ status: 0, stdout: o.args[0] === 'usage' ? USAGE_OK : NDJSON_OK, stderr: '' }) };
  await runCodeRabbit({ ...spent, head: '1'.repeat(40) });
  await runCodeRabbit({ ...spent, head: '2'.repeat(40) });
  assert.equal((await prePr(capped)).result.ok, true);
  const capStamp = JSON.parse(readFileSync(path.join(capped.dir, STAMP_REL), 'utf8'));
  assert.equal(capStamp.cr_skip_reason, 'cap');
  assert.equal(capStamp.cr_finished_runs, 2);
  assert.equal(hookVerdict(capped.dir).allow, true);

  const limited = withFork(makeRepo());
  const lim = await prePr(limited, { crRunner: (o) => (o.args[0] === 'usage' ? { status: 0, stdout: ev({ type: 'usage', remaining: 0, fullCapacityInMs: 720000 }), stderr: '' } : { status: 0, stdout: NDJSON_OK, stderr: '' }) });
  assert.equal(lim.result.ok, true, lim.result.lines.join('\n'));
  const stamp = JSON.parse(readFileSync(path.join(limited.dir, STAMP_REL), 'utf8'));
  assert.equal(stamp.cr_skip_reason, 'rate-limited');
  assert.equal(stamp.cr_retry_minutes, 12);
  assert.equal(hookVerdict(limited.dir).allow, true);

  const gone = withFork(makeRepo());
  assert.equal((await prePr(gone, { crRunner: (o) => (o.args[0] === 'usage' ? { status: null, stdout: '', stderr: '', error: 'spawn cr ENOENT', errorCode: 'ENOENT' } : NDJSON_OK) })).result.ok, true);
  assert.equal(JSON.parse(readFileSync(path.join(gone.dir, STAMP_REL), 'utf8')).cr_skip_reason, 'cli-missing');
  assert.equal(hookVerdict(gone.dir).allow, true);

  const ran = withFork(makeRepo());
  assert.equal((await prePr(ran)).result.ok, true);
  assert.equal(JSON.parse(readFileSync(path.join(ran.dir, STAMP_REL), 'utf8')).cr_skipped, false);
  assert.equal(hookVerdict(ran.dir).allow, true);
});

test('B3: a no-changes SKIP is stamped with reason no-changes and the built hook denies it', async () => {
  const repo = withFork(makeRepo());
  const empty = ev(CONTEXT, { type: 'complete', status: 'review_skipped', findings: 0, message: 'No changes detected' });
  const { result } = await prePr(repo, { crRunner: (o) => (o.args[0] === 'usage' ? { status: 0, stdout: USAGE_OK, stderr: '' } : { status: 0, stdout: empty, stderr: '' }) });
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.equal(JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8')).cr_skip_reason, 'no-changes');
  assert.equal(hookVerdict(repo.dir).allow, false);
});

// ---------- runPrePr: real git, fake runners ----------

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo({ files = { 'docs/a.md': 'hello\n' } } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prepr-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.gitignore'), '.claude/cache/\n');
  writeFileSync(path.join(dir, 'README.md'), 'root\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  if (Object.keys(files).length > 0) {
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'work');
  }
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

const okExec = (log) => (spec) => { log.push(spec.id ?? spec.args.join(' ')); return { status: 0, stdout: 'ran\nTests  1 passed (1)\n', stderr: '' }; };

async function prePr(repo, extra = {}) {
  const gateRuns = [];
  const crCalls = [];
  const opts = {
    root: repo.dir, base: 'main', config: CONFIG, now: new Date('2026-10-27T10:00:00Z'),
    exec: okExec(gateRuns), crRunner: (o) => { if (o.args[0] === 'usage') return { status: 0, stdout: USAGE_OK, stderr: '' }; crCalls.push(o); return { status: 0, stdout: NDJSON_OK, stderr: '' }; },
    guardLog: () => {},
    bodyText: 'Proof type: docs\n', ...extra,
  };
  return { result: await runPrePr(opts), gateRuns, crCalls };
}

test('R1: a full pass writes a stamp (head, branch, at, body hash, results), the log, and leaves the tree clean', async () => {
  const repo = makeRepo();
  const { result, gateRuns, crCalls } = (await prePr(repo));
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.equal(crCalls.length, 1);
  assert.deepEqual(gateRuns, ['context-budget']);
  const stampPath = path.join(repo.dir, STAMP_REL);
  const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
  assert.equal(stamp.head, repo.head);
  assert.equal(stamp.branch, 'feat/x');
  assert.equal(stamp.at, '2026-10-27T10:00:00.000Z');
  assert.equal(stamp.body_sha256, createHash('sha256').update('Proof type: docs\n').digest('hex'));
  assert.equal(stamp.cr_skipped, false);
  assert.equal(stamp.cr_skip_reason, null);
  assert.ok(Array.isArray(stamp.results) && stamp.results.length >= 6);
  assert.ok(stamp.results.every((x) => x.status !== 'FAIL'));
  const log = readFileSync(result.logPath, 'utf8');
  assert.match(log, /PASS/);
  assert.match(path.basename(result.logPath), new RegExp(`^2026-10-27-pre-pr-${repo.head.slice(0, 7)}\\.log$`));
  assert.equal(git(repo.dir, 'status', '--porcelain'), '', 'the stamp, counter and logs are ignored');
  // Every line is one PASS / FAIL / SKIP / NOTE line.
  assert.ok(result.lines.every((l) => /^(PASS|FAIL|SKIP|NOTE)\s|^\s/.test(l)), result.lines.join('\n'));
});

test('R2: a failing step writes no stamp, deletes an old one, and does not run the CLI review', async () => {
  const repo = makeRepo();
  const first = (await prePr(repo));
  assert.equal(first.result.ok, true);
  assert.ok(existsSync(path.join(repo.dir, STAMP_REL)));
  writeFileSync(path.join(repo.dir, 'untracked.txt'), 'x');
  const second = (await prePr(repo));
  assert.equal(second.result.ok, false);
  assert.equal(existsSync(path.join(repo.dir, STAMP_REL)), false, 'old stamp removed');
  assert.equal(second.crCalls.length, 0, 'no review slot spent');
  assert.ok(second.result.lines.some((l) => /^FAIL git:clean/.test(l)), second.result.lines.join('\n'));
  assert.ok(second.result.lines.some((l) => /^SKIP coderabbit/.test(l)), second.result.lines.join('\n'));
});

test('R2b: a failing gate fails the run, and the gate summary is in its line', async () => {
  const repo = makeRepo();
  const { result, crCalls } = (await prePr(repo, { exec: () => ({ status: 1, stdout: 'bad\n# fail 2\n', stderr: '' }) }));
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => /^FAIL gate:context-budget.*# fail 2/.test(l)), result.lines.join('\n'));
  assert.equal(crCalls.length, 0);
});

test('R2c: a gate that times out is a FAIL that says so', async () => {
  const repo = makeRepo();
  const { result } = (await prePr(repo, { exec: () => ({ status: null, stdout: '', stderr: '', timedOut: true }) }));
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => /^FAIL gate:context-budget.*timed out/i.test(l)), result.lines.join('\n'));
});

test('R2d: the dist post-check fails the build gate when the build leaves dist changed', async () => {
  const repo = makeRepo({ files: { '.claude/hooks/src/a.ts': 'export {}\n', '.claude/hooks/dist/a.mjs': 'x\n' } });
  const body = `## Evidence\n\nProof type: harness\n\nRED: \`x\` @ ${'b'.repeat(40)}\n\`\`\`text\nred\n\`\`\`\n\nGREEN: \`x\` @ ${repo.head}\n\`\`\`text\ngreen\n\`\`\`\n`;
  const exec = (spec) => {
    if (spec.id === 'hooks-build') writeFileSync(path.join(repo.dir, '.claude/hooks/dist/a.mjs'), 'changed\n');
    return { status: 0, stdout: 'ok\n', stderr: '' };
  };
  const { result } = (await prePr(repo, { exec, bodyText: body, skipCr: true }));
  assert.ok(result.lines.some((l) => /^FAIL gate:hooks-build.*dist/i.test(l)), result.lines.join('\n'));
  assert.equal(result.ok, false);
});

test('R2h: the dist post-check also fails when the build adds a new dist file, and passes when the build changes nothing', async () => {
  const repo = makeRepo({ files: { '.claude/hooks/src/a.ts': 'export {}\n', '.claude/hooks/dist/a.mjs': 'x\n' } });
  const body = `## Evidence\n\nProof type: harness\n\nRED: \`x\` @ ${'b'.repeat(40)}\n\`\`\`text\nred\n\`\`\`\n\nGREEN: \`x\` @ ${repo.head}\n\`\`\`text\ngreen\n\`\`\`\n`;
  const added = (spec) => {
    if (spec.id === 'hooks-build') writeFileSync(path.join(repo.dir, '.claude/hooks/dist/new.mjs'), 'new\n');
    return { status: 0, stdout: 'ok\n', stderr: '' };
  };
  assert.ok((await prePr(repo, { exec: added, bodyText: body, skipCr: true })).result.lines.some((l) => /^FAIL gate:hooks-build.*dist/i.test(l)));
  const fresh = makeRepo({ files: { '.claude/hooks/src/a.ts': 'export {}\n', '.claude/hooks/dist/a.mjs': 'x\n' } });
  const body2 = body.replaceAll(repo.head, fresh.head);
  const same = (await prePr(fresh, { bodyText: body2, skipCr: true }));
  assert.ok(same.result.lines.some((l) => /^PASS gate:hooks-build/.test(l)), same.result.lines.join('\n'));
});

test('R2i: a failing post-check command fails the gate: an unreadable dist is not "clean"', async () => {
  const repo = makeRepo({ files: { '.claude/hooks/src/a.ts': 'export {}\n', '.claude/hooks/dist/a.mjs': 'x\n' } });
  const body = `## Evidence\n\nProof type: harness\n\nRED: \`x\` @ ${'b'.repeat(40)}\n\`\`\`text\nred\n\`\`\`\n\nGREEN: \`x\` @ ${repo.head}\n\`\`\`text\ngreen\n\`\`\`\n`;
  const real = makeGit(repo.dir);
  const broken = (args) => (args[0] === 'diff' && args.includes('.claude/hooks/dist') ? { status: 128, stdout: '', stderr: 'fatal' } : real(args));
  const { result } = (await prePr(repo, { git: broken, bodyText: body, skipCr: true }));
  assert.ok(result.lines.some((l) => /^FAIL gate:hooks-build/.test(l)), result.lines.join('\n'));
});

test('R6: the review time limit reaches the CLI runner (default 30 min, or the value given)', async () => {
  const a = await prePr(makeRepo());
  assert.equal(a.crCalls[0].timeoutMs, 30 * 60_000);
  const b = await prePr(makeRepo(), { crTimeout: 7 * 60_000 });
  assert.equal(b.crCalls[0].timeoutMs, 7 * 60_000);
});

test('R2e: --skip-cr passes the run, says SKIP on the CLI line, and records it in the stamp', async () => {
  const repo = makeRepo();
  const { result, crCalls } = (await prePr(repo, { skipCr: true }));
  assert.equal(result.ok, true);
  assert.equal(crCalls.length, 0);
  const stamp = JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8'));
  assert.equal(stamp.results.find((x) => x.step === 'coderabbit').status, 'SKIP');
  assert.equal(stamp.cr_skipped, true);
  assert.equal(stamp.cr_skip_reason, 'flag');
});

test('R4: with both CLI runs of the branch used, the CLI step is a SKIP (cap), the run passes, and the stamp says cap', async () => {
  const repo = makeRepo();
  const spent = { root: repo.dir, branch: 'feat/x', base: 'main', now: new Date('2026-10-27T09:00:00Z'), runner: () => ({ status: 0, stdout: 'done\n', stderr: '' }) };
  (await runCodeRabbit({ ...spent, head: '1'.repeat(40) }));
  (await runCodeRabbit({ ...spent, head: '2'.repeat(40) }));
  const { result, crCalls } = (await prePr(repo));
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.equal(crCalls.length, 0);
  assert.ok(result.lines.some((l) => /^SKIP coderabbit.*limit/.test(l)), result.lines.join('\n'));
  const stamp = JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8'));
  assert.equal(stamp.cr_skipped, true);
  assert.equal(stamp.cr_skip_reason, 'cap');
});

test('R5: a changed file no surface owns gets its own NOTE line in the run, and the run still passes', async () => {
  const repo = makeRepo({ files: { 'misc/x.dat': 'x\n' } });
  const body = featureBody(repo.head);
  const { result } = (await prePr(repo, { bodyText: body, skipCr: true }));
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.ok(result.lines.some((l) => l.startsWith('NOTE unowned:misc/x.dat')), result.lines.join('\n'));
});

test('G6: a fork/<base> ref that is ahead of HEAD fails the behind check; one that is not does not', async () => {
  const ahead = checkGit(fakeGit({ ...GOOD, 'rev-parse --verify --quiet refs/remotes/fork/main': `${HEAD}\n`, 'rev-list --count HEAD..refs/remotes/fork/main': '2\n' }), 'main');
  assert.equal(ahead[2].status, 'FAIL');
  assert.match(ahead[2].detail, /fork\/main/);
  assert.match(ahead[2].detail, /2 commit/);
  const level = checkGit(fakeGit({ ...GOOD, 'rev-parse --verify --quiet refs/remotes/fork/main': `${HEAD}\n`, 'rev-list --count HEAD..refs/remotes/fork/main': '0\n' }), 'main');
  assert.equal(level[2].status, 'PASS');
  assert.match(level[2].detail, /0 commits behind main and fork\/main/);
  // No fork ref: only the local base counts, and the detail does not claim a fork check.
  assert.doesNotMatch(checkGit(fakeGit(GOOD), 'main')[2].detail, /fork\/main/);
  const bad = checkGit(fakeGit({ ...GOOD, 'rev-parse --verify --quiet refs/remotes/fork/main': `${HEAD}\n`, 'rev-list --count HEAD..refs/remotes/fork/main': 'oops\n' }), 'main');
  assert.equal(bad[2].status, 'FAIL');
});

test('G7: the same check against real git: a fork/main commit HEAD lacks fails, no fetch needed', async () => {
  const repo = makeRepo();
  assert.equal(checkGit(makeGit(repo.dir), 'main')[2].status, 'PASS');
  const ahead = git(repo.dir, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'ahead');
  git(repo.dir, 'update-ref', 'refs/remotes/fork/main', ahead);
  const r = checkGit(makeGit(repo.dir), 'main')[2];
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /1 commit/);
});

test('R2f: a dirty tree is the only FAIL when the rest is fine, and every other step still reports', async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo.dir, 'README.md'), 'edited\n');
  const { result } = (await prePr(repo, { skipCr: true }));
  const fails = result.lines.filter((l) => l.startsWith('FAIL'));
  assert.equal(fails.length, 1, result.lines.join('\n'));
  assert.ok(result.lines.some((l) => l.startsWith('PASS git:branch')));
  assert.ok(result.lines.some((l) => l.startsWith('PASS evidence')));
});

test('R2g: a branch with no change against main fails the changes step', async () => {
  const repo = makeRepo({ files: {} });
  git(repo.dir, 'commit', '-q', '--allow-empty', '-m', 'empty');
  const { result, crCalls } = (await prePr(repo, { skipCr: true }));
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => /^FAIL changes/.test(l)), result.lines.join('\n'));
  assert.equal(crCalls.length, 0);
});

test('R3: the CLI without --body exits 2 and prints usage; --help exits 0', async () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(HERE, 'pre-pr.mjs'), ...args], { encoding: 'utf8', windowsHide: true });
  const none = run();
  assert.equal(none.status, 2);
  assert.match(none.stderr, /usage/i);
  const missing = run('--body', path.join(os.tmpdir(), 'does-not-exist-prepr.md'), '--skip-cr');
  assert.equal(missing.status, 2, 'an unreadable body stops before any gate runs');
  assert.match(missing.stderr, /body/i);
});

// ---------- defects found by the first real run (2026-10-28) ----------

const gateById = (id) => SURFACES.flatMap((s) => s.gates ?? []).find((g) => g.id === id);
const execOut = (status, stdout) => () => ({ status, stdout, stderr: '', timedOut: false });
const MODS_SUMMARY = (tail) => `mods FAIL: validate OK (8 gating hooks, 0 without .catch) | tsc NOT RUN | ${tail}`;

test('RR1: the github-tests gate allows the 14-minute suite (timeout at least 20 min)', () => {
  assert.ok(gateById('github-tests').timeoutMs >= 20 * 60_000, `timeout ${gateById('github-tests').timeoutMs} ms`);
});

test('RR2: the hooks-vitest gate retries a test that fails only under load', () => {
  assert.ok(gateById('hooks-vitest').args.some((a) => /^--retry=[1-9]$/.test(a)), gateById('hooks-vitest').args.join(' '));
});

test('RR7: the behind FAIL says to merge the base in, and that a rebase starts a new CodeRabbit CLI run count', () => {
  const r = checkGit(fakeGit({ ...GOOD, 'rev-list --count HEAD..main': '3\n' }), 'main');
  assert.equal(r[2].status, 'FAIL');
  assert.match(r[2].detail, /merge main in/);
  assert.doesNotMatch(r[2].detail, /merge or rebase/);
  assert.match(r[2].detail, /rebase .*new CodeRabbit CLI run count/);
});

test('RR6: the hooks-vitest gate gives each test at least 20 s (dist-integration tests spawn node under load)', () => {
  const t = gateById('hooks-vitest').args.map((a) => /^--testTimeout=(\d+)$/.exec(a)).find(Boolean);
  assert.ok(t && Number(t[1]) >= 20_000, gateById('hooks-vitest').args.join(' '));
});

test('RR3: mods-validate PASSes with a NOTE when only the typecheck could not run', () => {
  const r = runGate(gateById('mods-validate'), { root: REPO_ROOT, exec: execOut(1, MODS_SUMMARY('test 215 pass 0 fail')), git: fakeGit({}) });
  assert.equal(r.status, 'PASS');
  assert.match(r.detail, /tsc NOT RUN/);
  assert.match(r.detail, /no \.claude-plugin\/types/);
});

test('RR4: mods-validate still FAILs on a failing mod test, a failed validate, or any other exit', () => {
  const cases = [
    MODS_SUMMARY('test 214 pass 1 fail'),
    'mods FAIL: validate FAIL (0 gating hooks) | tsc NOT RUN | test 215 pass 0 fail',
    'mods FAIL: validate OK (8 gating hooks, 0 without .catch) | tsc FAIL (3 errors) | test 215 pass 0 fail',
    'something else broke',
  ];
  for (const out of cases) {
    const r = runGate(gateById('mods-validate'), { root: REPO_ROOT, exec: execOut(1, out), git: fakeGit({}) });
    assert.equal(r.status, 'FAIL', out);
  }
});

test('RR5: the tsc-not-run allowance is mods-validate only; another gate with the same text still FAILs', () => {
  const r = runGate(gateById('github-tests'), { root: REPO_ROOT, exec: execOut(1, MODS_SUMMARY('test 215 pass 0 fail')), git: fakeGit({}) });
  assert.equal(r.status, 'FAIL');
});
