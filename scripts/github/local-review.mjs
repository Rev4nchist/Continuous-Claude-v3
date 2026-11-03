#!/usr/bin/env node
/**
 * local-review.mjs: the local review engine core (spec .claudedocs/2026-11-02-review-engine-p1-engine-core-spec.md, sections 1 and 2,
 * with section 13 of .claudedocs/2026-11-02-local-review-engine-spec.md overriding it).
 *
 * Usage: node scripts/github/local-review.mjs --pr <n> [--fresh] [--gates <pre-pr log>] [--json] [--engine-here] [--tldr] [--repo owner/name]
 *
 * Run without LOCAL_REVIEW_PINNED, it pins the engine first: it extracts scripts/ and review-router.config.json at fork/main to
 * <state>/local-review/engine/<sha>/ and starts that copy as a child process. The pinned process refuses (exit 2) when its own file is
 * not under engine/<sha>/. --engine-here (tests only) runs from the current tree and writes trusted:false.
 *
 * One review of one PR head (reviewHead): skip rules, band route, full or delta range, a slot, the review tree, CONTEXT.md and
 * PROMPT.md, a cap-checked agent run with one retry, the S5 filter, then an append-only record and the ledger end line.
 * P1 records `escalate` only. It posts no label and starts no critic or CodeRabbit run. It never writes coderabbit-paid.jsonl.
 *
 * Exit codes: 0 ok or skip, 1 failed, 2 refused, 3 cap or busy.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BAND_MODEL, DEFAULT_REPO, EXIT, buildAgentEnv, finishRun, isExcluded, parseReviewOutput, prepareReview, reserveRun,
  resolveAgent, runAgent,
} from './cursor-review.mjs';
import { pidAlive, withLock } from './lib/file-lock.mjs';
import { buildContext, readAtSha } from './local-review/context.mjs';
import { buildEnginePrompt, lastJsonBlock, PROMPT_PATH } from './local-review/prompt.mjs';
import {
  branchSlug, listRecords, lastReviewedSha, settlePrior, stateRoot as recordsRoot, writeRecord,
} from './local-review/record.mjs';
import {
  SEVERITY_RANK, filterFindings, findingId, isIgnoreFile, isStrippedFile, mapLine, parseHunks, rangeTouched, stripIgnoreFiles,
} from './review-filter.mjs';
import { bandOf } from './review-router.mjs';

const MIN = 60_000;
const SLOT_POLL_MS = 15_000;
const SLOT_GRACE_MS = 10 * MIN;
const TMP_GRACE_MS = 30 * MIN;
const KEEP_ENGINES = 3;
const SHA40 = /^[0-9a-f]{40}$/;
const RESERVED_SLUGS = new Set(['engine']);
const ENV_DROP = Object.freeze(['ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN']);

/** Engine files whose blob must equal fork/main:<path> for trusted:true (13.3). Paths are relative to the engine root. */
export const ENGINE_FILES = Object.freeze([
  'scripts/github/local-review.mjs', 'scripts/github/cursor-review.mjs', 'scripts/github/review-filter.mjs', 'scripts/github/review-router.mjs',
  'scripts/github/review-status.mjs', 'scripts/github/local-review/context.mjs', 'scripts/github/local-review/prompt.mjs',
  'scripts/github/local-review/record.mjs', 'scripts/github/lib/file-lock.mjs', 'scripts/github/lib/proc.mjs',
  'scripts/ratchets/review-skip-sync.mjs', 'review-router.config.json',
]);

/** The landed local_review block (review-router.config.json). A missing block uses these. */
export const LOCAL_REVIEW_DEFAULTS = Object.freeze({
  enabled: true, bands: ['MID', 'ELEVATED', 'HIGH', 'CRITICAL'], max_concurrent: 2, per_branch_cap: 8, retry_max: 1, slot_wait_min: 5,
  timeout_min: 20, thread_min_confidence: 3, context_cap_kb: 48, skip_authors: ['dependabot[bot]'], headless_daily_cap: 30,
});
const KINDS = {
  enabled: 'bool', bands: 'strings', skip_authors: 'strings', max_concurrent: 'pos', per_branch_cap: 'pos', retry_max: 'nonneg',
  slot_wait_min: 'nonneg', timeout_min: 'pos', thread_min_confidence: 'pos', context_cap_kb: 'pos', headless_daily_cap: 'pos',
};
const KIND_OK = {
  bool: (v) => typeof v === 'boolean',
  strings: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  pos: (v) => Number.isInteger(v) && v > 0,
  nonneg: (v) => Number.isInteger(v) && v >= 0,
};

const badInput = (msg) => Object.assign(new Error(msg), { code: 'BAD_INPUT' });
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 3)}...` : String(s));
const splitZ = (t) => String(t ?? '').split('\0').filter(Boolean);

// ---------- config ----------

/** { ok, cfg, full } or { ok:false, reason }. A missing local_review block uses the defaults; a wrong type is refused. */
export function loadConfig(file, read = (f) => readFileSync(f, 'utf8')) {
  let full;
  try { full = JSON.parse(read(file)); } catch (err) { return { ok: false, reason: `cannot read ${file}: ${err.message}` }; }
  const block = full?.local_review ?? {};
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return { ok: false, reason: 'local_review must be an object' };
  for (const [key, kind] of Object.entries(KINDS)) {
    if (key in block && !KIND_OK[kind](block[key])) return { ok: false, reason: `local_review.${key} has the wrong type (${kind})` };
  }
  return { ok: true, cfg: { ...LOCAL_REVIEW_DEFAULTS, ...block }, full };
}

// ---------- state paths, git, gh ----------

/** Every state path. records = the injectable root (record.mjs stateRoot); the other files sit next to it so a slug folder never collides. */
function statePaths(deps, env) {
  const records = recordsRoot({ stateRoot: deps.stateRoot, env });
  const aux = deps.stateDir ?? path.dirname(records);
  return {
    records, aux, engineRoot: path.join(records, 'engine'),
    slots: path.join(aux, 'local-review-slots.json'),
    ledger: path.join(aux, 'local-review-ledger.jsonl'),
    fetchLock: path.join(aux, 'local-review-fetch'),
    cursorLedger: deps.cursorLedger ?? env.CURSOR_REVIEW_LEDGER ?? path.join(aux, 'cursor-review-ledger.jsonl'),
  };
}

function defaultGit(root) {
  return (args, { input, env } = {}) => {
    const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: root, input, encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env,
    });
    if (r.error) return { status: null, stdout: '', stderr: r.error.message };
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

function gitOut(git, args, opts) {
  const r = git(args, opts);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr ?? '').trim()}`);
  return r.stdout;
}

