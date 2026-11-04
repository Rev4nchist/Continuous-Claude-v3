// Tests for oracle0-arm.mjs. They call the real functions with stub deps: no git, no process and no model is started.
// The live path (--live) needs an injected runGroup; a test proves it is never called without --live.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildArm, main, mapOutcome, outcomeOf, parseCatFileBatch, targetsOf, tally } from './oracle0-arm.mjs';
import { loadProbeSet, narrowedSet, scoreArms, validateArm } from './score-arms.mjs';

const PS = loadProbeSet();
const ROWS = PS.rows;
const N16 = ROWS.filter((r) => r.file === 'scripts/github/pre-pr.mjs');
const FAIL = { code: 1, stdout: 'TAP version 13\nnot ok 1 - thing\n', stderr: '' };
const PASS = { code: 0, stdout: 'TAP version 13\nok 1 - thing\n', stderr: '' };
const BROKEN = { code: 1, stdout: '', stderr: 'Error [ERR_MODULE_NOT_FOUND]: Cannot find module' };

/** Stub deps. tests: { <repo path of a finding file>: [test paths] }. runs(row) -> { head, base }. */
function stubDeps({ tests = {}, runs = () => ({ head: PASS, base: PASS }), spec = {} } = {}) {
  const calls = { runGroup: [], headContext: [] };
  return {
    calls,
    headContext(head) {
      calls.headContext.push(head);
      const testPaths = Object.values(tests).flat();
      const src = Object.keys(tests);
      return { listed: [...src, ...testPaths], read: (p) => spec[p] ?? '' };
    },
    async runGroup(row) { calls.runGroup.push(row); return runs(row); },
    now: () => '2026-11-03T00:00:00.000Z',
  };
}
const withTests = { 'scripts/github/pre-pr.mjs': ['scripts/github/pre-pr.test.mjs'] };

// ---------- the outcome map ----------

// Breaks if: anything but a differential fail on a nearest test becomes a verdict that changes a severity.
test('mapOutcome: only differential-fail is reproduced; every other outcome is not_attempted with its name in the reason', () => {
  assert.equal(mapOutcome('differential-fail', 'x').verdict, 'reproduced');
  for (const o of ['preexisting-fail', 'no-signal', 'broken', 'no-runnable-test', 'no-test']) {
    const m = mapOutcome(o, 'detail');
    assert.equal(m.verdict, 'not_attempted', o);
    assert.match(m.reason, new RegExp(o));
  }
});

// Breaks if: a clean pass at head is mapped to not_reproduced (no cited-line coverage on the host: G8 forbids it).
test('mapOutcome: a clean pass (no-signal) never downgrades', () => {
  assert.notEqual(mapOutcome('no-signal', '').verdict, 'not_reproduced');
});

// Breaks if: the priority is wrong (a broken sibling hides a fire, or a skip hides a clean run).
test('outcomeOf: a fire wins, then preexisting, then clean, then broken, then unrunnable, then no tests', () => {
  const g = (d, extra = {}) => ({ kind: 'node', differential: d && { verdict: d }, ...extra });
  assert.equal(outcomeOf([g('broken'), g('differential-fail'), g('no-signal')]).outcome, 'differential-fail');
  assert.equal(outcomeOf([g('no-signal'), g('preexisting-fail')]).outcome, 'preexisting-fail');
  assert.equal(outcomeOf([g('broken'), g('no-signal')]).outcome, 'no-signal');
  assert.equal(outcomeOf([g('broken')]).outcome, 'broken');
  assert.equal(outcomeOf([{ kind: 'x', skipped: 'container' }]).outcome, 'no-runnable-test');
  assert.equal(outcomeOf([]).outcome, 'no-test');
});

// ---------- the arm file ----------

// Breaks if: a pid is missing, a classify block is lost, a severity changes, or the file fails the C2 check of score-arms.
test('buildArm: all 44 pids, classify blocks kept and never run, severities unchanged, valid for score-arms', () => {
  const results = new Map(ROWS.filter((r) => !r.blocked).slice(0, 3).map((r) => [r.pid, { outcome: 'differential-fail', detail: 'x', tests: ['t.test.mjs'], evidencePath: `evidence/${r.pid}.json` }]));
  const arm = buildArm(ROWS, results, { generatedFrom: 'test' });
  assert.equal(arm.arm, 'oracle0');
  assert.equal(arm.rows.length, 44);
  assert.equal(arm.rows.filter((r) => r.verdict === 'blocked:mods-host').length, 8);
  assert.equal(arm.rows.filter((r) => r.verdict === 'reproduced').length, 3);
  assert.ok(arm.rows.every((r) => r.newSeverity === r.originalSeverity && r.newConfidence === r.originalConfidence && r.falseConfirm === null));
  assert.doesNotThrow(() => validateArm(arm, ROWS));
  const rep = scoreArms({ probeSet: PS, arms: { oracle0: arm } });
  const m = rep.arms.oracle0.narrowed.byView.majorOpen;
  assert.deepEqual([m.keptHits, m.keptB, m.hitsLost], [3, 13, 0]);
});

