// Tests for run.mjs, flow-run.mjs and lock.mjs. They import the real functions. Git, docker and the lock folder are injected.
// Each test names the source change that makes it fail.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyRun } from '../checks/prove-check.mjs';
import { EnvError } from './env.mjs';
import { applyStart, foldAttempts, runFlows } from './flow-run.mjs';
import { acquireLock, lockPathFor, unlockRun } from './lock.mjs';
import { UsageError, main, parseArgs, resolveHead, withDefaults } from './run.mjs';

const REAL_FLOWS = path.resolve(import.meta.dirname, '..', '..', '.trex', 'flows');
const DEAD_PID = 999_999;
const OK = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const NO = () => ({ status: 1, stdout: '', stderr: 'nope' });
const sha = (prefix) => prefix.padEnd(40, '0');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'trex-run-test-'));

const DEMO_FLOW = (extra = '') => `
id: demo-flow
title: demo
description: d
goal: g
paths: [a/b.ts]
driver: hook
needs: [git]
start: {git: commit, remote: 'https://example.test/r.git', stamp: fixtures/stamp.json}
steps:
  - action: {hook: dist/h.mjs, payload: fixtures/p.json}
    checks: [{text: denies, stdout: 'deny'}]
limits: {timeoutMs: 60000, retries: 0}
${extra}`;

const DEMO_FILES = (flowText = DEMO_FLOW()) => ({
  '.trex/flows/demo.yaml': flowText,
  '.trex/flows/fixtures/stamp.json': '{"head":"{{HEAD}}","at":"{{NOW}}"}',
  '.trex/flows/fixtures/p.json': '{"tool_name":"Bash"}',
});

/** A git function over an in-memory tree. rev-parse accepts hex refs only. */
function fakeGit(primary, files = DEMO_FILES()) {
  return (args) => {
    if (args[0] === 'rev-parse') {
      const ref = args.at(-1).replace(/\^\{commit\}$/, '');
      return /^[0-9a-f]{4,40}$/.test(ref) ? OK(`${sha(ref)}\n`) : NO();
    }
    if (args[0] === 'worktree') return OK(`worktree ${primary}\nHEAD abc\n`);
    if (args[0] === 'merge-base') return OK(`${sha('b45e')}\n`);
    if (args[0] === 'ls-tree') return OK(Object.keys(files).filter((f) => f.startsWith(`${args.at(-1)}/`)).join('\0'));
    if (args[0] === 'show') {
      const file = args[1].split(':').slice(1).join(':');
      return file in files ? OK(files[file]) : NO();
    }
    return NO();
  };
}

const done = (stdout = '', code = 0) => ({ code, stdout, stderr: '', timedOut: false });

/** A fake container: start steps succeed, `git rev-parse HEAD` answers, `node <hook>` answers with reply(). */
function fakeExec(reply, log = []) {
  return async (argv, opts) => {
    log.push({ argv, opts });
    if (argv[0] === 'git' && argv.includes('rev-parse')) return done(`${'f'.repeat(40)}\n`);
    if (argv[0] === 'node') return reply();
    return done();
  };
}

/** Deps for main(). Returns the deps plus the things the tests read back. */
function harness({ reply = () => done('deny'), files, startEnvImpl, alive } = {}) {
  const root = tmp();
  const lines = [];
  const calls = { startEnv: 0, stopEnv: 0, removeByLabel: [], exit: [] };
  const handlers = [];
  const execLog = [];
  const deps = {
    root, git: fakeGit(root, files), out: (l) => lines.push(l), runId: 'rid', alive,
    now: () => new Date('2026-11-02T12:00:00Z'),
    ensureImage: async () => ({ tag: 'trex:test', built: false }),
    startEnv: startEnvImpl ?? (async () => { calls.startEnv += 1; return { project: 'trex-sim-aaaaaaaa', digest: {}, exec: fakeExec(reply, execLog) }; }),
    stopEnv: async () => { calls.stopEnv += 1; },
    removeByLabel: async (id) => { calls.removeByLabel.push(id); return {}; },
    prepareHost: async () => ({ skipped: { reason: 'host_unmerged' } }),
    onSigint: (fn) => { handlers.push(fn); return () => {}; },
    exit: (c) => calls.exit.push(c),
  };
  return { deps, lines, calls, root, handlers, execLog, lockFile: lockPathFor(root) };
}

