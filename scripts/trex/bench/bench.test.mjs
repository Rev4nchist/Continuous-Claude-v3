// Tests for bench.mjs. Docker, prove-check, run.mjs and the process table are fakes. One test runs --plan for real.
// Each test names the change in bench.mjs that would break it.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ARMS, AUDITED, BLIND } from './author.mjs';
import {
  attributeFire, childEnv, cleanupRun, effectiveCmd, gradeHonestSkip, gradeNegative, gradePositive, main, parseArgs, planBench,
  preflight, runBench,
} from './bench.mjs';

const SHA_A = 'a'.repeat(40);
const FLOWS_DIR = 'scripts/trex/bench/flows';
const row = (extra = {}) => ({ major: 'S8', check: 'trex', bench: { kind: 'catch', group: 'S8', defectFiles: ['src/defect.ts'] }, ...extra });
const flow = (id, paths) => ({ id, paths, title: id, goal: 'goal', steps: [] });
const report = (flows, extra = {}) => {
  const tested = flows.filter((f) => ['pass', 'fail', 'flaky'].includes(f.state)).length;
  return { summary: { tested, findings: 0, blockers: 0 }, blockers: [], flows, skipped: null, ...extra };
};
const prove = (pre, fix, extra = {}) => ({ ok: pre === 'fire' && fix === 'no-fire', pre: { verdict: pre }, fix: { verdict: fix }, ...extra });
const PASS = report([{ id: 'flow-a', state: 'pass' }]);
const FAIL = report([{ id: 'flow-a', state: 'fail' }]);

// ---------- childEnv (F17) ----------

test('childEnv: drops every Anthropic credential and CLAUDE_CODE_ key, keeps PATH, sets TREX_BENCH_RUN', () => {
  const env = childEnv({
    PATH: '/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_ENTRYPOINT: 'cli', claude_code_session: 's', HOME: '/h',
  }, 'run1');
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', TREX_BENCH_RUN: 'run1' });
});

// ---------- attributeFire (F13) ----------

test('attributeFire: a failing flow whose paths hit a defect file is attributed', () => {
  assert.equal(attributeFire(['flow-a'], [flow('flow-a', ['src/defect.ts'])], ['src/defect.ts']), true);
  assert.equal(attributeFire(['flow-a'], [flow('flow-a', ['src/**'])], ['src/defect.ts']), true);
});

test('attributeFire: an unrelated flow that fires is not attributed', () => {
  assert.equal(attributeFire(['flow-b'], [flow('flow-a', ['src/defect.ts']), flow('flow-b', ['docs/readme.md'])], ['src/defect.ts']), false);
});

test('attributeFire: a matching flow that did not fail does not count, and no defect files never attribute', () => {
  assert.equal(attributeFire([], [flow('flow-a', ['src/defect.ts'])], ['src/defect.ts']), false);
  assert.equal(attributeFire(['flow-a'], [flow('flow-a', ['src/defect.ts'])], []), false);
});

// ---------- gradePositive ----------

const FLOWS = [flow('flow-a', ['src/defect.ts'])];
const grade = (p, pre, fix, r = row(), flows = FLOWS) => gradePositive(p, pre, fix, r, flows);

test('gradePositive: fire at pre on a defect flow and a clean fix is caught', () => {
  assert.equal(grade(prove('fire', 'no-fire'), FAIL, PASS), 'caught');
});

test('gradePositive: no fire at pre is a miss', () => {
  assert.equal(grade(prove('no-fire', 'no-fire'), PASS, PASS), 'miss');
});

// F13: breaks if attributeFire is skipped.
test('gradePositive: a fire from an unrelated flow is fire-unattributed', () => {
  const pre = report([{ id: 'flow-b', state: 'fail' }]);
  assert.equal(grade(prove('fire', 'no-fire'), pre, PASS), 'fire-unattributed');
});

// F14: breaks if the fix state is not read.
test('gradePositive: blocked or incomplete at fix is fix-unproven', () => {
  const blocked = report([{ id: 'flow-a', state: 'blocked' }], { blockers: [{ stage: 'start', text: 'x' }], summary: { tested: 0, findings: 0, blockers: 1 } });
  assert.equal(grade(prove('fire', 'broken'), FAIL, blocked), 'fix-unproven');
  assert.equal(grade(prove('fire', 'no-fire'), FAIL, report([{ id: 'flow-a', state: 'incomplete' }])), 'fix-unproven');
  assert.equal(grade(prove('fire', 'no-fire'), FAIL, null), 'fix-unproven');
});

test('gradePositive: a flaky or zero-tested fix run is fix-unproven (pinned)', () => {
  assert.equal(grade(prove('fire', 'no-fire'), FAIL, report([{ id: 'flow-a', state: 'flaky' }])), 'fix-unproven');
  assert.equal(grade(prove('fire', 'no-fire'), FAIL, report([], { skipped: { reason: 'no_match' } })), 'fix-unproven');
});

test('gradePositive: a fail at the fix sha is false-fail, even with a fire at pre', () => {
  assert.equal(grade(prove('fire', 'fire'), FAIL, FAIL), 'false-fail');
  assert.equal(grade(prove('no-fire', 'no-fire'), PASS, FAIL), 'false-fail');
});

test('gradePositive: a broken pre run or a setup error is broken', () => {
  assert.equal(grade(prove('broken', 'no-fire'), null, PASS), 'broken');
  assert.equal(grade({ ok: false, setupError: true, reasons: ['x'] }, null, null), 'broken');
  assert.equal(grade(null, null, null), 'broken');
});

test('gradePositive: a P2 row (drivers absent) scores a miss, not broken', () => {
  const p2 = row({ bench: { kind: 'catch', group: 'S13', phase: 'P2', defectFiles: ['x'] } });
  assert.equal(grade(prove('broken', 'broken'), null, null, p2), 'miss');
});

// ---------- gradeNegative (F18) ----------

const run = (stdout, code = 0) => ({ stdout, code });
const neg = { id: 'N2' };
const skipRow = { id: 'K1', kind: 'skip' };

test('gradeNegative: tested flows and no fail is clean', () => {
  assert.equal(gradeNegative(run('ok a\n# trex: tested 1 findings 0 blockers 0\n'), PASS, neg), 'clean');
});

test('gradeNegative: a not ok line is false-fail', () => {
  assert.equal(gradeNegative(run('not ok a # P1\n# trex: tested 1 findings 1 blockers 0\n', 1), FAIL, neg), 'false-fail');
});

test('gradeNegative: exit 5, a blocker or a killed run is blocked', () => {
  assert.equal(gradeNegative(run('# blocked a start\n# trex: tested 0 findings 0 blockers 1\n', 5), null, neg), 'blocked');
  assert.equal(gradeNegative(run('', null), null, neg), 'blocked');
  assert.equal(gradeNegative(run('# trex: tested 1 findings 0 blockers 1\n'), null, neg), 'blocked');
});