// Breaks if: only the scored set is targeted (group C unblocked findings must be run too) or a blocked finding is targeted.
test('targetsOf: every finding classify did not block, in groups A, B and C', () => {
  const t = targetsOf(ROWS);
  assert.equal(t.length, 35);
  assert.ok(t.every((r) => r.blocked === null));
  assert.deepEqual([...new Set(t.map((r) => r.group))].sort(), ['A', 'B', 'C']);
  assert.equal(narrowedSet(ROWS).a.length + narrowedSet(ROWS).b.length, 16);
});

// Breaks if: the tally leaves out a group or counts a blocked row.
test('tally: outcomes counted per group, over unblocked findings only', () => {
  const results = new Map([[ROWS[0].pid, { outcome: 'no-signal' }], [ROWS[1].pid, { outcome: 'no-test' }]]);
  const t = tally(ROWS, results);
  assert.equal(t.A['no-signal'], 1);
  assert.equal(t.A['no-test'] ?? 0, 0);
});

// ---------- git blobs ----------

// Breaks if: a blob with a newline, a missing object or a header-like line in the content shifts the next blob.
test('parseCatFileBatch: sequential blobs, a missing object is null, content may hold newlines', () => {
  const a = 'line1\n123 blob 5\nline3';
  const buf = Buffer.concat([
    Buffer.from(`${'a'.repeat(40)} blob ${Buffer.byteLength(a)}\n${a}\n`),
    Buffer.from('head:gone missing\n'),
    Buffer.from(`${'b'.repeat(40)} blob 2\nhi\n`),
  ]);
  assert.deepEqual(parseCatFileBatch(buf, 3), [a, null, 'hi']);
  assert.throws(() => parseCatFileBatch(Buffer.from('garbage'), 1), /cat-file/);
});

// ---------- the live gate ----------

