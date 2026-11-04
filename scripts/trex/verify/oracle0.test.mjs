// Tests for oracle0.mjs. Each test imports the real functions. The plan cases read real git history of this repo (read only).
// The tree cases build a throw-away git repo in the OS temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { proveRow } from '../../checks/prove-check.mjs';
import { proveRowInContainer, runSide, specArgv, withTrexLock, SEED_LIVE_SESSION } from './oracle0-container.mjs';
import { loadRows } from '../bench/rows.mjs';
import {
  differential, runPlan, groupRow, importTargets, isTestPath, nearestTests, oracleDeps, overlayFiles, planFixDiff, planRunners,
  pruneTests, rowVerdict, specNeedsServer, testFlows,
} from './oracle0.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const ROWS = loadRows(path.join(ROOT, 'scripts', 'trex', 'bench', 'proofs-trex.json'));
const hasHistory = spawnSync('git', ['-C', ROOT, 'cat-file', '-e', '23b62e5d^{commit}']).status === 0;
const skipHistory = hasHistory ? false : 'bench SHAs are not in this clone';
const row = (id) => ROWS.find((r) => r.major === id);

// ---------- which files are tests ----------

test('isTestPath: tests, specs, fixtures and e2e helpers are tests; sources and docs are not', () => {
  for (const p of ['scripts/github/review-status.test.mjs', 'a/b.spec.ts', '.claude/plugins/ccv3-mods/tests/brief.test.ts', 'scripts/github/fixtures/x/y.md', 'apps/agentic-os/e2e/state-fixture.ts', 'scripts/a.test.ps1']) {
    assert.equal(isTestPath(p), true, p);
  }
  for (const p of ['README.md', 'scripts/github/review-status.mjs', '.claude/hooks/src/shared/embedding-client.ts', '.github/workflows/ccv3-checks.yml']) {
    assert.equal(isTestPath(p), false, p);
  }
});

test('overlayFiles: a defect file that looks like a test is never laid over the pre tree', () => {
  const changed = ['x/a.test.mjs', 'x/a.mjs', 'x/fixtures/data.md'];
  assert.deepEqual(overlayFiles(changed, []), ['x/a.test.mjs', 'x/fixtures/data.md']);
  assert.deepEqual(overlayFiles(changed, ['x/fixtures/data.md']), ['x/a.test.mjs']);
});

// ---------- the runner plan ----------

test('specNeedsServer: page or request fixtures need a server, plain async callbacks do not', () => {
  assert.equal(specNeedsServer("test('a', async ({ page, request }) => {})"), true);
  assert.equal(specNeedsServer("test('a', async ({ request }) => {})"), true);
  assert.equal(specNeedsServer("test('a', async () => { expect(f()).toBe(1) })"), false);
});

test('planRunners: node, plugin, pure spec and server spec files get a runner; ps1 and fixtures are skipped with a reason', () => {
  const files = ['scripts/a.test.mjs', '.claude/plugins/ccv3-mods/tests/brief.test.ts', 'apps/agentic-os/e2e/pure.spec.ts', 'apps/agentic-os/e2e/server.spec.ts', 'scripts/x.test.ps1', 'scripts/fixtures/f.md'];
  const read = (f) => (f.endsWith('server.spec.ts') ? "test('a', async ({ page }) => {})" : "test('a', async () => {})");
  const { groups, skipped } = planRunners(files, read);
  assert.deepEqual(groups.map((g) => g.kind), ['node', 'plugin:ccv3-mods', 'playwright-pure', 'playwright-server']);
  assert.deepEqual(groups[0].cmd, ['{node}', '--test', '--test-reporter=tap', 'scripts/a.test.mjs']);
  assert.deepEqual(groups[1].cmd, ['claude', 'plugin', 'test', '.claude/plugins/ccv3-mods']);
  assert.deepEqual(groups[1].keep, { dir: '.claude/plugins/ccv3-mods/tests', files: ['.claude/plugins/ccv3-mods/tests/brief.test.ts'] });
  assert.ok(groups[2].cmd.includes('e2e/pure.spec.ts') && !groups[2].cmd.includes('e2e/server.spec.ts'));
  assert.equal(groups[3].container, true);
  assert.deepEqual(groups[3].files, ['apps/agentic-os/e2e/server.spec.ts']);
  assert.equal(groups.filter((g) => g.container).length, 1, 'only the server spec goes to the container');
  assert.deepEqual(skipped.map((s) => s.file).sort(), ['scripts/fixtures/f.md', 'scripts/x.test.ps1']);
  assert.ok(skipped.every((s) => s.reason.length > 10));
});

