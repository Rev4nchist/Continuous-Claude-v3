// Tests for verify.mjs, the P1 driver. No Docker, no model: a stub runner stands in for the container side.
// The real container run is the smoke: `node scripts/trex/verify/verify.mjs --live --flows-dir <fixture> --only <pids>`
// (artifact .claude/cache/e2e/2026-11-03-trex-verify-p1-driver-smoke.json).
// Each test names the change that would break it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, makeLiveRunner, parseArgs, runFromFlow, loadFlowDir } from './verify.mjs';
import { buildFireMatch } from './verdict.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'verify-test-'));
const FILE = 'scripts/github/review-status.mjs';
const SRC = 'export function f() {\n  return 1;\n}\n'.repeat(40);
const FIRE_MATCH = 'counts [1-9]\\d* outside-diff';
const FIRE_LINE = 'not ok 1 - a notice counts 2 outside-diff finding(s), want 0';
const sha = (c) => c.repeat(40);

const baseRow = (o = {}) => ({
  pid: 'aaaa000000000001', row: 'S9', group: 'C', file: FILE, startLine: 10, endLine: 12, title: 't', severity: 'major', confidence: 4,
  head: sha('1'), mergeBase: sha('2'), pre: sha('1'), fix: sha('3'), blocked: null, surface: 'node', ...o,
});

const flowYaml = (pid, extra = '') => `id: ${pid}
title: probe ${pid}
description: probe for a finding
goal: the app returns the correct value
paths: [${FILE}]
driver: cli
mode: scripted
profile: container
steps:
  - action:
      cmd: [node, --input-type=module]
      stdin: |
        console.log('probe');
    checks:
      - {text: the probe passes, exit: 0}
limits: {timeoutMs: 60000, retries: 1, maxSteps: 5}
severity: P1
${extra}`;

const declareJson = (pid, row, o = {}) => JSON.stringify({ pid, row, fireMatch: FIRE_MATCH, correct: 'a notice adds 0 to the count', citedFile: FILE, startLine: 10, endLine: 12, newCode: false, ...o });

/** A flows dir with the given pids' flows under <row>/. Returns the dir. */
function makeFlows(rows, { only = rows.map((r) => r.pid), declare = {}, yaml = {} } = {}) {
  const dir = tmp();
  for (const r of rows) mkdirSync(path.join(dir, r.row), { recursive: true });
  for (const r of rows.filter((x) => only.includes(x.pid))) {
    writeFileSync(path.join(dir, r.row, `${r.pid}.yaml`), yaml[r.pid] ?? flowYaml(r.pid));
    if (declare[r.pid] !== null) writeFileSync(path.join(dir, r.row, `${r.pid}.declare.json`), declare[r.pid] ?? declareJson(r.pid, r.row));
  }
  return dir;
}

// ---------- stub container side ----------

const covFor = (file) => ({ v8: [{ result: [{ url: `file:///app/${file}`, functions: [{ ranges: [{ startOffset: 0, endOffset: SRC.length, count: 1 }] }] }] }], trace: null, sources: { [file]: SRC } });
const noCov = (file) => ({ v8: [{ result: [{ url: 'file:///app/other.mjs', functions: [{ ranges: [{ startOffset: 0, endOffset: 5, count: 1 }] }] }] }], trace: null, sources: { [file]: SRC } });

const FIRE = { state: 'fail', steps: [{ code: 1, stdout: `${FIRE_LINE}\n`, stderr: '' }] };
const PASS = { state: 'pass', steps: [{ code: 0, stdout: 'ok 1\n', stderr: '' }] };

/**
 * A stub runner. `plan(sideSha, flowId)` returns { state, steps, tampered?, cov? } for one run. Events go to `log`.
 * `open` counts open sides, so a test can prove only one env is open at a time.
 */
function stubRunner({ plan, docker = '29.0', lockHeld = false, openFails = null, log = [], cov = covFor } = {}) {
  const state = { open: 0, maxOpen: 0 };
  return {
    log, state,
    preflight: async () => { log.push(['preflight']); return docker; },
    withLock: async (fn) => { if (lockHeld) throw new Error('the TREX run lock is held by pid 1'); return fn(); },
    open: async ({ sha: s, flows }) => {
      log.push(['open', s, flows.map((f) => f.id)]);
      if (openFails?.(s)) throw new Error('compose create failed');
      state.open += 1; state.maxOpen = Math.max(state.maxOpen, state.open);
      return {
        sha: s,
        runFlow: async (flow, o) => {
          log.push(['run', s, flow.id, flow.limits.retries, o.coverageFile ?? null]);
          const p = plan(s, flow.id);
          return { entry: { id: flow.id, state: p.state }, steps: p.steps, tampered: p.tampered ?? [], cov: o.coverageFile ? (p.cov ?? cov(o.coverageFile)) : null, wallMs: 5 };
        },
        setFile: async (rel, text) => { log.push(['setFile', s, rel, text === null ? null : text.length]); },
        close: async () => { state.open -= 1; log.push(['close', s]); },
      };
    },
  };
}

/** git stub: `files` maps "<ref>:<path>" to text. ls-tree prints the path when the ref has it. */
const stubGit = (files) => (args) => {
  if (args[0] === 'ls-tree') { const key = `${args[1]}:${args[3]}`; return { status: 0, stdout: key in files ? `100644 blob abc\t${args[3]}\n` : '', stderr: '' }; }
  if (args[0] === 'show') return args[1] in files ? { status: 0, stdout: files[args[1]], stderr: '' } : { status: 128, stdout: '', stderr: 'missing' };
  return { status: 1, stdout: '', stderr: '' };
};
const bothSides = (row, extra = {}) => ({ [`${row.head}:${row.file}`]: SRC, [`${row.mergeBase}:${row.file}`]: SRC, [`${row.fix}:${row.file}`]: SRC, ...extra });

