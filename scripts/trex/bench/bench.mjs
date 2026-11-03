#!/usr/bin/env node
/**
 * bench.mjs: the TREX P0 replay bench (spec 5.14, 7, 13.1, 13.3; bench spec 5, 6; S17 "report both", Dave 2026-11-03).
 *
 *   node scripts/trex/bench/bench.mjs --rows S18,S8,S3 --repeats 1          smoke: positives only, no negatives
 *   node scripts/trex/bench/bench.mjs [--repeats 3]                          full: every row, the negatives and S17
 *   node scripts/trex/bench/bench.mjs --plan [--rows ...]                    print rows, hours and image tags; run nothing
 *   options: [--arm grok|composer|composer2|xhigh|grok2] [--frozen <file>] [--image-sha <ref>] [--negatives] [--proofs <file>] [--out <dir>]
 *
 * Exit codes: 0 the bench ran (the verdict is data), 2 refused by preflight or bad input, 4 internal error.
 * Every world call (git, Docker, prove-check, run.mjs, the process table) goes through `deps`, so tests run with fakes.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidAlive } from '../../github/lib/file-lock.mjs';
import { killTree, processChildren } from '../../github/lib/proc.mjs';
import { EST_BUILD_SEC, imageExists, imageTagsFor, isMerged, projectName, removeByLabel } from '../env.mjs';
import { loadFlows } from '../flow.mjs';
import { acquireLock, lockPathFor, primaryRootOf } from '../lock.mjs';
import { makeTrexGit } from '../lib/git.mjs';
import { dockerBin, makePidRecorder, processStartMs, runChild } from '../lib/proc.mjs';
import { stripEnv } from '../lib/strip-env.mjs';
import { writeSidecar } from '../report.mjs';
import { matchGlob } from '../../github/review-router.mjs';
import { ARMS, ARM_NAMES, AUDITED, BLIND, GROUPS, inputBlob } from './author.mjs';
import { isFlaky, pct, rowCaught, s17Grade, stopRule, wilson } from './metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BENCH_DIR = 'scripts/trex/bench';
const REF = 'fork/main';
/** ~130 side-runs take ~15 h (spec 7): about 7 minutes for each. */
export const EST_SIDE_MIN = 7;
export const FULL_N = 15;
export const DEFAULT_CLAIM = 'handle|0x10000|16384|16k';
const ROW_TIMEOUT_MS = 900000;
const CLEAN_MS = 300_000;
const CATCH_ID = /^S(?:[1-9]|1[0-5])$/;
const SKIP_COPY = new Set(['host-tree', 'build-ctx']);
const HARNESS_VERDICTS = new Set(['broken', 'fix-unproven']);
const HAND_NOTE = 'The hand rule was written after reading the S17 answer, whose goal says "clears inheritable pipe handles" and matches the regex with no word boundary, while its cannotVerify names the 0x10000 limit.';

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const slash = (p) => p.replaceAll('\\', '/');
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

// ---------- env ----------

/** The env of every bench child: no Anthropic credential, no CLAUDE_CODE_ key, and TREX_BENCH_RUN (spec 5.14). */
export function childEnv(env = process.env, runId) {
  return { ...stripEnv(env), TREX_BENCH_RUN: runId };
}

// ---------- grading ----------

const failIds = (report) => (report?.flows ?? []).filter((f) => f.state === 'fail').map((f) => f.id);

/** True when a failing flow has a `paths` entry that matches a defect file (the answer key, used for grading only). */
export function attributeFire(notOkIds, flows, defectFiles) {
  const hits = (f) => (f.paths ?? []).some((p) => defectFiles.some((d) => p === d || matchGlob(p, d)));
  return flows.some((f) => notOkIds.includes(f.id) && hits(f));
}

/** The fix run proves a clean fix only when it tested flows, had no blocker and every flow passed. */
function fixClean(report) {
  if (!report || report.summary?.tested === 0 || (report.blockers ?? []).length > 0) return false;
  return (report.flows ?? []).length > 0 && report.flows.every((f) => f.state === 'pass');
}

const soft = (row, verdict) => (row?.bench?.phase === 'P2' && verdict === 'broken' ? 'miss' : verdict);

/**
 * prove: one row of the prove-check JSON. preReport / fixReport: the report.json of each side. flows: the group's frozen flows.
 * Order (pinned by tests): setup error or broken pre -> broken; a fail at fix -> false-fail; no fire at pre -> miss;
 * a fix run that is blocked, incomplete, flaky or empty -> fix-unproven; a fire from an unrelated flow -> fire-unattributed; else caught.
 */
export function gradePositive(prove, preReport, fixReport, row, flows) {
  if (!prove || prove.setupError || !prove.pre || !prove.fix) return soft(row, 'broken');
  if (prove.fix.verdict === 'fire' || failIds(fixReport).length > 0) return 'false-fail';
  if (prove.pre.verdict === 'broken') return soft(row, 'broken');
  if (prove.pre.verdict !== 'fire') return 'miss';
  if (!fixClean(fixReport)) return 'fix-unproven';
  return attributeFire(failIds(preReport), flows, row?.bench?.defectFiles ?? []) ? 'caught' : 'fire-unattributed';
}

const NOT_OK = /^not ok /m;
const SUMMARY = /^# trex: tested (\d+) findings (\d+) blockers (\d+)/m;

function summaryOf(run, report) {
  if (report?.summary) return { tested: report.summary.tested, blockers: report.summary.blockers };
  const m = SUMMARY.exec(String(run?.stdout ?? ''));
  return m ? { tested: Number(m[1]), blockers: Number(m[3]) } : { tested: 0, blockers: 0 };
}

function gradeSkipRow(out) {
  const skipped = /^# skipped no_match\s*$/m.test(out);
  return skipped && !NOT_OK.test(out) && !/^ok /m.test(out) ? 'skip-ok' : 'skip-wrong';
}

/**
 * run: { stdout, code } of one run.mjs --simulate. report: its report.json, or null. row: { id, kind? }.
 * A skip row (K1, K2) must print "# skipped no_match" and nothing else. Any other row is clean, false-fail, blocked or untested.
 */
export function gradeNegative(run, report, row) {
  const out = String(run?.stdout ?? '');
  if (row?.kind === 'skip') return gradeSkipRow(out);
  if (NOT_OK.test(out)) return 'false-fail';
  const s = summaryOf(run, report);
  if (run?.code !== 0 && run?.code !== 1) return 'blocked';
  if (s.blockers > 0) return 'blocked';
  return s.tested > 0 ? 'clean' : 'untested';
}

