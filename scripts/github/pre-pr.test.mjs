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
//   - the coordination gates go back to gates: [] or drift from CI job coordination-db -> CO1
//   - a glob gate misses a test file (no ** for a subfolder, one file named for a folder) -> TG1, TG2
//   - scripts/eval/review-eval has no gate, or a path there is unowned          -> TG3
//   - CI job ratchets drifts from a gate glob, or runs it unquoted (bash drops files) -> TG4
//   - lane-context.ts or its db test changes and the scratch-database gate does not run, or CI drops it -> TG5, TG6
//   - a test:scripts-only folder changes and the Windows gate test-scripts does not run, or it runs for other folders  -> WS1
//   - the test-scripts constant names a file that is gone or not in test:scripts, or names one twice              -> WS2
//   - a new test:scripts name is in no gate (neither the constant nor a CI step)                                     -> WS3
//   - the dead trex-tests gate comes back, or the trex surface loses its manual note                                 -> GW4b
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
// CLI spend log and daily cap (Dave, 2026-11-02; the CLI bills usage credits past the free hour with no prompt)
//   usageCost is parsed wrongly, or a malformed one (text, zero, negative) counts as a charge     -> P1
//   a free run (no usageCost) writes a ledger row                                                   -> P2
//   a billed run writes no cli row, a wrong one, or no cost line in the step output                 -> P3
//   a billed run that FAILs (outcome failed) is not logged, or a log error stops the step           -> P4
//   the cap is reached and the run still starts (usage or review), or the skip names no numbers     -> P5
//   under the cap the run is blocked; no cap configured reads the ledger anyway                      -> P6
//   an unreadable ledger with a cap lets the run go on                                              -> P7
//   runPrePr ignores the config key, stamps another reason, or the built hook denies the cli-cap skip -> P8
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
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, readdirSync, rmSync, utimesSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as PRE from './pre-pr.mjs';
import { BAND_SET_FILES, REVIEWER_SET_DIR, REVIEWER_SET_FILES } from '../eval/review-eval/engine-version.mjs';
import { REGISTRY } from '../checks/parser-fixtures/registry.mjs';
import { MARKER } from './lib/pssa-advisory.mjs';
import { cliCapOf } from './cr-paid.mjs';
import { envStep } from './lib/env-step.mjs';
import {
  SURFACES, ALWAYS_GATES, CATCHER_PARSER_FILES, BASE_TOKEN, withBase, CR_ARGS, CR_RUN_LIMIT, STAMP_REL, gatesFor, summaryLine, checkGit, checkEvidence,
  runCodeRabbit as runCodeRabbitLive, runPrePr as runPrePrLive, assertSafeCrArgs, changedFiles, makeGit, notesFor,
  parseAgentStream, parseUsage, usageCostOf, crTimeoutMs, defaultCrRunner, CR_USAGE_ARGS,
  killTree, sharedPrDir, crPaths, finishedRuns, logCliMissing, crTimeoutProblem, runGate, resolveSpawn, acquireLock,
} from './pre-pr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CONFIG = JSON.parse(readFileSync(path.join(REPO_ROOT, 'review-router.config.json'), 'utf8'));
const REVIEW_MD = readFileSync(path.join(REPO_ROOT, 'REVIEW.md'), 'utf8');
// Never read or write Dave's real paid ledger: every run here that could touch it gets a temp one.
// Safety net: a run that forgets gateLogPath still writes to a temp file, never to Dave's real pre-pr-gates.jsonl.
process.env.PRE_PR_GATE_LOG = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-gatelog-env-')), 'pre-pr-gates.jsonl');
// Same net for the run lock: a spawned pre-pr.mjs (X1, R3) takes the lock and logs START to runs.jsonl. It must reach a temp store, never
// the live ~/.claude/state/run-locks (seat finding 14:30 CST 11-18: X1 children left START rows there). Children inherit process.env.
process.env.RUN_LOCK_DIR = mkdtempSync(path.join(os.tmpdir(), 'prepr-runlock-env-'));
// O1: a child run takes the lock with its three samples at once (hook at run-lock.mjs, works only with a temp RUN_LOCK_DIR): no real 6 s + 30 s + 6 s
// machine read per spawn. The children here check exit codes and START and END rows, never the samples.
const LOCK_SAMPLES_ENV = { ...process.env, RUN_LOCK_TEST_SAMPLES: JSON.stringify({ free: [8, 8, 8], load: [10, 10, 10] }) };
const tempLedger = () =>path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-ledger-')), 'coderabbit-paid.jsonl');

const HEAD = 'a'.repeat(40);

// No test reads Dave's real CodeRabbit store (%LOCALAPPDATA%\coderabbit\reviews): every call goes in with crStore null (off) unless a test
// passes its own temp store. The step 2c tests (T0..T8) pass one on purpose.
// The answer-key guard reads REVIEW.md in the root and a both-sides path list. Tests that pass no list get a clean one; a test that passes
// changedPaths (or its own guardPaths) is checked on that list.
const CLEAN_PATHS = ['src/clean.mjs'];
// The CLI reads a PINNED base commit (card prflow-prepr-speed): a unit call with no repo gets this id.
const BASE40 = 'b'.repeat(40);
const runCodeRabbit = (o) => runCodeRabbitLive({ crStore: null, baseCommit: BASE40, ...(o.changedPaths === undefined && !('guardPaths' in o) ? { guardPaths: CLEAN_PATHS } : {}), ...o });
const runPrePr = (o) => runPrePrLive({ crStore: null, ...o });

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
      // The folder is the part before the first wildcard segment, so `scripts/github/local-review/**/*.test.mjs` is checked in scripts/github/local-review.
      const glob = g.args.find((x) => x.includes('*'));
      const dir = path.join(cwd, glob.split('/').slice(0, glob.split('/').findIndex((seg) => seg.includes('*'))).join('/'));
      assert.ok(readdirSync(dir, { recursive: glob.includes('**') }).some((n) => /\.test\.mjs$/.test(n)), `${g.id}: the glob matches no test file`);
    }
  }
});

test('S2: hooks source runs tsc, the build with a dist check, vitest, the Semgrep pack and the always gate', async () => {
  const got = gatesFor(['.claude/hooks/src/pre-pr-gate.ts'], REPO_ROOT);
  assert.deepEqual(ids(got).sort(), ['context-budget', 'hooks-build', 'hooks-tsc', 'hooks-vitest', 'semgrep-ccv3']);
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

test('CO1: a scripts/coordination change runs the same coordination test files as the CI job coordination-db', async () => {
  // Breaks when the row goes back to gates: [] (two render-board tests sat red on main, PR 312) or drifts from CI.
  const wf = readFileSync(path.join(REPO_ROOT, '.github/workflows/ccv3-checks.yml'), 'utf8');
  const start = wf.indexOf('\n  coordination-db:');
  assert.ok(start >= 0, 'the workflow has the coordination-db job');
  const rest = wf.slice(start + 1);
  const next = rest.slice(1).search(/\n  [\w-]+:/);
  const job = (next < 0 ? rest : rest.slice(0, next + 1)).split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n'); // drop YAML and shell comments
  const ci = [...job.matchAll(/scripts\/coordination\/[\w-]+\.test\.mjs/g)].map((m) => m[0]);
  assert.ok(ci.length > 0, 'the CI job lists coordination test files');
  for (const p of ['scripts/coordination/lane.mjs', 'scripts/coordination/render-board.test.mjs', '.claude/scripts/lane.mjs', 'docker/init-schema.sql', 'apps/agentic-os/drizzle/0004_x.sql']) {
    const got = gatesFor([p], REPO_ROOT).filter((g) => g.id.startsWith('coordination-'));
    assert.deepEqual(got.map((g) => g.id).sort(), ['coordination-db-tests', 'coordination-tests'], p);
    for (const g of got) assert.equal(g.args[0], '--test', g.id);
    const files = got.flatMap((g) => g.args.slice(1));
    assert.deepEqual([...files].sort(), [...new Set(ci)].sort(), `${p}: same files as CI`);
    for (const f of files) assert.ok(existsSync(path.join(REPO_ROOT, f)), f);
  }
  assert.equal(ids(gatesFor(['docs/x.md'], REPO_ROOT)).some((id) => id.startsWith('coordination-')), false);
});

test('CO2: reminder-sync.test.mjs runs in the pre-pr coordination-tests gate and in a CI step of job coordination-db (no gate ran it before)', async () => {
  // Breaks when the file leaves COORDINATION_TESTS, or when no step of the CI job names it. CO1 cannot see this: it compares the two lists with each other.
  const file = 'scripts/coordination/reminder-sync.test.mjs';
  assert.ok(existsSync(path.join(REPO_ROOT, file)), file);
  const g = gatesFor(['scripts/coordination/reminder-sync.mjs'], REPO_ROOT).find((x) => x.id === 'coordination-tests');
  assert.ok(g, 'a reminder-sync.mjs change plans coordination-tests');
  assert.ok(g.args.includes(file), `coordination-tests args hold ${file}`);
  const wf = readFileSync(path.join(REPO_ROOT, '.github/workflows/ccv3-checks.yml'), 'utf8');
  const start = wf.indexOf('\n  coordination-db:');
  assert.ok(start >= 0, 'the workflow has the coordination-db job');
  const rest = wf.slice(start + 1);
  const next = rest.slice(1).search(/\n  [\w-]+:/);
  const job = (next < 0 ? rest : rest.slice(0, next + 1)).split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
  assert.ok(job.includes(file), `a step of CI job coordination-db runs ${file}`);
});

// ---------- dependency routing: a path that feeds a gate selects it, even when the diff never touches that gate's own folder ----------

test('GR1: a hooks dependency (store link script, hooks package files, tsconfig, any workflow) runs hooks-tsc, hooks-build and hooks-vitest (#352 shipped a stale dist because none ran)', async () => {
  for (const p of ['scripts/worktree/shared-deps.mjs', '.claude/hooks/package-lock.json', '.claude/hooks/tsconfig.json', '.claude/hooks/tsconfig.build.json', '.github/workflows/gitleaks.yml', '.github/workflows/ccv3-checks.yml']) {
    const got = ids(gatesFor([p], REPO_ROOT));
    assert.ok(got.includes('hooks-build'), `${p} -> hooks-build`);
    assert.ok(got.includes('hooks-vitest'), `${p} -> hooks-vitest`);
    assert.ok(got.includes('hooks-tsc'), `${p} -> hooks-tsc`);
  }
});

test('TS1: hooks-tsc type-checks .claude/hooks with tsc --noEmit, runs before hooks-build, and no other surface plans it', async () => {
  const got = gatesFor(['.claude/hooks/src/pre-pr-gate.ts'], REPO_ROOT);
  const tsc = got.find((g) => g.id === 'hooks-tsc');
  assert.ok(tsc, 'a hooks change plans hooks-tsc');
  assert.ok(['npx', 'node'].includes(tsc.cmd), tsc.cmd);
  assert.ok(tsc.args.includes('tsc') && tsc.args.includes('--noEmit'), tsc.args.join(' '));
  assert.equal(tsc.cwd, '.claude/hooks');
  assert.ok(tsc.timeoutMs >= 5 * 60_000, 'tsc 7 is fast, but a cold busy machine gets the same 5 min as the build');
  assert.ok(ids(got).indexOf('hooks-tsc') < ids(got).indexOf('hooks-build'), 'tsc fails fast, before the build');
  const owners = SURFACES.filter((s) => (s.gates ?? []).some((g) => g.id === 'hooks-tsc')).map((s) => s.id);
  assert.deepEqual(owners, ['hooks']);
  for (const p of ['scripts/other.mjs', '.claude/rules-src/x.md', 'docs/a.md', 'opc/src/x.py', '.claude/skills/tdd/SKILL.md']) {
    assert.equal(ids(gatesFor([p], REPO_ROOT)).includes('hooks-tsc'), false, p);
  }
});

test('GR2: a scripts/coordination or pre-pr.mjs change runs github-tests (CI github-tests caught a drift pre-pr never ran in #343)', async () => {
  for (const p of ['scripts/coordination/lane.mjs', 'scripts/coordination/render-board.test.mjs', 'scripts/github/pre-pr.mjs']) {
    const g = gatesFor([p], REPO_ROOT).find((x) => x.id === 'github-tests');
    assert.ok(g, `${p} -> github-tests`);
    assert.deepEqual(g.args, ['--test', 'scripts/github/*.test.mjs']);
  }
  // The coordination gates still run for scripts/coordination.
  assert.ok(ids(gatesFor(['scripts/coordination/lane.mjs'], REPO_ROOT)).includes('coordination-tests'));
});

test('GR3: a docs-only diff selects no surface gate, and a hooks dependency glob does not catch Markdown beside it', async () => {
  assert.deepEqual(ids(gatesFor(['docs/x.md', 'README.md', 'docs/architecture/a.md'], REPO_ROOT)), ['context-budget']);
  for (const p of ['.claude/hooks/CONFIG.md', '.github/workflows/README.md']) {
    assert.deepEqual(ids(gatesFor(['docs/x.md', p], REPO_ROOT)), ['context-budget'], p);
  }
  // scripts/worktree/README.md is owned by worktree-scripts (its own test gate), but it must not pull in the hooks build.
  assert.equal(ids(gatesFor(['scripts/worktree/README.md'], REPO_ROOT)).some((i) => i.startsWith('hooks-')), false);
});

test('GR4: no gate id appears twice when one diff reaches the same gate through two surfaces', async () => {
  const sets = [
    ['scripts/coordination/lane.mjs', 'scripts/github/pre-pr.mjs', 'scripts/github/lib/proc.mjs'],
    ['scripts/worktree/shared-deps.mjs', '.claude/hooks/src/a.ts', '.claude/hooks/package.json', '.github/workflows/ccv3-checks.yml', '.claude/hooks/tsconfig.json'],
    SURFACES.flatMap((s) => s.globs.filter((g) => !/[*?]/.test(g))),
  ];
  for (const set of sets) {
    const got = ids(gatesFor(set, REPO_ROOT));
    assert.ok(got.length > 1, 'the set selects gates');
    assert.deepEqual(got, [...new Set(got)], `duplicate gate id in: ${got.join(', ')}`);
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

// ---------- PR B gates: Semgrep pack, scrubber grid, checks helpers ----------

test('GW1: a change to the scrubber source runs the scrub-invariant gate on the pure Playwright config', async () => {
  for (const p of ['apps/agentic-os/src/server/sources/safe-message.ts', 'apps/agentic-os/e2e/safe-message-invariant.spec.ts', 'apps/agentic-os/playwright.pure.config.ts']) {
    const g = gatesFor([p], REPO_ROOT).find((x) => x.id === 'scrub-invariant');
    assert.ok(g, p);
    assert.equal(g.cmd, 'node');
    assert.deepEqual(g.args, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'apps/agentic-os/playwright.pure.config.ts', '--reporter=line']);
    assert.ok(existsSync(path.join(REPO_ROOT, g.args[3])), 'the pure config named by the gate exists');
  }
});

test('GW2: a script or hook change runs the semgrep-ccv3 gate', async () => {
  for (const p of ['scripts/github/review-status.mjs', '.claude/plugins/ccv3-mods/hooks/pr-loop/model.ts', '.claude/hooks/src/pre-pr-gate.ts']) {
    const g = gatesFor([p], REPO_ROOT).find((x) => x.id === 'semgrep-ccv3');
    assert.ok(g, p);
    assert.deepEqual(g.args, ['scripts/ratchets/semgrep-ccv3.mjs']);
    assert.equal(g.acceptExit, undefined, 'no accepted non-zero exit: Docker down must FAIL');
  }
});

test('GW3: a docs-only change does not need Docker, so it holds no semgrep-ccv3 gate', async () => {
  assert.equal(ids(gatesFor(['docs/x.md'], REPO_ROOT)).includes('semgrep-ccv3'), false);
  assert.equal(ALWAYS_GATES.some((g) => g.id === 'semgrep-ccv3'), false);
});

test('GW7: a Markdown-only change under scripts/ or a hook folder needs no Docker; code and rule files still run semgrep-ccv3', async () => {
  for (const p of ['scripts/github/README.md', '.claude/hooks/src/NOTES.md', '.claude/plugins/ccv3-mods/hooks/pr-loop/README.md']) {
    assert.equal(ids(gatesFor([p], REPO_ROOT)).includes('semgrep-ccv3'), false, p);
  }
  for (const p of ['scripts/x.mjs', 'scripts/a/b.js', 'scripts/a/b.ts', 'scripts/ratchets/semgrep-ccv3/ccv3-new-rule.yml', '.claude/hooks/src/a.ts', '.claude/plugins/ccv3-mods/hooks/pr-loop/index.tsx']) {
    assert.equal(ids(gatesFor([p], REPO_ROOT)).includes('semgrep-ccv3'), true, p);
  }
});

test('GW4: a change under scripts/checks runs the checks helper tests, and the files named exist', async () => {
  const g = gatesFor(['scripts/checks/proofs.json'], REPO_ROOT).find((x) => x.id === 'checks-tests');
  assert.ok(g);
  for (const n of ['prove-check', 'state-table', 'changed-lines', 'typecheck-changed', 'cli-smoke', 'parser-fixtures', 'catchers']) {
    assert.ok(g.args.includes(`scripts/checks/${n}.test.mjs`), `${n}.test.mjs is left out of the checks-tests gate`);
  }
  for (const a of g.args.slice(1)) assert.ok(existsSync(path.join(REPO_ROOT, a)), a);
});

test('CW1: a changed scripts/**/*.mjs or a registered parser file runs the catchers gate; docs and other code do not (breaks if a glob is dropped)', async () => {
  for (const p of ['scripts/github/pre-pr.mjs', 'scripts/settings/remove-maestro-registrations.mjs', ...CATCHER_PARSER_FILES]) {
    assert.ok(ids(gatesFor([p], REPO_ROOT)).includes('catchers'), p);
  }
  for (const p of ['docs/x.md', '.claude/hooks/src/a.ts', 'scripts/github/README.md']) assert.equal(ids(gatesFor([p], REPO_ROOT)).includes('catchers'), false, p);
  const g = gatesFor(['scripts/a.mjs'], REPO_ROOT).find((x) => x.id === 'catchers');
  assert.deepEqual(g.args.slice(0, 5), ['scripts/checks/catchers.mjs', '--base', BASE_TOKEN, '--head', 'HEAD']);
  assert.ok(existsSync(path.join(REPO_ROOT, g.args[0])));
});

test('CW2: every file in the parser-fixtures registry triggers the catchers gate (breaks if a registry entry names a file the surface does not own)', async () => {
  assert.ok(REGISTRY.length >= 10, 'the registry is not empty');
  for (const file of new Set(REGISTRY.map((e) => e.file))) assert.ok(ids(gatesFor([file], REPO_ROOT)).includes('catchers'), file);
});

test('CW3: withBase replaces only the base token and leaves other gates alone (breaks if the token reaches the command line)', async () => {
  const g = gatesFor(['scripts/a.mjs'], REPO_ROOT).find((x) => x.id === 'catchers');
  assert.deepEqual(withBase(g, 'release').args.slice(0, 5), ['scripts/checks/catchers.mjs', '--base', 'release', '--head', 'HEAD']);
  assert.ok(g.args.includes(BASE_TOKEN), 'the table row is not changed');
  const other = gatesFor(['docs/x.md'], REPO_ROOT)[0];
  assert.equal(withBase(other, 'release'), other);
});

test('GW4b: no gate runs the dead trex glob; a trex change gets the manual NOTE, and test-map.mjs still runs its own test (Dave, 2026-11-17)', async () => {
  const all = [...ALWAYS_GATES, ...SURFACES.flatMap((s) => s.gates ?? [])];
  assert.equal(all.some((g) => g.id === 'trex-tests' || (g.args ?? []).some((a) => String(a).startsWith('scripts/trex/'))), false, 'scripts/trex does not exist: a gate on it runs nothing');
  const trex = SURFACES.find((s) => s.id === 'trex');
  assert.ok(trex, 'the trex surface keeps its globs');
  assert.deepEqual(trex.gates, []);
  for (const p of ['.trex/flows/x.yaml', 'docker/trex/Dockerfile', 'apps/agentic-os/e2e/trex-login.spec.ts']) {
    assert.ok(notesFor([p], CONFIG).some((n) => n.step === 'manual:trex'), `${p}: no manual:trex NOTE`);
  }
  assert.ok(ids(gatesFor(['scripts/checks/test-map.mjs'], REPO_ROOT)).includes('test-map-tests'));
  assert.match(trex.manual, /scripts\/checks\/test-map\.mjs/, 'the manual NOTE names test-map.mjs, which the trex surface also holds');
});

test('WS4: gate test-scripts gets at least 10 minutes, as checks-tests (72 s alone, slower under load)', () => {
  const g = SURFACES.flatMap((s) => s.gates ?? []).find((x) => x.id === 'test-scripts');
  assert.ok(g && g.timeoutMs >= 10 * 60_000, `timeout ${g?.timeoutMs} ms`);
});

// ---------- step 3 of card coord-test-gate-coverage: the Windows gate of the test:scripts-only files (Dave, 2026-11-17) ----------

const TEST_SCRIPTS = () => JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts['test:scripts'].split(/\s+/).filter((w) => /\.test\.mjs$/.test(w));

test('WS1: a change in a test:scripts-only folder runs gate test-scripts with the named files; other changes do not', async () => {
  // Real paths only (PR 648 critic): the scheduled wrappers under .claude/scripts/scheduled, and the coordination modules the tested code imports.
  const runs = ['scripts/review-engine/args.test.mjs', 'scripts/scheduled/tasks.json', '.claude/scripts/scheduled/scheduled-health-check.bat',
    'scripts/settings/apply-registrations.mjs', 'scripts/measurement/cost-reconcile.mjs', 'scripts/msys/reap.ps1', 'scripts/pricing/refresh-prices.mjs',
    '.claude/scripts/security/sink-spy.mjs', 'scripts/harness-doctor.mjs', 'scripts/coordination/reminder-core.mjs', 'scripts/coordination/lane-dash-flow.test.mjs',
    'scripts/coordination/lane-dep.mjs', 'scripts/coordination/lane-seed-file.mjs', 'scripts/coordination/canon-home.mjs', 'scripts/coordination/session-label.mjs',
    'scripts/coordination/lane-board.mjs'];
  for (const p of runs) {
    assert.ok(existsSync(path.join(REPO_ROOT, p)), `${p}: WS1 must read real paths`);
    const g = gatesFor([p], REPO_ROOT).find((x) => x.id === 'test-scripts');
    assert.ok(g, `${p}: no test-scripts gate`);
    assert.deepEqual([g.cmd, g.args], ['node', ['--test', ...PRE.SCRIPTS_WINDOWS_TESTS]]);
  }
  for (const p of ['docs/x.md', 'scripts/coordination/lane-band.mjs', 'scripts/github/lib/proc.mjs', '.claude/hooks/src/x.ts']) {
    assert.equal(ids(gatesFor([p], REPO_ROOT)).includes('test-scripts'), false, `${p}: test-scripts must not run`);
  }
});

test('WS2: every name in SCRIPTS_WINDOWS_TESTS is a tracked file named in package.json test:scripts, once', async () => {
  const names = PRE.SCRIPTS_WINDOWS_TESTS;
  assert.ok(Array.isArray(names) && names.length >= 40, `only ${names?.length} names: the check would be vacuous`);
  assert.equal(new Set(names).size, names.length, 'a name is listed twice');
  const tracked = new Set(execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0'));
  const inScript = new Set(TEST_SCRIPTS());
  for (const n of names) {
    assert.ok(tracked.has(n), `${n} is not tracked`);
    assert.ok(inScript.has(n), `${n} is not in package.json test:scripts`);
  }
});

test('WS3: every test:scripts name is in SCRIPTS_WINDOWS_TESTS, another pre-pr gate or a CI step, so a new name fails here', async () => {
  const { readSources } = await import('./gate-coverage.mjs');
  const { ci, prepr } = await readSources(REPO_ROOT);
  assert.ok(prepr instanceof Set && prepr.size > 0, 'readSources gives no pre-pr set: the check would be vacuous');
  const names = new Set(PRE.SCRIPTS_WINDOWS_TESTS ?? []);
  const loose = TEST_SCRIPTS().filter((n) => !names.has(n) && !ci.has(n) && !prepr.has(n));
  assert.deepEqual(loose, [], 'test:scripts names that no gate runs: add them to SCRIPTS_WINDOWS_TESTS in pre-pr.mjs');
});

test('GW4c: a change to test-map.mjs runs test-map.test.mjs, and one under scripts/github/local-review runs the tests in that folder (breaks if either test file is left out of every gate)', async () => {
  const tm = gatesFor(['scripts/checks/test-map.mjs'], REPO_ROOT).find((x) => x.id === 'test-map-tests');
  assert.ok(tm);
  assert.deepEqual([tm.cmd, tm.args], ['node', ['--test', 'scripts/checks/test-map.test.mjs']]);
  assert.ok(existsSync(path.join(REPO_ROOT, tm.args[1])));
  const lr = gatesFor(['scripts/github/local-review/record.mjs'], REPO_ROOT).find((x) => x.id === 'local-review-tests');
  assert.ok(lr);
  assert.deepEqual([lr.cmd, lr.args], ['node', ['--test', 'scripts/github/local-review/**/*.test.mjs']]);
});

// ---------- test globs (re-test-globs): each glob gate runs every test file it should, and CI runs the same patterns ----------

/**
 * Build a temp root with marker test files, take gate `gateId` from gatesFor([changed]) and run it with the real defaultExec.
 * Each test file appends its name to picked.txt, so the result says which files node --test really ran. NODE_TEST_CONTEXT is
 * cleared around the run: this file runs under node --test, and a nested node --test with that variable set runs no file and exits 0.
 */
function runGlobGate(gateId, changed, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'prepr-glob-'));
  const marker = path.join(root, 'picked.txt');
  try {
    for (const rel of files) {
      const name = path.posix.basename(rel, '.test.mjs');
      mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(root, rel), `import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest(${JSON.stringify(name)}, () => { appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${name}\n`)}); });\n`);
    }
    const gate = gatesFor([changed], REPO_ROOT).find((g) => g.id === gateId);
    assert.ok(gate, `${changed} -> ${gateId}`);
    const saved = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    let r;
    try {
      r = runGate({ ...gate, timeoutMs: 2 * 60_000 }, { root, exec: PRE.defaultExec, git: () => ({ status: 0, stdout: '', stderr: '' }) });
    } finally {
      if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
    }
    const picked = existsSync(marker) ? readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean).sort() : [];
    return { r, picked };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('TG1: local-review-tests runs the top-level tests and the tests in a subfolder (breaks if the gate pattern loses **)', async () => {
  const { r, picked } = runGlobGate('local-review-tests', 'scripts/github/local-review/backends/x.mjs',
    ['scripts/github/local-review/top.test.mjs', 'scripts/github/local-review/backends/deep.test.mjs']);
  assert.equal(r.status, 'PASS', `${r.detail}\n${r.output}`);
  assert.deepEqual(picked, ['deep', 'top']);
});

test('TG2: resolve-deps-tests runs every scripts/lib test file, not only resolve-deps.test.mjs (breaks if the gate names one file)', async () => {
  const { r, picked } = runGlobGate('resolve-deps-tests', 'scripts/lib/headless.mjs', ['scripts/lib/a.test.mjs', 'scripts/lib/b.test.mjs']);
  assert.equal(r.status, 'PASS', `${r.detail}\n${r.output}`);
  assert.deepEqual(picked, ['a', 'b']);
});

test('TG3: a change under scripts/eval/review-eval (code, fixtures, config) runs review-eval-tests, and no path there is unowned', async () => {
  for (const p of ['scripts/eval/review-eval/score.mjs', 'scripts/eval/review-eval/fixtures/x.json']) {
    assert.ok(ids(gatesFor([p], REPO_ROOT)).includes('review-eval-tests'), p);
  }
  const { r, picked } = runGlobGate('review-eval-tests', 'scripts/eval/review-eval/score.mjs', ['scripts/eval/review-eval/t.test.mjs']);
  assert.equal(r.status, 'PASS', `${r.detail}\n${r.output}`);
  assert.deepEqual(picked, ['t']);
  assert.equal(notesFor(['scripts/eval/review-eval/config.json'], CONFIG).some((n) => n.step.startsWith('unowned:')), false);
});

test('TG3b: a change to a reviewer-set or band-set file runs review-eval-tests, taken from the engine-version lists (breaks if the trigger list is copied or dropped; PR 574 failed in CI on a one-file reviewer change)', async () => {
  // The paths come from the module the engine freeze reads, so a file added to a set runs the gate with no edit here.
  const sample = [...REVIEWER_SET_FILES, `${REVIEWER_SET_DIR}backends/x.mjs`, `${REVIEWER_SET_DIR}a/b/deep.mjs`, `${REVIEWER_SET_DIR}prompt.mjs`, ...BAND_SET_FILES];
  assert.ok(sample.length >= 10, 'the lists are not empty');
  for (const p of sample) assert.ok(ids(gatesFor([p], REPO_ROOT)).includes('review-eval-tests'), p);
  // A file outside the sets and outside the eval folder does not start it.
  assert.equal(ids(gatesFor(['scripts/github/open-prs.mjs'], REPO_ROOT)).includes('review-eval-tests'), false);
});

test('TG3c: review-eval-tests also runs the tests of the rubrics folder, which the top-level pattern does not reach (breaks if the second pattern is dropped)', async () => {
  const { r, picked } = runGlobGate('review-eval-tests', 'scripts/eval/review-eval/rubrics/rubric-lint.mjs',
    ['scripts/eval/review-eval/t.test.mjs', 'scripts/eval/review-eval/rubrics/r.test.mjs']);
  assert.equal(r.status, 'PASS', `${r.detail}\n${r.output}`);
  assert.deepEqual(picked, ['r', 't']);
});

test('TG4: CI job ratchets runs the same three glob patterns as pre-pr, each in single quotes (breaks if a pattern drifts or loses its quotes)', async () => {
  const wf = readFileSync(path.join(REPO_ROOT, '.github/workflows/ccv3-checks.yml'), 'utf8');
  const start = wf.indexOf('\n  ratchets:');
  assert.ok(start >= 0, 'the workflow has the ratchets job');
  const rest = wf.slice(start + 1);
  const next = rest.slice(1).search(/\n  [\w-]+:/);
  const job = next < 0 ? rest : rest.slice(0, next + 1);
  const runs = job.split('\n').filter((l) => /^\s*run:/.test(l));
  assert.ok(runs.length > 10, 'the ratchets job has run lines');
  const gates = SURFACES.flatMap((s) => s.gates ?? []);
  for (const id of ['local-review-tests', 'resolve-deps-tests', 'review-eval-tests']) {
    const g = gates.find((x) => x.id === id);
    assert.ok(g, id);
    // Every pattern of the gate (review-eval-tests has two: the folder and its rubrics subfolder).
    for (const pattern of g.args.slice(1)) {
      assert.ok(pattern.includes('*'), `${id}: ${pattern} is a glob`);
      // Unquoted, bash reads ** as * (no globstar) and drops the top-level files with no error. Node expands a quoted pattern.
      const hits = runs.filter((l) => l.includes(pattern));
      assert.ok(hits.length > 0, `${id}: no run line in job ratchets names ${pattern}`);
      for (const l of hits) assert.ok(l.includes(`'${pattern}'`), `${id}: ${pattern} is not in single quotes: ${l.trim()}`);
    }
  }
});

test('TG5: a change to lane-context.ts or its db test runs the lane-context-db gate; another hooks file does not (breaks if the row or a glob is dropped)', async () => {
  for (const p of ['.claude/hooks/src/lane-context.ts', '.claude/hooks/src/__tests__/lane-context-db.test.ts']) {
    const g = gatesFor([p], REPO_ROOT).find((x) => x.id === 'lane-context-db');
    assert.ok(g, `${p} -> lane-context-db`);
    assert.deepEqual([g.cmd, g.args, g.cwd], ['node', ['scripts/github/lane-context-db-gate.mjs'], '.']);
    assert.ok(g.timeoutMs >= 10 * 60_000, 'a scratch database and the vitest run get 10 min');
  }
  assert.equal(ids(gatesFor(['.claude/hooks/src/pre-pr-gate.ts'], REPO_ROOT)).includes('lane-context-db'), false);
});

test('TG7: each file that scratch-db.mjs create --through 6 reads runs the lane-context-db gate; a rollback file does not (breaks if a schema glob is dropped or widened)', async () => {
  // The list comes from scratch-db.mjs: init-schema.sql (:173), the three coordination migrations (:207-208), the journal (:133)
  // and each journal tag up to 6 (:211). A new tag changes the journal, so the gate runs for it too.
  const journal = JSON.parse(readFileSync(path.join(REPO_ROOT, 'apps/agentic-os/drizzle/meta/_journal.json'), 'utf8'));
  const tags = journal.entries.map((e) => e.tag).filter((t) => Number(t.slice(0, 4)) <= 6);
  assert.equal(tags.length, 7, 'the journal has tags 0000 to 0006');
  const read = [
    'docker/init-schema.sql',
    ...['001-file-claims-leases.sql', '002-g5-drop-orphan-sessions.sql', '003-sessions-lifecycle.sql'].map((f) => `scripts/coordination/migrations/${f}`),
    'apps/agentic-os/drizzle/meta/_journal.json',
    ...tags.map((t) => `apps/agentic-os/drizzle/${t}.sql`),
  ];
  read.push('scripts/coordination/scratch-db.mjs'); // the program that builds the database: a change to its create or drop can break the gate
  for (const p of read) {
    assert.ok(existsSync(path.join(REPO_ROOT, p)), `${p} exists`);
    assert.ok(ids(gatesFor([p], REPO_ROOT)).includes('lane-context-db'), `${p} -> lane-context-db`);
  }
  for (const p of ['apps/agentic-os/drizzle/0006_down.sql', 'apps/agentic-os/drizzle/meta/0006_snapshot.json', 'docker/docker-compose.yml']) {
    assert.equal(ids(gatesFor([p], REPO_ROOT)).includes('lane-context-db'), false, `${p} is not read by create --through 6`);
  }
});

test('TG6: CI job coordination-db runs lane-context-db-gate.mjs (breaks if the step is dropped)', async () => {
  const wf = readFileSync(path.join(REPO_ROOT, '.github/workflows/ccv3-checks.yml'), 'utf8');
  const start = wf.indexOf('\n  coordination-db:');
  assert.ok(start >= 0, 'the workflow has the coordination-db job');
  const rest = wf.slice(start + 1);
  const next = rest.slice(1).search(/\n  [\w-]+:/);
  const job = next < 0 ? rest : rest.slice(0, next + 1);
  const runs = job.split('\n').filter((l) => /^\s*run:/.test(l));
  assert.ok(runs.some((l) => /^\s*run:\s*node scripts\/github\/lane-context-db-gate\.mjs\s*$/.test(l)), runs.join('\n'));
  // The gate step may use 8 minutes after the earlier test steps. A 10-minute job could cancel it before the drop.
  const jobLimit = Number(/^ {4}timeout-minutes:\s*(\d+)/m.exec(job)?.[1]);
  assert.ok(jobLimit >= 15, `coordination-db job limit is ${jobLimit} min; it must cover the earlier steps and the 8-minute gate step`);
});

test('GW5: the semgrep-ccv3 gate FAILs and names Docker when Docker is not available (never a SKIP or NOTE)', async () => {
  const gate = SURFACES.flatMap((s) => s.gates ?? []).find((g) => g.id === 'semgrep-ccv3');
  const saved = process.env.DOCKER_BIN;
  process.env.DOCKER_BIN = path.join(os.tmpdir(), 'no-such-docker-binary');
  // The wrapper uses opengrep when it finds the binary under the home folder. An empty home forces the Docker path.
  const home = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, CCV3_OPENGREP: process.env.CCV3_OPENGREP };
  process.env.USERPROFILE = process.env.HOME = mkdtempSync(path.join(os.tmpdir(), 'gw5-home-'));
  delete process.env.CCV3_OPENGREP;
  try {
    const r = runGate({ ...gate, timeoutMs: 60_000 }, { root: REPO_ROOT, exec: PRE.defaultExec, git: () => ({ status: 0, stdout: '', stderr: '' }) });
    assert.equal(r.status, 'FAIL');
    assert.match(r.detail, /Docker Desktop/);
  } finally {
    if (saved === undefined) delete process.env.DOCKER_BIN;
    else process.env.DOCKER_BIN = saved;
    for (const [k, v] of Object.entries(home)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('GW6: the ccv3-checks workflow is owned by a surface, so pre-pr does not report it as unowned', async () => {
  const p = '.github/workflows/ccv3-checks.yml';
  assert.equal(notesFor([p], CONFIG).some((n) => n.step.startsWith('unowned:')), false);
  assert.ok(ids(gatesFor([p], REPO_ROOT)).includes('ratchets-tests'), 'the ratchets tests read the Semgrep digest in this file (SG2)');
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
  writeFileSync(path.join(root, 'REVIEW.md'), REVIEW_MD);
  const calls = [];
  const usageCalls = [];
  const runner = (opts) => {
    if (opts.args[0] === 'usage') { usageCalls.push(opts); return runner.usage ?? { status: 0, stdout: USAGE_OK, stderr: '' }; }
    calls.push(opts);
    return runner.next ?? { status: 0, stdout: NDJSON_OK, stderr: '' };
  };
  return { root, calls, usageCalls, runner, now: new Date('2026-10-27T10:00:00Z'), ledgerPath: tempLedger() };
}
const crOpts = (f, extra = {}) => ({ root: f.root, branch: 'feat/x', head: HEAD, base: 'main', now: f.now, runner: f.runner, ledgerPath: f.ledgerPath, crStore: null, ...extra });

test('C1: the run uses cr review --agent and never --use-credits or --api-key', async () => {
  const f = crFixture();
  const r = (await runCodeRabbit(crOpts(f)));
  assert.equal(r.status, 'PASS');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args.slice(0, 2), ['review', '--agent']);
  assert.equal(f.calls[0].args.some((a) => /use-credits|api-key/.test(a)), false);
  assert.ok(f.calls[0].timeoutMs >= 15 * 60_000);
  assert.deepEqual(CR_ARGS(BASE40), ['review', '--agent', '--committed', '--base-commit', BASE40]);
  assert.deepEqual(f.calls[0].args, CR_ARGS(BASE40));
  assert.deepEqual(CR_USAGE_ARGS, ['usage', '--agent']);
  assert.throws(() => assertSafeCrArgs(['usage', '--agent', '--use-credits']), /forbidden/i);
  assert.throws(() => assertSafeCrArgs(['usage']), /forbidden/i);
  assertSafeCrArgs(['usage', '--agent']);
  assertSafeCrArgs(CR_ARGS(BASE40));
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

test('P6: a usage report of "unavailable" (CodeRabbit lookup_failed, exit 1) means the count is unknown, so the review still runs', async () => {
  // The real output of `cr usage --agent` (CLI 0.9.0, 2026-11-02) while CodeRabbit's usage lookup was down; `cr review --agent` still worked.
  const down = '{"type":"status","phase":"usage","status":"unavailable","organization":"Rev4nchist","includedReviews":{"state":"unavailable","reason":"lookup_failed"},"billingPeriod":{"state":"unavailable","reason":"lookup_failed"}}\n';
  const f = crFixture();
  f.runner.usage = { status: 1, stdout: down, stderr: '' };
  const r = await runCodeRabbit(crOpts(f));
  assert.equal(r.status, 'PASS', r.detail);
  assert.equal(f.calls.length, 1, 'the review ran');
  // An error record with a non-zero exit stays a broken CLI.
  const g = crFixture();
  g.runner.usage = { status: 1, stdout: ev({ type: 'status', phase: 'usage', status: 'error', message: 'x' }), stderr: '' };
  assert.equal((await runCodeRabbit(crOpts(g))).skipReason, 'cli-error');
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
// On POSIX the runner kills the process group of the child. A detached grandchild leaves that group, so no group kill can
// reach it. The real cr binary does not detach, so on POSIX the grandchild stays in the group of the child.
test('T5: the hard timeout stops the whole process tree, not only the child (no tree-kill command)', async () => {
  const pidFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-gc-')), 'gc.pid');
  const script = fakeCr(`import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', ${JSON.stringify(pidFile)}], { stdio: 'ignore', detached: process.platform === 'win32' }).unref();
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
  const v = hookVerdict(repo.dir);
  assert.equal(v.allow, false);
  assert.match(v.reason, new RegExp('skipped the CodeRabbit CLI review.*cli-error'));
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
    // Older than the grace: a malformed body is then a dead writer's leftover, not a write in progress.
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const r = await runCodeRabbit(crOpts(f));
    assert.equal(r.status, 'PASS', body);
    assert.equal(f.calls.length, 1);
    assert.equal(existsSync(lock), false);
  }
});