// ---------- the fix-diff plan on real history ----------

test('planFixDiff: S8 and S10 have no test file in the fix diff; the other 13 of 15 rows do', { skip: skipHistory }, () => {
  const ids = Array.from({ length: 15 }, (_, i) => `S${i + 1}`);
  const withTests = ids.filter((id) => planFixDiff(ROOT, row(id)).overlay.length > 0);
  const without = ids.filter((id) => !withTests.includes(id));
  assert.deepEqual(without, ['S8', 'S10']);
  assert.equal(withTests.length, 13);
  assert.equal(planFixDiff(ROOT, row('S8')).attempted, false);
});

test('planFixDiff: S14 lays the fixture over the pre tree and runs both node test files', { skip: skipHistory }, () => {
  const plan = planFixDiff(ROOT, row('S14'));
  assert.ok(plan.overlay.includes('scripts/github/fixtures/coderabbit-severity/pr242-review-5729735980-follow-up-major.md'));
  assert.deepEqual(plan.groups.map((g) => g.kind), ['node']);
  assert.deepEqual(plan.groups[0].files.sort(), ['scripts/github/cr-paid.test.mjs', 'scripts/github/review-status.test.mjs']);
});

test('planFixDiff: S6 and S7 give a node group and a plugin group; S12 gives nothing to run; S1 runs in the container', { skip: skipHistory }, () => {
  assert.deepEqual(planFixDiff(ROOT, row('S6')).groups.map((g) => g.kind).sort(), ['node', 'plugin:ccv3-mods']);
  const s12 = planFixDiff(ROOT, row('S12'));
  assert.equal(s12.attempted, false);
  assert.match(s12.why, /FAIL/);
  const s1 = planFixDiff(ROOT, row('S1'));
  assert.equal(s1.attempted, true);
  assert.deepEqual(s1.groups.map((g) => [g.kind, g.container === true]), [['playwright-server', true]]);
});

test('planFixDiff: S13 splits the pure specs (host) from the server spec (container)', { skip: skipHistory }, () => {
  const plan = planFixDiff(ROOT, row('S13'));
  assert.deepEqual(plan.groups.map((g) => g.kind), ['playwright-pure', 'playwright-server']);
  assert.deepEqual(plan.groups[1].files, ['apps/agentic-os/e2e/raw-project.spec.ts']);
});

// ---------- verdicts ----------

const run = (code, stdout = '', stderr = '') => ({ code, stdout, stderr });
const R = { major: 'X', check: 'oracle0', fireMatch: '^not ok ' };
const FAIL = run(1, 'not ok 1 - the leak test\n');
const PASS = run(0, 'ok 1 - the leak test\n');
const IMPORT_ERR = run(1, '', "Error: Cannot find module '../src/project-label'\nnot ok 1 - file did not load\n");

test('differential: fires at head and clean at base is a differential fail', () => {
  assert.equal(differential(R, FAIL, PASS).verdict, 'differential-fail');
});

test('differential: fires at both is preexisting, clean at head is no signal', () => {
  assert.equal(differential(R, FAIL, FAIL).verdict, 'preexisting-fail');
  assert.equal(differential(R, PASS, FAIL).verdict, 'no-signal');
  assert.equal(differential(R, PASS, PASS).verdict, 'no-signal');
});

test('differential: an import error at head is broken, never a fire', () => {
  assert.equal(differential(R, IMPORT_ERR, PASS).verdict, 'broken');
  assert.equal(differential(R, run(1, 'boom'), PASS).verdict, 'broken');
});

test('proveRow through the oracle row shape: fire at pre and clean at fix proves; an import error at pre does not', () => {
  const plan = { major: 'S9', pre: 'a', fix: 'b', overlay: ['t.test.mjs'] };
  const r = groupRow(plan, { kind: 'node', files: ['t.test.mjs'], cmd: ['{node}', '--test'], fireMatch: '^not ok ' });
  const deps = (pre) => ({ buildTree: (_r, ref) => ({ ref, sha: ref, tree: `/t/${ref}` }), runCmd: (_r, tree) => (tree.endsWith('/a') ? pre : PASS) });
  assert.equal(proveRow(r, deps(FAIL)).ok, true);
  const broken = proveRow(r, deps(IMPORT_ERR));
  assert.equal(broken.ok, false);
  assert.match(broken.reasons.join(' '), /broken/);
  assert.equal(proveRow(r, deps(PASS)).ok, false);
});