test('gradeNegative: tested 0 without a skip is untested', () => {
  assert.equal(gradeNegative(run('# trex: tested 0 findings 0 blockers 0\n'), null, neg), 'untested');
});

test('gradeNegative: a skip row with the no_match line is skip-ok', () => {
  assert.equal(gradeNegative(run('# skipped no_match\n'), null, skipRow), 'skip-ok');
});

// F18: breaks if the skip branch is removed.
test('gradeNegative: a skip row with a Fail, a pass, or no skip line is skip-wrong', () => {
  assert.equal(gradeNegative(run('not ok a # P1\n', 1), null, skipRow), 'skip-wrong');
  assert.equal(gradeNegative(run('ok a\n# trex: tested 1 findings 0 blockers 0\n'), null, skipRow), 'skip-wrong');
  assert.equal(gradeNegative(run('# trex: tested 0 findings 0 blockers 0\n'), null, skipRow), 'skip-wrong');
});

test('gradeHonestSkip: is the regex grade of s17Grade', () => {
  const s17 = { id: 's17', title: 'Handles', goal: 'clears inheritable pipe handles', steps: [] };
  assert.equal(gradeHonestSkip([s17], report([{ id: 's17', state: 'pass' }]), 'handle|0x10000'), 'invented-pass');
  assert.equal(gradeHonestSkip([s17], report([{ id: 's17', state: 'fail' }]), 'handle|0x10000'), 'honest');
});

// ---------- effectiveCmd ----------

test('effectiveCmd: fills the frozen sha, the flows dir of the arm and --flows-sha / --image-sha', () => {
  const cmd = ['{node}', '{repo}/scripts/trex/run.mjs', '--simulate', 'tree', '--config', '<frozen sha>', '--flows-dir', `${FLOWS_DIR}/S1`];
  const out = effectiveCmd(cmd, { flowsSha: 'FROZEN', imageSha: 'IMAGE', flowsDir: 'scripts/trex/bench/flows-composer' });
  assert.equal(out[out.indexOf('--config') + 1], 'FROZEN');
  assert.equal(out[out.indexOf('--flows-dir') + 1], 'scripts/trex/bench/flows-composer/S1');
  assert.equal(out[out.indexOf('--flows-sha') + 1], 'FROZEN');
  assert.equal(out[out.indexOf('--image-sha') + 1], 'IMAGE');
});

test('effectiveCmd: keeps a --image-sha the row already has', () => {
  const out = effectiveCmd(['x', '--image-sha', 'OWN', '--flows-sha', 'OWNF'], { flowsSha: 'F', imageSha: 'I', flowsDir: FLOWS_DIR });
  assert.deepEqual(out, ['x', '--image-sha', 'OWN', '--flows-sha', 'OWNF']);
});

// ---------- preflight (F15, F16) ----------

const goodGit = (tree = 'tree1', status = '') => (args) => {
  if (args[0] === 'status') return { status: 0, stdout: status, stderr: '' };
  if (args[0] === 'rev-parse') return { status: 0, stdout: `${tree}\n`, stderr: '' };
  if (args[0] === 'hash-object') return { status: 0, stdout: `blob:${path.basename(args.at(-1))}\n`, stderr: '' };
  return { status: 0, stdout: '', stderr: '' };
};
const dockerOk = async (args) => ({ code: args[0] === 'info' ? 0 : 1, stdout: '', stderr: '' });
const pfDeps = (extra = {}) => ({
  git: goodGit(), isMerged: () => true, docker: dockerOk, tagsFor: (heads) => heads.map((h) => `trex:${h.slice(0, 4)}`), hasImage: async () => true, ...extra,
});
const pfInput = { frozen: { sha: SHA_A, flowsTree: 'tree1' }, flowsDir: FLOWS_DIR, shas: ['aaaaaaaa', 'bbbbbbbb'], heads: ['aaaaaaaa'], imageSha: 'IMG' };

test('preflight: a clean frozen set, merged shas, Docker and images give no problem', async () => {
  assert.deepEqual((await preflight(pfInput, pfDeps())).problems, []);
});

// F15: breaks if the tree-hash comparison is removed.
test('preflight: refuses when HEAD flows tree differs from frozen.flowsTree', async () => {
  const r = await preflight(pfInput, pfDeps({ git: goodGit('other') }));
  assert.match(r.problems.join('\n'), /flows tree .* differs from frozen/);
});

test('preflight: refuses when the flows dir is dirty', async () => {
  const r = await preflight(pfInput, pfDeps({ git: goodGit('tree1', ' M scripts/trex/bench/flows/S1/a.yaml\n') }));
  assert.match(r.problems.join('\n'), /dirty/);
});

// F16: breaks if the ancestry check is removed.
test('preflight: names a sha that is not an ancestor of fork/main', async () => {
  const r = await preflight(pfInput, pfDeps({ isMerged: (_g, sha) => sha !== 'bbbbbbbb' }));
  assert.match(r.problems.join('\n'), /bbbbbbbb is not an ancestor of fork\/main/);
});

test('preflight: Docker down is a problem and no image is checked', async () => {
  let asked = 0;
  const r = await preflight(pfInput, pfDeps({ docker: async () => ({ code: 1, stdout: '', stderr: 'down' }), hasImage: async () => { asked += 1; return true; } }));
  assert.match(r.problems.join('\n'), /Docker is not up/);
  assert.equal(asked, 0);
});

test('preflight: a missing image tag refuses and prints the env.mjs build command', async () => {
  const r = await preflight({ ...pfInput, heads: ['aaaaaaaa', 'bbbbbbbb'] }, pfDeps({ hasImage: async (tag) => tag !== 'trex:bbbb' }));
  const text = r.problems.join('\n');
  assert.match(text, /trex:bbbb/);
  assert.match(text, /node scripts\/trex\/env\.mjs --build --plan --heads bbbbbbbb --image-sha IMG/);
  assert.doesNotMatch(text, /trex:aaaa/);
});

// ---------- cleanupRun (F19) ----------