test('L5: a fresh empty or half-written lock is another run between create and write: held, not removed (CodeRabbit #193)', async () => {
  for (const body of ['', '{"pid":']) {
    const f = crFixture();
    const { lock } = crPaths(f.root, 'feat/x');
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, body);
    const r = await runCodeRabbit(crOpts(f));
    assert.equal(r.status, 'FAIL', JSON.stringify(body));
    assert.match(r.detail, /in progress/);
    assert.equal(f.calls.length, 0, 'no CLI run while the lock may be held');
    assert.equal(existsSync(lock), true, 'the lock of the other run is not removed');
  }
});

test('L6: an empty lock that is removed between the read and the stat is gone, not held: the next create wins (CodeRabbit #193)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pre-pr-l6-'));
  const lock = path.join(dir, 'cr-lock.json');
  writeFileSync(lock, '');
  let stats = 0;
  const stat = (p) => {
    stats += 1;
    rmSync(p, { force: true }); // the holder releases the lock at this moment
    const err = new Error('ENOENT: no such file'); err.code = 'ENOENT'; throw err;
  };
  const r = acquireLock(lock, { pid: process.pid, head: HEAD, at: new Date().toISOString() }, { nowMs: Date.now(), staleMs: 60_000, stat });
  assert.equal(stats, 1);
  assert.deepEqual(r, { ok: true });
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid);
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
  const run = (cwd, ...args) => spawnSync(process.execPath, [path.join(HERE, 'pre-pr.mjs'), ...args], { cwd, encoding: 'utf8', windowsHide: true, env: LOCK_SAMPLES_ENV });
  assert.equal(run(os.tmpdir()).status, 2);
  // A git checkout with no review-router.config.json: the config read throws inside the run.
  const repo = makeRepo();
  const body = path.join(repo.dir, '..', `body-${Date.now()}.md`);
  writeFileSync(body, 'Proof type: docs\n');
  const r = run(repo.dir, '--body', body, '--skip-cr');
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /stopped by an error/);
  // O1: the child takes the lock with fake samples (no real 6 s + 30 s + 6 s machine read). Break: drop RUN_LOCK_TEST_SAMPLES from the spawn env.
  assert.match(r.stderr, /samples come from RUN_LOCK_TEST_SAMPLES/);
});

// The built hook, fed a stamp that pre-pr.mjs really wrote.
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'dist', 'pre-pr-gate.mjs');
// The hook denies a body that is not a file, so the default command names a file that holds the body prePr() hashed.
const STAMPED_BODY = 'Proof type: docs\n';
function hookVerdict(repoDir, command) {
  if (command === undefined) {
    const bodyFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-hookbody-')), 'body.md');
    writeFileSync(bodyFile, STAMPED_BODY);
    // A draft create: a CCv3 create that is not a draft is denied for that reason first, which these checks do not test.
    command = `gh pr create --draft --body-file "${bodyFile.replace(/\\/g, '/')}"`;
  }
  const log = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-hooklog-')), 'g.jsonl');
  // A busy machine (the full suite runs files in parallel) can pass the hook's 2 s git limit; a git timeout on a PR
  // create then denies, which is right in use but would make this check depend on load.
  const env = { ...process.env, CCV3_GUARD_DECISIONS_LOG: log, SKIP_PRE_PR_GATE: '', PRE_PR_GATE_GIT_TIMEOUT_MS: '10000' };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repoDir, session_id: 't' }), encoding: 'utf8', windowsHide: true, env });
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

test('B1k: an answer-key stamp written by pre-pr is allowed by the built hook only with both proof fields; flag stays denied', async () => {
  // Breaks when: the hook (dist/pre-pr-gate.mjs, built from src) does not accept the earned reason, accepts it with a field missing, or pre-pr stops writing the fields.
  const repo = withFork(repoWithGoldFile());
  git(repo.dir, 'rm', '-q', repo.rel);
  git(repo.dir, 'commit', '-q', '-m', 'delete gold');
  const run = await prePr(repo);
  assert.equal(run.result.ok, true, run.result.lines.join('\n'));
  const file = stampFile(repo);
  const stamp = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(hookVerdict(repo.dir).allow, true, 'both fields: allowed');
  const denied = (over) => { writeFileSync(file, JSON.stringify({ ...stamp, ...over })); return hookVerdict(repo.dir); };
  for (const over of [{ answer_key_paths: undefined }, { answer_key_paths: 0 }, { cr_answer_key: false }, { cr_answer_key: undefined }]) {
    const v = denied(over);
    assert.equal(v.allow, false, JSON.stringify(over));
    assert.match(v.reason, /answer-key/, JSON.stringify(over));
  }
  assert.equal(denied({ cr_skip_reason: 'flag' }).allow, false, 'the fields do not excuse flag');
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
  // No cap in the config: remaining 0 has no budget to compare, so it stays rate-limited. With a cap it runs or skips on the estimate (CE tests).
  const noCap = { ...CONFIG, coderabbit: { ...CONFIG.coderabbit, cli_daily_cap_usd: undefined } };
  const lim = await prePr(limited, { config: noCap, crRunner: (o) => (o.args[0] === 'usage' ? { status: 0, stdout: ev({ type: 'usage', remaining: 0, fullCapacityInMs: 720000 }), stderr: '' } : { status: 0, stdout: NDJSON_OK, stderr: '' }) });
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
  const v = hookVerdict(repo.dir);
  assert.equal(v.allow, false);
  assert.match(v.reason, new RegExp('skipped the CodeRabbit CLI review.*no-changes'));
});

// ---------- docs-only branches: the CLI has nothing to review (.coderabbit.yaml path_filters exclude docs/**) ----------

const NO_FILES = ev(CONTEXT, { type: 'error', errorType: 'review', message: 'Review failed: No files to review\nPrevious local review has no stored findings.', recoverable: false });
const crReturning = (stdout) => (o) => (o.args[0] === 'usage' ? { status: 0, stdout: USAGE_OK, stderr: '' } : { status: 0, stdout, stderr: '' });
/** The real CLI on "No files to review": the error event on stdout, the same text on stderr, exit code 1 (seen 11-06 on docs/codemap). */
const crExiting = (status, stdout) => (o) => (o.args[0] === 'usage' ? { status: 0, stdout: USAGE_OK, stderr: '' } : { status, stdout, stderr: 'Error: No files to review\n' });
const runsOn = (repo) => JSON.parse(readFileSync(crPaths(repo.dir, 'feat/x').counter, 'utf8')).runs;
const harnessBodyFor = (head) => `## Evidence\n\nProof type: harness\n\nRED: \`x\` @ ${'b'.repeat(40)}\n\`\`\`text\nred\n\`\`\`\n\nGREEN: \`x\` @ ${head}\n\`\`\`text\ngreen\n\`\`\`\n`;

test('DO1: a docs-only branch where the CLI says "No files to review" is a SKIP docs-only, no slot spent, and the stamp says so', async () => {
  const repo = withFork(makeRepo());
  const { result } = await prePr(repo, { crRunner: crExiting(1, NO_FILES) }); // exit 1 is what the real CLI does
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.ok(result.lines.some((l) => /^SKIP coderabbit/.test(l)), result.lines.join('\n'));
  const stamp = JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8'));
  assert.equal(stamp.cr_skipped, true);
  assert.equal(stamp.cr_skip_reason, 'docs-only');
  assert.equal(stamp.cr_docs_only, true);
  assert.equal(stamp.docs_verified, true);
  assert.equal(runsOn(repo).length, 0, 'the slot is given back');
});

test('DO2: the same error with one non-docs changed file stays a FAIL', async () => {
  const repo = makeRepo({ files: { 'docs/a.md': 'hello\n', 'scripts/a.mjs': 'export const a = 1;\n' } });
  const { result } = await prePr(repo, { bodyText: harnessBodyFor(repo.head), crRunner: crReturning(NO_FILES) });
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => /^FAIL coderabbit.*No files to review/.test(l)), result.lines.join('\n'));
  assert.equal(existsSync(path.join(repo.dir, STAMP_REL)), false, 'no stamp');
});

test('DO3: a different error event on a docs-only branch stays a FAIL', async () => {
  const repo = makeRepo();
  const other = ev(CONTEXT, { type: 'error', errorType: 'review', message: 'Review failed: upstream timeout', recoverable: true });
  const { result } = await prePr(repo, { crRunner: crReturning(other) });
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => /^FAIL coderabbit.*upstream timeout/.test(l)), result.lines.join('\n'));
  assert.equal(existsSync(path.join(repo.dir, STAMP_REL)), false, 'no stamp');
});

test('DO5: "No files to review" from a CLI that timed out or could not start stays a FAIL (a stopped review is not a clean skip)', async () => {
  const timedOut = withFork(makeRepo());
  const hung = (o) => (o.args[0] === 'usage' ? { status: 0, stdout: USAGE_OK, stderr: '' } : { status: null, stdout: NO_FILES, stderr: '', timedOut: true });
  const a = await prePr(timedOut, { crRunner: hung });
  assert.equal(a.result.ok, false, a.result.lines.join('\n'));
  assert.match(a.result.lines.join('\n'), /FAIL coderabbit[\s\S]*timed out/);
  assert.equal(existsSync(path.join(timedOut.dir, STAMP_REL)), false, 'timed out: no stamp');
  // Only exit 1 is the real CLI's code for this error: any other exit (for example 2 or 137) is a stopped review.
  const otherExit = withFork(makeRepo());
  const b = await prePr(otherExit, { crRunner: crExiting(2, NO_FILES) });
  assert.equal(b.result.ok, false, b.result.lines.join('\n'));
  assert.match(b.result.lines.join('\n'), /FAIL coderabbit[\s\S]*exit 2/);
  assert.equal(existsSync(path.join(otherExit.dir, STAMP_REL)), false, 'exit 2: no stamp');
  // A CLI that could not start is the existing cli-error skip (the gate hook denies it); it must never be recorded as docs-only.
  const noStart = withFork(makeRepo());
  const broken = (o) => (o.args[0] === 'usage' ? { status: 0, stdout: USAGE_OK, stderr: '' } : { status: null, stdout: NO_FILES, stderr: '', error: 'spawn EACCES' });
  await prePr(noStart, { crRunner: broken });
  const stamp = JSON.parse(readFileSync(path.join(noStart.dir, STAMP_REL), 'utf8'));
  assert.notEqual(stamp.cr_skip_reason, 'docs-only');
  assert.equal(stamp.cr_docs_only, false);
});

