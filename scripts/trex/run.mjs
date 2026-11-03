#!/usr/bin/env node
// TREX runner. P0 builds simulate mode; PR mode (--pr, --base) is P1.
//   run.mjs --simulate <sha|tree> [--config <sha>] [--flows-sha <sha>] [--image-sha <sha>] [--flows-dir <dir>]
//           [--flows a,b] [--tree <dir>] [--evidence <dir>] [--json]
//   run.mjs --unlock
// Exit codes: 0 no Fail, 1 Fail, 2 input error, 3 lock held, 4 internal error, 5 no evidence (nothing tested, or a blocker).
// Child output never reaches stdout or stderr: prove-check scans both for broken markers. It stays in the evidence files.

import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGit } from '../github/pre-pr.mjs';
import { resolveBase } from './base.mjs';
import { ensureImage, prepareHost, removeByLabel, startEnv, stopEnv } from './env.mjs';
import { loadFlows } from './flow.mjs';
import { runFlows, strictExec } from './flow-run.mjs';
import { acquireLock, lockPathFor, primaryRootOf, unlockRun } from './lock.mjs';
import { makePidRecorder, runChild } from './lib/proc.mjs';
import { buildReport, exitCodeFor, formatLines, writeAll, writeSidecar } from './report.mjs';

export { acquireLock } from './lock.mjs';
export { foldAttempts, runFlows } from './flow-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VALUE_FLAGS = ['--simulate', '--config', '--flows-sha', '--image-sha', '--flows-dir', '--flows', '--tree', '--evidence', '--pr', '--head', '--base'];
const BOOL_FLAGS = ['--json', '--unlock', '--rerun', '--advisory', '--select-only'];
const TREE_SHA8 = /[\\/]proof[\\/]([0-9a-f]{8})(?:[\\/]|$)/i;
const VERDICTS = Object.freeze({ 0: 'pass', 1: 'fail', 2: 'input_error', 3: 'locked', 4: 'internal_error', 5: 'no_evidence' });
const ENV_TRIES = 2;
const firstLine = (text) => String(text ?? '').trim().split(/\r?\n/)[0];
const slash = (p) => p.replaceAll('\\', '/');

/** A bad command line or bad input. Its message is fixed text that holds no user value. */
export class UsageError extends Error {
  constructor(message, options) { super(message, options); this.name = 'UsageError'; }
}

// ---------- command line ----------