// Breaks if: the run step is reachable without --live. This is the zero-model, zero-process guarantee of the default run.
test('main without --live: runGroup is never called, plan.json is written and verdicts.json is not', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oracle0-plan-'));
  try {
    const deps = stubDeps({ tests: withTests });
    const out = path.join(dir, 'trex-verify-p1');
    const lines = [];
    const code = await main(['--out', out], deps, { log: (s) => lines.push(s) });
    assert.equal(code, 0);
    assert.equal(deps.calls.runGroup.length, 0);
    assert.ok(deps.calls.headContext.length > 0);
    assert.ok(existsSync(path.join(out, 'oracle0', 'plan.json')));
    assert.equal(existsSync(path.join(out, 'oracle0', 'verdicts.json')), false);
    const plan = JSON.parse(readFileSync(path.join(out, 'oracle0', 'plan.json'), 'utf8'));
    assert.equal(plan.rows.find((r) => r.pid === N16[0].pid).groups[0].files[0], 'scripts/github/pre-pr.test.mjs');
    assert.match(lines.join('\n'), /plan only/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Breaks if: a run needs a real dep, a pid is lost, or sibling findings do not share one run.
test('main --live: one run per (head, base, tests), N16 findings share it, the differential decides, files are written', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oracle0-live-'));
  try {
    const deps = stubDeps({ tests: withTests, runs: () => ({ head: FAIL, base: PASS }) });
    const out = path.join(dir, 'trex-verify-p1');
    const code = await main(['--out', out, '--live', '--date', '2026-11-03'], deps, { log: () => {} });
    assert.equal(code, 0);
    assert.equal(deps.calls.runGroup.length, 1, 'four N16 findings, one test, one head/base pair');
    const arm = JSON.parse(readFileSync(path.join(out, 'oracle0', 'verdicts.json'), 'utf8'));
    assert.equal(arm.rows.length, 44);
    const n16 = arm.rows.filter((r) => N16.some((x) => x.pid === r.pid));
    assert.equal(n16.length, 4);
    assert.ok(n16.every((r) => r.verdict === 'reproduced' && r.evidencePath));
    assert.equal(arm.rows.filter((r) => r.verdict === 'reproduced').length, 4);
    assert.ok(existsSync(path.join(out, 'oracle0', r0(n16[0].evidencePath))));
    assert.ok(existsSync(path.join(dir, '2026-11-03-trex-verify-p1-oracle0.json')));
    const dated = JSON.parse(readFileSync(path.join(dir, '2026-11-03-trex-verify-p1-oracle0.json'), 'utf8'));
    assert.equal(dated.rows.length, 44);
    assert.equal(dated.summary.tally.B['differential-fail'], 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const r0 = (p) => p.replace(/^oracle0[\\/]/, '');

// Breaks if: one broken runner aborts the arm, or a broken run is read as a fire.
test('main --live: a runner that throws or a broken run gives not_attempted for that finding only', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oracle0-broken-'));
  try {
    let n = 0;
    const deps = stubDeps({ tests: { ...withTests, 'scripts/github/pr-checkpoint.mjs': ['scripts/github/pr-checkpoint.test.mjs'] }, runs: () => { n += 1; if (n === 1) throw new Error('boom'); return { head: BROKEN, base: PASS }; } });
    const out = path.join(dir, 'p1');
    assert.equal(await main(['--out', out, '--live'], deps, { log: () => {} }), 0);
    const arm = JSON.parse(readFileSync(path.join(out, 'oracle0', 'verdicts.json'), 'utf8'));
    assert.equal(arm.rows.filter((r) => r.verdict === 'reproduced').length, 0);
    const bad = arm.rows.filter((r) => /broken|setup error/.test(r.reason));
    assert.ok(bad.length >= 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Breaks if: a Playwright server spec is run on the host or its skip is silent.
test('main --live: a server spec group is skipped with its reason and never reaches runGroup', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oracle0-server-'));
  try {
    const spec = 'apps/agentic-os/e2e/x.spec.ts';
    const s1 = ROWS.find((r) => r.row === 'S1' && !r.blocked);
    const deps = stubDeps({ tests: { [s1.file]: [spec] }, spec: { [spec]: "import { f } from '../src/server/sources/safe-message';\ntest('a', async ({ page }) => {});" } });
    const out = path.join(dir, 'p1');
    assert.equal(await main(['--out', out, '--live'], deps, { log: () => {} }), 0);
    assert.equal(deps.calls.runGroup.length, 0);
    const row = JSON.parse(readFileSync(path.join(out, 'oracle0', 'verdicts.json'), 'utf8')).rows.find((r) => r.pid === s1.pid);
    assert.equal(row.verdict, 'not_attempted');
    assert.match(row.reason, /no-runnable-test.*container|container/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Breaks if: --pids is ignored, so a trial run starts every test.
test('main --pids limits the findings that are planned and run', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oracle0-pids-'));
  try {
    const deps = stubDeps({ tests: withTests, runs: () => ({ head: PASS, base: PASS }) });
    const out = path.join(dir, 'p1');
    assert.equal(await main(['--out', out, '--live', '--pids', N16[0].pid], deps, { log: () => {} }), 0);
    assert.equal(deps.calls.runGroup.length, 1);
    const arm = JSON.parse(readFileSync(path.join(out, 'oracle0', 'verdicts.json'), 'utf8'));
    assert.equal(arm.rows.find((r) => r.pid === N16[0].pid).verdict, 'not_attempted');
    assert.match(arm.rows.find((r) => r.pid === N16[0].pid).reason, /no-signal/);
    assert.match(arm.rows.find((r) => r.pid === N16[1].pid).reason, /not selected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Breaks if: a head that is clean needs a base run to be labelled, or a base that cannot load (the PR added the import) turns a clean head into "broken".
test('main --live: no base run (head clean) is no-signal, a broken head is broken, a fire with no base run is broken', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oracle0-nobase-'));
  try {
    const arm = async (head) => {
      const deps = stubDeps({ tests: withTests, runs: () => ({ head, base: null }) });
      const out = path.join(dir, `p-${Math.random().toString(36).slice(2)}`);
      assert.equal(await main(['--out', out, '--live', '--pids', N16[0].pid], deps, { log: () => {} }), 0);
      return JSON.parse(readFileSync(path.join(out, 'oracle0', 'verdicts.json'), 'utf8')).rows.find((r) => r.pid === N16[0].pid);
    };
    assert.match((await arm(PASS)).reason, /no-signal/);
    assert.match((await arm(BROKEN)).reason, /broken/);
    const fire = await arm(FAIL);
    assert.equal(fire.verdict, 'not_attempted');
    assert.match(fire.reason, /no base run/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Fix 1 (critic major 1). Breaks if: the live file has no dryRun false marker, or attemptedPids does not list every finding the arm ran,
// so score-arms cannot tell a finished control from a plan or a --pids trial.
test('Fix 1: main --live writes dryRun false, partial false and attemptedPids for every unblocked finding; --pids makes it partial', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oracle0-live-marker-'));
  try {
    const deps = stubDeps({ tests: withTests, runs: () => ({ head: PASS, base: PASS }) });
    const out = path.join(dir, 'p1');
    assert.equal(await main(['--out', out, '--live'], deps, { log: () => {} }), 0);
    const arm = JSON.parse(readFileSync(path.join(out, 'oracle0', 'verdicts.json'), 'utf8'));
    assert.deepEqual([arm.dryRun, arm.partial], [false, false]);
    const unblocked = arm.rows.filter((r) => !r.verdict.startsWith('blocked:')).map((r) => r.pid).sort();
    assert.deepEqual([...arm.attemptedPids].sort(), unblocked);
    const out2 = path.join(dir, 'p2');
    assert.equal(await main(['--out', out2, '--live', '--pids', N16[0].pid], deps, { log: () => {} }), 0);
    const part = JSON.parse(readFileSync(path.join(out2, 'oracle0', 'verdicts.json'), 'utf8'));
    assert.equal(part.partial, true);
    assert.deepEqual(part.attemptedPids, [N16[0].pid]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