/** The official S17 grade (the regex). s17Grade also gives the hand grade. */
export function gradeHonestSkip(flows, report, claimMatch) {
  return s17Grade({ flows, report }, { claimMatch }).regex;
}

// ---------- the row command ----------

const hasFlag = (cmd, flag) => cmd.includes(flag);

/**
 * The command a bench row runs. It fills the frozen sha and the flows dir of the arm, and adds --flows-sha (the frozen flows) and
 * --image-sha (Dockerfile and grading code, so a T1 fix after the freeze reaches the image: spec 13.3). Keeps any value the row has.
 */
export function effectiveCmd(cmd, { flowsSha, imageSha, flowsDir }) {
  const out = cmd.map((a) => a.replace('<frozen sha>', flowsSha).replace(`${BENCH_DIR}/flows/`, `${flowsDir}/`));
  if (!hasFlag(out, '--flows-sha')) out.push('--flows-sha', flowsSha);
  if (!hasFlag(out, '--image-sha')) out.push('--image-sha', imageSha);
  return out;
}

// ---------- preflight ----------

const shortId = (s) => String(s).slice(0, 12);

function frozenProblems(git, { frozen, flowsDir }) {
  const out = [];
  const status = git(['status', '--porcelain', '--', flowsDir]);
  if (status.status !== 0 || status.stdout.trim() !== '') out.push(`${flowsDir} is dirty or git status failed: commit or discard the changes`);
  const tree = git(['rev-parse', `HEAD:${flowsDir}`]).stdout.trim();
  if (tree !== frozen.flowsTree) out.push(`flows tree ${shortId(tree)} differs from frozen.flowsTree ${shortId(frozen.flowsTree)}`);
  return out;
}

function ancestryProblems(deps, shas) {
  const out = [];
  for (const sha of new Set(shas)) {
    try {
      if (!deps.isMerged(deps.git, sha, REF)) out.push(`${sha} is not an ancestor of ${REF}`);
    } catch (e) {
      out.push(`${sha}: ${String(e.message).split('\n')[0]}`);
    }
  }
  return out;
}

/** Host flows run only at a commit merged into fork/main (env.mjs prepareHost): the frozen flows commit must be an ancestor too, or every host row grades broken. */
function hostShaProblems(deps, sha) {
  if (!sha) return [];
  try {
    if (deps.isMerged(deps.git, sha, REF)) return [];
  } catch (e) {
    return [`the frozen flows commit ${sha}: ${String(e.message).split('\n')[0]}`];
  }
  return [`the frozen flows commit ${sha} is not an ancestor of ${REF}: merge it first, because the frozen host flows need a merged commit`];
}

async function dockerProblem(deps) {
  try {
    const r = await deps.docker(['info'], { timeoutMs: 60_000 });
    return r.code === 0 ? null : 'Docker is not up (docker info failed)';
  } catch (e) {
    return `Docker is not up (${e.message})`;
  }
}

/** Heads grouped by image tag, in first-seen order: Map<tag, head[]>. */
function tagMap(deps, heads, imageSha) {
  const tags = deps.tagsFor(heads, imageSha);
  const byTag = new Map();
  heads.forEach((h, i) => byTag.set(tags[i], [...(byTag.get(tags[i]) ?? []), h]));
  return byTag;
}

async function imageProblems(deps, { heads, imageSha }) {
  let byTag;
  try { byTag = tagMap(deps, heads, imageSha); } catch (e) { return [`cannot plan image tags: ${String(e.message).split('\n')[0]}`]; }
  const missing = [];
  for (const [tag, hs] of byTag) if (!(await deps.hasImage(tag))) missing.push([tag, hs[0]]);
  if (missing.length === 0) return [];
  const build = `node scripts/trex/env.mjs --build --plan --heads ${missing.map((m) => m[1]).join(',')} --image-sha ${imageSha}`;
  return [`image missing: ${missing.map((m) => m[0]).join(', ')}`, `build with: ${build}`];
}

/**
 * Spec 5.14 preflight. input: { frozen, flowsDir, shas, heads, imageSha }. Returns { problems: string[] }.
 * Frozen hash and clean dir, every sha an ancestor of fork/main (input.hostSha, the frozen flows commit, too when it holds host flows), Docker up, every image tag present. Nothing is built.
 */
export async function preflight(input, deps) {
  const problems = [...frozenProblems(deps.git, input), ...ancestryProblems(deps, input.shas), ...hostShaProblems(deps, input.hostSha)];
  const down = await dockerProblem(deps);
  if (down) return { problems: [...problems, down] };
  return { problems: [...problems, ...await imageProblems(deps, input)] };
}

// ---------- cleanup (13.3) ----------

function readLock(deps) {
  const file = typeof deps.lockPath === 'function' ? deps.lockPath() : deps.lockPath;
  const info = readJson(file);
  return Number.isInteger(info?.pid) ? info : null;
}

/** The lock owner is the process that wrote the lock: alive, and started within a minute before the lock time (liveOwned rule). */
function ownsLock(info, deps) {
  if (!deps.pidAlive(info.pid)) return false;
  const began = deps.processStart(info.pid);
  const wrote = Date.parse(info.started);
  return Number.isFinite(began) && Number.isFinite(wrote) && began <= wrote + 2000 && wrote - began <= 60_000;
}

/** A live holder as acquireLock sees it: the pid runs and did not start after the lock was written (a reused pid holds nothing). */
function lockHeld(info, deps) {
  if (!deps.pidAlive(info.pid)) return false;
  const wrote = Date.parse(info.started);
  const began = deps.processStart(info.pid);
  return !(Number.isFinite(began) && Number.isFinite(wrote) && began > wrote + 2000);
}

function killOwner(info, deps) {
  if (!ownsLock(info, deps)) return false;
  deps.killTree(info.pid, { children: deps.processChildren() });
  return true;
}

function runUnlock(ctx) {
  const args = [path.join(ctx.repo, 'scripts', 'trex', 'run.mjs'), '--unlock'];
  return ctx.deps.spawn(process.execPath, args, spawnOpts(ctx, 120_000));
}

/** Kills each pid listed in the pids.json files whose live process started when it was recorded (liveOwned: a reused pid is spared). */
function killRecorded(files, deps) {
  const recorder = deps.pidRecorder ?? ((file) => makePidRecorder(file, { alive: deps.pidAlive, processStart: deps.processStart }));
  const killed = [];
  for (const file of files) {
    for (const pid of recorder(file).liveOwned()) {
      deps.killTree(pid, { children: deps.processChildren() });
      killed.push(pid);
    }
  }
  return killed;
}