const SIM = (evidence, ...more) => ['--simulate', 'aaaaaaaa', '--config', 'c0ffee', '--evidence', evidence, ...more];

// ---------- command line ----------

test('--pr and --base exit 2 with "P1: not built" and run nothing', async () => {
  // Breaks when --pr is routed to a run instead of the stub.
  const h = harness();
  assert.equal(await main(['--pr', '7'], h.deps), 2);
  assert.equal(await main(['--base', 'x', '--head', 'y'], h.deps), 2);
  assert.ok(h.lines.every((l) => l.includes('P1: not built')));
  assert.equal(h.calls.startEnv, 0);
});

test('parseArgs refuses an unknown flag, a missing value and two modes', () => {
  // Breaks when the unknown-flag branch is removed or the mode count is not checked.
  assert.throws(() => parseArgs(['--simulate', 'a', '--bogus']), UsageError);
  assert.throws(() => parseArgs(['--simulate']), UsageError);
  assert.throws(() => parseArgs(['--simulate', 'a', '--unlock']), UsageError);
  assert.throws(() => parseArgs([]), UsageError);
});

test('--tree takes only the sha8 of /proof/<sha8>/ (13.1)', () => {
  // Breaks when the regex changes, or when the tree path is used instead of the SHA.
  const git = fakeGit('/x');
  const tree = path.join('C:', 'repo', '.claude', 'cache', 'proof', 'abcd1234', 'trex-S1');
  assert.equal(resolveHead(git, parseArgs(['--simulate', 'tree', '--tree', tree])), sha('abcd1234'));
  assert.throws(() => resolveHead(git, parseArgs(['--simulate', 'tree', '--tree', '/no/proof/here'])), UsageError);
  assert.throws(() => resolveHead(git, parseArgs(['--simulate', 'beef0000', '--tree', tree])), UsageError);
});

test('a --flows id that does not exist exits 2', async () => {
  // Breaks when a missing id is dropped silently (then a typo runs nothing and reads as skipped).
  const h = harness();
  assert.equal(await main(SIM(path.join(h.root, 'ev'), '--flows', 'nope-flow'), h.deps), 2);
});

// ---------- folding ----------

test('foldAttempts: fail then pass is flaky, all fail is fail, start failure is incomplete', () => {
  // Breaks when the fold returns the last attempt, or maps start_unreached to fail.
  assert.deepEqual(foldAttempts([{ state: 'fail' }, { state: 'pass' }]), { state: 'flaky' });
  assert.deepEqual(foldAttempts([{ state: 'fail' }, { state: 'fail' }]), { state: 'fail' });
  assert.deepEqual(foldAttempts([{ state: 'pass' }]), { state: 'pass' });
  assert.deepEqual(foldAttempts([{ state: 'incomplete', reason: 'start_unreached' }]), { state: 'incomplete', reason: 'start_unreached' });
  assert.deepEqual(foldAttempts([{ state: 'fail' }, { state: 'incomplete', reason: 'timeout' }]), { state: 'fail', incomplete: true });
  assert.throws(() => foldAttempts([]), TypeError);
});

// ---------- lock ----------

test('a lock held by a live pid gives exit 3 and leaves the evidence folder alone', async () => {
  // Breaks when the pid test is removed (a live run would lose its lock) or the lock is taken after the evidence is written.
  const h = harness({ alive: () => true });
  mkdirSync(path.dirname(h.lockFile), { recursive: true });
  writeFileSync(h.lockFile, JSON.stringify({ pid: 4242, started: 'x', argv: [] }));
  const evidence = path.join(h.root, 'ev');
  assert.equal(await main(SIM(evidence, '--json'), h.deps), 3);
  assert.equal(existsSync(evidence), false);
  assert.equal(JSON.parse(h.lines.at(-1)).verdict, 'locked');
  assert.equal(JSON.parse(readFileSync(h.lockFile, 'utf8')).pid, 4242);
});

test('a lock left by a dead pid is replaced, and release removes only our own lock', () => {
  // Breaks when a stale lock is refused (spec 13.3), or when release deletes a lock that is no longer ours.
  const file = lockPathFor(tmp());
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: DEAD_PID }));
  const alive = (pid) => pid !== DEAD_PID;
  const mine = acquireLock(file, { pid: 1, token: 'mine' }, { alive });
  assert.equal(mine.ok, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'mine');
  writeFileSync(file, JSON.stringify({ pid: 2, token: 'other' }));
  mine.release();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'other');
});