test('DO4: a finished review on a docs-only branch is unchanged: not skipped, no docs-only flag, the slot is used', async () => {
  const repo = makeRepo();
  const { result } = await prePr(repo);
  assert.equal(result.ok, true, result.lines.join('\n'));
  const stamp = JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8'));
  assert.equal(stamp.cr_skipped, false);
  assert.equal(stamp.cr_skip_reason, null);
  assert.equal(stamp.cr_docs_only, false);
  assert.equal(runsOn(repo).length, 1);
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
  writeFileSync(path.join(dir, 'REVIEW.md'), REVIEW_MD); // the answer-key guard reads it from the root
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

// The env step looks for esbuild, vitest and pg in the temp repo, which has no node_modules. These tests are about the other steps,
// so they run with an env step that finds everything. The EN tests below use the real one (envStep) or their own.
const NO_ENV = ({ gates }) => ({ fail: null, others: [], note: null, blocked: new Set(), gates });

const SUMMARY_OK = () => ({ result: { step: 'summary', status: 'PASS', detail: 'stub summary', notes: [] }, sha: 'a'.repeat(64), ok: true });

async function prePr(repo, extra = {}) {
  const gateRuns = [];
  const crCalls = [];
  // The real clock by default: the B tests feed this stamp to the built hook, which checks it against the real time
  // (a fixed date made them fail once the real clock passed it by 24 hours). R1 passes its own fixed time.
  const opts = {
    root: repo.dir, base: 'main', config: CONFIG, now: new Date(),
    exec: okExec(gateRuns), crRunner: (o) => { if (o.args[0] === 'usage') return { status: 0, stdout: USAGE_OK, stderr: '' }; crCalls.push(o); return { status: 0, stdout: NDJSON_OK, stderr: '' }; },
    // No fetch by default: withFork adds a GitHub URL as the fork remote. The PF tests pass fetch: undefined for the real one.
    fetch: () => null,
    guardLog: () => {},
    envCheck: NO_ENV,
    ledgerPath: tempLedger(),
    crStore: null,
    gateLogPath: tempGateLog(),
    // The osv and pssa advisories never start a scanner or touch the network here: no lockfile, no binary. The OSV-PP / PSSA-PP tests inject their own.
    osvLockfiles: [], findOsv: () => null, findPssa: () => null,
    // The summary step has its own tests (lib/pr-summary.test.mjs and SM1..SM4 below); every other test runs with a summary that passes.
    summaryCheck: SUMMARY_OK,
    bodyText: 'Proof type: docs\n', ...extra,
  };
  return { result: await runPrePr(opts), gateRuns, crCalls };
}

test('R1: a full pass writes a stamp (head, branch, at, body hash, results), the log, and leaves the tree clean', async () => {
  const repo = makeRepo();
  const { result, gateRuns, crCalls } = (await prePr(repo, { now: new Date('2026-10-27T10:00:00Z') }));
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
  assert.match(path.basename(result.logPath), new RegExp(`^2026-10-27-pre-pr-${repo.head.slice(0, 7)}-\\d{6}\\.log$`));
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

test('SM1: a summary FAIL stops the run: no gate runs, no review slot is spent, no stamp, and the summary line is first', async () => {
  const repo = makeRepo();
  const summaryCheck = () => ({ result: { step: 'summary', status: 'FAIL', detail: 'no summary file', notes: [] }, sha: null });
  const { result, gateRuns, crCalls } = await prePr(repo, { summaryCheck });
  assert.equal(result.ok, false);
  assert.equal(existsSync(path.join(repo.dir, STAMP_REL)), false, 'no stamp');
  assert.equal(crCalls.length, 0);
  assert.deepEqual(gateRuns, []);
  assert.match(result.lines[0], /^FAIL summary - no summary file/);
  assert.ok(result.lines.some((l) => /^SKIP gate:context-budget.*summary failed/.test(l)), result.lines.join('\n'));
});

test('SM2: a passing summary puts its hash in the stamp; the check gets root, head, branch and base, and mode note when the config names none', async () => {
  const repo = makeRepo();
  const seen = [];
  const summaryCheck = (a) => { seen.push(a); return SUMMARY_OK(); };
  const { result } = await prePr(repo, { summaryCheck, config: { ...CONFIG, pre_pr: undefined } });
  assert.equal(result.ok, true, result.lines.join('\n'));
  const stamp = JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8'));
  assert.equal(stamp.summary_sha256, 'a'.repeat(64));
  assert.equal(stamp.summary_ok, true, 'the stamp records that the summary is a real one, so the Open PR question can show its Change');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].root, repo.dir);
  assert.equal(seen[0].head, repo.head);
  assert.equal(seen[0].branch, 'feat/x');
  assert.equal(seen[0].base, 'main');
  assert.equal(seen[0].mode, 'note');
  assert.equal(typeof seen[0].git, 'function');
  assert.match(readFileSync(result.logPath, 'utf8'), /PASS summary - stub summary/);
  // The config can turn on the gate (Dave decides after the one-week trial).
  await prePr(repo, { summaryCheck, config: { ...CONFIG, pre_pr: { summary_mode: 'fail' } } });
  assert.equal(seen[1].mode, 'fail');
});

test('SM3: the summary is step 0: first in the results, and it runs before the base is fetched', async () => {
  const repo = makeRepo();
  const order = [];
  const { result } = await prePr(repo, {
    summaryCheck: () => { order.push('summary'); return SUMMARY_OK(); },
    fetch: () => { order.push('fetch'); return null; },
  });
  assert.deepEqual(order, ['summary', 'fetch']);
  assert.equal(result.results[0].step, 'summary');
  assert.match(result.lines[0], /^PASS summary/);
});

test('SM4: the real check, no summary file, default mode: one NOTE line first, the run still passes, and the stamp has summary_sha256 null', async () => {
  const repo = makeRepo();
  const { result } = await prePr(repo, { summaryCheck: undefined, config: { ...CONFIG, pre_pr: undefined } });
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.match(result.lines[0], /^NOTE summary - .*summary\.md/);
  const stamp = JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8'));
  assert.equal(stamp.summary_sha256, null);
});

test('CW4: runPrePr gives the catchers gate the real base, and a failing catchers gate blocks the stamp (breaks if the token is not replaced or a catchers FAIL is ignored)', async () => {
  const repo = makeRepo({ files: { 'scripts/a.mjs': 'export const a = 1;\n' } });
  const specs = [];
  const exec = (spec) => {
    specs.push(spec);
    return spec.id === 'catchers' ? { status: 1, stdout: 'cli-smoke GATE: 1 failed of 1 script(s) run\ncatchers: FAIL: smoke 1 failed of 1\n', stderr: '' } : { status: 0, stdout: 'ok\n', stderr: '' };
  };
  // keepGoing: this repo has no PR body, so the evidence step fails first and fail-fast would skip the gate.
  const { result, crCalls } = await prePr(repo, { exec, keepGoing: true });
  const gate = specs.find((x) => x.id === 'catchers');
  assert.ok(gate, specs.map((x) => x.id).join(',') + '\n' + result.lines.join('\n'));
  assert.deepEqual(gate.args.slice(0, 5), ['scripts/checks/catchers.mjs', '--base', 'main', '--head', 'HEAD']);
  assert.equal(result.ok, false);
  assert.equal(existsSync(path.join(repo.dir, STAMP_REL)), false, 'no stamp');
  assert.ok(result.lines.some((l) => /^FAIL gate:catchers.*catchers: FAIL/.test(l)), result.lines.join('\n'));
  assert.equal(crCalls.length, 0);
});

test('R2b: a failing gate fails the run, and the gate summary is in its line', async () => {
  const repo = makeRepo();
  const bad = () => ({ status: 1, stdout: 'bad\n# fail 2\n', stderr: '' });
  const { result, crCalls } = (await prePr(repo, { exec: bad }));
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => /^FAIL gate:context-budget.*# fail 2/.test(l)), result.lines.join('\n'));
  // Card prepr-speed-bundle (O4): context-budget is a cheap gate and runs before the review, so its FAIL starts no review at all.
  assert.equal(crCalls.length, 0);
  // Card prflow-prepr-speed: the review starts beside the other gates, so a failing non-cheap gate does not stop it. PRE_PR_SERIAL_CR=1 keeps the old rule.
  const beside = await prePr(makeRepo(), { exec: bad, ...withGates(fakeGate('s1')) });
  assert.equal(beside.result.ok, false);
  assert.equal(beside.crCalls.length, 1);
  const serial = await prePr(makeRepo(), { env: { PRE_PR_SERIAL_CR: '1' }, exec: bad, ...withGates(fakeGate('s1')) });
  assert.equal(serial.crCalls.length, 0);
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
  // The git:stable re-check compares with the state at the start: a tree that was already dirty is reported once, by git:clean.
  assert.ok(!result.lines.some((l) => /^FAIL git:stable/.test(l)), result.lines.join('\n'));
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

// CodeRabbit #193 outside-diff finding: the clean-tree and HEAD checks ran only at the start, so a stamp could be
// written for a head the gates never checked. Each test changes the repo in the middle of the run (in a gate, or in
// the CodeRabbit step) and expects a FAIL git:stable line, a failed run, and no stamp.
const stampFile = (repo) => path.join(repo.dir, STAMP_REL);
const duringCr = (mutate) => ({ crRunner: (o) => { if (o.args[0] === 'usage') return { status: 0, stdout: USAGE_OK, stderr: '' }; mutate(); return { status: 0, stdout: NDJSON_OK, stderr: '' }; } });
const duringGate = (repo, mutate) => ({ exec: () => { mutate(repo); return { status: 0, stdout: 'ran\nTests  1 passed (1)\n', stderr: '' }; } });
const assertUnstable = (repo, result) => {
  assert.equal(result.ok, false, result.lines.join('\n'));
  assert.ok(result.lines.some((l) => /^FAIL git:stable/.test(l)), result.lines.join('\n'));
  assert.equal(existsSync(stampFile(repo)), false, 'no stamp for unchecked code');
  assert.equal(result.stampPath, null);
};

test('R7: a tracked file edited (not staged) during the CodeRabbit step gives FAIL git:stable and no stamp', async () => {
  const repo = makeRepo();
  const { result } = await prePr(repo, duringCr(() => writeFileSync(path.join(repo.dir, 'docs/a.md'), 'edited during the run\n')));
  assertUnstable(repo, result);
});

test('R8: a tracked file edited and staged during the CodeRabbit step gives FAIL git:stable and no stamp', async () => {
  const repo = makeRepo();
  const { result } = await prePr(repo, duringCr(() => { writeFileSync(path.join(repo.dir, 'docs/a.md'), 'staged during the run\n'); git(repo.dir, 'add', 'docs/a.md'); }));
  assertUnstable(repo, result);
});

test('R9: a commit made during the CodeRabbit step moves HEAD: FAIL git:stable and no stamp for the old head', async () => {
  const repo = makeRepo();
  const { result } = await prePr(repo, duringCr(() => { writeFileSync(path.join(repo.dir, 'docs/b.md'), 'new\n'); git(repo.dir, 'add', '.'); git(repo.dir, 'commit', '-q', '-m', 'during'); }));
  assertUnstable(repo, result);
});

test('R10: a tracked file edited during a gate (before the CodeRabbit step) also gives FAIL git:stable and no stamp', async () => {
  const repo = makeRepo();
  const { result } = await prePr(repo, duringGate(repo, (r) => writeFileSync(path.join(r.dir, 'docs/a.md'), 'edited by a gate\n')));
  assertUnstable(repo, result);
});

test('R11: an untracked file created during the run does not fail it: the log and stamp files are untracked, and only tracked content counts', async () => {
  const repo = makeRepo();
  const { result } = await prePr(repo, duringCr(() => writeFileSync(path.join(repo.dir, 'scratch.txt'), 'untracked\n')));
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.ok(existsSync(stampFile(repo)));
  assert.ok(!result.lines.some((l) => /git:stable/.test(l) && /^FAIL/.test(l)));
});

test('R12: a git call that fails in the final re-check is FAIL git:stable, never a pass (each of the three commands)', async () => {
  const cases = [['rev-parse', 'HEAD'], ['diff', '--name-only'], ['diff', '--cached', '--name-only']];
  for (const failing of cases) {
    const repo = makeRepo();
    const real = makeGit(repo.dir);
    let armed = false;
    // Armed when the CodeRabbit step runs, so only calls made after it (the re-check) fail.
    const git = (args) => (armed && args.join(' ') === failing.join(' ') ? { status: 128, stdout: '', stderr: 'fatal: boom' } : real(args));
    const { result } = await prePr(repo, { git, ...duringCr(() => { armed = true; }) });
    assert.ok(result.lines.some((l) => /^FAIL git:stable/.test(l)), `${failing.join(' ')}: ${result.lines.join('\n')}`);
    assert.equal(result.ok, false, failing.join(' '));
    assert.equal(existsSync(stampFile(repo)), false, `${failing.join(' ')}: no stamp`);
  }
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

test('RR8: npm and npx run through node and npm\'s own CLI script, never a shell (Semgrep spawn-shell-true)', () => {
  const nodeExe = 'C:\\nodejs\\node.exe';
  const exists = (p) => /npm-cli\.js$|npx-cli\.js$/.test(p);
  for (const platform of ['win32', 'linux']) {
    for (const tool of ['npm', 'npx']) {
      const s = resolveSpawn({ cmd: tool, args: ['run', 'build'] }, { platform, execPath: nodeExe, exists });
      assert.equal(s.shell, false, `${platform} ${tool}`);
      assert.equal(s.cmd, nodeExe, `${platform} ${tool}`);
      assert.match(s.args[0], new RegExp(`${tool}-cli\\.js$`));
      assert.deepEqual(s.args.slice(1), ['run', 'build']);
    }
  }
  assert.throws(() => resolveSpawn({ cmd: 'npm', args: [] }, { platform: 'win32', execPath: nodeExe, exists: () => false }), /npm-cli\.js/);
  const n = resolveSpawn({ cmd: 'node', args: ['x.mjs'] }, { platform: 'win32', execPath: nodeExe, exists });
  assert.deepEqual([n.cmd, n.shell], [nodeExe, false]);
  const b = resolveSpawn({ cmd: 'bash', args: ['t.sh'] }, { platform: 'win32', execPath: nodeExe, exists });
  assert.equal(b.cmd, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(resolveSpawn({ cmd: 'uv', args: ['run'] }, { platform: 'win32', execPath: nodeExe, exists }).shell, false);
});

test('RR7: the behind FAIL says to merge the base in, and that a rebase starts a new CodeRabbit CLI run count', () => {
  const r = checkGit(fakeGit({ ...GOOD, 'rev-list --count HEAD..main': '3\n' }), 'main');
  assert.equal(r[2].status, 'FAIL');
  assert.match(r[2].detail, /git merge fork\/main/);
  assert.doesNotMatch(r[2].detail, /merge or rebase/);
  assert.match(r[2].detail, /rebase .*new CodeRabbit CLI run count/);
});

test('RR6: the hooks-vitest gate gives each test at least 20 s (dist-integration tests spawn node under load)', () => {
  const t = gateById('hooks-vitest').args.map((a) => /^--testTimeout=(\d+)$/.exec(a)).find(Boolean);
  assert.ok(t && Number(t[1]) >= 20_000, gateById('hooks-vitest').args.join(' '));
});

// ---------- card coord-flake-ledger: a test that passes only on a retry leaves a record (design rev 2, seat GO 2026-11-18) ----------

const FLAKE_REPORTER = './test-support/flake-ledger-reporter.mjs';
const FLAKE_ARGS = ['--includeTaskLocation', '--reporter=default', `--reporter=${FLAKE_REPORTER}`];

test('FL1: the hooks-vitest gate and the CI hooks step both run the flake ledger reporter, from .claude/hooks where its path resolves (F1)', () => {
  const g = gateById('hooks-vitest');
  assert.equal(g.cwd, '.claude/hooks');
  for (const a of FLAKE_ARGS) assert.ok(g.args.includes(a), `pre-pr hooks-vitest lacks ${a}: ${g.args.join(' ')}`);
  assert.ok(existsSync(path.join(REPO_ROOT, g.cwd, FLAKE_REPORTER)), 'the reporter file is missing');
  const yml = readFileSync(path.join(REPO_ROOT, '.github/workflows/ccv3-checks.yml'), 'utf8');
  const step = yml.split(/\r?\n- name: |\n\s+- name: /).find((s) => s.startsWith('Hooks tests (vitest)'));
  assert.ok(step, 'CI step "Hooks tests (vitest)" not found');
  assert.match(step, /working-directory: \.claude\/hooks/);
  const run = /run: (.+)/.exec(step)?.[1] ?? '';
  // Named reporters replace vitest's defaults, and on CI the defaults include github-actions (the PR annotations): name it again there.
  for (const a of [...FLAKE_ARGS, '--reporter=github-actions']) assert.ok(run.split(/\s+/).includes(a), `CI hooks step lacks ${a}: ${run}`);
});

test('FL4: a change to the flake ledger code or its fixture runs gate hooks-vitest (the test-support folder is in the hooks surface)', () => {
  for (const p of ['.claude/hooks/test-support/flake-ledger.mjs', '.claude/hooks/test-support/flake-ledger-reporter.mjs', '.claude/hooks/test-support/fixtures/retry-once/retry-once.fixture.mjs']) {
    assert.ok(ids(gatesFor([p], REPO_ROOT)).includes('hooks-vitest'), `${p}: no hooks-vitest gate`);
  }
});

test('FL5: a run that fails only by the flake ledger names the FAIL line in its detail, not just "Tests N passed"', () => {
  const g = gateById('hooks-vitest');
  const out = '      Tests  9 passed (9)\nFLAKE LEDGER FAIL src/__tests__/x.test.ts:12 (2 in 7 days)\nFLAKE LEDGER: 1 retry pass(es) this run, 1 at the limit, ledger /x\n';
  const r = runGate(g, { root: REPO_ROOT, exec: execOut(1, out), git: fakeGit({}) });
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /FLAKE LEDGER FAIL src\/__tests__\/x\.test\.ts:12 \(2 in 7 days\)/);
});

test('FL2: a PASS of hooks-vitest carries the FLAKE LEDGER line and a WARN line in its detail (seat C4)', () => {
  const g = gateById('hooks-vitest');
  const out = ' Test Files  3 passed (3)\n      Tests  9 passed (9)\nFLAKE LEDGER WARN write failed (EBUSY); the run result is unchanged\nFLAKE LEDGER: 1 retry pass(es) this run, 0 at the limit, ledger /x\n';
  const r = runGate(g, { root: REPO_ROOT, exec: execOut(0, out), git: fakeGit({}) });
  assert.equal(r.status, 'PASS');
  assert.match(r.detail, /Tests {2}9 passed/);
  assert.match(r.detail, /FLAKE LEDGER WARN write failed/);
  assert.match(r.detail, /FLAKE LEDGER: 1 retry pass\(es\) this run/);
});

test('FL3: a gate without alsoLine keeps today\'s PASS detail, the summary line alone (F14)', () => {
  const g = { ...gateById('hooks-vitest') };
  delete g.alsoLine;
  const out = '      Tests  9 passed (9)\nFLAKE LEDGER: 0 retry pass(es) this run, 0 at the limit, ledger /x\n';
  const r = runGate(g, { root: REPO_ROOT, exec: execOut(0, out), git: fakeGit({}) });
  assert.equal(r.detail, summaryLine(out));
  assert.equal(SURFACES.flatMap((s) => s.gates ?? []).filter((x) => x.alsoLine).map((x) => x.id).join(','), 'hooks-vitest', 'only hooks-vitest sets alsoLine');
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

// ---------- PF: a bounded fetch of the base before the behind check (PR flow review, 2026-10-31) ----------
// Ways it can fail: the fetch is not run, so a stale fork/main passes (PF1); a failed fetch fails the run or hides
// that it failed (PF2); the fetch has no time limit, or a missing remote is an error (PF3).

const makeBare = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prepr-bare-'));
  git(dir, 'init', '-q', '--bare', '-b', 'main');
  return dir;
};

/** A repo whose fork remote holds a newer main than the fork/main ref the repo last fetched. */
function repoWithStaleFork() {
  const repo = makeRepo();
  const bare = makeBare();
  git(repo.dir, 'remote', 'add', 'fork', bare);
  git(repo.dir, 'push', '-q', 'fork', 'main');
  const base = git(repo.dir, 'rev-parse', 'main');
  const newer = git(repo.dir, 'commit-tree', 'main^{tree}', '-p', 'main', '-m', 'newer main');
  git(repo.dir, 'push', '-q', 'fork', `${newer}:refs/heads/main`);
  git(repo.dir, 'update-ref', 'refs/remotes/fork/main', base);
  return { ...repo, bare, newer, base };
}

const behindLine = (result) => result.results.find((r) => r.step === 'git:behind');

test('PF1: the run fetches the base from the fork first, so a fork/main that moved is seen as behind', async () => {
  const repo = repoWithStaleFork();
  const { result } = await prePr(repo, { fetch: undefined, skipCr: true });
  const behind = behindLine(result);
  assert.equal(behind.status, 'FAIL', result.lines.join('\n'));
  assert.match(behind.detail, /1 commit\(s\) behind fork\/main/);
  assert.doesNotMatch(behind.detail, /as last fetched/);
  assert.equal(git(repo.dir, 'rev-parse', 'refs/remotes/fork/main'), repo.newer, 'the remote-tracking ref was updated');
});

test('PF2: a fetch that fails keeps the old comparison, says the fetch failed, and does not fail the run', async () => {
  const repo = repoWithStaleFork();
  git(repo.dir, 'remote', 'set-url', 'fork', path.join(os.tmpdir(), 'prepr-no-such-remote-dir'));
  const { result } = await prePr(repo, { fetch: undefined, skipCr: true });
  const behind = behindLine(result);
  assert.equal(behind.status, 'PASS', result.lines.join('\n'));
  assert.match(behind.detail, /fetch of fork\/main failed/);
  assert.match(behind.detail, /last-fetched fork\/main/);
  assert.equal(result.ok, true, result.lines.join('\n'));
});

test('PF3: fetchBase reports no-remote without a fork remote, and a timeout as a failure that says so', () => {
  const repo = makeRepo();
  assert.equal(PRE.fetchBase(repo.dir, 'main').state, 'no-remote');
  const bare = makeBare();
  git(repo.dir, 'remote', 'add', 'fork', bare);
  git(repo.dir, 'push', '-q', 'fork', 'main');
  const slow = PRE.fetchBase(repo.dir, 'main', { timeoutMs: 1 });
  assert.equal(slow.state, 'failed');
  assert.match(slow.detail, /timed out/);
  assert.equal(PRE.fetchBase(repo.dir, 'main').state, 'ok');
});

// PF4 (CodeRabbit CLI, 2026-11-01): the default ssh command must not override the user's own ssh transport,
// because GIT_SSH_COMMAND outranks GIT_SSH and core.sshCommand.
test('PF4: fetchEnv sets the default ssh command only when no ssh transport is configured', () => {
  const dflt = PRE.fetchEnv({}, '').GIT_SSH_COMMAND;
  assert.match(dflt, /BatchMode=yes/);
  assert.equal(PRE.fetchEnv({}, '').GIT_TERMINAL_PROMPT, '0');
  assert.equal(PRE.fetchEnv({ GIT_SSH_COMMAND: 'my-ssh' }, '').GIT_SSH_COMMAND, 'my-ssh');
  assert.equal('GIT_SSH_COMMAND' in PRE.fetchEnv({ GIT_SSH: 'plink.exe' }, ''), false);
  assert.equal('GIT_SSH_COMMAND' in PRE.fetchEnv({}, 'ssh -i key'), false);
});

// ---------- GU: the GREEN sha follows a merge of the base (PR flow review, 2026-10-31) ----------
// Ways it can fail: the sha is not rewritten (GU1); it is rewritten when it is not an ancestor of HEAD (GU2), when a gate
// failed (GU3), or when another proof problem exists (GU4); the stamp hash is not the hash of the new file bytes (GU1);
// CRLF is turned into LF (GU5); a GREEN-looking line inside a RED output block is rewritten, or RED changes (GU6).

const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const greenBody = ({ redExtra = '', green, nl = '\n', redSha = 'b'.repeat(40), withRed = true }) => [
  '## Evidence', '', 'Proof type: feature', '',
  ...(withRed ? [`RED: \`node --test x\` @ ${redSha}`, '```text', 'not ok 1', ...(redExtra ? [redExtra] : []), '```', ''] : []),
  `GREEN: \`node --test x\` @ ${green}`, '```text', 'ok 1', '```', '',
].join(nl);

/** A feature branch that merged a newer main after its work. `old` is the head before the merge. */
function mergedRepo() {
  const repo = makeRepo({ files: { 'misc/x.dat': 'x\n' } });
  git(repo.dir, 'checkout', '-q', 'main');
  writeFileSync(path.join(repo.dir, 'NEW.md'), 'main moved\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'main moves');
  git(repo.dir, 'checkout', '-q', 'feat/x');
  git(repo.dir, 'merge', '-q', '--no-edit', 'main');
  return { dir: repo.dir, old: repo.head, head: git(repo.dir, 'rev-parse', 'HEAD') };
}

/** Runs pre-pr on a body file kept outside the repo. Returns the run, the file path and its bytes before. */
async function runWithBodyFile(repo, text, extra = {}) {
  const bodyPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-body-')), 'body.md');
  writeFileSync(bodyPath, text);
  const run = await prePr(repo, { bodyText: readFileSync(bodyPath, 'utf8'), bodyPath, skipCr: true, ...extra });
  return { ...run, bodyPath, after: readFileSync(bodyPath, 'utf8') };
}

test('GU1: GREEN names an ancestor of HEAD and every gate passes: the sha is rewritten, logged, and the stamp hashes the new file', async () => {
  const repo = mergedRepo();
  const before = greenBody({ green: repo.old });
  const { result, bodyPath, after } = await runWithBodyFile(repo, before);
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.equal(after, before.replace(`@ ${repo.old}\n\`\`\`text\nok 1`, `@ ${repo.head.slice(0, 7)}\n\`\`\`text\nok 1`), 'only the sha after @ on the GREEN line changed');
  assert.ok(result.lines.some((l) => l.includes(`GREEN updated ${repo.old.slice(0, 7)} -> ${repo.head.slice(0, 7)}`)), result.lines.join('\n'));
  assert.ok(result.lines.some((l) => /^PASS evidence/.test(l)), result.lines.join('\n'));
  const stamp = JSON.parse(readFileSync(stampFile(repo), 'utf8'));
  assert.equal(stamp.body_sha256, sha256(readFileSync(bodyPath, 'utf8')));
});

test('GU2: GREEN names a commit that is not an ancestor of HEAD: FAIL as before, the file is not touched', async () => {
  const repo = mergedRepo();
  const orphan = git(repo.dir, 'commit-tree', 'HEAD^{tree}', '-m', 'orphan');
  const before = greenBody({ green: orphan });
  const { result, after } = await runWithBodyFile(repo, before);
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => /GREEN names commit/.test(l)), result.lines.join('\n'));
  assert.equal(after, before);
  assert.equal(existsSync(stampFile(repo)), false);
});

test('GU3: a gate fails: the file is not touched and there is no stamp', async () => {
  const repo = mergedRepo();
  const before = greenBody({ green: repo.old });
  const { result, after } = await runWithBodyFile(repo, before, { exec: () => ({ status: 1, stdout: 'bad\n# fail 1\n', stderr: '' }) });
  assert.equal(result.ok, false);
  assert.equal(after, before);
  assert.equal(existsSync(stampFile(repo)), false);
});

test('GU4: another proof problem (no RED line) with a stale GREEN: the file is not touched', async () => {
  const repo = mergedRepo();
  const before = greenBody({ green: repo.old, withRed: false });
  const { result, after } = await runWithBodyFile(repo, before);
  assert.equal(result.ok, false);
  assert.equal(after, before);
});

test('GU5: a CRLF body keeps every CRLF and still gets the new sha', async () => {
  const repo = mergedRepo();
  const before = greenBody({ green: repo.old, nl: '\r\n' });
  const { result, bodyPath, after } = await runWithBodyFile(repo, before);
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.ok(after.includes(`@ ${repo.head.slice(0, 7)}`));
  assert.equal(after.split('\r').length, before.split('\r').length, 'the CR count is unchanged');
  assert.equal(after.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF');
  assert.equal(JSON.parse(readFileSync(stampFile(repo), 'utf8')).body_sha256, sha256(readFileSync(bodyPath, 'utf8')));
});

test('GU6: RED is never changed, and a GREEN-looking line inside a fenced block is left alone', async () => {
  const repo = mergedRepo();
  const decoy = `GREEN: \`x\` @ ${repo.old}`;
  const before = greenBody({ green: repo.old, redExtra: decoy, redSha: repo.old });
  const { result, after } = await runWithBodyFile(repo, before);
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.ok(after.includes(`RED: \`node --test x\` @ ${repo.old}\n`), 'RED keeps its sha');
  assert.ok(after.includes(`\n${decoy}\n`), 'the fenced line keeps its sha');
  assert.ok(after.includes(`GREEN: \`node --test x\` @ ${repo.head.slice(0, 7)}\n`));
});

// GU9 (CodeRabbit on #242): the body file was edited while the gates ran. The GREEN rewrite must not overwrite that edit;
// the run keeps the "GREEN names commit" FAIL and writes no stamp.
test('GU9: a body file edited during the run is not overwritten by the GREEN rewrite', async () => {
  const repo = mergedRepo();
  const before = greenBody({ green: repo.old });
  const bodyPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-body-')), 'body.md');
  writeFileSync(bodyPath, before);
  const edited = `${before}\nDave's note added during the run.\n`;
  const exec = () => { writeFileSync(bodyPath, edited); return { status: 0, stdout: 'ok\n', stderr: '' }; };
  const { result } = await prePr(repo, { bodyText: before, bodyPath, skipCr: true, exec });
  assert.equal(readFileSync(bodyPath, 'utf8'), edited, 'the edit made during the run survives');
  assert.equal(result.ok, false);
  assert.ok(result.lines.some((l) => /GREEN names commit/.test(l)), result.lines.join('\n'));
  assert.equal(existsSync(stampFile(repo)), false);
});

// ---------- GU7, GU8: a GREEN taken before an own change is not carried to the new head (review of PR flow quickfixes) ----------
// The rewrite is only for "the base was merged in". GU7: an own commit after the GREEN commit (linear, or after a merge of
// main) changed code that the GREEN run never saw. GU8: a merge of main whose conflict was resolved by hand holds code that
// nobody ran. In both, the old sha stays and the "GREEN names commit" FAIL stays; no stamp.

test('GU7: an own code commit after the GREEN commit: the sha is not rewritten, FAIL stays, no stamp', async () => {
  const kinds = {
    linear: () => makeRepo({ files: { 'misc/x.dat': 'x\n' } }),
    'after a merge of main': () => mergedRepo(),
  };
  for (const [name, make] of Object.entries(kinds)) {
    const repo = make();
    const old = repo.old ?? repo.head;
    writeFileSync(path.join(repo.dir, 'misc/x.dat'), 'changed after the GREEN run\n');
    git(repo.dir, 'add', '.');
    git(repo.dir, 'commit', '-q', '-m', 'own change after GREEN');
    const before = greenBody({ green: old });
    const { result, after } = await runWithBodyFile({ dir: repo.dir }, before);
    assert.equal(result.ok, false, `${name}: ${result.lines.join('\n')}`);
    assert.ok(result.lines.some((l) => /GREEN names commit/.test(l)), `${name}: ${result.lines.join('\n')}`);
    assert.equal(after, before, `${name}: the body file is unchanged`);
    assert.equal(existsSync(stampFile(repo)), false, `${name}: no stamp`);
  }
});

// GU8b (CodeRabbit round 2 on #242): a conflict resolved by taking one parent's version shows no combined diff, so
// diff-tree --cc reads it as clean. The resolved tree was never run: no rewrite.
test('GU8b: a conflict resolved by taking main\'s version whole is not a clean merge: no rewrite, no stamp', async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo.dir, 'README.md'), 'feature line\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'feature edits README');
  const old = git(repo.dir, 'rev-parse', 'HEAD');
  git(repo.dir, 'checkout', '-q', 'main');
  writeFileSync(path.join(repo.dir, 'README.md'), 'main line\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'main edits README');
  git(repo.dir, 'checkout', '-q', 'feat/x');
  const merge = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--no-edit', 'main'], { cwd: repo.dir, encoding: 'utf8', windowsHide: true });
  assert.notEqual(merge.status, 0, 'the merge must conflict');
  writeFileSync(path.join(repo.dir, 'README.md'), 'main line\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '--no-edit');
  const before = greenBody({ green: old });
  const { result, after } = await runWithBodyFile({ dir: repo.dir }, before);
  assert.equal(after, before, 'the GREEN line is not rewritten');
  assert.equal(result.ok, false, result.lines.join('\n'));
  assert.equal(existsSync(stampFile(repo)), false);
});

test('GU8: a merge of main with a hand-resolved conflict: the sha is not rewritten, FAIL stays, no stamp', async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo.dir, 'README.md'), 'feature line\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'feature edits README');
  const old = git(repo.dir, 'rev-parse', 'HEAD');
  git(repo.dir, 'checkout', '-q', 'main');
  writeFileSync(path.join(repo.dir, 'README.md'), 'main line\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'main edits README');
  git(repo.dir, 'checkout', '-q', 'feat/x');
  const merge = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--no-edit', 'main'], { cwd: repo.dir, encoding: 'utf8', windowsHide: true });
  assert.notEqual(merge.status, 0, 'the merge must conflict');
  writeFileSync(path.join(repo.dir, 'README.md'), 'a hand-written resolution that no run saw\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '--no-edit');
  const before = greenBody({ green: old });
  const { result, after } = await runWithBodyFile({ dir: repo.dir }, before);
  assert.equal(result.ok, false, result.lines.join('\n'));
  assert.ok(result.lines.some((l) => /GREEN names commit/.test(l)), result.lines.join('\n'));
  assert.equal(after, before);
  assert.equal(existsSync(stampFile(repo)), false);
});

// ---------- CLI spend log and daily cap ----------

const BILLED = { type: 'complete', status: 'review_completed', findings: 2, outcome: 'completed', usageCost: { billedFilesCount: 4, costCents: 100, unitPriceCents: 25, billingMethod: 'usage_credits' } };
const BILLED_OK = ev(CONTEXT, MAJOR, MINOR, BILLED);
const cliRows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const cliRowOf = (cost, at = '2026-10-27') => JSON.stringify({ ts: `${at}T10:00:00.000Z`, date: at, kind: 'cli', branch: 'feat/y', head: HEAD, files: 4, cost, session: 's' });
const seedLedger = (file, ...lines) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${lines.join('\n')}\n`); };

test('P1: usageCost is read from the complete record; a free run and every malformed value read as null', () => {
  assert.deepEqual(parseAgentStream(BILLED_OK).usageCost, { files: 4, costCents: 100, unitPriceCents: 25, method: 'usage_credits' });
  assert.equal(parseAgentStream(ev(CONTEXT, DONE)).usageCost, null, 'a free run has no usageCost');
  assert.deepEqual(usageCostOf({ usageCost: { costCents: 50 } }), { files: 0, costCents: 50, unitPriceCents: null, method: null }, 'a cost with no file count still counts');
  for (const bad of [{ costCents: '100' }, { costCents: 0 }, { costCents: -25 }, { costCents: 12.5 }, { costCents: null }, { costCents: Number.NaN }, { billedFilesCount: 4 }, { billedFilesCount: -1, costCents: 25 }, [], 'x', 7, null]) {
    assert.equal(usageCostOf({ usageCost: bad }), null, JSON.stringify(bad));
  }
  assert.equal(usageCostOf(null), null);
});

test('P2: a free run writes no ledger row', async () => {
  const f = crFixture();
  assert.equal((await runCodeRabbit(crOpts(f, { cliCapUsd: 3 }))).status, 'PASS');
  assert.equal(existsSync(f.ledgerPath), false);
});

test('P3: a billed run writes one cli row and the step line names the cost', async () => {
  const f = crFixture();
  f.runner.next = { status: 0, stdout: BILLED_OK, stderr: '' };
  const r = await runCodeRabbit(crOpts(f, { cliCapUsd: 3, now: new Date('2026-10-27T15:00:00Z') }));
  assert.equal(r.status, 'PASS');
  assert.match(r.detail, /2 finding\(s\) \(1 major, 1 minor\), billed \$1\.00 \(usage credits\)/);
  const rows = cliRows(f.ledgerPath);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], session: undefined }, { ts: '2026-10-27T15:00:00.000Z', date: '2026-10-27', kind: 'cli', branch: 'feat/x', head: HEAD, files: 4, cost: 1, session: undefined });
});

test('P4: a billed run that failed is still logged; a ledger that cannot be written adds a note and does not stop the step', async () => {
  const f = crFixture();
  const failed = ev(CONTEXT, { ...BILLED, outcome: 'failed' });
  f.runner.next = { status: 0, stdout: failed, stderr: '' };
  const r = await runCodeRabbit(crOpts(f));
  assert.equal(r.status, 'FAIL');
  assert.equal(cliRows(f.ledgerPath).length, 1);
  const g = crFixture();
  g.runner.next = { status: 0, stdout: BILLED_OK, stderr: '' };
  const dirAsFile = mkdtempSync(path.join(os.tmpdir(), 'prepr-ledgerdir-'));
  const r2 = await runCodeRabbit(crOpts(g, { ledgerPath: dirAsFile }));
  assert.equal(r2.status, 'PASS');
  assert.ok(r2.notes.some((n) => /could not log/i.test(n) && /\$1\.00/.test(n)), r2.notes.join('|'));
});

test('P5: at the cap the step SKIPs with cli-cap, names the total and the cap, and starts no run (no usage call either)', async () => {
  const f = crFixture();
  seedLedger(f.ledgerPath, cliRowOf(2), cliRowOf(1), cliRowOf(5, '2026-10-26'));
  const r = await runCodeRabbit(crOpts(f, { cliCapUsd: 3 }));
  assert.equal(r.status, 'SKIP');
  assert.equal(r.skipReason, 'cli-cap');
  assert.match(r.detail, /\$3\.00/);
  assert.match(r.detail, /daily cap of \$3\.00/);
  assert.equal(f.usageCalls.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(crPaths(f.root, 'feat/x').counter), false, 'no slot counted');
  assert.equal(existsSync(crPaths(f.root, 'feat/x').lock), false);
});

test('P6: under the cap the run goes ahead; with no cap configured a full ledger does not stop it', async () => {
  const f = crFixture();
  seedLedger(f.ledgerPath, cliRowOf(2.75));
  assert.equal((await runCodeRabbit(crOpts(f, { cliCapUsd: 3 }))).status, 'PASS');
  assert.equal(f.calls.length, 1);
  const g = crFixture();
  seedLedger(g.ledgerPath, cliRowOf(50));
  assert.equal((await runCodeRabbit(crOpts(g))).status, 'PASS');
  const h = crFixture();
  seedLedger(h.ledgerPath, 'not json');
  assert.equal((await runCodeRabbit(crOpts(h))).status, 'PASS', 'no cap: the ledger is not read');
});

test('P7: an unreadable ledger with a cap FAILs the step and starts no run', async () => {
  const f = crFixture();
  seedLedger(f.ledgerPath, 'not json');
  const r = await runCodeRabbit(crOpts(f, { cliCapUsd: 3 }));
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /ledger/i);
  assert.equal(f.usageCalls.length + f.calls.length, 0);
});

test('P8: runPrePr reads the cap from the config, stamps cli-cap, and the built hook accepts that stamp', async () => {
  const repo = withFork(makeRepo());
  const ledgerPath = tempLedger();
  const today = new Date();
  seedLedger(ledgerPath, cliRowOf(3, new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(today)));
  const config = { ...CONFIG, coderabbit: { ...CONFIG.coderabbit, cli_daily_cap_usd: 3 } };
  const { result, crCalls } = await prePr(repo, { ledgerPath, config, now: today });
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.equal(crCalls.length, 0);
  assert.equal(JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8')).cr_skip_reason, 'cli-cap');
  assert.equal(hookVerdict(repo.dir).allow, true);
  assert.notEqual(cliCapOf(CONFIG), null, 'the shipped config sets a cap');
});

// ---------- cost estimate before a run (Dave, 2026-11-06) ----------
// Remaining 0 stays rate-limited: no run, no estimate gate (Dave: NO to billed runs on an empty allowance). The estimate (every changed
// file x $0.25) applies only when the usage read is unavailable: today's spend plus the estimate over the cap SKIPs with cli-cap.

const srcFiles = (n) => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
const usageWith = (f, remaining) => { f.runner.usage = { status: 0, stdout: ev({ type: 'usage', remaining, fullCapacityInMs: 600000 }), stderr: '' }; };
const USAGE_DOWN = '{"type":"status","phase":"usage","status":"unavailable","organization":"Rev4nchist","includedReviews":{"state":"unavailable","reason":"lookup_failed"}}\n';
const usageDown = (f) => { f.runner.usage = { status: 1, stdout: USAGE_DOWN, stderr: '' }; };

test('CE1: remaining 0 SKIPs rate-limited even when the estimate is over the cap, and starts no run', async () => {
  // Breaks when: the estimate gate replaces rate-limited at remaining 0 (cli-cap), or remaining 0 lets a run start.
  const f = crFixture();
  usageWith(f, 0);
  const r = await runCodeRabbit(crOpts(f, { cliCapUsd: 3, changedPaths: srcFiles(16) }));
  assert.equal(r.status, 'SKIP');
  assert.equal(r.skipReason, 'rate-limited');
  assert.match(r.detail, /remaining 0/);
  assert.equal(f.usageCalls.length, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(crPaths(f.root, 'feat/x').counter), false, 'no slot counted');
});

test('CE2: remaining 0 SKIPs rate-limited even when the estimate fits under the cap', async () => {
  // Breaks when: a cap and a small estimate let a billed run start on an empty allowance.
  const f = crFixture();
  usageWith(f, 0);
  const r = await runCodeRabbit(crOpts(f, { cliCapUsd: 3, changedPaths: srcFiles(2) }));
  assert.equal(r.status, 'SKIP');
  assert.equal(r.skipReason, 'rate-limited');
  assert.equal(f.calls.length, 0);
});

test('CE3: unknown count: today\'s spend counts, so an estimate under the cap alone still SKIPs when spend plus estimate passes it', async () => {
  // Breaks when: the estimate is compared with the cap alone.
  const f = crFixture();
  usageDown(f);
  seedLedger(f.ledgerPath, cliRowOf(2));
  const r = await runCodeRabbit(crOpts(f, { cliCapUsd: 3, changedPaths: srcFiles(8) }));
  assert.equal(r.skipReason, 'cli-cap');
  assert.match(r.detail, /\$2\.00 plus today's paid CLI spend \$2\.00/);
  assert.equal(f.calls.length, 0);
});

test('CE4: remaining above 0 is unchanged: an estimate over the cap does not stop the run, and the run line still prints it', async () => {
  // Breaks when: the estimate gate also applies while included reviews are left.
  const f = crFixture();
  usageWith(f, 5);
  const lines = [];
  const r = await runCodeRabbit(crOpts(f, { cliCapUsd: 3, changedPaths: srcFiles(16), log: (m) => lines.push(m) }));
  assert.equal(r.status, 'PASS', r.detail);
  assert.equal(f.calls.length, 1);
  assert.ok(lines.some((m) => /16 file\(s\) x \$0\.25 = \$4\.00/.test(m) && /5/.test(m)), lines.join('\n'));
  assert.ok(r.notes.some((n) => /\$4\.00/.test(n)), 'the step line carries the estimate');
});

test('CE5: an unavailable usage read is an unknown count: over the cap SKIPs with cli-cap and names the estimate, under it runs and prints it', async () => {
  // Breaks when: unknown is treated as free (the old behaviour) or as rate-limited, or the run line drops the estimate.
  const over = crFixture();
  usageDown(over);
  const a = await runCodeRabbit(crOpts(over, { cliCapUsd: 3, changedPaths: srcFiles(16) }));
  assert.equal(a.skipReason, 'cli-cap');
  assert.match(a.detail, /16 file\(s\) x \$0\.25 = \$4\.00/);
  assert.match(a.detail, /unknown/);
  assert.equal(over.calls.length, 0);
  assert.equal(existsSync(crPaths(over.root, 'feat/x').counter), false, 'no slot counted');
  const under = crFixture();
  usageDown(under);
  const lines = [];
  const b = await runCodeRabbit(crOpts(under, { cliCapUsd: 3, changedPaths: srcFiles(8), log: (m) => lines.push(m) }));
  assert.equal(b.status, 'PASS', b.detail);
  assert.equal(under.calls.length, 1);
  assert.ok(lines.some((m) => /8 file\(s\) x \$0\.25 = \$2\.00/.test(m) && /unknown/.test(m)), lines.join('\n'));
  assert.ok(b.notes.some((n) => /\$2\.00/.test(n)), 'the step line carries the estimate');
});

test('CE6: the estimate counts every changed file, even ones .coderabbit.yaml path_filters exclude', async () => {
  // Breaks when: excluded files are dropped from the estimate (12 files = $3.00 passes a $2 cap; 4 files = $1.00 would not).
  const f = crFixture();
  usageDown(f);
  writeFileSync(path.join(f.root, '.coderabbit.yaml'), 'reviews:\n  path_filters:\n    - "!docs/**"\n');
  const docs = Array.from({ length: 8 }, (_, i) => `docs/d${i}.md`);
  const r = await runCodeRabbit(crOpts(f, { cliCapUsd: 2, changedPaths: [...docs, ...srcFiles(4)] }));
  assert.equal(r.skipReason, 'cli-cap');
  assert.match(r.detail, /12 file\(s\) x \$0\.25 = \$3\.00/);
  assert.equal(f.calls.length, 0);
});

test('CE7: an unknown count with no cap, or with no file list, runs as on main (no budget to compare)', async () => {
  // Breaks when: a missing cap or an unknown file list blocks a run the old code allowed.
  const noCap = crFixture();
  usageDown(noCap);
  assert.equal((await runCodeRabbit(crOpts(noCap, { changedPaths: srcFiles(100) }))).status, 'PASS');
  const noList = crFixture();
  usageDown(noList);
  assert.equal((await runCodeRabbit(crOpts(noList, { cliCapUsd: 3 }))).status, 'PASS');
  assert.equal(noCap.calls.length + noList.calls.length, 2);
});

test('CE8: runPrePr passes the changed files: an unknown count over the cap stamps cli-cap (P8 covers the hook accepting it)', async () => {
  // Breaks when: runPrePr does not give runCodeRabbit the changed file list.
  const repo = withFork(makeRepo({ files: { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' } }));
  const config = { ...CONFIG, coderabbit: { ...CONFIG.coderabbit, cli_daily_cap_usd: 0.25 } };
  const crCalls = [];
  const crRunner = (o) => { if (o.args[0] === 'usage') return { status: 1, stdout: USAGE_DOWN, stderr: '' }; crCalls.push(o); return { status: 0, stdout: NDJSON_OK, stderr: '' }; };
  const { result } = await prePr(repo, { config, crRunner, bodyText: harnessBody(repo.head) });
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.equal(crCalls.length, 0);
  const stamp = JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8'));
  assert.equal(stamp.cr_skip_reason, 'cli-cap');
  assert.match(result.results.find((r) => r.step === 'coderabbit').detail, /2 file\(s\) x \$0\.25 = \$0\.50/);
});

// ---------- zizmor advisory (one-week trial: it never fails pre-pr) ----------

const harnessBody = (head) => `## Evidence\n\nProof type: harness\n\nRED: \`x\` @ ${'b'.repeat(40)}\n\`\`\`text\nred\n\`\`\`\n\nGREEN: \`x\` @ ${head}\n\`\`\`text\ngreen\n\`\`\`\n`;
const ZIZMOR_OUT = JSON.stringify([{ ident: 'unpinned-uses', determinations: { severity: 'High' }, locations: [{ symbolic: { kind: 'Primary', key: { Local: { verbatim_path: '.github/workflows/a.yml' } } }, concrete: { location: { start_point: { row: 6, column: 0 } } } }] }]);

test('Z-PP1: a workflow change adds one NOTE zizmor line with the counts, and exit 14 from zizmor does not fail the run', async () => {
  // Breaks when: the advisory is not wired into runPrePr, or its exit code or findings are turned into a FAIL.
  const repo = makeRepo({ files: { '.github/workflows/a.yml': 'name: a\n' } });
  const calls = [];
  const { result } = await prePr(repo, { bodyText: harnessBody(repo.head), skipCr: true, findZizmor: () => 'ZBIN', zizmorRun: (bin, args) => { calls.push([bin, ...args]); return { status: 14, stdout: ZIZMOR_OUT, stderr: '' }; } });
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.deepEqual(calls, [['ZBIN', '--offline', '--strict-collection', '--format', 'json', '.github/workflows/a.yml']]);
  const step = result.results.find((r) => r.step === 'zizmor');
  assert.equal(step.status, 'NOTE');
  assert.match(step.detail, /1 High/);
  assert.match(step.detail, /a\.yml:7/);
});

test('Z-PP2: no workflow change means no zizmor step and no zizmor run', async () => {
  // Breaks when: the advisory runs on every branch.
  const repo = makeRepo();
  let ran = 0;
  const { result } = await prePr(repo, { findZizmor: () => 'ZBIN', zizmorRun: () => { ran += 1; return { status: 0, stdout: '[]', stderr: '' }; } });
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.equal(ran, 0);
  assert.equal(result.results.some((r) => r.step === 'zizmor'), false);
});

test('Z-PP3: a workflow change with no zizmor binary passes with a skip note', async () => {
  // Breaks when: a missing binary fails the run.
  const repo = makeRepo({ files: { '.github/workflows/a.yml': 'name: a\n' } });
  const { result } = await prePr(repo, { bodyText: harnessBody(repo.head), skipCr: true, findZizmor: () => null, zizmorRun: () => { throw new Error('must not run'); } });
  assert.equal(result.ok, true, result.lines.join('\n'));
  const step = result.results.find((r) => r.step === 'zizmor');
  assert.equal(step.status, 'NOTE');
  assert.match(step.detail, /skipped/);
});

// ---------- osv and pssa advisories (one-week trial: they never fail pre-pr) ----------

const osvBaseline = JSON.stringify({ tool: 'osv', reason: 't', total: 0, counts: {} });
const osvOut = (root) => JSON.stringify({ results: [{ source: { path: `${root.replace(/\\/g, '/')}/package-lock.json`, type: 'lockfile' }, packages: [{ package: { name: 'vite', version: '1', ecosystem: 'npm' }, groups: [{ ids: ['GHSA-x'], aliases: [], max_severity: '8.1' }] }] }] });

test('OSV-PP1: a tracked lockfile adds one NOTE osv line on any change, and an osv exit 1 does not fail the run', async () => {
  // Breaks when: the advisory is not wired into runPrePr, runs only when a lockfile changed, or turns exit 1 or a finding into a FAIL.
  const repo = makeRepo({ files: { 'package-lock.json': '{}\n', 'scripts/ratchets/osv-baseline.json': osvBaseline } });
  const calls = [];
  const { result } = await prePr(repo, { bodyText: harnessBody(repo.head), skipCr: true, osvLockfiles: ['package-lock.json'], findOsv: () => 'OBIN', osvRun: (bin, args, opts) => { calls.push([bin, ...args]); return { status: 1, stdout: osvOut(opts.cwd), stderr: '' }; } });
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.deepEqual(calls, [['OBIN', 'scan', 'source', '--format', 'json', '-L', 'package-lock.json']]);
  const step = result.results.find((r) => r.step === 'osv');
  assert.equal(step.status, 'NOTE');
  assert.match(step.detail, /1 high\/unscored advisory group\(s\) in 1 lockfile\(s\), baseline 0, new 1, drift 0/);
});

test('OSV-PP2: with the default lockfile lookup (git ls-files), no tracked lockfile means no osv step and no osv run; a tracked one is found', async () => {
  // Breaks when: osv runs (or prints a line) for a repo with no lockfile, which would add a line to every pre-pr, or the default lookup finds nothing.
  const repo = makeRepo();
  let ran = 0;
  const { result } = await prePr(repo, { osvLockfiles: undefined, findOsv: () => 'OBIN', osvRun: () => { ran += 1; return { status: 0, stdout: '{"results":[]}', stderr: '' }; } });
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.equal(ran, 0);
  assert.equal(result.results.some((r) => r.step === 'osv'), false);
  // The lookup does see a tracked lockfile: no binary, so the step is a skip note and nothing starts.
  const locked = makeRepo({ files: { 'package-lock.json': '{}\n' } });
  const second = await prePr(locked, { bodyText: featureBody(locked.head), skipCr: true, osvLockfiles: undefined, findOsv: () => null, osvRun: () => { ran += 1; return {}; } });
  assert.match(second.result.results.find((r) => r.step === 'osv').detail, /^skipped: osv-scanner not found/);
  assert.equal(ran, 0);
});

test('OSV-PP3: a network failure (osv exit 127) or a missing binary passes with a skip note', async () => {
  // Breaks when: osv-scanner failing to reach osv.dev, or not being installed, fails the run.
  const repo = makeRepo({ files: { 'package-lock.json': '{}\n', 'scripts/ratchets/osv-baseline.json': osvBaseline } });
  const net = await prePr(repo, { bodyText: harnessBody(repo.head), skipCr: true, osvLockfiles: ['package-lock.json'], findOsv: () => 'OBIN', osvRun: () => ({ status: 127, stdout: '', stderr: 'failed to fetch api.osv.dev' }) });
  assert.equal(net.result.ok, true, net.result.lines.join('\n'));
  assert.match(net.result.results.find((r) => r.step === 'osv').detail, /^skipped: osv-scanner could not run/);
  const none = await prePr(repo, { bodyText: harnessBody(repo.head), skipCr: true, osvLockfiles: ['package-lock.json'], findOsv: () => null, osvRun: () => { throw new Error('must not run'); } });
  assert.equal(none.result.ok, true, none.result.lines.join('\n'));
  assert.match(none.result.results.find((r) => r.step === 'osv').detail, /^skipped: osv-scanner not found/);
});

test('PSSA-PP1: a changed .ps1 adds one NOTE pssa line with the counts, and findings do not fail the run', async () => {
  // Breaks when: the advisory is not wired into runPrePr, or its findings or exit code become a FAIL.
  const repo = makeRepo({ files: { 'scripts/x.ps1': 'Write-Output 1\n', 'PSScriptAnalyzerSettings.psd1': '@{}\n' } });
  const calls = [];
  const out = (root) => JSON.stringify([{ RuleName: 'PSAvoidUsingEmptyCatchBlock', Severity: 'Warning', ScriptPath: path.join(root, 'scripts', 'x.ps1'), Line: 3 }]);
  const { result } = await prePr(repo, { bodyText: harnessBody(repo.head), skipCr: true, findPssa: () => 'MOD', pssaRun: (bin, args, opts) => { calls.push(bin); return { status: 0, stdout: [MARKER, out(opts.cwd)].join('\n'), stderr: '' }; } });
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.deepEqual(calls, ['pwsh']);
  const step = result.results.find((r) => r.step === 'pssa');
  assert.equal(step.status, 'NOTE');
  assert.match(step.detail, /1 finding\(s\): 1 Warning; top: scripts\/x\.ps1:3 PSAvoidUsingEmptyCatchBlock/);
});

test('PSSA-PP2: no .ps1 change means no pssa step and no pwsh run; a missing module passes with a skip note', async () => {
  // Breaks when: pssa runs on every branch, or a missing module fails the run.
  let ran = 0;
  const plain = await prePr(makeRepo(), { findPssa: () => 'MOD', pssaRun: () => { ran += 1; return { status: 0, stdout: '[]', stderr: '' }; } });
  assert.equal(plain.result.ok, true, plain.result.lines.join('\n'));
  assert.equal(ran, 0);
  assert.equal(plain.result.results.some((r) => r.step === 'pssa'), false);
  const repo = makeRepo({ files: { 'scripts/x.ps1': 'Write-Output 1\n' } });
  const miss = await prePr(repo, { bodyText: harnessBody(repo.head), skipCr: true, findPssa: () => null, pssaRun: () => { throw new Error('must not run'); } });
  assert.equal(miss.result.ok, true, miss.result.lines.join('\n'));
  assert.match(miss.result.results.find((r) => r.step === 'pssa').detail, /^skipped: PSScriptAnalyzer not found/);
});

// ---------- pre-pr fixes (Dave, 2026-11-04): fail-fast, cheap gates first, CR cap on new code, log per run ----------
// How each part can fail, and the test that catches it (written before the code):
//   a git:behind FAIL still runs every gate (no fail-fast)                                  -> FF1
//   --keep-going no longer runs every gate after a FAIL                                     -> FF2
//   a cheap gate runs after the costly ones                                                 -> FF3
//   a failing cheap gate does not stop the costly gates                                     -> FF4
//   a stale GREEN after a clean merge of main stops the gates (the rewrite needs them);
//     a stale GREEN that cannot be rewritten does not stop them                             -> FF5, GU1
//   the behind FAIL does not name the commands                                              -> FF6
//   a docs-only, merge-only or hand-resolved head is classed wrongly                        -> NC1..NC4
//   a run on a head with no new code uses a slot; a code head after it is capped            -> CAP1
//   the old counter file (no newCode field) stops counting                                  -> CAP2
//   the cap text says coderabbit-cli.md allows 2 per PR                                     -> CAP3
//   two runs on one head overwrite the first log                                            -> LOG1
//   the GREEN rewrite note does not say to PATCH an open PR body                            -> GU1b

const commitFile = (repo, name, text, msg = `edit ${name}`) => {
  mkdirSync(path.dirname(path.join(repo.dir, name)), { recursive: true });
  writeFileSync(path.join(repo.dir, name), text);
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', msg);
  return git(repo.dir, 'rev-parse', 'HEAD');
};
const forkAhead = (repo) => git(repo.dir, 'update-ref', 'refs/remotes/fork/main', git(repo.dir, 'commit-tree', 'main^{tree}', '-p', 'main', '-m', 'ahead'));
const recordingExec = (runs, failIds = []) => (spec) => {
  runs.push(spec.id);
  return failIds.includes(spec.id) ? { status: 1, stdout: 'bad\n# fail 1\n', stderr: '' } : { status: 0, stdout: 'ran\nTests  1 passed (1)\n', stderr: '' };
};

test('FF1: by default a git:behind FAIL stops the gates: each is a SKIP line, no gate runs, no stamp, the CLI review is skipped', async () => {
  const repo = makeRepo();
  forkAhead(repo);
  const runs = [];
  const { result, crCalls } = await prePr(repo, { exec: recordingExec(runs) });
  assert.equal(result.ok, false);
  assert.deepEqual(runs, [], 'no gate ran');
  const behind = result.lines.find((l) => /^FAIL git:behind/.test(l));
  assert.match(behind, /git fetch fork main.*git merge fork\/main.*pre-pr\.mjs again/, 'the FAIL names the exact commands, in order');
  assert.ok(result.lines.some((l) => /^SKIP gate:context-budget - not run: .*git:behind/.test(l)), result.lines.join('\n'));
  assert.match(result.lines.find((l) => /^SKIP coderabbit/.test(l)), /earlier step failed/);
  assert.doesNotMatch(result.lines.join('\n'), /limited to 2 per branch/);
  assert.equal(crCalls.length, 0);
  assert.equal(existsSync(stampFile(repo)), false);
});

test('FF2: --keep-going (keepGoing) runs every gate after a FAIL, as before', async () => {
  const repo = makeRepo();
  forkAhead(repo);
  const runs = [];
  const { result } = await prePr(repo, { exec: recordingExec(runs), keepGoing: true });
  assert.equal(result.ok, false);
  assert.deepEqual(runs, ['context-budget']);
  assert.ok(result.lines.some((l) => /^FAIL git:behind/.test(l)));
  assert.ok(!result.lines.some((l) => /^SKIP gate:/.test(l)), result.lines.join('\n'));
});

test('FF3: cheap gates come before the costly ones, in every change set', () => {
  const got = ids(gatesFor(['.claude/hooks/src/a.ts', '.claude/rules-src/a.md', '.claude/skills/x/SKILL.md', '.claude/agents/a.md', 'scripts/github/x.mjs']));
  const cheap = ['context-budget', 'ondemand-index', 'audit-skills', 'agent-model-drift', 'agent-body', 'no-pg-lookup'];
  for (const id of cheap) assert.ok(got.includes(id), id);
  const lastCheap = Math.max(...cheap.map((id) => got.indexOf(id)));
  const firstCostly = Math.min(...got.map((id, i) => (cheap.includes(id) ? Infinity : i)));
  assert.ok(lastCheap < firstCostly, got.join(' '));
});

test('FF4: a failing cheap gate stops the costly gates; each is a SKIP line that names the gate that failed', async () => {
  const repo = makeRepo({ files: { '.claude/hooks/src/a.ts': 'export {};\n' } });
  const runs = [];
  const { result } = await prePr(repo, { bodyText: featureBody(repo.head), skipCr: true, exec: recordingExec(runs, ['context-budget']) });
  assert.equal(result.ok, false);
  assert.deepEqual(runs, ['context-budget'], 'only the cheap gate ran');
  assert.ok(result.lines.some((l) => /^FAIL gate:context-budget/.test(l)));
  assert.ok(result.lines.some((l) => /^SKIP gate:hooks-vitest - not run: .*gate:context-budget/.test(l)), result.lines.join('\n'));
});

test('FF5: a stale GREEN that cannot be rewritten stops the gates; one a clean merge of main made still runs them', async () => {
  const repo = mergedRepo();
  const orphan = git(repo.dir, 'commit-tree', 'HEAD^{tree}', '-m', 'orphan');
  const runs = [];
  const stop = await runWithBodyFile(repo, greenBody({ green: orphan }), { exec: recordingExec(runs) });
  assert.equal(stop.result.ok, false);
  assert.deepEqual(runs, [], 'GREEN names a commit outside the branch: no rewrite is possible, so no gate runs');
  const again = [];
  const go = await runWithBodyFile(repo, greenBody({ green: repo.old }), { exec: recordingExec(again) });
  assert.equal(go.result.ok, true, go.result.lines.join('\n'));
  assert.deepEqual(again, ['context-budget'], 'the rewrite needs the gates');
});

test('GU1b: the GREEN rewrite note says the local file changed and an open PR body needs a PATCH', async () => {
  const repo = mergedRepo();
  const { result } = await runWithBodyFile(repo, greenBody({ green: repo.old }));
  const note = result.results.find((r) => r.step === 'evidence:green');
  assert.match(note.detail, /GREEN updated/);
  assert.match(note.detail, /PATCH the PR body/);
});

test('NC1: a path is not code when it is docs, evidence, a PR body or a test snapshot; rules, scripts and tests are code', () => {
  for (const p of ['docs/a.md', 'README.md', '.claudedocs/x.json', '.claudedocs/n/y.md', '.claudedocs/p.html', '.claudedocs/q.csv', '.claudedocs/r.txt', '.claude/cache/e2e/a.log', 'tests/__snapshots__/a.snap', 'src/b.test.ts.snap', 'pr-body-297.txt', 'x/pr-body.txt']) {
    assert.equal(PRE.isNonCodePath(p, CONFIG), true, p);
  }
  for (const p of ['scripts/a.mjs', '.claude/rules-ondemand/pr-review-loop.md', '.claude/hooks/src/a.ts', 'src/a.test.ts', 'CLAUDE.md', '.github/workflows/x.yml', 'src/pr-body.ts', '.claudedocs/y.sql', '.claudedocs/z.mjs', '.claudedocs/n/w.py']) {
    assert.equal(PRE.isNonCodePath(p, CONFIG), false, p);
  }
});

test('NC2: carriesNewCode reads the own commits since the last reviewed head: docs only is false, a code file is true', () => {
  const repo = makeRepo({ files: { 'misc/x.dat': 'x\n' } });
  const g = makeGit(repo.dir);
  const reviewed = repo.head;
  const docsHead = commitFile(repo, 'docs/b.md', 'b\n');
  assert.equal(PRE.carriesNewCode(g, 'main', reviewed, docsHead, CONFIG), false);
  const codeHead = commitFile(repo, 'misc/y.dat', 'y\n');
  assert.equal(PRE.carriesNewCode(g, 'main', reviewed, codeHead, CONFIG), true);
  assert.equal(PRE.carriesNewCode(g, 'main', docsHead, codeHead, CONFIG), true);
  assert.equal(PRE.carriesNewCode(g, 'main', codeHead, codeHead, CONFIG), false, 'same head: nothing new');
});

test('NC3: a clean merge of main that brings code is not new code; an own commit after it still is', () => {
  const repo = makeRepo({ files: { 'misc/x.dat': 'x\n' } });
  const g = makeGit(repo.dir);
  const reviewed = repo.head;
  git(repo.dir, 'checkout', '-q', 'main');
  commitFile(repo, 'scripts/from-main.mjs', 'export {};\n');
  git(repo.dir, 'checkout', '-q', 'feat/x');
  git(repo.dir, 'merge', '-q', '--no-edit', 'main');
  const merged = git(repo.dir, 'rev-parse', 'HEAD');
  assert.equal(PRE.carriesNewCode(g, 'main', reviewed, merged, CONFIG), false);
  const own = commitFile(repo, 'misc/z.dat', 'z\n');
  assert.equal(PRE.carriesNewCode(g, 'main', reviewed, own, CONFIG), true);
});

test('NC4: a hand-edited merge, an unknown sha and a non-git folder count as new code (never a free run on a guess)', () => {
  const repo = makeRepo({ files: { 'misc/x.dat': 'x\n' } });
  const g = makeGit(repo.dir);
  const reviewed = repo.head;
  git(repo.dir, 'checkout', '-q', 'main');
  commitFile(repo, 'later.md', 'later\n');
  git(repo.dir, 'checkout', '-q', 'feat/x');
  git(repo.dir, 'merge', '-q', '--no-commit', '--no-ff', 'main');
  writeFileSync(path.join(repo.dir, 'misc', 'evil.dat'), 'smuggled\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'merge with an edit of its own');
  const evil = git(repo.dir, 'rev-parse', 'HEAD');
  assert.equal(PRE.carriesNewCode(g, 'main', reviewed, evil, CONFIG), true);
  assert.equal(PRE.carriesNewCode(g, 'main', '1'.repeat(40), evil, CONFIG), true);
  assert.equal(PRE.carriesNewCode(makeGit(mkdtempSync(path.join(os.tmpdir(), 'prepr-nogit-'))), 'main', reviewed, evil, CONFIG), true);
});

test('NC5: a code file moved to a docs path still counts as code (the old path is listed)', () => {
  const repo = makeRepo({ files: { 'misc/x.dat': 'x\n' } });
  const g = makeGit(repo.dir);
  const reviewed = repo.head;
  mkdirSync(path.join(repo.dir, 'docs'), { recursive: true });
  git(repo.dir, 'mv', 'misc/x.dat', 'docs/x.md');
  git(repo.dir, 'commit', '-q', '-m', 'move code into docs');
  assert.equal(PRE.carriesNewCode(g, 'main', reviewed, git(repo.dir, 'rev-parse', 'HEAD'), CONFIG), true);
});

test('CAP1: a head with only docs changes reuses the saved review of the last reviewed head: no runner call, no slot; a code head is reviewed; the next code head is capped', async () => {
  const repo = makeRepo({ files: { 'misc/x.dat': 'x\n' } });
  const f = crFixture();
  const run = (head) => runCodeRabbit({ root: repo.dir, branch: 'feat/x', head, base: 'main', now: f.now, runner: f.runner, config: CONFIG, ledgerPath: f.ledgerPath });
  assert.equal((await run(repo.head)).status, 'PASS');
  const docs = commitFile(repo, 'docs/b.md', 'b\n');
  const reused = await run(docs);
  assert.equal(reused.status, 'PASS');
  assert.match(reused.detail, new RegExp(`reused the saved CLI output for ${repo.head.slice(0, 7)}.*no new code`));
  assert.equal(f.calls.length, 1, 'no cr call for the docs head');
  assert.equal(JSON.parse(readFileSync(crPaths(repo.dir, 'feat/x').counter, 'utf8')).runs.length, 1, 'and no counter row');
  const code = commitFile(repo, 'misc/y.dat', 'y\n');
  const second = await run(code);
  assert.equal(second.status, 'PASS', `${second.status} ${second.detail}`);
  assert.equal(f.calls.length, 2);
  const capped = await run(commitFile(repo, 'misc/w.dat', 'w\n'));
  assert.equal(capped.skipReason, 'cap', 'two runs with new code are used');
  assert.doesNotMatch(capped.detail, /allows \d+ per PR/);
  assert.match(capped.detail, /pre-pr\.mjs.*new code/);
  assert.equal(f.calls.length, 2);
});

test('CAP4: with no saved review file, a docs-only head runs the CLI but uses no slot, so a later code head is still reviewed', async () => {
  const repo = makeRepo({ files: { 'misc/x.dat': 'x\n' } });
  const f = crFixture();
  const run = (head) => runCodeRabbit({ root: repo.dir, branch: 'feat/x', head, base: 'main', now: f.now, runner: f.runner, config: CONFIG, ledgerPath: f.ledgerPath });
  assert.equal((await run(repo.head)).status, 'PASS');
  const e2e = path.join(repo.dir, '.claude', 'cache', 'e2e');
  for (const n of readdirSync(e2e)) if (/pre-pr-cr-/.test(n)) unlinkSync(path.join(e2e, n));
  const docs = commitFile(repo, 'docs/b.md', 'b\n');
  assert.equal((await run(docs)).status, 'PASS');
  assert.equal(f.calls.length, 2, 'the fallback runs the CLI');
  const code = commitFile(repo, 'misc/y.dat', 'y\n');
  assert.equal((await run(code)).status, 'PASS');
  assert.equal(f.calls.length, 3);
  const rows = JSON.parse(readFileSync(crPaths(repo.dir, 'feat/x').counter, 'utf8')).runs;
  assert.deepEqual(rows.map((r) => r.newCode), [true, false, true]);
});

test('CAP5: a merge-only head (main brought code, no own commit) reuses the saved review through pre-pr: 0 runner calls, a PASS line that names the reviewed sha, a stamp that is not a skip', async () => {
  const repo = makeRepo({ files: { 'misc/x.dat': 'x\n' } });
  const first = await prePr(repo, { bodyText: featureBody(repo.head) });
  assert.equal(first.result.ok, true, first.result.lines.join('\n'));
  assert.equal(first.crCalls.length, 1);
  git(repo.dir, 'checkout', '-q', 'main');
  commitFile(repo, 'scripts/from-main.mjs', 'export {};\n');
  git(repo.dir, 'checkout', '-q', 'feat/x');
  git(repo.dir, 'merge', '-q', '--no-edit', 'main');
  const head = git(repo.dir, 'rev-parse', 'HEAD');
  const second = await prePr(repo, { bodyText: featureBody(head) });
  assert.equal(second.result.ok, true, second.result.lines.join('\n'));
  assert.equal(second.crCalls.length, 0, 'no cr review was started');
  assert.ok(second.result.lines.some((l) => new RegExp(`^PASS coderabbit - reused the saved CLI output for ${repo.head.slice(0, 7)}`).test(l)), second.result.lines.join('\n'));
  const stamp = JSON.parse(readFileSync(stampFile(repo), 'utf8'));
  assert.equal(stamp.head, head);
  assert.equal(stamp.cr_skipped, false);
});

test('CAP2: a counter row from before this change (no newCode field) counts', async () => {
  const repo = makeRepo({ files: { 'misc/x.dat': 'x\n' } });
  const f = crFixture();
  const { counter } = crPaths(repo.dir, 'feat/x');
  mkdirSync(path.dirname(counter), { recursive: true });
  writeFileSync(counter, JSON.stringify({ branch: 'feat/x', runs: [{ head: '1'.repeat(40), outcome: 'finished', complete: true }, { head: '2'.repeat(40), outcome: 'finished', complete: true }] }));
  const r = await runCodeRabbit({ root: repo.dir, branch: 'feat/x', head: repo.head, base: 'main', now: f.now, runner: f.runner, config: CONFIG });
  assert.equal(r.skipReason, 'cap');
  assert.equal(f.calls.length, 0);
});

test('LOG1: two runs on one head on one day keep two logs (the time is in the name)', async () => {
  const repo = makeRepo();
  const first = await prePr(repo, { skipCr: true, now: new Date(2026, 10, 4, 10, 0, 0) });
  writeFileSync(path.join(repo.dir, 'untracked.txt'), 'x');
  const second = await prePr(repo, { skipCr: true, now: new Date(2026, 10, 4, 10, 5, 7) });
  assert.notEqual(first.result.logPath, second.result.logPath);
  assert.ok(existsSync(first.result.logPath) && existsSync(second.result.logPath));
  assert.match(path.basename(second.result.logPath), new RegExp(`^2026-11-04-pre-pr-${repo.head.slice(0, 7)}-100507\\.log$`));
  assert.match(readFileSync(first.result.logPath, 'utf8'), /PASS git:clean/);
  assert.match(readFileSync(second.result.logPath, 'utf8'), /FAIL git:clean/);
});

// ---------- the env step (scripts/github/lib/env-step.mjs): a worktree has no node_modules ----------
// How it can fail, and the test that catches it:
//   a missing esbuild bin is not one ENV line, or the gate still runs                 -> EN1 (drop the step or its blocked set)
//   with --keep-going the other gates stop, or the blocked gate runs                  -> EN2
//   a missing pg is not named, or a repo that has it gets a line                      -> EN3 (judge pg on the own folder only)
//   a drift NOTE fails the run, or the lockfile text is not a FAIL                    -> EN4, EN5
//   a gate child in a worktree gets no NODE_PATH, or the primary gets one             -> EN6 (drop the env option of defaultExec)
//   a MODULE_NOT_FOUND gate FAIL has no ENV prefix, or a plain failure has one         -> EN7
const EN_FIX = 'ENV: this branch changes .claude/hooks/package-lock.json, so it needs its own npm ci in this worktree (Dave approves an install). The primary\'s packages would give a wrong green.';

/** Keeps untracked fake packages out of git:clean. */
function ignoreModules(repo) { writeFileSync(path.join(repo.dir, '.git', 'info', 'exclude'), 'node_modules/\n'); }
const fakeFile = (repo, rel, text = '{}') => { const f = path.join(repo.dir, ...rel.split('/')); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };

test('EN1: a hooks change with no esbuild is ONE ENV FAIL line, and no gate runs', async () => {
  const repo = makeRepo({ files: { '.claude/hooks/src/x.ts': '// x\n' } });
  const { result, gateRuns } = await prePr(repo, { envCheck: envStep, skipCr: true, bodyText: featureBody(repo.head) });
  const envLines = result.lines.filter((l) => /^\w+ env - /.test(l));
  assert.equal(envLines.length, 1, result.lines.join('\n'));
  // hooks-tsc comes first (it fails fast), so it owns the FAIL line; the other two missing needs are notes under it.
  assert.match(envLines[0], /^FAIL env - ENV: hooks-tsc needs tsc\. Tried .+This is the environment, not your change\. Fix: run `node scripts\/worktree\/shared-deps\.mjs --check` in /);
  assert.ok(result.lines.some((l) => /^ {4}ENV: hooks-build needs esbuild\./.test(l)), 'the second missing need is a note under the line');
  assert.ok(result.lines.some((l) => /^ {4}ENV: hooks-vitest needs vitest\./.test(l)), 'the third missing need is a note under the line');
  assert.ok(result.lines.some((l) => /^SKIP gate:hooks-build - not run: env failed/.test(l)), result.lines.join('\n'));
  assert.equal(gateRuns.includes('hooks-build'), false);
  assert.equal(gateRuns.length, 0, 'a run stops at the first FAIL');
  assert.equal(result.ok, false);
});

test('EN2: with --keep-going only the gate that misses its package is skipped', async () => {
  const repo = makeRepo({ files: { '.claude/hooks/src/x.ts': '// x\n' } });
  ignoreModules(repo);
  fakeFile(repo, '.claude/hooks/node_modules/.bin/esbuild', '#!/bin/sh\n');
  fakeFile(repo, '.claude/hooks/node_modules/.bin/esbuild.cmd', '@echo off\r\n');
  fakeFile(repo, '.claude/hooks/node_modules/.bin/tsc', '#!/bin/sh\n');
  fakeFile(repo, '.claude/hooks/node_modules/.bin/tsc.cmd', '@echo off\r\n');
  const { result, gateRuns } = await prePr(repo, { envCheck: envStep, skipCr: true, keepGoing: true, bodyText: featureBody(repo.head) });
  assert.ok(result.lines.some((l) => /^FAIL env - ENV: hooks-vitest needs vitest\./.test(l)), result.lines.join('\n'));
  assert.ok(gateRuns.includes('hooks-build'), 'the gate whose bin exists still runs');
  assert.equal(gateRuns.includes('hooks-vitest'), false);
  assert.ok(result.lines.some((l) => /^SKIP gate:hooks-vitest - not run: env failed/.test(l)));
});

test('EN3: a coordination change names a missing pg; with pg in place the step prints nothing and the gates run', async () => {
  const repo = makeRepo({ files: { 'scripts/coordination/x.mjs': '// x\n' } });
  ignoreModules(repo);
  // The step reads NODE_PATH at call time as its last lookup: a shell, or the env step of the pre-pr run that tests this file, may set one.
  const savedNodePath = process.env.NODE_PATH;
  delete process.env.NODE_PATH;
  let miss;
  try { miss = await prePr(repo, { envCheck: envStep, skipCr: true, bodyText: featureBody(repo.head) }); } finally { if (savedNodePath !== undefined) process.env.NODE_PATH = savedNodePath; }
  // github-tests (also selected by scripts/coordination, GR2) needs pg too and comes first: the FAIL line names it, a note line names the other.
  assert.ok(miss.result.lines.some((l) => /^FAIL env - ENV: github-tests needs pg\. Tried /.test(l)), miss.result.lines.join('\n'));
  assert.ok(miss.result.lines.some((l) => /^ {4}ENV: coordination-db-tests needs pg\. Tried /.test(l)), miss.result.lines.join('\n'));
  assert.equal(miss.gateRuns.includes('coordination-db-tests'), false);
  fakeFile(repo, '.claude/hooks/node_modules/pg/package.json', JSON.stringify({ name: 'pg', main: 'index.js' }));
  fakeFile(repo, '.claude/hooks/node_modules/pg/index.js', 'module.exports = {};\n');
  fakeFile(repo, 'node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '1.0.0' }));
  const ok = await prePr(repo, { envCheck: envStep, skipCr: true, bodyText: featureBody(repo.head) });
  assert.equal(ok.result.lines.some((l) => /^\w+ env - /.test(l)), false, ok.result.lines.join('\n'));
  assert.ok(ok.gateRuns.includes('coordination-db-tests'), ok.result.lines.join('\n'));
});

test('EN4: a drift NOTE never fails the run, and prints the line the plan names', async () => {
  const repo = makeRepo();
  const note = "installed typescript 5.9.3, lock says 7.0.2: run npm ci in .claude/hooks (Dave's yes)";
  const { result } = await prePr(repo, { envCheck: ({ gates }) => ({ ...NO_ENV({ gates }), note }) });
  assert.ok(result.lines.includes(`NOTE env - ${note}`), result.lines.join('\n'));
  assert.equal(result.ok, true, result.lines.join('\n'));
});

test('EN5: the lockfile text is a FAIL on the env step and blocks the stamp', async () => {
  const repo = makeRepo();
  const { result } = await prePr(repo, { skipCr: true, envCheck: ({ gates }) => ({ ...NO_ENV({ gates }), fail: EN_FIX }) });
  assert.ok(result.lines.includes(`FAIL env - ${EN_FIX}`), result.lines.join('\n'));
  assert.equal(result.ok, false);
  assert.equal(result.stampPath, null);
});

test('EN6: a gate child in a worktree gets the primary node_modules on NODE_PATH; the primary gets none', () => {
  const repo = makeRepo();
  ignoreModules(repo);
  fakeFile(repo, '.claude/hooks/node_modules/.package-lock.json');
  const wt = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-wt-')), 'wt');
  git(repo.dir, 'worktree', 'add', '-q', '-b', 'en6-wt', wt);
  const probe = (root, env) => PRE.defaultExec({ cmd: 'node', args: ['-e', 'process.stdout.write(process.env.NODE_PATH || "")'], cwd: root, root, timeoutMs: 30_000, ...(env ? { env } : {}) });
  const inWt = probe(wt);
  assert.equal(inWt.status, 0, inWt.stderr);
  assert.ok(inWt.stdout.split(path.delimiter).includes(path.join(repo.dir, '.claude', 'hooks', 'node_modules')), `NODE_PATH was "${inWt.stdout}"`);
  const inPrimary = probe(repo.dir);
  assert.equal(inPrimary.stdout, process.env.NODE_PATH ?? '', 'the primary inherits its env unchanged');
});

test('EN7: a gate that fails with a missing package gets the ENV prefix; a missing relative import and a plain failure do not', () => {
  const git0 = fakeGit({});
  const gate = gateById('coordination-db-tests');
  const run = (out) => runGate(gate, { root: REPO_ROOT, exec: execOut(1, out), git: git0 });
  const pkg = run("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pg' imported from x.mjs\n# fail 4\n");
  assert.equal(pkg.status, 'FAIL');
  assert.match(pkg.detail, /^ENV: exit 1: # fail 4\. This is the environment, not your change\. Fix: run `node scripts\/worktree\/shared-deps\.mjs --check` in /);
  assert.match(run("Error: Cannot find module 'pg'\ncode: 'MODULE_NOT_FOUND'\n# fail 4\n").detail, /^ENV: /);
  assert.match(run("Error [ERR_MODULE_NOT_FOUND]: Cannot find module './gone.mjs' imported from x.mjs\n# fail 4\n").detail, /^exit 1: /);
  assert.match(run('# fail 4\nAssertionError: expected 1\n').detail, /^exit 1: # fail 4$/);
});

test('EN8: the ratchet and the resolver tests are gates of their own surfaces', () => {
  assert.deepEqual(gatesFor(['scripts/coordination/lane.mjs']).filter((g) => g.id === 'no-pg-lookup').map((g) => g.args[0]), ['scripts/ratchets/no-pg-lookup.mjs']);
  assert.ok(gatesFor(['scripts/lib/resolve-deps.mjs']).some((g) => g.id === 'resolve-deps-tests'));
  assert.equal(gatesFor(['docs/a.md']).some((g) => g.id === 'no-pg-lookup'), false);
});

test('EN9: a change under scripts/worktree runs the shared-deps tests, and a docs change does not', () => {
  const gate = gatesFor(['scripts/worktree/shared-deps.mjs']).find((g) => g.id === 'shared-deps-tests');
  assert.ok(gate, 'shared-deps-tests is a gate of the worktree-scripts surface');
  assert.deepEqual(gate.args, ['--test', 'scripts/worktree/shared-deps.test.mjs']);
  assert.equal(gatesFor(['docs/a.md']).some((g) => g.id === 'shared-deps-tests'), false);
});

// ---------- gate-outcome log (one JSON row per step, append-only) ----------
// How it can fail, and the test that catches it:
//   a run writes no row, a row lacks a field, or the rows do not match the steps    -> GL1
//   a second run on the same head overwrites the first run's rows                   -> GL2
//   an unwritable log path changes the exit code, a verdict or the stamp            -> GL3
//   a FAIL step has another status in the row, or no wall time                      -> GL4
//   a token or the PR body reaches a row, or a detail passes 200 chars              -> GL5

const tempGateLog = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-gatelog-')), 'pre-pr-gates.jsonl');
const rowsOf = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const slowFail = (out = 'boom\n') => () => { const end = Date.now() + 15; while (Date.now() < end); return { status: 1, stdout: out, stderr: '' }; };

test('GL1: a run writes one row per step with ts, branch, head, base, run_id, step, status, ms and detail', async () => {
  const repo = makeRepo();
  const file = tempGateLog();
  const { result } = await prePr(repo, { gateLogPath: file });
  const rows = rowsOf(file);
  assert.equal(rows.length, result.results.length);
  assert.deepEqual(rows.map((r) => [r.step, r.status]), result.results.map((r) => [r.step, r.status]));
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['base', 'branch', 'detail', 'head', 'ms', 'run_id', 'status', 'step', 'ts']);
    assert.equal(r.head, repo.head);
    assert.equal(r.branch, 'feat/x');
    assert.equal(r.base, 'main');
    assert.ok(!Number.isNaN(Date.parse(r.ts)));
    assert.ok(['PASS', 'FAIL', 'SKIP', 'NOTE'].includes(r.status));
    assert.ok(r.ms === null || (Number.isInteger(r.ms) && r.ms >= 0), `ms of ${r.step} is ${r.ms}`);
    assert.equal(typeof r.detail, 'string');
  }
  assert.equal(new Set(rows.map((r) => r.run_id)).size, 1);
  assert.equal(typeof rows.find((r) => r.step === 'gate:context-budget').ms, 'number');
  assert.equal(typeof rows.find((r) => r.step === 'coderabbit').ms, 'number');
});

test('GL2: two runs on the same head append, and never overwrite the first run', async () => {
  const repo = makeRepo();
  const file = tempGateLog();
  await prePr(repo, { gateLogPath: file });
  const first = readFileSync(file, 'utf8');
  const n = rowsOf(file).length;
  await prePr(repo, { gateLogPath: file });
  const all = rowsOf(file);
  assert.equal(all.length, n * 2);
  assert.ok(readFileSync(file, 'utf8').startsWith(first), 'the first run rows are unchanged');
  assert.equal(new Set(all.map((r) => r.run_id)).size, 2);
});

test('GL3: an unwritable log path changes no exit status, verdict or stamp', async () => {
  const good = await prePr(makeRepo(), { gateLogPath: tempGateLog() });
  const blocker = tempGateLog();
  writeFileSync(blocker, 'a file where a folder should be\n');
  const repo = makeRepo();
  const bad = await prePr(repo, { gateLogPath: path.join(blocker, 'sub', 'log.jsonl') });
  assert.equal(bad.result.ok, good.result.ok);
  assert.equal(bad.result.ok, true);
  assert.deepEqual(bad.result.results.map((r) => [r.step, r.status]), good.result.results.map((r) => [r.step, r.status]));
  assert.ok(existsSync(path.join(repo.dir, STAMP_REL)), 'the stamp is still written');
  assert.equal(readFileSync(blocker, 'utf8'), 'a file where a folder should be\n');
});

test('GL4: a FAIL gate row has status FAIL and a wall time in ms', async () => {
  const file = tempGateLog();
  const { result } = await prePr(makeRepo(), { gateLogPath: file, exec: slowFail(), ...withGates(fakeGate('s1')) });
  assert.equal(result.ok, false);
  const row = rowsOf(file).find((r) => r.step === 'gate:s1');
  assert.equal(row.status, 'FAIL');
  assert.equal(typeof row.ms, 'number');
  assert.ok(row.ms >= 10, `ms was ${row.ms}`);
  // The review started beside the gate and ended on its own (it was SKIP earlier-step-failed; PRE_PR_SERIAL_CR=1 still gives that).
  assert.equal(rowsOf(file).find((r) => r.step === 'coderabbit').status, 'PASS');
  const serialFile = tempGateLog();
  await prePr(makeRepo(), { gateLogPath: serialFile, env: { PRE_PR_SERIAL_CR: '1' }, exec: slowFail(), ...withGates(fakeGate('s1')) });
  assert.equal(rowsOf(serialFile).find((r) => r.step === 'coderabbit').status, 'SKIP');
  // Card prepr-speed-bundle (O4): a FAIL of the cheap gate (context-budget) is logged with its time and the review is SKIP: it never started.
  const cheapFile = tempGateLog();
  await prePr(makeRepo(), { gateLogPath: cheapFile, exec: slowFail() });
  assert.equal(rowsOf(cheapFile).find((r) => r.step === 'gate:context-budget').status, 'FAIL');
  assert.equal(rowsOf(cheapFile).find((r) => r.step === 'coderabbit').status, 'SKIP');
});

test('GL5: a token and the PR body never reach a row, and a detail stops at 200 chars', async () => {
  const file = tempGateLog();
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  const body = 'Proof type: docs\nBODY-MARKER-9f3 private text\n';
  await prePr(makeRepo(), { gateLogPath: file, exec: slowFail(`${'x'.repeat(400)} token=${token}\nTests  1 failed (${token})\n`), bodyText: body });
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes(token), 'the token is gone');
  assert.ok(!text.includes('BODY-MARKER-9f3'), 'the body is not in the log');
  assert.ok(rowsOf(file).every((r) => r.detail.length <= 200));
});

test('GL6: the default log path honours PRE_PR_GATE_LOG, then falls back to the home logs folder', async () => {
  const { gateLogPath } = await import('./lib/gate-log.mjs');
  assert.equal(gateLogPath({ PRE_PR_GATE_LOG: path.join('somewhere', 'y.jsonl') }), path.join('somewhere', 'y.jsonl'));
  assert.equal(gateLogPath({ USERPROFILE: path.join('home', 't') }), path.join('home', 't', '.claude', 'logs', 'pre-pr-gates.jsonl'));
});

// ---------- step 2c: a note when a NEW CLI store marker has no git data ----------
// The CLI keeps each review at %LOCALAPPDATA%\coderabbit\reviews\<workspace>\<scope>\reviews\<id>\ with a .session-complete-v2 marker.
// A FAIL with unreviewed files plus a new marker with hasGitMetadata false gets ONE read-only note. It never changes a verdict.
// How it can fail, and the test that catches it (written before the code):
//   LOCALAPPDATA unset, empty or relative gives a path under the cwd (the `?? ''` pattern)      -> S2c-T0
//   listMarkers throws on a missing store, lists files or stray folders, or recurses              -> T2, T5h
//   a failed "before" snapshot reads as empty, so ~500 old markers look new                       -> T2b
//   readFlag treats a string "false", a missing or a broken marker as false                       -> T3
//   the own-root match breaks on slash, drive-letter case or trailing slash                       -> T4, T5b
//   a foreign marker suppresses the note, or is named in it                                       -> T5c, T5d
//   the note shows the user path or any file content                                              -> T5a, T5g
//   a marker folder is entered (a sentinel one level deeper is read)                              -> T5h
//   the note changes the status, detail, skipReason, run counter or notes of the step             -> T6, T8
//   a PASS run gets the note                                                                      -> T7
//   a throw in the snapshot or the diagnostic stops the step                                      -> T8
// Test names are S2c-<id> (the file already has T1..T7 for the runner). S2c-T0..T6 fail before the code. S2c-T7, S2c-T8 and N3 (untouched) guard behaviour that must not change.

const mkStore = () => mkdtempSync(path.join(os.tmpdir(), 'prepr-crstore-'));
const SENTINEL = 'SENTINEL-do-not-read-9f3c';
const NOTE = (key) => `a new CLI store marker has no git data (hasGitMetadata false): %LOCALAPPDATA%\\coderabbit\\reviews\\${key.split('/').join('\\')}; this can be a run of another project. The step still fails.`;
// The real marker shape: { version, state, hasGitMetadata, hasIncrementalDiff } (boolean flags). git.json holds workingDirectory (backslashes, C:).
function mkMarker(store, key, { flag = false, git = null, marker = null } = {}) {
  const dir = path.join(store, ...key.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.session-complete-v2'), JSON.stringify(marker ?? { version: 2, state: 'complete', hasGitMetadata: flag, hasIncrementalDiff: flag }));
  if (git !== null) writeFileSync(path.join(dir, 'git.json'), JSON.stringify({ workingDirectory: git, head: 'x' }));
}
const storeDeps = (store, extra = {}) => ({ root: store, list: PRE.listMarkers, diagnose: PRE.storeDiagnostic, ...extra });
const UNREVIEWED = ev(CONTEXT, MAJOR, { ...DONE, unreviewedFileCount: 8 });
// A runner that writes a marker into the store on the review call (not the usage call), like the real CLI does.
function crWriting(f, store, key, flag) {
  const inner = f.runner;
  f.runner = (o) => { if (o.args[0] !== 'usage') mkMarker(store, key, { flag }); return inner(o); };
}
const storeNotes = (r) => r.notes.filter((n) => /hasGitMetadata/.test(n));

test('S2c-T0: crStoreRoot is null for an unset, empty or relative LOCALAPPDATA, and joins an absolute one', () => {
  // Breaks when: crStoreRoot copies `env.LOCALAPPDATA ?? ''` (cursor-review.mjs:410): '' joins to a relative path under the cwd.
  assert.equal(PRE.crStoreRoot({}), null);
  assert.equal(PRE.crStoreRoot({ LOCALAPPDATA: undefined }), null);
  assert.equal(PRE.crStoreRoot({ LOCALAPPDATA: '' }), null);
  assert.equal(PRE.crStoreRoot({ LOCALAPPDATA: 'AppData' }), null);
  const abs = os.tmpdir();
  assert.equal(PRE.crStoreRoot({ LOCALAPPDATA: abs }), path.join(abs, 'coderabbit', 'reviews'));
});

test('S2c-T2: listMarkers lists workspace/scope/reviews/id keys at a fixed depth; a missing store is empty; a file as the store is null', () => {
  const s = mkStore();
  mkMarker(s, 'w1/s1/reviews/a');
  mkMarker(s, 'w1/s1/reviews/b');
  mkMarker(s, 'w2/s2/reviews/c');
  mkdirSync(path.join(s, 'w3', 's3'), { recursive: true }); // a scope with no reviews folder
  writeFileSync(path.join(s, '.checkpoint-compaction-v2'), 'x'); // a stray file next to the workspaces (real store)
  writeFileSync(path.join(s, 'w1', 'stray.txt'), 'x');
  writeFileSync(path.join(s, 'w1', 's1', 'reviews', 'stray.txt'), 'x');
  assert.deepEqual([...PRE.listMarkers(s)].sort(), ['w1/s1/reviews/a', 'w1/s1/reviews/b', 'w2/s2/reviews/c']);
  const none = PRE.listMarkers(path.join(s, 'nope'));
  assert.ok(none instanceof Set);
  assert.equal(none.size, 0);
  assert.equal(PRE.listMarkers(path.join(s, '.checkpoint-compaction-v2')), null);
});

test('S2c-T2b: a failed "before" or "after" snapshot (null) gives no message; the step with a null first listing gets no note', async () => {
  // Breaks when: null is read as an empty set, so every old marker looks new.
  const s = mkStore();
  mkMarker(s, 'w/s/reviews/old1');
  mkMarker(s, 'w/s/reviews/old2');
  const after = new Set(['w/s/reviews/old1', 'w/s/reviews/old2']);
  assert.equal(PRE.storeDiagnostic({ before: null, after, root: 'C:/x/wt', storeRoot: s }), null);
  assert.equal(PRE.storeDiagnostic({ before: new Set(), after: null, root: 'C:/x/wt', storeRoot: s }), null);
  const f = crFixture();
  f.runner.next = { status: 0, stdout: UNREVIEWED, stderr: '' };
  let calls = 0;
  const list = (r) => (calls++ === 0 ? null : PRE.listMarkers(r));
  const r = await runCodeRabbit(crOpts(f, { crStore: storeDeps(s, { list }) }));
  assert.equal(r.status, 'FAIL');
  assert.equal(storeNotes(r).length, 0);
});

test('S2c-T3: readFlag is true or false only for a boolean hasGitMetadata; a missing, broken or non-boolean marker is null', () => {
  const s = mkStore();
  mkMarker(s, 'w/s/reviews/t', { flag: true });
  mkMarker(s, 'w/s/reviews/f', { flag: false });
  mkMarker(s, 'w/s/reviews/str', { marker: { hasGitMetadata: 'false' } });
  mkMarker(s, 'w/s/reviews/nokey', { marker: { version: 2 } });
  mkdirSync(path.join(s, 'w', 's', 'reviews', 'empty'), { recursive: true });
  mkMarker(s, 'w/s/reviews/bad');
  writeFileSync(path.join(s, 'w', 's', 'reviews', 'bad', '.session-complete-v2'), '{not json');
  const at = (id) => PRE.readFlag(path.join(s, 'w', 's', 'reviews', id));
  assert.equal(at('t'), true);
  assert.equal(at('f'), false);
  assert.equal(at('str'), null);
  assert.equal(at('nokey'), null);
  assert.equal(at('empty'), null);
  assert.equal(at('bad'), null);
});

test('S2c-T4: normDir is a pure string function: slashes, drive-letter case and trailing slash', () => {
  assert.equal(PRE.normDir('C:\\Users\\x\\wt\\'), 'c:/Users/x/wt');
  assert.equal(PRE.normDir('c:/Users/x/wt'), 'c:/Users/x/wt');
  assert.equal(PRE.normDir('C:/Users/x/wt//'), 'c:/Users/x/wt');
  assert.equal(PRE.normDir('/home/x/wt/'), '/home/x/wt');
  assert.equal(PRE.normDir('/'), '/');
  assert.equal(PRE.normDir(null), '');
  assert.notEqual(PRE.normDir('C:/a/b'), PRE.normDir('C:/a/bc'));
});

const diag = (store, keys, root, before = new Set()) => PRE.storeDiagnostic({ before, after: new Set(keys), root, storeRoot: store });

test('S2c-T5a: one new marker with no git data gives the path-only note, in %LOCALAPPDATA% form, with no user or temp path', () => {
  const s = mkStore();
  mkMarker(s, 'ws1/sc1/reviews/id1', { flag: false });
  const note = diag(s, ['ws1/sc1/reviews/id1'], 'C:/work/wt');
  assert.equal(note, NOTE('ws1/sc1/reviews/id1'));
  assert.ok(!note.includes(os.tmpdir()), 'no expanded path');
  assert.ok(!note.includes(os.homedir()), 'no home path');
});

test('S2c-T5b: a new marker whose git.json names this root (any slash, drive case, trailing slash) gives no note', () => {
  for (const named of ['C:\\work\\wt', 'c:/work/wt/', 'C:/work/wt', 'c:\\work\\wt\\']) {
    const s = mkStore();
    mkMarker(s, 'w/s/reviews/bad', { flag: false });
    mkMarker(s, 'w/s/reviews/own', { flag: true, git: named });
    assert.equal(diag(s, ['w/s/reviews/bad', 'w/s/reviews/own'], 'C:/work/wt'), null, named);
  }
});

test('S2c-T5c: a foreign new marker (git.json names another dir) does not suppress the note and is not named in it', () => {
  const s = mkStore();
  mkMarker(s, 'w/s/reviews/bad', { flag: false });
  mkMarker(s, 'w/s/reviews/foreign', { flag: true, git: 'C:\\work\\other' });
  const note = diag(s, ['w/s/reviews/bad', 'w/s/reviews/foreign'], 'C:/work/wt');
  assert.equal(note, NOTE('w/s/reviews/bad'));
  assert.ok(!note.includes('foreign'));
});

test('S2c-T5d: a foreign marker alone gives no note, even with a false flag; no new marker gives none; two false markers give one note (the first by name)', () => {
  const s = mkStore();
  mkMarker(s, 'w/s/reviews/foreign', { flag: false, git: 'C:\\work\\other' });
  assert.equal(diag(s, ['w/s/reviews/foreign'], 'C:/work/wt'), null);
  const t = mkStore();
  mkMarker(t, 'w/s/reviews/old', { flag: false });
  assert.equal(diag(t, ['w/s/reviews/old'], 'C:/work/wt', new Set(['w/s/reviews/old'])), null, 'old marker is not new');
  const u = mkStore();
  mkMarker(u, 'w/s/reviews/b2', { flag: false });
  mkMarker(u, 'w/s/reviews/a1', { flag: false });
  assert.equal(diag(u, ['w/s/reviews/b2', 'w/s/reviews/a1'], 'C:/work/wt'), NOTE('w/s/reviews/a1'));
});

test('S2c-T5g: no file content reaches the note: a sentinel in the marker and in git.json is absent', () => {
  const s = mkStore();
  mkMarker(s, 'w/s/reviews/bad', { marker: { hasGitMetadata: false, note: SENTINEL } });
  writeFileSync(path.join(s, 'w', 's', 'reviews', 'bad', 'git.json'), JSON.stringify({ head: SENTINEL }));
  const note = diag(s, ['w/s/reviews/bad'], 'C:/work/wt');
  assert.equal(note, NOTE('w/s/reviews/bad'));
  assert.ok(!note.includes(SENTINEL));
});

test('S2c-T5h: a marker folder is never entered: a decoy one level deeper is not listed, not read, and cannot change the result', () => {
  // Breaks when: listMarkers or the diagnostic recurses into <id>/. The decoy git.json names this root: reading it would suppress the note.
  const s = mkStore();
  mkMarker(s, 'w/s/reviews/bad', { flag: false });
  mkMarker(s, 'w/s/reviews/bad/deeper', { flag: false, git: 'C:\\work\\wt' });
  writeFileSync(path.join(s, 'w', 's', 'reviews', 'bad', 'deeper', 'diff.txt'), SENTINEL);
  mkMarker(s, 'w/s/reviews/good', { flag: true });
  mkMarker(s, 'w/s/reviews/good/deeper', { flag: false });
  const keys = PRE.listMarkers(s);
  assert.deepEqual([...keys].sort(), ['w/s/reviews/bad', 'w/s/reviews/good']);
  const note = PRE.storeDiagnostic({ before: new Set(), after: keys, root: 'C:/work/wt', storeRoot: s });
  assert.equal(note, NOTE('w/s/reviews/bad'));
  assert.ok(!note.includes('deeper') && !note.includes(SENTINEL));
  assert.equal(PRE.storeDiagnostic({ before: new Set(['w/s/reviews/bad']), after: keys, root: 'C:/work/wt', storeRoot: s }), null, 'the good marker has git data; its decoy is unread');
});

test('S2c-T6: a FAIL with unreviewed files and a new marker with no git data gets one note; verdict, skipReason and run count do not change', async () => {
  const f = crFixture();
  const s = mkStore();
  mkMarker(s, 'old/s/reviews/1', { flag: true, git: 'C:\\other' });
  f.runner.next = { status: 0, stdout: UNREVIEWED, stderr: '' };
  crWriting(f, s, 'w/s/reviews/new', false);
  const r = await runCodeRabbit(crOpts(f, { crStore: storeDeps(s) }));
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /INCOMPLETE/);
  assert.equal(r.skipReason, undefined);
  assert.deepEqual(storeNotes(r), [NOTE('w/s/reviews/new')]);
  assert.equal(f.calls.length, 1);
  const counter = JSON.parse(readFileSync(crPaths(f.root, 'feat/x').counter, 'utf8'));
  assert.equal(counter.runs.length, 1, 'the run is counted');
  assert.equal(counter.runs[0].outcome, 'failed');
});

test('S2c-T7: a PASS run whose runner writes a new marker with no git data gets no note', async () => {
  const f = crFixture();
  const s = mkStore();
  crWriting(f, s, 'w/s/reviews/new', false);
  const r = await runCodeRabbit(crOpts(f, { crStore: storeDeps(s) }));
  assert.equal(r.status, 'PASS');
  assert.equal(storeNotes(r).length, 0);
  // Breaks when: the unreviewedFileCount > 0 condition is dropped. A FAIL with no unreviewed count (a failed outcome) gets no note.
  const g = crFixture();
  const t = mkStore();
  g.runner.next = { status: 0, stdout: ev(CONTEXT, MAJOR, { ...DONE, outcome: 'failed', message: 'server error' }), stderr: '' };
  crWriting(g, t, 'w/s/reviews/new', false);
  const failed = await runCodeRabbit(crOpts(g, { crStore: storeDeps(t) }));
  assert.equal(failed.status, 'FAIL');
  assert.equal(storeNotes(failed).length, 0);
});

test('S2c-T6b: with the note, only one note is added: status, detail, skipReason and counter equal the empty-store run', async () => {
  const baseline = await t8Run((s) => storeDeps(s), false);
  const noted = await t8Run((s) => storeDeps(s), true);
  assert.equal(noted.notes.at(-1), NOTE('w/s/reviews/new'));
  assert.deepEqual({ ...noted, notes: noted.notes.slice(0, -1) }, baseline);
});

test('S2c-T6c: runPrePr hands its crStore to the CodeRabbit step (the snapshot reads the store it was given)', async () => {
  // Breaks when: runPrePr drops crStore from its runCodeRabbit call (every prePr() test would then read the live store).
  const s = mkStore();
  const seen = [];
  const crStore = { root: s, list: (r) => { seen.push(r); return PRE.listMarkers(r); }, diagnose: PRE.storeDiagnostic };
  const { crCalls } = await prePr(makeRepo(), { crStore });
  assert.equal(crCalls.length, 1);
  assert.ok(seen.length >= 1 && seen.every((r) => r === s), JSON.stringify(seen));
});

async function t8Run(deps, writes) {
  const f = crFixture();
  const s = mkStore();
  f.runner.next = { status: 0, stdout: UNREVIEWED, stderr: '' };
  if (writes) crWriting(f, s, 'w/s/reviews/new', false);
  const r = await runCodeRabbit(crOpts(f, { crStore: deps(s) }));
  const counter = readFileSync(crPaths(f.root, 'feat/x').counter, 'utf8');
  return { status: r.status, detail: r.detail, skipReason: r.skipReason, notes: r.notes, counter, calls: f.calls.length };
}

test('S2c-T8: a throw in the snapshot, in the second listing or in the diagnostic gives the same step as an empty-store run', async () => {
  // Breaks when: a try is removed (the step rejects) or a throw changes the status, detail, skipReason, notes or run counter.
  const baseline = await t8Run((s) => storeDeps(s), false);
  assert.equal(baseline.status, 'FAIL');
  const boom = () => { throw new Error('boom'); };
  const listThrowsOn = (n) => (s) => { let c = 0; return storeDeps(s, { list: (r) => { if (c++ === n) boom(); return PRE.listMarkers(r); } }); };
  const variants = { snapshot: listThrowsOn(0), 'second listing': listThrowsOn(1), diagnostic: (s) => storeDeps(s, { diagnose: boom }), 'no store root': () => storeDeps(null) };
  for (const [name, deps] of Object.entries(variants)) {
    assert.deepEqual(await t8Run(deps, true), baseline, name);
  }
});

// ---------- answer-key guard (card prepr-answer-key-cli-guard): no CLI review reads an answer-key path ----------
// The match list is the frozen ANSWER_KEY_GLOBS; REVIEW.md "## Skip paths" is only the drift alarm (A13). The guard runs in runCodeRabbit before the lock, the counter
// and the CLI, on the paths of BOTH sides of the change (a delete or a rename names its old path too). A hit is a SKIP "answer-key" (an earned
// skip: the stamp gets cr_answer_key true and answer_key_paths N, and the gate accepts it only with both). An unreadable list, a null list and a
// failed git read stay a FAIL. How it can fail, and the test:
//   a gold, seeds, rubrics or labels path reaches the CLI; the guard runs after the lock or the counter          -> A1
//   a prefix match blocks linktype-labels.json.bak or review-eval/gold.mjs, or misses a glob                      -> A2
//   REVIEW.md missing, unreadable, with no section, or with no answer-key glob lets the run go                      -> A3
//   a null changed list lets the run go                                                                           -> A4
//   the live list drifts from cursor-review.mjs TREE_EXCLUDES                                                       -> A5
//   a clean diff is blocked                                                                                       -> A6
//   a delete or a rename out of gold/ shows only the new path (git diff --name-only follows renames)              -> A7, A8
//   Gold/ or a backslash path slips past the match                                                                -> A9
//   runPrePr does not pass the both-sides list, or reads a failed git as "no paths"                               -> A7, A10
const GOLD = 'scripts/eval/review-eval/gold/g.json';
const KEY_TAIL = /Fix REVIEW\.md or the git read, then run pre-pr again\.$/;
// A REVIEW.md "Skip paths" block with the four answer-key globs (the live one) plus extra lines.
const reviewMdWith = (extra) => REVIEW_MD.replace(/(## Skip paths\s+```\r?\n)/, `$1${extra}\n`);

test('A1: a diff with an answer-key path is SKIPped (answer-key) before the lock, the counter and the CLI; the detail names the first path and the count', async () => {
  const f = crFixture();
  // A live lock held by another run: a guard that sat after the lock would answer "a run is in progress" instead.
  const p = crPaths(f.root, 'feat/x');
  mkdirSync(path.dirname(p.lock), { recursive: true });
  const lockText = JSON.stringify({ pid: process.pid, head: 'other', at: new Date(f.now.getTime() - 60_000).toISOString() });
  writeFileSync(p.lock, lockText);
  const r = await runCodeRabbit(crOpts(f, { changedPaths: ['src/a.ts', GOLD, 'scripts/eval/review-eval/seeds/s.json'] }));
  assert.equal(r.status, 'SKIP');
  assert.doesNotMatch(r.detail, /in progress/);
  assert.equal(r.skipReason, 'answer-key');
  assert.equal(r.answerKeyPaths, 2);
  assert.match(r.detail, new RegExp(`${GOLD.replaceAll('/', '\\/')}, 2 in all`));
  assert.match(r.detail, /internal review and a seat diff read replace the CLI/);
  assert.ok(!r.detail.includes('seeds/s.json'), 'only the first path is named');
  assert.equal(f.calls.length + f.usageCalls.length, 0, 'the CLI is never called, not even the usage check');
  assert.equal(existsSync(p.counter), false, 'no run counted');
  assert.equal(readFileSync(p.lock, 'utf8'), lockText, 'the other run keeps its lock');
});

test('A2: seeds, rubrics, linktype-labels.json and gold match by whole glob; a .bak, gold.mjs and a sibling folder do not', () => {
  const block = (p) => PRE.answerKeyBlock({ root: REPO_ROOT, paths: [p] });
  for (const p of ['scripts/eval/review-eval/seeds/s.json', 'scripts/eval/review-eval/rubrics/deep/r.md', 'scripts/eval/review-eval/linktype-labels.json', GOLD]) {
    assert.match(block(p) ?? '', /answer-key path/, p);
  }
  for (const p of ['scripts/eval/review-eval/linktype-labels.json.bak', 'scripts/eval/review-eval/gold.mjs', 'scripts/eval/review-eval/goldx/a.json', 'scripts/eval/review-eval/lib.mjs', 'src/gold/g.json']) {
    assert.equal(block(p), null, p);
  }
});

test('A3: REVIEW.md missing, unreadable, without the section, or without an answer-key glob FAILs and never calls the CLI', async () => {
  const bad = {
    missing: (root) => rmSync(path.join(root, 'REVIEW.md')),
    unreadable: (root) => { rmSync(path.join(root, 'REVIEW.md')); mkdirSync(path.join(root, 'REVIEW.md')); },
    'no section': (root) => writeFileSync(path.join(root, 'REVIEW.md'), '# Review\n\nno list here\n'),
    'no answer-key glob': (root) => writeFileSync(path.join(root, 'REVIEW.md'), '# Review\n\n## Skip paths\n\n```\ndocs/**\nscripts/eval/review-eval-other/**\n```\n'),
    // The match list is a constant of the four globs; REVIEW.md is the drift alarm. One missing glob, or one wide glob instead, is a FAIL.
    'three of four globs': (root) => writeFileSync(path.join(root, 'REVIEW.md'), '# Review\n\n## Skip paths\n\n```\ndocs/**\nscripts/eval/review-eval/gold/**\nscripts/eval/review-eval/seeds/**\nscripts/eval/review-eval/rubrics/**\n```\n'),
    'a wide glob instead of the four': (root) => writeFileSync(path.join(root, 'REVIEW.md'), '# Review\n\n## Skip paths\n\n```\ndocs/**\nscripts/eval/review-eval/**\n```\n'),
  };
  for (const [name, breakIt] of Object.entries(bad)) {
    const f = crFixture();
    breakIt(f.root);
    const r = await runCodeRabbit(crOpts(f, { changedPaths: ['src/a.ts'] }));
    assert.equal(r.status, 'FAIL', name);
    assert.match(r.detail, /could not check the diff/, name);
    assert.match(r.detail, KEY_TAIL, name);
    assert.doesNotMatch(r.detail, /--skip-cr/, name);
    assert.equal(f.calls.length + f.usageCalls.length, 0, name);
    assert.equal(existsSync(crPaths(f.root, 'feat/x').counter), false, name);
  }
});

test('A4: a null changed-file list FAILs and never calls the CLI', async () => {
  const f = crFixture();
  const r = await runCodeRabbit(crOpts(f, { changedPaths: null }));
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /changed-file list is unknown/);
  assert.equal(f.calls.length + f.usageCalls.length, 0);
});

test('A5: the frozen ANSWER_KEY_GLOBS are the answer-key globs of the live REVIEW.md AND the answer-key entries of cursor-review.mjs TREE_EXCLUDES', async () => {
  const { TREE_EXCLUDES } = await import('./cursor-review.mjs');
  const { parseReviewMd } = await import('../ratchets/review-skip-sync.mjs');
  const asEntry = (g) => g.replace(/\/\*\*$/, '');
  const frozen = PRE.ANSWER_KEY_GLOBS;
  assert.equal(frozen.length, 4);
  assert.ok(Object.isFrozen(frozen));
  const inReviewMd = parseReviewMd(REVIEW_MD).filter((g) => g.startsWith('scripts/eval/review-eval/'));
  assert.deepEqual([...frozen].sort(), [...inReviewMd].sort(), 'REVIEW.md Skip paths holds exactly the four');
  const excluded = TREE_EXCLUDES.filter((x) => x.startsWith('scripts/eval/review-eval/'));
  assert.deepEqual(frozen.map(asEntry).sort(), [...excluded].sort(), 'TREE_EXCLUDES holds exactly the four');
  assert.deepEqual(PRE.answerKeyGlobs(REPO_ROOT), { globs: frozen });
});

test('A13: a wide glob in REVIEW.md earns nothing: with the four present, a file outside the four runs the CLI; a gold path still hits', async () => {
  const f = crFixture();
  writeFileSync(path.join(f.root, 'REVIEW.md'), reviewMdWith('scripts/eval/review-eval/**'));
  const r = await runCodeRabbit(crOpts(f, { changedPaths: ['scripts/eval/review-eval/lib.mjs'] }));
  assert.equal(r.status, 'PASS');
  assert.equal(f.calls.length, 1, 'the CLI runs');
  const g = crFixture();
  writeFileSync(path.join(g.root, 'REVIEW.md'), reviewMdWith('scripts/eval/review-eval/**'));
  assert.equal((await runCodeRabbit(crOpts(g, { changedPaths: [GOLD] }))).skipReason, 'answer-key');
});

test('A6: a clean diff runs the CLI as before', async () => {
  const f = crFixture();
  const r = await runCodeRabbit(crOpts(f, { changedPaths: ['src/a.ts', 'docs/x.md', 'scripts/eval/review-eval/lib.mjs'] }));
  assert.equal(r.status, 'PASS');
  assert.equal(f.calls.length, 1);
});

test('A9: the match ignores case, backslashes and a leading ./', () => {
  for (const p of ['Scripts/Eval/Review-Eval/Gold/G.json', 'scripts\\eval\\review-eval\\gold\\g.json', './scripts/eval/review-eval/gold/g.json', 'SCRIPTS/EVAL/REVIEW-EVAL/LINKTYPE-LABELS.JSON']) {
    assert.match(PRE.answerKeyBlock({ root: REPO_ROOT, paths: [p] }) ?? '', new RegExp(`answer-key path \\(${p.replace(/[.\\/-]/g, '\\$&')},`), p);
  }
});

// A repo whose base (main) holds an answer-key .md file, then the branch deletes it or renames it out. .md keeps the diff docs-only, so
// the evidence step passes and the CodeRabbit step runs.
function repoWithGoldFile() {
  const repo = makeRepo({ files: {} });
  const rel = 'scripts/eval/review-eval/gold/old.md';
  git(repo.dir, 'checkout', '-q', 'main');
  mkdirSync(path.join(repo.dir, path.dirname(rel)), { recursive: true });
  writeFileSync(path.join(repo.dir, rel), 'a long enough answer key body so that git sees the rename\nline two\nline three\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'gold on main');
  git(repo.dir, 'checkout', '-q', 'feat/x');
  git(repo.dir, 'merge', '-q', '--ff-only', 'main');
  return { ...repo, rel };
}
const crStep = (r) => r.result.results.find((x) => x.step === 'coderabbit');

const stampOf = (repo) => JSON.parse(readFileSync(stampFile(repo), 'utf8'));
const keyFields = (s) => ({ skipped: s.cr_skipped, reason: s.cr_skip_reason, key: s.cr_answer_key, n: s.answer_key_paths, docs: s.cr_docs_only });

test('A7: a DELETE of an answer-key file is caught: bothSidePaths lists it and runPrePr SKIPs the CodeRabbit step as answer-key (stamp fields set, no CLI call)', async () => {
  const repo = repoWithGoldFile();
  git(repo.dir, 'rm', '-q', repo.rel);
  git(repo.dir, 'commit', '-q', '-m', 'delete gold');
  assert.deepEqual(PRE.bothSidePaths(makeGit(repo.dir), 'main...HEAD'), [repo.rel]);
  const run = await prePr(repo);
  assert.equal(crStep(run).status, 'SKIP');
  assert.equal(crStep(run).skipReason, 'answer-key');
  assert.match(crStep(run).detail, new RegExp(`${repo.rel.replaceAll('/', '\\/')}, 1 in all`));
  assert.equal(run.crCalls.length, 0);
  assert.equal(run.result.ok, true, run.result.lines.join('\n'));
  assert.deepEqual(keyFields(stampOf(repo)), { skipped: true, reason: 'answer-key', key: true, n: 1, docs: false });
});

test('A12: a normal stamp has cr_answer_key false and answer_key_paths 0 (only an answer-key skip sets them)', async () => {
  const repo = makeRepo();
  const run = await prePr(repo);
  assert.equal(run.result.ok, true, run.result.lines.join('\n'));
  assert.deepEqual(keyFields(stampOf(repo)), { skipped: false, reason: null, key: false, n: 0, docs: false });
});

test('A8: a RENAME out of gold/ is caught on the OLD path: --name-only shows only the new one, bothSidePaths shows both', async () => {
  const repo = repoWithGoldFile();
  mkdirSync(path.join(repo.dir, 'docs'), { recursive: true });
  git(repo.dir, 'mv', repo.rel, 'docs/moved.md');
  git(repo.dir, 'commit', '-q', '-m', 'move gold out');
  assert.deepEqual(changedFiles(makeGit(repo.dir), 'main').paths, ['docs/moved.md'], 'the rename shows only the new path today');
  assert.deepEqual(PRE.bothSidePaths(makeGit(repo.dir), 'main...HEAD'), ['docs/moved.md', repo.rel]);
  const run = await prePr(repo);
  assert.equal(crStep(run).status, 'SKIP');
  assert.match(crStep(run).detail, /answer-key path/);
  assert.equal(run.crCalls.length, 0);
  assert.deepEqual(keyFields(stampOf(repo)), { skipped: true, reason: 'answer-key', key: true, n: 1, docs: false });
});

test('A11: answerKeyRange (the cr-fix guard) checks both sides of from..HEAD in a real repo', () => {
  const repo = repoWithGoldFile();
  assert.equal(PRE.answerKeyRange(repo.dir, 'main'), null, 'an empty range is clean');
  mkdirSync(path.join(repo.dir, 'docs'), { recursive: true });
  git(repo.dir, 'mv', repo.rel, 'docs/moved.md');
  git(repo.dir, 'commit', '-q', '-m', 'move gold out');
  assert.match(PRE.answerKeyRange(repo.dir, 'main') ?? '', /answer-key path \(scripts\/eval\/review-eval\/gold\/old\.md, 1 in all\)/);
  const closed = PRE.answerKeyRange(path.join(os.tmpdir(), 'prepr-no-such-dir'), 'main') ?? '';
  assert.match(closed, /could not check the diff/);
  assert.match(closed, /Fix REVIEW\.md or the git read, then run cr-fix again\.$/);
  assert.doesNotMatch(closed + PRE.answerKeyRange(repo.dir, 'main'), /--skip-cr/, 'cr-fix has no --skip-cr flag');
});

// The guard range is base...HEAD and the stamp records no base. A hit earns the skip only on the default base, and only when the hit path is also
// in the fork/<base>...HEAD list (so a stale local base cannot pull another PR's gold path into this change).
test('A14: with a --base override a hit is a FAIL, never an earned skip; the CLI never starts', async () => {
  const f = crFixture();
  const r = await runCodeRabbit(crOpts(f, { changedPaths: [GOLD], guardBase: { override: true, forkPaths: undefined } }));
  assert.equal(r.status, 'FAIL');
  assert.equal(r.skipReason, undefined);
  assert.match(r.detail, new RegExp(`${GOLD.replaceAll('/', '\\/')}, 1 in all`));
  assert.match(r.detail, /--base/);
  assert.equal(f.calls.length + f.usageCalls.length, 0);
  const repo = repoWithGoldFile();
  git(repo.dir, 'branch', 'trunk', 'main');
  git(repo.dir, 'rm', '-q', repo.rel);
  git(repo.dir, 'commit', '-q', '-m', 'delete gold');
  const run = await prePr(repo, { base: 'trunk' });
  assert.equal(crStep(run).status, 'FAIL');
  assert.match(crStep(run).detail, /--base trunk/);
  assert.equal(run.crCalls.length, 0);
  assert.equal(run.result.ok, false);
});

// Local main is behind fork/main; the branch merged fork/main, so git:behind passes, but main...HEAD holds another PR's gold file.
function repoWithStaleMain() {
  const repo = makeRepo({ files: {} });
  const d = repo.dir;
  git(d, 'checkout', '-q', '-b', 'up', 'main');
  mkdirSync(path.join(d, 'scripts', 'eval', 'review-eval', 'gold'), { recursive: true });
  writeFileSync(path.join(d, 'scripts', 'eval', 'review-eval', 'gold', 'other.md'), 'another pull request gold\n');
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'other pr gold');
  git(d, 'update-ref', 'refs/remotes/fork/main', git(d, 'rev-parse', 'HEAD'));
  git(d, 'checkout', '-q', 'feat/x');
  git(d, 'merge', '-q', '--no-ff', '--no-edit', 'up');
  mkdirSync(path.join(d, 'docs'), { recursive: true });
  writeFileSync(path.join(d, 'docs', 'mine.md'), 'my change\n');
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'my change');
  return repo;
}

// Card prflow-prepr-speed (R1): the pin is the merge base with fork/main, so a stale local main no longer pulls another PR's gold path into the
// range. A15 was "FAIL: update local main"; the range the CLI reads is now the right one, and the run goes on.
test('A15: a stale local main that holds another PR\'s gold path no longer reaches the guard: the pinned range is the branch\'s own change, and the CLI runs on it', async () => {
  const repo = repoWithStaleMain();
  const run = await prePr(repo);
  assert.equal(crStep(run).status, 'PASS', run.result.lines.join('\n'));
  assert.equal(crStep(run).skipReason, undefined);
  assert.equal(run.crCalls.length, 1);
  assert.equal(run.crCalls[0].args.at(-1), git(repo.dir, 'rev-parse', 'refs/remotes/fork/main'), 'the CLI reads from fork/main');
  assert.equal(run.result.ok, true);
});

test('A16: with fork/main present, an answer-key path that is also in the fork/main list still earns the skip; an unreadable fork list is a FAIL', async () => {
  const repo = repoWithGoldFile();
  git(repo.dir, 'update-ref', 'refs/remotes/fork/main', 'main');
  git(repo.dir, 'rm', '-q', repo.rel);
  git(repo.dir, 'commit', '-q', '-m', 'delete gold');
  const run = await prePr(repo);
  assert.equal(crStep(run).status, 'SKIP', run.result.lines.join('\n'));
  assert.equal(crStep(run).skipReason, 'answer-key');
  assert.equal(run.result.ok, true);
  const f = crFixture();
  const r = await runCodeRabbit(crOpts(f, { changedPaths: [GOLD], guardBase: { override: false, forkPaths: null } }));
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /fork\/main/);
  assert.equal(f.calls.length, 0);
});

test('A17: an accepted answer-key skip writes one guardLog row (decision, count, head, reason); a normal run writes none', async () => {
  const repo = repoWithGoldFile();
  git(repo.dir, 'rm', '-q', repo.rel);
  git(repo.dir, 'commit', '-q', '-m', 'delete gold');
  const rows = [];
  const run = await prePr(repo, { guardLog: (row) => rows.push(row) });
  assert.equal(crStep(run).skipReason, 'answer-key');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'answer-key');
  assert.equal(rows[0].count, 1);
  assert.equal(rows[0].head, git(repo.dir, 'rev-parse', 'HEAD'));
  assert.match(rows[0].reason, /gold\/old\.md, 1 in all/);
  const none = [];
  await prePr(makeRepo(), { guardLog: (row) => none.push(row) });
  assert.deepEqual(none, []);
  // The default logger keeps the row's own decision, count and head (cli-missing keeps its fixed decision).
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-gl-')), 'g.jsonl');
  logCliMissing(rows[0], { CCV3_GUARD_DECISIONS_LOG: file });
  const written = JSON.parse(readFileSync(file, 'utf8').trim());
  assert.deepEqual([written.decision, written.count, written.head], ['answer-key', 1, rows[0].head]);
});

// The guard checks the diff before the lock, but the usage preflight is awaited before the review starts. A commit or a checkout in that
// window changes the committed diff the CLI would read, so HEAD is read again right before the CLI starts.
function crInRepo(repo, runner, extra = {}) {
  return { root: repo.dir, branch: 'feat/x', head: repo.head, base: 'main', now: new Date('2026-10-27T10:00:00Z'), runner, ledgerPath: tempLedger(), headGit: makeGit(repo.dir), crStore: null, guardPaths: CLEAN_PATHS, baseCommit: git(repo.dir, 'rev-parse', 'main'), ...extra };
}
const commitDuring = (repo, rel) => {
  mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
  writeFileSync(path.join(repo.dir, rel), `moved ${rel}\n`);
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', `during the preflight: ${rel}`);
};

test('A18: HEAD moved during the usage preflight (a commit, or a new gold path) starts no CLI and gives the run slot back', async () => {
  for (const rel of ['docs/during.md', GOLD]) {
    const repo = makeRepo();
    const seen = [];
    const runner = (o) => {
      seen.push(o.args[0]);
      if (o.args[0] === 'usage') { commitDuring(repo, rel); return { status: 0, stdout: USAGE_OK, stderr: '' }; }
      return { status: 0, stdout: NDJSON_OK, stderr: '' };
    };
    const r = await runCodeRabbitLive(crInRepo(repo, runner));
    assert.equal(r.status, 'FAIL', rel);
    assert.equal(r.skipReason, undefined, rel);
    assert.match(r.detail, /HEAD moved during the preflight/, rel);
    assert.match(r.detail, /run pre-pr again/, rel);
    assert.deepEqual(seen, ['usage'], `${rel}: the review is never called`);
    const counter = JSON.parse(readFileSync(crPaths(repo.dir, 'feat/x').counter, 'utf8'));
    assert.equal(counter.runs.length, 0, `${rel}: not counted`);
    assert.equal(existsSync(crPaths(repo.dir, 'feat/x').lock), false, `${rel}: the lock is released`);
  }
});

test('A19: a steady HEAD runs the CLI as before; an unreadable HEAD before the start is a FAIL; no headGit (a direct call) adds no check', async () => {
  const repo = makeRepo();
  const calls = [];
  const runner = (o) => { calls.push(o.args[0]); return { status: 0, stdout: o.args[0] === 'usage' ? USAGE_OK : NDJSON_OK, stderr: '' }; };
  assert.equal((await runCodeRabbitLive(crInRepo(repo, runner))).status, 'PASS');
  assert.deepEqual(calls, ['usage', 'review']);
  const broken = makeRepo();
  const none = [];
  const r = await runCodeRabbitLive(crInRepo(broken, (o) => { none.push(o.args[0]); return { status: 0, stdout: USAGE_OK, stderr: '' }; }, { headGit: () => ({ status: 128, stdout: '', stderr: 'fatal' }) }));
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /HEAD could not be re-read/);
  assert.deepEqual(none, ['usage']);
  const direct = makeRepo();
  const moving = [];
  const mover = (o) => { moving.push(o.args[0]); if (o.args[0] === 'usage') commitDuring(direct, 'docs/x.md'); return { status: 0, stdout: o.args[0] === 'usage' ? USAGE_OK : NDJSON_OK, stderr: '' }; };
  assert.equal((await runCodeRabbitLive(crInRepo(direct, mover, { headGit: null, crStore: null }))).status, 'PASS');
});

test('A20: runPrePr hands its git to the CodeRabbit step: a HEAD that moves in the preflight gives no CLI start', async () => {
  // Breaks when: runPrePr drops headGit from its runCodeRabbit call.
  const repo = makeRepo();
  const crCalls = [];
  const crRunner = (o) => {
    if (o.args[0] === 'usage') { commitDuring(repo, 'docs/during.md'); return { status: 0, stdout: USAGE_OK, stderr: '' }; }
    crCalls.push(o);
    return { status: 0, stdout: NDJSON_OK, stderr: '' };
  };
  const run = await prePr(repo, { crRunner });
  assert.equal(crStep(run).status, 'FAIL');
  assert.match(crStep(run).detail, /HEAD moved during the preflight/);
  assert.equal(crCalls.length, 0);
  assert.equal(run.result.ok, false);
});

// The base ref moves too: every worktree shares refs/heads/main, and landed PRs move it all day.
const shaOf = (repo, ref) => git(repo.dir, 'rev-parse', ref);
const moveBase = (repo) => git(repo.dir, 'update-ref', 'refs/heads/main', git(repo.dir, 'commit-tree', 'main^{tree}', '-p', 'main', '-m', 'main moved'));

// Card prflow-prepr-speed (R1): the base is PINNED. runPrePr reads baseCommit = `git merge-base HEAD fork/<base>` once, after the fetch
// (the local base when there is no fork ref), and the changes step, the guard and `cr review --base-commit` all use it. A move of the base
// ref during the run changes nothing the run reads, so it is no FAIL any more. Only HEAD is checked at the last moment.
// A21..A25 below were "a base that moved is a FAIL" tests; each now holds the new rule.
test('A21: the base ref moved during the usage preflight changes nothing: the CLI starts on the pinned base commit and the slot is used', async () => {
  const repo = makeRepo();
  const pinned = shaOf(repo, 'main');
  const seen = [];
  const runner = (o) => {
    seen.push(o.args);
    if (o.args[0] === 'usage') moveBase(repo);
    return { status: 0, stdout: o.args[0] === 'usage' ? USAGE_OK : NDJSON_OK, stderr: '' };
  };
  const r = await runCodeRabbitLive(crInRepo(repo, runner, { baseCommit: pinned }));
  assert.equal(r.status, 'PASS', r.detail);
  assert.deepEqual(seen.at(-1), ['review', '--agent', '--committed', '--base-commit', pinned]);
  assert.equal(JSON.parse(readFileSync(crPaths(repo.dir, 'feat/x').counter, 'utf8')).runs.length, 1, 'counted');
});

test('A22: an empty head that cannot be re-read FAILs before any equality test; a missing or malformed base commit FAILs closed with no CLI call', async () => {
  const repo = makeRepo();
  const seen = [];
  const runner = (o) => { seen.push(o.args[0]); return { status: 0, stdout: o.args[0] === 'usage' ? USAGE_OK : NDJSON_OK, stderr: '' }; };
  const failedRead = () => ({ status: 128, stdout: '', stderr: 'fatal' });
  const emptyHead = await runCodeRabbitLive(crInRepo(repo, runner, { head: '', headGit: failedRead }));
  assert.equal(emptyHead.status, 'FAIL', 'head empty and the re-read failed: not "equal"');
  assert.match(emptyHead.detail, /HEAD could not be re-read/);
  assert.deepEqual(seen, ['usage']);
  for (const bad of ['', 'main', 'abc123', `${'a'.repeat(39)}g`]) {
    seen.length = 0;
    const noBase = await runCodeRabbitLive(crInRepo(makeRepo(), runner, { baseCommit: bad }));
    assert.equal(noBase.status, 'FAIL', String(bad));
    assert.match(noBase.detail, /no pinned base commit/);
    assert.deepEqual(seen, [], `${bad}: no CLI call, not even the usage preflight`);
  }
  // No base commit given (a direct call): it is read from the checkout. In a folder that is no checkout the read fails and the step FAILs closed.
  seen.length = 0;
  const direct = makeRepo();
  const { baseCommit: _given, ...noBase } = crInRepo(direct, runner);
  assert.equal((await runCodeRabbitLive(noBase)).status, 'PASS');
  assert.deepEqual(seen, ['usage', 'review']);
  seen.length = 0;
  const lost = await runCodeRabbitLive({ ...noBase, root: crFixture().root, headGit: null });
  assert.equal(lost.status, 'FAIL');
  assert.match(lost.detail, /no pinned base commit \(none\)/);
  assert.deepEqual(seen, [], 'no CLI call at all');
});

test('A23: runPrePr pins the base: the CLI gets --base-commit <merge-base of HEAD and fork/main>, and the guard reads the same range, whatever the refs do after', async () => {
  const repo = makeRepo();
  git(repo.dir, 'update-ref', 'refs/remotes/fork/main', 'main');
  const pinned = shaOf(repo, 'fork/main');
  const real = makeGit(repo.dir);
  const ranges = [];
  const reviewArgs = [];
  const crRunner = (o) => {
    if (o.args[0] === 'usage') { moveBase(repo); git(repo.dir, 'update-ref', 'refs/remotes/fork/main', 'main'); return { status: 0, stdout: USAGE_OK, stderr: '' }; }
    reviewArgs.push(o.args);
    return { status: 0, stdout: NDJSON_OK, stderr: '' };
  };
  const run = await prePr(repo, { crRunner, git: (args) => { if (args.includes('--no-renames')) ranges.push(args.at(-1)); return real(args); } });
  assert.equal(crStep(run).status, 'PASS', run.result.lines.join('\n'));
  assert.deepEqual(reviewArgs, [['review', '--agent', '--committed', '--base-commit', pinned]]);
  assert.ok(ranges.length >= 1 && ranges.every((r) => r === `${pinned}...HEAD`), `the guard reads ${pinned}...HEAD: ${ranges.join(', ')}`);
  assert.equal(run.result.ok, true);
  assert.equal(stampOf(repo).base_commit, pinned, 'the stamp names the base commit');
});

// R2: the guard sees exactly the diff the CLI reads and still runs before the spawn.
test('PIN3: the guard paths are the paths of git diff --name-only <baseCommit>...HEAD, read before the first CLI call, and a moved fork/main changes neither', async () => {
  const repo = repoWithStaleMain();
  const pinned = git(repo.dir, 'merge-base', 'HEAD', 'refs/remotes/fork/main');
  const order = [];
  const real = makeGit(repo.dir);
  const git2 = (args) => { if (args.includes('--no-renames')) order.push(`guard ${args.at(-1)}`); return real(args); };
  const crRunner = (o) => { order.push(`cr ${o.args[0]}`); if (o.args[0] === 'usage') moveBase(repo); return { status: 0, stdout: o.args[0] === 'usage' ? USAGE_OK : NDJSON_OK, stderr: '' }; };
  const run = await prePr(repo, { crRunner, git: git2 });
  const expected = git(repo.dir, 'diff', '--name-only', '--no-renames', `${pinned}...HEAD`).split('\n').filter(Boolean);
  assert.deepEqual(expected, ['docs/mine.md'], 'the other PR\'s gold file is not in the range the CLI reads');
  assert.equal(order[0], `guard ${pinned}...HEAD`, 'the guard runs first, on the pinned range');
  assert.ok(order.indexOf('cr usage') > order.indexOf(`guard ${pinned}...HEAD`));
  assert.equal(crStep(run).status, 'PASS', run.result.lines.join('\n'));
  assert.equal(order.filter((x) => x === 'cr review').length, 1);
});

test('A24: the pin is the merge base, not the tip of a base that HEAD does not contain: a moved local main is not read', async () => {
  const repo = makeRepo();
  const pinned = shaOf(repo, 'main');
  moveBase(repo);
  assert.equal(PRE.resolveBaseCommit(makeGit(repo.dir), 'main'), pinned, 'merge-base HEAD main, not the new tip');
  git(repo.dir, 'update-ref', 'refs/remotes/fork/main', 'main');
  assert.equal(PRE.resolveBaseCommit(makeGit(repo.dir), 'main'), pinned, 'fork/main is the new tip (not in HEAD): the merge base stays');
  assert.equal(PRE.resolveBaseCommit(() => ({ status: 128, stdout: '', stderr: 'fatal' }), 'main'), '', 'a failed read is the empty string');
  assert.equal(PRE.resolveBaseCommit(() => ({ status: 0, stdout: 'not a sha\n', stderr: '' }), 'main'), '', 'text that is no commit is the empty string');
});

test('A25 and F21: main moves during the gates and the run still PASSES, on the pinned base commit; HEAD moving still FAILs', async () => {
  const repo = makeRepo();
  git(repo.dir, 'update-ref', 'refs/remotes/fork/main', 'main');
  const pinned = shaOf(repo, 'main');
  const moved = [];
  const run = await prePr(repo, { exec: () => { if (moved.length === 0) { moveBase(repo); git(repo.dir, 'update-ref', 'refs/remotes/fork/main', 'main'); moved.push(1); } return { status: 0, stdout: 'ran\nTests  1 passed (1)\n', stderr: '' }; } });
  assert.equal(moved.length, 1, 'the base moved in the gates');
  assert.equal(run.result.ok, true, run.result.lines.join('\n'));
  assert.equal(crStep(run).status, 'PASS');
  assert.equal(stampOf(repo).base_commit, pinned);
  assert.equal(run.crCalls.at(-1).args.at(-1), pinned);
  const headMoves = makeRepo();
  const bad = await prePr(headMoves, { crRunner: (o) => { if (o.args[0] === 'usage') commitDuring(headMoves, 'docs/during.md'); return { status: 0, stdout: o.args[0] === 'usage' ? USAGE_OK : NDJSON_OK, stderr: '' }; } });
  assert.equal(bad.result.ok, false);
});

test('PIN1: no fork ref: the pin is the merge base with the local base; a merge base git cannot read fails the changes step closed with no CLI call', async () => {
  const repo = makeRepo();
  const pinned = shaOf(repo, 'main');
  const run = await prePr(repo);
  assert.equal(run.crCalls.at(-1).args.at(-1), pinned);
  assert.equal(stampOf(repo).base_commit, pinned);
  const none = makeRepo();
  const real = makeGit(none.dir);
  const broken = await prePr(none, { git: (args) => (args[0] === 'merge-base' ? { status: 128, stdout: '', stderr: 'fatal: no merge base' } : real(args)) });
  assert.equal(broken.result.ok, false);
  assert.equal(broken.crCalls.length, 0);
  assert.match(broken.result.lines.join('\n'), /FAIL changes - .*base commit/);
});

test('PIN2: assertSafeCrArgs lets --base-commit pass only with a 40 character commit id', () => {
  assertSafeCrArgs(['review', '--agent', '--committed', '--base-commit', 'a'.repeat(40)]);
  for (const bad of ['main', '--use-credits', 'A'.repeat(40), 'a'.repeat(39), '']) {
    assert.throws(() => assertSafeCrArgs(['review', '--agent', '--committed', '--base-commit', bad]), /forbidden/i, bad);
  }
  assert.throws(() => assertSafeCrArgs(['review', '--agent', '--committed', '--base-commit']), /forbidden/i);
});

test('A10: runPrePr reads a failed both-sides diff as unknown, not as no paths: FAIL, no CLI call', async () => {
  const repo = makeRepo();
  const real = makeGit(repo.dir);
  const git = (args) => (args.includes('--no-renames') ? { status: 128, stdout: '', stderr: 'fatal: boom' } : real(args));
  const run = await prePr(repo, { git });
  assert.equal(crStep(run).status, 'FAIL');
  assert.match(crStep(run).detail, /could not check the diff/);
  assert.equal(run.crCalls.length, 0);
  assert.equal((await prePr(makeRepo())).crCalls.length, 1, 'a clean branch still runs the CLI');
});

// ---------- card prflow-prepr-speed, Q1: a review whose run failed a test gate ----------
// The review starts beside the test gates. When a gate fails, the review has spent its run on a head that cannot pass. Its counter row gets
// gateFailed: true and uses no slot, but only ONE such free row per branch per Chicago day: the next one counts as a normal slot.
// A gateFailed row must never count toward cr_finished_runs or cr_partial_earned (the hook accepts a cap skip on cr_finished_runs >= 1).
//
// How it can fail, one test each, with the source change that makes it fail:
//   Q1a  a gateFailed row uses a slot                              (count every row)
//   Q1b  every gateFailed row is free, so a failing head costs nothing for ever   (no bound)
//   Q1c  the day is the UTC or the machine day, not the Chicago day               (dayOf or slice(0, 10) of the ISO time)
//   Q1d  a gateFailed row counts as a finished run or a partial run               (no exclusion in finishedRuns and partialEarnedFor)
const hexOf = (c) => c.repeat(40);
const gfRow = (c, at, extra = {}) => ({ head: hexOf(c), at, outcome: 'finished', complete: true, newCode: true, gateFailed: true, ...extra });
const okRow = (c, at) => ({ head: hexOf(c), at, outcome: 'finished', complete: true, newCode: true });
function seedCounter(f, rows) {
  const file = crPaths(f.root, 'feat/x').counter;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ branch: 'feat/x', runs: rows }));
}
const MORNING = '2026-10-27T15:00:00.000Z'; // 10:00 in Chicago on 10-27

test('Q1a: one gateFailed row and one normal row use ONE slot: a third head is still reviewed', async () => {
  const f = crFixture();
  seedCounter(f, [gfRow('1', MORNING), okRow('2', MORNING)]);
  const r = await runCodeRabbit(crOpts(f, { head: hexOf('3') }));
  assert.equal(r.status, 'PASS', r.detail);
  assert.equal(f.calls.length, 1);
});

test('Q1b: a second gateFailed row on the same Chicago day counts as a normal slot', async () => {
  const f = crFixture();
  seedCounter(f, [gfRow('1', MORNING), gfRow('2', '2026-10-27T16:00:00.000Z'), okRow('3', MORNING)]);
  const r = await runCodeRabbit(crOpts(f, { head: hexOf('4') }));
  assert.equal(r.skipReason, 'cap', 'the free row is 1, rows 2 and 3 are 2 slots');
  assert.equal(f.calls.length, 0);
});

test('Q1c: the free row is one per CHICAGO day: 22:30 on 10-27 and 05:00 on 10-27 in Chicago are one day (two UTC days), 10-26 evening is another', async () => {
  const same = crFixture();
  seedCounter(same, [gfRow('1', '2026-10-27T10:00:00.000Z'), gfRow('2', '2026-10-28T03:30:00.000Z')]); // Chicago 10-27 05:00 and 10-27 22:30
  const sameRun = await runCodeRabbit(crOpts(same, { head: hexOf('3') }));
  assert.equal(sameRun.status, 'PASS', 'free row + 1 slot = 1 counted: a run is left');
  seedCounter(same, [gfRow('1', '2026-10-27T10:00:00.000Z'), gfRow('2', '2026-10-28T03:30:00.000Z'), okRow('4', MORNING)]);
  assert.equal((await runCodeRabbit(crOpts(same, { head: hexOf('5') }))).skipReason, 'cap', 'same Chicago day: the second row counts, so 2 counted');
  const days = crFixture();
  seedCounter(days, [gfRow('1', '2026-10-27T10:00:00.000Z'), gfRow('2', '2026-10-27T03:00:00.000Z'), okRow('4', MORNING)]); // 10-27 and 10-26 in Chicago, plus one normal
  assert.equal((await runCodeRabbit(crOpts(days, { head: hexOf('6') }))).status, 'PASS', 'two Chicago days: both rows are free, 1 counted');
});

test('Q1d: a gateFailed row is never a finished run and never earns a partial cap skip', () => {
  const f = crFixture();
  seedCounter(f, [gfRow('1', MORNING), okRow('2', MORNING)]);
  assert.equal(finishedRuns(f.root, 'feat/x'), 1, 'only the normal row finished');
  seedCounter(f, [gfRow('1', MORNING)]);
  assert.equal(finishedRuns(f.root, 'feat/x'), 0);
  const repo = makeRepo();
  const partial = { head: repo.head, partial: true, reviewed: 3, unreviewed: 1, findings: [], gateFailed: true };
  assert.equal(PRE.partialEarnedFor(repo.dir, [{ ...partial, gateFailed: undefined }], repo.head).earned, 1, 'the same row without the flag earns (the control)');
  assert.deepEqual(PRE.partialEarnedFor(repo.dir, [partial], repo.head), { earned: 0, unreviewed: 0 });
});

test('Q1e: markGateFailed marks only the row of this run: it needs BOTH the head and the time', () => {
  const f = crFixture();
  const LATER = '2026-10-27T16:00:00.000Z';
  // Rows that share a head (rows 0 and 1) and rows that share a time (rows 0 and 2): matching on one field marks the wrong row.
  const rows = [okRow('1', MORNING), okRow('1', LATER), okRow('2', MORNING)];
  const paths = crPaths(f.root, 'feat/x');
  const marked = (head, at) => {
    seedCounter(f, rows);
    PRE.markGateFailed(paths.counter, { head: hexOf(head), at });
    return JSON.parse(readFileSync(paths.counter, 'utf8')).runs.map((r) => r.gateFailed === true);
  };
  assert.deepEqual(marked('1', LATER), [false, true, false], 'same head, other time: only the row with this time');
  assert.deepEqual(marked('2', MORNING), [false, false, true], 'same time, other head: only the row with this head');
  assert.equal(PRE.markGateFailed(paths.counter, { head: hexOf('9'), at: MORNING }), false, 'a row that is not there');
  assert.equal(PRE.markGateFailed(paths.counter, { head: hexOf('2'), at: LATER }), false, 'a head and a time that no single row has');
});

// ---------- card prflow-prepr-speed: the review runs beside the test gates ----------
// A test gate is a blocking spawnSync: while it runs, the event loop of pre-pr does not run. The review child must not need the loop.
// The review call (fileStdio: true) gives the child a FILE for stdout and one for stderr, so nobody has to read a pipe. The usage call keeps pipes.
//
// How it can fail, one test each, with the source change that makes it fail:
//   F6   the child blocks on a full pipe while a gate blocks the loop           (stdio pipe)
//   F7   the time limit fires late after a long gate                            (checked: it fires when the loop runs again, with the child dead)
//   M1   a late limit timer kills a review that ended in time and reports a time-out   (no exit check in the limit handler)
//   M5   stderr lines land in the parsed stream                                 (one file for both)
//   F24  two runs write one running file                                        (no pid in the name)
const blockFor = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { windowsHide: true });
const tmpFile = (name) => path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-fstdio-')), name);

test('F6: a review child that writes 1 MB is not blocked while a gate blocks the event loop for 3 s (file stdio)', async () => {
  const marker = tmpFile('done.txt');
  const script = fakeCr(`import { writeSync, writeFileSync } from 'node:fs';
const chunk = 'x'.repeat(65536);
for (let i = 0; i < 17; i += 1) writeSync(1, chunk);
writeFileSync(${JSON.stringify(marker)}, String(Date.now()));`);
  const streamTo = tmpFile('run.txt');
  const running = defaultCrRunner({ cwd: os.tmpdir(), args: REVIEW, timeoutMs: 60_000, streamTo, fileStdio: true }, asFake(script));
  blockFor(3000);
  const blockEnd = Date.now();
  const doneAt = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : null;
  const r = await running;
  assert.ok(doneAt !== null && doneAt <= blockEnd, 'the child finished while the loop was blocked');
  assert.equal(r.status, 0);
  assert.ok(r.stdout.length >= 1_000_000, `the runner read ${r.stdout.length} characters`);
  assert.equal(readFileSync(streamTo, 'utf8').length, r.stdout.length, 'the stream file is the stdout');
});

test('F7 and M1: a review that ended in time is not a time-out when the limit timer fires late (gate of 2 s, limit 1 s); a child that runs on is stopped', async () => {
  const quick = fakeCr('console.log(\'{"type":"complete","status":"review_completed"}\'); setTimeout(() => process.exit(0), 300);');
  const ended = defaultCrRunner({ cwd: os.tmpdir(), args: REVIEW, timeoutMs: 1000, streamTo: tmpFile('quick.txt'), fileStdio: true }, asFake(quick));
  blockFor(2000);
  const r = await ended;
  assert.equal(r.timedOut, false, 'the child had ended: no kill, no time-out');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /complete/);
  const hangs = fakeCr('setInterval(() => console.log(\'{"type":"heartbeat"}\'), 100);');
  const stuck = defaultCrRunner({ cwd: os.tmpdir(), args: REVIEW, timeoutMs: 1000, streamTo: tmpFile('stuck.txt'), fileStdio: true }, asFake(hangs));
  blockFor(2000);
  const s = await stuck;
  assert.equal(s.timedOut, true);
  assert.match(s.stdout, /heartbeat/, 'the partial stream is kept');
});