test('rowVerdict: one proving group is enough; a fix side that fires or breaks is never proven; no group is not proven', () => {
  const ok = { major: 'S6.node', ok: true, reasons: [], fix: { verdict: 'no-fire' } };
  const noFire = { major: 'S6.plugin', ok: false, reasons: ['pre-fix run did not fire'], fix: { verdict: 'no-fire' } };
  const fixFires = { major: 'S6.x', ok: false, reasons: ['fix run still fires'], fix: { verdict: 'fire' } };
  assert.equal(rowVerdict([ok, noFire]).proven, true);
  assert.equal(rowVerdict([ok, fixFires]).proven, false);
  assert.equal(rowVerdict([noFire]).proven, false);
  assert.equal(rowVerdict([]).proven, false);
  assert.equal(rowVerdict([{ major: 'S13.p', ok: false, reasons: ['setup error: x'], setupError: true }]).proven, false);
});

// ---------- trees: a throw-away repo ----------

function makeRepo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oracle0-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q');
  const put = (f, text) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), text); };
  return { dir, git, put };
}

test('buildTree: the pre tree holds the fix copy of the overlay test, the fix tree holds the fix, and neither leaks into the other', (t) => {
  const { dir, git, put } = makeRepo(t);
  put('src/a.mjs', 'export const v = 1;\n');
  put('src/old.test.mjs', 'old\n');
  git('add', '-A'); git('commit', '-qm', 'pre');
  const pre = git('rev-parse', 'HEAD');
  put('src/a.mjs', 'export const v = 2;\n');
  put('src/a.test.mjs', 'new test\n');
  git('add', '-A'); git('commit', '-qm', 'fix');
  const fix = git('rev-parse', 'HEAD');
  const r = { ...groupRow({ major: 'S9', pre, fix, overlay: ['src/a.test.mjs'] }, { kind: 'node', files: ['src/a.test.mjs'], cmd: ['x'], fireMatch: '^not ok ' }) };
  const deps = oracleDeps({ repo: dir, treeRoot: dir });
  const a = deps.buildTree(r, pre);
  assert.equal(readFileSync(path.join(a.tree, 'src/a.mjs'), 'utf8'), 'export const v = 1;\n', 'pre source stays at pre');
  assert.equal(readFileSync(path.join(a.tree, 'src/a.test.mjs'), 'utf8'), 'new test\n', 'fix test is laid over pre');
  const b = deps.buildTree(r, fix);
  assert.equal(readFileSync(path.join(b.tree, 'src/a.mjs'), 'utf8'), 'export const v = 2;\n');
  assert.notEqual(a.tree, b.tree);
  assert.ok(a.tree.startsWith(path.join(dir, '.claude', 'cache', 'proof')), 'trees live under the proof folder of the given root');
});

test('buildTree: a tree outside the proof folder is refused and a stale file does not survive a rebuild', (t) => {
  const { dir, git, put } = makeRepo(t);
  put('a.txt', '1');
  git('add', '-A'); git('commit', '-qm', 'one');
  const sha = git('rev-parse', 'HEAD');
  const r = groupRow({ major: 'S9', pre: sha, fix: sha, overlay: [] }, { kind: 'node', files: [], cmd: ['x'], fireMatch: '^not ok ' });
  const deps = oracleDeps({ repo: dir, treeRoot: dir });
  const first = deps.buildTree(r, sha);
  writeFileSync(path.join(first.tree, 'stale.txt'), 'x');
  const second = deps.buildTree(r, sha);
  assert.equal(existsSync(path.join(second.tree, 'stale.txt')), false);
});