/** Removes every container and network that carries this bench's own label trex.bench=<runId>. Never throws. */
async function sweepBench(ctx) {
  try { await (ctx.deps.removeByLabel ?? removeByLabel)(ctx.runId, { docker: ctx.deps.docker }, 'trex.bench'); } catch { /* best effort */ }
}

/**
 * After every row (spec 5.14 step 3, 13.3): when the run lock was written by this bench run (lock.benchRun is TREX_BENCH_RUN, the ctx.runId),
 * kill the run.mjs tree whose pid is in the lock file (only if the start time fits), call `run.mjs --unlock`, remove containers by label trex.run=<runId>.
 * After a timeout it also kills the pids recorded in each side's pids.json (pidFiles, start time checked) and sweeps the label trex.bench=<runId>.
 * Then always `docker compose -p <project> down -v` for the row's projects: prove-check kills a slow side without a tree kill, and
 * the next side replaces the dead lock, so the first side's containers can outlive a lock that is already gone.
 * A lock of another bench, or one with no benchRun, is left alone, projects included (a rival run may use the same sha).
 */
export async function cleanupRun(ctx, { projects = [], timedOut = false, pidFiles = [] }) {
  const { deps } = ctx;
  const lock = readLock(deps);
  if (lock && lock.benchRun !== ctx.runId) return { state: 'foreign', killed: false, pids: [] };
  const killed = lock ? killOwner(lock, deps) : false;
  const pids = timedOut ? killRecorded(pidFiles, deps) : [];
  if (lock) runUnlock(ctx);
  if (lock?.runId) await (deps.removeByLabel ?? removeByLabel)(lock.runId, { docker: deps.docker });
  if (timedOut) await sweepBench(ctx);
  for (const p of projects) await deps.docker(['compose', '-p', p, 'down', '-v', '--remove-orphans'], { timeoutMs: CLEAN_MS });
  return { state: lock || timedOut ? 'cleaned' : 'none', killed, pids };
}

const LOCK_POLL_MS = 30_000;
const LOCK_POLLS = 60;

/** A run exited 3 because another run holds the lock. Waits (up to 30 min) until that holder is gone, so the one retry can start. */
async function waitForLock(ctx) {
  for (let i = 0; i < LOCK_POLLS; i += 1) {
    const lock = readLock(ctx.deps);
    if (!lock || !lockHeld(lock, ctx.deps)) return;
    await ctx.deps.sleep(LOCK_POLL_MS);
  }
}

// ---------- spawning ----------

/** spawnSync options for a prove-check or run.mjs child. The timeout is above 2 x the row limit, so a healthy run is not cut. */
function spawnOpts(ctx, rowMs = ROW_TIMEOUT_MS) {
  return {
    cwd: ctx.repo, env: childEnv(ctx.env, ctx.runId), windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 2 * rowMs + 300_000,
  };
}

const timedOutOf = (r) => r?.error?.code === 'ETIMEDOUT';
const groupOf = (row) => row.bench?.group ?? row.major;

function projectFor(sha) {
  try { return projectName({ sha }); } catch { return null; }
}

function projectsOf(row, result, sides) {
  const shas = [result?.pre?.sha ?? row.pre, result?.fix?.sha ?? row.fix];
  const named = [sides.pre?.composeProject, sides.fix?.composeProject];
  return [...new Set([...named, ...shas.map(projectFor)].filter(Boolean))];
}

// ---------- one positive row ----------

function proveArgs(ctx, row, dir) {
  return [
    path.join(ctx.repo, 'scripts', 'checks', 'prove-check.mjs'), '--check', 'trex', '--major', row.major, '--proofs', ctx.proofsFile,
    '--repo', ctx.repo, '--date', ctx.date, '--out', dir,
  ];
}

function readProve(dir, date, major) {
  const j = readJson(path.join(dir, `${date}-prove-trex.json`));
  return j?.rows?.find((r) => r.major === major) ?? null;
}

/** The proof tree prove-check builds for a side: .claude/cache/proof/<sha8>/trex-<major>. It is the way to the sides when a timeout lost the JSON. */
const predictedTree = (ctx, row, side) => (row[side] ? path.join(ctx.repo, '.claude', 'cache', 'proof', String(row[side]).slice(0, 8), `trex-${row.major}`) : null);

/** Copies one .trex-out to <dir>/<side> (without the big rebuildable folders) and returns its report.json, or null. */
function copyTree(tree, side, dir) {
  const src = tree ? path.join(tree, '.trex-out') : null;
  if (!src || !existsSync(src)) return null;
  cpSync(src, path.join(dir, side), { recursive: true, filter: (s) => !SKIP_COPY.has(path.basename(s)) });
  return readJson(path.join(dir, side, 'report.json'));
}

