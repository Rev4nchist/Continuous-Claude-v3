#!/usr/bin/env node
// verify.mjs: the P1 driver of TREX verify. It runs the authored probe flows of the scored findings and writes one verdict file.
// No model is called here. Docker is touched only with --live; without it the driver prints the plan and writes a dry-run file.
//
//   node scripts/trex/verify/verify.mjs [--live] [--flows-dir <dir>] [--out <dir>] [--only <pid,pid>] [--probe-set <file>]
//
// Inputs (contract C1): <flows-dir>/<row>/<pid>.yaml (one TREX flow, id = pid) and <pid>.declare.json
//   {pid, row, fireMatch, correct, citedFile, startLine, endLine, newCode}. The flows dir is read from the working tree, not through git.
// Output (contract C2): <out>/verify/verdicts.json, and per pid <out>/verify/evidence/<pid>/. Default <out> is the primary checkout's
//   .claude/cache/e2e/trex-verify-p1. A dry run writes verdicts.dry-run.json. A --only run never replaces a full verdicts.json
//   (it writes verdicts.only.json then). The file says dryRun (true only for a dry run), partial (true for a --only run, and while a run is
//   unfinished) and attemptedPids (the pids a live run judged). score-arms scores only a live, complete file. verdicts.json is rewritten
//   after every record (partial true until the run ends), so a crash keeps the finished verdicts. A group A row has falseConfirm (a boolean
//   when the fix env ran) or, when the fix env failed, falseConfirm null and fixError.
//
// Per record (all findings of one row share head, merge-base and fix), one env at a time, under the global TREX lock:
//   head env: every flow x2 (retries 0, coverage on for the cited file), then G9 (the cited file put back to base) when base is not reachable
//   base env: x1, only for flows whose head runs all fired and whose cited file exists at the merge base (verdict.mjs ignores base on a pass)
//   fix env:  x1 for group A (eval control: a fire there is falseConfirm)
// The cited range comes from probe-set.json, never from the author's declare file. Whether the base run happens comes from git ls-tree at
// the merge base (the cited file exists there or not), never from the declare's newCode.
// Exit: 0 done, 2 usage, 3 docker down or lock held.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parse } from 'yaml';
import { makeTrexGit } from '../lib/git.mjs';
import { primaryRootOf } from '../lock.mjs';
import { normalizeFlow, validateFlow } from '../flow.mjs';
import { runFlows } from '../flow-run.mjs';
import { writeStepOutput } from '../report.mjs';
import { applyVerdict, buildFireMatch, verdict } from './verdict.mjs';
import { loadContainerCoverage, makeCoverage } from './coverage.mjs';
import { hunkRevertChanged, normalizeOutput, observedValue, runFromStep, tamperedFiles } from './evidence.mjs';
import { dockerUp, mergeCov, refHas, restoreTree, uniqueTampered, verdictInputFor, writeText } from './adversarial.mjs';
import { realContainerDeps, withTrexLock } from './oracle0-container.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
export const DEFAULT_FLOWS_DIR = path.join(REPO, 'scripts', 'trex', 'bench', 'flows-verify');
/** startEnv needs a committed flows dir with grading files, or it skips with no_config. This one exists at every image SHA (adversarial.mjs uses it too). */
export const ANCHOR_FLOWS_DIR = 'scripts/trex/bench/flows/S9';
const PROBE_SET = path.join(HERE, 'probe-set.json');
const HEAD_RUNS = ['h1', 'h2'];
const NO_ENV_REASON = Object.freeze({ 'env-busy': 'the TREX run lock is held by another run', 'env-build': 'the environment did not start' });

export class UsageError extends Error {}

// ---------- command line ----------

const defaultOut = () => path.join(primaryRootOf(makeTrexGit(REPO), REPO), '.claude', 'cache', 'e2e', 'trex-verify-p1');

