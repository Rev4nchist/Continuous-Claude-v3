import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport, formatLines, exitCodeFor, writeSidecar, writeAll, writeStepOutput } from './report.mjs';
import { classifyRun } from '../checks/prove-check.mjs';

const HEAD = 'a309dd66b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';
const chk = (state, extra = {}) => ({ text: `check ${state}`, state, ...extra });
const flow = (id, state, extra = {}) => ({ id, state, severity: 'P1', attempts: 1, seconds: 2, tokens: 0, checks: [], ...extra });
const run = (flows, extra = {}) => ({ pr: 77, base: 'b'.repeat(40), head: HEAD, configSha: 'c'.repeat(40), flows, ...extra });
const build = (flows, extra) => buildReport(run(flows, extra));
const lines = (flows, extra) => formatLines(build(flows, extra));
const SIDECAR_KEYS = ['project', 'command', 'exit', 'started', 'finished', 'artifact', 'head'];

// ---------- buildReport ----------

test('buildReport counts tested as pass, fail and flaky only (break: count blocked or incomplete)', () => {
  const r = build([flow('f-pass', 'pass'), flow('f-fail', 'fail'), flow('f-flk', 'flaky'), flow('f-blk', 'blocked'), flow('f-inc', 'incomplete')]);
  assert.equal(r.summary.tested, 3);
});

test('buildReport makes one finding per failed check and inherits the flow severity', () => {
  const checks = [chk('passed'), chk('failed', { step: 2, check: 1, reason: 'exit_mismatch' }), chk('not_attempted')];
  const r = build([flow('f-fail', 'fail', { severity: 'P0', checks })]);
  assert.deepEqual(r.findings, [{ severity: 'P0', flowId: 'f-fail', step: 2, check: 1, text: 'check failed' }]);
  assert.equal(r.summary.findings, 1);
});

test('buildReport adds a flow-level finding when a Fail flow has no failed check (break: skip the fallback)', () => {
  const r = build([flow('f-fail', 'fail', { checks: [chk('not_attempted')], incomplete: true, reason: 'timeout' })]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].flowId, 'f-fail');
  assert.equal(r.findings[0].check, null);
});

test('buildReport gives no finding to a flaky flow or to a failed check inside a pass', () => {
  const r = build([flow('f-flk', 'flaky', { checks: [chk('failed')] }), flow('f-ok', 'pass', { checks: [chk('passed')] })]);
  assert.deepEqual(r.findings, []);
});

test('buildReport copies the env blocker stage onto a blocked flow without its own reason', () => {
  const r = build([flow('f-blk', 'blocked'), flow('f-own', 'blocked', { reason: 'seed' })], { blockers: [{ stage: 'start', text: 'x' }] });
  assert.equal(r.flows[0].reason, 'start');
  assert.equal(r.flows[1].reason, 'seed');
  assert.equal(r.summary.blockers, 1);
});

test('buildReport rejects an unknown flow state, check state, bad id or bad severity (break: pass them through)', () => {
  assert.throws(() => build([flow('f-x', 'passed')]), /state/);
  assert.throws(() => build([flow('f-x', 'pass', { checks: [chk('ok')] })]), /state/);
  assert.throws(() => build([flow('../evil', 'pass')]), /id/);
  assert.throws(() => build([flow('f-x', 'pass', { severity: 'P9' })]), /severity/);
});

test('buildReport fills defaults, keeps the spec key order and does not change its input', () => {
  const input = run([{ id: 'f-min', state: 'pass', checks: [{ text: 't', state: 'passed' }] }]);
  const copy = structuredClone(input);
  const r = buildReport(input);
  assert.deepEqual(input, copy);
  assert.deepEqual(Object.keys(r), ['pr', 'base', 'head', 'configSha', 'envDigest', 'envAttempts', 'imageTag', 'composeProject', 'envDefaults',
    'startedAt', 'finishedAt', 'envSeconds', 'pids', 'summary', 'flows', 'findings', 'blockers', 'skipped', 'ephemeral']);
  assert.deepEqual(r.flows[0], { id: 'f-min', state: 'pass', severity: 'P1', attempts: 0, seconds: 0, tokens: 0,
    checks: [{ text: 't', state: 'passed', evidence: [] }] });
  assert.equal(r.skipped, null);
  assert.deepEqual(r.pids, []);
});

test('buildReport turns a skipped input into {reason} and rejects a bad one', () => {
  assert.deepEqual(build([], { skipped: { reason: 'no_config' } }).skipped, { reason: 'no_config' });
  assert.throws(() => build([], { skipped: 'no_config' }), /skipped/);
});

