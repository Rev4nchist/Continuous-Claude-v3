// Build report.json, the stdout lines, the exit code and the evidence folder of one TREX run.
// Rule: stdout carries only flow ids, states, severities, stage or reason codes, counts, the PR number and a short sha.
// Titles, check text and child output stay in the files. prove-check scans stdout for broken markers.

import nodeFs from 'node:fs';
import path from 'node:path';
import { ID_RE, SEVERITIES } from './flow.mjs';

const FLOW_STATES = Object.freeze(['pass', 'fail', 'flaky', 'blocked', 'incomplete']);
const CHECK_STATES = Object.freeze(['passed', 'failed', 'blocked', 'not_attempted']);
const ENV_SOURCES = Object.freeze(['flow', 'default']);
const TESTED_STATES = new Set(['pass', 'fail', 'flaky']);
const SIDECAR_KEYS = Object.freeze(['project', 'command', 'exit', 'started', 'finished', 'artifact', 'head']);

const oneOf = (list, v, what) => {
  if (!list.includes(v)) throw new TypeError(`report: ${what} "${String(v)}" is not one of ${list.join(', ')}`);
  return v;
};
const slash = (p) => p.replaceAll('\\', '/');

// ---------- buildReport ----------

function buildCheck(c) {
  const out = {};
  if (c.step !== undefined) out.step = c.step;
  if (c.check !== undefined) out.check = c.check;
  return { ...out, text: c.text, state: oneOf(CHECK_STATES, c.state, 'check state'), ...(c.reason ? { reason: c.reason } : {}), evidence: [...(c.evidence ?? [])] };
}

function buildFlow(f, blockers) {
  if (typeof f.id !== 'string' || !ID_RE.test(f.id)) throw new TypeError(`report: flow id "${String(f.id)}" does not match ${ID_RE}`);
  const state = oneOf(FLOW_STATES, f.state, 'flow state');
  const reason = f.reason ?? (state === 'blocked' ? blockers[0]?.stage : undefined);
  return {
    id: f.id,
    state,
    ...(f.incomplete ? { incomplete: true } : {}),
    ...(reason ? { reason } : {}),
    severity: oneOf(SEVERITIES, f.severity ?? 'P1', 'severity'),
    attempts: f.attempts ?? 0,
    seconds: f.seconds ?? 0,
    tokens: f.tokens ?? 0,
    checks: (f.checks ?? []).map(buildCheck),
    ...(f.env ? { env: { git: oneOf(ENV_SOURCES, f.env.git, 'env git'), remote: oneOf(ENV_SOURCES, f.env.remote, 'env remote') } } : {}),
  };
}

/** One finding for each failed check of a Fail flow. A Fail flow with no failed check gets one flow-level finding. */
function findingsOf(flow) {
  if (flow.state !== 'fail') return [];
  const base = { severity: flow.severity, flowId: flow.id };
  const failedChecks = flow.checks.filter((c) => c.state === 'failed');
  if (failedChecks.length === 0) return [{ ...base, step: null, check: null, text: flow.reason ?? 'flow failed' }];
  return failedChecks.map((c) => ({ ...base, step: c.step ?? null, check: c.check ?? null, text: c.text }));
}

function skippedOf(skipped) {
  if (skipped === undefined || skipped === null) return null;
  if (typeof skipped?.reason !== 'string' || skipped.reason === '') throw new TypeError('report: skipped must be {reason: string} or null');
  return { reason: skipped.reason };
}

/** The run blockers, then the blocker of each blocked flow (for example out of memory). Equal blockers count once. */
function blockersOf(run) {
  const all = [...(run.blockers ?? []), ...(run.flows ?? []).map((f) => f.blocker).filter(Boolean)];
  const seen = new Set();
  return all.map((b) => ({ stage: b.stage, text: b.text })).filter((b) => {
    const key = JSON.stringify([b.stage, b.text]);
    return seen.has(key) ? false : seen.add(key);
  });
}