async function drive(rows, { flows, plan, live = true, only = null, git, runner, out = tmp(), probeRows = rows } = {}) {
  const r = runner ?? stubRunner({ plan });
  const argv = ['--flows-dir', flows, '--out', out, ...(live ? ['--live'] : []), ...(only ? ['--only', only.join(',')] : [])];
  const lines = [];
  let made = 0;
  const code = await main(argv, { rows: probeRows, git: git ?? stubGit(Object.assign({}, ...rows.map((x) => bothSides(x)))), makeRunner: () => { made += 1; return r; }, out: (l) => lines.push(l) });
  const wrote = lines.findLast((l) => /^# verify: wrote /.test(l));
  const file = wrote ? path.normalize(wrote.replace(/^# verify: wrote /, '')) : undefined;
  return { code, lines, runner: r, made, out, file, c2: file ? JSON.parse(readFileSync(file, 'utf8')) : null };
}

const rowOf = (res, pid) => res.c2.rows.find((r) => r.pid === pid);
const runs = (log) => log.filter((e) => e[0] === 'run');

// ---------- failure: the live path is reached without --live ----------

// Breaks if: main builds the live runner (Docker) before it checks --live.
test('without --live the live runner is never built, no env opens and the C2 file is a dry-run file', async () => {
  const row = baseRow();
  const res = await drive([row], { flows: makeFlows([row]), live: false, plan: () => { throw new Error('ran'); } });
  assert.equal(res.made, 0);
  assert.equal(res.code, 0);
  assert.equal(res.runner.log.length, 0);
  assert.match(path.basename(res.file), /dry-run/);
  assert.equal(rowOf(res, row.pid).verdict, 'not_attempted');
  assert.match(rowOf(res, row.pid).reason, /dry run/);
  assert.ok(res.lines.some((l) => /--live/.test(l)), 'the plan tells Dave how to go live');
});

// Breaks if: main builds the runner more than once per run, or never with --live.
test('with --live the runner is built once', async () => {
  const row = baseRow();
  const res = await drive([row], { flows: makeFlows([row]), plan: (s) => (s === row.head ? FIRE : PASS) });
  assert.equal(res.made, 1);
});

// ---------- failure: a pid gets no verdict, or two ----------

// Breaks if: a probe-set pid is skipped or listed twice in the C2 file, or a row loses its group or its original severity.
test('the real 44-pid probe set gives exactly 44 rows, with the classify blocks, in a dry run', async () => {
  const set = JSON.parse(readFileSync(new URL('./probe-set.json', import.meta.url), 'utf8')).rows;
  const flows = tmp();
  const res = await drive([], { flows, live: false, probeRows: set, git: stubGit({}) });
  assert.equal(res.c2.rows.length, 44);
  assert.equal(new Set(res.c2.rows.map((r) => r.pid)).size, 44);
  assert.equal(res.c2.arm, 'verify');
  const blocked = res.c2.rows.filter((r) => r.verdict.startsWith('blocked:'));
  assert.equal(blocked.length, set.filter((r) => r.blocked).length);
  for (const r of res.c2.rows) {
    const src = set.find((s) => s.pid === r.pid);
    assert.equal(r.group, src.group);
    assert.equal(r.originalSeverity, src.severity);
    assert.equal(r.newSeverity, src.severity, 'a dry run never changes severity');
    assert.equal(r.falseConfirm, null);
  }
  assert.ok(blocked.every((r) => /^blocked:(mods-host|windows-only)$/.test(r.verdict)));
});

// Breaks if: --only drops the other pids from the file instead of marking them not_attempted, or lets the filter unblock a classify block.
test('--only runs the named pids and marks every other pid not_attempted, classify blocks kept', async () => {
  const a = baseRow({ pid: 'aaaa000000000001' });
  const b = baseRow({ pid: 'bbbb000000000002' });
  const c = baseRow({ pid: 'cccc000000000003', blocked: 'mods-host', file: 'x/index.tsx' });
  const flows = makeFlows([a, b, c]);
  const res = await drive([a, b, c], { flows, only: [a.pid], plan: (s) => (s === a.head ? PASS : PASS) });
  assert.equal(res.c2.rows.length, 3);
  assert.equal(rowOf(res, b.pid).verdict, 'not_attempted');
  assert.match(rowOf(res, b.pid).reason, /--only/);
  assert.equal(rowOf(res, c.pid).verdict, 'blocked:mods-host');
  assert.ok(runs(res.runner.log).every((e) => e[2].startsWith(a.pid)));
  assert.equal(path.basename(res.file), 'verdicts.json', 'a fresh out dir takes the --only run as verdicts.json');
});

// Breaks if: a --only run overwrites a full run's verdicts.json.
test('a --only run never overwrites a full run file', async () => {
  const a = baseRow();
  const out = tmp();
  mkdirSync(path.join(out, 'verify'), { recursive: true });
  writeFileSync(path.join(out, 'verify', 'verdicts.json'), JSON.stringify({ arm: 'verify', rows: [{ pid: 'keep' }] }));
  const res = await drive([a], { flows: makeFlows([a]), only: [a.pid], out, plan: () => PASS });
  assert.equal(path.basename(res.file), 'verdicts.only.json');
  assert.equal(JSON.parse(readFileSync(path.join(out, 'verify', 'verdicts.json'), 'utf8')).rows[0].pid, 'keep');
});

// Breaks if: an unknown --only pid is ignored, so a typo reads as "nothing to do".
test('--only with a pid that is not in the probe set is a usage error (exit 2)', async () => {
  const a = baseRow();
  const res = await drive([a], { flows: makeFlows([a]), only: ['nope'], plan: () => PASS });
  assert.equal(res.code, 2);
  assert.equal(res.made, 0);
});

// ---------- failure: classify-blocked and flow-less pids ----------

// Breaks if: the driver runs a classify-blocked finding because its flow file exists.
test('a classify-blocked pid is never run even when a flow exists for it', async () => {
  const blocked = baseRow({ blocked: 'mods-host' });
  const res = await drive([blocked], { flows: makeFlows([blocked]), plan: () => FIRE });
  assert.equal(rowOf(res, blocked.pid).verdict, 'blocked:mods-host');
  assert.equal(runs(res.runner.log).length, 0);
  assert.equal(res.runner.log.some((e) => e[0] === 'open'), false);
  assert.equal(rowOf(res, blocked.pid).evidencePath, null);
});

// Breaks if: the no-flow rule swaps: a record the author never ran is blocked:no_flow, or an authored record's gap is not_attempted.
test('no flow: row dir present gives blocked:no_flow, row dir absent gives not_attempted', async () => {
  const a = baseRow({ pid: 'aaaa000000000001', row: 'S9' });
  const b = baseRow({ pid: 'bbbb000000000002', row: 'S9' });
  const c = baseRow({ pid: 'cccc000000000003', row: 'S11' });
  const flows = makeFlows([a, b], { only: [a.pid] });
  const res = await drive([a, b, c], { flows, plan: () => PASS });
  assert.equal(rowOf(res, b.pid).verdict, 'blocked:no_flow');
  assert.equal(rowOf(res, c.pid).verdict, 'not_attempted');
  assert.match(rowOf(res, c.pid).reason, /no authored flow/);
});

// Breaks if: a bad flow reaches the container. Each lint failure is blocked:lint before any env opens.
test('lint failures are blocked:lint with no env: bad yaml, id differs from pid, host profile, unknown key, bad declare', async () => {
  const mk = (n) => baseRow({ pid: `a${n}${n}${n}000000000000` });  // a leading letter: an all-digit pid would parse as a YAML number
  const [yamlBad, idBad, host, extra, declBad, pidBad] = ['1', '2', '3', '4', '5', '6'].map(mk);
  const rows = [yamlBad, idBad, host, extra, declBad, pidBad];
  const flows = makeFlows(rows, {
    yaml: {
      [yamlBad.pid]: 'id: [unclosed',
      [idBad.pid]: flowYaml('other-id-value'),
      [host.pid]: flowYaml(host.pid).replace('profile: container', 'profile: host'),
      [extra.pid]: flowYaml(extra.pid, 'declare: {x: 1}\n'),
    },
    declare: {
      [declBad.pid]: JSON.stringify({ pid: declBad.pid, row: 'S9', fireMatch: '.*', correct: 'x' }),
      [pidBad.pid]: declareJson('ffffffffffffffff', 'S9'),
    },
  });
  const res = await drive(rows, { flows, plan: () => PASS });
  for (const r of rows) assert.equal(rowOf(res, r.pid).verdict, 'blocked:lint', r.pid);
  assert.match(rowOf(res, extra.pid).reason, /unknown key "declare"/);
  assert.match(rowOf(res, host.pid).reason, /profile/);
  assert.match(rowOf(res, declBad.pid).reason, /fireMatch/);
  assert.equal(res.runner.log.some((e) => e[0] === 'open'), false);
});

// Breaks if: a flow with no declare sidecar runs and can fire.
test('a flow without a declare sidecar is not_attempted (G1) and does not run', async () => {
  const a = baseRow();
  const res = await drive([a], { flows: makeFlows([a], { declare: { [a.pid]: null } }), plan: () => FIRE });
  assert.equal(rowOf(res, a.pid).verdict, 'not_attempted');
  assert.match(rowOf(res, a.pid).reason, /declare/);
  assert.equal(runs(res.runner.log).length, 0);
});

// ---------- failure: docker down, lock held, env start fails ----------

// Breaks if: an outage reads as not_attempted/blocked, or the driver opens an env after a failed preflight.
test('preflight fails: every attempted pid is env-down, classify blocks stay, no env opens', async () => {
  const a = baseRow({ pid: 'aaaa000000000001' });
  const b = baseRow({ pid: 'bbbb000000000002', blocked: 'mods-host' });
  const c = baseRow({ pid: 'cccc000000000003' });
  const flows = makeFlows([a, b, c], { only: [a.pid, b.pid] });
  const runner = stubRunner({ docker: null, plan: () => PASS });
  const res = await drive([a, b, c], { flows, runner });
  assert.equal(rowOf(res, a.pid).verdict, 'env-down');
  assert.equal(rowOf(res, b.pid).verdict, 'blocked:mods-host');
  assert.equal(rowOf(res, c.pid).verdict, 'blocked:no_flow');
  assert.equal(rowOf(res, a.pid).newSeverity, 'major');
  assert.equal(runner.log.some((e) => e[0] === 'open'), false);
  assert.equal(res.code, 3);
});

// Breaks if: a held lock lets the driver start an env anyway, or reads as a verdict on the finding.
test('the TREX lock is held: attempted pids are blocked:env-busy and nothing opens', async () => {
  const a = baseRow();
  const runner = stubRunner({ lockHeld: true, plan: () => PASS });
  const res = await drive([a], { flows: makeFlows([a]), runner });
  assert.equal(rowOf(res, a.pid).verdict, 'blocked:env-busy');
  assert.equal(runner.log.some((e) => e[0] === 'open'), false);
  assert.equal(res.code, 3);
});

// Breaks if: a failed env start turns into a verdict about the finding.
test('the head env fails to start: blocked:env-build, severity unchanged', async () => {
  const a = baseRow();
  const runner = stubRunner({ plan: () => PASS, openFails: () => true });
  const res = await drive([a], { flows: makeFlows([a]), runner });
  assert.equal(rowOf(res, a.pid).verdict, 'blocked:env-build');
  assert.equal(rowOf(res, a.pid).newSeverity, 'major');
});

// ---------- the run plan ----------

// Breaks if: head runs fewer than 2 times (G6 cannot agree), the flow keeps retries (x2 becomes up to 4), or a group C finding gets a fix run.
test('a group C finding runs head x2 with retries 0, base x1, and no fix run; reproduced', async () => {
  const a = baseRow();
  const res = await drive([a], { flows: makeFlows([a]), plan: (s) => (s === a.head ? FIRE : PASS) });
  const r = runs(res.runner.log);
  assert.deepEqual(r.map((e) => [e[1], e[2]]), [[a.head, `${a.pid}-h1`], [a.head, `${a.pid}-h2`], [a.mergeBase, `${a.pid}-b1`]]);
  assert.ok(r.every((e) => e[3] === 0), 'retries 0');
  assert.deepEqual(r.map((e) => e[4]), [FILE, FILE, null], 'coverage on at head only');
  const v = rowOf(res, a.pid);
  assert.equal(v.verdict, 'reproduced');
  assert.equal(v.falseConfirm, null);
  assert.equal(v.newSeverity, 'major');
});

// Breaks if: group A loses its fix control, or a fire at the fix SHA is not reported as falseConfirm.
test('a group A finding also runs the fix SHA: a fire there is falseConfirm', async () => {
  const a = baseRow({ group: 'A' });
  const clean = await drive([a], { flows: makeFlows([a]), plan: (s) => (s === a.head ? FIRE : PASS) });
  assert.equal(runs(clean.runner.log).filter((e) => e[1] === a.fix).length, 1);
  assert.equal(rowOf(clean, a.pid).falseConfirm, false);
  const dirty = await drive([a], { flows: makeFlows([a]), plan: (s) => (s === a.mergeBase ? PASS : FIRE) });
  assert.equal(rowOf(dirty, a.pid).falseConfirm, true);
  assert.equal(rowOf(dirty, a.pid).verdict, 'reproduced', 'a false confirm is reported beside the verdict, it does not change it');
});

// Breaks if: the base env is opened for a finding whose head runs all passed (wasted 10+ s per pid; verdict ignores base on a pass).
test('head passes and the cited lines ran: not_reproduced, severity minor, and no base env opens', async () => {
  const a = baseRow();
  const res = await drive([a], { flows: makeFlows([a]), plan: () => PASS });
  const v = rowOf(res, a.pid);
  assert.equal(v.verdict, 'not_reproduced');
  assert.equal(v.newSeverity, 'minor');
  assert.equal(v.newConfidence, 2);
  assert.deepEqual(res.runner.log.filter((e) => e[0] === 'open').map((e) => e[1]), [a.head]);
});

// Breaks if: a pass without coverage of the cited lines counts as not_reproduced (off-path probe).
test('head passes but the cited lines did not run: blocked:no-coverage, severity kept', async () => {
  const a = baseRow();
  const runner = stubRunner({ plan: () => ({ ...PASS, cov: noCov(FILE) }) });
  const res = await drive([a], { flows: makeFlows([a]), runner });
  const v = rowOf(res, a.pid);
  assert.equal(v.verdict, 'blocked:no-coverage');
  assert.equal(v.newSeverity, 'major');
});

// Breaks if: the head runs disagree and the driver still picks a side.
test('head runs that disagree give blocked:disagree', async () => {
  const a = baseRow();
  const runner = stubRunner({ plan: (s, id) => (id.endsWith('-h1') ? FIRE : PASS) });
  const res = await drive([a], { flows: makeFlows([a]), runner });
  assert.equal(rowOf(res, a.pid).verdict, 'blocked:disagree');
});

// Breaks if: a file changed outside /app/.verify/ in a run does not block the verdict (G5).
test('a tampered tree gives blocked:tamper', async () => {
  const a = baseRow();
  const runner = stubRunner({ plan: (s, id) => ({ ...FIRE, tampered: id.endsWith('-h2') ? [FILE] : [] }) });
  const res = await drive([a], { flows: makeFlows([a]), runner });
  assert.equal(rowOf(res, a.pid).verdict, 'blocked:tamper');
});

// Breaks if: base fires the same line and the driver still says reproduced.
test('base fires the same fireMatch: refuted, severity trivial', async () => {
  const a = baseRow();
  const res = await drive([a], { flows: makeFlows([a]), plan: () => FIRE });
  assert.equal(rowOf(res, a.pid).verdict, 'refuted');
  assert.equal(rowOf(res, a.pid).newSeverity, 'trivial');
});

// Fix 4 (critic major 4). Breaks if: the driver does not compute G9(a) at head or does not pass it, so a bad probe that fires on both sides
// (off the cited path, or failing by itself) is scored as a refute.
test('Fix 4: base fires the same line but the probe never reached the cited lines: blocked:broken-probe, not refuted', async () => {
  const a = baseRow();
  const runner = stubRunner({ plan: () => FIRE, cov: noCov });
  const res = await drive([a], { flows: makeFlows([a]), runner });
  assert.equal(rowOf(res, a.pid).verdict, 'blocked:broken-probe');
  assert.equal(rowOf(res, a.pid).newSeverity, 'major', 'a bad probe never lowers the finding');
});

test('Fix 4: base fires the same line and the fail line text is a literal of the probe source: blocked:broken-probe, not refuted', async () => {
  const a = baseRow();
  const yaml = flowYaml(a.pid).replace("console.log('probe');", `console.log('${FIRE_LINE}');`);
  const res = await drive([a], { flows: makeFlows([a], { yaml: { [a.pid]: yaml } }), plan: () => FIRE });
  assert.equal(rowOf(res, a.pid).verdict, 'blocked:broken-probe');
  assert.equal(rowOf(res, a.pid).newSeverity, 'major');
});

// Breaks if: the base run is attempted for new code (the cited file is absent at base), or G9 never runs, or the file is not put back.
test('the cited file is absent at base: no base env, G9 reverts the file (removed), reruns, restores head content', async () => {
  const a = baseRow();
  const files = { [`${a.head}:${a.file}`]: SRC };
  const plan = (s, id) => (id.endsWith('-rv') ? PASS : FIRE);
  const runner = stubRunner({ plan });
  const res = await drive([a], { flows: makeFlows([a]), runner, git: stubGit(files) });
  assert.equal(rowOf(res, a.pid).verdict, 'reproduced_new');
  const log = runner.log;
  assert.equal(log.some((e) => e[0] === 'open' && e[1] === a.mergeBase), false);
  const iRv = log.findIndex((e) => e[0] === 'run' && e[2].endsWith('-rv'));
  assert.ok(iRv > 0);
  assert.deepEqual(log[iRv - 1], ['setFile', a.head, FILE, null], 'the file is removed before the rerun');
  assert.deepEqual(log[iRv + 1], ['setFile', a.head, FILE, SRC.length], 'head content is written back after');
});

// Minor fix. Breaks if: the model's declare.newCode decides whether the base run happens. The harness decides from git ls-tree at the
// merge base: a file that exists there CAN run at base, so the base differential runs whatever the model said.
test('declare.newCode true does not skip the base run when the cited file exists at base', async () => {
  const a = baseRow();
  const flows = makeFlows([a], { declare: { [a.pid]: declareJson(a.pid, a.row, { newCode: true }) } });
  const runner = stubRunner({ plan: (s, id) => (s === a.head ? FIRE : PASS) });
  const res = await drive([a], { flows, runner });
  assert.equal(rowOf(res, a.pid).verdict, 'reproduced', 'base ran, passed: a differential reproduction, not reproduced_new');
  assert.ok(runner.log.some((e) => e[0] === 'open' && e[1] === a.mergeBase), 'the base env opened');
  assert.equal(runner.log.some((e) => e[0] === 'setFile'), false, 'no G9 revert when the base can run');
});

// Breaks if: declare.newCode false makes the harness run a base env for a file that is absent at base (the run cannot work), or skips G9.
test('declare.newCode false does not force a base run when the cited file is absent at base: G9 decides', async () => {
  const a = baseRow();
  const flows = makeFlows([a], { declare: { [a.pid]: declareJson(a.pid, a.row, { newCode: false }) } });
  const runner = stubRunner({ plan: (s, id) => (id.endsWith('-rv') ? PASS : FIRE) });
  const res = await drive([a], { flows, runner, git: stubGit({ [`${a.head}:${a.file}`]: SRC }) });
  assert.equal(rowOf(res, a.pid).verdict, 'reproduced_new');
  assert.equal(runner.log.some((e) => e[0] === 'open' && e[1] === a.mergeBase), false);
  assert.ok(runner.log.some((e) => e[0] === 'setFile' && e[2] === FILE));
});

// Breaks if: G9 is skipped, so an unconditional fail on new code scores as reproduced_new.
test('new code whose hunk revert does not change the outcome is unverified', async () => {
  const a = baseRow();
  const res = await drive([a], { flows: makeFlows([a], { declare: { [a.pid]: declareJson(a.pid, a.row, { newCode: true }) } }), plan: () => FIRE, git: stubGit({ [`${a.head}:${a.file}`]: SRC }) });
  assert.equal(rowOf(res, a.pid).verdict, 'unverified');
});

// Breaks if: two envs are open at once (6 GB each; the design allows at most 2 containers) or batching leaves one open.
test('envs open one at a time, per record in order head, base, fix; every opened env is closed', async () => {
  const a = baseRow({ pid: 'aaaa000000000001', group: 'A' });
  const b = baseRow({ pid: 'bbbb000000000002', group: 'A' });
  const c = baseRow({ pid: 'cccc000000000003', row: 'S11', head: sha('4'), mergeBase: sha('5'), fix: sha('6') });
  const rows = [a, b, c];
  const runner = stubRunner({ plan: (s, id) => ((s === sha('1') || s === sha('4')) ? FIRE : PASS) });
  const res = await drive(rows, { flows: makeFlows(rows), runner });
  assert.equal(runner.state.maxOpen, 1);
  assert.equal(runner.state.open, 0);
  const opens = runner.log.filter((e) => e[0] === 'open').map((e) => e[1]);
  assert.deepEqual(opens, [sha('1'), sha('2'), sha('3'), sha('4'), sha('5')], 'S9 (2 findings) shares one env per side; S11 has no fix run');
  assert.equal(res.c2.rows.length, 3);
});

// Breaks if: one pid throwing in the container aborts the record or the run.
test('a run that throws gives that pid blocked:broken-probe and the other pids still finish', async () => {
  const a = baseRow({ pid: 'aaaa000000000001' });
  const b = baseRow({ pid: 'bbbb000000000002' });
  const plan = (s, id) => { if (id.startsWith(a.pid)) throw new Error('docker exec died'); return s === a.head ? FIRE : PASS; };
  const res = await drive([a, b], { flows: makeFlows([a, b]), plan });
  assert.equal(rowOf(res, a.pid).verdict, 'blocked:broken-probe');
  assert.equal(rowOf(res, b.pid).verdict, 'reproduced');
});

// Fix 2 (critic major 2). Breaks if: a failure to start the fix env is swallowed, so a group A hit has falseConfirm null with no reason and
// gate (b) cannot say why it has no data.
test('Fix 2: a fix env that fails to start is recorded in the row as fixError and falseConfirm stays null', async () => {
  const a = baseRow({ group: 'A' });
  const runner = stubRunner({ plan: (s) => (s === a.head ? FIRE : PASS), openFails: (s) => s === a.fix });
  const res = await drive([a], { flows: makeFlows([a]), runner });
  const r = rowOf(res, a.pid);
  assert.equal(r.verdict, 'reproduced', 'the head and base verdict is unchanged');
  assert.equal(r.falseConfirm, null);
  assert.match(r.fixError, /compose create failed/);
});

test('Fix 2: a group A hit with a fix run has a boolean falseConfirm and no fixError', async () => {
  const a = baseRow({ group: 'A' });
  const res = await drive([a], { flows: makeFlows([a]), plan: (s) => (s === a.head ? FIRE : PASS) });
  const r = rowOf(res, a.pid);
  assert.equal(r.falseConfirm, false);
  assert.equal('fixError' in r, false);
  const fired = await drive([a], { flows: makeFlows([a]), plan: () => FIRE });
  assert.equal(rowOf(fired, a.pid).falseConfirm, true, 'the probe fires at the fix SHA too');
});

// ---------- Fix 1: markers and incremental C2 ----------

// Breaks if: a live file has no dryRun false / partial / attemptedPids, so score-arms cannot tell a run from a plan.
test('Fix 1: a full live run says dryRun false, partial false and lists the pids it ran; --only is partial; a dry run says dryRun true', async () => {
  const a = baseRow({ pid: 'aaaa000000000001' });
  const b = baseRow({ pid: 'bbbb000000000002' });
  const full = await drive([a, b], { flows: makeFlows([a, b]), plan: (s) => (s === a.head ? FIRE : PASS) });
  assert.deepEqual([full.c2.dryRun, full.c2.partial], [false, false]);
  assert.deepEqual([...full.c2.attemptedPids].sort(), [a.pid, b.pid]);
  const only = await drive([a, b], { flows: makeFlows([a, b]), only: [a.pid], plan: () => PASS });
  assert.deepEqual([only.c2.dryRun, only.c2.partial], [false, true]);
  assert.deepEqual(only.c2.attemptedPids, [a.pid]);
  const dry = await drive([a, b], { flows: makeFlows([a, b]), live: false, plan: () => PASS });
  assert.deepEqual([dry.c2.dryRun, dry.c2.attemptedPids], [true, []]);
  assert.match(path.basename(dry.file), /dry-run/);
});

// Minor fix. Breaks if: verdicts.json is written only after the whole run, so a crash on record 2 loses the verdict of record 1.
test('verdicts.json is written after each record (partial true) so a crash keeps the finished verdicts', async () => {
  const a = baseRow({ pid: 'aaaa000000000001', row: 'S9' });
  const b = baseRow({ pid: 'bbbb000000000002', row: 'S11', head: sha('4'), mergeBase: sha('5'), fix: sha('6') });
  const out = tmp();
  const base = stubGit(Object.assign({}, bothSides(a), bothSides(b)));
  const crashing = (args) => { if (args[0] === 'ls-tree' && args[1] === b.head && globalThis.__crashOnB) throw new Error('git blew up'); return base(args); };
  globalThis.__crashOnB = true;
  try {
    await assert.rejects(drive([a, b], { flows: makeFlows([a, b]), out, git: crashing, plan: (s) => (s === a.head || s === b.head ? FIRE : PASS) }), /git blew up/);
  } finally { delete globalThis.__crashOnB; }
  const kept = JSON.parse(readFileSync(path.join(out, 'verify', 'verdicts.json'), 'utf8'));
  assert.equal(kept.partial, true);
  assert.equal(kept.dryRun, false);
  assert.equal(kept.rows.length, 2);
  assert.equal(kept.rows.find((r) => r.pid === a.pid).verdict, 'reproduced', 'record 1 survived the crash');
  assert.equal(kept.rows.find((r) => r.pid === b.pid).verdict, 'not_attempted');
});

// ---------- evidence ----------

// Breaks if: a verdict is saved without the evidence a second reader needs (G7).
test('evidence dir holds the flow, declare, both SHAs, sha256 of the probe bytes, coverage summary, runs, logs path and a rerun command', async () => {
  const a = baseRow();
  const flows = makeFlows([a]);
  const out = tmp();
  const res = await drive([a], { flows, out, plan: (s) => (s === a.head ? FIRE : PASS) });
  const dir = rowOf(res, a.pid).evidencePath;
  assert.equal(path.normalize(dir), path.join(out, 'verify', 'evidence', a.pid));
  assert.deepEqual(readdirSync(dir).sort(), ['coverage.json', 'declare.json', 'flow.yaml', 'rerun.txt', 'runs.json', 'shas.json', 'verdict.json']);
  const flowBytes = readFileSync(path.join(flows, 'S9', `${a.pid}.yaml`));
  const shas = JSON.parse(readFileSync(path.join(dir, 'shas.json'), 'utf8'));
  assert.equal(shas.head, a.head);
  assert.equal(shas.mergeBase, a.mergeBase);
  assert.equal(shas.probeSha256.flow, createHash('sha256').update(flowBytes).digest('hex'));
  assert.deepEqual(readFileSync(path.join(dir, 'flow.yaml')), flowBytes);
  const cov = JSON.parse(readFileSync(path.join(dir, 'coverage.json'), 'utf8'));
  assert.deepEqual([cov.file, cov.startLine, cov.endLine, cov.citedLinesExecuted], [FILE, 10, 12, true]);
  const rerun = readFileSync(path.join(dir, 'rerun.txt'), 'utf8');
  assert.match(rerun, /verify\.mjs --live --flows-dir .* --only aaaa000000000001/);
  const r = JSON.parse(readFileSync(path.join(dir, 'runs.json'), 'utf8'));
  assert.deepEqual(r.map((x) => x.label), ['h1', 'h2', 'b1']);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'verdict.json'), 'utf8')).verdict, 'reproduced');
});