test('a lock with an unreadable body is held while it is young', () => {
  // Breaks when an empty body counts as stale: a writer between create and write would lose its lock.
  const file = lockPathFor(tmp());
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
  assert.equal(acquireLock(file, { pid: 1 }, { alive: () => false }).ok, false);
});

test('--unlock removes a dead lock and its containers, and keeps a live lock', async () => {
  // Breaks when unlock ignores the pid, or skips the removal by label.
  const dead = harness({ alive: (p) => p !== DEAD_PID });
  mkdirSync(path.dirname(dead.lockFile), { recursive: true });
  writeFileSync(dead.lockFile, JSON.stringify({ pid: DEAD_PID, runId: 'old-run' }));
  assert.equal(await main(['--unlock'], dead.deps), 0);
  assert.equal(existsSync(dead.lockFile), false);
  assert.deepEqual(dead.calls.removeByLabel, ['old-run']);
  const live = harness({ alive: () => true });
  mkdirSync(path.dirname(live.lockFile), { recursive: true });
  writeFileSync(live.lockFile, JSON.stringify({ pid: 4242, runId: 'live-run' }));
  assert.equal(await main(['--unlock'], live.deps), 3);
  assert.equal(existsSync(live.lockFile), true);
  assert.equal(unlockRun(path.join(tmp(), 'none.lock')).state, 'none');
});

// ---------- environment retries and exit 5 ----------

test('an env that fails twice blocks every flow, exits 5, and prove-check reads it as broken', async () => {
  // Breaks when the retry is removed (startEnv count), when Blocked is not set, or when exit 5 becomes 0 (then classifyRun says no-fire).
  let tries = 0;
  const h = harness({ startEnvImpl: async () => { tries += 1; throw new EnvError('start', `compose failed ${tries}`); } });
  const code = await main(SIM(path.join(h.root, 'ev')), h.deps);
  assert.equal(code, 5);
  assert.equal(tries, 2);
  assert.deepEqual(h.lines, ['# blocked demo-flow start', '# trex: tested 0 findings 0 blockers 1']);
  const report = JSON.parse(readFileSync(path.join(h.root, 'ev', 'report.json'), 'utf8'));
  assert.equal(report.envAttempts, 2);
  assert.equal(report.blockers[0].stage, 'start');
  const verdict = classifyRun({ fireMatch: '^not ok ' }, { code, stdout: h.lines.join('\n'), stderr: '' });
  assert.equal(verdict.verdict, 'broken');
});

test('one env failure is retried and the run goes on', async () => {
  // Breaks when the first failure blocks the flows at once.
  let tries = 0;
  const h = harness();
  const inner = h.deps.startEnv;
  h.deps.startEnv = async (...a) => { tries += 1; if (tries === 1) throw new EnvError('seed', 'once'); return inner(...a); };
  assert.equal(await main(SIM(path.join(h.root, 'ev')), h.deps), 0);
  assert.equal(tries, 2);
  assert.equal(h.lines[0], 'ok demo-flow');
});

test('no flows at the flows SHA is skipped no_config and exits 5', async () => {
  // Breaks when an empty run reads as success (exit 0).
  const h = harness({ files: {} });
  assert.equal(await main(SIM(path.join(h.root, 'ev')), h.deps), 5);
  assert.deepEqual(h.lines, ['# skipped no_config', '# trex: tested 0 findings 0 blockers 0']);
  assert.equal(h.calls.startEnv, 0);
});

// ---------- grading, retries and stdout hygiene ----------