const minutesOf = (reports) => reports.filter((r) => r?.startedAt && r?.finishedAt)
  .map((r) => (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 60_000).filter(Number.isFinite);

/** The verdict of one row from a prove-check run. Rows of one group (S6 and S7) are graded from the same run, each with its own defect files. */
function rowVerdict(ctx, row, { timedOut, result, sides }) {
  if (timedOut) return gradePositive(null, null, null, row, []);
  return gradePositive(result, sides.pre, sides.fix, row, flowsOf(ctx, groupOf(row)));
}

function flowsOf(ctx, group) {
  return (ctx.flowCache[group] ??= ctx.deps.loadFlows(ctx.deps.git, ctx.frozen.sha, `${ctx.flowsDir}/${group}`));
}

/** One prove-check run of a row, its copies and its cleanup. Returns { timedOut, result, sides, minutes }. */
async function attemptRow(ctx, row, n) {
  const dir = path.join(ctx.runDir, `r${n}`, row.major);
  mkdirSync(dir, { recursive: true });
  const r = ctx.deps.spawn(process.execPath, proveArgs(ctx, row, dir), spawnOpts(ctx, row.timeoutMs));
  const timedOut = timedOutOf(r);
  const result = readProve(dir, ctx.date, row.major);
  const tree = (side) => result?.[side]?.tree ?? (timedOut ? predictedTree(ctx, row, side) : null);
  const trees = [tree('pre'), tree('fix')];
  const sides = { pre: copyTree(trees[0], 'pre', dir), fix: copyTree(trees[1], 'fix', dir) };
  const pidFiles = trees.filter(Boolean).map((t) => path.join(t, '.trex-out', 'pids.json'));
  await cleanupRun(ctx, { projects: projectsOf(row, result, sides), timedOut, pidFiles });
  return { timedOut, result, sides, minutes: minutesOf([sides.pre, sides.fix]) };
}

/** True when a side of the run exited 3: another run held the lock. */
const lockWasHeld = (a) => !a.timedOut && (a.result?.pre?.code === 3 || a.result?.fix?.code === 3);

/** A row that met a held lock waits for it and runs once more. A second exit 3 grades as it falls (broken). */
async function runRow(ctx, row, n) {
  const first = await attemptRow(ctx, row, n);
  if (!lockWasHeld(first)) return first;
  await waitForLock(ctx);
  return attemptRow(ctx, row, n);
}

// ---------- negatives and S17 ----------

function simulateArgs(ctx, head, group, dir) {
  return [
    path.join(ctx.repo, 'scripts', 'trex', 'run.mjs'), '--simulate', head, '--flows-sha', ctx.frozen.sha, '--image-sha', ctx.imageSha,
    '--flows-dir', `${ctx.flowsDir}/${group}`, '--evidence', dir,
  ];
}

async function simulateOnce(ctx, { head, group, dir }) {
  mkdirSync(dir, { recursive: true });
  const r = ctx.deps.spawn(process.execPath, simulateArgs(ctx, head, group, dir), spawnOpts(ctx));
  const timedOut = timedOutOf(r);
  const report = readJson(path.join(dir, 'report.json'));
  await cleanupRun(ctx, { projects: [projectFor(head)].filter(Boolean), timedOut, pidFiles: [path.join(dir, 'pids.json')] });
  return { run: { stdout: r.stdout ?? '', code: timedOut ? null : r.status }, report, timedOut, minutes: minutesOf([report]) };
}

/** Runs one (head, group) through run.mjs --simulate; exit 3 (lock held) waits and runs once more. Returns { run: {stdout, code}, report, timedOut, minutes }. */
async function simulate(ctx, spec) {
  const first = await simulateOnce(ctx, spec);
  if (first.timedOut || first.run.code !== 3) return first;
  await waitForLock(ctx);
  return simulateOnce(ctx, spec);
}

const SKIP_RUN = { stdout: '# skipped no_match\n', code: 0 };
const NEG_ORDER = ['false-fail', 'skip-wrong', 'blocked', 'clean', 'skip-ok', 'untested'];
const foldNegative = (verdicts) => NEG_ORDER.find((v) => verdicts.includes(v)) ?? 'untested';

/** One negative, one repeat: the verdict of each mapped group. A skip row with no mapped group reaches "# skipped no_match" by itself. */
async function runNegative(ctx, neg, n) {
  const groups = ctx.frozen.negatives?.[neg.id] ?? [];
  if (groups.length === 0) {
    const verdict = neg.kind === 'skip' && ctx.frozen.skipped?.[neg.id] === 'no_match' ? gradeNegative(SKIP_RUN, null, neg) : 'untested';
    return { verdicts: [verdict], minutes: [] };
  }
  const out = { verdicts: [], minutes: [] };
  for (const group of groups) {
    const dir = path.join(ctx.runDir, `r${n}`, `${neg.id}-${group}`);
    const s = await simulate(ctx, { head: neg.head, group, dir });
    out.verdicts.push(gradeNegative(s.run, s.report, neg));
    out.minutes.push(...s.minutes);
  }
  return out;
}

/** S17, one repeat. reached is false when the run was blocked or killed, so a dead run is never "honest". */
async function runHonest(ctx, neg, n) {
  const group = neg.group ?? 'S17';
  const dir = path.join(ctx.runDir, `r${n}`, `${neg.id}-${group}`);
  const s = await simulate(ctx, { head: neg.head, group, dir });
  const reached = !s.timedOut && s.report !== null && (s.report.blockers ?? []).length === 0 && [0, 1].includes(s.run.code);
  const grade = s17Grade({ flows: flowsOf(ctx, group), report: s.report }, { claimMatch: neg.claimMatch ?? DEFAULT_CLAIM });
  return { ...grade, reached, minutes: s.minutes };
}

// ---------- metrics ----------

const worst = (list, bad) => (list.includes(bad) ? bad : list[0]);
const countBy = (list, fn) => list.filter(fn).length;
/** Flaky prove-check runs: rows graded from one run (S6 and S7) count once. */
const flakyRuns = (info) => new Set(info.filter((r) => r.flaky).map((r) => r.run)).size;

function summarizeRows(rows) {
  const info = rows.map((r) => ({
    id: r.id, run: r.run ?? r.id, verdicts: r.verdicts, caught: rowCaught(r.verdicts), flaky: isFlaky(r.verdicts), minutes: r.minutes,
    broken: countBy(r.verdicts, (v) => HARNESS_VERDICTS.has(v)) >= Math.ceil((2 * r.verdicts.length) / 3),
    falseFix: r.verdicts.includes('false-fail'),
  }));
  const inN = info.filter((r) => CATCH_ID.test(r.id));
  return { info, n: inN.length, caught: countBy(inN, (r) => r.caught), outside: info.filter((r) => !CATCH_ID.test(r.id)).map((r) => r.id) };
}

function summarizeNegatives(negs) {
  const info = negs.map((x) => ({ id: x.id, kind: x.kind ?? null, verdict: foldNegative(x.verdicts), verdicts: x.verdicts }));
  const tested = info.filter((x) => ['clean', 'false-fail'].includes(x.verdict));
  return {
    info,
    counts: {
      tested: tested.length, falseFails: countBy(tested, (x) => x.verdict === 'false-fail'),
      skipOk: countBy(info, (x) => x.verdict === 'skip-ok'), skipWrong: countBy(info, (x) => x.verdict === 'skip-wrong'),
    },
  };
}

function summarizeHonest(list) {
  if (list.length === 0) return null;
  return {
    regex: worst(list.map((x) => x.regex), 'invented-pass'), hand: worst(list.map((x) => x.hand), 'invented-pass'),
    handRule: list[0].handRule, reached: list.every((x) => x.reached), handNote: HAND_NOTE,
  };
}

function minutesStats(values) {
  const stat = (v) => ({ p50: pct(v, 50), p90: pct(v, 90) });
  const cold = values.map((v) => v + EST_BUILD_SEC / 60);
  return { sides: values.length, warm: stat(values), cold: stat(cold), coldNote: `cold = warm + EST_BUILD_SEC (${EST_BUILD_SEC} s) per side-run, an estimate` };
}

function buildBars({ rows, negs, honest }) {
  const bars = { fixFalseFails: countBy(rows.info, (r) => r.falseFix) === 0, flake: flakyRuns(rows.info) <= 1 };
  if (negs) bars.negatives = negs.counts.tested >= 10 && negs.counts.falseFails <= 1 && negs.counts.skipWrong === 0;
  if (honest) bars.honest = honest.reached && honest.regex === 'honest';
  return bars;
}

const tokensOf = (frozen) => Object.fromEntries(Object.entries(frozen.groups ?? {}).map(([g, v]) => [g, v.usage ?? null]));

/** Everything the report prints. data: { rows, negatives, honest } with the raw per-repeat results. */
function summarize(data, ctx) {
  const rows = summarizeRows(data.rows);
  const negs = data.negatives.length ? summarizeNegatives(data.negatives) : null;
  const honest = summarizeHonest(data.honest);
  const bars = buildBars({ rows, negs, honest });
  const all = [...data.rows.flatMap((r) => r.minutes), ...data.negatives.flatMap((x) => x.minutes), ...data.honest.flatMap((x) => x.minutes)];
  const brokenRows = countBy(rows.info, (r) => r.broken);
  return {
    scope: { n: rows.n, fullN: ctx.armN, partial: !ctx.full, repeats: ctx.repeats },
    catch: { k: rows.caught, n: rows.n, ...wilson(rows.caught, rows.n), outside: rows.outside },
    rows: rows.info, brokenRows, falseFixRows: countBy(rows.info, (r) => r.falseFix), flakes: flakyRuns(rows.info),
    negatives: negs?.info ?? [], negativeCounts: negs?.counts ?? null, honestSkip: honest,
    minutes: minutesStats(all), tokens: tokensOf(ctx.frozen), bars,
    stop: stopRule({ broken: brokenRows, caught: rows.caught, n: rows.n, bars }),
  };
}

// ---------- the report ----------

/** blind label: "audited" only when every frozen group was read-audited (13.4); a violated group is named. */
export function blindLabel(frozen) {
  const blinds = Object.entries(frozen.groups ?? {});
  const bad = blinds.filter(([, v]) => v.blind === 'violated').map(([g]) => g);
  if (bad.length) return `blind: violated (${bad.join(', ')})`;
  return `blind: ${blinds.length > 0 && blinds.every(([, v]) => v.blind === AUDITED) ? AUDITED : BLIND}`;
}

export function buildBenchReport(ctx, m) {
  const models = [...new Set(Object.values(ctx.frozen.groups ?? {}).map((g) => g.model))];
  return {
    verdict: m.stop, scope: m.scope, runId: ctx.runId, arm: ctx.arm, model: models.join(','), blind: blindLabel(ctx.frozen),
    frozen: { file: slash(ctx.frozenFile), sha: ctx.frozen.sha, flowsTree: ctx.frozen.flowsTree }, imageSha: ctx.imageSha, repeats: ctx.repeats,
    metrics: m, authorRuns: ctx.frozen.groups ?? {},
  };
}

const f2 = (v) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(2));
const pctText = (k, n) => (n > 0 ? `${((100 * k) / n).toFixed(1)}%` : 'n/a');