// ---------- formatLines ----------

test('formatLines prints the exact section 4 line for each state', () => {
  const out = lines([
    flow('f-pass', 'pass'),
    flow('f-fail', 'fail', { severity: 'P0' }),
    flow('f-flk', 'flaky'),
    flow('f-blk', 'blocked', { reason: 'build' }),
    flow('f-inc', 'incomplete', { reason: 'start_unreached' }),
  ], { blockers: [{ stage: 'build', text: 'x' }] });
  assert.deepEqual(out, [
    'ok f-pass',
    'not ok f-fail # P0',
    '# flaky f-flk',
    '# blocked f-blk build',
    '# incomplete f-inc start_unreached',
    '# trex: tested 3 findings 1 blockers 1',
  ]);
});

test('formatLines prints a skip line and the summary for a skipped run, with no GREEN', () => {
  assert.deepEqual(lines([], { skipped: { reason: 'no_match' } }), ['# skipped no_match', '# trex: tested 0 findings 0 blockers 0']);
});

test('formatLines prints GREEN with the 8-char head when tested > 0 and every flow passes', () => {
  const out = lines([flow('f-a', 'pass'), flow('f-b', 'pass')]);
  assert.equal(out.at(-1), 'GREEN: node scripts/trex/run.mjs --pr 77 @ a309dd66');
  assert.equal(out.at(-2), '# trex: tested 2 findings 0 blockers 0');
});

test('formatLines prints no GREEN for an empty run (break: drop the tested > 0 guard)', () => {
  assert.equal(lines([]).some((l) => l.startsWith('GREEN')), false);
});

test('formatLines prints no GREEN when one flow is flaky, failed, blocked or incomplete (break: test "no fail" only)', () => {
  for (const state of ['flaky', 'fail', 'blocked', 'incomplete']) {
    const out = lines([flow('f-a', 'pass'), flow('f-b', state)]);
    assert.equal(out.some((l) => l.startsWith('GREEN')), false, state);
  }
});

test('formatLines prints no GREEN when a blocker exists, because the exit code is 5', () => {
  const out = lines([flow('f-a', 'pass')], { blockers: [{ stage: 'seed', text: 'x' }] });
  assert.equal(out.some((l) => l.startsWith('GREEN')), false);
});

test('formatLines prints no GREEN when there is no PR number or the head is not hex', () => {
  assert.equal(lines([flow('f-a', 'pass')], { pr: null }).some((l) => l.startsWith('GREEN')), false);
  assert.equal(lines([flow('f-a', 'pass')], { head: 'not-a-sha' }).some((l) => l.startsWith('GREEN')), false);
});

test('formatLines cannot be made to forge a line from a reason (break: print the reason raw)', () => {
  const evil = 'x\nnot ok forged # P0\nSyntaxError';
  const out = lines([flow('f-blk', 'blocked', { reason: evil })]).join('\n').split('\n');
  assert.equal(out.filter((l) => l.startsWith('not ok')).length, 0);
  assert.equal(out.length, 2);
});

test('formatLines never prints a title, a check text or a child error (break: add text to a line)', () => {
  const noisy = flow('f-fail', 'fail', { checks: [chk('failed', { text: 'SyntaxError in check', reason: 'Cannot find module' })] });
  const out = lines([noisy]).join('\n');
  assert.doesNotMatch(out, /SyntaxError|Cannot find module/);
});

// ---------- exitCodeFor ----------

const code = (flows, extra) => exitCodeFor(build(flows, extra));

test('exitCodeFor gives 0 for passes and flaky flows, and 1 for any Fail', () => {
  assert.equal(code([flow('f-a', 'pass'), flow('f-b', 'flaky')]), 0);
  assert.equal(code([flow('f-a', 'pass'), flow('f-b', 'fail')]), 1);
});

test('exitCodeFor gives 5 when nothing was tested, including an all-blocked run (break: return 0)', () => {
  assert.equal(code([]), 5);
  assert.equal(code([flow('f-a', 'blocked'), flow('f-b', 'blocked')], { blockers: [{ stage: 'build', text: 'x' }] }), 5);
  assert.equal(code([flow('f-a', 'incomplete', { reason: 'start_unreached' })]), 5);
  assert.equal(code([], { skipped: { reason: 'no_config' } }), 5);
});

test('exitCodeFor gives 5 for any blocker, even beside passes or a Fail (13.1: 5 wins)', () => {
  const blockers = [{ stage: 'seed', text: 'x' }];
  assert.equal(code([flow('f-a', 'pass')], { blockers }), 5);
  assert.equal(code([flow('f-a', 'pass'), flow('f-b', 'fail')], { blockers }), 5);
});