/**
 * @param {object} run  {pr, base, head, configSha, envDigest, envAttempts, imageTag, composeProject, startedAt, finishedAt,
 *   envSeconds, envDefaults, pids, flows, blockers, skipped, ephemeral}. `summary` and `findings` are derived, never passed in.
 *   flows[]: {id, state: pass|fail|flaky|blocked|incomplete, incomplete?, reason?, blocker?: {stage, text}, severity?, attempts?, seconds?, tokens?,
 *   checks?: [{text, state, step?, check?, reason?, evidence?}]}. A blocked flow without a reason takes blockers[0].stage.
 * @returns the report.json object, with the keys in the order of spec section 4.
 */
export function buildReport(run) {
  const blockers = blockersOf(run);
  const flows = (run.flows ?? []).map((f) => buildFlow(f, blockers));
  const findings = flows.flatMap(findingsOf);
  const tested = flows.filter((f) => TESTED_STATES.has(f.state)).length;
  const pick = (k) => run[k] ?? null;
  return {
    pr: pick('pr'), base: pick('base'), head: pick('head'), configSha: pick('configSha'), envDigest: pick('envDigest'),
    envAttempts: pick('envAttempts'), imageTag: pick('imageTag'), composeProject: pick('composeProject'),
    envDefaults: pick('envDefaults'),
    startedAt: pick('startedAt'), finishedAt: pick('finishedAt'), envSeconds: pick('envSeconds'),
    pids: [...(run.pids ?? [])],
    summary: { tested, findings: findings.length, blockers: blockers.length },
    flows, findings, blockers,
    skipped: skippedOf(run.skipped),
    ephemeral: [...(run.ephemeral ?? [])],
  };
}

// ---------- exit code ----------

// A skipped run with this reason is not clean: nothing was configured to grade.
const SKIP_IS_BROKEN = new Set(['no_config']);
const OPEN_STATES = new Set(['incomplete', 'blocked']);

/**
 * Exit code of a run, from the report alone. Codes 2, 3 and 4 belong to run.mjs.
 * 5: any blocker, no flow tested, or any selected flow incomplete or blocked. There is no evidence, so prove-check reads it as broken (13.1).
 * 0: a skipped run with nothing tested, such as "# skipped no_match" (bench negatives K1 and K2). Not broken: no flow applied.
 *    The exception is skipped no_config (no grading files), which stays 5.
 * 1: a Fail, and none of the above.
 * Flaky stays 0 when nothing failed. The bench grades flakiness from report.json, not from the exit code.
 * A Fail beside a blocker gives 5, as 13.1 says. This loses nothing: prove-check reads the `not ok` line as a fire
 * whatever the exit code is, as long as a failing line exists (prove-check.mjs classifyRun).
 */
export function exitCodeFor(report) {
  if (report.blockers.length > 0) return 5;
  if (report.summary.tested === 0) return report.skipped && !SKIP_IS_BROKEN.has(report.skipped.reason) ? 0 : 5;
  if (report.flows.some((f) => OPEN_STATES.has(f.state))) return 5;
  return report.flows.some((f) => f.state === 'fail') ? 1 : 0;
}

// ---------- stdout lines ----------

/** Keep only characters that cannot start a new line or smuggle text. */
const safe = (v) => String(v).replace(/[^A-Za-z0-9_.:-]/g, '_');
const stage = (f) => safe(f.reason ?? 'unknown');

const FLOW_LINES = {
  pass: (f) => `ok ${safe(f.id)}`,
  fail: (f) => `not ok ${safe(f.id)} # ${safe(f.severity)}`,
  flaky: (f) => `# flaky ${safe(f.id)}`,
  blocked: (f) => `# blocked ${safe(f.id)} ${stage(f)}`,
  incomplete: (f) => `# incomplete ${safe(f.id)} ${stage(f)}`,
};