test('M5: with file stdio stderr goes to <name>.err and never into the parsed stdout; ticks read the last event from the file', async () => {
  const script = fakeCr('console.error("E-LINE"); let i = 0; const t = setInterval(() => { console.log(\'{"type":"heartbeat"}\'); if (++i === 8) { clearInterval(t); } }, 80);');
  const streamTo = tmpFile('run.txt');
  const ticks = [];
  const r = await defaultCrRunner({ cwd: os.tmpdir(), args: REVIEW, timeoutMs: 20_000, streamTo, fileStdio: true, onTick: (t) => ticks.push(t) }, asFake(script));
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /E-LINE/);
  assert.match(r.stderr, /E-LINE/);
  assert.match(readFileSync(`${streamTo}.err`, 'utf8'), /E-LINE/);
  assert.doesNotMatch(readFileSync(streamTo, 'utf8'), /E-LINE/);
  assert.ok(ticks.some((t) => t.lastEvent === 'heartbeat'), JSON.stringify(ticks));
});

test('file stdio: a missing binary is still ENOENT and leaves no open handle that blocks removing the files', async () => {
  const streamTo = tmpFile('gone.txt');
  const gone = await defaultCrRunner({ cwd: os.tmpdir(), args: REVIEW, timeoutMs: 20_000, streamTo, fileStdio: true }, { command: 'definitely-not-a-binary-xyz', prefixArgs: [] });
  assert.equal(gone.errorCode, 'ENOENT');
  unlinkSync(streamTo);
  unlinkSync(`${streamTo}.err`);
});