function defaultGh(repo) {
  return (args) => {
    const personal = path.join(os.homedir(), '.config', 'gh-personal');
    const dir = process.env.GH_CONFIG_DIR || (existsSync(personal) ? personal : undefined);
    const env = { ...process.env, ...(dir ? { GH_CONFIG_DIR: dir } : {}) };
    const out = execFileSync('gh', args, { encoding: 'utf8', env, timeout: 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(out);
  };
}

/** Fetch under the fetch lock; one retry when git reports index.lock. Returns the git result, or { status:null, stderr } on a lock refusal. */
function fetchLocked(d, args) {
  mkdirSync(path.dirname(d.fetchLock), { recursive: true });
  const attempt = () => d.withLock(d.fetchLock, { lockWaitMs: 120_000, lockStaleMs: 120_000 }, () => d.git(['fetch', '--quiet', ...args]));
  let r = attempt();
  if (r?.ok === false) return { status: null, stderr: r.detail ?? 'the fetch lock is held' };
  if (r.status !== 0 && /index\.lock/.test(r.stderr ?? '')) r = attempt();
  return r?.ok === false ? { status: null, stderr: r.detail ?? 'the fetch lock is held' } : r;
}

// ---------- pinEngine ----------

const blobSha = (file) => {
  try {
    const buf = readFileSync(file);
    return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
  } catch { return null; }
};

/** Every file under dir as Map<"rel/path", git blob sha>. */
function blobMap(dir, rel = '', out = new Map()) {
  for (const ent of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) blobMap(dir, childRel, out);
    else out.set(childRel, blobSha(path.join(dir, childRel)));
  }
  return out;
}

/**
 * True when dir holds exactly the engine files of commit `sha`: same paths, same blobs (`git ls-tree -r`). A pinned folder that someone edited,
 * trimmed or added to is not intact (13.3), so the code that runs is always the fork/main blob.
 */
function engineIntact({ git, sha, dir }) {
  const r = git(['ls-tree', '-r', '-z', sha, '--', 'scripts', 'review-router.config.json']);
  if (r.status !== 0) return false;
  const want = new Map(splitZ(r.stdout).map((e) => /^\d+ blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(e)).map((m) => (m ? [m[2], m[1]] : [null, null])));
  try {
    const have = blobMap(dir);
    return have.size === want.size && [...want].every(([p, b]) => b !== null && have.get(p) === b);
  } catch { return false; }
}

/** Puts the staged engine at dir. A folder already there is kept when it is intact (another run won the race), else moved aside into work. */
function placeEngine({ stage, dir, work, intact }) {
  if (existsSync(dir)) {
    if (intact()) return;
    renameSync(dir, path.join(work, 'replaced'));
  }
  try { renameSync(stage, dir); } catch (err) { if (!(existsSync(dir) && intact())) throw err; }
}

function extractEngine({ git, sha, dir, engineRoot }) {
  mkdirSync(engineRoot, { recursive: true });
  const work = mkdtempSync(path.join(engineRoot, '.tmp-'));
  const stage = path.join(work, 'tree');
  try {
    const env = { GIT_INDEX_FILE: path.join(work, 'index') };
    gitOut(git, ['read-tree', sha], { env });
    const list = gitOut(git, ['ls-files', '-z', '--', 'scripts', 'review-router.config.json'], { env });
    if (!splitZ(list).includes('scripts/github/local-review.mjs')) return { ok: false, reason: `fork/main (${sha}) holds no review engine` };
    gitOut(git, ['checkout-index', '-f', '-z', '--stdin', `--prefix=${stage.replaceAll('\\', '/')}/`], { env, input: list });
    placeEngine({ stage, dir, work, intact: () => engineIntact({ git, sha, dir }) });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `engine extract failed: ${err.message}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Keeps the newest `keep` engine folders (and `current`). Folders are named by sha; temp folders start with a dot. */
function pruneEngines(engineRoot, keep, current) {
  let names = [];
  try { names = readdirSync(engineRoot).filter((n) => SHA40.test(n)); } catch { return; }
  const aged = names.map((n) => ({ n, t: statSync(path.join(engineRoot, n)).mtimeMs })).sort((a, b) => b.t - a.t);
  const keepSet = new Set([current, ...aged.slice(0, keep).map((x) => x.n)]);
  for (const { n } of aged) if (!keepSet.has(n)) rmSync(path.join(engineRoot, n), { recursive: true, force: true });
}

/**
 * Pins the engine: fetch fork main (under the fetch lock), extract scripts/ + review-router.config.json at fork/main into
 * <engineRoot>/<sha>/, keep 3 folders. { ok, engineSha, dir, warning? } or { ok:false, reason }.
 * deps (tests): { git, withLock, stateRoot, stateDir, remote }.
 */
export function pinEngine({ root, env = process.env } = {}, deps = {}) {
  const P = statePaths(deps, env);
  const d = { git: deps.git ?? defaultGit(root), withLock: deps.withLock ?? withLock, fetchLock: P.fetchLock };
  const remote = deps.remote ?? 'fork';
  const fetched = fetchLocked(d, [remote, 'main']);
  const warning = fetched.status === 0 ? undefined : `fetch ${remote} main failed, the last fetched ref is used: ${clip(String(fetched.stderr ?? '').trim(), 200)}`;
  const sha = String(d.git(['rev-parse', '--verify', '--quiet', `${remote}/main^{commit}`]).stdout ?? '').trim();
  if (!SHA40.test(sha)) return { ok: false, reason: `cannot resolve ${remote}/main` };
  const dir = path.join(P.engineRoot, sha);
  if (existsSync(dir) && engineIntact({ git: d.git, sha, dir })) {
    try { const t = new Date(); utimesSync(dir, t, t); } catch { /* best effort */ }
  } else {
    const x = extractEngine({ git: d.git, sha, dir, engineRoot: P.engineRoot });
    if (!x.ok) return x;
  }
  pruneEngines(P.engineRoot, KEEP_ENGINES, sha);
  return { ok: true, engineSha: sha, dir, ...(warning ? { warning } : {}) };
}

const realOr = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };

/** True when selfPath sits strictly under <engineRoot>/<sha>/. */
function underPinned(selfPath, engineRoot, sha) {
  const rel = path.relative(realOr(path.join(engineRoot, sha)), realOr(selfPath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The pin rule. LOCAL_REVIEW_PINNED=<sha> needs selfPath under engine/<sha>/ (else refused). With no pin, only --engine-here runs (trusted:false).
 * { ok, pinned, engineSha } or { ok:false, reason }.
 */
export function checkPin({ env = process.env, selfPath, engineRoot, engineHere = false }) {
  const sha = env.LOCAL_REVIEW_PINNED;
  if (sha) {
    if (!SHA40.test(sha)) return { ok: false, reason: `LOCAL_REVIEW_PINNED is not a 40-character sha: ${clip(sha, 60)}` };
    if (!underPinned(selfPath, engineRoot, sha)) return { ok: false, reason: `this process runs from ${selfPath}, not from ${path.join(engineRoot, sha)}: refused` };
    return { ok: true, pinned: true, engineSha: sha };
  }
  if (engineHere) return { ok: true, pinned: false, engineSha: null };
  return { ok: false, reason: 'not started from a pinned engine copy: run without LOCAL_REVIEW_PINNED so the engine pins itself, or pass --engine-here (tests only)' };
}

/** trusted:true needs every engine file blob to equal `git rev-parse fork/main:<path>` (13.3). */
export function computeTrust({ selfRoot, git, remote = 'fork', files = ENGINE_FILES }) {
  const r = git(['rev-parse', ...files.map((f) => `${remote}/main:${f}`)]);
  const want = r.status === 0 ? String(r.stdout).split(/\r?\n/).filter(Boolean) : [];
  const mismatched = files.filter((f, i) => {
    const have = blobSha(path.join(selfRoot, f));
    return have === null || have !== want[i];
  });
  return { trusted: mismatched.length === 0, mismatched };
}

// ---------- resolveTarget ----------

/** [{ filename, previous_filename? }] from `git diff --name-status -M -z`. */
export function parseNameStatus(text) {
  const t = String(text ?? '').split('\0');
  const out = [];
  for (let i = 0; i < t.length && t[i] !== '';) {
    const status = t[i++];
    if (/^[RC]/.test(status)) { const oldName = t[i++]; out.push({ filename: t[i++], previous_filename: oldName }); } else out.push({ filename: t[i++] });
  }
  return out.filter((f) => f.filename);
}

function ensureCommit(d, sha, refs) {
  const have = () => d.git(['cat-file', '-e', `${sha}^{commit}`]).status === 0;
  for (const ref of refs) {
    if (have()) return;
    fetchLocked(d, [d.remote, ref]);
  }
  if (!have()) throw badInput(`commit ${sha} is not available after fetch`);
}

function fetchDeps(root, deps, env) {
  const P = statePaths(deps, env);
  return { git: deps.git ?? defaultGit(root), withLock: deps.withLock ?? withLock, fetchLock: P.fetchLock, remote: deps.remote ?? 'fork' };
}

/**
 * One gh read of the PR, then the commits (fetched under the fetch lock when missing), the merge base and the changed files
 * (`git diff --name-status -M -z`, minus TREE_EXCLUDES). Throws BAD_INPUT when gh returns no head or base.
 * -> { pr, head, pullBaseSha, mergeBase, pull, files, branch }
 */
export async function resolveTarget({ root, pr, gh, repo = DEFAULT_REPO }, deps = {}) {
  const d = fetchDeps(root, deps, deps.env ?? process.env);
  const pull = await gh(['api', `repos/${repo}/pulls/${pr}`]);
  const head = pull?.head?.sha;
  const pullBaseSha = pull?.base?.sha;
  const baseRef = pull?.base?.ref;
  if (!SHA40.test(String(head)) || !SHA40.test(String(pullBaseSha)) || !baseRef) throw badInput(`PR ${pr}: gh returned no usable head sha, base sha or base ref`);
  ensureCommit(d, head, [`pull/${pr}/head`]);
  ensureCommit(d, pullBaseSha, [baseRef, pullBaseSha]);
  const mergeBase = gitOut(d.git, ['merge-base', pullBaseSha, head]).trim();
  const files = parseNameStatus(gitOut(d.git, ['diff', '--name-status', '-M', '-z', mergeBase, head])).filter((f) => !isExcluded(f.filename));
  return { pr, head, pullBaseSha, mergeBase, pull, files, branch: pull.head.ref };
}

// ---------- routeBand ----------

/** { band, detail, model|null, escalate } from the landed bandOf. HIGH or CRITICAL escalate to the critic; a security-tier file adds coderabbit. */
export function routeBand({ files, configAtBase, labels = [] }) {
  const detail = bandOf(files, configAtBase, { labels });
  if (!detail) return { band: null, detail: null, model: null, escalate: [] };
  const escalate = [];
  if (detail.band === 'HIGH' || detail.band === 'CRITICAL') escalate.push('critic');
  if (detail.securityTier?.length > 0) escalate.push('coderabbit');
  return { band: detail.band, detail, model: BAND_MODEL[detail.band] ?? null, escalate };
}

// ---------- resolveRange ----------

const isComplete = (rec) => rec?.status === 'ok' && rec?.coverage?.complete === true;

/**
 * 'done' when a complete record exists at this head, 'delta' from the newest complete record whose head is an ancestor, else 'full'.
 * --fresh is always 'full'. trustedOnly skips records with trusted:false.
 * deps: { stateRoot, env, isAncestor(candidate, head) }.
 */
export function resolveRange({ branch, head, fresh = false, trustedOnly = false }, deps = {}) {
  if (fresh) return { mode: 'full', from: null };
  const rec = { stateRoot: deps.stateRoot, env: deps.env };
  const here = listRecords({ branch, head }, rec).records.some(({ record }) => isComplete(record) && (!trustedOnly || record.trusted === true));
  if (here) return { mode: 'done', from: head };
  const from = lastReviewedSha({ branch, head, isAncestor: deps.isAncestor, trustedOnly }, rec);
  return from && from !== head ? { mode: 'delta', from } : { mode: 'full', from: null };
}

// ---------- slots ----------

function readSlots(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(j?.active) ? j.active.filter((e) => e && typeof e === 'object') : [];
  } catch { return []; }
}

function writeSlots(file, active) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ active }, null, 2)}\n`);
  renameSync(tmp, file);
}

function slotDeps(deps) {
  return {
    now: deps.now ?? Date.now, pidAlive: deps.pidAlive ?? pidAlive, pid: deps.pid ?? process.pid,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), lockWaitMs: deps.lockWaitMs ?? 5000, pollMs: deps.pollMs ?? SLOT_POLL_MS,
  };
}