test('child output never reaches stdout: a SyntaxError in a log does not give broken', async () => {
  // Breaks when the runner echoes child stdout or stderr (prove-check reads SyntaxError as broken).
  const noise = () => ({ code: 0, stdout: 'deny\nSyntaxError: Unexpected token', stderr: 'Error: Cannot find module x', timedOut: false });
  const pass = harness({ reply: noise });
  const code = await main(SIM(path.join(pass.root, 'ev')), pass.deps);
  assert.equal(code, 0);
  assert.equal(pass.lines.join('\n').includes('SyntaxError'), false);
  assert.equal(classifyRun({ fireMatch: '^not ok ' }, { code, stdout: pass.lines.join('\n'), stderr: '' }).verdict, 'no-fire');
  const fail = harness({ reply: () => ({ code: 0, stdout: 'allowed SyntaxError', stderr: 'Cannot find module y', timedOut: false }) });
  const failCode = await main(SIM(path.join(fail.root, 'ev')), fail.deps);
  assert.equal(failCode, 1);
  assert.equal(classifyRun({ fireMatch: '^not ok ' }, { code: failCode, stdout: fail.lines.join('\n'), stderr: '' }).verdict, 'fire');
  const saved = readFileSync(path.join(fail.root, 'ev', 'flows', 'demo-flow', 'a1', 'step1.stdout.txt'), 'utf8');
  assert.match(saved, /SyntaxError/);
});

test('a flow that fails once and then passes is flaky and does not fail the run', async () => {
  // Breaks when the retry loop is removed (then the first failure is final) or flaky maps to fail.
  let n = 0;
  const h = harness({ files: DEMO_FILES(DEMO_FLOW().replace('retries: 0', 'retries: 1')), reply: () => done(++n === 1 ? 'allowed' : 'deny') });
  assert.equal(await main(SIM(path.join(h.root, 'ev')), h.deps), 0);
  assert.equal(h.lines[0], '# flaky demo-flow');
  assert.equal(n, 2);
});

test('a hung step is Incomplete timeout and is retried, never Fail', async () => {
  // Breaks when timedOut is read as a failed check (then the flow would be a Fail and fire the bench).
  const hung = () => ({ code: null, stdout: '', stderr: '', timedOut: true });
  const h = harness({ files: DEMO_FILES(DEMO_FLOW().replace('retries: 0', 'retries: 1')), reply: hung });
  const code = await main(SIM(path.join(h.root, 'ev')), h.deps);
  assert.equal(code, 5);
  assert.equal(h.lines[0], '# incomplete demo-flow timeout');
});

test('a start step that fails is Incomplete start_unreached, not Fail', async () => {
  // Breaks when a StartError is graded as a failed check.
  const h = harness();
  h.deps.startEnv = async () => ({ project: 'p', digest: {}, exec: async () => done('', 1) });
  const code = await main(SIM(path.join(h.root, 'ev')), h.deps);
  assert.equal(h.lines[0], '# incomplete demo-flow start_unreached');
  assert.equal(code, 5);
});

test('an exec that throws gives Incomplete driver_error and the env is still stopped', async () => {
  // Breaks when stopEnv moves out of the finally block, or when a thrown error reaches stdout.
  const h = harness();
  h.deps.startEnv = async () => ({ project: 'p', digest: {}, exec: async () => { throw new Error('docker exploded'); } });
  await main(SIM(path.join(h.root, 'ev')), h.deps);
  assert.equal(h.lines[0], '# incomplete demo-flow driver_error');
  assert.equal(h.calls.stopEnv, 1);
  assert.equal(h.lines.join('\n').includes('exploded'), false);
});

test('a host flow at an unmerged SHA is Incomplete host_unmerged and runs no spawn', async () => {
  // Breaks when the host flow is run without prepareHost saying the SHA is merged.
  const hostFlow = `
id: host-demo
title: t
description: d
goal: g
paths: [a/b.ts]
driver: mod-event
profile: host
steps:
  - action: {test: demo}
    checks: [{text: ok, exit: 0}]
`;
  const h = harness({ files: { '.trex/flows/host.yaml': hostFlow } });
  assert.equal(await main(SIM(path.join(h.root, 'ev')), h.deps), 5);
  assert.equal(h.lines[0], '# incomplete host-demo host_unmerged');
  assert.equal(h.calls.startEnv, 0);
});

// ---------- start block ----------

