#!/usr/bin/env node
// adversarial.mjs: the 9 hand-written bad probes of the verify design (P0 gate: 9 of 9 give the expected verdict).
// Where the verdict depends on execution, the probe runs in the real TREX container through the real runner (flow-run.mjs runFlows,
// with coverage on), and the evidence goes through verdict.mjs. No model is called.
//
//   node scripts/trex/verify/adversarial.mjs [--out <dir>] [--only <fixture id>] [--no-overhead]
//
// Fixtures: fixtures/adversarial/<id>/{probe.mjs, declare.json, fixture.json}. fixture.json holds the run plan and `expected`.
// Heads and bases are bench SHAs whose lockfiles map to an existing image: a SHA with no image would start a build.
// The probe for each side goes in /app/.verify/<fixture>/, outside the app source (G5). Exit 0 all expected, 1 a mismatch, 2 setup, 3 lock or docker.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadFlows } from '../flow.mjs';
import { runFlows } from '../flow-run.mjs';
import { makeTrexGit } from '../lib/git.mjs';
import { resolveDeps } from '../env.mjs';
import { writeStepOutput } from '../report.mjs';
import { BLOCK_REASONS, VERDICTS, verdict } from './verdict.mjs';
import { loadContainerCoverage, makeCoverage } from './coverage.mjs';
import { hunkRevertChanged, observedValue, runFromStep, tamperedFiles } from './evidence.mjs';
import { realContainerDeps, withTrexLock } from './oracle0-container.mjs';

export const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/adversarial/', import.meta.url));
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FLOWS_DIR = 'scripts/trex/bench/flows/S9';
const DATE = '2026-11-03';
const PROBE_TIMEOUT_MS = 60_000;

// ---------- fixtures (pure) ----------

const isVerdict = (v) => VERDICTS.includes(v) || (typeof v === 'string' && v.startsWith('blocked:') && BLOCK_REASONS.includes(v.slice(8)));

/** Problems with one loaded fixture, as text. An empty array means it is usable. */
export function validateFixture(fx) {
  const bad = [];
  if (!/^[a-z0-9-]{3,40}$/.test(fx?.id ?? '')) bad.push('id must match [a-z0-9-]{3,40}');
  if (typeof fx?.probe !== 'string' || fx.probe.trim() === '') bad.push('probe.mjs is empty');
  if (fx?.declare !== null && typeof fx?.declare !== 'object') bad.push('declare must be an object');
  if (!isVerdict(fx?.expected?.verdict)) bad.push(`expected.verdict "${fx?.expected?.verdict}" is not a verdict`);
  if (typeof fx?.head !== 'string' || !fx.head) bad.push('head must be a ref');
  const c = fx?.cited;
  if (typeof c?.file !== 'string' || !Number.isInteger(c?.start) || !Number.isInteger(c?.end) || c.start < 1 || c.end < c.start) bad.push('cited needs file, start >= 1 and end >= start');
  if (!Number.isInteger(fx?.headRuns) || fx.headRuns < 0 || fx.headRuns > 3) bad.push('headRuns must be an integer 0-3');
  if (fx?.runBase === true && !fx.base) bad.push('runBase needs a base ref');
  if (fx?.runFix === true && !fx.fix) bad.push('runFix needs a fix ref');
  if (fx?.g9 === true && !fx.base) bad.push('g9 needs a base ref to revert to');
  return bad;
}

export const GATE_SIZE = 9;

/** Fixture folders on disk. Counted apart from loadFixtures so a folder that never loads cannot shrink the denominator. */
export const countFixtureDirs = (dir = FIXTURES_DIR) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;

/**
 * The P0 gate. A full run passes only when it has 9 rows, 9 fixture folders and every row matched. A --only run is never the gate:
 * its label starts with "non-gate" and pass is false. `pass` is the gate; `allOk` says every row that ran matched.
 * @returns {{ pass: boolean, allOk: boolean, label: string }}
 */