function tryTake({ file, runKey, max, timeoutMs }, d) {
  mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, { lockWaitMs: d.lockWaitMs, lockStaleMs: 30_000 }, () => {
    const t = d.now();
    const alive = (e) => d.pidAlive(e.pid) && t - Date.parse(e.startedAt) <= timeoutMs + SLOT_GRACE_MS;
    const live = readSlots(file).filter(alive);
    if (live.length >= max) return { ok: false, reason: 'busy', active: live.length };
    writeSlots(file, [...live, { runKey, pid: d.pid, startedAt: new Date(t).toISOString() }]);
    return { ok: true };
  });
}

/**
 * Takes one of `max` slots in slots.json ({active:[{runKey,pid,startedAt}]}), under the lock only for the take. Entries with a dead pid or an age
 * over timeoutMs + 10 min are dropped. At the limit it polls every 15 s until waitMs has passed.
 * -> { ok:true } | { ok:false, reason:'busy'|'lock' }. deps (tests): { now, pidAlive, pid, sleep, lockWaitMs, pollMs }.
 */
export async function takeSlot({ runKey, max, timeoutMs, waitMs, file }, deps = {}) {
  const d = slotDeps(deps);
  const deadline = d.now() + waitMs;
  for (;;) {
    const r = tryTake({ file, runKey, max, timeoutMs }, d);
    if (r.ok || r.reason === 'lock') return r;
    const left = deadline - d.now();
    if (left <= 0) return r;
    await d.sleep(Math.min(d.pollMs, left));
  }
}