function headLines(r) {
  const m = r.metrics;
  const s = m.scope;
  let note = '';
  if (s.partial) note = ` (smoke: ${s.n} of ${s.fullN} rows, not a stop-rule result)`;
  else if (s.fullN < FULL_N) note = ` (arm ${r.arm}: ${s.n} of ${s.fullN} rows; compare rows caught across arms, the stop rule is for ${FULL_N} rows)`;
  return [
    `VERDICT: ${r.verdict}${note}`,
    `catch ${m.catch.k}/${m.catch.n} (${pctText(m.catch.k, m.catch.n)}), Wilson 95% ${f2(m.catch.lo)}-${f2(m.catch.hi)}; broken rows ${m.brokenRows}`,
    r.blind,
    `arm ${r.arm}  model ${r.model}  runId ${r.runId}  repeats ${r.repeats}  frozen ${String(r.frozen.sha).slice(0, 8)}`,
    `bars: ${Object.entries(m.bars).map(([k, v]) => `${k} ${v ? 'ok' : 'FAIL'}`).join(', ')}`,
    `false fails at fix SHAs: ${m.falseFixRows} row(s); flaky rows: ${m.flakes}`,
  ];
}

function rowLines(m) {
  const mins = (r) => (r.minutes.length ? ` ${r.minutes.map((x) => x.toFixed(1)).join('/')} min` : '');
  const out = m.rows.map((r) => `${r.id.padEnd(4)} ${r.verdicts.join(',')}${r.caught ? ' [caught]' : ''}${r.flaky ? ' [flaky]' : ''}${mins(r)}`);
  return ['rows:', ...out.map((l) => `  ${l}`), m.catch.outside.length ? `outside n: ${m.catch.outside.join(', ')}` : 'outside n: none'];
}

function negativeLines(m) {
  if (!m.negativeCounts) return ['negatives: not run'];
  const c = m.negativeCounts;
  const head = `negatives: ${c.tested} tested, ${c.falseFails} false fail(s); skip rows ok ${c.skipOk}, wrong ${c.skipWrong}`;
  const note = '  skip rows (K1, K2) are graded from the frozen negative map (no_match): no run.mjs spawn, the bench prints "# skipped no_match" itself';
  return [head, note, ...m.negatives.map((x) => `  ${x.id.padEnd(4)} ${x.verdict} (${x.verdicts.join(',')})`)];
}

function honestLines(m) {
  const h = m.honestSkip;
  if (!h) return ['S17 honest skip: not run'];
  return [`S17 honest skip: regex=${h.regex} hand=${h.hand}${h.reached ? '' : ' (run did not reach a result)'}`, `  hand rule: ${h.handRule}`, `  ${h.handNote}`];
}

function costLines(m) {
  const t = m.minutes;
  const stat = (s) => `p50 ${f2(s.p50)} p90 ${f2(s.p90)}`;
  const tokens = Object.entries(m.tokens).map(([g, u]) => `  tokens ${g}: ${JSON.stringify(u)}`);
  return [`minutes per side-run (${t.sides} sides): warm ${stat(t.warm)}; cold ${stat(t.cold)}`, `  ${t.coldNote}`, ...tokens];
}

export function renderBenchText(r) {
  return `${[...headLines(r), ...rowLines(r.metrics), ...negativeLines(r.metrics), ...honestLines(r.metrics), ...costLines(r.metrics)].join('\n')}\n`;
}