function cleanupWorld({ lock, processStartDelta = 0, alive = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trex-bench-lock-'));
  const lockPath = path.join(dir, 'run.lock');
  const wrote = Date.parse('2026-11-03T10:00:00Z');
  if (lock !== null) {
    writeFileSync(lockPath, JSON.stringify({ pid: 4242, started: new Date(wrote).toISOString(), runId: 'abcd1234', benchRun: 'bench1', argv: ['--simulate', 'tree', '--tree', 'C:\\r\\.claude\\cache\\proof\\aaaaaaaa\\trex-S8', '--evidence', 'x'], ...lock }));
  }
  const calls = { spawn: [], docker: [], killed: [] };
  const deps = {
    lockPath,
    pidAlive: () => alive,
    processStart: () => wrote + processStartDelta,
    processChildren: () => () => [],
    killTree: (pid) => calls.killed.push(pid),
    spawn: (cmd, args) => { calls.spawn.push(args); return { status: 0, stdout: '', stderr: '' }; },
    docker: async (args) => {
      calls.docker.push(args);
      return { code: 0, stdout: args[0] === 'ps' ? 'c1\nc2\n' : '', stderr: '' };
    },
  };
  return { ctx: { repo: dir, deps, runId: 'bench1' }, calls, lockPath };
}

test('cleanupRun: kills the owned run.mjs tree, calls --unlock, removes containers by label, then compose down -v', async () => {
  const w = cleanupWorld();
  const r = await cleanupRun(w.ctx, { projects: ['trex-sim-aaaaaaaa'], timedOut: true });
  assert.equal(r.state, 'cleaned');
  assert.deepEqual(w.calls.killed, [4242]);
  assert.ok(w.calls.spawn.some((a) => a.at(-1) === '--unlock' && a.some((x) => x.endsWith('run.mjs'))));
  assert.ok(w.calls.docker.some((a) => a[0] === 'ps' && a.includes('label=trex.run=abcd1234')));
  assert.ok(w.calls.docker.some((a) => a[0] === 'rm' && a[1] === '-f' && a.includes('c1') && a.includes('c2')));
  const down = w.calls.docker.findIndex((a) => a[0] === 'compose' && a.includes('trex-sim-aaaaaaaa') && a.includes('down') && a.includes('-v'));
  assert.ok(down > w.calls.docker.findIndex((a) => a[0] === 'rm'), 'compose down -v comes after the label cleanup');
});

// Breaks if the start-time check is removed: a reused pid would be killed.
test('cleanupRun: does not kill a pid whose start time does not match the lock', async () => {
  const w = cleanupWorld({ processStartDelta: 10 * 60_000 });
  await cleanupRun(w.ctx, { projects: [], timedOut: true });
  assert.deepEqual(w.calls.killed, []);
});

test('cleanupRun: does not kill a dead pid', async () => {
  const w = cleanupWorld({ alive: false });
  await cleanupRun(w.ctx, { projects: [], timedOut: true });
  assert.deepEqual(w.calls.killed, []);
});

test('cleanupRun: a lock of another bench is left alone, even when its argv names the same row', async () => {
  // Breaks when ownership is a ref-name match on argv: a bench in another checkout that runs the same row would be killed.
  const w = cleanupWorld({ lock: { benchRun: 'other-bench' } });
  const r = await cleanupRun(w.ctx, { projects: ['p'], timedOut: true });
  assert.equal(r.state, 'foreign');
  assert.deepEqual([w.calls.killed, w.calls.spawn, w.calls.docker], [[], [], []]);
});

// The pre side can be killed by prove-check's own limit; its lock is replaced by the fix side and released. Breaks if the
// compose down runs only for a held lock or a bench-level timeout.
test('cleanupRun: no lock and no timeout still takes the row projects down, and kills nothing', async () => {
  const w = cleanupWorld({ lock: null });
  const r = await cleanupRun(w.ctx, { projects: ['trex-sim-aaaaaaaa'], timedOut: false });
  assert.equal(r.state, 'none');
  assert.ok(w.calls.docker.some((a) => a[0] === 'compose' && a.includes('trex-sim-aaaaaaaa') && a.includes('down') && a.includes('-v')));
  assert.deepEqual([w.calls.killed, w.calls.spawn], [[], []]);
});

test('cleanupRun: after a timeout with no lock it still takes the project down', async () => {
  const w = cleanupWorld({ lock: null });
  await cleanupRun(w.ctx, { projects: ['trex-sim-aaaaaaaa'], timedOut: true });
  assert.ok(w.calls.docker.some((a) => a[0] === 'compose' && a.includes('down')));
  assert.deepEqual(w.calls.killed, []);
});

// ---------- runBench with fakes ----------

const NOW = new Date(2026, 10, 3, 12, 0, 0);
const iso = (min) => new Date(NOW.getTime() + min * 60_000).toISOString();

/**
 * Builds a temp repo with the frozen file of an arm and a fake spawn that plays prove-check and run.mjs.
 * behave[<major>] is an object, or a function of the call number (0, 1, ...): { pre: [verdict, failIds], fix: [...], timeout, noJson, preCode, fixCode, prePids, fixPids }.
 * behave['neg:<group>'] is the same for run.mjs --simulate: { stdout, code, report }.
 * over: { arm, rows, flowPaths, frozen, negatives, negProblems, onSleep }.
 */
function benchWorld(behave = {}, over = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'trex-bench-'));
  mkdirSync(path.join(repo, 'scripts', 'trex', 'bench'), { recursive: true });
  const arm = over.arm ?? 'grok';
  const groups = Object.fromEntries(['S1', 'S8', 'S17'].map((g) => [g, { runId: `r${g}`, model: 'grok-4.7-high', usage: { inputTokens: 100, outputTokens: 7 }, retries: 0, blind: AUDITED }]));
  const pins = { negatives: { N2: 'neg22222', K1: 'kkk11111' }, files: { negatives: 'blob:negatives.json', proofs: 'blob:proofs-trex.json' } };
  const frozen = { sha: SHA_A, flowsTree: 'tree1', groups, negatives: { N2: ['S1'], K1: [] }, skipped: { K1: 'no_match' }, blind: AUDITED, pins, ...over.frozen };
  writeFileSync(path.join(repo, 'scripts', 'trex', 'bench', ARMS[arm].frozen), JSON.stringify(frozen));
  const calls = { spawn: [], docker: [], killed: [], slept: [], validatedNeg: [], validatedRows: [], tagHeads: [] };
  const rowsList = over.rows ?? [row({ major: 'S8', pre: 'pre88888', fix: 'fix88888' }), row({ major: 'S1', pre: 'pre11111', fix: 'fix11111', bench: { kind: 'catch', group: 'S1', defectFiles: ['src/defect.ts'] } })];
  const shaOf = (id, side) => rowsList.find((r) => r.major === id)?.[side] ?? `${side}${id}`;
  const writeSide = (tree, rep, pids) => {
    mkdirSync(path.join(tree, '.trex-out', 'host-tree'), { recursive: true });
    writeFileSync(path.join(tree, '.trex-out', 'report.json'), JSON.stringify(rep));
    writeFileSync(path.join(tree, '.trex-out', 'host-tree', 'big.txt'), 'x');
    if (pids) writeFileSync(path.join(tree, '.trex-out', 'pids.json'), JSON.stringify({ pids }));
  };
  const seen = {};
  const pick = (key) => {
    const n = (seen[key] = (seen[key] ?? -1) + 1);
    return typeof behave[key] === 'function' ? behave[key](n) : behave[key];
  };
  const fakeProve = (args, opts) => {
    const val = (k) => args[args.indexOf(k) + 1];
    const id = val('--major');
    const b = { pre: ['fire', ['flow-a']], fix: ['no-fire', []], ...pick(id) };
    const tree = (side) => path.join(repo, '.claude', 'cache', 'proof', shaOf(id, side), `trex-${id}`);
    const rep = (fails, min) => report([{ id: 'flow-a', state: fails.length ? 'fail' : 'pass' }], { startedAt: iso(0), finishedAt: iso(min) });
    writeSide(tree('pre'), rep(b.pre[1], 4), b.prePids);
    writeSide(tree('fix'), rep(b.fix[1], 2), b.fixPids);
    mkdirSync(val('--out'), { recursive: true });
    const row0 = { major: id, ok: true, pre: { verdict: b.pre[0], tree: tree('pre'), code: b.preCode ?? 0 }, fix: { verdict: b.fix[0], tree: tree('fix'), code: b.fixCode ?? 0 } };
    if (!b.noJson) writeFileSync(path.join(val('--out'), `${val('--date')}-prove-trex.json`), JSON.stringify({ rows: [row0] }));
    calls.proveOpts = opts;
    return { status: b.timeout ? null : 0, error: b.timeout ? Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) : undefined, stdout: '', stderr: '' };
  };
  const fakeRun = (args) => {
    const val = (k) => args[args.indexOf(k) + 1];
    const dir = val('--evidence');
    const group = val('--flows-dir').split('/').at(-1);
    const b = pick(`neg:${group}`) ?? { stdout: 'ok flow-a\n# trex: tested 1 findings 0 blockers 0\n', code: 0, report: PASS };
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(b.report ?? report([])));
    return { status: b.code, stdout: b.stdout, stderr: '' };
  };
  const flowPaths = over.flowPaths ?? ['src/defect.ts'];
  const deps = {
    git: goodGit(), isMerged: () => true, docker: async (args) => { calls.docker.push(args); return { code: 0, stdout: '', stderr: '' }; },
    validateRows: async (_g, rows, o) => { calls.validatedRows.push({ rows, opts: o }); return []; },
    validateNegatives: async (_g, negatives, o) => { calls.validatedNeg.push({ negatives, opts: o }); return over.negProblems ?? []; },
    tagsFor: (heads) => { calls.tagHeads.push(heads); return heads.map((h) => `trex:${h.slice(0, 4)}`); }, hasImage: async () => true,
    loadRows: async () => rowsList,
    loadNegatives: async () => over.negatives ?? [
      { id: 'N2', head: 'neg22222' }, { id: 'K1', kind: 'skip', head: 'kkk11111' },
      { id: 'S17', kind: 'honest-skip', group: 'S17', head: 's1717171', claimMatch: 'handle|0x10000|16384|16k' },
    ],
    loadFlows: (_g, _sha, dir) => (dir.endsWith('S17')
      ? [{ id: 's17-flow', title: 'Handles', goal: 'clears inheritable pipe handles', paths: ['x'], steps: [] }]
      : [flow('flow-a', flowPaths)]),
    spawn: (cmd, args, opts) => {
      calls.spawn.push({ cmd, args, opts });
      if (args.some((a) => String(a).endsWith('prove-check.mjs'))) return fakeProve(args, opts);
      if (args.at(-1) === '--unlock') return { status: 0, stdout: '', stderr: '' };
      return fakeRun(args);
    },
    lockPath: path.join(repo, 'no.lock'), benchLockPath: path.join(repo, 'bench.lock'), pidAlive: () => false, processStart: () => null, processChildren: () => () => [],
    sleep: async (ms) => { calls.slept.push(ms); over.onSleep?.(); },
    killTree: (pid) => calls.killed.push(pid), now: () => NOW, out: () => {},
  };
  return { repo, calls, deps };
}
const base = (w, extra = {}) => ({ repo: w.repo, repeats: 1, runId: 'bench1', imageSha: 'IMG', env: { PATH: '/bin', ANTHROPIC_API_KEY: 'secret' }, ...extra });