test('F24: the review call asks for file stdio and a running file named with the pid of this run; the usage call keeps pipes', async () => {
  const f = crFixture();
  const seen = [];
  const made = [];
  // The real runner opens both files before the child starts: make them here, so "removed" is a fact and not the default of a runner that made none.
  const runner = (o) => { seen.push(o); if (o.args[0] === 'review') { writeFileSync(o.streamTo, ''); writeFileSync(`${o.streamTo}.err`, ''); made.push(o.streamTo, `${o.streamTo}.err`); } return f.runner(o); };
  const r = await runCodeRabbit(crOpts(f, { runner }));
  assert.equal(r.status, 'PASS', r.detail);
  assert.equal(made.length, 2, 'the runner made the running file and its .err file');
  const usage = seen.find((o) => o.args[0] === 'usage');
  const review = seen.find((o) => o.args[0] === 'review');
  assert.equal(usage.fileStdio, undefined);
  assert.equal(review.fileStdio, true);
  assert.equal(path.basename(review.streamTo), `2026-10-27-pre-pr-cr-aaaaaaa-${process.pid}.running.txt`);
  const left = readdirSync(path.join(f.root, '.claude', 'cache', 'e2e')).filter((n) => /running/.test(n) || /\.err$/.test(n));
  assert.deepEqual(left, [], 'the running file and its .err file are removed when the output is saved');
});