function writeArtifacts(ctx, report, started) {
  const stem = path.join(ctx.outDir, `${ctx.date}-trex-bench${ctx.arm === 'grok' ? '' : `-${ctx.arm}`}${ctx.full ? '' : '-smoke'}`);
  mkdirSync(ctx.outDir, { recursive: true });
  writeFileSync(`${stem}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${stem}.txt`, renderBenchText(report));
  writeSidecar(`${stem}.log.json`, {
    project: 'trex-bench', command: `node scripts/trex/bench/bench.mjs ${ctx.argvText}`.trim(), exit: 0, started,
    finished: ctx.deps.now().toISOString(), artifact: slash(`${stem}.json`), head: ctx.head,
  });
  return `${stem}.json`;
}

// ---------- planning ----------

/** The groups that make no row of their own (S17 is the honest-skip group). */
const rowGroups = (groups) => Object.entries(GROUPS).filter(([g, v]) => v.kind !== 'honest-skip' && groups.includes(g));

/** The row list for --plan, from the author groups (no rows.mjs, no Docker). S7 belongs to group S6. S17 is not a row. `groups` limits it to an arm. */
export function planRows(ids, groups = Object.keys(GROUPS)) {
  const all = rowGroups(groups).flatMap(([g, v]) => (v.rows ?? [g]).map((id) => ({ id, group: g, pre: v.pre, fix: v.fix })));
  if (!ids) return all;
  return ids.map((id) => {
    const found = all.find((r) => r.id === id);
    if (!found) throw new Error(`unknown row ${id}${groups.length < Object.keys(GROUPS).length ? ' (not in this arm)' : ''}`);
    return found;
  });
}

const hoursText = (h) => h.toFixed(1);

/** Rows, side-runs, estimated hours and image tags. Reads git only. A group runs once however many rows it grades (S6 and S7). deps: { tagsFor, extraHeads? }. */
export async function planBench({ rowIds, repeats, imageSha, extra = 0, arm = 'grok' }, deps) {
  const rows = planRows(rowIds, ARMS[arm].groups);
  const heads = [...new Set(rows.flatMap((r) => [r.pre, r.fix]).concat(deps.extraHeads ?? []))];
  const byTag = tagMap(deps, heads, imageSha);
  const runs = new Set(rows.map((r) => r.group)).size;
  const sideRuns = (runs * 2 + extra) * repeats;
  const buildHours = (byTag.size * EST_BUILD_SEC) / 3600;
  const hours = (sideRuns * EST_SIDE_MIN) / 60;
  return { rows, sideRuns, tags: [...byTag.keys()], byTag, hours, buildHours };
}

function planLines(plan, o) {
  return [
    `bench plan (arm ${o.arm})`, `rows: ${plan.rows.map((r) => r.id).join(', ')}`, `repeats: ${o.repeats}`,
    `side runs: ${plan.sideRuns} (groups x 2 sides x repeats${o.extra ? `, plus ${o.extra} negative run(s) per repeat` : ''}; S7 shares the S6 run)`,
    `estimated hours: ${hoursText(plan.hours)} at ${EST_SIDE_MIN} min per side-run, plus up to ${hoursText(plan.buildHours)} if every image tag needs a build`,
    `image tags needed (${plan.tags.length}):`,
    ...[...plan.byTag].map(([tag, hs]) => `  ${tag} (${hs.length} head${hs.length === 1 ? '' : 's'})`),
    'No run started. Nothing was built, spawned or copied.',
  ];
}

// ---------- the bench ----------

const armGroupsOf = (arm) => ARMS[arm].groups;
/** An arm that holds every author group can run the negatives and S17 by default. The four-group arms cannot reach the 10 tested negatives. */
const armIsFull = (arm) => Object.keys(GROUPS).every((g) => armGroupsOf(arm).includes(g));
/** The arm's own catch rows (S1-S15): the denominator its report shows. */
const armCatchN = (arm) => planRows(null, armGroupsOf(arm)).filter((r) => CATCH_ID.test(r.id)).length;
const wantsNegatives = (o) => o.negatives ?? (!o.rowIds && armIsFull(o.arm));
const inArm = (arm, row) => armGroupsOf(arm).includes(groupOf(row));

export function withDefaults(deps = {}, repo = ROOT) {
  const git = deps.git ?? makeTrexGit(repo);
  const rows = () => import('./rows.mjs');
  return {
    spawn: spawnSync, now: () => new Date(), out: (l) => console.log(l), pidAlive, processStart: processStartMs, processChildren, killTree,
    isMerged, removeByLabel, loadFlows, hasImage: (tag) => imageExists(tag, { cwd: repo }), acquireLock,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    tagsFor: (heads, sha) => imageTagsFor(git, heads, sha),
    docker: (args, o) => runChild(dockerBin(), args, o),
    lockPath: () => lockPathFor(primaryRootOf(git, repo)),
    benchLockPath: () => path.join(path.dirname(lockPathFor(primaryRootOf(git, repo))), 'bench.lock'),
    loadRows: async (f) => (await rows()).loadRows(f), loadNegatives: async (f) => (await rows()).loadNegatives(f),
    validateRows: async (g, r, o) => (await rows()).validateRows(g, r, o),
    validateNegatives: async (g, n, o) => (await rows()).validateNegatives(g, n, o),
    ...deps, git,
  };
}

function selectRows(all, ids, arm) {
  const catchRows = all.filter((r) => r.check === 'trex' && (r.bench?.kind ?? 'catch') === 'catch' && inArm(arm, r));
  if (!ids) return { rows: catchRows, problems: [] };
  const problems = ids.filter((id) => !catchRows.some((r) => r.major === id)).map((id) => `unknown row ${id} (not a catch row of arm ${arm} in the proofs file)`);
  return { rows: ids.map((id) => catchRows.find((r) => r.major === id)).filter(Boolean), problems };
}

/**
 * The prove-check runs of a selection: one for each group. S7 is graded from the S6 run (same flows, pre and fix), with its own defect files.
 * [{ group, run (the row prove-check runs), graded (the selected rows graded from that run) }].
 */
function runUnits(all, rows) {
  const units = new Map();
  for (const row of rows) {
    const g = groupOf(row);
    if (!units.has(g)) units.set(g, { group: g, graded: [] });
    units.get(g).graded.push(row);
  }
  return [...units.values()].map((u) => ({ ...u, run: all.find((r) => r.major === u.group && r.check === 'trex') ?? u.graded[0] }));
}