/** Removes the runKey from slots.json under the lock. { ok:true } or { ok:false, reason:'lock' } (the entry then ages out). */
export function releaseSlot({ runKey, file }, deps = {}) {
  const d = slotDeps(deps);
  mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, { lockWaitMs: d.lockWaitMs, lockStaleMs: 30_000 }, () => {
    writeSlots(file, readSlots(file).filter((e) => e.runKey !== runKey));
    return { ok: true };
  });
}

// ---------- env and sweep ----------

/** The agent env: buildAgentEnv (drops ANTHROPIC_API_KEY, GH_TOKEN, GITHUB_TOKEN) minus CLAUDE_CODE_MESSAGING_TOKEN. */
export function buildEngineEnv(base = process.env, platform = process.platform) {
  const env = buildAgentEnv(base, platform);
  for (const k of ENV_DROP) delete env[k];
  return env;
}

/** Removes tmpRoot/cursor-review-* folders older than maxAgeMs. Returns the names removed. Never throws. */
export function sweepTmp({ tmpRoot = os.tmpdir(), maxAgeMs, now = Date.now() }) {
  const removed = [];
  let names = [];
  try { names = readdirSync(tmpRoot); } catch { return removed; }
  for (const n of names.filter((x) => x.startsWith('cursor-review-'))) {
    const p = path.join(tmpRoot, n);
    try {
      const st = lstatSync(p);
      if (!st.isDirectory() || now - st.mtimeMs <= maxAgeMs) continue;
      rmSync(p, { recursive: true, force: true });
      removed.push(n);
    } catch { /* best effort */ }
  }
  return removed;
}

// ---------- reviewHead ----------

function makeDeps(opts, deps) {
  const env = deps.env ?? process.env;
  const root = opts.root ?? deps.root ?? process.cwd();
  const selfPath = deps.selfPath ?? fileURLToPath(import.meta.url);
  const P = statePaths(deps, env);
  const git = deps.git ?? defaultGit(root);
  return {
    env, root, P, git, selfPath, platform: deps.platform ?? process.platform, now: deps.now ?? Date.now, grep: deps.grep,
    selfRoot: deps.selfRoot ?? path.resolve(path.dirname(selfPath), '..', '..'),
    configPath: deps.configPath ?? path.resolve(path.dirname(selfPath), '..', '..', 'review-router.config.json'),
    gh: deps.gh ?? defaultGh(opts.repo ?? DEFAULT_REPO), repo: opts.repo ?? DEFAULT_REPO,
    withLock: deps.withLock ?? withLock, fetchLock: P.fetchLock, remote: deps.remote ?? 'fork',
    runAgent: deps.runAgent ?? runAgent, reserveRun: deps.reserveRun ?? reserveRun, finishRun: deps.finishRun ?? finishRun,
    writeRecord: deps.writeRecord ?? writeRecord, prepareReview: deps.prepareReview ?? prepareReview,
    readAtSha: deps.readAtSha ?? ((r, s, p) => readAtSha(r, s, p)), agent: deps.agent,
    slotDeps: { now: deps.now, pidAlive: deps.pidAlive, pid: deps.pid, sleep: deps.sleep, lockWaitMs: deps.lockWaitMs, pollMs: deps.pollMs },
    tmpRoot: deps.tmpRoot ?? os.tmpdir(), tldr: 'tldr' in deps ? deps.tldr : (opts.tldr ? undefined : null),
    log: deps.stderr ?? (() => {}),
  };
}

function refuse(d, exit, reason) {
  d.log(`local-review: ${reason}`);
  return { exit, recordPath: null, skipReason: null, reason };
}

function skip(d, row) {
  mkdirSync(d.P.aux, { recursive: true });
  appendFileSync(d.P.ledger, `${JSON.stringify({ ts: new Date(d.now()).toISOString(), phase: 'skip', ...row })}\n`);
  d.log(`local-review: skip ${row.reason}`);
  return { exit: EXIT.OK, recordPath: null, skipReason: row.reason };
}