export function gateResult(rows, { folderCount, only = null }) {
  const ok = rows.filter((r) => r.ok).length;
  const allOk = rows.length > 0 && ok === rows.length;
  if (only !== null) return { pass: false, allOk, label: `non-gate: ${ok} of ${rows.length} ran (--only ${only}; run without --only for the gate)` };
  if (rows.length !== folderCount || rows.length !== GATE_SIZE) {
    return { pass: false, allOk, label: `FAIL: ${rows.length} rows for ${folderCount} fixture folders, the gate needs exactly ${GATE_SIZE} of ${GATE_SIZE}` };
  }
  return { pass: allOk, allOk, label: `${ok} of ${rows.length} expected` };
}

/** Files that differ in any run, each listed once, in first-seen order. */
export const uniqueTampered = (runs) => [...new Set(runs.flatMap((r) => r.tampered))];

/** Reads every fixture dir, sorted by id. Throws on a problem so a broken fixture never counts as a pass. */
export function loadFixtures(dir = FIXTURES_DIR) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const read = (f) => readFileSync(path.join(dir, name, f), 'utf8');
    const fx = { ...JSON.parse(read('fixture.json')), probe: read('probe.mjs'), declare: JSON.parse(read('declare.json')) };
    const problems = validateFixture(fx);
    if (problems.length > 0 || fx.id !== name) throw new Error(`fixture ${name}: ${[...problems, ...(fx.id !== name ? ['id differs from the folder name'] : [])].join('; ')}`);
    out.push(fx);
  }
  return out;
}

/** The verdict.mjs input from a fixture and the evidence collected for it. Pure. */
export function verdictInputFor(fx, ev) {
  return {
    declare: fx.declare,
    declaredBeforeFirstRun: fx.declaredBeforeFirstRun,
    head: ev.headRuns,
    base: ev.baseRun ?? null,
    fix: ev.fixRun ?? null,
    baseReachable: ev.baseReachable,
    coverage: { citedLinesExecuted: ev.cited },
    g9: ev.baseReachable ? undefined : ev.g9,
    tamper: ev.tamper,
    citedPathExists: ev.citedPathExists,
    dockerOk: ev.dockerOk,
  };
}

/** True when the verdict matches, and the rule and false_confirm too when the fixture states them. */
export const matchesExpected = (got, expected) => got.verdict === expected.verdict
  && (expected.rule === undefined || got.rule === expected.rule)
  && (expected.false_confirm === undefined || got.false_confirm === expected.false_confirm);

// ---------- container side ----------

const shortId = (fx) => fx.id.slice(0, 2);
const probeDir = (fx) => `/app/.verify/${fx.id}`;
const execOk = (r) => r?.code === 0 && r.timedOut !== true;