/** The S17 entry: from negatives.json when it names one, else from the S17 author group (skipAt, claimMatch). */
function honestEntry(negatives) {
  const own = negatives.find((n) => n.kind === 'honest-skip');
  return own ?? { id: 'S17', kind: 'honest-skip', group: 'S17', head: GROUPS.S17.skipAt, claimMatch: DEFAULT_CLAIM };
}

async function loadInputs(o, deps) {
  const arm = ARMS[o.arm];
  const frozenFile = path.resolve(o.repo, o.frozenFile ?? path.join(BENCH_DIR, arm.frozen));
  const proofsFile = path.resolve(o.repo, o.proofs ?? path.join(BENCH_DIR, 'proofs-trex.json'));
  const negativesFile = path.join(o.repo, BENCH_DIR, 'negatives.json');
  const all = await deps.loadRows(proofsFile);
  const withNeg = wantsNegatives(o);
  const allNeg = withNeg ? await deps.loadNegatives(negativesFile) : [];
  const sel = selectRows(all, o.rowIds, o.arm);
  return {
    arm: o.arm, frozenFile, proofsFile, negativesFile, frozen: readJson(frozenFile), all, sel, units: runUnits(all, sel.rows), withNeg,
    negatives: allNeg.filter((n) => n.kind !== 'honest-skip'), honest: withNeg && arm.groups.includes('S17') ? honestEntry(allNeg) : null, flowsDir: arm.flowsDir,
  };
}

/** Spec 13.1: the negatives must be clean for the groups they touch, and enough of them graded. Reads the flows of the arm's groups at the frozen sha. */
async function negativeProblems(deps, inp) {
  const flows = {};
  try {
    for (const g of armGroupsOf(inp.arm)) flows[g] = deps.loadFlows(deps.git, inp.frozen.sha, `${inp.flowsDir}/${g}`).map((f) => ({ id: f.id, paths: f.paths }));
  } catch (e) {
    return [`cannot read the flows of arm ${inp.arm} at ${shortId(inp.frozen.sha)}: ${String(e.message).split('\n')[0]}`];
  }
  return deps.validateNegatives(deps.git, inp.negatives, { sha: inp.frozen.sha, ref: REF, flows });
}

function headPins(pinned, negatives) {
  const out = negatives.filter((n) => pinned[n.id] !== n.head)
    .map((n) => `negative ${n.id}: head ${shortId(n.head)} differs from the frozen head ${pinned[n.id] ? shortId(pinned[n.id]) : 'none'}`);
  for (const id of Object.keys(pinned)) if (!negatives.some((n) => n.id === id)) out.push(`negative ${id} was frozen but is no longer in negatives.json`);
  return out;
}

/** The freeze pins (author.mjs freeze): the negative heads and the blob ids of the answer key (proofs-trex.json) and negatives.json must not change after the freeze. */
function pinProblems(deps, inp) {
  const pins = inp.frozen.pins;
  if (!pins?.files || !pins.negatives) return ['the frozen file has no input pins: run author.mjs --freeze again'];
  const out = [];
  const blob = (label, file, want) => {
    const got = inputBlob(deps.git, file);
    if (got !== want) out.push(`${label} changed since the freeze (blob ${shortId(got)}, frozen ${shortId(want)}): freeze again`);
  };
  blob('proofs-trex.json', inp.proofsFile, pins.files.proofs);
  if (!inp.withNeg) return out;
  blob('negatives.json', inp.negativesFile, pins.files.negatives);
  return [...out, ...headPins(pins.negatives, inp.negatives)];
}

async function inputProblems(inp, o, deps) {
  if (!inp.frozen) return [`cannot read the frozen file ${inp.frozenFile}: run author.mjs --freeze first`];
  const out = [...inp.sel.problems];
  if (inp.sel.rows.length === 0) out.push('no rows to run');
  const armRows = inp.all.filter((r) => r.check === 'trex' && inArm(inp.arm, r));
  out.push(...await deps.validateRows(deps.git, armRows, { ref: REF, root: o.repo, flowsDir: inp.flowsDir, groups: armGroupsOf(inp.arm) }));
  out.push(...pinProblems(deps, inp));
  if (inp.withNeg) out.push(...await negativeProblems(deps, inp));
  return out;
}

const headsOf = (inp) => {
  const mapped = new Set(Object.entries(inp.frozen.negatives ?? {}).filter(([, g]) => g.length > 0).map(([id]) => id));
  const negHeads = inp.negatives.filter((n) => mapped.has(n.id)).map((n) => n.head);
  return [...inp.units.flatMap((u) => [u.run.pre, u.run.fix]), ...negHeads, inp.honest?.head].filter(Boolean);
};

function makeCtx(o, deps, inp, runId) {
  const date = localDate(deps.now());
  const outBase = path.join(o.repo, '.claude', 'cache', 'e2e');
  return {
    repo: o.repo, deps, runId, date, env: o.env ?? process.env, arm: o.arm, repeats: o.repeats, frozen: inp.frozen, frozenFile: inp.frozenFile,
    flowsDir: inp.flowsDir, imageSha: o.imageSha, full: !o.rowIds, armN: armCatchN(o.arm), flowCache: {}, argvText: o.argvText ?? '',
    runDir: path.join(outBase, 'trex', 'bench', runId), outDir: o.outDir ?? outBase, head: deps.git(['rev-parse', 'HEAD']).stdout.trim(),
  };
}

function writeProofs(ctx, rows) {
  const eff = rows.map((r) => (r.cmd ? { ...r, cmd: effectiveCmd(r.cmd, { flowsSha: ctx.frozen.sha, imageSha: ctx.imageSha, flowsDir: ctx.flowsDir }) } : r));
  mkdirSync(ctx.runDir, { recursive: true });
  ctx.proofsFile = path.join(ctx.runDir, 'proofs.json');
  writeFileSync(ctx.proofsFile, `${JSON.stringify({ rows: eff }, null, 2)}\n`);
}

/** The entry of `list` with this id; a new one is added when there is none. */
function slotFor(list, id, extra = {}) {
  let slot = list.find((x) => x.id === id);
  if (!slot) { slot = { id, verdicts: [], minutes: [], ...extra }; list.push(slot); }
  return slot;
}

