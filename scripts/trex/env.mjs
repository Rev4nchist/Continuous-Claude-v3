#!/usr/bin/env node
// The TREX environment: image tag, image build, compose project, head tree copy, grading overlay, database setup.
// Three SHAs stay apart (spec 13.3):
//   head     the code under test. Only its tree and its lockfiles come from here.
//   flowsSha the flows, specs and Playwright config that grade it (overlay).
//   imageSha the Dockerfile and compose files. A PR cannot edit its own image.
// Every docker, git and tar call goes through `deps`, so tests run without Docker.
//
// CLI: node scripts/trex/env.mjs --plan [--heads a,b] [--image-sha X] [--est-sec N]
//      node scripts/trex/env.mjs --build [--plan|--yes] [--heads a,b] [--image-sha X] [--evidence dir]
// --plan prints how many images would be built and the estimated seconds. It never builds.
// --build prints that plan, then builds the image of each head. It refuses without --plan or --yes.

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FLOWS_DIR, FLOW_SETS, IMAGE_SETS, archiveArgs, archiveInto, extractGrading, listGrading, tarBin,
} from './base.mjs';
import { makeTrexGit } from './lib/git.mjs';
import { dockerBin, pipeChildren, runChild } from './lib/proc.mjs';
import { stripEnv } from './lib/strip-env.mjs';

export { archiveArgs };

export const EST_BUILD_SEC = 600; // a guess until the first real build is timed (runtime spec probe 4)
const COMPOSE_MS = 5 * 60_000;
const COPY_MS = 5 * 60_000;
const BUILD_MS = 45 * 60_000;
const SETUP_SEC = 600;
const HEALTH_TRIES = 60;
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const BUILD_FILES = ['package.json', 'package-lock.json', 'apps/agentic-os/package.json', 'apps/agentic-os/package-lock.json'];
const LOCK_INPUTS = [
  { file: 'package-lock.json', side: 'head' },
  { file: 'apps/agentic-os/package-lock.json', side: 'head' },
  { file: 'docker/trex/Dockerfile', side: 'image' },
];

/** A failure of the environment. `stage` is build, start or seed (the blocker stages of the report). */
export class EnvError extends Error {
  constructor(stage, message) {
    super(message);
    this.name = 'EnvError';
    this.stage = stage;
  }
}