test('pruneTests: only the kept test files stay, sources stay', (t) => {
  const { dir, put } = makeRepo(t);
  put('p/tests/keep.test.ts', 'k'); put('p/tests/drop.test.ts', 'd'); put('p/tests/sub/drop2.test.tsx', 'd'); put('p/tests/helper.ts', 'h'); put('p/hooks/x.ts', 'x');
  pruneTests(dir, 'p/tests', ['p/tests/keep.test.ts']);
  assert.equal(existsSync(path.join(dir, 'p/tests/keep.test.ts')), true);
  assert.equal(existsSync(path.join(dir, 'p/tests/drop.test.ts')), false);
  assert.equal(existsSync(path.join(dir, 'p/tests/sub/drop2.test.tsx')), false);
  assert.equal(existsSync(path.join(dir, 'p/tests/helper.ts')), true);
  assert.equal(existsSync(path.join(dir, 'p/hooks/x.ts')), true);
});

// ---------- finding mode: nearest tests ----------

const LISTED = [
  'scripts/github/review-status.mjs', 'scripts/github/review-status.test.mjs', 'scripts/github/cr-paid.mjs', 'scripts/github/cr-paid.test.mjs',
  '.claude/plugins/ccv3-mods/hooks/agentic-os/brief.ts', '.claude/plugins/ccv3-mods/tests/brief.test.ts', '.claude/plugins/ccv3-mods/tests/other.test.ts',
];
const READ = (f) => (f === 'scripts/github/cr-paid.test.mjs' ? "import { x } from './review-status.mjs';\nimport { y } from './cr-paid.mjs';" : f.endsWith('brief.test.ts') ? "import { a } from '../hooks/agentic-os/brief'" : '');

test('importTargets: a relative import resolves to the tracked file, with or without extension', () => {
  assert.deepEqual(importTargets('.claude/plugins/ccv3-mods/tests/brief.test.ts', READ('.claude/plugins/ccv3-mods/tests/brief.test.ts'), LISTED), ['.claude/plugins/ccv3-mods/hooks/agentic-os/brief.ts']);
  assert.deepEqual(importTargets('scripts/github/cr-paid.test.mjs', READ('scripts/github/cr-paid.test.mjs'), LISTED).sort(), ['scripts/github/cr-paid.mjs', 'scripts/github/review-status.mjs']);
});

test('nearestTests: a finding file picks the tests that import it or are named after it, and not unrelated tests', () => {
  const flows = testFlows(LISTED, READ);
  assert.deepEqual(nearestTests(flows, 'scripts/github/review-status.mjs').sort(), ['scripts/github/cr-paid.test.mjs', 'scripts/github/review-status.test.mjs']);
  assert.deepEqual(nearestTests(flows, '.claude/plugins/ccv3-mods/hooks/agentic-os/brief.ts'), ['.claude/plugins/ccv3-mods/tests/brief.test.ts']);
  assert.deepEqual(nearestTests(flows, 'docs/readme.md'), []);
});

// ---------- runPlan: container groups ----------

test('runPlan: a container group goes to the container runner, host groups to proveRow; no runner is a setup error', async () => {
  const plan = { major: 'S1', pre: 'a', fix: 'b', overlay: ['apps/agentic-os/e2e/x.spec.ts'], groups: [{ kind: 'playwright-server', files: ['apps/agentic-os/e2e/x.spec.ts'], container: true, cmd: ['npx'], fireMatch: '^x' }] };
  const seen = [];
  const out = await runPlan(plan, {}, async (r) => { seen.push(r.oracle.specs); return { major: r.major, ok: true, reasons: [] }; });
  assert.deepEqual(seen, [['apps/agentic-os/e2e/x.spec.ts']]);
  assert.equal(out[0].ok, true);
  const none = await runPlan(plan, {}, undefined);
  assert.equal(none[0].ok, false);
  assert.equal(none[0].setupError, true);
  const thrown = await runPlan(plan, {}, async () => { throw new Error('lock held'); });
  assert.match(thrown[0].reasons[0], /lock held/);
});

// ---------- the container runner with fake environments ----------

const SPEC = 'apps/agentic-os/e2e/s.spec.ts';
const PASS_OUT = { code: 0, stdout: '  3 passed', stderr: '' };
const FAIL_OUT = { code: 1, stdout: '  1) [chromium] > e2e/s.spec.ts:5 > t\n  1 failed', stderr: '' };