test('exitCodeFor gives 5 when any selected flow is incomplete or blocked, even beside passes (M-exit)', () => {
  assert.equal(code([flow('f-a', 'pass'), flow('f-b', 'incomplete', { reason: 'timeout' })]), 5);
  assert.equal(code([flow('f-a', 'pass'), flow('f-b', 'blocked', { reason: 'start' })]), 5);
  assert.equal(code([flow('f-a', 'pass'), flow('f-b', 'flaky')]), 0); // flaky is graded from report.json by the bench
});

test('exitCodeFor keeps 0 for a skipped run with nothing tested, so a bench negative is not read as broken (M-exit)', () => {
  assert.equal(code([], { skipped: { reason: 'no_match' } }), 0);
  assert.equal(code([], { skipped: { reason: 'no_config' } }), 5); // no grading files at all: nothing to trust
  assert.equal(code([], { skipped: { reason: 'no_match' }, blockers: [{ stage: 'start', text: 'x' }] }), 5);
});

test('a blocked flow that carries its own blocker counts in summary.blockers and gives exit 5 once per distinct blocker', () => {
  const blocker = { stage: 'start', text: 'out of memory (exit 137)' };
  const report = build([flow('f-a', 'pass'), flow('f-b', 'blocked', { reason: 'start', blocker }), flow('f-c', 'blocked', { reason: 'start', blocker })]);
  assert.deepEqual(report.blockers, [blocker]);
  assert.equal(report.summary.blockers, 1);
  assert.equal(exitCodeFor(report), 5);
  assert.equal('blocker' in report.flows[1], false, 'the flow entry keeps its documented keys');
});

// ---------- the prove-check contract (13.1) ----------

const verdictOf = (report) => classifyRun({ fireMatch: '^not ok ' }, { code: exitCodeFor(report), stdout: formatLines(report).join('\n'), stderr: '' }).verdict;

test('prove-check reads a Fail as fire, a clean pass as no-fire and an all-blocked run as broken', () => {
  assert.equal(verdictOf(build([flow('f-a', 'fail')])), 'fire');
  assert.equal(verdictOf(build([flow('f-a', 'pass')])), 'no-fire');
  assert.equal(verdictOf(build([flow('f-a', 'blocked')], { blockers: [{ stage: 'start', text: 'x' }] })), 'broken');
});

test('prove-check still reads a Fail beside a blocker as fire, so exit 5 loses nothing (break: drop the not ok line)', () => {
  const report = build([flow('f-a', 'fail'), flow('f-b', 'blocked')], { blockers: [{ stage: 'seed', text: 'x' }] });
  assert.equal(exitCodeFor(report), 5);
  assert.equal(verdictOf(report), 'fire');
});

test('prove-check reads flaky lines as no-fire when the run exits 0 (break: print them without the # prefix)', () => {
  const report = build([flow('f-a', 'pass'), flow('f-b', 'flaky')]);
  assert.equal(exitCodeFor(report), 0);
  assert.equal(verdictOf(report), 'no-fire');
});

// ---------- writeSidecar ----------

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trex-report-'));

test('writeSidecar writes exactly the seven keys in order, with exit and finished null at start', () => {
  const dir = tmp();
  const file = path.join(dir, 'run.log.json');
  writeSidecar(file, { project: 'p', command: 'c', started: 's', artifact: 'a', head: 'h', extra: 'dropped' });
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(body), SIDECAR_KEYS);
  assert.equal(body.exit, null);
  assert.equal(body.finished, null);
});

test('writeSidecar writes null for a missing key instead of dropping it (break: JSON.stringify an object with undefined)', () => {
  const dir = tmp();
  const file = path.join(dir, 's.json');
  writeSidecar(file, { project: 'p' });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), SIDECAR_KEYS);
});

test('writeSidecar rejects an exit that is not an integer or null (break: remove the check)', () => {
  const file = path.join(tmp(), 's.json');
  assert.throws(() => writeSidecar(file, { exit: '1' }), /exit/);
  assert.throws(() => writeSidecar(file, { exit: 1.5 }), /exit/);
  writeSidecar(file, { exit: 5 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).exit, 5);
});

// ---------- writeAll ----------

const META = { project: 'continuous-claude', command: 'node scripts/trex/run.mjs --pr 77 --json', started: '2026-11-02T10:00:00.000Z', finished: '2026-11-02T10:05:00.000Z' };