/** The default deps. `onSpawn(pid)` and `onExit(pid)` reach every docker and pipe child, so a caller can keep a pid sidecar (spec 13.3). */
export function resolveDeps(deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const bin = deps.bin ?? dockerBin();
  return {
    cwd,
    bin,
    git: makeTrexGit(cwd),
    docker: (args, opts = {}) => runChild(bin, args, { onSpawn: deps.onSpawn, onExit: deps.onExit, ...opts }),
    pipe: (a, b, opts = {}) => pipeChildren(a, b, { onSpawn: deps.onSpawn, onExit: deps.onExit, ...opts }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    mkdir: mkdirSync,
    writeFile: writeFileSync,
    clock: () => Date.now(),
    out: console.log,
    exit: process.exit,
    onSigint: (fn) => { process.once('SIGINT', fn); return () => process.off('SIGINT', fn); },
    ...deps,
  };
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const firstLine = (text) => String(text ?? '').trim().split(/\r?\n/)[0];

/** Throws an EnvError unless a docker result is a clean exit 0. */
function must(res, stage, label) {
  if (res.code === 0 && !res.timedOut) return res;
  const why = res.timedOut ? 'timed out' : `exit ${res.code}`;
  throw new EnvError(stage, `${label} failed (${why}): ${firstLine(res.stderr || res.error)}`);
}

// ---------- names, hashes and config checks ----------

function blobId(git, sha, file) {
  const r = git(['rev-parse', '--verify', `${sha}:${file}`]);
  return r.status === 0 ? r.stdout.trim() : 'absent'; // an old SHA may lack a lockfile
}

/**
 * A 12-hex tag for the image: the head root lockfile, the head app lockfile and the Dockerfile at imageSha.
 * A lockfile missing at head counts as "absent". An unknown head throws.
 */
export function lockHash(git, head, imageSha) {
  if (git(['rev-parse', '--verify', `${head}^{commit}`]).status !== 0) throw new Error(`unknown head commit ${head}`);
  const parts = LOCK_INPUTS.map((i) => `${i.file}=${blobId(git, i.side === 'head' ? head : imageSha, i.file)}`);
  return sha256(parts.join('\n')).slice(0, 12);
}

/** `trex-<pr>-<sha8>`, or `trex-sim-<sha8>` without a PR. The result is a valid compose project name. */
export function projectName({ pr, sha }) {
  const short = String(sha ?? '').toLowerCase().slice(0, 8);
  const label = pr === undefined || pr === null ? 'sim' : String(pr).toLowerCase();
  const name = `trex-${label}-${short}`;
  if (short.length < 8 || !/^[a-z0-9_-]+$/.test(name)) throw new Error(`cannot build a project name from pr=${pr} sha=${sha}`);
  return name;
}

/** Ports published on a non-loopback address. Same rule as docker/compose-loopback-probe.mjs. */
export function loopbackOffenders(configJson) {
  const config = typeof configJson === 'string' ? JSON.parse(configJson) : configJson;
  const offenders = [];
  for (const [name, service] of Object.entries(config?.services ?? {})) {
    for (const port of service.ports ?? []) {
      if (!LOOPBACK.has(port.host_ip)) offenders.push(`${name}: ${port.published} -> ${port.target} on ${port.host_ip || 'all interfaces'}`);
    }
  }
  return offenders;
}

/** The argv after the docker binary for one compose call. Every call names its project, so no call can touch another. `file` may be a list (the base file, then an override). */
export function composeArgv(project, file, ...rest) {
  if (!project) throw new Error('composeArgv needs a project name');
  return ['compose', '-p', project, ...[file].flat().flatMap((f) => ['-f', f]), ...rest];
}

const BENCH_ID = /^[A-Za-z0-9][\w.-]{0,63}$/;

/**
 * The compose override that adds the label trex.bench=<id> to every object of the base file (postgres, app and the network with a database;
 * the app alone without one). The base files carry only trex.run, so a bench-wide sweep needs this (spec 5.14 step 4, 13.3).
 */
export function benchOverride(benchRun, needsDb) {
  if (!BENCH_ID.test(benchRun)) throw new EnvError('start', 'TREX_BENCH_RUN is not a plain label value (letters, digits, dot, dash, underscore)');
  const labels = `    labels:\n      trex.bench: ${JSON.stringify(benchRun)}\n`;
  const services = needsDb ? `  postgres:\n${labels}  app:\n${labels}` : `  app:\n${labels}`;
  return `services:\n${services}${needsDb ? `networks:\n  trexnet:\n${labels}` : ''}`;
}

/** { "node:22": "sha256:...", ... } from every `name:tag@sha256:digest` in a Dockerfile or compose text. */
export function parseDigests(text) {
  const out = {};
  for (const m of text.matchAll(/([a-z0-9][\w./-]*:[\w.-]+)@(sha256:[0-9a-f]{64})/g)) out[m[1]] = m[2];
  return out;
}

const gitShow = (git, sha, file) => {
  const r = git(['show', `${sha}:${file}`]);
  return r.status === 0 ? r.stdout : null;
};

/** The pinned base image digests at imageSha. The run report copies them into envDigest. */
export function envDigests(git, imageSha) {
  const texts = ['docker/trex/Dockerfile', 'docker/trex/compose.yml'].map((f) => {
    const text = gitShow(git, imageSha, f);
    if (text === null) throw new EnvError('start', `${f} is missing at ${imageSha}`);
    return text;
  });
  return parseDigests(texts.join('\n'));
}

// ---------- image ----------

async function buildContext(d, { head, imageSha, ctxDir }) {
  const r = d.git(['ls-tree', '-r', '-z', '--name-only', head, '--', ...BUILD_FILES]);
  const files = r.status === 0 ? r.stdout.split('\0').filter(Boolean) : [];
  if (files.length > 0) await archiveInto(head, files, ctxDir, d);
  const cfg = await extractGrading(d.git, imageSha, ctxDir, null, { ...d, sets: IMAGE_SETS });
  if (cfg.skipped) throw new EnvError('build', `docker/trex is missing at ${imageSha}`);
}

/**
 * Finds the image for this head, or builds it. Returns { tag, built }.
 * The context is the head lockfiles plus docker/trex from imageSha, in <evidenceDir>/build-ctx.
 * Build output goes to <evidenceDir>/build.log. No secret is passed.
 */
export async function ensureImage({ head, imageSha, evidenceDir }, deps = {}) {
  const d = resolveDeps(deps);
  const tag = `trex:${lockHash(d.git, head, imageSha)}`;
  if ((await d.docker(['image', 'inspect', tag])).code === 0) return { tag, built: false };
  const ctxDir = path.join(evidenceDir, 'build-ctx');
  await buildContext(d, { head, imageSha, ctxDir });
  const dockerfile = path.join(ctxDir, 'docker', 'trex', 'Dockerfile');
  const res = await d.docker(['build', '-t', tag, '-f', dockerfile, ctxDir], { logPath: path.join(evidenceDir, 'build.log'), timeoutMs: BUILD_MS });
  must(res, 'build', `docker build ${tag}`);
  return { tag, built: true };
}

/** The image tag of each head, in order (repeats stay). Bench preflight checks these tags exist before a run. */
export function imageTagsFor(git, heads, imageSha) {
  return heads.map((head) => `trex:${lockHash(git, head, imageSha)}`);
}

/** True when docker has the image. deps: the same as resolveDeps. */
export async function imageExists(tag, deps = {}) {
  const d = resolveDeps(deps);
  return (await d.docker(['image', 'inspect', tag])).code === 0;
}

/** What an image build would cost, without building. */
export async function planBuilds({ git, heads, imageSha, hasImage, estSec = EST_BUILD_SEC }) {
  const byTag = new Map();
  for (const head of heads) {
    const tag = `trex:${lockHash(git, head, imageSha)}`;
    byTag.set(tag, [...(byTag.get(tag) ?? []), head]);
  }
  const images = [];
  for (const [tag, tagHeads] of byTag) images.push({ tag, heads: tagHeads, exists: await hasImage(tag) });
  const toBuild = images.filter((i) => !i.exists).length;
  return { total: images.length, toBuild, estSeconds: toBuild * estSec, images };
}

// ---------- start ----------

function makeCtx(opts, d) {
  const { pr, head, image, runId = randomBytes(4).toString('hex'), evidenceDir, flows = [] } = opts;
  const needsDb = flows.some((f) => f.needs?.includes('db'));
  const project = projectName({ pr, sha: head });
  const dbPw = randomBytes(16).toString('hex');
  const file = path.join(evidenceDir, 'cfg', 'docker', 'trex', needsDb ? 'compose.yml' : 'compose.none.yml');
  const benchRun = opts.benchRun ?? process.env.TREX_BENCH_RUN;
  const benchFile = benchRun ? path.join(evidenceDir, 'cfg', 'docker', 'trex', 'compose.bench.yml') : null;
  const childEnv = { ...stripEnv(process.env), TREX_RUN_ID: runId, TREX_IMAGE: image, TREX_DB_PW: dbPw };
  return {
    project, runId, needsDb, dbPw, childEnv, composeFile: benchFile ? [file, benchFile] : file, benchFile, benchRun,
    app: `${project}-app-1`, pg: `${project}-postgres-1`,
    appPw: randomBytes(16).toString('hex'), indexerPw: randomBytes(16).toString('hex'),
    d,
  };
}

const compose = (ctx, ...rest) => ctx.d.docker(composeArgv(ctx.project, ctx.composeFile, ...rest), { env: ctx.childEnv, timeoutMs: COMPOSE_MS });

async function copyIn(ctx, sha, files) {
  const { d } = ctx;
  const a = { cmd: 'git', args: archiveArgs(sha, files), cwd: d.cwd };
  const b = { cmd: d.bin, args: ['cp', '-', `${ctx.app}:/app`] };
  const r = await d.pipe(a, b, { cwd: d.cwd, timeoutMs: COPY_MS });
  if (r.codeA !== 0 || r.codeB !== 0) throw new EnvError('start', `copy of ${sha.slice(0, 8)} into ${ctx.app} failed (git ${r.codeA}, docker ${r.codeB}): ${firstLine(r.stderrA || r.stderrB)}`);
}

async function checkLoopback(ctx) {
  const res = must(await compose(ctx, 'config', '--format', 'json'), 'start', 'compose config');
  const bad = loopbackOffenders(res.stdout);
  if (bad.length > 0) throw new EnvError('start', `ports on a non-loopback address: ${bad.join('; ')}`);
}

async function waitHealthy(ctx) {
  const args = ['inspect', '--format', '{{.State.Health.Status}}', ctx.pg];
  for (let i = 0; i < HEALTH_TRIES; i += 1) {
    const r = await ctx.d.docker(args, { timeoutMs: 30_000 });
    if (r.stdout.trim() === 'healthy') return;
    await ctx.d.sleep(2000);
  }
  throw new EnvError('start', `${ctx.pg} did not become healthy`);
}

/** `docker exec` argv inside the app container. The command runs under `timeout -s KILL`, because killing the CLI does not stop it. */
function execArgs(ctx, argv, { cwd = '.', timeoutSec = 60, stdin, env = {} } = {}) {
  const dir = path.posix.join('/app', cwd);
  if (dir !== '/app' && !dir.startsWith('/app/')) throw new Error(`exec cwd escapes /app: ${cwd}`);
  const flags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const db = ctx.needsDb ? ['-e', 'AGENTIC_OS_DATABASE_URL'] : [];
  return ['exec', ...(stdin === undefined ? [] : ['-i']), '-w', dir, ...flags, ...db, ctx.app, 'timeout', '-s', 'KILL', String(timeoutSec), ...argv];
}

const appDbUrl = (ctx) => `postgres://agentic_os_app:${ctx.appPw}@postgres:5432/continuous_claude`;
const adminDbUrl = (ctx) => `postgres://claude:${ctx.dbPw}@postgres:5432/continuous_claude`;

const psql = (ctx, stdin, label, stage = 'seed') => ctx.d.docker(
  ['exec', '-i', ctx.pg, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'claude', '-d', 'continuous_claude', '-f', '-'],
  { stdin, env: ctx.childEnv, timeoutMs: COMPOSE_MS },
).then((res) => must(res, stage, label));

function rolesSql(ctx, { head, imageSha }) {
  const { git } = ctx.d;
  const sql = gitShow(git, head, 'apps/agentic-os/scripts/provision-roles.sql') ?? gitShow(git, imageSha, 'docker/trex/roles-min.sql');
  if (sql === null) throw new EnvError('seed', 'no provision-roles.sql at head and no roles-min.sql at imageSha');
  // The passwords travel on stdin as psql variables, so they never appear in a process argv.
  return `\\set app_pw '${ctx.appPw}'\n\\set indexer_pw '${ctx.indexerPw}'\n\\set finish COMMIT\n${sql}`;
}

async function runSeeds(ctx, flows) {
  const seeds = [...new Set(flows.map((f) => f.start?.db).filter(Boolean))];
  for (const seed of seeds) {
    const cat = await ctx.d.docker(execArgs(ctx, ['cat', `/app/${seed}`]), { env: ctx.childEnv, timeoutMs: 60_000 });
    must(cat, 'seed', `read seed ${seed}`);
    await psql(ctx, cat.stdout, `load seed ${seed}`);
  }
}

async function setupDb(ctx, opts) {
  const { d } = ctx;
  const schema = gitShow(d.git, opts.head, 'docker/init-schema.sql');
  if (schema === null) throw new EnvError('seed', `docker/init-schema.sql is missing at ${opts.head}`);
  await psql(ctx, schema, 'load init-schema.sql');
  const migrate = execArgs(ctx, ['npx', 'drizzle-kit', 'migrate'], { cwd: 'apps/agentic-os', timeoutSec: SETUP_SEC });
  // The URL travels in the docker client env (-e NAME without a value), so the password is not in any argv.
  const res = await d.docker(migrate, { env: { ...ctx.childEnv, AGENTIC_OS_DATABASE_URL: adminDbUrl(ctx) }, timeoutMs: (SETUP_SEC + 30) * 1000 });
  must(res, 'seed', 'drizzle-kit migrate');
  await psql(ctx, rolesSql(ctx, opts), 'provision roles');
  await runSeeds(ctx, opts.flows ?? []);
}

async function bringUp(ctx, opts, overlay) {
  must(await compose(ctx, 'create'), 'start', 'compose create');
  await copyIn(ctx, opts.head, []);
  await copyIn(ctx, opts.flowsSha, overlay);
  must(await compose(ctx, 'start'), 'start', 'compose start');
  if (!ctx.needsDb) return;
  await waitHealthy(ctx);
  await setupDb(ctx, opts);
}

async function cpOut(ctx, src, dest) {
  const { d } = ctx;
  d.mkdir(dest, { recursive: true });
  const a = { cmd: d.bin, args: ['cp', `${ctx.app}:${src}`, '-'] };
  const b = { cmd: d.tar ?? tarBin(d.env ?? process.env), args: ['-xf', '-', '-C', dest] };
  const r = await d.pipe(a, b, { cwd: d.cwd, timeoutMs: COPY_MS });
  return { ok: r.codeA === 0 && r.codeB === 0 && hasEntries(d, dest) };
}

/** True when tar put something in dest. A tar can exit 0 and extract nothing. */
function hasEntries(d, dest) {
  try { return (d.readdir ?? readdirSync)(dest).length > 0; } catch { return false; }
}

/**
 * Reads a docker exec result against its budget. `timeout -s KILL` inside the container fires before the
 * docker CLI timer, so a hang comes back as 137 (or 124) with timedOut false. After the full budget that is
 * a time-out. An earlier 137 is the kernel OOM killer, marked oom:true (the field toStepResult reads) and reason 'oom_killed'.
 */
export function classifyExec(res, timeoutSec, elapsedMs) {
  if (res.timedOut || (res.code !== 137 && res.code !== 124)) return res;
  if (elapsedMs >= timeoutSec * 1000) return { ...res, timedOut: true };
  return res.code === 137 ? { ...res, oom: true, reason: 'oom_killed' } : res;
}

/** One exec in the app container. It counts OOM kills on the env, so the runner can report a blocker. */
async function execIn(ctx, env, argv, o) {
  const t0 = ctx.d.clock();
  const res = await ctx.d.docker(execArgs(ctx, argv, o), {
    env: ctx.needsDb ? { ...ctx.childEnv, AGENTIC_OS_DATABASE_URL: appDbUrl(ctx) } : ctx.childEnv,
    stdin: o.stdin, timeoutMs: ((o.timeoutSec ?? 60) + 15) * 1000,
  });
  const out = classifyExec(res, o.timeoutSec ?? 60, ctx.d.clock() - t0);
  if (out.oom === true) env.oomHits += 1;
  return out;
}

function makeEnv(ctx, opts) {
  const env = {
    project: ctx.project, app: ctx.app, runId: ctx.runId, composeFile: ctx.composeFile, childEnv: ctx.childEnv,
    dbUrl: ctx.needsDb ? appDbUrl(ctx) : null, dbPort: null, digest: envDigests(ctx.d.git, opts.imageSha), d: ctx.d,
    oomHits: 0, // exec results killed early with 137; run.mjs turns a non-zero count into an OOM blocker
    cpOut: (src, dest) => cpOut(ctx, src, dest),
  };
  env.exec = (argv, o = {}) => execIn(ctx, env, argv, o);
  return env;
}

/** Takes down this run's project only. It never throws. */
export async function stopEnv(env, deps = {}) {
  const d = env.d ?? resolveDeps(deps);
  const res = await d.docker(composeArgv(env.project, env.composeFile, 'down', '-v', '--remove-orphans'), { env: env.childEnv, timeoutMs: COMPOSE_MS });
  return { ok: res.code === 0 };
}

/**
 * Starts the environment for one run. Returns an Env, or { skipped: { reason: 'no_config' } } when
 * flowsSha has no grading files (nothing is started then).
 * opts: { pr?, head, flowsSha, imageSha, image, flows, flowsDir?, evidenceDir, runId? }
 * The head tree enters through `git archive | docker cp -`; the grading overlay comes from flowsSha.
 */
export async function startEnv(opts, deps = {}) {
  const d = resolveDeps(deps);
  const overlay = listGrading(d.git, opts.flowsSha, opts.flowsDir ?? DEFAULT_FLOWS_DIR, FLOW_SETS);
  if (overlay.length === 0) return { skipped: { reason: 'no_config' } };
  const ctx = makeCtx(opts, d);
  const cfgDir = path.join(opts.evidenceDir, 'cfg');
  const cfg = await extractGrading(d.git, opts.imageSha, cfgDir, null, { ...d, sets: IMAGE_SETS });
  if (cfg.skipped) throw new EnvError('start', `docker/trex is missing at ${opts.imageSha}`);
  if (ctx.benchFile) d.writeFile(ctx.benchFile, benchOverride(ctx.benchRun, ctx.needsDb));
  await checkLoopback(ctx);
  await compose(ctx, 'down', '-v', '--remove-orphans');
  try {
    await bringUp(ctx, opts, overlay);
    return makeEnv(ctx, opts);
  } catch (err) {
    await stopEnv({ ...ctx, d }, d);
    throw err;
  }
}

/** Runs fn(env) and always tears the project down, also on SIGINT. A skipped start returns the skip. */
export async function withEnv(opts, deps, fn) {
  const d = resolveDeps(deps);
  const env = await startEnv(opts, d);
  if (env.skipped) return env;
  const off = d.onSigint(async () => { await stopEnv(env, d); d.exit(130); });
  try {
    return await fn(env);
  } finally {
    off();
    await stopEnv(env, d);
  }
}

/** Removes containers and networks that carry <key>=<id>: trex.run=<runId> (default, after a bench time-out: spec 13.3) or trex.bench=<benchRun> (bench-wide sweep). */
export async function removeByLabel(runId, deps = {}, key = 'trex.run') {
  if (!runId) throw new Error('removeByLabel needs a runId');
  const d = resolveDeps(deps);
  const filter = ['--filter', `label=${key}=${runId}`];
  const ids = async (args) => (await d.docker(args, { timeoutMs: 60_000 })).stdout.split(/\s+/).filter(Boolean);
  const containers = await ids(['ps', '-aq', ...filter]);
  if (containers.length > 0) await d.docker(['rm', '-f', ...containers], { timeoutMs: 120_000 });
  const networks = await ids(['network', 'ls', '-q', ...filter]);
  if (networks.length > 0) await d.docker(['network', 'rm', ...networks], { timeoutMs: 60_000 });
  return { containers: containers.length, networks: networks.length };
}

// ---------- host profile ----------

/** True when head is an ancestor of ref (default fork/main, never local main). Other git errors throw. */
export function isMerged(git, head, ref = 'fork/main') {
  const r = git(['merge-base', '--is-ancestor', head, ref]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(`cannot check whether ${head} is merged into ${ref}: ${firstLine(r.stderr)}`);
}

/**
 * Prepares a host-profile run. Host flows never run PR code or PR flows: head and flowsSha must both be merged,
 * or the run is skipped host_unmerged. imageSha is not checked: host flows never use the image, and spec 13.3 lets
 * --image-sha carry an unmerged post-freeze T1 fix.
 * Otherwise it unpacks the head tree and the flowsSha overlay under <evidenceDir>/host-tree.
 * Returns { treeDir, env } with a stripped env, or { skipped }.
 */
export async function prepareHost({ head, flowsSha, evidenceDir, flowsDir, ref }, deps = {}) {
  const d = resolveDeps(deps);
  const shas = new Set([head, flowsSha]);
  if (![...shas].every((sha) => isMerged(d.git, sha, ref))) return { skipped: { reason: 'host_unmerged' } };
  const treeDir = path.join(evidenceDir, 'host-tree');
  await archiveInto(head, [], treeDir, d);
  const grading = await extractGrading(d.git, flowsSha, treeDir, flowsDir ?? DEFAULT_FLOWS_DIR, { ...d, sets: FLOW_SETS });
  if (grading.skipped) return { skipped: grading.skipped };
  return { treeDir, env: stripEnv(process.env) };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = { plan: false, build: false, yes: false, heads: ['HEAD'], imageSha: 'HEAD', estSec: EST_BUILD_SEC, evidence: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--plan') opts.plan = true;
    else if (argv[i] === '--build') opts.build = true;
    else if (argv[i] === '--yes') opts.yes = true;
    else if (argv[i] === '--heads') opts.heads = String(argv[++i]).split(',').filter(Boolean);
    else if (argv[i] === '--image-sha') opts.imageSha = argv[++i];
    else if (argv[i] === '--evidence') opts.evidence = argv[++i];
    else if (argv[i] === '--est-sec') opts.estSec = Number(argv[++i]);
  }
  return opts;
}

export function planLines(plan) {
  const noun = plan.total === 1 ? 'image' : 'images';
  const head = `trex plan: ${plan.toBuild} of ${plan.total} ${noun} to build, estimated ${plan.estSeconds} s`;
  return [head, ...plan.images.map((i) => `  ${i.tag} ${i.exists ? 'present' : 'to build'} (${i.heads.length} head${i.heads.length === 1 ? '' : 's'})`)];
}

async function printPlan(d, opts) {
  const hasImage = (tag) => imageExists(tag, d);
  const plan = await planBuilds({ git: d.git, heads: opts.heads, imageSha: opts.imageSha, hasImage, estSec: opts.estSec });
  for (const line of planLines(plan)) d.out(line);
}

/** Builds the image of each head outside any run. The plan is already printed; the build needs --plan or --yes. */
async function doBuild(d, opts) {
  if (!opts.plan && !opts.yes) {
    d.out('trex build: refused, pass --plan with --build or pass --yes');
    return 2;
  }
  const root = opts.evidence ?? path.join(d.cwd, '.claude', 'cache', 'e2e', 'trex', 'build');
  for (const head of opts.heads) {
    const t0 = d.clock();
    const evidenceDir = path.join(root, head.replace(/[^\w.-]/g, '_').slice(0, 12));
    const r = await ensureImage({ head, imageSha: opts.imageSha, evidenceDir }, d);
    d.out(`${r.tag} ${r.built ? 'built' : 'present'} ${Math.round((d.clock() - t0) / 1000)} s`);
  }
  return 0;
}

/** Returns an exit code. 0 done, 1 a build failed, 2 bad usage, bad input or a refused build. */
export async function main(argv, deps = {}) {
  const d = resolveDeps(deps);
  const opts = parseArgs(argv);
  if (!(opts.plan || opts.build) || !Number.isFinite(opts.estSec)) {
    d.out('usage: node scripts/trex/env.mjs --plan|--build [--yes] [--heads a,b] [--image-sha X] [--est-sec N] [--evidence dir]');
    return 2;
  }
  try {
    await printPlan(d, opts);
    return opts.build ? await doBuild(d, opts) : 0;
  } catch (err) {
    d.out(`trex ${opts.build ? 'build' : 'plan'}: stopped (${firstLine(err.message)})`);
    return err instanceof EnvError ? 1 : 2;
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) main(process.argv.slice(2)).then((code) => process.exit(code));