// ---------- card prflow-prepr-speed: the CodeRabbit step starts before the first test gate ----------
// How it can fail, one test each, with the source change that makes it fail:
//   F1   a fast step fails and a review still starts                         (start the review before the fast steps are known)
//   F2   the review does not start before the first gate                     (an await before the spawn is not waited for, or the old order)
//   F3   git:stable runs before the review ends                              (push git:stable before the await)
//   F4   a gate FAIL stops or loses the review output, or prints nothing at once   (kill the review at the first FAIL)
//   F5   a rerun on the same head spends a new review                        (reuse reads .failed.txt only, or the counter is rewritten)
//   F22  a stale GREEN run (settled by the gates) starts the review early     (no settledByGates test in the early start)
//   F23  an error exit leaves the review alive                               (no killActiveCr in the exit handler)
//   Q1f  the counter row of a review whose run failed a gate is not marked, or another row is marked
//   SER  PRE_PR_SERIAL_CR=1 does not restore today's order                    (no switch)
//   PH   the phase is not set to cr after the last gate, or is set when no review runs
const gateFail = (events) => () => { events?.push('gate'); return { status: 1, stdout: 'bad\n# fail 1\n', stderr: '' }; };
const slowReview = (events, ms = 300) => async (o) => {
  if (o.args[0] === 'usage') { await sleep(5); return { status: 0, stdout: USAGE_OK, stderr: '' }; }
  events.push('review-start');
  await sleep(ms);
  events.push('review-end');
  return { status: 0, stdout: NDJSON_OK, stderr: '' };
};
const e2eFiles = (repo) => readdirSync(path.join(repo.dir, '.claude', 'cache', 'e2e'));
const counterRows = (repo) => JSON.parse(readFileSync(crPaths(repo.dir, 'feat/x').counter, 'utf8')).runs;
// Card prepr-speed-bundle (O3, O4): the gates run in this order: the cheap ones, then the review starts, then the other gates. A docs change runs
// only context-budget (cheap), so the order tests inject fake gates of both kinds through the env step. A fake gate is a node call that the fake exec answers by id.
const fakeGate = (id, cheap = false) => ({ id, cmd: 'node', args: [], cwd: '.', timeoutMs: 60_000, ...(cheap ? { cheap: true } : {}) });
const withGates = (...gates) => ({ envCheck: () => ({ fail: null, others: [], note: null, blocked: new Set(), gates }) });
const GATE_OK = { status: 0, stdout: 'ran\nTests  1 passed (1)\n', stderr: '' };
const idExec = (events, failIds = []) => (spec) => { events.push(spec.id); return failIds.includes(spec.id) ? { status: 1, stdout: 'bad\n# fail 1\n', stderr: '' } : GATE_OK; };
const idCr = (events) => (o) => { events.push(o.args[0]); return { status: 0, stdout: o.args[0] === 'usage' ? USAGE_OK : NDJSON_OK, stderr: '' }; };