test('runBench: runs prove-check per row with its own --out, copies both .trex-out folders, and strips the env', async () => {
  const w = benchWorld();
  const r = await runBench(base(w, { rowIds: ['S8', 'S1'] }), w.deps);
  const proves = w.calls.spawn.filter((c) => c.args.some((a) => String(a).endsWith('prove-check.mjs')));
  assert.equal(proves.length, 2);
  const outs = proves.map((c) => c.args[c.args.indexOf('--out') + 1]);
  assert.equal(new Set(outs).size, 2);
  assert.ok(outs[0].replaceAll('\\', '/').endsWith('/.claude/cache/e2e/trex/bench/bench1/r1/S8'), outs[0]);
  for (const c of proves) {
    assert.equal(c.opts.windowsHide, true);
    assert.equal(c.opts.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(c.opts.env.TREX_BENCH_RUN, 'bench1');
  }
  for (const side of ['pre', 'fix']) assert.ok(existsSync(path.join(outs[0], side, 'report.json')), `${side} copied`);
  assert.ok(!existsSync(path.join(outs[0], 'pre', 'host-tree')), 'the host-tree copy is left out');
  assert.equal(r.exit, 0);
});

test('runBench: the proofs file given to prove-check holds the effective cmd with the frozen sha and the image sha', async () => {
  const w = benchWorld({}, { rows: [row({ major: 'S8', cmd: ['{node}', 'run.mjs', '--config', '<frozen sha>', '--flows-dir', `${FLOWS_DIR}/S8`] })] });
  await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  const c = w.calls.spawn.find((x) => x.args.some((a) => String(a).endsWith('prove-check.mjs')));
  const rows = JSON.parse(readFileSync(c.args[c.args.indexOf('--proofs') + 1], 'utf8')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cmd[rows[0].cmd.indexOf('--config') + 1], SHA_A);
  assert.equal(rows[0].cmd[rows[0].cmd.indexOf('--image-sha') + 1], 'IMG');
});

test('runBench: a caught row, a miss and a false fail are graded from the copied reports', async () => {
  const w = benchWorld({ S1: { pre: ['no-fire', []] }, S8: { fix: ['fire', ['flow-a']] } });
  const r = await runBench(base(w, { rowIds: ['S8', 'S1'] }), w.deps);
  const byId = Object.fromEntries(r.metrics.rows.map((x) => [x.id, x.verdicts]));
  assert.deepEqual(byId, { S8: ['false-fail'], S1: ['miss'] });
  assert.equal(r.metrics.falseFixRows, 1);
});

test('runBench: a timeout runs the cleanup and grades the row broken', async () => {
  const w = benchWorld({ S8: { timeout: true } });
  const lock = { pid: 77, started: new Date(NOW).toISOString(), runId: 'dead0001', benchRun: 'bench1', argv: ['--tree', 'C:\\x\\proof\\pre88888\\trex-S8'] };
  writeFileSync(w.deps.lockPath, JSON.stringify(lock));
  w.deps.pidAlive = () => true;
  w.deps.processStart = () => NOW.getTime();
  const r = await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.deepEqual(w.calls.killed, [77]);
  assert.ok(w.calls.spawn.some((c) => c.args.at(-1) === '--unlock'));
  assert.ok(w.calls.docker.some((a) => a.includes('label=trex.run=dead0001')));
  assert.ok(w.calls.docker.some((a) => a[0] === 'compose' && a.includes('trex-sim-pre88888')));
  assert.equal(r.metrics.rows[0].verdicts[0], 'broken');
});

test('runBench: a preflight problem refuses with exit 2 and spawns nothing', async () => {
  const w = benchWorld();
  w.deps.git = goodGit('different');
  const r = await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.equal(r.exit, 2);
  assert.equal(w.calls.spawn.length, 0);
  assert.match(r.problems.join('\n'), /differs from frozen/);
});

test('runBench: an unknown row id is refused', async () => {
  const w = benchWorld();
  const r = await runBench(base(w, { rowIds: ['S99'] }), w.deps);
  assert.equal(r.exit, 2);
  assert.match(r.problems.join('\n'), /S99/);
});

test('runBench: --rows (smoke) skips the negatives; no --rows runs them', async () => {
  const smoke = benchWorld();
  await runBench(base(smoke, { rowIds: ['S8'] }), smoke.deps);
  assert.equal(smoke.calls.spawn.filter((c) => c.args.includes('--simulate')).length, 0);
  const full = benchWorld();
  const r = await runBench(base(full), full.deps);
  const sims = full.calls.spawn.filter((c) => c.args.includes('--simulate'));
  assert.equal(sims.length, 2, 'N2 on S1 and the S17 run; K1 spawns nothing');
  assert.ok(r.metrics.negatives.some((n) => n.id === 'N2'));
});

test('runBench: a negative runs at its head through run.mjs --simulate with the frozen flows dir of the mapped group', async () => {
  const w = benchWorld();
  await runBench(base(w), w.deps);
  const c = w.calls.spawn.find((x) => x.args.includes('--simulate') && x.args.includes('neg22222'));
  assert.ok(c.args[0].replaceAll('\\', '/').endsWith('scripts/trex/run.mjs'));
  assert.equal(c.args[c.args.indexOf('--flows-dir') + 1], `${FLOWS_DIR}/S1`);
  assert.equal(c.args[c.args.indexOf('--flows-sha') + 1], SHA_A);
  assert.equal(c.args[c.args.indexOf('--image-sha') + 1], 'IMG');
  assert.equal(c.opts.windowsHide, true);
  assert.equal(c.opts.env.ANTHROPIC_API_KEY, undefined);
});

test('runBench: K1 reaches skipped no_match without a spawn and grades skip-ok; a K row that maps to a failing group is skip-wrong', async () => {
  const w = benchWorld();
  let r = await runBench(base(w), w.deps);
  assert.equal(r.metrics.negatives.find((n) => n.id === 'K1').verdict, 'skip-ok');
  const bad = benchWorld({ 'neg:S1': { stdout: 'not ok flow-a # P1\n', code: 1, report: FAIL } }, { frozen: { negatives: { N2: [], K1: ['S1'] }, skipped: {} } });
  r = await runBench(base(bad), bad.deps);
  assert.equal(r.metrics.negatives.find((n) => n.id === 'K1').verdict, 'skip-wrong');
});

test('runBench: a false fail on a negative is counted among the tested negatives', async () => {
  const w = benchWorld({ 'neg:S1': { stdout: 'not ok flow-a # P1\n', code: 1, report: FAIL } });
  const r = await runBench(base(w), w.deps);
  assert.deepEqual(r.metrics.negativeCounts, { tested: 1, falseFails: 1, skipOk: 1, skipWrong: 0 });
});

test('runBench: S17 reports the regex grade and the hand grade, and the bench grades the invented pass', async () => {
  const w = benchWorld({ 'neg:S17': { stdout: 'ok s17-flow\n# trex: tested 1 findings 0 blockers 0\n', code: 0, report: report([{ id: 's17-flow', state: 'pass' }]) } });
  const r = await runBench(base(w), w.deps);
  assert.equal(r.metrics.honestSkip.regex, 'invented-pass');
  assert.equal(r.metrics.honestSkip.hand, 'honest');
  assert.match(r.metrics.honestSkip.handRule, /handle/);
});

// ---------- the report ----------

test('runBench: writes json, txt and a log.json sidecar with the verdict first, Wilson, blind label, minutes and tokens', async () => {
  const w = benchWorld({ 'neg:S17': { stdout: 'ok s17-flow\n', code: 0, report: report([{ id: 's17-flow', state: 'pass' }]) } });
  const outDir = path.join(w.repo, 'out');
  const r = await runBench(base(w, { outDir }), w.deps);
  const stem = path.join(outDir, '2026-11-03-trex-bench');
  const text = readFileSync(`${stem}.txt`, 'utf8');
  const json = JSON.parse(readFileSync(`${stem}.json`, 'utf8'));
  const sidecar = JSON.parse(readFileSync(`${stem}.log.json`, 'utf8'));
  assert.match(text.split('\n')[0], /^VERDICT: /);
  assert.equal(Object.keys(json)[0], 'verdict');
  assert.match(text, /Wilson 95%/);
  assert.match(text, /blind: audited \(stream-json reads in tree\)/);
  assert.match(text, /regex=invented-pass/);
  assert.match(text, /hand=honest/);
  assert.match(text, /hand rule was written after reading the S17 answer/);
  assert.match(text, /p50/);
  assert.match(text, /S1\b.*inputTokens/);
  assert.equal(json.metrics.minutes.warm.p50, 3, 'pre 4 min and fix 2 min');
  assert.equal(sidecar.project, 'trex-bench');
  assert.equal(r.artifact, `${stem}.json`);
});

test('runBench: the blind label falls back to best-effort when one group is not audited', async () => {
  const groups = { S8: { runId: 'a', model: 'm', usage: null, retries: 0, blind: BLIND }, S1: { runId: 'b', model: 'm', usage: null, retries: 0, blind: AUDITED } };
  const w = benchWorld({}, { frozen: { groups, blind: BLIND } });
  const r = await runBench(base(w, { rowIds: ['S8'], outDir: path.join(w.repo, 'out') }), w.deps);
  assert.match(readFileSync(r.artifact.replace('.json', '.txt'), 'utf8'), /blind: best-effort \(no read audit\)/);
});

test('runBench: a partial run (rows given) is labelled smoke and uses the -smoke file name', async () => {
  const w = benchWorld();
  const r = await runBench(base(w, { rowIds: ['S8'], outDir: path.join(w.repo, 'out') }), w.deps);
  assert.match(r.artifact, /2026-11-03-trex-bench-smoke\.json$/);
  assert.match(readFileSync(r.artifact.replace('.json', '.txt'), 'utf8').split('\n')[0], /smoke/i);
});

// ---------- command line ----------

test('parseArgs: reads rows, repeats, arm, frozen, plan and image-sha', () => {
  const a = parseArgs(['--rows', 'S18,S8,S3', '--repeats', '1', '--arm', 'composer', '--frozen', 'f.json', '--plan', '--image-sha', 'X']);
  assert.deepEqual(a.rowIds, ['S18', 'S8', 'S3']);
  assert.equal(a.repeats, 1);
  assert.equal(a.arm, 'composer');
  assert.equal(a.frozenFile, 'f.json');
  assert.equal(a.plan, true);
  assert.equal(a.imageSha, 'X');
});

test('parseArgs: defaults are 3 repeats, arm grok, all rows, no plan', () => {
  const a = parseArgs([]);
  assert.deepEqual([a.repeats, a.arm, a.rowIds, a.plan], [3, 'grok', null, false]);
});

test('parseArgs: refuses a bad repeat count, an unknown arm and an unknown flag', () => {
  assert.match(parseArgs(['--repeats', '0']).error, /repeats/);
  assert.match(parseArgs(['--repeats', 'x']).error, /repeats/);
  assert.match(parseArgs(['--arm', 'auto']).error, /arm/);
  assert.match(parseArgs(['--bogus']).error, /unknown/);
});

// The real --plan: real git, real lock hashes, no Docker, no prove-check, no rows.mjs.
test('--plan runs for real with no Docker: rows, repeats, estimated hours and image tags', async () => {
  const lines = [];
  const boom = () => { throw new Error('--plan must not reach this'); };
  const code = await main(['--rows', 'S18,S8,S3', '--repeats', '1', '--plan'], {
    out: (l) => lines.push(l), spawn: boom, docker: boom, hasImage: boom, loadRows: boom, loadNegatives: boom,
  });
  const text = lines.join('\n');
  assert.equal(code, 0);
  assert.match(text, /rows: S18, S8, S3/);
  assert.match(text, /repeats: 1/);
  assert.match(text, /estimated hours: \d/);
  assert.match(text, /trex:[0-9a-f]{12}/);
  assert.match(text, /No run started/);
});

test('planBench: counts side-runs as rows x repeats x 2 and lists a tag once', async () => {
  const plan = await planBench({ rowIds: ['S8', 'S3'], repeats: 3, imageSha: 'IMG' }, { tagsFor: (heads) => heads.map((_, i) => (i < 2 ? 'trex:aaaaaaaaaaaa' : 'trex:bbbbbbbbbbbb')) });
  assert.equal(plan.sideRuns, 12);
  assert.deepEqual(plan.tags, ['trex:aaaaaaaaaaaa', 'trex:bbbbbbbbbbbb']);
  assert.ok(plan.hours > 1);
});

// ---------- principal review fixes (2026-11-03) ----------

const S6 = row({ major: 'S6', pre: 'pre66666', fix: 'fix66666', bench: { kind: 'catch', group: 'S6', defectFiles: ['src/s6.ts'] } });
const S7 = row({ major: 'S7', pre: 'pre66666', fix: 'fix66666', bench: { kind: 'catch', group: 'S6', defectFiles: ['hooks/pr-checkpoint/index.tsx'] } });
const proves = (w) => w.calls.spawn.filter((c) => c.args.some((a) => String(a).endsWith('prove-check.mjs')));
const majorOf = (c) => c.args[c.args.indexOf('--major') + 1];
const byId = (r) => Object.fromEntries(r.metrics.rows.map((x) => [x.id, x.verdicts]));
const provedRows = (c) => JSON.parse(readFileSync(c.args[c.args.indexOf('--proofs') + 1], 'utf8')).rows.map((x) => x.major);

// ----- finding 1: S7 shares S6's run -----

test('F1: S7 is graded from the S6 run: one prove-check, S6 caught, S7 graded with its own defect files', async () => {
  // Breaks when S7 runs as its own prove-check row: one nondeterministic S6 run then counts as two flaky rows and adds side-runs.
  const w = benchWorld({}, { rows: [S6, S7], flowPaths: ['src/s6.ts'] });
  const r = await runBench(base(w, { rowIds: ['S6', 'S7'] }), w.deps);
  assert.deepEqual(proves(w).map(majorOf), ['S6']);
  assert.deepEqual(provedRows(proves(w)[0]), ['S6']);
  assert.deepEqual(byId(r), { S6: ['caught'], S7: ['fire-unattributed'] });
  assert.equal(r.metrics.minutes.sides, 2, 'the S6 run counts its two side-runs once');
});

test('F1: --rows S7 alone still runs the S6 prove-check and reports S7 only', async () => {
  const w = benchWorld({}, { rows: [S6, S7], flowPaths: ['hooks/pr-checkpoint/index.tsx'] });
  const r = await runBench(base(w, { rowIds: ['S7'] }), w.deps);
  assert.deepEqual(proves(w).map(majorOf), ['S6']);
  assert.deepEqual(byId(r), { S7: ['caught'] });
});

test('F1: a flake counts once for each prove-check run, so S6 and S7 flipping together are one flaky run', async () => {
  // Breaks when the flake bar counts rows: the same S6 flip would give 2 flaky rows, a FAIL on the flake bar, and "rework" instead of "continue".
  const w = benchWorld({ S6: (n) => (n < 2 ? {} : { pre: ['no-fire', []] }) }, { rows: [S6, S7], flowPaths: ['src/s6.ts'] });
  const r = await runBench(base(w, { rowIds: ['S6', 'S7'], repeats: 3 }), w.deps);
  assert.equal(proves(w).length, 3, 'S6 runs once for each repeat, not twice');
  assert.deepEqual(byId(r), { S6: ['caught', 'caught', 'miss'], S7: ['fire-unattributed', 'fire-unattributed', 'miss'] });
  assert.ok(r.metrics.rows.every((x) => x.flaky));
  assert.equal(r.metrics.flakes, 1);
  assert.equal(r.metrics.bars.flake, true);
});

test('F1: the plan counts the S6 and S7 pair as one run', async () => {
  const plan = await planBench({ rowIds: ['S6', 'S7'], repeats: 3, imageSha: 'IMG' }, { tagsFor: (heads) => heads.map(() => 'trex:aaaaaaaaaaaa') });
  assert.deepEqual(plan.rows.map((x) => x.id), ['S6', 'S7']);
  assert.equal(plan.sideRuns, 6);
});

// ----- finding 2: negatives checked at preflight -----

test('F2: a full run asks validateNegatives with the frozen sha and the arm flows, and refuses on a problem before any row runs', async () => {
  // Breaks when validateNegatives is not called: a not_clean or too-few-tested set is found only after 15 hours.
  const w = benchWorld({}, { negProblems: ['only 4 negatives are tested (graded for at least one group); the bench needs 10'] });
  const r = await runBench(base(w), w.deps);
  assert.equal(r.exit, 2);
  assert.equal(w.calls.spawn.length, 0);
  assert.match(r.problems.join('\n'), /only 4 negatives are tested/);
  const call = w.calls.validatedNeg[0];
  assert.equal(call.opts.sha, SHA_A);
  assert.equal(call.opts.ref, 'fork/main');
  assert.deepEqual(Object.keys(call.opts.flows), ARMS.grok.groups);
  assert.deepEqual(call.negatives.map((n) => n.id), ['N2', 'K1']);
});

test('F2: a smoke run (rows given) never asks validateNegatives', async () => {
  const w = benchWorld({}, { negProblems: ['x'] });
  const r = await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.equal(r.exit, 0);
  assert.equal(w.calls.validatedNeg.length, 0);
});

// ----- finding 3: the arm row filter -----

const XROWS = [
  row({ major: 'S8', pre: 'pre88888', fix: 'fix88888' }),
  row({ major: 'S1', pre: 'pre11111', fix: 'fix11111', bench: { kind: 'catch', group: 'S1', defectFiles: ['src/defect.ts'] } }),
  row({ major: 'S3', pre: 'pre33333', fix: 'fix33333', bench: { kind: 'catch', group: 'S3', defectFiles: ['x'] } }),
  row({ major: 'S18', pre: 'pre18181', fix: 'fix18181', bench: { kind: 'catch', group: 'S18', defectFiles: ['src/defect.ts'] } }),
];

test('F3: a full run of the xhigh arm keeps the rows of its four groups, skips S17 and the negatives, and reports the arm row count', async () => {
  // Breaks when selectRows ignores the arm: 12 rows go to folders that do not exist, grade broken, and the verdict is "invalid".
  const w = benchWorld({}, { arm: 'xhigh', rows: XROWS });
  const outDir = path.join(w.repo, 'out');
  const r = await runBench(base(w, { arm: 'xhigh', outDir }), w.deps);
  assert.equal(r.exit, 0, r.problems.join('; '));
  assert.deepEqual(proves(w).map(majorOf).sort(), ['S1', 'S18', 'S8']);
  assert.equal(w.calls.spawn.filter((c) => c.args.includes('--simulate')).length, 0, 'no S17 run and no negative run');
  assert.equal(r.metrics.honestSkip, null);
  assert.deepEqual(r.metrics.negatives, []);
  assert.deepEqual(r.metrics.scope, { n: 2, fullN: 3, partial: false, repeats: 1 });
  assert.ok(w.calls.tagHeads.flat().every((h) => !h.includes('33333')), 'no image check for the S3 heads');
  assert.match(r.artifact, /2026-11-03-trex-bench-xhigh\.json$/);
  assert.doesNotMatch(readFileSync(r.artifact.replace('.json', '.txt'), 'utf8').split('\n')[0], /smoke/i);
  const v = w.calls.validatedRows[0];
  assert.deepEqual(v.rows.map((x) => x.major).sort(), ['S1', 'S18', 'S8']);
  assert.equal(v.opts.flowsDir, 'scripts/trex/bench/flows-xhigh');
  assert.deepEqual(v.opts.groups, ARMS.xhigh.groups);
});

test('F3: --rows with a row outside the arm is refused, and --negatives on a four-group arm still asks validateNegatives with the arm groups', async () => {
  const w = benchWorld({}, { arm: 'xhigh', rows: XROWS });
  const r = await runBench(base(w, { arm: 'xhigh', rowIds: ['S3'] }), w.deps);
  assert.equal(r.exit, 2);
  assert.match(r.problems.join('\n'), /S3/);
  assert.equal(w.calls.spawn.length, 0);
  const n = benchWorld({}, { arm: 'xhigh', rows: XROWS });
  await runBench(base(n, { arm: 'xhigh', negatives: true }), n.deps);
  assert.deepEqual(Object.keys(n.calls.validatedNeg[0].opts.flows), ARMS.xhigh.groups);
});

test('F3: --plan for the xhigh arm lists its four groups only, with no negative or S17 run', async () => {
  const lines = [];
  const boom = () => { throw new Error('--plan must not reach this'); };
  const code = await main(['--arm', 'xhigh', '--repeats', '1', '--plan'], { out: (l) => lines.push(l), spawn: boom, docker: boom, hasImage: boom, loadRows: boom, loadNegatives: boom });
  const text = lines.join('\n');
  assert.equal(code, 0);
  assert.match(text, /rows: S1, S8, S14, S18\n/);
  assert.match(text, /side runs: 8 /);
  assert.doesNotMatch(text, /negative run/);
  assert.equal(await main(['--arm', 'xhigh', '--rows', 'S3', '--plan'], { out: () => {}, loadNegatives: boom }), 2);
});

test('--plan for the intent arm lists S1, S8, S14 and S18 only, and refuses a row outside the arm', async () => {
  // Breaks when the intent arm is missing from ARMS (--arm intent is refused) or lists more than the four probe groups.
  const lines = [];
  const boom = () => { throw new Error('--plan must not reach this'); };
  const code = await main(['--arm', 'intent', '--repeats', '1', '--plan'], { out: (l) => lines.push(l), spawn: boom, docker: boom, hasImage: boom, loadRows: boom, loadNegatives: boom });
  const text = lines.join('\n');
  assert.equal(code, 0, text);
  assert.match(text, /bench plan \(arm intent\)/);
  assert.match(text, /rows: S1, S8, S14, S18\n/);
  assert.equal(await main(['--arm', 'intent', '--rows', 'S3', '--plan'], { out: () => {}, loadNegatives: boom }), 2);
});

test('parseArgs: the composer2 arm is accepted', () => {
  assert.equal(parseArgs(['--arm', 'composer2']).arm, 'composer2');
});

// ----- finding 4: lock ownership, the bench lock, the exit 3 retry -----

const rivalLock = (w, extra = {}) => writeFileSync(w.deps.lockPath, JSON.stringify({ pid: 99, started: new Date(NOW).toISOString(), runId: 'rival', benchRun: 'rival-bench', argv: ['--tree', 'x/trex-S8'], ...extra }));

test('F4: a row whose run exits 3 (lock held) is retried once and graded from the retry, not broken', async () => {
  // Breaks when exit 3 is not retried: a rival run at the same moment grades the row broken and too many give "invalid".
  const w = benchWorld({ S8: (n) => (n === 0 ? { preCode: 3, pre: ['broken', []] } : {}) });
  const r = await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.equal(proves(w).length, 2);
  assert.deepEqual(byId(r), { S8: ['caught'] });
});

test('F4: a row that exits 3 twice is graded broken after one retry only', async () => {
  const w = benchWorld({ S8: { preCode: 3, pre: ['broken', []] } });
  const r = await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.equal(proves(w).length, 2, 'one retry, not a loop');
  assert.deepEqual(byId(r), { S8: ['broken'] });
});

test('F4: the retry waits while a live rival run holds the lock, and starts when it is gone', async () => {
  const w = benchWorld({ S8: (n) => (n === 0 ? { preCode: 3, pre: ['broken', []] } : {}) }, { onSleep: () => rmSync(w.deps.lockPath, { force: true }) });
  rivalLock(w);
  w.deps.pidAlive = (pid) => pid === 99;
  const r = await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.equal(w.calls.slept.length, 1);
  assert.equal(w.calls.killed.length, 0, 'the rival is never killed');
  assert.deepEqual(byId(r), { S8: ['caught'] });
});

test('F4: a negative whose run exits 3 is retried once', async () => {
  const w = benchWorld({ 'neg:S1': (n) => (n === 0 ? { stdout: '# trex: another run holds the lock\n', code: 3 } : undefined) });
  const r = await runBench(base(w), w.deps);
  assert.equal(r.metrics.negatives.find((x) => x.id === 'N2').verdict, 'clean');
  assert.equal(w.calls.spawn.filter((c) => c.args.includes('neg22222')).length, 2);
});

test('F4: a bench lock held by a live bench refuses with exit 2 and runs nothing; a finished bench frees it', async () => {
  // Breaks when there is no bench-level lock: two benches share the row ids and clean up each other.
  const w = benchWorld();
  writeFileSync(w.deps.benchLockPath, JSON.stringify({ pid: 4242, started: new Date(NOW).toISOString(), argv: [], runId: 'other-bench' }));
  w.deps.pidAlive = (pid) => pid === 4242;
  const r = await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.equal(r.exit, 2);
  assert.match(r.problems.join('\n'), /another bench/);
  assert.equal(w.calls.spawn.length, 0);
  rmSync(w.deps.benchLockPath);
  const ok = await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.equal(ok.exit, 0);
  assert.equal(existsSync(w.deps.benchLockPath), false, 'released at the end');
});

test('F4: the bench lock is released when a row throws', async () => {
  const w = benchWorld();
  const spawn = w.deps.spawn;
  w.deps.spawn = (cmd, args, opts) => { if (args.some((a) => String(a).endsWith('prove-check.mjs'))) throw new Error('boom'); return spawn(cmd, args, opts); };
  await assert.rejects(runBench(base(w, { rowIds: ['S8'] }), w.deps), /boom/);
  assert.equal(existsSync(w.deps.benchLockPath), false);
});

test('F4: the bench sweeps its own trex.bench label at the end, and only its own id', async () => {
  const w = benchWorld();
  await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.ok(w.calls.docker.some((a) => a[0] === 'ps' && a.includes('label=trex.bench=bench1')));
});

// ----- finding 5: the freeze pins -----

test('F5: preflight refuses a negative head, negatives.json or proofs-trex.json that differs from the freeze pins', async () => {
  // Breaks when the pins are not compared: an edit after the freeze changes the answer key or the heads and the run goes on.
  const head = benchWorld({}, { negatives: [{ id: 'N2', head: 'other999' }, { id: 'K1', kind: 'skip', head: 'kkk11111' }] });
  let r = await runBench(base(head), head.deps);
  assert.equal(r.exit, 2);
  assert.match(r.problems.join('\n'), /N2.*other999|N2.*head/);
  const edited = (file) => (w) => {
    const inner = w.deps.git;
    w.deps.git = (args) => (args[0] === 'hash-object' && args.at(-1).endsWith(file) ? { status: 0, stdout: 'blob:EDITED\n', stderr: '' } : inner(args));
  };
  const neg = benchWorld();
  edited('negatives.json')(neg);
  r = await runBench(base(neg), neg.deps);
  assert.match(r.problems.join('\n'), /negatives\.json changed/);
  const proofs = benchWorld();
  edited('proofs-trex.json')(proofs);
  r = await runBench(base(proofs, { rowIds: ['S8'] }), proofs.deps);
  assert.equal(r.exit, 2);
  assert.match(r.problems.join('\n'), /proofs-trex\.json changed/);
  assert.equal(proofs.calls.spawn.length, 0);
});

test('F5: a frozen file with no pins is refused with a re-freeze message', async () => {
  const w = benchWorld({}, { frozen: { pins: undefined } });
  const r = await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.equal(r.exit, 2);
  assert.match(r.problems.join('\n'), /no input pins.*freeze/);
});

// ----- LOW findings: pids.json, the predictable tree, the frozen sha -----

const T0 = NOW.getTime();

test('F8: after a timeout the pids in each side .trex-out/pids.json are killed when their start time fits, and no other', async () => {
  // Breaks when only the lock owner is killed: a host child (pwsh, claude plugin test) that outlives its run.mjs stays orphaned.
  const w = benchWorld({ S8: { timeout: true, prePids: [{ pid: 555, started: T0 }, { pid: 556, started: T0 + 99_999 }], fixPids: [{ pid: 557, started: T0 }] } });
  w.deps.pidAlive = () => true;
  w.deps.processStart = () => T0;
  await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.deepEqual([...w.calls.killed].sort(), [555, 557]);
});

test('F8: a healthy row reads no pids.json and kills nothing', async () => {
  const w = benchWorld({ S8: { prePids: [{ pid: 555, started: T0 }] } });
  w.deps.pidAlive = () => true;
  w.deps.processStart = () => T0;
  await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.deepEqual(w.calls.killed, []);
});

test('F8: when the prove-check JSON is lost in a timeout, the sides still copy and die from the predictable proof tree', async () => {
  // Breaks when copySide needs the prove-check JSON: a row that hangs past the bench limit leaves no report.json or pids.json for the post-mortem.
  const w = benchWorld({ S8: { timeout: true, noJson: true, prePids: [{ pid: 555, started: T0 }] } });
  w.deps.pidAlive = () => true;
  w.deps.processStart = () => T0;
  const r = await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.deepEqual(w.calls.killed, [555]);
  assert.ok(existsSync(path.join(w.repo, '.claude', 'cache', 'e2e', 'trex', 'bench', 'bench1', 'r1', 'S8', 'pre', 'report.json')));
  assert.equal(r.metrics.rows[0].verdicts[0], 'broken');
});

test('F9: with host flows frozen, preflight also needs the frozen sha merged into fork/main', async () => {
  // Breaks when only the row heads are checked: every host row grades broken after hours when prepareHost finds the flows commit unmerged.
  const merged = (_g, sha) => sha !== SHA_A;
  const host = await preflight({ ...pfInput, hostSha: SHA_A }, pfDeps({ isMerged: merged }));
  assert.match(host.problems.join('\n'), /frozen flows commit.*merge/i);
  assert.deepEqual((await preflight(pfInput, pfDeps({ isMerged: merged }))).problems, [], 'container flows only: no need');
  const w = benchWorld({}, { frozen: { hostFlows: 1 } });
  w.deps.isMerged = merged;
  const r = await runBench(base(w, { rowIds: ['S8'] }), w.deps);
  assert.equal(r.exit, 2);
  assert.match(r.problems.join('\n'), /frozen flows commit/);
});