/** A fake TREX environment. execFor(head) gives the spec run output of the environment started for that head. */
function fakeContainerDeps({ execFor = () => PASS_OUT, failStart = false, lockOk = true } = {}) {
  const log = [];
  const deps = {
    cwd: os.tmpdir(), imageSha: 'img', evidenceRoot: path.join(os.tmpdir(), 'oracle0-container-test'), lockFile: 'lock',
    git: (args) => (args[0] === 'show' ? { status: 0, stdout: `SPEC FROM ${args[1]}`, stderr: '' } : { status: 1, stdout: '', stderr: '' }),
    ensureImage: async () => ({ tag: 'trex:x', built: false }),
    startEnv: async (o) => {
      log.push(['start', o.head]);
      if (failStart) throw new Error('compose create failed');
      return {
        app: 'p-app-1', childEnv: {},
        d: { docker: async (a, o2) => { log.push(['seed', o2.stdin]); return { code: 0, stdout: '', stderr: '' }; } },
        exec: async (argv, o2) => {
          if (argv[0] === 'sh') { log.push(['write', argv[2], o2.stdin]); return { code: 0, stdout: '', stderr: '' }; }
          log.push(['exec', argv.join(' '), o2.cwd, o2.env]);
          return execFor(o.head);
        },
      };
    },
    stopEnv: async () => { log.push(['stop']); },
    acquireLock: () => (lockOk ? { ok: true, release: () => log.push(['release']) } : { ok: false, pid: 42 }),
  };
  return { deps, log };
}
const ROWC = { major: 'S1.playwright-server', check: 'oracle0', pre: 'PRE', fix: 'FIX', fireMatch: '^(\\d+\\)|x\\s+\\d+)\\s', oracle: { overlay: [SPEC, 'scripts/other.test.mjs'], specs: [SPEC] } };

test('specArgv: spec paths are made relative to the app folder and one project runs', () => {
  assert.deepEqual(specArgv([SPEC]), ['npx', 'playwright', 'test', 'e2e/s.spec.ts', '--project=chromium', '--reporter=list']);
});

test('runSide: seeds before the run, writes the overlay only when asked, and always stops the environment', async () => {
  const { deps, log } = fakeContainerDeps();
  const r = await runSide(deps, { head: 'PRE', fix: 'FIX', overlay: [SPEC], specs: [SPEC] });
  assert.equal(r.code, 0);
  assert.deepEqual(log.map((l) => l[0]), ['start', 'seed', 'write', 'exec', 'stop']);
  assert.ok(log[3][3].USER, 'the spec run has an OS user name (the container has none)');
  assert.equal(log[1][1], SEED_LIVE_SESSION);
  assert.equal(log[2][2], `SPEC FROM FIX:${SPEC}`, 'the file comes from the fix SHA');
  const clean = fakeContainerDeps();
  await runSide(clean.deps, { head: 'FIX', fix: 'FIX', overlay: [], specs: [SPEC] });
  assert.equal(clean.log.some((l) => l[0] === 'write'), false);
});

test('runSide: an environment that fails to start is a BROKEN run (error set), never a throw', async () => {
  const { deps } = fakeContainerDeps({ failStart: true });
  const r = await runSide(deps, { head: 'PRE', fix: 'FIX', overlay: [], specs: [SPEC] });
  assert.equal(r.code, null);
  assert.match(r.error, /compose create failed/);
});

test('proveRowInContainer: fire at pre and a pass at fix proves; only app files go in; an environment error is not a fire', async () => {
  const ok = await proveRowInContainer(ROWC, fakeContainerDeps({ execFor: (head) => (head === 'PRE' ? FAIL_OUT : PASS_OUT) }).deps);
  assert.equal(ok.ok, true, ok.reasons.join('; '));
  assert.deepEqual(ok.pre.copied.map((c) => c.to), [SPEC]);
  const bad = await proveRowInContainer(ROWC, fakeContainerDeps({ failStart: true }).deps);
  assert.equal(bad.ok, false);
  assert.match(bad.reasons.join(' '), /broken/);
  const stillFires = await proveRowInContainer(ROWC, fakeContainerDeps({ execFor: () => FAIL_OUT }).deps);
  assert.equal(stillFires.ok, false);
  assert.match(stillFires.reasons.join(' '), /still fires/);
});

test('withTrexLock: a held lock refuses before any run; the lock is released after a failing run', async () => {
  const held = fakeContainerDeps({ lockOk: false });
  await assert.rejects(withTrexLock(held.deps, async () => 'ran'), /lock is held by pid 42/);
  const ok = fakeContainerDeps();
  await assert.rejects(withTrexLock(ok.deps, async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(ok.log, [['release']]);
});