/** @returns {{ live: boolean, flowsDir: string, out: string, only: string[]|null, probeSet: string }} */
export function parseArgs(argv) {
  const o = { live: false, flowsDir: DEFAULT_FLOWS_DIR, out: null, only: null, probeSet: PROBE_SET };
  const value = { '--flows-dir': 'flowsDir', '--out': 'out', '--only': 'only', '--probe-set': 'probeSet' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--live') o.live = true;
    else if (value[a]) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${a} needs a value`);
      o[value[a]] = argv[++i];
    } else throw new UsageError(`unknown argument ${a}`);
  }
  if (typeof o.only === 'string') o.only = o.only.split(',').map((s) => s.trim()).filter(Boolean);
  o.flowsDir = path.resolve(o.flowsDir);
  o.out = path.resolve(o.out ?? defaultOut());
  return o;
}

// ---------- flow files (pure over the files it reads) ----------

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const readOptional = (file) => (existsSync(file) ? readFileSync(file) : null);
const oneLine = (e) => String(e?.message ?? e).split('\n')[0];

function lintFlow(e) {
  let value;
  try { value = parse(e.flowText); } catch (err) { return { problems: [`YAML error: ${oneLine(err)}`] }; }
  const problems = validateFlow(value);
  if (problems.length > 0) return { problems };
  const flow = normalizeFlow(value);
  if (flow.id !== e.pid) problems.push(`flow id "${flow.id}" must equal the pid "${e.pid}"`);
  if (flow.profile !== 'container') problems.push(`profile must be container, got "${flow.profile}" (a host flow would run on this machine)`);
  return { flow, problems };
}

function lintDeclare(e) {
  if (e.declareText === null) return { declare: null, problems: [] };
  let declare;
  try { declare = JSON.parse(e.declareText); } catch (err) { return { declare: null, problems: [`declare.json is not valid JSON: ${oneLine(err)}`] }; }
  if (declare === null || typeof declare !== 'object' || Array.isArray(declare)) return { declare: null, problems: ['declare.json must be an object'] };
  const problems = [];
  if (declare.pid !== e.pid) problems.push(`declare.pid "${declare.pid}" must equal the pid "${e.pid}"`);
  if (declare.row !== e.row) problems.push(`declare.row "${declare.row}" must equal the row "${e.row}"`);
  return { declare, problems };
}

function readEntry(dir, row, pid, name) {
  const flowBytes = readFileSync(path.join(dir, name));
  const declareBytes = readOptional(path.join(dir, `${pid}.declare.json`));
  const e = { pid, row, dir, flowBytes, flowText: flowBytes.toString('utf8'), declareBytes, declareText: declareBytes ? declareBytes.toString('utf8') : null };
  const f = lintFlow(e);
  const d = lintDeclare(e);
  return { ...e, flow: f.flow ?? null, declare: d.declare, problems: [...f.problems, ...d.problems] };
}

/**
 * Reads <flowsDir>/<row>/<pid>.yaml for every probe-set row. A file whose name is not a pid of that row is a stray.
 * @returns {{ byPid: Map<string, object>, rowDirs: Set<string>, strays: string[] }}
 */
export function loadFlowDir(flowsDir, rows) {
  const byPid = new Map();
  const rowDirs = new Set();
  const strays = [];
  for (const row of [...new Set(rows.map((r) => r.row))]) {
    const dir = path.join(flowsDir, row);
    if (!isDir(dir)) continue;
    rowDirs.add(row);
    const pids = new Set(rows.filter((r) => r.row === row).map((r) => r.pid));
    for (const name of readdirSync(dir).sort()) {
      const m = /^(.+)\.ya?ml$/.exec(name);
      if (!m) continue;
      if (pids.has(m[1])) byPid.set(m[1], readEntry(dir, row, m[1], name));
      else strays.push(`${row}/${name}`);
    }
  }
  return { byPid, rowDirs, strays };
}

/** A fixture reader for flows that use start.stamp: reads under the row's flows folder only. */
const fixtureReader = (dir) => (rel) => {
  const file = path.resolve(dir, rel);
  const inside = path.relative(dir, file);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  try { return readFileSync(file, 'utf8'); } catch { return null; }
};

// ---------- one flow run as a verdict.mjs Run (pure) ----------

const NO_FIRE_LINE = 'flow failed: a check was not met';

/**
 * The verdict.mjs Run of one flow attempt. The fail line is a line of the program's own output that matches the declared fireMatch.
 * Check text is author prose and is never used: it could carry the declared words and fake a fire.
 * An import or compile error in the output, a timeout, an unfinished flow and a flaky one are broken, never a fire.
 */
export function runFromFlow(entry, steps, _re) {
  const state = entry?.state;
  if (state === 'pass') return { exitClass: 'pass', failLine: null, normalizedOutput: '' };
  if (state !== 'fail') return { exitClass: `broken:${entry?.reason ?? state ?? 'unknown'}`, failLine: null, normalizedOutput: '' };
  if ((steps ?? []).some((s) => s.timedOut === true)) return { exitClass: 'broken:timeout', failLine: null, normalizedOutput: '' };
  // G3: the real step code goes to prove-check's classifier, so "exit N with no failing line" and a crash marker are broken.
  const marked = (steps ?? []).map((s) => runFromStep({ code: s.code ?? null, stdout: s.stdout, stderr: s.stderr, timedOut: s.timedOut }));
  const broken = marked.find((m) => m.exitClass.startsWith('broken:'));
  if (broken) return broken;
  // The fire line is the failing line classifyRun returns (the TAP "not ok" line), never another line of the output.
  const fire = marked.find((m) => m.exitClass === 'assert-fail');
  const failLine = fire?.failLine ?? NO_FIRE_LINE;
  return { exitClass: 'assert-fail', failLine, normalizedOutput: normalizeOutput(failLine) };
}

const fires = (run, re) => run?.exitClass === 'assert-fail' && re.test(String(run.failLine ?? ''));

// ---------- results and C2 rows ----------

const pre = (v, rule, reason) => ({ verdict: v, rule, reason, false_confirm: false, priorOpen: false });

function c2Row(row, result, { evidencePath = null, control = false, fixError = null } = {}) {
  const next = applyVerdict({ severity: row.severity, confidence: row.confidence }, result);
  return {
    pid: row.pid, row: row.row, group: row.group, verdict: result.verdict, reason: result.reason,
    originalSeverity: row.severity, originalConfidence: row.confidence, newSeverity: next.severity, newConfidence: next.confidence,
    falseConfirm: control ? result.false_confirm : null, evidencePath, ...(fixError ? { fixError } : {}),
  };
}

/** The result for a pid that needs no run, or { item } for one that does. */
function planOne(row, { loaded, selected }) {
  if (row.blocked) return { result: verdict({ classifyBlock: row.blocked }) };
  if (selected && !selected.has(row.pid)) return { result: pre('not_attempted', 'plan', 'not selected (--only)') };
  const e = loaded.byPid.get(row.pid);
  if (!e) {
    return loaded.rowDirs.has(row.row)
      ? { result: pre('blocked:no_flow', 'no_flow', `the author run for ${row.row} produced no flow for this finding`) }
      : { result: pre('not_attempted', 'plan', `no authored flow for record ${row.row}`) };
  }
  if (e.problems.length > 0) return { result: pre('blocked:lint', 'lint', e.problems.join('; ')) };
  if (e.declare === null) return { result: pre('not_attempted', 'G1', 'no declare sidecar for the flow') };
  const fire = buildFireMatch(e.declare);
  if (!fire.ok) return { result: pre('blocked:lint', 'G2', `fireMatch rejected: ${fire.reason} (${fire.detail})`) };
  return { item: { row, pid: row.pid, entry: e, flow: e.flow, declare: e.declare, fire, newCode: e.declare.newCode === true, baseReachable: true, ev: null } };
}

// ---------- container side, per record ----------

async function runOne(side, item, label, { coverageFile = null, logsDir }) {
  const flow = { ...item.flow, id: `${item.pid}-${label}`, limits: { ...item.flow.limits, retries: 0 } };
  try {
    const r = await side.runFlow(flow, { label, evidenceDir: logsDir, coverageFile, readFixture: fixtureReader(item.entry.dir) });
    return { label, flowId: flow.id, state: r.entry.state, run: runFromFlow(r.entry, r.steps, item.fire.re), tampered: r.tampered ?? [], cov: r.cov ?? null, wallMs: r.wallMs ?? null };
  } catch (e) {
    return { label, flowId: flow.id, state: 'error', run: { exitClass: 'broken:error', failLine: null, normalizedOutput: '' }, tampered: [], cov: null, wallMs: null, error: oneLine(e) };
  }
}

const sidesDone = (item) => (item.ev.headRuns.length === HEAD_RUNS.length && item.ev.headRuns.every((r) => fires(r, item.fire.re)));

function citedExecuted(item, covs) {
  const { startLine, endLine, file } = item.row;
  if (covs.length === 0 || !Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  try { return makeCoverage(mergeCov(covs)).citedLinesExecuted(file, startLine, endLine); } catch { return null; }
}

/** G9: the cited file put back to its base content (or removed), the flow run again, head content written back. */
async function g9Evidence(side, item, git, logsDir) {
  const { file, mergeBase, head } = item.row;
  const first = item.ev.headRuns[0];
  const baseText = git(['show', `${mergeBase}:${file}`]);
  const headText = git(['show', `${head}:${file}`]);
  if (headText.status !== 0) return null;
  await side.setFile(file, baseText.status === 0 ? baseText.stdout : null);
  let reverted;
  try { reverted = await runOne(side, item, 'rv', { logsDir }); } finally { await side.setFile(file, headText.stdout); }
  item.ev.runs.push({ ...runRecord(reverted, 'head'), note: 'cited file at base content' });
  return { observedValue: observedValue(first.failLine, item.fire.source, item.entry.flowText), hunkRevertChanged: hunkRevertChanged(first, reverted.run) };
}

function runRecord(r, side) {
  return { label: r.label, side, flowId: r.flowId, state: r.state, exitClass: r.run.exitClass, failLine: r.run.failLine, wallMs: r.wallMs, tampered: r.tampered, ...(r.error ? { error: r.error } : {}) };
}

async function headPhase(side, items, git) {
  for (const item of items) {
    const { ev } = item;
    const covs = [];
    for (const label of HEAD_RUNS) {
      const r = await runOne(side, item, label, { coverageFile: item.row.file, logsDir: item.logsDir });
      ev.runs.push(runRecord(r, 'head'));
      ev.headRuns.push(r.run);
      if (r.cov) covs.push(r.cov);
      ev.tampered.push(...r.tampered);
    }
    ev.cited = citedExecuted(item, covs);
    // G9(a) at head for every fired item: a refute from "base fires the same line" needs it, as well as new code.
    ev.observedValue = sidesDone(item) && observedValue(ev.headRuns[0].failLine, item.fire.source, item.entry.flowText);
    ev.covRuns = covs.map((c) => ({ v8Scripts: c.v8.length, traceBytes: (c.trace ?? '').length }));
    if (!ev.baseReachable && sidesDone(item)) ev.g9 = await g9Evidence(side, item, git, item.logsDir);
  }
}

async function singlePhase(side, items, label, key, sideName) {
  for (const item of items) {
    const r = await runOne(side, item, label, { logsDir: item.logsDir });
    item.ev.runs.push(runRecord(r, sideName));
    item.ev[key] = r.run;
  }
}

async function withSide(runner, spec, fn) {
  const side = await runner.open(spec);
  try { return await fn(side); } finally { await side.close().catch(() => {}); }
}

const flowsOf = (items) => items.map((i) => i.flow);

async function sidePhase(runner, ctx, sha, items, tag, fn) {
  const evidenceDir = path.join(ctx.workDir, `${items[0].row.row}-${tag}-${sha.slice(0, 8)}`);
  mkdirSync(evidenceDir, { recursive: true });
  await withSide(runner, { sha, flows: flowsOf(items), evidenceDir }, fn);
}

/** Marks items with a failed env as a block. A failed start while docker answers is env-build; while docker is silent it is env-down. */
async function envFailure(runner, err) {
  const up = await runner.preflight().catch(() => null);
  return up ? pre('blocked:env-build', 'env', `${NO_ENV_REASON['env-build']}: ${oneLine(err)}`) : verdict({ dockerOk: false });
}

async function verifyRecord(runner, ctx, items) {
  const { git } = ctx;
  const row = items[0].row;
  for (const item of items) {
    const base = item.baseReachable;
    item.logsDir = path.join(ctx.evidenceRoot, item.pid, 'logs');
    item.ev = { runs: [], headRuns: [], tampered: [], cited: null, observedValue: false, fixError: null, covRuns: [], g9: null, baseRun: null, fixRun: null, baseReachable: base, citedPathExists: refHas(git, row.head, item.row.file) };
  }
  try { await sidePhase(runner, ctx, row.head, items, 'head', (side) => headPhase(side, items, git)); } catch (err) {
    const blocked = await envFailure(runner, err);
    for (const item of items) item.forced = blocked;
    return;
  }
  const needBase = items.filter((i) => i.ev.baseReachable && sidesDone(i));
  if (needBase.length > 0) {
    try { await sidePhase(runner, ctx, row.mergeBase, needBase, 'base', (side) => singlePhase(side, needBase, 'b1', 'baseRun', 'base')); } catch (err) {
      const blocked = await envFailure(runner, err);
      for (const item of needBase) item.forced = blocked;
    }
  }
  const control = items.filter((i) => i.row.group === 'A' && i.row.fix);
  if (control.length > 0) {
    try { await sidePhase(runner, ctx, row.fix, control, 'fix', (side) => singlePhase(side, control, 'f1', 'fixRun', 'fix')); } catch (err) {
      // No control run: falseConfirm stays null and the row says why, so gate (b) can name the missing fix run.
      for (const item of control) item.ev.fixError = `fix env ${String(row.fix).slice(0, 8)}: ${oneLine(err)}`;
    }
  }
}

function finalize(item) {
  if (item.forced) return item.forced;
  const { ev } = item;
  return verdict(verdictInputFor(
    { declare: item.declare, declaredBeforeFirstRun: true },
    { headRuns: ev.headRuns, baseRun: ev.baseRun, fixRun: ev.fixRun, baseReachable: ev.baseReachable, cited: ev.cited, observedValue: ev.observedValue, g9: ev.g9, tamper: ev.tampered.length > 0, citedPathExists: ev.citedPathExists, dockerOk: true },
  ));
}

// ---------- evidence ----------

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const slash = (p) => p.replaceAll('\\', '/');
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

function writeEvidence(ctx, item, result) {
  const dir = path.join(ctx.evidenceRoot, item.pid);
  mkdirSync(dir, { recursive: true });
  const { ev, row, entry } = item;
  writeFileSync(path.join(dir, 'flow.yaml'), entry.flowBytes);
  writeFileSync(path.join(dir, 'declare.json'), entry.declareBytes);
  writeFileSync(path.join(dir, 'runs.json'), json(ev.runs));
  writeFileSync(path.join(dir, 'coverage.json'), json({ file: row.file, startLine: row.startLine, endLine: row.endLine, citedLinesExecuted: ev.cited, runs: ev.covRuns }));
  writeFileSync(path.join(dir, 'shas.json'), json({
    head: row.head, mergeBase: row.mergeBase, fix: row.fix ?? null, baseReachable: ev.baseReachable, newCode: item.newCode, tamperedFiles: uniqueTampered([{ tampered: ev.tampered }]),
    probeSha256: { flow: sha256(entry.flowBytes), declare: sha256(entry.declareBytes) },
  }));
  writeFileSync(path.join(dir, 'verdict.json'), json({ pid: item.pid, row: row.row, group: row.group, ...result, g9: ev.g9, baseReachable: ev.baseReachable, citedPathExists: ev.citedPathExists }));
  writeFileSync(path.join(dir, 'rerun.txt'), `${ctx.rerun(item.pid)}\n`);
  return dir;
}

// ---------- the run ----------

/** Records of the selected, runnable items: one batch per probe-set row. */
function batches(items) {
  const by = new Map();
  for (const i of items) by.set(i.row.row, [...(by.get(i.row.row) ?? []), i]);
  return [...by.values()];
}

async function runLive(deps, ctx, items, results, { attempted, onProgress }) {
  const runner = deps.makeRunner(ctx.git);
  const docker = await runner.preflight().catch(() => null);
  if (!docker) {
    for (const item of items) results.set(item.pid, { result: verdict({ dockerOk: false }) });
    return { docker: null, code: 3 };
  }
  try {
    await runner.withLock(async () => {
      for (const batch of batches(items)) {
        await verifyRecord(runner, ctx, batch);
        for (const item of batch) {
          const result = finalize(item);
          const evidencePath = item.ev.runs.length > 0 ? slash(writeEvidence(ctx, item, result)) : null;
          results.set(item.pid, { result, evidencePath, control: item.row.group === 'A' && item.ev.fixRun !== null, fixError: item.ev.fixError });
          attempted.add(item.pid);
        }
        onProgress();
      }
    });
  } catch (err) {
    if (!/lock is held/.test(String(err.message))) throw err;
    for (const item of items) if (!attempted.has(item.pid)) results.set(item.pid, { result: pre('blocked:env-busy', 'env', `${NO_ENV_REASON['env-busy']}: ${oneLine(err)}`) });
    return { docker, code: 3 };
  }
  return { docker, code: 0 };
}

function planLines(items) {
  const lines = [];
  for (const batch of batches(items)) {
    const r = batch[0].row;
    const base = batch.filter((i) => i.baseReachable).length;
    lines.push(`plan ${r.row}: head env ${r.head.slice(0, 8)} (${batch.length} flow(s) x2), base env ${r.mergeBase.slice(0, 8)} for those that fire (${base} with the cited file at the merge base)${batch.some((i) => i.row.group === 'A') ? `, fix env ${String(r.fix).slice(0, 8)}` : ''}`);
  }
  return lines;
}

/**
 * Plans every probe-set row, runs the runnable ones when live, and returns one C2 row per probe-set pid.
 * deps: { git, makeRunner(git) }. opts: { rows, flowsDir, out, only, live }.
 */
export async function runVerify(deps, opts) {
  const { rows, flowsDir, out, only, live, onProgress = () => {} } = opts;
  const loaded = loadFlowDir(flowsDir, rows);
  const selected = only ? new Set(only) : null;
  const results = new Map();
  const items = [];
  for (const row of rows) {
    const p = planOne(row, { loaded, selected });
    if (p.item) { p.item.baseReachable = refHas(deps.git, row.mergeBase, row.file); items.push(p.item); } else results.set(row.pid, { result: p.result });
  }
  const ctx = {
    git: deps.git, workDir: path.join(out, 'verify', 'work'), evidenceRoot: path.join(out, 'verify', 'evidence'),
    rerun: (pid) => `node scripts/trex/verify/verify.mjs --live --flows-dir ${slash(flowsDir)} --only ${pid} --out ${slash(out)}`,
  };
  const attempted = new Set();
  const c2Rows = () => rows.map((r) => { const x = results.get(r.pid); return c2Row(r, x.result, { evidencePath: x.evidencePath ?? null, control: x.control === true, fixError: x.fixError ?? null }); });
  let live_ = { docker: null, code: 0 };
  if (live && items.length > 0) {
    for (const item of items) results.set(item.pid, { result: pre('not_attempted', 'plan', 'not run yet: the run is unfinished') });
    live_ = await runLive(deps, ctx, items, results, { attempted, onProgress: () => onProgress({ rows: c2Rows(), attemptedPids: [...attempted], docker: live_.docker }) });
  } else for (const item of items) results.set(item.pid, { result: pre('not_attempted', 'plan', live ? 'nothing to run' : 'dry run: pass --live to run this flow') });
  return { rows: c2Rows(), attemptedPids: [...attempted], plan: planLines(items), strays: loaded.strays, docker: live_.docker, code: live_.code };
}

// ---------- the real container side ----------

/**
 * The container side of the driver. deps: realContainerDeps(...) plus git. Tests inject runFlows and loadCoverage.
 * runFlow reads the coverage and checks the tree for tamper BEFORE the env is stopped (close).
 */
export function makeLiveRunner(deps) {
  const d = { runFlows, loadCoverage: loadContainerCoverage, ...deps };
  return {
    preflight: () => dockerUp(d),
    withLock: (fn) => withTrexLock(d, fn),
    async open({ sha, flows, evidenceDir }) {
      const image = await d.ensureImage({ head: sha, imageSha: d.imageSha, evidenceDir }, { cwd: d.cwd });
      const env = await d.startEnv({ head: sha, flowsSha: d.imageSha, imageSha: d.imageSha, image: image.tag, flows, flowsDir: ANCHOR_FLOWS_DIR, evidenceDir, runId: randomBytes(4).toString('hex') }, { cwd: d.cwd });
      if (env.skipped) throw new Error(`environment skipped: ${JSON.stringify(env.skipped)}`);
      return liveSide(d, env);
    },
  };
}

function liveSide(d, env) {
  return {
    async runFlow(flow, { evidenceDir, coverageFile, readFixture }) {
      const steps = [];
      const deps = {
        evidenceDir, now: () => new Date(), readFixture: readFixture ?? (() => null), coverage: coverageFile ? [flow.id] : false,
        writeStep: (a) => { steps.push(a.result); return writeStepOutput(evidenceDir, a); },
      };
      const t0 = performance.now();
      const [entry] = await d.runFlows([flow], env, deps);
      const wallMs = Math.round(performance.now() - t0);
      const status = await env.exec(['git', 'status', '--porcelain'], { cwd: '.', timeoutSec: 60 });
      const tampered = tamperedFiles(status.stdout);
      if (tampered.length > 0) await restoreTree(env);
      const cov = coverageFile ? await d.loadCoverage(env.exec, flow.id, [coverageFile]) : null;
      return { entry, steps, tampered, cov, wallMs };
    },
    async setFile(rel, text) {
      if (rel.split('/').includes('..') || path.isAbsolute(rel)) throw new Error(`unsafe path ${rel}`);
      const target = `/app/${rel}`;
      if (text === null) await env.exec(['rm', '-f', '--', target], { cwd: '.', timeoutSec: 30 });
      else await writeText(env, target, text);
    },
    close: () => d.stopEnv(env, { cwd: d.cwd }),
  };
}

// ---------- main ----------

const readRows = (file) => JSON.parse(readFileSync(file, 'utf8')).rows;

/** A --only run must not replace a full verdicts file. A dry run has its own name. */
function outFileFor(out, { dry, partial }) {
  const dir = path.join(out, 'verify');
  if (dry) return path.join(dir, 'verdicts.dry-run.json');
  const full = path.join(dir, 'verdicts.json');
  if (!partial || !existsSync(full)) return full;
  try { return JSON.parse(readFileSync(full, 'utf8')).partial === true ? full : path.join(dir, 'verdicts.only.json'); } catch { return path.join(dir, 'verdicts.only.json'); }
}

const countBy = (rows) => rows.reduce((m, r) => ({ ...m, [r.verdict]: (m[r.verdict] ?? 0) + 1 }), {});

export async function main(argv, deps = {}) {
  const d = { out: console.log, git: makeTrexGit(REPO), makeRunner: (git) => makeLiveRunner({ ...realContainerDeps(git, REPO), git }), ...deps };
  let opts;
  try { opts = parseArgs(argv); } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    d.out(`# verify: ${err.message}`);
    return 2;
  }
  const rows = d.rows ?? readRows(opts.probeSet);
  const unknown = (opts.only ?? []).filter((p) => !rows.some((r) => r.pid === p));
  if (unknown.length > 0) { d.out(`# verify: --only names pids that are not in the probe set: ${unknown.join(', ')}`); return 2; }
  const dry = !opts.live;
  const partial = opts.only !== null;
  const head = d.git(['rev-parse', 'HEAD']).stdout.trim().slice(0, 8) || 'unknown';
  const file = outFileFor(opts.out, { dry, partial });
  mkdirSync(path.dirname(file), { recursive: true });
  const generatedFrom = `verify.mjs ${dry ? 'dry run' : 'live'}, flows ${slash(opts.flowsDir)}, ${rows.length} probe-set rows, repo ${head}${partial ? `, --only ${opts.only.length} pid(s)` : ''}`;
  const write = (body, isPartial) => writeFileSync(file, json({ arm: 'verify', generatedFrom, partial: isPartial, dryRun: dry, attemptedPids: body.attemptedPids, docker: body.docker ?? null, strayFlows: body.strays ?? [], rows: body.rows }));
  // After every record the file is rewritten as partial, so a crash in a later record keeps the verdicts already made.
  const res = await runVerify(d, { ...opts, rows, onProgress: (p) => write(p, true) });
  write(res, partial);
  for (const l of res.plan) d.out(l);
  if (dry) d.out('# verify: dry run, no Docker and no model were touched. Pass --live to run the flows.');
  d.out(`# verify: ${res.rows.length} rows ${JSON.stringify(countBy(res.rows))}`);
  d.out(`# verify: wrote ${slash(file)}`);
  return res.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => process.exit(c));