test('writeAll writes the 5.10 layout: report.json, run.log, run.log.json and index.json', () => {
  const dir = path.join(tmp(), 'out');
  const report = build([flow('f-fail', 'fail', { checks: [chk('failed', { step: 1, check: 0, evidence: ['flows/f-fail/a1/step1.stdout.txt'] })] })]);
  const paths = writeAll(dir, report, META);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')), report);
  assert.equal(fs.readFileSync(path.join(dir, 'run.log'), 'utf8'), `${formatLines(report).join('\n')}\n`);
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.deepEqual(index, [{ flowId: 'f-fail', step: 1, check: 0, files: ['flows/f-fail/a1/step1.stdout.txt'] }]);
  assert.equal(paths.sidecar, path.join(dir, 'run.log.json'));
});

test('writeAll sidecar holds the exact keys, the exit code from exitCodeFor and the run.log path', () => {
  const dir = path.join(tmp(), 'out');
  const report = build([flow('f-fail', 'fail')]);
  writeAll(dir, report, META);
  const side = JSON.parse(fs.readFileSync(path.join(dir, 'run.log.json'), 'utf8'));
  assert.deepEqual(Object.keys(side), SIDECAR_KEYS);
  assert.equal(side.exit, 1);
  assert.equal(side.head, HEAD);
  assert.equal(side.artifact, path.resolve(dir, 'run.log').replaceAll('\\', '/'));
  assert.equal(side.finished, META.finished);
});

test('writeAll lets meta.exit override the computed code (run.mjs owns codes 2, 3 and 4)', () => {
  const dir = path.join(tmp(), 'out');
  writeAll(dir, build([flow('f-a', 'pass')]), { ...META, exit: 4 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run.log.json'), 'utf8')).exit, 4);
});

test('writeAll writes the sidecar last, so a crash leaves exit null (break: write the sidecar first)', () => {
  const order = [];
  const fake = { mkdirSync: () => {}, writeFileSync: (f) => order.push(path.basename(f)) };
  writeAll('/x/out', build([flow('f-a', 'pass')]), META, fake);
  assert.equal(order.at(-1), 'run.log.json');
  assert.deepEqual([...order].sort(), ['index.json', 'report.json', 'run.log', 'run.log.json']);
});

// ---------- writeStepOutput ----------

test('writeStepOutput writes stdout and stderr under flows/<id>/a<n>/step<k> and returns relative paths', () => {
  const dir = tmp();
  const files = writeStepOutput(dir, { flowId: 'f-a', attempt: 2, step: 3, result: { stdout: 'o', stderr: 'e' } });
  assert.deepEqual(files, ['flows/f-a/a2/step3.stdout.txt', 'flows/f-a/a2/step3.stderr.txt']);
  assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), 'o');
  assert.equal(fs.readFileSync(path.join(dir, files[1]), 'utf8'), 'e');
});

test('writeStepOutput refuses a flow id or number that could leave the folder (break: skip the id check)', () => {
  const dir = tmp();
  const bad = (o) => () => writeStepOutput(dir, { flowId: 'f-a', attempt: 1, step: 1, result: {}, ...o });
  assert.throws(bad({ flowId: '../../x' }), /id/);
  assert.throws(bad({ attempt: 0 }), /attempt/);
  assert.throws(bad({ step: '1/../..' }), /step/);
});

// ---------- env source and defaults ----------

test('buildReport keeps flows[].env and the envDefaults field; both are absent for a run without them', () => {
  // Breaks when buildFlow drops env, when envDefaults is not a top-level key, or when a host flow gains an env key.
  const r = build([flow('aaa', 'pass', { env: { git: 'default', remote: 'default' } }), flow('bbb', 'pass', { env: { git: 'flow', remote: 'flow' } }), flow('hhh', 'pass')], { envDefaults: { git: 'commit', remote: 'https://example.test/r.git' } });
  assert.deepEqual(r.envDefaults, { git: 'commit', remote: 'https://example.test/r.git' });
  assert.deepEqual(r.flows.map((f) => f.env), [{ git: 'default', remote: 'default' }, { git: 'flow', remote: 'flow' }, undefined]);
  assert.equal('env' in r.flows[2], false);
  assert.equal(build([flow('aaa', 'pass')]).envDefaults, null);
});

test('buildReport refuses an env.git or env.remote that is not flow or default', () => {
  // Breaks when the env source is copied through without a check.
  assert.throws(() => build([flow('aaa', 'pass', { env: { git: 'maybe', remote: 'flow' } })]), /env git/);
  assert.throws(() => build([flow('aaa', 'pass', { env: { git: 'flow', remote: 'maybe' } })]), /env remote/);
});