/** GREEN needs a PR number and a hex head. Simulate runs have no PR, so they print no GREEN line. */
function greenLine(report) {
  const allPass = report.summary.tested > 0 && report.flows.every((f) => f.state === 'pass'); // a skipped run exits 0 with tested 0: no GREEN
  const prOk = Number.isInteger(report.pr) && report.pr > 0;
  const headOk = typeof report.head === 'string' && /^[0-9a-f]{8,40}$/i.test(report.head);
  if (!allPass || !prOk || !headOk || exitCodeFor(report) !== 0) return [];
  return [`GREEN: node scripts/trex/run.mjs --pr ${report.pr} @ ${report.head.slice(0, 8)}`];
}

/** The stdout lines of section 4, in order: flows, skip, summary, GREEN. */
export function formatLines(report) {
  const { tested, findings, blockers } = report.summary;
  return [
    ...report.flows.map((f) => FLOW_LINES[f.state](f)),
    ...(report.skipped ? [`# skipped ${safe(report.skipped.reason)}`] : []),
    `# trex: tested ${tested} findings ${findings} blockers ${blockers}`,
    ...greenLine(report),
  ];
}

// ---------- files ----------

/**
 * Write the sidecar, in the shape of verify.mjs writeSidecar: exactly seven keys, in this order.
 * A missing key is null. Write it with exit null and finished null at the start of a run, then again at the end.
 */
export function writeSidecar(file, fields, fs = nodeFs) {
  const body = Object.fromEntries(SIDECAR_KEYS.map((k) => [k, fields[k] ?? null]));
  if (body.exit !== null && !Number.isInteger(body.exit)) throw new TypeError(`report: sidecar exit must be an integer or null, got ${String(body.exit)}`);
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

/** Index of evidence files: one entry for each check that has files. */
function indexOf(report) {
  return report.flows.flatMap((f) => f.checks
    .filter((c) => c.evidence.length > 0)
    .map((c) => ({ flowId: f.id, step: c.step ?? null, check: c.check ?? null, files: c.evidence })));
}

/**
 * Write report.json, run.log (the stdout lines), index.json and the run.log.json sidecar into `dir`. The sidecar goes last,
 * so a crash leaves exit null. build.log, env.log and flows/** belong to env.mjs and writeStepOutput.
 * meta: {project, command, started, finished, head?, exit?}. exit defaults to exitCodeFor(report).
 */
export function writeAll(dir, report, meta, fs = nodeFs) {
  fs.mkdirSync(dir, { recursive: true });
  const paths = { report: path.join(dir, 'report.json'), log: path.join(dir, 'run.log'), index: path.join(dir, 'index.json'), sidecar: path.join(dir, 'run.log.json') };
  fs.writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(paths.log, `${formatLines(report).join('\n')}\n`);
  fs.writeFileSync(paths.index, `${JSON.stringify(indexOf(report), null, 2)}\n`);
  const fields = {
    project: meta.project, command: meta.command, started: meta.started ?? report.startedAt, finished: meta.finished ?? report.finishedAt,
    exit: meta.exit ?? exitCodeFor(report), artifact: slash(path.resolve(paths.log)), head: meta.head ?? report.head,
  };
  writeSidecar(paths.sidecar, fields, fs);
  return paths;
}

const posInt = (v, what) => {
  if (!Number.isInteger(v) || v < 1) throw new TypeError(`report: ${what} must be a positive integer, got ${String(v)}`);
  return v;
};

/**
 * Write one step's stdout and stderr to flows/<id>/a<attempt>/step<step>.{stdout,stderr}.txt under `dir`.
 * Returns the two paths, relative to `dir` with "/" separators, for check.evidence.
 */
export function writeStepOutput(dir, { flowId, attempt, step, result }, fs = nodeFs) {
  if (typeof flowId !== 'string' || !ID_RE.test(flowId)) throw new TypeError(`report: flow id "${String(flowId)}" does not match ${ID_RE}`);
  const rel = `flows/${flowId}/a${posInt(attempt, 'attempt')}/step${posInt(step, 'step')}`;
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  const files = [`${rel}.stdout.txt`, `${rel}.stderr.txt`];
  fs.writeFileSync(path.join(dir, files[0]), String(result?.stdout ?? ''));
  fs.writeFileSync(path.join(dir, files[1]), String(result?.stderr ?? ''));
  return files;
}
