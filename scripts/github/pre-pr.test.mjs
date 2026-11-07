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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, utimesSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as PRE from './pre-pr.mjs';
import { REGISTRY } from '../checks/parser-fixtures/registry.mjs';
import { MARKER } from './lib/pssa-advisory.mjs';
import { cliCapOf } from './cr-paid.mjs';
import { envStep } from './lib/env-step.mjs';
import {
  SURFACES, ALWAYS_GATES, CATCHER_PARSER_FILES, BASE_TOKEN, withBase, CR_ARGS, CR_RUN_LIMIT, STAMP_REL, gatesFor, summaryLine, checkGit, checkEvidence,
  runCodeRabbit, runPrePr, assertSafeCrArgs, changedFiles, makeGit, notesFor,
  parseAgentStream, parseUsage, usageCostOf, crTimeoutMs, defaultCrRunner, CR_USAGE_ARGS,
  killTree, sharedPrDir, crPaths, finishedRuns, logCliMissing, crTimeoutProblem, runGate, resolveSpawn, acquireLock,
} from './pre-pr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CONFIG = JSON.parse(readFileSync(path.join(REPO_ROOT, 'review-router.config.json'), 'utf8'));
// Never read or write Dave's real paid ledger: every run here that could touch it gets a temp one.
// Safety net: a run that forgets gateLogPath still writes to a temp file, never to Dave's real pre-pr-gates.jsonl.
process.env.PRE_PR_GATE_LOG = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-gatelog-env-')), 'pre-pr-gates.jsonl');
const tempLedger = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-ledger-')), 'coderabbit-paid.jsonl');

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
      // The folder is the part before the first wildcard segment, so `scripts/trex/**/*.test.mjs` is checked in scripts/trex.
      const glob = g.args.find((x) => x.includes('*'));
      const dir = path.join(cwd, glob.split('/').slice(0, glob.split('/').findIndex((seg) => seg.includes('*'))).join('/'));
      // TREX lands from its own branch: until scripts/trex exists here, its glob has nothing to match (Node 22 exits 0 on that).
      if (g.id === 'trex-tests' && !existsSync(dir)) continue;
      assert.ok(readdirSync(dir, { recursive: glob.includes('**') }).some((n) => /\.test\.mjs$/.test(n)), `${g.id}: the glob matches no test file`);
    }
  }
});

test('S2: hooks source runs the build with a dist check, vitest, the Semgrep pack and the always gate', async () => {
  const got = gatesFor(['.claude/hooks/src/pre-pr-gate.ts'], REPO_ROOT);
  assert.deepEqual(ids(got).sort(), ['context-budget', 'hooks-build', 'hooks-vitest', 'semgrep-ccv3']);
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

// ---------- dependency routing: a path that feeds a gate selects it, even when the diff never touches that gate's own folder ----------

test('GR1: a hooks dependency (store link script, hooks package files, tsconfig, any workflow) runs hooks-build and hooks-vitest (#352 shipped a stale dist because none ran)', async () => {
  for (const p of ['scripts/worktree/shared-deps.mjs', '.claude/hooks/package-lock.json', '.claude/hooks/tsconfig.json', '.claude/hooks/tsconfig.build.json', '.github/workflows/gitleaks.yml', '.github/workflows/ccv3-checks.yml']) {
    const got = ids(gatesFor([p], REPO_ROOT));
    assert.ok(got.includes('hooks-build'), `${p} -> hooks-build`);
    assert.ok(got.includes('hooks-vitest'), `${p} -> hooks-vitest`);
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

test('GW4b: a change under scripts/trex, or to the shared selector test-map.mjs, runs the TREX node tests', async () => {
  for (const p of ['scripts/trex/run.mjs', '.trex/flows/x.yaml', 'docker/trex/Dockerfile', 'scripts/checks/test-map.mjs']) {
    const g = gatesFor([p], REPO_ROOT).find((x) => x.id === 'trex-tests');
    assert.ok(g, p);
    assert.deepEqual([g.cmd, g.args], ['node', ['--test', 'scripts/trex/**/*.test.mjs']]);
  }
  assert.equal(gatesFor(['scripts/github/lib/proc.mjs'], REPO_ROOT).some((x) => x.id === 'trex-tests'), false);
});

test('GW4c: a change to test-map.mjs runs test-map.test.mjs, and one under scripts/github/local-review runs the tests in that folder (breaks if either test file is left out of every gate)', async () => {
  const tm = gatesFor(['scripts/checks/test-map.mjs'], REPO_ROOT).find((x) => x.id === 'test-map-tests');
  assert.ok(tm);
  assert.deepEqual([tm.cmd, tm.args], ['node', ['--test', 'scripts/checks/test-map.test.mjs']]);
  assert.ok(existsSync(path.join(REPO_ROOT, tm.args[1])));
  const lr = gatesFor(['scripts/github/local-review/record.mjs'], REPO_ROOT).find((x) => x.id === 'local-review-tests');
  assert.ok(lr);
  assert.deepEqual([lr.cmd, lr.args], ['node', ['--test', 'scripts/github/local-review/*.test.mjs']]);
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
  const calls = [];
  const usageCalls = [];
  const runner = (opts) => {
    if (opts.args[0] === 'usage') { usageCalls.push(opts); return runner.usage ?? { status: 0, stdout: USAGE_OK, stderr: '' }; }
    calls.push(opts);
    return runner.next ?? { status: 0, stdout: NDJSON_OK, stderr: '' };
  };
  return { root, calls, usageCalls, runner, now: new Date('2026-10-27T10:00:00Z'), ledgerPath: tempLedger() };
}
const crOpts = (f, extra = {}) => ({ root: f.root, branch: 'feat/x', head: HEAD, base: 'main', now: f.now, runner: f.runner, ledgerPath: f.ledgerPath, ...extra });

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
    gateLogPath: tempGateLog(),
    // The osv and pssa advisories never start a scanner or touch the network here: no lockfile, no binary. The OSV-PP / PSSA-PP tests inject their own.
    osvLockfiles: [], findOsv: () => null, findPssa: () => null,
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
  assert.match(envLines[0], /^FAIL env - ENV: hooks-build needs esbuild\. Tried .+This is the environment, not your change\. Fix: run `node scripts\/worktree\/shared-deps\.mjs --check` in /);
  assert.ok(result.lines.some((l) => /^ {4}ENV: hooks-vitest needs vitest\./.test(l)), 'the second missing need is a note under the line');
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
  const { result } = await prePr(makeRepo(), { gateLogPath: file, exec: slowFail() });
  assert.equal(result.ok, false);
  const row = rowsOf(file).find((r) => r.step === 'gate:context-budget');
  assert.equal(row.status, 'FAIL');
  assert.equal(typeof row.ms, 'number');
  assert.ok(row.ms >= 10, `ms was ${row.ms}`);
  assert.equal(rowsOf(file).find((r) => r.step === 'coderabbit').status, 'SKIP');
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