/** @returns {object} opts: { mode: 'simulate'|'unlock'|'pr'|'base', json, simulate, config, flowsSha, imageSha, flowsDir, flows, tree, evidence, ... } */
export function parseArgs(argv) {
  const opts = { json: false, flowsDir: '.trex/flows', flows: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (BOOL_FLAGS.includes(a)) opts[camel(a)] = true;
    else if (VALUE_FLAGS.includes(a)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${a} needs a value`);
      opts[camel(a)] = argv[++i];
    } else throw new UsageError('unknown argument');
  }
  if (typeof opts.flows === 'string') opts.flows = opts.flows.split(',').map((s) => s.trim()).filter(Boolean);
  opts.mode = modeOf(opts);
  return opts;
}

const camel = (flag) => flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());

function modeOf(opts) {
  const modes = ['unlock', 'simulate', 'pr', 'base'].filter((m) => opts[m] !== undefined);
  if (modes.length !== 1) throw new UsageError('give exactly one of --simulate, --pr, --base, --unlock');
  if (opts.selectOnly) throw new UsageError('P1: not built (--select-only)');
  return modes[0];
}

// ---------- inputs ----------

const fullSha = (git, ref) => {
  const r = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (r.status !== 0) throw new UsageError('a SHA or ref does not resolve to a commit');
  return r.stdout.trim();
};

/** The head SHA. `--simulate tree` takes only the sha8 of /proof/<sha8>/ and re-archives that commit (spec 13.1). */
export function resolveHead(git, opts) {
  const fromTree = opts.tree ? TREE_SHA8.exec(opts.tree)?.[1] : null;
  if (opts.simulate === 'tree') {
    if (!fromTree) throw new UsageError('--simulate tree needs --tree <dir> with /proof/<sha8>/ in the path');
    return fullSha(git, fromTree);
  }
  const head = fullSha(git, opts.simulate);
  if (fromTree && !head.startsWith(fromTree.toLowerCase())) throw new UsageError('--tree names another commit than --simulate');
  return head;
}

function resolveShas(git, opts, head) {
  const base = () => {
    try { return resolveBase(git, head); } catch { throw new UsageError('no base: fork/main is missing, pass --config'); }
  };
  const pick = (own) => fullSha(git, own ?? opts.config ?? base());
  return { flowsSha: pick(opts.flowsSha), imageSha: pick(opts.imageSha) };
}

/** Loads the flows of flowsSha and applies --flows. A named flow that does not exist is an input error. */
export function selectFlows(git, flowsSha, opts) {
  let flows;
  try { flows = loadFlows(git, flowsSha, opts.flowsDir); } catch (err) {
    if (err.name === 'FlowError') throw new UsageError(`flow files are invalid (${err.problems.length} file${err.problems.length === 1 ? '' : 's'}); see flow-errors.txt`, { cause: err });
    throw new UsageError('flows cannot be read at the flows SHA', { cause: err });
  }
  if (!opts.flows) return flows;
  const missing = opts.flows.filter((id) => !flows.some((f) => f.id === id));
  if (missing.length > 0) throw new UsageError('a flow named by --flows does not exist at the flows SHA');
  return flows.filter((f) => opts.flows.includes(f.id));
}

// ---------- environment ----------

/** Starts the container environment, up to two tries. Returns { env, image } | { skipped } | { blocker }. */
async function startWithRetry(d, run) {
  let last = null;
  for (let n = 1; n <= ENV_TRIES; n += 1) {
    run.envAttempts = n;
    try {
      const image = await d.ensureImage({ head: run.head, imageSha: run.imageSha, evidenceDir: run.evidenceDir }, d.envDeps);
      const opts = { head: run.head, flowsSha: run.flowsSha, imageSha: run.imageSha, image: image.tag, flows: run.container, flowsDir: run.flowsDir, evidenceDir: run.evidenceDir, runId: run.runId };
      const env = await d.startEnv(opts, d.envDeps);
      return env.skipped ? { skipped: env.skipped } : { env, image };
    } catch (err) {
      last = err;
      d.noteError({ flowId: 'env', attempt: n, err });
    }
  }
  return { blocker: { stage: last?.stage ?? 'start', text: firstLine(last?.message) } };
}

const blockedFlows = (flows, blocker) => flows.map((f) => ({ id: f.id, state: 'blocked', reason: blocker.stage, severity: f.severity, attempts: 0 }));

function fixtureReader(d, run) {
  const dir = run.flowsDir.replace(/\\/g, '/').replace(/\/+$/, '');
  return (rel) => {
    const r = d.git(['show', `${run.flowsSha}:${dir}/${rel}`]);
    return r.status === 0 ? r.stdout : null;
  };
}

function flowDeps(d, run) {
  return { evidenceDir: run.evidenceDir, now: d.now, readFixture: fixtureReader(d, run), noteError: d.noteError, ...run.host };
}

async function runContainer(d, run) {
  const started = await startWithRetry(d, run);
  if (started.skipped) { run.skipped = started.skipped; return; }
  if (started.blocker) { run.blockers.push(started.blocker); run.flows.push(...blockedFlows(run.container, started.blocker)); return; }
  const { env, image } = started;
  Object.assign(run, { imageTag: image.tag, composeProject: env.project, envDigest: env.digest ?? null });
  run.live = env;
  try {
    run.flows.push(...await runFlows(run.container, env, flowDeps(d, run)));
  } finally {
    run.live = null;
    await d.stopEnv(env, d.envDeps);
  }
}

async function runHost(d, run) {
  let prep;
  try { prep = await d.prepareHost({ head: run.head, flowsSha: run.flowsSha, evidenceDir: run.evidenceDir, flowsDir: run.flowsDir }, d.envDeps); } catch (err) {
    d.noteError({ flowId: 'host', attempt: 1, err });
    const blocker = { stage: err.stage ?? 'start', text: firstLine(err.message) };
    run.blockers.push(blocker);
    run.flows.push(...blockedFlows(run.hostFlows, blocker));
    return;
  }
  if (prep.skipped?.reason === 'host_unmerged') {
    run.flows.push(...run.hostFlows.map((f) => ({ id: f.id, state: 'incomplete', reason: 'host_unmerged', severity: f.severity, attempts: 0 })));
    return;
  }
  if (prep.skipped) { run.skipped = prep.skipped; return; }
  const host = { treeDir: prep.treeDir, hostEnv: prep.env, spawn: strictExec(d.hostSpawn(run)) };
  run.flows.push(...await runFlows(run.hostFlows, null, { ...flowDeps(d, run), ...host }));
}

// ---------- the run ----------

function newRun(inputs, evidenceDir, runId) {
  const { flows } = inputs;
  return {
    ...inputs, evidenceDir, runId, flows: [], blockers: [], envAttempts: 0, skipped: null, live: null,
    container: flows.filter((f) => f.profile !== 'host'), hostFlows: flows.filter((f) => f.profile === 'host'), host: {},
    imageTag: null, composeProject: null, envDigest: null,
  };
}

async function executeRun(d, run) {
  const t0 = d.now().getTime();
  if (run.container.length > 0) await runContainer(d, run);
  if (run.hostFlows.length > 0 && !run.skipped) await runHost(d, run);
  run.envSeconds = Math.round((d.now().getTime() - t0) / 1000);
}

function reportOf(d, run, startedAt) {
  return buildReport({
    pr: null, base: null, head: run.head, configSha: run.flowsSha, envDigest: run.envDigest, envAttempts: run.envAttempts || null,
    imageTag: run.imageTag, composeProject: run.composeProject, startedAt, finishedAt: d.now().toISOString(), envSeconds: run.envSeconds ?? null,
    pids: d.pids, flows: run.flows, blockers: run.blockers, skipped: run.skipped ?? (run.flows.length === 0 ? { reason: 'no_config' } : null),
  });
}

const detailFile = (dir, name, text) => {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, name), text); } catch { /* a detail file never changes the exit code */ }
};

// ---------- defaults ----------

function withDefaults(deps) {
  const root = deps.root ?? ROOT;
  const git = deps.git ?? makeGit(root);
  const pids = [];
  const recorder = { onSpawn: (pid) => { pids.push(pid); d.recorder?.onSpawn(pid); deps.onSpawn?.(pid); } };
  const d = {
    root, git, pids, ensureImage, startEnv, stopEnv, prepareHost, removeByLabel, runChild,
    now: () => new Date(), out: console.log, alive: undefined, runId: randomBytes(4).toString('hex'),
    onSigint: (fn) => { process.once('SIGINT', fn); return () => process.off('SIGINT', fn); }, exit: process.exit,
    noteError: () => {}, ...deps,
  };
  // The env module must not install its own SIGINT handler: this file owns lock release and the sidecar.
  d.envDeps = { cwd: root, git, onSpawn: recorder.onSpawn, onSigint: () => () => {}, ...deps.envDeps };
  d.hostSpawn = deps.hostSpawn ?? (() => (argv, o) => d.runChild(argv[0], argv.slice(1), { ...o, onSpawn: recorder.onSpawn }));
  return d;
}

const jsonLine = (code, run, report, evidenceDir) => JSON.stringify({
  pr: null, head: run?.head ?? null, base: null, configSha: run?.flowsSha ?? null, verdict: VERDICTS[code],
  summary: report?.summary ?? null, skipped: report?.skipped ?? null, reportPath: report ? slash(path.join(evidenceDir, 'report.json')) : null,
});

function finish(d, opts, code, run = null, report = null, evidenceDir = null) {
  if (opts?.json) d.out(jsonLine(code, run, report, evidenceDir));
  return code;
}

// ---------- unlock ----------

async function doUnlock(d, opts) {
  const lockFile = lockPathFor(primaryRootOf(d.git, d.root));
  const res = unlockRun(lockFile, { alive: d.alive });
  if (res.state === 'held') { d.out('# trex: lock held by a live run'); return finish(d, opts, 3); }
  if (res.state === 'removed' && res.info?.runId) await d.removeByLabel(res.info.runId, d.envDeps).catch(() => {});
  d.out(`# trex: unlock ${res.state}`);
  return finish(d, opts, 0);
}

// ---------- main ----------

function resolveInputs(d, opts) {
  const head = resolveHead(d.git, opts);
  const { flowsSha, imageSha } = resolveShas(d.git, opts, head);
  const evidence = path.resolve(opts.evidence ?? path.join(d.root, '.claude', 'cache', 'e2e', 'trex', 'sim', head.slice(0, 8)));
  return { head, flowsSha, imageSha, flowsDir: opts.flowsDir, flows: selectFlows(d.git, flowsSha, opts), evidenceDir: evidence };
}

function sidecarFields(d, argv, run, startedAt, exit, finished) {
  return { project: 'trex', command: `node scripts/trex/run.mjs ${argv.join(' ')}`.trim(), exit, started: startedAt, finished, artifact: slash(path.resolve(run.evidenceDir, 'run.log')), head: run.head };
}

/** The run context for one guarded run: paths, clock and the sidecar writer. */
function makeCtx(d, argv, inputs) {
  const startedAt = d.now().toISOString();
  const run = newRun(inputs, inputs.evidenceDir, d.runId);
  const sidecar = path.join(run.evidenceDir, 'run.log.json');
  const write = (exit, finished) => {
    try { writeSidecar(sidecar, sidecarFields(d, argv, run, startedAt, exit, finished)); } catch { /* best effort */ }
  };
  return { run, startedAt, write, command: sidecarFields(d, argv, run, startedAt, null, null).command };
}

/** SIGINT: stop the env, release the lock, record exit 130, leave. The env module installs no handler of its own. */
function interruptHandler(d, c, lock) {
  return async () => {
    try { if (c.run.live) await d.stopEnv(c.run.live, d.envDeps); } finally {
      lock.release();
      c.write(130, d.now().toISOString());
      d.exit(130);
    }
  };
}

function prepareEvidence(d, run) {
  mkdirSync(run.evidenceDir, { recursive: true });
  d.recorder = makePidRecorder(path.join(run.evidenceDir, 'pids.json'));
  const noted = d.noteError;
  d.noteError = (e) => { noted(e); detailFile(run.evidenceDir, `error-${e.flowId}-a${e.attempt}.txt`, `${e.err?.stack ?? e.err}\n`); };
}

async function guardedRun(d, opts, argv, inputs, lock) {
  const c = makeCtx(d, argv, inputs);
  const { run } = c;
  const off = d.onSigint(interruptHandler(d, c, lock));
  try {
    prepareEvidence(d, run);
    c.write(null, null);
    await executeRun(d, run);
    const report = reportOf(d, run, c.startedAt);
    const code = exitCodeFor(report);
    writeAll(run.evidenceDir, report, { project: 'trex', command: c.command, started: c.startedAt, finished: report.finishedAt, head: run.head, exit: code });
    formatLines(report).forEach((line) => d.out(line));
    return finish(d, opts, code, run, report, run.evidenceDir);
  } catch (err) {
    detailFile(run.evidenceDir, 'run-error.txt', `${err?.stack ?? err}\n`);
    c.write(4, d.now().toISOString());
    d.out('# trex: internal error, see run-error.txt');
    return finish(d, opts, 4, run);
  } finally {
    off();
    lock.release();
  }
}

/** Returns an exit code. deps are for tests: git, root, ensureImage, startEnv, stopEnv, prepareHost, removeByLabel, out, now, alive, onSigint, exit. */
export async function main(argv, deps = {}) {
  const d = withDefaults(deps);
  let opts = { json: argv.includes('--json') };
  try {
    opts = parseArgs(argv);
    if (opts.mode === 'pr' || opts.mode === 'base') throw new UsageError('P1: not built');
    if (opts.mode === 'unlock') return await doUnlock(d, opts);
    const inputs = resolveInputs(d, opts);
    const info = { pid: process.pid, started: d.now().toISOString(), argv, runId: d.runId };
    const lock = acquireLock(lockPathFor(primaryRootOf(d.git, d.root)), info, { alive: d.alive });
    if (!lock.ok) { d.out('# trex: another run holds the lock'); return finish(d, opts, 3); }
    return await guardedRun(d, opts, argv, inputs, lock);
  } catch (err) {
    if (!(err instanceof UsageError)) { d.out('# trex: internal error'); return finish(d, opts, 4); }
    if (err.cause?.problems) detailFile(path.resolve(d.root, opts.evidence ?? path.join('.claude', 'cache', 'e2e', 'trex', 'sim')), 'flow-errors.txt', `${err.cause.message}\n`);
    d.out(`# trex: ${err.message}`);
    return finish(d, opts, 2);
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) main(process.argv.slice(2)).then((code) => process.exit(code));