const skipRow = (s, reason) => skip(s.d, { pr: s.opts.pr, head: s.target?.head ?? null, branch: s.target?.branch ?? null, reason });

function baseConfig(s) {
  const { d, target } = s;
  try {
    const text = d.readAtSha(d.root, target.mergeBase, 'review-router.config.json');
    if (text !== null && text !== undefined) return JSON.parse(text);
    s.problems.push('review-router.config.json not found at the merge base: the pinned copy sets the band rules');
  } catch (err) {
    s.problems.push(`review-router.config.json at the merge base is unusable (${clip(err.message, 120)}): the pinned copy sets the band rules`);
  }
  return s.full;
}

async function stepTarget(s) {
  const { d, opts } = s;
  try {
    s.target = await resolveTarget({ root: d.root, pr: opts.pr, gh: d.gh, repo: d.repo }, { git: d.git, withLock: d.withLock, stateDir: d.P.aux, stateRoot: d.P.records, env: d.env, remote: d.remote });
    s.slug = branchSlug(s.target.branch);
  } catch (err) {
    return refuse(d, err.code === 'BAD_INPUT' || /branch name/.test(err.message) ? EXIT.REFUSED : EXIT.FAILED, err.message);
  }
  if (RESERVED_SLUGS.has(s.slug)) return refuse(d, EXIT.REFUSED, `branch name "${s.target.branch}" collides with the engine folder`);
  s.ref = `branch-${s.slug}`;
  const { pull } = s.target;
  if (pull.draft === true) return skipRow(s, 'draft');
  if (s.cfg.skip_authors.includes(pull.user?.login)) return skipRow(s, `author ${pull.user.login} is on the skip list`);
  return null;
}