test('F1: a fast step that FAILs (evidence) starts no review at all: the runner is never called, not even for usage', async () => {
  const repo = makeRepo({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  const calls = [];
  const run = await prePr(repo, { bodyText: 'Proof type: feature\n', crRunner: (o) => { calls.push(o.args[0]); return { status: 0, stdout: USAGE_OK, stderr: '' }; } });
  assert.equal(run.result.ok, false);
  assert.ok(run.result.results.some((r) => r.step === 'evidence' && r.status === 'FAIL'), run.result.lines.join('\n'));
  assert.deepEqual(calls, []);
  assert.equal(crStep(run).skipReason, 'earlier-step-failed');
});

test('F2: the review child is running before the first test gate starts (real runner, a stub command, an async preflight)', async () => {
  const repo = makeRepo();
  const pidFile = tmpFile('cr.pid');
  const script = fakeCr(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write(${JSON.stringify(NDJSON_OK)});`);
  const crRunner = async (o) => {
    if (o.args[0] === 'usage') { await sleep(60); return { status: 0, stdout: USAGE_OK, stderr: '' }; }
    return defaultCrRunner(o, asFake(script));
  };
  const seen = [];
  const exec = () => { blockFor(1500); seen.push(existsSync(pidFile)); return { status: 0, stdout: 'ran\nTests  1 passed (1)\n', stderr: '' }; };
  const run = await prePr(repo, { crRunner, exec, ...withGates(fakeGate('s1')) }); // a non-cheap gate: the cheap ones run before the review (O4)
  assert.deepEqual(seen, [true], 'the stub child had started and written its pid file while the first gate blocked');
  assert.equal(run.result.ok, true, run.result.lines.join('\n'));
  assert.equal(crStep(run).status, 'PASS');
});

test('F3: git:stable is the last step and comes after a slow review; the review sits after the gates in the results', async () => {
  const repo = makeRepo();
  const events = [];
  // The git spy records WHEN git:stable runs (its `diff --cached` read), not only where its result sits in the list.
  const real = makeGit(repo.dir);
  // git:clean (the start) reads `diff --cached` too, so only a read after its `ls-files` counts.
  let cleanDone = false;
  const git = (args) => { if (args[0] === 'ls-files') cleanDone = true; if (cleanDone && args.join(' ') === 'diff --cached --name-only') events.push('stable-check'); return real(args); };
  const run = await prePr(repo, { git, crRunner: slowReview(events, 250) });
  assert.equal(run.result.ok, true, run.result.lines.join('\n'));
  const steps = run.result.results.map((r) => r.step);
  assert.equal(steps.at(-1), 'git:stable');
  assert.ok(steps.indexOf('coderabbit') > steps.indexOf('gate:context-budget'), steps.join(' '));
  assert.ok(steps.indexOf('coderabbit') < steps.indexOf('git:stable'));
  assert.deepEqual(events, ['review-start', 'review-end', 'stable-check'], 'git:stable is read after the review ended, once');
});

test('F4 and Q1f: a gate FAILs while the review runs: the line is printed at once, the review ends on its own and its output is saved, no stamp, only this run\'s row is marked gateFailed', async () => {
  const repo = makeRepo();
  const events = [];
  const earlier = { head: hexOf('7'), at: '2026-10-25T15:00:00.000Z', outcome: 'finished', complete: true, newCode: true };
  mkdirSync(path.dirname(crPaths(repo.dir, 'feat/x').counter), { recursive: true });
  writeFileSync(crPaths(repo.dir, 'feat/x').counter, JSON.stringify({ branch: 'feat/x', runs: [earlier] }));
  const run = await prePr(repo, { exec: gateFail(events), crRunner: slowReview(events, 400), log: (l) => events.push(`log: ${l}`), ...withGates(fakeGate('s1')) });
  assert.equal(run.result.ok, false);
  const failedAt = events.findIndex((e) => /^log: pre-pr: gate s1 FAILED; waiting for the CLI review to end so its output is saved$/.test(e));
  assert.ok(failedAt >= 0, events.join('\n'));
  assert.ok(failedAt < events.indexOf('review-end'), 'the FAILED line comes before the review ends');
  assert.ok(events.indexOf('review-start') < events.indexOf('gate'), 'the review started before the gate');
  assert.equal(crStep(run).status, 'PASS', 'the review ended on its own: it was not stopped');
  assert.ok(e2eFiles(repo).some((n) => /pre-pr-cr-[0-9a-f]{7}\.txt$/.test(n)), 'the output is saved');
  assert.equal(existsSync(stampFile(repo)), false);
  assert.deepEqual(counterRows(repo).map((r) => r.gateFailed === true), [false, true]);
});

test('F5: a rerun on the same head reuses the saved output: no review call, no new counter row, and it passes when the gate passes', async () => {
  const repo = makeRepo();
  await prePr(repo, { exec: gateFail(), crRunner: slowReview([], 100), ...withGates(fakeGate('s1')) }); // a non-cheap gate: a cheap FAIL starts no review (O4)
  assert.equal(counterRows(repo).length, 1);
  const second = await prePr(repo);
  assert.equal(second.crCalls.length, 0);
  assert.equal(second.result.ok, true, second.result.lines.join('\n'));
  assert.match(crStep(second).detail, /reused the saved CLI output/);
  assert.equal(counterRows(repo).length, 1);
  assert.equal(stampOf(repo).cr_finished_runs, 0, 'a gateFailed row is not a finished run');
});

test('F22 (O3): a stale GREEN (settled by the gates) starts the review early, before the first non-cheap gate', async () => {
  const repo = mergedRepo();
  const events = [];
  const { result } = await runWithBodyFile(repo, greenBody({ green: repo.old }), { skipCr: false, crRunner: idCr(events), exec: idExec(events), ...withGates(fakeGate('s1')) });
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.deepEqual(events, ['usage', 'review', 's1']);
});

test('O4a: a cheap gate that FAILs ends the run before any review call: no usage call, no review call, no slot spent', async () => {
  const events = [];
  const run = await prePr(makeRepo(), { ...withGates(fakeGate('c1', true), fakeGate('s1')), exec: idExec(events, ['c1']), crRunner: idCr(events) });
  assert.equal(run.result.ok, false);
  assert.deepEqual(events, ['c1'], 'one cheap gate ran; no review call, and the other gate did not run');
  assert.equal(crStep(run).skipReason, 'earlier-step-failed');
});

test('O4b: the cheap gates run first, the review starts before the first other gate, and every gate runs once', async () => {
  const events = [];
  const run = await prePr(makeRepo(), { ...withGates(fakeGate('s1'), fakeGate('c1', true), fakeGate('s2')), exec: idExec(events), crRunner: idCr(events) });
  assert.equal(run.result.ok, true, run.result.lines.join('\n'));
  assert.deepEqual(events, ['c1', 'usage', 'review', 's1', 's2']);
  const steps = run.result.results.map((r) => r.step).filter((s) => s.startsWith('gate:'));
  assert.deepEqual(steps, ['gate:c1', 'gate:s1', 'gate:s2'], 'the results are in the order the gates ran');
});

test('O3c: an early review on a stale GREEN, then a FAIL that is no gate (the body file changed during the gates): the counter row is marked gateFailed and no slot is used', async () => {
  const repo = mergedRepo();
  const events = [];
  const body = greenBody({ green: repo.old });
  const bodyPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-body-')), 'body.md');
  writeFileSync(bodyPath, body);
  const exec = (spec) => { events.push(spec.id); writeFileSync(bodyPath, `${body}edited while the gates ran\n`); return GATE_OK; };
  const run = await prePr(repo, { bodyText: body, bodyPath, skipCr: false, crRunner: idCr(events), exec, ...withGates(fakeGate('s1')) });
  assert.equal(run.result.ok, false, 'the stale GREEN stays: the file was not rewritten');
  assert.deepEqual(events, ['usage', 'review', 's1']);
  assert.equal(counterRows(repo).at(-1).gateFailed, true, 'the review row is marked, so the 2-run cap does not count it');
  assert.equal(existsSync(stampFile(repo)), false);
});

test('SER: PRE_PR_SERIAL_CR=1 keeps today\'s order (gates, then the review); without it the review comes first', async () => {
  const early = [];
  await prePr(makeRepo(), { exec: gateFail(early), crRunner: slowReview(early, 50), ...withGates(fakeGate('s1')) });
  assert.deepEqual(early.filter((e) => e !== 'review-end'), ['review-start', 'gate'], 'default: the review starts first');
  const serial = [];
  const run = await prePr(makeRepo(), { env: { PRE_PR_SERIAL_CR: '1' }, exec: gateFail(serial), crRunner: slowReview(serial, 50), ...withGates(fakeGate('s1')) });
  assert.deepEqual(serial, ['gate'], 'serial: a failed gate means no review');
  assert.equal(crStep(run).skipReason, 'earlier-step-failed');
});

test('PH: the phase becomes cr after the last gate while the review runs; no review, no phase change', async () => {
  const events = [];
  await prePr(makeRepo(), { onPhase: (p) => events.push(`phase ${p}`), exec: () => { events.push('gate'); return { status: 0, stdout: 'ran\nTests  1 passed (1)\n', stderr: '' }; }, crRunner: slowReview(events, 300), ...withGates(fakeGate('s1')) });
  assert.deepEqual(events, ['review-start', 'gate', 'phase cr', 'review-end']);
  const none = [];
  await prePr(makeRepo(), { skipCr: true, onPhase: (p) => none.push(p) });
  assert.deepEqual(none, []);
});

// ---------- card prflow-prepr-speed: the run lock wiring (heavy, START and END lines, waiting, errors) ----------
// takeRunLock gets a fake lock, a fake exit and a fake clock: no test here opens the live store (~/.claude/state/run-locks).
//
// How it can fail, one test each, with the source change that makes it fail:
//   M2   heavy is decided by a path test and not by the hooks-vitest gate        (a path test)
//   F17  the START or END line is missing or wrong                               (no line, no failing step)
//   L1   head and heavy are read once, before a wait of up to 60 minutes         (a value, not a function, for the wait)
//   M6   a lock error in grant mode lets the run go on with no limit             (catch and go on in every mode)
//   WL   --wait-lock waits when it is not asked for, or does not wait when it is  (always acquire once)
const fakeLock = (over = {}) => {
  const calls = { acquire: [], wait: [], phase: [], log: [], heavy: [] };
  const lock = {
    calls,
    mode: () => 'grant',
    acquire: async (o) => { calls.acquire.push(o); return { granted: true, mode: 'grant', file: 'pre-pr-1-2.lock', freeGB: 8.2, loadPct: 14, lines: ['GRANTED pre-pr'] }; },
    waitForGrant: async (o) => { calls.wait.push(o); return { granted: true, mode: 'grant', file: 'pre-pr-1-2.lock', freeGB: 8.2, loadPct: 14, lines: ['GRANTED pre-pr'] }; },
    setPhase: (o) => { calls.phase.push(o); return { changed: true }; },
    setHeavy: (o) => { calls.heavy.push(o); return { changed: true }; },
    logRun: (row) => calls.log.push(row),
    ...over,
  };
  return lock;
};
const lockRun = (lock, extra = {}) => {
  const said = [];
  const exits = [];
  const sleeps = [];
  const args = { bodyPath: '/x/body.md', wait: false, factsOf: () => ({ head: 'abcd1234', heavy: false }), lock, say: (l) => said.push(l), exit: (c) => exits.push(c), sleep: async (ms) => { sleeps.push(ms); }, install: () => {}, pid: 4242, ...extra };
  return { said, exits, sleeps, done: PRE.takeRunLock(args) };
};

test('M2: heavy means the change set runs the hooks-vitest gate, not that a path is under .claude/hooks', () => {
  assert.equal(PRE.isHeavyRun(['.claude/hooks/src/x.ts']), true);
  assert.equal(PRE.isHeavyRun(['.claude\\hooks\\src\\x.ts']), true, 'a Windows path');
  assert.equal(PRE.isHeavyRun(['docs/a.md']), false);
  // The template is no hooks path, yet it runs the hooks-vitest gate: a path test would call it light.
  assert.ok(gatesFor(['.claude/settings.json.template']).some((g) => g.id === 'hooks-vitest'), 'the premise: the template runs hooks-vitest');
  assert.equal(PRE.isHeavyRun(['.claude/settings.json.template']), true);
});

test('F17: a grant prints the START line with pid, head, heavy or light, free memory, load and mode, and logs it; the END line names the failing step and the minutes', async () => {
  const lock = fakeLock();
  const r = lockRun(lock, { factsOf: () => ({ head: 'abcd1234', heavy: true }) });
  const info = await r.done;
  assert.ok(r.said.includes('PRE-PR START pid 4242 head abcd1234 heavy free 8.2 load 14 mode grant'), r.said.join('\n'));
  assert.deepEqual(lock.calls.log.map((x) => [x.event, x.pid, x.head, x.heavy]), [['start', 4242, 'abcd1234', true]]);
  assert.equal(info.file, 'pre-pr-1-2.lock');
  const said = [];
  const run = { ok: false, results: [{ step: 'git:branch', status: 'PASS' }, { step: 'gate:hooks-vitest', status: 'FAIL' }, { step: 'coderabbit', status: 'PASS' }] };
  PRE.reportRunEnd({ pid: 4242, head: 'abcd1234', run, startedAt: 1_000, now: 1_000 + 4.25 * 60_000, lock, say: (l) => said.push(l) });
  assert.deepEqual(said, ['PRE-PR END pid 4242 head abcd1234 FAIL gate:hooks-vitest 4.3']);
  assert.deepEqual(lock.calls.log.at(-1), { event: 'end', pid: 4242, head: 'abcd1234', result: 'FAIL', failing: 'gate:hooks-vitest', minutes: 4.3 });
  const pass = [];
  PRE.reportRunEnd({ pid: 4242, head: 'abcd1234', run: { ok: true, results: [] }, startedAt: 0, now: 60_000, lock: fakeLock(), say: (l) => pass.push(l) });
  assert.deepEqual(pass, ['PRE-PR END pid 4242 head abcd1234 PASS - 1.0']);
});

test('F17b: the phase callback of a grant sets the phase of exactly this lock file; a refusal exits 75 with the old text and no START line', async () => {
  const lock = fakeLock();
  const r = lockRun(lock);
  const info = await r.done;
  info.onPhase('cr');
  assert.deepEqual(lock.calls.phase, [{ file: 'pre-pr-1-2.lock', pid: 4242, phase: 'cr' }]);
  const refused = fakeLock({ acquire: async () => ({ granted: false, lines: ['WAIT load 80 percent'] }) });
  const x = lockRun(refused);
  await x.done;
  assert.deepEqual(x.exits, [75]);
  assert.ok(x.said.some((l) => /stopped before any gate \(the run lock said wait\)/.test(l)), x.said.join('\n'));
  assert.equal(x.said.some((l) => /PRE-PR START/.test(l)), false);
});

test('L1 and WL: with --wait-lock the wait takes a function that reads head and heavy at each attempt; without it the lock is asked once', async () => {
  let n = 0;
  const heads = ['11111111', '22222222'];
  const lock = fakeLock({ waitForGrant: async (o) => { assert.equal(typeof o, 'function', 'a function: the facts are read again at each attempt'); const first = o(); const second = o(); lock.calls.wait.push([first.head, second.head]); return { granted: true, mode: 'grant', file: 'f.lock', freeGB: 8, loadPct: 1, lines: [] }; } });
  const r = lockRun(lock, { wait: true, factsOf: () => ({ head: heads[n++ % 2], heavy: false }) });
  await r.done;
  assert.deepEqual(lock.calls.wait, [['11111111', '22222222']]);
  assert.equal(lock.calls.acquire.length, 0);
  const once = fakeLock();
  await lockRun(once, { wait: false }).done;
  assert.equal(once.calls.acquire.length, 1);
  assert.equal(once.calls.wait.length, 0);
  const timedOut = lockRun(fakeLock({ waitForGrant: async () => ({ granted: false, exit: 75, timedOut: true, lines: ['WAIT slots'] }) }), { wait: true });
  await timedOut.done;
  assert.deepEqual(timedOut.exits, [75]);
});

test('M6: in grant mode a lock error is tried 3 more times, 10 s apart, then exits 75; in warn mode the run goes on at once', async () => {
  let tries = 0;
  const lock = fakeLock({ acquire: async () => { tries += 1; throw new Error('gate stays held'); } });
  const r = lockRun(lock);
  await r.done;
  assert.equal(tries, 4, 'the first try and 3 more');
  assert.deepEqual(r.sleeps, [10_000, 10_000, 10_000]);
  assert.deepEqual(r.exits, [75]);
  assert.ok(r.said.some((l) => /run lock is not available/.test(l)));
  let warnTries = 0;
  const warn = lockRun(fakeLock({ mode: () => 'warn', acquire: async () => { warnTries += 1; throw new Error('boom'); } }));
  const out = await warn.done;
  assert.equal(out, undefined);
  assert.equal(warnTries, 1);
  assert.deepEqual(warn.exits, []);
  assert.ok(warn.said.some((l) => /the run goes on/.test(l)), warn.said.join('\n'));
  let later = 0;
  const heals = lockRun(fakeLock({ acquire: async () => { later += 1; if (later < 3) throw new Error('blip'); return { granted: true, mode: 'grant', file: 'f.lock', freeGB: 8, loadPct: 1, lines: [] }; } }));
  assert.equal((await heals.done).file, 'f.lock');
  assert.deepEqual(heals.exits, []);
});

test('PH2: an onPhase that throws (a lock file busy) changes no result: the review is not stopped and the run passes', async () => {
  const lines = [];
  const run = await prePr(makeRepo(), { onPhase: () => { throw new Error('EBUSY: resource busy'); }, log: (l) => lines.push(l), crRunner: slowReview([], 150) });
  assert.equal(run.result.ok, true, run.result.lines.join('\n'));
  assert.equal(crStep(run).status, 'PASS');
  assert.ok(lines.some((l) => /could not set the run lock phase \(EBUSY/.test(l)), lines.join('\n'));
});

test('F23: an error exit (exit 3) stops the live review child: the exit handler calls killActiveCr', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prepr-f23-'));
  const pidFile = path.join(dir, 'cr.pid');
  const sleeper = path.join(dir, 'fake-cr.mjs');
  // The grandchild breaks away from the job object of Windows (detached): only a real tree kill reaches it, as in pre-pr-signal.test.mjs.
  writeFileSync(sleeper, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 60000); setInterval(() => {}, 1000)', ${JSON.stringify(`${pidFile}.gc`)}], { stdio: 'ignore', detached: process.platform === 'win32' }).unref();
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => process.exit(0), 60000); setInterval(() => {}, 1000);`);
  const script = path.join(dir, 'child.mjs');
  writeFileSync(script, `import { existsSync } from 'node:fs';
import { installRunLockHandlers, defaultCrRunner } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'pre-pr.mjs')).href)};
installRunLockHandlers();
defaultCrRunner({ cwd: process.argv[3], args: ${JSON.stringify(REVIEW)}, timeoutMs: 60000, streamTo: process.argv[4], fileStdio: true }, { command: process.execPath, prefixArgs: [process.argv[2]] });
while (!existsSync(process.argv[5]) || !existsSync(process.argv[5] + '.gc')) await new Promise((r) => setTimeout(r, 50));
process.exit(3);
`);
  const r = spawnSync(process.execPath, [script, sleeper, dir, path.join(dir, 'run.txt'), pidFile], { encoding: 'utf8', timeout: 100_000, env: { ...process.env, RUN_LOCK_DIR: path.join(dir, 'store') } });
  const pidOf = (file) => (existsSync(file) ? Number(readFileSync(file, 'utf8')) || 0 : 0);
  const [crPid, gcPid] = [pidOf(pidFile), pidOf(`${pidFile}.gc`)];
  try {
    assert.equal(r.status, 3, `${r.stdout}\n${r.stderr}`);
    assert.ok(crPid > 0 && gcPid > 0, 'the fake cr and its grandchild started');
    let alive = true;
    for (let i = 0; i < 80 && alive; i += 1) { try { process.kill(gcPid, 0); await sleep(100); } catch { alive = false; } }
    assert.equal(alive, false, `the grandchild of the fake cr (pid ${gcPid}) still runs after the error exit`);
  } finally {
    for (const p of [crPid, gcPid]) if (p > 0) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(300);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a process still holds a file: the temp folder is cleaned by the system */ }
  }
});

// ---------- seat finding 14:30 CST: no test run of the check script may reach the live run-lock store ----------
// How it fails: RL-ISO a test file that starts scripts/github/pre-pr.mjs as a process sets no RUN_LOCK_DIR, so the child writes lock files and
// START rows into ~/.claude/state/run-locks (break: drop the RUN_LOCK_DIR line of a spawning file).
test('RL-ISO: every test file that starts pre-pr.mjs as a process sends its run lock to a temp store', () => {
  const testFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : testFiles(p);
    return e.name.endsWith('.test.mjs') ? [p] : [];
  });
  // A spawn of the script: a spawn or exec call whose arguments name pre-pr.mjs, or a module text that imports it to run its handlers.
  const SPAWNS = /(spawnSync|spawn|execFileSync|execFile)\([^;]*pre-pr\.mjs|installRunLockHandlers.*pre-pr\.mjs|PRE_PR\s*=\s*resolve\([^)]*pre-pr\.mjs/s;
  const spawning = testFiles(path.join(REPO_ROOT, 'scripts')).filter((f) => SPAWNS.test(readFileSync(f, 'utf8')));
  assert.ok(spawning.length >= 3, `found the spawning files (${spawning.map((f) => path.basename(f)).join(', ')})`);
  const bare = spawning.filter((f) => !/RUN_LOCK_DIR/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(bare.map((f) => path.relative(REPO_ROOT, f)), [], 'these files start pre-pr.mjs with no temp RUN_LOCK_DIR');
  assert.notEqual(path.resolve(process.env.RUN_LOCK_DIR), path.join(os.homedir(), '.claude', 'state', 'run-locks'), 'this file points the store at a temp folder');
});

// RL-ISO2 (behaviour): a spawned run that stops with exit 3 (as X1 does) writes its START row into this file's temp store. Break: drop the
// process.env.RUN_LOCK_DIR line at the top of this file (the row then goes to the live store, and this temp store has none).
test('RL-ISO2: a spawned exit-3 run writes its START row to the temp store of this file, not the live one', () => {
  assert.ok(process.env.RUN_LOCK_DIR, 'the file sets RUN_LOCK_DIR');
  const repo = makeRepo();
  const body = path.join(repo.dir, '..', `body-iso-${Date.now()}.md`);
  writeFileSync(body, 'Proof type: docs\n');
  const r = spawnSync(process.execPath, [path.join(HERE, 'pre-pr.mjs'), '--body', body, '--skip-cr'], { cwd: repo.dir, encoding: 'utf8', windowsHide: true, env: LOCK_SAMPLES_ENV });
  assert.equal(r.status, 3, r.stderr);
  // O1: same fake samples here (this test checks START and END rows, never the machine read).
  assert.match(r.stderr, /samples come from RUN_LOCK_TEST_SAMPLES/);
  const runs = path.join(process.env.RUN_LOCK_DIR, 'runs.jsonl');
  assert.ok(existsSync(runs), 'the child wrote runs.jsonl in the temp store');
  const rows = readFileSync(runs, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // Seat ruling 14:44 (e): the exit-3 run also has exactly one END row, result ERROR with the exit code. Break: drop the END write of the exit
  // handler (endRowAtExit), and the run leaves a START row with no END row. Break: drop the START write, and an older run's START row in this
  // shared store must not stand in for it: only the rows with the pid of THIS child count (spawnSync returns it).
  const mine = rows.filter((row) => row.pid === r.pid);
  assert.ok(Number.isInteger(r.pid) && r.pid > 0, 'the spawn result has the child pid');
  assert.ok(mine.some((row) => row.event === 'start'), 'a START row of this child is in the temp store');
  assert.equal(mine.filter((row) => row.event === 'start').length, 1, 'one START row');
  const ends = mine.filter((row) => row.event === 'end');
  assert.equal(ends.length, 1, 'one END row for the exit-3 run');
  assert.equal(ends[0].result, 'ERROR');
  assert.equal(ends[0].exitCode, 3);
});

// ---------- card prepr-speed-bundle, O5: the summary check runs once before the run lock ----------
// How it can fail, one test each, with the source change that makes it fail:
//   O5a  a summary FAIL before the lock leaves the old stamp, or writes no gate-log row   (drop the stamp removal or the row)
//   O5b  a PASS (or a note-mode result) before the lock stops the run                      (exit on any result)
//   O5c  a bad summary still takes the lock first: START row, reads, spacing charge        (no check before takeRunLock in main)
const FAIL_SUMMARY = () => ({ result: { step: 'summary', status: 'FAIL', detail: 'no summary file: stub', notes: [] }, sha: null, ok: false });

test('O5a: a summary FAIL before the lock returns the FAIL, removes the old stamp and leaves one summary row in the gate log', () => {
  const repo = makeRepo();
  const stamp = path.join(repo.dir, PRE.STAMP_REL);
  mkdirSync(path.dirname(stamp), { recursive: true });
  writeFileSync(stamp, '{"old":true}');
  const gateLogFile = tempGateLog();
  const failed = PRE.summaryBeforeLock({ root: repo.dir, base: 'main', config: CONFIG, summaryCheck: FAIL_SUMMARY, gateLogFile, now: new Date() });
  assert.equal(failed.status, 'FAIL');
  assert.equal(existsSync(stamp), false, 'an old stamp must not outlive a FAIL');
  const rows = readFileSync(gateLogFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.step, r.status, r.head, r.branch]), [['summary', 'FAIL', repo.head, 'feat/x']]);
});