test('applyStart: git commit, then remote, then the stamp with the in-container HEAD and the run time', async () => {
  // Breaks when the stamp is written before the commit, {{HEAD}} is not replaced, or {{NOW}} is not replaced.
  const log = [];
  const flow = { start: { git: 'commit', remote: 'https://example.test/r.git', stamp: 'fixtures/stamp.json' } };
  const ctx = { readFixture: () => '{"head":"{{HEAD}}","at":"{{NOW}}"}', now: () => new Date('2026-11-02T12:00:00Z') };
  const out = await applyStart(flow, fakeExec(() => done(), log), ctx);
  const verbs = log.map((c) => c.argv.find((a) => ['init', 'add', 'commit', 'remote', 'rev-parse', '-c'].includes(a)) ? c.argv.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ') : c.argv[0]);
  assert.deepEqual(verbs.slice(0, 2), ['rm', 'git init']);
  const stamp = log.find((c) => c.argv[0] === 'sh');
  assert.equal(JSON.parse(stamp.opts.stdin).head, 'f'.repeat(40));
  assert.equal(JSON.parse(stamp.opts.stdin).at, '2026-11-02T12:00:00.000Z');
  assert.ok(log.indexOf(stamp) > log.findIndex((c) => c.argv.includes('commit')));
  assert.ok(log.some((c) => c.argv.join(' ').startsWith('git remote add origin https://example.test/r.git')));
  assert.equal(out.head, 'f'.repeat(40));
});

test('a stamp that needs {{HEAD}} without start.git is a start failure', async () => {
  // Breaks when the placeholder is replaced with an empty head (the gate would then deny for the wrong reason).
  const ctx = { readFixture: () => '{{HEAD}}', now: () => new Date() };
  await assert.rejects(applyStart({ start: { stamp: 'x.json' } }, fakeExec(() => done()), ctx), /needs \{\{HEAD\}\}/);
});

// ---------- the dev S18 flow ----------

function realFlowFiles() {
  const fixtures = ['pre-pr-stamp.json', 'pr-create-inline-body.json'];
  const files = { '.trex/flows/pre-pr-gate-inline-body.yaml': readFileSync(path.join(REAL_FLOWS, 'pre-pr-gate-inline-body.yaml'), 'utf8') };
  for (const f of fixtures) files[`.trex/flows/fixtures/${f}`] = readFileSync(path.join(REAL_FLOWS, 'fixtures', f), 'utf8');
  return files;
}

test('the S18 dev flow loads, fails when the gate allows an inline body and passes when it denies', async () => {
  // Breaks when the flow file is invalid, or its checks accept the old allow output or a deny for the wrong reason.
  const allow = harness({ files: realFlowFiles(), reply: () => done('{}') });
  assert.equal(await main(SIM(path.join(allow.root, 'ev'), '--flows', 'pre-pr-gate-inline-body'), allow.deps), 1);
  assert.equal(allow.lines[0], 'not ok pre-pr-gate-inline-body # P1');
  const body = 'BLOCKED (pre-pr-gate): the PR body is not a file, so it cannot be matched';
  const deny = harness({ files: realFlowFiles(), reply: () => done(JSON.stringify({ permissionDecisionReason: body })) });
  assert.equal(await main(SIM(path.join(deny.root, 'ev'), '--flows', 'pre-pr-gate-inline-body'), deny.deps), 0);
  assert.equal(deny.lines[0], 'ok pre-pr-gate-inline-body');
  const stampDeny = harness({ files: realFlowFiles(), reply: () => done(JSON.stringify({ permissionDecisionReason: 'BLOCKED (pre-pr-gate): the PR body is not a file; also no stamp' })) });
  assert.equal(await main(SIM(path.join(stampDeny.root, 'ev'), '--flows', 'pre-pr-gate-inline-body'), stampDeny.deps), 1);
});

// ---------- output and signals ----------

test('--json prints the 8-key line last', async () => {
  // Breaks when a key is renamed or dropped, or the line is not last.
  const h = harness();
  const code = await main(SIM(path.join(h.root, 'ev'), '--json'), h.deps);
  const last = JSON.parse(h.lines.at(-1));
  assert.deepEqual(Object.keys(last), ['pr', 'head', 'base', 'configSha', 'verdict', 'summary', 'skipped', 'reportPath']);
  assert.equal(last.verdict, 'pass');
  assert.equal(code, 0);
  assert.ok(existsSync(last.reportPath));
});

test('the sidecar has exit null at the start and the exit code at the end', async () => {
  // Breaks when the first sidecar is skipped (a crash would leave no record) or the last is not rewritten.
  const h = harness();
  const sidecar = path.join(h.root, 'ev', 'run.log.json');
  let atStart = null;
  const inner = h.deps.startEnv;
  h.deps.startEnv = async (...a) => { atStart = JSON.parse(readFileSync(sidecar, 'utf8')); return inner(...a); };
  await main(SIM(path.join(h.root, 'ev')), h.deps);
  assert.equal(atStart.exit, null);
  assert.deepEqual(Object.keys(atStart), ['project', 'command', 'exit', 'started', 'finished', 'artifact', 'head']);
  assert.equal(JSON.parse(readFileSync(sidecar, 'utf8')).exit, 0);
});

test('SIGINT stops the env, releases the lock and records exit 130', async () => {
  // Breaks when the run installs no SIGINT handler or the handler skips the lock or the sidecar.
  const h = harness();
  const evidence = path.join(h.root, 'ev');
  let sidecarAtSignal = null;
  const exec = fakeExec(() => done('deny'), h.execLog);
  h.deps.startEnv = async () => ({
    project: 'p', digest: {},
    exec: async (argv, o) => {
      if (argv[0] === 'node') {
        await h.handlers[0]();
        sidecarAtSignal = JSON.parse(readFileSync(path.join(evidence, 'run.log.json'), 'utf8'));
      }
      return exec(argv, o);
    },
  });
  await main(SIM(evidence), h.deps);
  assert.deepEqual(h.calls.exit, [130]);
  assert.equal(sidecarAtSignal.exit, 130);
  assert.ok(h.calls.stopEnv >= 1);
  assert.equal(existsSync(h.lockFile), false);
});

test('runFlows returns one entry per flow, in order', async () => {
  // Breaks when a flow is dropped or reordered.
  const evidenceDir = tmp();
  const flow = { id: 'demo-flow', severity: 'P1', driver: 'hook', profile: 'container', limits: { timeoutMs: 60000, retries: 0 }, steps: [{ action: { hook: 'dist/h.mjs', payload: 'p.json' }, checks: [{ text: 't', stdout: 'deny' }] }] };
  const env = { exec: fakeExec(() => done('deny')) };
  const out = await runFlows([flow, { ...flow, id: 'second-flow' }], env, { evidenceDir, now: () => new Date(), readFixture: () => '{}' });
  assert.deepEqual(out.map((f) => [f.id, f.state]), [['demo-flow', 'pass'], ['second-flow', 'pass']]);
});

test('an internal error exits 4, keeps its text out of stdout, writes run-error.txt and releases the lock', async () => {
  // Breaks when the catch is removed (the process would crash with exit 1), when the message is printed, or when the lock stays.
  const h = harness();
  h.deps.stopEnv = async () => { throw new Error('SyntaxError in teardown'); };
  const evidence = path.join(h.root, 'ev');
  assert.equal(await main(SIM(evidence, '--json'), h.deps), 4);
  assert.equal(h.lines.join('\n').includes('SyntaxError'), false);
  assert.match(readFileSync(path.join(evidence, 'run-error.txt'), 'utf8'), /SyntaxError in teardown/);
  assert.equal(JSON.parse(readFileSync(path.join(evidence, 'run.log.json'), 'utf8')).exit, 4);
  assert.equal(existsSync(h.lockFile), false);
  assert.equal(JSON.parse(h.lines.at(-1)).verdict, 'internal_error');
});

test('--flows-sha goes to startEnv only; --image-sha goes to ensureImage and startEnv (13.3)', async () => {
  // Breaks when resolveShas swaps the two SHAs, or ensureImage gets the flows SHA.
  const h = harness();
  const seen = {};
  const startInner = h.deps.startEnv;
  h.deps.ensureImage = async (o) => { seen.image = o; return { tag: 'trex:test', built: false }; };
  h.deps.startEnv = async (o, e) => { seen.start = o; return startInner(o, e); };
  const args = ['--simulate', 'aaaaaaaa', '--flows-sha', 'f10f10', '--image-sha', 'ac1d00', '--evidence', path.join(h.root, 'ev')];
  assert.equal(await main(args, h.deps), 0);
  assert.equal(seen.image.imageSha, sha('ac1d00'));
  assert.equal(seen.image.head, sha('aaaaaaaa'));
  assert.equal(seen.start.imageSha, sha('ac1d00'));
  assert.equal(seen.start.flowsSha, sha('f10f10'));
});

test('child pids reach the report and the pids.json sidecar at spawn time', async () => {
  // Breaks when envDeps.onSpawn is dropped or the recorder stops writing.
  const h = harness();
  const startInner = h.deps.startEnv;
  h.deps.startEnv = async (o, envDeps) => { envDeps.onSpawn(4242); return startInner(o, envDeps); };
  const evidence = path.join(h.root, 'ev');
  assert.equal(await main(SIM(evidence), h.deps), 0);
  assert.deepEqual(JSON.parse(readFileSync(path.join(evidence, 'report.json'), 'utf8')).pids, [4242]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(evidence, 'pids.json'), 'utf8')).pids.map((e) => e.pid ?? e), [4242]); // an entry is a bare pid or { pid, started }
});