async function writeText(env, target, text) {
  const r = await env.exec(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', target], { cwd: '.', stdin: text, timeoutSec: 30 });
  if (!execOk(r)) throw new Error(`write ${target} failed (exit ${r?.code})`);
}

function flowFor(fx, flowId) {
  return {
    id: flowId, title: `adversarial ${fx.id}`, description: 'verify P0 adversarial probe', goal: 'run the probe', paths: ['.verify/probe'], driver: 'cli', mode: 'scripted',
    profile: 'container', needs: [], severity: 'P1', limits: { timeoutMs: PROBE_TIMEOUT_MS, retries: 0, maxSteps: 100 },
    steps: [{ action: { cmd: ['node', `.verify/${fx.id}/probe.mjs`], cwd: '.' }, checks: [{ text: 'the probe passes', exit: 0 }] }],
  };
}

async function restoreTree(env) {
  await env.exec(['sh', '-c', 'git checkout -- . && git clean -fdq -e .verify'], { cwd: '.', timeoutSec: 60 });
}

/** One probe run through runFlows with coverage on. Returns the Run, the tamper list, the coverage data and the wall time. */
async function runProbe(side, fx, label) {
  const flowId = `${shortId(fx)}-${label}`;
  const steps = [];
  const deps = {
    evidenceDir: side.evidenceDir, now: () => new Date(), readFixture: () => null, coverage: [flowId],
    writeStep: (a) => { steps.push(a.result); return writeStepOutput(side.evidenceDir, a); },
  };
  const t0 = performance.now();
  const [entry] = await runFlows([flowFor(fx, flowId)], side.env, deps);
  const ms = Math.round(performance.now() - t0);
  const step = steps.at(-1);
  const run = step ? runFromStep(step) : { exitClass: `broken:${entry?.reason ?? 'start'}`, failLine: null, normalizedOutput: '' };
  const status = await side.env.exec(['git', 'status', '--porcelain'], { cwd: '.', timeoutSec: 60 });
  const tampered = tamperedFiles(status.stdout);
  if (tampered.length > 0) await restoreTree(side.env);
  const cov = await loadContainerCoverage(side.env.exec, flowId, [fx.cited.file]);
  return { run, tampered, cov, ms, flowId, step };
}

async function openSide(deps, head, root, tag) {
  const evidenceDir = path.join(root, tag);
  mkdirSync(evidenceDir, { recursive: true });
  const runId = randomBytes(4).toString('hex');
  const image = await deps.ensureImage({ head, imageSha: deps.imageSha, evidenceDir }, { cwd: deps.cwd });
  const env = await deps.startEnv({ head, flowsSha: deps.imageSha, imageSha: deps.imageSha, image: image.tag, flows: [], flowsDir: FLOWS_DIR, evidenceDir, runId }, { cwd: deps.cwd });
  if (env.skipped) throw new Error(`environment skipped: ${JSON.stringify(env.skipped)}`);
  return { env, evidenceDir, head, image: image.tag };
}

async function withSide(deps, head, root, tag, fn) {
  const side = await openSide(deps, head, root, tag);
  try { return await fn(side); } finally { await deps.stopEnv(side.env, { cwd: deps.cwd }).catch(() => {}); }
}

const mergeCov = (list) => ({ v8: list.flatMap((c) => c.v8), trace: list.map((c) => c.trace).filter(Boolean).join('\n') || null, sources: Object.assign({}, ...list.map((c) => c.sources)) });
const refHas = (git, ref, file) => git(['ls-tree', ref, '--', file]).stdout.trim() !== '';

/** G9 for new code: observed value, plus the cited file put back to its base content (or removed) and the probe run again. */
async function g9Evidence(side, fx, git, headRun, probeSource) {
  const file = fx.cited.file;
  const target = `/app/${file}`;
  const baseText = git(['show', `${fx.base}:${file}`]);
  const headText = git(['show', `${fx.head}:${file}`]).stdout;
  if (baseText.status === 0) await writeText(side.env, target, baseText.stdout);
  else await side.env.exec(['rm', '-f', '--', target], { cwd: '.', timeoutSec: 30 });
  const reverted = await runProbe(side, fx, 'rv');
  await writeText(side.env, target, headText);
  return {
    observedValue: observedValue(headRun.failLine, fx.declare.fireMatch, probeSource),
    hunkRevertChanged: hunkRevertChanged(headRun, reverted.run),
    revertedRun: reverted.run,
  };
}

async function headEvidence(side, fx, git, raw) {
  const runs = [];
  for (let k = 1; k <= fx.headRuns; k += 1) runs.push(await runProbe(side, fx, `h${k}`));
  for (const r of runs) raw[r.flowId] = { v8: r.cov.v8, trace: r.cov.trace };
  const baseReachable = fx.base ? refHas(git, fx.base, fx.cited.file) : true;
  const cited = runs.length > 0 ? makeCoverage(mergeCov(runs.map((r) => r.cov))).citedLinesExecuted(fx.cited.file, fx.cited.start, fx.cited.end) : null;
  const first = runs[0]?.run;
  const g9 = fx.g9 && first ? await g9Evidence(side, fx, git, first, fx.probe) : null;
  return {
    headRuns: runs.map((r) => r.run), cited, baseReachable, g9, tamper: runs.some((r) => r.tampered.length > 0), tamperedFiles: uniqueTampered(runs),
    citedPathExists: refHas(git, fx.head, fx.cited.file), dockerOk: true, wallMs: runs.map((r) => r.ms),
  };
}

const brief = (run) => (run ? { exitClass: run.exitClass, failLine: run.failLine } : null);

function rowOf(fx, ev, got) {
  return {
    id: fx.id, title: fx.title, expected: fx.expected, got: { verdict: got.verdict, rule: got.rule, reason: got.reason, false_confirm: got.false_confirm }, ok: matchesExpected(got, fx.expected),
    headRuns: ev.headRuns.map(brief), baseRun: brief(ev.baseRun), fixRun: brief(ev.fixRun), baseReachable: ev.baseReachable, citedLinesExecuted: ev.cited, cited: fx.cited,
    tamper: ev.tamper, tamperedFiles: ev.tamperedFiles, g9: ev.g9 ? { observedValue: ev.g9.observedValue, hunkRevertChanged: ev.g9.hunkRevertChanged } : null,
    wallMs: ev.wallMs,
  };
}

// ---------- coverage proof and overhead ----------

async function shProof(side, raw) {
  const fx = { id: 'cs-sh', cited: { file: 'scripts/cleanup-temp.sh' } };
  const flowId = 'cs-sh-h1';
  const flow = { ...flowFor(fx, flowId), steps: [{ action: { cmd: ['bash', 'scripts/cleanup-temp.sh', '--dry-run'], cwd: '.' }, checks: [{ text: 'runs', exit: 0 }] }] };
  const steps = [];
  await runFlows([flow], side.env, { evidenceDir: side.evidenceDir, now: () => new Date(), readFixture: () => null, coverage: [flowId], writeStep: (a) => { steps.push(a.result); return writeStepOutput(side.evidenceDir, a); } });
  const cov = await loadContainerCoverage(side.env.exec, flowId, []);
  raw[flowId] = { v8: cov.v8, trace: cov.trace };
  const c = makeCoverage(cov);
  return {
    script: 'bash scripts/cleanup-temp.sh --dry-run', exit: steps.at(-1)?.code ?? null, traceLines: (cov.trace ?? '').split('\n').filter(Boolean).length,
    echoDryRunLine14: c.citedLinesExecuted('scripts/cleanup-temp.sh', 14, 14), ifBodyLines31to36: c.citedLinesExecuted('scripts/cleanup-temp.sh', 31, 36),
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const S9_CMD = ['node', 'scripts/github/review-status.mjs', '--fixture', 'scripts/trex/bench/flows/S9/fixtures/outside-only.json', '--json'];

async function timedExec(env, envVars) {
  const flags = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
  const script = 's=$(date +%s%N); "$@" >/dev/null 2>&1; e=$(date +%s%N); echo $(( (e - s) / 1000000 ))';
  const r = await env.exec(['env', ...flags, 'sh', '-c', script, 'sh', ...S9_CMD], { cwd: '.', timeoutSec: 60 });
  return Number(String(r.stdout).trim());
}

/** Coverage overhead on the real S9 flow: in-container process time (node with and without NODE_V8_COVERAGE) and runFlows wall time. */
async function overhead(side, git, imageSha) {
  const reps = 7;
  const off = [];
  const on = [];
  for (let i = 0; i < reps; i += 1) {
    off.push(await timedExec(side.env, {}));
    on.push(await timedExec(side.env, { NODE_V8_COVERAGE: `/app/.verify/oh/cov-${i}` }));
  }
  const flow = loadFlows(git, imageSha, FLOWS_DIR).find((f) => f.id === 'outside-diff-no-sentence');
  const wall = async (coverage) => {
    const t0 = performance.now();
    await runFlows([flow], side.env, { evidenceDir: side.evidenceDir, now: () => new Date(), readFixture: () => null, coverage, writeStep: (a) => writeStepOutput(side.evidenceDir, a) });
    return Math.round(performance.now() - t0);
  };
  const flowOff = [];
  const flowOn = [];
  for (let i = 0; i < 3; i += 1) { flowOff.push(await wall(false)); flowOn.push(await wall(true)); }
  const mOff = median(off);
  const mOn = median(on);
  return {
    target: S9_CMD.join(' '), processMs: { reps, off, on, medianOff: mOff, medianOn: mOn, deltaMs: mOn - mOff, ratio: Number((mOn / mOff).toFixed(2)) },
    flowWallMs: { flow: 'outside-diff-no-sentence', reps: 3, off: flowOff, on: flowOn, medianOff: median(flowOff), medianOn: median(flowOn), deltaMs: median(flowOn) - median(flowOff) },
  };
}

// ---------- run ----------

async function dockerUp(deps) {
  const d = resolveDeps({ cwd: deps.cwd });
  const r = await d.docker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 });
  return r.code === 0 && !r.timedOut ? r.stdout.trim() : null;
}

/** Runs every fixture. Holds the TREX lock. Returns the full table. deps: realContainerDeps(...) plus git. */
export async function runAdversarial(deps, { outDir, only = null, withOverhead = true } = {}) {
  const git = deps.git;
  const fixtures = loadFixtures().filter((f) => only === null || f.id === only);
  if (fixtures.length === 0) throw new Error(`no fixture matches --only ${only}`);
  const root = path.join(outDir, `${DATE}-trex-verify-p0-adversarial-run`);
  const raw = {};
  const evidence = new Map();
  const extra = {};
  await withSide(deps, fixtures[0]?.head ?? '8b69c3e1', root, 'head', async (side) => {
    for (const fx of fixtures) {
      await writeText(side.env, `${probeDir(fx)}/probe.mjs`, fx.probe);
      evidence.set(fx.id, await headEvidence(side, fx, git, raw));
    }
    extra.shProof = await shProof(side, raw);
    if (withOverhead) extra.overhead = await overhead(side, git, deps.imageSha);
  });
  const jobs = [
    ...fixtures.filter((f) => f.runBase).map((fx) => ({ fx, sha: fx.base, key: 'baseRun', label: 'b1' })),
    ...fixtures.filter((f) => f.runFix).map((fx) => ({ fx, sha: fx.fix, key: 'fixRun', label: 'f1' })),
  ];
  for (const sha of [...new Set(jobs.map((j) => j.sha))]) {
    await withSide(deps, sha, root, `side-${sha}`, async (side) => {
      for (const job of jobs.filter((j) => j.sha === sha)) {
        await writeText(side.env, `${probeDir(job.fx)}/probe.mjs`, job.fx.probe);
        const r = await runProbe(side, job.fx, job.label);
        raw[r.flowId] = { v8: r.cov.v8, trace: r.cov.trace };
        evidence.get(job.fx.id)[job.key] = r.run;
      }
    });
  }
  const rows = fixtures.map((fx) => {
    const ev = evidence.get(fx.id);
    return rowOf(fx, ev, verdict(verdictInputFor(fx, ev)));
  });
  return { rows, raw, ...extra };
}

function parseArgs(argv) {
  const o = { out: path.join(REPO, '.claude', 'cache', 'e2e'), only: null, overhead: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') o.out = path.resolve(argv[++i]);
    else if (argv[i] === '--only') o.only = argv[++i];
    else if (argv[i] === '--no-overhead') o.overhead = false;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return o;
}

export async function main(argv) {
  const o = parseArgs(argv);
  const git = makeTrexGit(REPO);
  const deps = { ...realContainerDeps(git, REPO), git };
  const docker = await dockerUp(deps);
  if (!docker) { console.log('# adversarial: docker info did not answer in 20 s (env-down)'); return 3; }
  mkdirSync(o.out, { recursive: true });
  let result;
  try { result = await withTrexLock(deps, () => runAdversarial(deps, { outDir: o.out, only: o.only, withOverhead: o.overhead })); } catch (e) {
    console.log(`# adversarial: ${String(e.message).split('\n')[0]}`);
    return /lock is held/.test(e.message) ? 3 : 2;
  }
  const g = gateResult(result.rows, { folderCount: countFixtureDirs(), only: o.only });
  const table = { date: DATE, docker, imageSha: deps.imageSha, gate: g.label, gatePass: g.pass, ...result, raw: undefined };
  // A --only run is not the gate: it must not overwrite the gate artifact.
  const suffix = o.only === null ? '' : `-only-${o.only}`;
  writeFileSync(path.join(o.out, `${DATE}-trex-verify-p0-adversarial${suffix}.json`),`${JSON.stringify(table, null, 2)}\n`);
  writeFileSync(path.join(o.out, `${DATE}-trex-verify-p0-coverage-raw${suffix}.json`),`${JSON.stringify(result.raw, null, 1)}\n`);
  for (const r of result.rows) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}: expected ${r.expected.verdict}, got ${r.got.verdict} (${r.got.rule})`);
  console.log(o.only === null ? `# adversarial gate: ${g.label}` : `# adversarial ${g.label}`);
  return o.only === null ? (g.pass ? 0 : 1) : (g.allOk ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => process.exit(c));