test('O5b: a summary that passes (or only notes) before the lock returns null: the run goes on, no stamp is touched, no row is written', () => {
  const repo = makeRepo();
  const stamp = path.join(repo.dir, PRE.STAMP_REL);
  mkdirSync(path.dirname(stamp), { recursive: true });
  writeFileSync(stamp, '{"old":true}');
  const gateLogFile = tempGateLog();
  assert.equal(PRE.summaryBeforeLock({ root: repo.dir, base: 'main', config: CONFIG, summaryCheck: SUMMARY_OK, gateLogFile, now: new Date() }), null);
  assert.equal(PRE.summaryBeforeLock({ root: repo.dir, base: 'main', config: CONFIG, summaryCheck: () => ({ result: { step: 'summary', status: 'NOTE', detail: 'note mode', notes: [] }, sha: null, ok: false }), gateLogFile, now: new Date() }), null);
  assert.equal(existsSync(stamp), true);
  assert.equal(existsSync(gateLogFile), false, 'no row for a pass');
});

test('O5c: a bad summary stops pre-pr.mjs before the run lock: exit 1, the FAIL line, no START row, no wait, no stamp', () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo.dir, 'review-router.config.json'), JSON.stringify({ ...CONFIG, pre_pr: { ...CONFIG.pre_pr, summary_mode: 'fail' } }));
  const body = path.join(repo.dir, '..', `body-o5-${Date.now()}.md`);
  writeFileSync(body, 'Proof type: docs\n');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, 'pre-pr.mjs'), '--body', body, '--wait-lock'], { cwd: repo.dir, encoding: 'utf8', windowsHide: true, env: LOCK_SAMPLES_ENV, timeout: 60_000 });
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /FAIL summary/);
  assert.match(r.stdout, /RESULT FAIL: no stamp/);
  assert.ok(Date.now() - t0 < 20_000, 'no lock wait');
  const runs = path.join(process.env.RUN_LOCK_DIR, 'runs.jsonl');
  const mine = existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((row) => row.pid === r.pid) : [];
  assert.deepEqual(mine, [], 'this child took no lock and logged no START');
  assert.equal(existsSync(path.join(repo.dir, PRE.STAMP_REL)), false);
});

// Seat ruling 14:44 (a)-(d): the exit handler writes END only when START was logged and END was not; it never throws; a normal end and a
// signal stop give one END row each. Breaks: write END with no START; write a second END after reportRunEnd; let a log error throw.
test('RL-END: endRowAtExit writes one ERROR row only after START and before any END, and never throws', () => {
  const rows = [];
  const lock = { logRun: (row) => rows.push(row) };
  const st = PRE.newRunLogState();
  assert.equal(PRE.endRowAtExit(3, { state: st, lock }), false, 'no START: no END row');
  st.started = { pid: 41, head: 'abcd1234', at: 0 };
  assert.equal(PRE.endRowAtExit(130, { state: st, lock, now: 6 * 60_000 }), true, 'a signal stop (exit 130) after START writes END');
  assert.deepEqual(rows, [{ event: 'end', pid: 41, head: 'abcd1234', result: 'ERROR', failing: null, exitCode: 130, minutes: 6 }]);
  assert.equal(PRE.endRowAtExit(130, { state: st, lock }), false, 'a second call writes no second row');
  const st2 = PRE.newRunLogState();
  st2.started = { pid: 42, head: null, at: 0 };
  PRE.reportRunEnd({ pid: 42, head: null, run: { ok: true, results: [] }, startedAt: 0, now: 60_000, lock, say: () => {}, state: st2 });
  assert.equal(PRE.endRowAtExit(0, { state: st2, lock }), false, 'after a normal END the exit handler writes nothing');
  assert.equal(rows.filter((r) => r.pid === 42 && r.event === 'end').length, 1, 'a normal run has exactly one END row');
  const st3 = PRE.newRunLogState();
  st3.started = { pid: 43, head: null, at: 0 };
  assert.doesNotThrow(() => PRE.endRowAtExit(1, { state: st3, lock: { logRun: () => { throw new Error('disk'); } } }), 'a log error never throws');
});

// ---------- part 4 of the hooks build-inputs note (Coord hooks, taken into card prflow-prepr-speed) ----------
// A file outside .claude/hooks that a hook bundle imports is listed in `external` of the committed dist/.build-inputs.json. A change set
// with only such a file must still run the hooks gates (the build and its dist diff), or a stale dist passes pre-pr and fails in CI.
// How it fails: BI-F7a the hooks surface matches by its globs only (no external read); BI-F7b a manifest with no `external`, or one that
// does not parse, adds a match or throws.
const BI_LIB = 'scripts/github/lib/answer-paths.mjs';
const writeManifest = (manifest) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'prepr-bi-'));
  mkdirSync(path.join(root, '.claude', 'hooks', 'dist'), { recursive: true });
  if (manifest !== undefined) writeFileSync(path.join(root, '.claude', 'hooks', 'dist', '.build-inputs.json'), manifest);
  return root;
};

test('BI-F7a: a change set with only an external input of the hooks build selects the hooks gates', () => {
  const root = writeManifest(JSON.stringify({ version: 1, inputs: {}, external: { [BI_LIB]: { sha256: 'a'.repeat(64) } } })); // the PR B format: keys are paths, values objects
  const externals = PRE.buildInputExternals(root);
  assert.deepEqual(externals, [BI_LIB]);
  const ids = PRE.gatesFor([BI_LIB], externals).map((g) => g.id);
  assert.ok(ids.includes('hooks-build'), `hooks-build runs (got ${ids.join(', ')})`);
  assert.ok(ids.includes('hooks-vitest'), 'hooks-vitest runs');
  assert.equal(PRE.isHeavyRun([BI_LIB], externals), true, 'the run is heavy');
  assert.ok(!PRE.gatesFor([BI_LIB]).some((g) => g.id === 'hooks-build'), 'control: without the list, the globs alone do not select it');
});

test('BI-F7b: no manifest, no external field, a bad external or bad JSON add nothing and never throw', () => {
  for (const m of [undefined, JSON.stringify({ version: 1, inputs: {} }), JSON.stringify({ version: 1, external: ['x.mjs'] }), JSON.stringify({ version: 1, external: null }), '{not json']) {
    const externals = PRE.buildInputExternals(writeManifest(m));
    assert.deepEqual(externals, [], `manifest ${String(m).slice(0, 30)}: no externals`);
    assert.ok(!PRE.gatesFor([BI_LIB], externals).some((g) => g.id === 'hooks-build'), 'no hooks gate');
  }
  const back = PRE.buildInputExternals(writeManifest(JSON.stringify({ version: 1, external: { 'a\\b.mjs': 'x' } })));
  assert.deepEqual(back, ['a/b.mjs'], 'a backslash key is read as a posix path');
});

// ---------- card prflow-prepr-speed follow-up (CodeRabbit CLI run 1) ----------
// How it can fail, one test each, with the source change that makes it fail:
//   M3  a change read that failed counts the run as light                                          (heavy only when the read has no paths)
//   D   a light grant stays light when the run's own change read finds the hooks-vitest gate       (no setHeavy call after the START read)
//   E   serial mode keeps phase test during the review, or sets cr when no review starts           (no phase call; a phase call on every end of the step)
//   I   a failed second open leaks the first descriptor                                            (both opens inside one push call)
//   J   a review that never started leaves its running file and its .err file                      (no remove on the not-started or throw path)
//   K   the END row of a normal run measures from before the wait, the error END row from START    (startedAt of main in reportRunEnd)
//   C   a late gateFailed mark is erased by a second run that wrote its old copy of the counter    (writes of a copy read at the start of the step)

test('M3: a change read that fails counts the run as heavy, not light', () => {
  const repo = makeRepo();
  const real = makeGit(repo.dir);
  assert.equal(PRE.runFacts(repo.dir, 'main', real).heavy, false, 'control: a docs-only change is light');
  const failing = (args) => (args[0] === 'diff' ? { status: 128, stdout: '', stderr: 'fatal: boom' } : real(args));
  assert.equal(PRE.runFacts(repo.dir, 'main', failing).heavy, true);
});

test('D: a light grant whose own change read says heavy turns the lock heavy and prints a NOTE; no second limit check', async () => {
  const lock = fakeLock();
  let n = 0;
  const r = lockRun(lock, { factsOf: () => ({ head: 'abcd1234', heavy: n++ > 0 }) }); // the grant reads light, the START read finds the hooks-vitest gate
  await r.done;
  assert.deepEqual(lock.calls.heavy, [{ file: 'pre-pr-1-2.lock', pid: 4242 }]);
  assert.ok(r.said.some((l) => /^NOTE/.test(l) && /heavy/.test(l)), r.said.join('\n'));
  assert.equal(lock.calls.acquire.length, 1, 'the lock is not asked again: it turns heavy and does not refuse');
  assert.deepEqual(r.exits, []);
  const same = fakeLock();
  await lockRun(same, { factsOf: () => ({ head: 'abcd1234', heavy: true }) }).done;
  await lockRun(same, { factsOf: () => ({ head: 'abcd1234', heavy: false }) }).done;
  assert.deepEqual(same.calls.heavy, [], 'granted heavy, or light and still light: no change');
  const broken = fakeLock({ setHeavy: () => { throw new Error('EBUSY: resource busy'); } });
  let m = 0;
  const b = lockRun(broken, { factsOf: () => ({ head: 'abcd1234', heavy: m++ > 0 }) });
  assert.equal((await b.done).file, 'pre-pr-1-2.lock', 'a lock write that fails does not stop the run');
  assert.ok(b.said.some((l) => /could not set the run lock to heavy \(EBUSY/.test(l)), b.said.join('\n'));
  assert.deepEqual(b.exits, []);
});

test('E: PRE_PR_SERIAL_CR=1 sets phase cr when the review really starts, and not on a skip, a reuse or a failed gate', async () => {
  const env = { PRE_PR_SERIAL_CR: '1' };
  const events = [];
  const repo = makeRepo();
  const exec = () => { events.push('gate'); return { status: 0, stdout: 'ran\nTests  1 passed (1)\n', stderr: '' }; };
  await prePr(repo, { env, onPhase: (p) => events.push(`phase ${p}`), exec, crRunner: slowReview(events, 150) });
  assert.deepEqual(events, ['gate', 'review-start', 'phase cr', 'review-end'], 'the phase turns cr as the review starts');
  const reuse = [];
  await prePr(repo, { env, onPhase: (p) => reuse.push(p) });
  assert.deepEqual(reuse, [], 'a reused saved output starts no review');
  const none = [];
  await prePr(makeRepo(), { env, skipCr: true, onPhase: (p) => none.push(p) });
  await prePr(makeRepo(), { env, onPhase: (p) => none.push(p), exec: gateFail() });
  assert.deepEqual(none, [], 'a skip and an earlier failed step start no review');
  const lines = [];
  await prePr(makeRepo(), { env, onPhase: () => { throw new Error('EBUSY: resource busy'); }, log: (l) => lines.push(l), crRunner: slowReview([], 50) });
  assert.ok(lines.some((l) => /could not set the run lock phase \(EBUSY/.test(l)), 'a phase write that fails does not stop the review');
});

test('I: a second open that fails closes the first descriptor', () => {
  const streamTo = tmpFile('leak.txt');
  mkdirSync(`${streamTo}.err`); // a folder cannot be opened for writing: the second open fails
  const probeFile = tmpFile('probe.txt');
  const probe = () => { const fd = openSync(probeFile, 'w'); closeSync(fd); return fd; }; // the lowest free descriptor number
  const before = probe();
  const pending = defaultCrRunner({ cwd: os.tmpdir(), args: REVIEW, timeoutMs: 20_000, streamTo, fileStdio: true }, { command: process.execPath, prefixArgs: ['-e', ''] });
  const after = probe(); // the opens run inside the call: a leaked descriptor shifts the lowest free number
  assert.equal(after, before, 'no descriptor of the failed open stays open');
  return pending.then((r) => assert.ok(r.error, 'the runner reports the failed open'));
});

test('J: a review that did not start (a not-started result, a throw, a rejected promise) leaves no running file and no .err file', async () => {
  const attempt = async (act) => {
    const f = crFixture();
    const runner = (o) => {
      if (o.args[0] === 'usage') return f.runner(o);
      writeFileSync(o.streamTo, ''); // the real runner opens both files before the child starts
      writeFileSync(`${o.streamTo}.err`, '');
      return act();
    };
    const settled = await runCodeRabbit(crOpts(f, { runner })).then((r) => ({ r }), (err) => ({ err }));
    const left = readdirSync(path.join(f.root, '.claude', 'cache', 'e2e')).filter((n) => /running/.test(n) || /\.err$/.test(n));
    return { ...settled, left };
  };
  const missing = await attempt(() => ({ status: null, error: 'spawn cr ENOENT', errorCode: 'ENOENT', stdout: '', stderr: '' }));
  assert.equal(missing.r.skipReason, 'cli-missing');
  assert.deepEqual(missing.left, [], 'not started: no leftover files');
  const thrown = await attempt(() => { throw new Error('boom'); });
  assert.match(String(thrown.err?.message), /boom/);
  assert.deepEqual(thrown.left, [], 'a throw: no leftover files');
  const rejected = await attempt(() => Promise.reject(new Error('boom2')));
  assert.match(String(rejected.err?.message), /boom2/);
  assert.deepEqual(rejected.left, [], 'a rejected promise: no leftover files');
});

test('K: the END row of a normal run and of an error exit both measure from the START time of the run', () => {
  const rows = [];
  const lock = { logRun: (row) => rows.push(row) };
  const started = { pid: 51, head: 'abcd1234', at: 10_000 };
  // main() read its own clock 8 minutes before START (the wait for the lock came between): that time must not be used when START is known.
  const beforeWait = started.at - 8 * 60_000;
  const now = started.at + 3 * 60_000;
  PRE.reportRunEnd({ pid: 51, head: 'abcd1234', run: { ok: true, results: [] }, startedAt: beforeWait, now, lock, say: () => {}, state: { started, ended: false } });
  PRE.endRowAtExit(3, { state: { started, ended: false }, lock, now });
  assert.deepEqual(rows.map((r) => [r.event, r.minutes]), [['end', 3], ['end', 3]]);
});

test('C: a review that ends before a failing gate gets its row marked gateFailed, and a second run that read the counter earlier does not erase the mark', async () => {
  const repo = makeRepo({ files: { 'scripts/a.mjs': 'export const a = 1;\n' } });
  const paths = crPaths(repo.dir, 'feat/x');
  const rowsNow = () => (existsSync(paths.counter) ? JSON.parse(readFileSync(paths.counter, 'utf8')).runs : []);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const secondRunner = async (o) => { if (o.args[0] === 'usage') { await held; return { status: 0, stdout: USAGE_OK, stderr: '' }; } return { status: 0, stdout: NDJSON_OK, stderr: '' }; };
  let second;
  const exec = () => {
    const over = rowsNow().at(-1)?.outcome === 'finished' && !existsSync(paths.lock); // the review of this run ended and its lock is gone
    if (!over) return { status: 0, stdout: 'ran\nTests  1 passed (1)\n', stderr: '' };
    // A second run starts on the same branch: it takes the counter lock and reads the counter, which has no mark yet. It waits in its usage check.
    second ??= runCodeRabbit({ root: repo.dir, branch: 'feat/x', head: hexOf('b'), base: 'main', now: new Date(Date.now() + 5000), runner: secondRunner, ledgerPath: tempLedger(), crStore: null, config: CONFIG, changedPaths: ['scripts/b.mjs'] });
    return { status: 1, stdout: 'bad\n# fail 1\n', stderr: '' };
  };
  const run = await prePr(repo, { exec, bodyText: featureBody(repo.head) });
  assert.ok(second, 'the second run started after the review of this run ended');
  assert.equal(run.result.ok, false);
  assert.equal(crStep(run).status, 'PASS', 'the review ended before the gate failed');
  assert.ok(existsSync(paths.lock), 'this run did not remove the counter lock of the second run');
  assert.deepEqual(rowsNow().map((r) => r.gateFailed === true), [true], 'the row of this run is marked');
  release();
  await second;
  assert.deepEqual(rowsNow().map((r) => r.gateFailed === true), [true, false], 'the second run wrote its row and kept the mark');
  assert.equal(existsSync(paths.lock), false, 'the second run freed its lock');
});

test('C-lock: the late gateFailed mark takes the counter lock: a lock file with no live holder is replaced, and no lock file is left after the mark', async () => {
  const repo = makeRepo({ files: { 'scripts/a.mjs': 'export const a = 1;\n' } });
  const paths = crPaths(repo.dir, 'feat/x');
  const rowsNow = () => (existsSync(paths.counter) ? JSON.parse(readFileSync(paths.counter, 'utf8')).runs : []);
  let planted = false;
  const exec = () => {
    if (!(rowsNow().at(-1)?.outcome === 'finished' && !existsSync(paths.lock))) return { status: 0, stdout: 'ran\nTests  1 passed (1)\n', stderr: '' };
    if (!planted) { planted = true; writeFileSync(paths.lock, JSON.stringify({ pid: 'none', head: 'x', at: new Date().toISOString() })); } // a lock nobody holds: no pid
    return { status: 1, stdout: 'bad\n# fail 1\n', stderr: '' };
  };
  const run = await prePr(repo, { exec, bodyText: featureBody(repo.head) });
  assert.ok(planted, 'a gate failed after the review ended');
  assert.equal(run.result.ok, false);
  assert.deepEqual(rowsNow().map((r) => r.gateFailed === true), [true]);
  assert.equal(existsSync(paths.lock), false, 'the mark replaced the unheld lock file and freed its own');
});