// ---------- review fixes F1 ----------

test('--flows-dir allows only .trex/flows and scripts/trex/bench/flows/<S|N|K group>', () => {
  // Breaks when the allow-list is removed: a PR-chosen directory then supplies the flows that grade it.
  const dir = (v) => parseArgs(['--simulate', 'a', '--flows-dir', v]).flowsDir;
  assert.equal(dir('.trex/flows'), '.trex/flows');
  assert.equal(dir('.trex\\flows\\'), '.trex/flows');
  for (const ok of ['S1', 'S18', 'N2', 'N12', 'K3']) assert.equal(dir(`scripts/trex/bench/flows/${ok}`), `scripts/trex/bench/flows/${ok}`);
  for (const bad of ['x/y', 'scripts/trex/bench/flows/K10', 'scripts/trex/bench/flows/S100', 'scripts/trex/bench/flows/s1', '../.trex/flows', '.trex/flows/../x', 'scripts/trex/bench/flows', '.trex']) {
    assert.throws(() => dir(bad), UsageError, bad);
  }
});

test('main: a --flows-dir outside the allow-list exits 2 and starts nothing', async () => {
  // Breaks when the check runs after the environment starts.
  const h = harness();
  assert.equal(await main(SIM(path.join(h.root, 'ev'), '--flows-dir', 'x/y'), h.deps), 2);
  assert.equal(h.calls.startEnv, 0);
});