// Breaks if: the C2 row loses a contract key.
test('every C2 row has the contract keys, and the file names the arm and where it came from', async () => {
  const a = baseRow();
  const res = await drive([a], { flows: makeFlows([a]), plan: () => PASS });
  assert.equal(res.c2.arm, 'verify');
  assert.equal(typeof res.c2.generatedFrom, 'string');
  assert.deepEqual(Object.keys(res.c2.rows[0]).sort(), ['evidencePath', 'falseConfirm', 'group', 'newConfidence', 'newSeverity', 'originalConfidence', 'originalSeverity', 'pid', 'reason', 'row', 'verdict']);
});

// ---------- pure helpers ----------

const re = buildFireMatch({ fireMatch: FIRE_MATCH }).re;

// Breaks if: the check text of the flow (author prose) is used as the fail line, so the author's own wording can fake a fire.
test('runFromFlow: a failing flow takes its fail line from the program output, never from check text', () => {
  const steps = [{ code: 0, stdout: 'no match here\n', stderr: '' }];
  const r = runFromFlow({ state: 'fail', checks: [{ text: 'counts 2 outside-diff finding', state: 'failed' }] }, steps, re);
  assert.equal(r.exitClass, 'assert-fail');
  assert.doesNotMatch(r.failLine, re);
  const hit = runFromFlow({ state: 'fail' }, [{ code: 1, stdout: `noise\n${FIRE_LINE}\n`, stderr: '' }], re);
  assert.equal(hit.failLine, FIRE_LINE);
});