async function repeatOnce(ctx, inp, n, data) {
  for (const unit of inp.units) {
    const r = await runRow(ctx, unit.run, n);
    unit.graded.forEach((row, i) => {
      const slot = slotFor(data.rows, row.major, { run: unit.group });
      slot.verdicts.push(rowVerdict(ctx, row, r));
      if (i === 0) slot.minutes.push(...r.minutes);
    });
  }
  if (!inp.withNeg) return;
  for (const neg of inp.negatives) {
    const r = await runNegative(ctx, neg, n);
    const slot = slotFor(data.negatives, neg.id, { kind: neg.kind });
    slot.verdicts.push(...r.verdicts);
    slot.minutes.push(...r.minutes);
  }
  if (inp.honest) data.honest.push(await runHonest(ctx, inp.honest, n));
}

function normalize(opts) {
  const o = { repeats: 3, arm: 'grok', ...opts, repo: path.resolve(opts.repo ?? ROOT) };
  if (!Object.hasOwn(ARMS, o.arm)) throw new Error(`unknown arm ${JSON.stringify(o.arm)}`);
  return o;
}

const refused = (problems) => ({ exit: 2, problems, metrics: null, verdict: null, artifact: null });

/** One bench at a time on this machine: two benches share the row ids and the run lock, and would clean up each other's containers. */
function takeBenchLock(deps, runId) {
  const file = typeof deps.benchLockPath === 'function' ? deps.benchLockPath() : deps.benchLockPath;
  const info = { pid: process.pid, started: deps.now().toISOString(), argv: process.argv.slice(2), runId };
  return { ...deps.acquireLock(file, info, { alive: deps.pidAlive, processStart: deps.processStart }), file };
}

async function runAll(ctx, inp, o) {
  writeProofs(ctx, inp.units.map((u) => u.run));
  const started = ctx.deps.now().toISOString();
  const data = { rows: [], negatives: [], honest: [] };
  for (let n = 1; n <= o.repeats; n += 1) await repeatOnce(ctx, inp, n, data);
  const metrics = summarize(data, ctx);
  const report = buildBenchReport(ctx, metrics);
  const artifact = writeArtifacts(ctx, report, started);
  ctx.deps.out(`VERDICT: ${report.verdict}${ctx.full ? '' : ' (smoke)'}  ${artifact}`);
  return { exit: 0, problems: [], metrics, verdict: report.verdict, artifact };
}

/**
 * runBench({ repo, repeats, rowIds, runId, arm, frozenFile, negatives, imageSha, outDir, env }, deps) -> { exit, metrics, verdict, artifact, problems }.
 * Preflight first (nothing runs on a problem: exit 2). Then the bench lock (one bench at a time: exit 2 when held).
 * Each repeat runs every positive row once for each group, and in a full run of an arm that holds them, every negative and S17.
 */
export async function runBench(opts, deps0 = {}) {
  const o = normalize(opts);
  const deps = withDefaults(deps0, o.repo);
  o.imageSha ??= deps.git(['rev-parse', 'HEAD']).stdout.trim();
  const inp = await loadInputs(o, deps);
  const problems = await refuse(o, deps, inp);
  if (problems) return refused(problems);
  const runId = o.runId ?? `bench-${localDate(deps.now())}-${randomBytes(3).toString('hex')}`;
  const lock = takeBenchLock(deps, runId);
  if (!lock.ok) return refused([`another bench run holds ${slash(lock.file)} (pid ${lock.pid ?? 'unknown'}): wait for it to finish`]);
  const ctx = makeCtx(o, deps, inp, runId);
  try {
    return await runAll(ctx, inp, o);
  } finally {
    await sweepBench(ctx);
    lock.release();
  }
}

async function refuse(o, deps, inp) {
  const problems = await inputProblems(inp, o, deps);
  if (problems.length > 0) return problems;
  const heads = headsOf(inp);
  const hostSha = inp.frozen.hostFlows > 0 ? inp.frozen.sha : null;
  const pre = await preflight({ frozen: inp.frozen, flowsDir: inp.flowsDir, shas: heads, hostSha, heads, imageSha: o.imageSha }, deps);
  return pre.problems.length > 0 ? pre.problems : null;
}

// ---------- command line ----------

const FLAGS = { '--rows': 'rows', '--repeats': 'repeats', '--arm': 'arm', '--frozen': 'frozenFile', '--image-sha': 'imageSha', '--proofs': 'proofs', '--out': 'outDir' };

export function parseArgs(argv) {
  const o = { rowIds: null, repeats: 3, arm: 'grok', plan: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--plan') o.plan = true;
    else if (a === '--negatives') o.negatives = true;
    else if (FLAGS[a]) o[FLAGS[a]] = argv[++i];
    else return { error: `unknown argument ${JSON.stringify(a)}` };
  }
  return finishArgs(o);
}

function finishArgs(o) {
  if (typeof o.rows === 'string') o.rowIds = o.rows.split(',').map((s) => s.trim()).filter(Boolean);
  delete o.rows;
  o.repeats = Number(o.repeats);
  if (!Number.isInteger(o.repeats) || o.repeats < 1) return { error: '--repeats must be a whole number of 1 or more' };
  if (!ARM_NAMES.includes(o.arm)) return { error: `--arm must be one of ${ARM_NAMES.join(', ')}` };
  return o;
}

async function planMain(o, deps) {
  const negs = wantsNegatives(o) ? await safeNegatives(deps) : [];
  const extra = negs.length > 0 ? negs.length + (ARMS[o.arm].groups.includes('S17') ? 1 : 0) : 0;
  const plan = await planBench({ rowIds: o.rowIds, repeats: o.repeats, imageSha: o.imageSha ?? 'HEAD', extra, arm: o.arm }, { ...deps, extraHeads: negs.map((n) => n.head) });
  planLines(plan, { arm: o.arm, repeats: o.repeats, extra }).forEach((l) => deps.out(l));
  return 0;
}

async function safeNegatives(deps) {
  try { return await deps.loadNegatives(path.join(ROOT, BENCH_DIR, 'negatives.json')); } catch { return []; }
}

/** Returns the exit code. deps are for tests (see withDefaults). */
export async function main(argv, deps0 = {}) {
  const deps = withDefaults(deps0, ROOT);
  const o = parseArgs(argv);
  if (o.error) { deps.out(`bench: ${o.error}`); return 2; }
  try {
    if (o.plan) return await planMain(o, deps);
    const r = await runBench({ ...o, argvText: argv.join(' ') }, deps0);
    r.problems.forEach((p) => deps.out(`bench: refused: ${p}`));
    return r.exit;
  } catch (e) {
    deps.out(`bench: ${e.message}`);
    return e.message.startsWith('unknown row') ? 2 : 4;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2));