test('a host flow run passes imageSha to prepareHost, so it can be checked for merge', async () => {
  // Breaks when runHost drops imageSha: an unmerged image config would then pass the host check.
  const hostFlow = 'id: host-demo\ntitle: t\ndescription: d\ngoal: g\npaths: [a/b.ts]\ndriver: mod-event\nprofile: host\nsteps:\n  - action: {test: demo}\n    checks: [{text: ok, exit: 0}]\n';
  const h = harness({ files: { '.trex/flows/host.yaml': hostFlow } });
  let seen;
  h.deps.prepareHost = async (opts) => { seen = opts; return { skipped: { reason: 'host_unmerged' } }; };
  const rc = await main(['--simulate', 'aaaaaaaa', '--flows-sha', 'f1f1f1f1', '--image-sha', 'e2e2e2e2', '--evidence', path.join(h.root, 'ev')], h.deps);
  assert.ok(seen, `exit ${rc}: ${h.lines.join(' / ')}`);
  assert.equal(seen.imageSha, sha('e2e2e2e2'));
  assert.equal(seen.flowsSha, sha('f1f1f1f1'));
});

test('an env that saw an OOM kill (exit 137 before the budget) gives an oom blocker and exit 5', async () => {
  // Breaks when run.mjs ignores env.oomHits: a killed process would grade as a plain failed check.
  const h = harness();
  const evidence = path.join(h.root, 'ev');
  h.deps.startEnv = async () => ({ project: 'p', digest: {}, oomHits: 1, exec: fakeExec(() => done('deny'), []) });
  assert.equal(await main(SIM(evidence), h.deps), 5);
  const report = JSON.parse(readFileSync(path.join(evidence, 'report.json'), 'utf8'));
  assert.equal(report.blockers[0].stage, 'oom');
});

test('withDefaults: the default git does not pass ANTHROPIC_API_KEY to the git child', () => {
  // Breaks when run.mjs goes back to the pre-pr makeGit, which passes the whole env.
  process.env.ANTHROPIC_API_KEY = 'sk-test-secret-xyz';
  try {
    const r = withDefaults({}).git(['-c', 'alias.showkey=!echo key=$ANTHROPIC_API_KEY', 'showkey']);
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('sk-test-secret-xyz'));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