// Breaks if: a pass, a timeout, an import error or an incomplete flow maps to the wrong exit class.
test('runFromFlow maps pass, timeout, import error, incomplete and blocked', () => {
  assert.deepEqual(runFromFlow({ state: 'pass' }, [], re), { exitClass: 'pass', failLine: null, normalizedOutput: '' });
  assert.equal(runFromFlow({ state: 'fail' }, [{ code: null, stdout: '', stderr: '', timedOut: true }], re).exitClass, 'broken:timeout');
  assert.equal(runFromFlow({ state: 'fail' }, [{ code: 1, stdout: '', stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/x.mjs'" }], re).exitClass, 'broken:import');
  assert.equal(runFromFlow({ state: 'incomplete', reason: 'start_unreached' }, [], re).exitClass, 'broken:start_unreached');
  assert.equal(runFromFlow({ state: 'blocked', reason: 'oom' }, [], re).exitClass, 'broken:oom');
  assert.equal(runFromFlow({ state: 'flaky' }, [], re).exitClass, 'broken:flaky');
});

// Fix 3 (critic major 3). Breaks if: runFromFlow passes code 0 to runFromStep (so "exit N with no failing line is broken" never fires),
// or matches fireMatch against every output line instead of the TAP "not ok" line. The first expectation is the critic's exact example.
test('runFromFlow: a crash with no "not ok" line is broken, never an assert-fail (G3)', () => {
  const crash = runFromFlow({ state: 'fail' }, [{ code: 1, stdout: '', stderr: 'TypeError: parse returned null\n    at x' }], /returned null/);
  assert.match(crash.exitClass, /^broken:/);
  assert.equal(crash.failLine, null);
  const exit2 = runFromFlow({ state: 'fail' }, [{ code: 2, stdout: 'checking input: scrub left "x" counts 2 outside-diff\n', stderr: '' }], re);
  assert.match(exit2.exitClass, /^broken:/, 'exit 2 with output but no failing line: the check did not run');
});

test('runFromFlow: only the "not ok" line can fire; a diagnostic line that matches fireMatch is not a fire', () => {
  const diag = 'checking input: a notice counts 2 outside-diff finding(s)';
  const noFire = runFromFlow({ state: 'fail' }, [{ code: 1, stdout: `${diag}\nnot ok 1 - parse returned something else\n`, stderr: '' }], re);
  assert.equal(noFire.exitClass, 'assert-fail');
  assert.equal(noFire.failLine, 'not ok 1 - parse returned something else');
  assert.doesNotMatch(noFire.failLine, re, 'the diagnostic line must not be picked as the fire line');
  const fire = runFromFlow({ state: 'fail' }, [{ code: 1, stdout: `${diag}\n${FIRE_LINE}\n`, stderr: '' }], re);
  assert.equal(fire.failLine, FIRE_LINE);
});

// Breaks if: unknown or conflicting arguments are accepted.
test('parseArgs: defaults, --only list, unknown flag throws', () => {
  const o = parseArgs([]);
  assert.equal(o.live, false);
  assert.equal(o.only, null);
  assert.match(o.flowsDir.replaceAll('\\', '/'), /scripts\/trex\/bench\/flows-verify$/);
  assert.match(o.out.replaceAll('\\', '/'), /\.claude\/cache\/e2e\/trex-verify-p1$/);
  assert.deepEqual(parseArgs(['--only', 'a, b,,c']).only, ['a', 'b', 'c']);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.throws(() => parseArgs(['--out']), /needs a value/);
});

// Breaks if: loadFlowDir reads a flow for a pid that is in another record, or hides a stray flow file.
test('loadFlowDir: flows are matched by <row>/<pid>.yaml and strays are listed', () => {
  const a = baseRow();
  const dir = makeFlows([a]);
  writeFileSync(path.join(dir, 'S9', 'zzzz999999999999.yaml'), flowYaml('zzzz999999999999'));
  const l = loadFlowDir(dir, [a]);
  assert.ok(l.byPid.has(a.pid));
  assert.deepEqual(l.strays, ['S9/zzzz999999999999.yaml']);
  assert.ok(l.rowDirs.has('S9'));
});

// ---------- the real runner's ordering ----------

// Breaks if: the coverage is read after the env is stopped (the files are gone), or the tree is not checked for tamper before the next flow.
test('makeLiveRunner: coverage is read and the tree checked before stopEnv; the TREX lock is released', async () => {
  const log = [];
  const env = { exec: async (argv) => { log.push(['exec', argv.slice(0, 2).join(' ')]); return { code: 0, stdout: '', stderr: '' }; } };
  const deps = {
    git: () => ({ status: 0, stdout: '', stderr: '' }), cwd: '.', imageSha: 'f'.repeat(40), evidenceRoot: tmp(),
    ensureImage: async () => ({ tag: 'trex:x' }), startEnv: async (o) => { log.push(['startEnv', o.head, o.flowsDir]); return env; },
    stopEnv: async () => { log.push(['stopEnv']); },
    acquireLock: () => ({ ok: true, release: () => log.push(['unlock']) }), lockFile: 'x',
    runFlows: async (flows, e, d) => { log.push(['runFlows', flows[0].id, d.coverage]); d.writeStep({ flowId: flows[0].id, attempt: 1, step: 1, result: { code: 0, stdout: '', stderr: '' } }); return [{ id: flows[0].id, state: 'pass' }]; },
    loadCoverage: async (exec, id) => { log.push(['loadCoverage', id]); return { v8: [], trace: null, sources: {} }; },
  };
  const runner = makeLiveRunner(deps);
  await runner.withLock(async () => {
    const side = await runner.open({ sha: sha('1'), flows: [], evidenceDir: tmp() });
    const flow = { id: 'aaaa000000000001-h1', limits: { retries: 0 } };
    await side.runFlow(flow, { label: 'h1', evidenceDir: tmp(), coverageFile: FILE });
    await side.runFlow({ ...flow, id: 'aaaa000000000001-b1' }, { label: 'b1', evidenceDir: tmp(), coverageFile: null });
    await side.close();
  });
  const names = log.map((e) => e[0]);
  assert.ok(names.indexOf('loadCoverage') > names.indexOf('runFlows'));
  assert.ok(names.indexOf('loadCoverage') < names.indexOf('stopEnv'));
  assert.equal(names.filter((n) => n === 'loadCoverage').length, 1, 'no coverage read for a run with coverage off');
  assert.equal(log.find((e) => e[0] === 'runFlows')[2].join(','), 'aaaa000000000001-h1', 'coverage is on for this flow id only');
  assert.equal(log.filter((e) => e[0] === 'runFlows')[1][2], false);
  assert.equal(log.find((e) => e[0] === 'startEnv')[2], 'scripts/trex/bench/flows/S9', 'startEnv gets a committed anchor dir, not the flows dir');
  assert.equal(names.at(-1), 'unlock');
});

// Breaks if: a lock held by another run is ignored by the real runner.
test('makeLiveRunner: a held lock throws "lock is held"', async () => {
  const runner = makeLiveRunner({ git: () => ({ status: 0, stdout: '', stderr: '' }), acquireLock: () => ({ ok: false, pid: 7 }), lockFile: 'x', cwd: '.' });
  await assert.rejects(runner.withLock(async () => 1), /lock is held by pid 7/);
});