function stepBand(s) {
  const labels = (s.target.pull.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
  s.route = routeBand({ files: s.target.files, configAtBase: baseConfig(s), labels });
  if (!s.route.band) return refuse(s.d, EXIT.REFUSED, 'no matrix block in the band config: the band cannot be set');
  if (!s.cfg.bands.includes(s.route.band) || !s.route.model) return skipRow(s, `band ${s.route.band} is not reviewed`);
  return null;
}

const isAncestorOf = (d) => (a, b) => d.git(['merge-base', '--is-ancestor', a, b]).status === 0;

function loadPrior(s) {
  const byId = new Map();
  for (const { record } of listRecords({ branch: s.target.branch, head: s.range.from }, s.rec).records) {
    for (const f of record.findings ?? []) if (f.id) byId.set(f.id, f);
  }
  return [...byId.values()].filter((f) => (f.status ?? 'open') === 'open');
}

/** A prior finding whose lines the diff touched (or grew) goes to the model; the others are re-lined and stay open. */
function relinePrior(prior, hunks) {
  const touchedIds = new Set();
  const relined = prior.map((f) => {
    const end = f.endLine ?? f.startLine;
    const a = mapLine(hunks, f.file, f.startLine);
    const b = mapLine(hunks, f.file, end);
    const moved = a.touched || b.touched || b.line - a.line !== end - f.startLine;
    // The endpoints can sit still while a line between them was replaced one for one, so the range is checked too.
    if (moved || rangeTouched(hunks, f.file, f.startLine, end)) { touchedIds.add(f.id); return f; }
    return { ...f, startLine: a.line, endLine: b.line };
  });
  return { relined, touchedIds };
}

const pathspecDiff = (d, args, names) => gitOut(d.git, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', ...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: names.join('\0') });

/** Map<old name, new name> of the files the delta from..head renamed. */
function deltaRenames(d, from, head) {
  const list = parseNameStatus(gitOut(d.git, ['diff', '--name-status', '-M', '-z', from, head]));
  return new Map(list.filter((f) => f.previous_filename).map((f) => [f.previous_filename, f.filename]));
}

/** The prior findings with a renamed file moved to its new name, and the pathspec names (new and old) for the rename-aware diff. */
function priorUnderRenames(prior, renames) {
  const moved = prior.map((f) => (renames.has(f.file) ? { ...f, file: renames.get(f.file) } : f));
  const files = new Set(moved.map((f) => f.file));
  const olds = [...renames].filter(([, to]) => files.has(to)).map(([from]) => from);
  return { moved, names: [...files, ...olds] };
}

/** Delta files = from..head intersect mergeBase..head (a main merge adds none). Also the prior findings and their touched set. */
function stepDelta(s) {
  const { d, target, range } = s;
  const changed = new Set(splitZ(gitOut(d.git, ['diff', '--name-only', '--no-renames', '-z', range.from, target.head])));
  s.deltaFiles = target.files.filter((f) => changed.has(f.filename));
  if (s.deltaFiles.length === 0) return skipRow(s, 'delta is empty (only main merge changes since the last review)');
  s.deltaDiff = pathspecDiff(d, [range.from, target.head], s.deltaFiles.map((f) => f.filename));
  const { moved, names } = priorUnderRenames(loadPrior(s), deltaRenames(d, range.from, target.head));
  s.prior = moved;
  const hunks = names.length ? parseHunks(pathspecDiff(d, ['-M', range.from, target.head], names)) : null;
  const { relined, touchedIds } = relinePrior(s.prior, hunks);
  s.priorRelined = relined;
  s.touchedIds = touchedIds;
  return null;
}

async function stepRange(s) {
  const { d, target } = s;
  const trustedOnly = s.trust.trusted;
  s.range = resolveRange({ branch: target.branch, head: target.head, fresh: s.opts.fresh, trustedOnly }, { stateRoot: d.P.records, env: d.env, isAncestor: isAncestorOf(d) });
  if (s.range.mode === 'done') return skipRow(s, 'range done: a complete record exists at this head');
  s.prior = []; s.priorRelined = []; s.touchedIds = new Set();
  return s.range.mode === 'delta' ? stepDelta(s) : null;
}

function writeReviewDir(s, prep) {
  const { d, target, cfg } = s;
  const dir = path.join(prep.dir, '.review');
  rmSync(dir, { recursive: true, force: true }); // a PR may carry its own .review/ or DELTA.diff: nothing of it stays
  rmSync(path.join(prep.dir, 'DELTA.diff'), { force: true });
  mkdirSync(dir, { recursive: true });
  // cursor-agent hides what .gitignore and .cursorignore list. A PR could list PR.diff and .review/, so these files go like the agent files.
  stripIgnoreFiles(prep.dir, d.platform);
  const agentFiles = [...new Set([...(prep.agentFiles ?? []), ...prep.files.filter((f) => isIgnoreFile(f, d.platform))])];
  const diffText = readFileSync(path.join(prep.dir, 'PR.diff'), 'utf8');
  const input = { root: d.root, mergeBase: target.mergeBase, head: target.head, pull: target.pull, files: target.files, gates: s.opts.gatesText, treeDir: prep.dir, diffText, capKb: cfg.context_cap_kb };
  const ctx = buildContext(input, { readAtSha: d.readAtSha, tldr: d.tldr });
  writeFileSync(path.join(dir, 'CONTEXT.md'), ctx.text);
  const delta = s.range.mode === 'delta';
  const files = delta ? s.deltaFiles.map((f) => f.filename) : prep.files;
  const prompt = buildEnginePrompt({ mode: s.range.mode, files, agentFiles });
  writeFileSync(path.join(prep.dir, PROMPT_PATH), prompt.promptText);
  if (delta) writeDeltaFiles(s, prep, dir);
  return { ctx, prompt, diffText };
}

function writeDeltaFiles(s, prep, dir) {
  writeFileSync(path.join(prep.dir, 'DELTA.diff'), s.deltaDiff);
  const send = s.priorRelined.filter((f) => s.touchedIds.has(f.id))
    .map((f) => ({ id: f.id, file: f.file, startLine: f.startLine, endLine: f.endLine, severity: f.severity, title: clip(f.title ?? '', 300), body: clip(f.body ?? '', 1500) }));
  writeFileSync(path.join(dir, 'PRIOR.json'), `${JSON.stringify(send, null, 2)}\n`);
}

function runError(run, parsed, timeoutMs, model) {
  if (run.timedOut) return `TIMED OUT after ${Math.round(timeoutMs / 1000)} s: the agent and its process tree were stopped; no findings were read`;
  if (run.error) return `the agent did not start or crashed: ${run.error}`;
  if (run.status !== 0) return `the agent exited with status ${run.status}${run.stderr ? `: ${clip(run.stderr.trim(), 200)}` : ''}`;
  if (parsed.modelMismatch) return `model check failed: the output names a model other than ${model}; the run is void`;
  if (!parsed.ok) return parsed.problems.join('; ');
  return null;
}

/** Retry only on a spawn error (Dave 2026-11-02, main spec). Never on a non-zero exit, a time-out, a model mismatch or notRun. */
const retryable = (cur) => !cur.run.timedOut && !cur.parsed.modelMismatch && !cur.parsed.notRun && Boolean(cur.run.error);

async function runOnce(s, prep, plan, runId, attempt) {
  const { d, route } = s;
  const agent = s.agent;
  const args = [...(agent.prefixArgs ?? []), '-p', '--mode', 'ask', '--trust', '--output-format', 'json', '--model', route.model, ...plan.prompt.argv];
  const spec = { command: agent.cmd, args, cwd: prep.dir, timeoutMs: s.timeoutMs, env: buildEngineEnv(d.env, d.platform) };
  const t0 = d.now();
  let run;
  try { run = await d.runAgent(spec); } catch (err) { run = { status: null, stdout: '', stderr: '', timedOut: false, error: String(err.message), durationMs: d.now() - t0 }; }
  const parsed = parseReviewOutput(run.stdout, { expectModel: route.model });
  return { runId, attempt, run, parsed, error: runError(run, parsed, s.timeoutMs, route.model) };
}

function endLine(s, cur, extra = {}) {
  const { d, route } = s;
  d.finishRun(d.P.cursorLedger, cur.runId, {
    ref: s.ref, model: route.model, band: route.band, sessionId: d.env.CLAUDE_CODE_SESSION_ID || null, durationMs: cur.run.durationMs ?? null,
    exit: cur.error ? EXIT.FAILED : EXIT.OK, timedOut: Boolean(cur.run.timedOut), modelVerified: cur.parsed.modelVerified, usage: cur.parsed.usage,
    ...(cur.error ? { error: clip(cur.error, 300) } : {}), pr: s.target.pr, head: s.target.head, mode: s.range.mode, engineSha: s.pin.engineSha, ...extra,
  }, { now: d.now });
}

/** Reserve (cap keyed on the branch), run, and retry once. A superseded attempt gets its end line when the next attempt is reserved. */
async function runAttempts(s, prep, plan) {
  const { d, route, cfg } = s;
  const runs = [];
  let prev = null;
  for (let n = 1; n <= 1 + cfg.retry_max; n += 1) {
    const entry = { ref: s.ref, model: route.model, band: route.band, sessionId: d.env.CLAUDE_CODE_SESSION_ID || null };
    const reserved = d.reserveRun(d.P.cursorLedger, entry, { now: d.now, perRefCap: cfg.per_branch_cap });
    if (!reserved.ok) return { stopped: reserved, prev, runs };
    if (prev) endLine(s, prev);
    prev = await runOnce(s, prep, plan, reserved.id, n);
    runs.push({ runId: prev.runId, attempt: n, model: route.model, exit: prev.run.status, timedOut: Boolean(prev.run.timedOut), durationMs: prev.run.durationMs ?? null, usage: prev.parsed.usage });
    if (!retryable(prev)) break;
  }
  return { stopped: null, prev, runs };
}

const runComplete = (run, parsed, answer) => run.status === 0 && !run.timedOut && parsed.ok && !parsed.notRun && !parsed.modelMismatch && answer !== null;

const rankOf = (f) => SEVERITY_RANK[f.severity] ?? 0;

/** A new finding with the id of a still-open prior finding: the prior stays open, with the higher severity. The model cannot close or downgrade it (13.3). */
function mergeSame(old, f) {
  const top = rankOf(f) > rankOf(old) ? f : old;
  return { ...top, id: old.id, status: 'open', firstSeenSha: old.firstSeenSha ?? f.firstSeenSha, thread: Boolean(old.thread || f.thread) };
}

function settleAndFilter(s, prep, plan, answer) {
  const r = filterFindings(answer.findings, { treeDir: prep.dir, hunks: parseHunks(plan.diffText), prior: s.priorRelined, threadMin: s.cfg.thread_min_confidence, ...(s.d.grep ? { grep: s.d.grep } : {}) });
  const kept = r.kept.map((f) => ({ ...f, firstSeenSha: f.firstSeenSha ?? s.target.head }));
  const exists = (rel) => existsSync(path.join(prep.dir, rel)) || isStrippedFile(rel);
  const settled = s.range.mode === 'delta' ? settlePrior(s.priorRelined, answer.prior, { touches: (f) => s.touchedIds.has(f.id), exists }) : [];
  const openPrior = settled.filter((f) => f.status === 'open');
  const open = new Map(openPrior.map((f) => [f.id, f]));
  // A re-lined prior keeps its old id; a re-report at the new line gets a new id. Match on the re-lined location too.
  const atLine = new Map(openPrior.map((f) => [findingId(f), f]));
  const priorFor = (f) => open.get(f.id) ?? atLine.get(f.id);
  const merged = kept.map((f) => (priorFor(f) ? mergeSame(priorFor(f), f) : f));
  const ids = new Set(merged.map((f) => f.id));
  return { findings: [...settled.filter((f) => !ids.has(f.id)), ...merged], dropped: r.dropped, problems: r.problems };
}

function buildRecord(s, plan, out, answer, filtered, error) {
  const { target, route } = s;
  const final = out.prev;
  const { band, score, G, C, K, L, securityTier } = route.detail;
  const problems = [...s.problems, ...final.parsed.problems, ...filtered.problems, ...(error ? [error] : [])];
  if (out.stopped) problems.push(`the retry was not reserved (${out.stopped.reason}): the first failed attempt stands`);
  const selected = s.range.mode === 'delta' ? s.deltaFiles.length : target.files.length;
  const claimedReviewed = answer?.reviewed?.length ?? 0;
  // An answer that claims no file reviewed is not complete when files were selected: a hidden or unreadable tree gives that answer.
  const complete = runComplete(final.run, final.parsed, answer) && (selected === 0 || claimedReviewed > 0);
  return {
    schema: 1, runId: final.runId, pr: target.pr, branch: target.branch, head: target.head, mergeBase: target.mergeBase, pullBaseSha: target.pullBaseSha,
    engineSha: s.pin.engineSha, trusted: s.trust.trusted, promptVersion: plan.prompt.promptVersion, promptSha256: plan.prompt.promptSha256,
    mode: s.range.mode, from: s.range.from, band: { band, score, G, C, K, L, securityTier }, status: error ? 'failed' : 'ok', skipReason: null,
    escalate: route.escalate, runs: out.runs,
    coverage: { selected, ignoredByFilter: filtered.dropped.length, claimedReviewed, complete },
    contextMissing: plan.ctx.contextMissing, findings: filtered.findings, dropped: filtered.dropped, problems, ts: new Date(s.d.now()).toISOString(),
  };
}

/** Writes the record first, then the ledger end line with the record's path and sha256. */
function persist(s, final, record, error) {
  const { d } = s;
  let written;
  try {
    written = d.writeRecord(record, { stateRoot: d.P.records, env: d.env, now: d.now });
  } catch (err) {
    const msg = `record write failed: ${err.message}`;
    endLine(s, { ...final, error: msg }, { findingCount: 0 });
    return refuse(d, EXIT.FAILED, msg);
  }
  endLine(s, final, { findingCount: record.findings.length, recordPath: written.path, recordSha256: written.sha256 });
  return { exit: error ? EXIT.FAILED : EXIT.OK, recordPath: written.path, skipReason: null, runId: final.runId, status: record.status, findingCount: record.findings.length, mode: record.mode, trusted: record.trusted, ...(error ? { reason: error } : {}) };
}

async function stepRun(s) {
  const { d, target } = s;
  const prep = await d.prepareReview({ root: d.root, input: { range: `${target.pullBaseSha}..${target.head}` }, tmpRoot: d.tmpRoot, platform: d.platform });
  try {
    let plan;
    try { plan = writeReviewDir(s, prep); } catch (err) { return refuse(d, err.code === 'PROMPT_TOO_LONG' ? EXIT.REFUSED : EXIT.FAILED, err.message); }
    const out = await runAttempts(s, prep, plan);
    if (out.stopped && !out.prev) return refuse(d, out.stopped.reason === 'lock' ? EXIT.FAILED : EXIT.CAP, out.stopped.detail ?? `${out.stopped.reason} reached (${out.stopped.count})`);
    const final = out.prev;
    const answer = lastJsonBlock(final.parsed.text);
    const error = final.error ?? (answer ? null : 'the answer has no final json block with findings, reviewed and prior');
    const filtered = error ? { findings: [], dropped: [], problems: [] } : settleAndFilter(s, prep, plan, answer);
    if (error && !final.error) final.error = error;
    return persist(s, final, buildRecord(s, plan, out, answer, filtered, error), error);
  } finally {
    prep.cleanup();
  }
}

async function withSlot(s) {
  const { d, cfg } = s;
  const runKey = `${s.ref}@${s.target.head.slice(0, 12)}-${d.slotDeps.pid ?? process.pid}-${randomUUID().slice(0, 8)}`;
  const slot = await takeSlot({ runKey, max: cfg.max_concurrent, timeoutMs: s.timeoutMs * (1 + cfg.retry_max), waitMs: cfg.slot_wait_min * MIN, file: d.P.slots }, d.slotDeps);
  if (!slot.ok) return refuse(d, EXIT.CAP, slot.reason === 'busy' ? `all ${cfg.max_concurrent} review slots are busy after ${cfg.slot_wait_min} min` : slot.detail ?? 'the slot lock is held');
  try { return await stepRun(s); } finally { releaseSlot({ runKey, file: d.P.slots }, d.slotDeps); }
}

async function runHead(opts, d) {
  if (!Number.isInteger(opts.pr) || opts.pr <= 0) return refuse(d, EXIT.REFUSED, 'a PR number is required (--pr <n>)');
  const pin = checkPin({ env: d.env, selfPath: d.selfPath, engineRoot: d.P.engineRoot, engineHere: opts.engineHere });
  if (!pin.ok) return refuse(d, EXIT.REFUSED, pin.reason);
  const loaded = loadConfig(d.configPath);
  if (!loaded.ok) return refuse(d, EXIT.REFUSED, loaded.reason);
  d.sweepAgeMs = loaded.cfg.timeout_min * MIN + TMP_GRACE_MS;
  const trust = pin.pinned ? computeTrust({ selfRoot: d.selfRoot, git: d.git, remote: d.remote }) : { trusted: false, mismatched: ['--engine-here'] };
  const s = { d, opts, pin, trust, cfg: loaded.cfg, full: loaded.full, problems: [], rec: { stateRoot: d.P.records, env: d.env }, timeoutMs: loaded.cfg.timeout_min * MIN };
  if (!s.cfg.enabled) return skip(d, { pr: opts.pr, reason: 'local_review.enabled is false' });
  const early = (await stepTarget(s)) ?? stepBand(s) ?? (await stepRange(s));
  if (early) return early;
  s.agent = d.agent ?? resolveAgent({ env: d.env });
  if (s.agent.error) return refuse(d, EXIT.FAILED, s.agent.error);
  return withSlot(s);
}

/**
 * One review of one PR head. opts: { pr, fresh, gatesText, engineHere, tldr, root, repo }.
 * deps (tests): { git, gh, runAgent, reserveRun, finishRun, writeRecord, prepareReview, readAtSha, agent, now, pidAlive, sleep, env, stateRoot,
 *   stateDir, cursorLedger, selfPath, selfRoot, configPath, tmpRoot, tldr, grep, stderr }.
 * -> { exit, recordPath|null, skipReason|null, ... }
 */
export async function reviewHead(opts, deps = {}) {
  const d = makeDeps(opts, deps);
  try {
    return await runHead(opts, d);
  } catch (err) {
    return refuse(d, err.code === 'BAD_INPUT' ? EXIT.REFUSED : EXIT.FAILED, err.message);
  } finally {
    if (d.sweepAgeMs !== undefined) sweepTmp({ tmpRoot: d.tmpRoot, maxAgeMs: d.sweepAgeMs, now: d.now() });
  }
}

// ---------- command line ----------

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--pr': { const v = argv[++i]; if (!/^\d+$/.test(v ?? '') || Number(v) <= 0) return { error: `--pr needs a PR number, got ${JSON.stringify(v)}` }; out.pr = Number(v); break; }
      case '--gates': out.gates = argv[++i]; if (!out.gates) return { error: '--gates needs a file' }; break;
      case '--repo': out.repo = argv[++i]; if (!/^[\w.-]+\/[\w.-]+$/.test(out.repo ?? '')) return { error: '--repo needs owner/name' }; break;
      case '--fresh': out.fresh = true; break;
      case '--json': out.json = true; break;
      case '--engine-here': out.engineHere = true; break;
      case '--tldr': out.tldr = true; break;
      default: return { error: `unknown argument ${JSON.stringify(a)}` };
    }
  }
  if (out.pr === undefined) return { error: 'pass --pr <n>: the engine runs on a PR' };
  return out;
}

function repoRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : process.cwd();
}

/** Starts the pinned copy as a child process and passes its output through. Exit 2 when the pin fails. */
async function relaunch(argv, ctx) {
  const { root, env, out, err, deps } = ctx;
  const pin = (deps.pinEngine ?? pinEngine)({ root, env }, deps);
  if (!pin.ok) { err(`local-review: ${pin.reason}`); return EXIT.REFUSED; }
  if (pin.warning) err(`local-review: ${pin.warning}`);
  const conf = loadConfig(path.join(pin.dir, 'review-router.config.json'));
  const cfg = conf.ok ? conf.cfg : LOCAL_REVIEW_DEFAULTS;
  const timeoutMs = (cfg.slot_wait_min + cfg.timeout_min * (1 + cfg.retry_max) + 5) * MIN;
  const script = path.join(pin.dir, 'scripts', 'github', 'local-review.mjs');
  const r = await (deps.runAgent ?? runAgent)({ command: process.execPath, args: [script, ...argv], cwd: root, timeoutMs, env: { ...env, LOCAL_REVIEW_PINNED: pin.engineSha } });
  if (r.stdout) out(r.stdout.replace(/\r?\n$/, ''));
  if (r.stderr) err(r.stderr.replace(/\r?\n$/, ''));
  if (r.timedOut) { err('local-review: the pinned engine timed out'); return EXIT.FAILED; }
  return r.status ?? EXIT.FAILED;
}

function readGates(file) {
  try { return { text: readFileSync(file, 'utf8') }; } catch (e) { return { error: `cannot read --gates ${file}: ${e.message}` }; }
}

function report(r, json, out) {
  if (json) { out(JSON.stringify(r)); return; }
  if (r.skipReason) out(`local-review: skipped (${r.skipReason})`);
  else if (r.recordPath) out(`local-review: ${r.status}, ${r.findingCount} finding(s), ${r.mode}${r.trusted ? '' : ', untrusted'}\nrecord: ${r.recordPath}`);
  else if (r.reason) out(`local-review: ${r.reason}`);
}

/** Returns the exit code. deps (tests): reviewHead deps plus stdout, stderr, env, root, pinEngine, runAgent. */
export async function main(argv, deps = {}) {
  const out = deps.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const args = parseArgs(argv);
  if (args.error) { err(`local-review: ${args.error}`); return EXIT.REFUSED; }
  const env = deps.env ?? process.env;
  const root = deps.root ?? repoRoot();
  if (!env.LOCAL_REVIEW_PINNED && !args.engineHere) return relaunch(argv, { root, env, out, err, deps });
  const gates = args.gates ? readGates(args.gates) : {};
  if (gates.error) { err(`local-review: ${gates.error}`); return EXIT.REFUSED; }
  const r = await (deps.reviewHead ?? reviewHead)({ ...args, root, gatesText: gates.text }, { ...deps, env, stderr: err });
  report(r, args.json, out);
  return r.exit;
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}
