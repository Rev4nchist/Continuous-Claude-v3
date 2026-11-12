#!/usr/bin/env node
/**
 * local-review-sweep.mjs: runs the existing review engine (reviewHead in local-review.mjs) as advice over the open PRs and over saved earlier
 * heads, saves the same-head CodeRabbit CLI pairs, and prints a report (docs/review-engine/map.md, lane re-live-advisory). No engine code changes.
 *
 * Usage: node scripts/github/local-review-sweep.mjs [--engine-sha <sha40>] [--frozen-sha <sha40>] [--band-counts <file>] [--cli-dir <dir>]...
 *          [--max-runs <n>] [--pairs-only] [--dry-run] [--json] [--repo <owner/name>]
 *
 * Engine. --engine-sha (path F): scripts/ and review-router.config.json at that commit are extracted (own extract, no fetch, never pinEngine) into
 *   <records>/engine/<sha>/. Before each run the copy is extracted again when its engine file is gone (the engine's pruning removed it), then
 *   proved by blob (ruling D.8): every reviewer-set file, review-router.mjs and the config must have their blob id at the SHA. A changed or
 *   partial copy is not repaired: error line, no engine call, the sweep stops (exit 1). The proof runs again after each run (copyChanged).
 *   reviewHead is imported FROM THE COPY and called with LOCAL_REVIEW_PINNED=<sha> and the same records root: the engine takes selfPath from its own
 *   import.meta.url, so checkPin sees a file under <records>/engine/<sha>/ and accepts it. The pin is not weakened.
 *   Without --engine-sha: the engine of this checkout runs with engineHere (records say trusted:false), and the versions are computed at the
 *   checkout HEAD. Such a run is always "rehearsal, prompt v1" and never counted: the code that ran can differ from HEAD.
 * Targets. Open PRs (gh api pulls?state=open, paged, read-only), and every saved CLI output <date>-pre-pr-cr-<sha7>.txt that names a Major or a
 *   Critical: that earlier head runs with the gh answer patched to it (as engine-run.mjs does), withholdBody and fresh, never evalRun (so its
 *   ledger ref is branch-<slug>: inside the live cap and the per-branch cap). "Already run" is keyed on head + engineSha (null unpinned): an ok
 *   or a void line blocks it, one failed line allows one more try, two block.
 *   An OPEN head is not checked against the list (F7): it is called again in every sweep, without fresh. The engine then skips it itself,
 *   with no ledger start, when a complete record (status ok, coverage complete) exists at that branch and head (resolveRange 'done',
 *   local-review.mjs:353-360, :598); a pinned copy that is trusted (equal to fork/main) counts only trusted records there. An open head whose
 *   records are all failed or incomplete therefore runs again in every sweep and spends a start each time, up to the engine's per-branch cap
 *   (per_branch_cap, 8 per branch in 7 days). A pull open with no record yet runs once, then skips. The PR of a CLI head: by commit, then (no commit hit) by the
 *   worktree branch; exactly one candidate, on the worktree branch when one is known, else ambiguousPr or noPr. .failed.txt files are counted.
 * Order. CRITICAL, then HIGH, then MID and ELEVATED by the --band-counts share (pushes per risk band over 4 weeks; DEFAULT_BAND_COUNTS without
 *   the flag). LOW never runs. laneState() is injected (tests, a later caller). The command line has no reader of the lane DB, so it passes
 *   none and runs CRITICAL (skipCritical false). The risk band comes from the engine's own resolveTarget and routeBand (the copy that runs).
 * Live cap. WEEKLY_LIVE_CAP (or local_review.weekly_live_cap of the root config, a cap key exempt from the freeze set) Cursor ledger starts in
 *   7 days with purpose review and a ref that does not start with eval-. A run is refused, and the sweep stops, when starts + 1 + retry_max
 *   would pass the cap (retry_max from the config of the engine that runs, else LOCAL_REVIEW_DEFAULTS). The report sets overCap above the cap.
 *   A ledger file that exists and cannot be read (not ENOENT) refuses the run: the count is unknown, so it fails closed (exit 3).
 * Facts. The engine's usage line names catchers.md, but it reads the --facts file as text (local-review.mjs:902). By the map the sweep passes the
 *   text of .claude/cache/pre-pr/catchers.json of the PR branch's worktree, only when that worktree is at the head under review.
 * Files. <records>/cli-pairs/<pr>/<sha40>.txt: the CLI output (never rewritten). <records>/cli-pairs/sweep-runs.jsonl: one line per engine
 *   answer that can follow a ledger start (a record, or status failed with recordPath null), with frozenSha and frozenEngineVersion (what the
 *   label was tested against; null without --frozen-sha). A failed append is logged and gives exit 1 (a void stays exit 4).
 *   pinned:true there is the pinned tag (a pinned copy wrote the record). counted:true only when ALL hold: the pinned copy ran, its
 *   engineVersion equals the frozen value (label "frozen"), status ok, coverage complete, the read audit wrote a pass line with symlinkCheck
 *   pass, and the copy was still there after the run. Otherwise `reason` names the first condition that failed.
 * Read audit. After each run with a stream: auditReplay (read-audit.mjs) on the .stream.jsonl.gz beside the record, as replay.mjs does (runOk
 *   only for an ok, complete record). A run with no stream is 'not-run'. A void run is not counted and stops the sweep (map, "On a void").
 *
 * Exit codes:
 *   0  done
 *   1  a run failed, the engine copy failed or was changed, a list line was not written, a gh lookup failed, or the engine refused a run
 *      (the engine's own exit 2 gives the sweep 1; a pin refusal also stops the sweep)
 *   2  usage, or a repo other than the fork (refusals by the sweep itself)
 *   3  the live cap, the engine's own weekly cap, or a Cursor ledger that exists and cannot be read, stopped the sweep
 *   4  a void run stopped the sweep
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants as fsc, appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeVersions as realComputeVersions } from '../eval/review-eval/engine-version.mjs';
import { auditReplay, defaultStatePath, newestByRunId, readLines } from '../eval/review-eval/read-audit.mjs';
import { DEFAULT_REPO, countRuns, readLedger } from './cursor-review.mjs';
import { LOCAL_REVIEW_DEFAULTS } from './local-review.mjs';
import { branchSlug, stateRoot as recordsRoot } from './local-review/record.mjs';
import { CATCHERS_JSON, parseAgentStream } from './pre-pr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout this file sits in: its engine runs when no --engine-sha is given. */
const CHECKOUT_DIR = path.resolve(HERE, '..', '..');
const ENGINE_FILE = 'scripts/github/local-review.mjs';
const CONFIG_FILE = 'review-router.config.json';
const SHA40 = /^[0-9a-f]{40}$/;
const DAY = 86_400_000;
const PASSED_CLI = /^(\d{4}-\d{2}-\d{2})-pre-pr-cr-([0-9a-f]{7,40})\.txt$/;
const FAILED_CLI = /^\d{4}-\d{2}-\d{2}-pre-pr-cr-[0-9a-f]{7,40}\.failed\.txt$/;

/** Live engine starts allowed per 7 days, all live callers together (map C2, Dave DP1.2). */
export const WEEKLY_LIVE_CAP = 100;
/** The MID / ELEVATED share without --band-counts: equal. Ties go to the larger count, then MID. */
export const DEFAULT_BAND_COUNTS = Object.freeze({ ELEVATED: 1, MID: 1 });
export const SWEEP_EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, CAP: 3, VOID: 4 });
export const REHEARSAL_LABEL = 'rehearsal, prompt v1';
export const FROZEN_LABEL = 'frozen';
/** The report window: the weekly report of re-live-accrual. */
export const WINDOW_DAYS = 7;
const RISK_BANDS = ['LOW', 'MID', 'ELEVATED', 'HIGH', 'CRITICAL'];
const USAGE = 'usage: local-review-sweep.mjs [--engine-sha <sha40>] [--frozen-sha <sha40>] [--band-counts <file>] [--cli-dir <dir>]... '
  + '[--max-runs <n>] [--pairs-only] [--dry-run] [--json] [--repo <owner/name>]';
/** The engine's refusals of the pin rule (checkPin): every later run would be refused too, so the sweep stops. */
const PIN_REFUSAL = /not started from a pinned engine copy|LOCAL_REVIEW_PINNED is not a 40-character sha|this process runs from .*: refused/;
const DRY_NO_COMMITS = 'risk band unknown (commits not here)';

const clip = (s, n = 200) => (String(s).length > n ? `${String(s).slice(0, n - 3)}...` : String(s));
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

// ---------- command line ----------

const VALUE_FLAGS = {
  '--engine-sha': (v, o) => (SHA40.test(v ?? '') ? void (o.engineSha = v) : '--engine-sha needs a 40-character sha'),
  '--frozen-sha': (v, o) => (SHA40.test(v ?? '') ? void (o.frozenSha = v) : '--frozen-sha needs a 40-character sha'),
  '--band-counts': (v, o) => (v ? void (o.bandCounts = v) : '--band-counts needs a file'),
  '--cli-dir': (v, o) => (v ? void (o.cliDirs = [...(o.cliDirs ?? []), v]) : '--cli-dir needs a folder'),
  '--max-runs': (v, o) => (/^\d+$/.test(v ?? '') && Number(v) > 0 ? void (o.maxRuns = Number(v)) : '--max-runs needs a whole number above 0'),
  '--repo': (v, o) => (/^[\w.-]+\/[\w.-]+$/.test(v ?? '') ? void (o.repo = v) : '--repo needs owner/name'),
};
const BOOL_FLAGS = { '--pairs-only': 'pairsOnly', '--dry-run': 'dryRun', '--json': 'json' };

/** The options, or { error }. The upstream repo is refused: the sweep reads the fork only. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (BOOL_FLAGS[a]) { out[BOOL_FLAGS[a]] = true; continue; }
    if (!VALUE_FLAGS[a]) return { error: `unknown argument ${JSON.stringify(a)}` };
    const problem = VALUE_FLAGS[a](argv[++i], out);
    if (problem) return { error: problem };
  }
  if (out.repo && out.repo.toLowerCase() !== DEFAULT_REPO.toLowerCase()) return { error: `${out.repo} is refused: the sweep reads the fork ${DEFAULT_REPO} only` };
  return out;
}

/** { value } from the --band-counts file ({ "HIGH": n, "MID": n, ... } pushes per risk band), or { error }. */
function readBandCounts(file) {
  if (!file) return { value: DEFAULT_BAND_COUNTS };
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { return { error: `cannot read --band-counts ${file}: ${err.message}` }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: '--band-counts must hold a JSON object' };
  const bad = Object.entries(j).find(([, v]) => typeof v !== 'number' || !(v >= 0));
  return bad ? { error: `--band-counts: ${bad[0]} is not a count` } : { value: j };
}

// ---------- git, gh ----------

function defaultGit(root) {
  return (args, { input, env } = {}) => {
    const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: root, input, encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env,
    });
    return r.error ? { status: null, stdout: '', stderr: r.error.message } : { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

/** gh with the personal config folder, as local-review.mjs defaultGh does. Read-only calls only. */
function defaultGh() {
  return (args) => {
    const personal = path.join(os.homedir(), '.config', 'gh-personal');
    const dir = process.env.GH_CONFIG_DIR || (existsSync(personal) ? personal : undefined);
    const env = { ...process.env, ...(dir ? { GH_CONFIG_DIR: dir } : {}) };
    return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', env, timeout: 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }));
  };
}

const gitText = (git, args) => { const r = git(args); return r.status === 0 ? String(r.stdout ?? '') : null; };

/** gh with the PR answer patched to an earlier head (engine-run.mjs roundGh, head only: the base stays the PR's base). */
function headGh(gh, pr, sha40) {
  return async (args) => {
    const out = await gh(args);
    const isPull = args[0] === 'api' && String(args[1]).endsWith(`/pulls/${pr}`);
    return isPull ? { ...out, head: { ...out.head, sha: sha40 } } : out;
  };
}

function repoRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : process.cwd();
}

// ---------- worktrees, CLI files, ledger ----------

/** [{ path, head, branch|null }] from `git worktree list --porcelain`. */
export function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), head: null, branch: null }; out.push(cur); }
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
  }
  return out;
}

/** Live review starts in the 7 days before now: start rows, purpose review, ref not eval-*, distinct run ids, notStarted runs skipped (countRuns). */
export function liveStarts(entries, now) {
  const unstarted = new Set(entries.filter((e) => e.notStarted === true && e.id).map((e) => e.id));
  const live = entries.filter((e) => e.phase === 'start' && e.purpose === 'review' && !String(e.ref ?? '').startsWith('eval-') && !unstarted.has(e.id));
  return countRuns(live, { now });
}

/** The cap: local_review.weekly_live_cap of the root config when it is a whole number above 0, else WEEKLY_LIVE_CAP. */
function liveCap(root) {
  try {
    const v = JSON.parse(readFileSync(path.join(root, CONFIG_FILE), 'utf8'))?.local_review?.weekly_live_cap;
    return Number.isInteger(v) && v > 0 ? v : WEEKLY_LIVE_CAP;
  } catch { return WEEKLY_LIVE_CAP; }
}

const isRetryMax = (v) => Number.isInteger(v) && v >= 0;

/** retry_max of the engine that runs: its loadConfig on its own config file, else that file read as JSON, else LOCAL_REVIEW_DEFAULTS. */
function retryMaxOf(eng) {
  const file = eng ? path.join(eng.dir, CONFIG_FILE) : null;
  try {
    const loaded = file && typeof eng.engine.loadConfig === 'function' ? eng.engine.loadConfig(file) : null;
    if (isRetryMax(loaded?.cfg?.retry_max)) return loaded.cfg.retry_max;
    const raw = file ? JSON.parse(readFileSync(file, 'utf8'))?.local_review?.retry_max : undefined;
    if (isRetryMax(raw)) return raw;
  } catch { /* the default below */ }
  return (eng?.engine?.LOCAL_REVIEW_DEFAULTS ?? LOCAL_REVIEW_DEFAULTS).retry_max;
}

/**
 * { liveStarts, cap, retryMax, overCap, damaged? }. A run takes up to 1 + retryMax starts (one retry each), so room is checked for all of
 * them. A ledger line that cannot be read can be a start row of any age: each one counts as a live start, so the check errs toward refusing
 * a run. The report names the count (damaged) when it is not 0; repair the ledger line to get the room back.
 */
function ledgerLoad(ctx, eng) {
  const unreadable = ledgerUnreadable(ctx);
  const cap = liveCap(ctx.root);
  if (unreadable) return { liveStarts: null, cap, retryMax: retryMaxOf(eng), overCap: false, unreadable };
  const ledger = readLedger(ctx.cursorLedger);
  const used = liveStarts(ledger.entries, ctx.now()) + ledger.damaged;
  return { liveStarts: used, cap, retryMax: retryMaxOf(eng), overCap: used > cap, ...(ledger.damaged ? { damaged: ledger.damaged } : {}) };
}

/**
 * Fail closed on the ledger read. readLedger (cursor-review.mjs) turns every read error into an empty ledger, so the sweep reads the file
 * itself first: a missing file (ENOENT) is 0 starts; any other error (a folder, no permission) is the reason text, and the run is refused.
 */
function ledgerUnreadable(ctx) {
  try { ctx.readLedgerText(ctx.cursorLedger); return null; } catch (err) {
    return err?.code === 'ENOENT' ? null : `${err?.code ?? 'error'}: ${clip(String(err?.message ?? err), 120)}`;
  }
}
const noRoom = (load) => load.liveStarts + 1 + load.retryMax > load.cap;

function cliDirs(ctx) {
  if (ctx.args.cliDirs) return ctx.args.cliDirs;
  const dirs = [ctx.root, ...ctx.worktrees.map((w) => w.path)].map((d) => path.resolve(d, '.claude', 'cache', 'e2e'));
  return [...new Set(dirs)];
}

/** Passed CLI files [{ file, date, sha7 }] (sorted by name) and the count of .failed.txt files. A missing folder is empty. */
function scanCliDirs(dirs) {
  const files = [];
  let failed = 0;
  for (const dir of dirs) {
    let names = [];
    try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const n of names) {
      const m = PASSED_CLI.exec(n);
      if (m) files.push({ file: path.join(dir, n), dir, date: m[1], sha7: m[2] });
      else if (FAILED_CLI.test(n)) failed += 1;
    }
  }
  return { files, failed };
}

const samePath = (a, b) => {
  const n = (p) => path.resolve(p).replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** The branch of the worktree whose .claude/cache/e2e is this folder, or null (the primary's main, or a folder of no worktree). */
function branchOfCliDir(ctx, dir) {
  const wt = ctx.worktrees.find((w) => w.branch && samePath(path.join(w.path, '.claude', 'cache', 'e2e'), dir));
  return wt && wt.branch !== 'main' ? wt.branch : null;
}

/** The candidates of a gh list: on the branch when one is known. Never "open first": the caller needs exactly one. */
function candidates(list, branch) {
  const pulls = (Array.isArray(list) ? list : []).filter((p) => Number.isInteger(p?.number));
  return branch ? pulls.filter((p) => p.head?.ref === branch) : pulls;
}

/** GitHub does not know the commit or the route: that is "no PR", not a failure. */
const UNKNOWN_TO_GITHUB = /HTTP 4(?:04|22)|Not Found|No commit found/i;

/** Every page of a gh list (100 a page). An unknown commit gives []. Any other gh failure throws: it must never read as "no PR". */
async function ghList(ctx, url) {
  const all = [];
  const sep = url.includes('?') ? '&' : '?';
  for (let page = 1; ; page += 1) {
    let batch;
    try { batch = await ctx.gh(['api', `${url}${sep}per_page=100&page=${page}`]); } catch (err) {
      if (UNKNOWN_TO_GITHUB.test(String(err?.message))) return all;
      throw err;
    }
    if (!Array.isArray(batch)) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/**
 * The PR of a head: { pr, branch } | { ambiguous: true } | { error } | null. By commit first (commits/<sha>/pulls). With no commit hit, by the worktree
 * branch (pulls?state=all&head=<owner>:<branch>: it finds a head that a force push replaced). Each step needs exactly one candidate, on the
 * worktree branch when one is known: two or more is ambiguous, none is no PR. A gh failure is { error }: the caller counts and logs it.
 */
async function prForHead(ctx, sha40, branch) {
  try {
    let found = candidates(await ghList(ctx, `repos/${ctx.repo}/commits/${sha40}/pulls`), branch);
    if (found.length === 0 && branch) {
      const owner = ctx.repo.split('/')[0];
      found = candidates(await ghList(ctx, `repos/${ctx.repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`), branch);
    }
    if (found.length > 1) return { ambiguous: true };
    return found.length === 1 ? { pr: found[0].number, branch: found[0].head?.ref ?? null } : null;
  } catch (err) {
    return { error: clip(String(err?.message ?? err)) };
  }
}

const hasMajor = (text) => { const s = parseAgentStream(text).bySeverity; return (s.major ?? 0) + (s.critical ?? 0) > 0; };

/** One entry per resolved CLI head: { sha40, pr, branch, date, major, file }. Unknown sha, no PR and failed files are counted. */
async function collectCliHeads(ctx) {
  const { files, failed } = scanCliDirs(cliDirs(ctx));
  ctx.report.skipped.failedCli += failed;
  const heads = new Map();
  for (const f of files) {
    const sha40 = gitText(ctx.git, ['rev-parse', '--verify', '--quiet', `${f.sha7}^{commit}`])?.trim();
    if (!sha40 || !SHA40.test(sha40)) { ctx.report.skipped.ambiguousSha += 1; continue; }
    if (heads.has(sha40)) continue;
    const owner = await prForHead(ctx, sha40, branchOfCliDir(ctx, f.dir));
    if (owner?.error) {
      ctx.report.skipped.ghError += 1;
      ctx.failed = true;
      ctx.log(`local-review-sweep: gh lookup of the PR for ${sha40.slice(0, 12)} failed: ${owner.error}`);
      continue;
    }
    if (!owner || owner.ambiguous) { ctx.report.skipped[owner ? 'ambiguousPr' : 'noPr'] += 1; continue; }
    let text = '';
    try { text = readFileSync(f.file, 'utf8'); } catch { /* an unreadable file names no Major */ }
    heads.set(sha40, { sha40, ...owner, date: f.date, major: hasMajor(text), file: f.file });
  }
  return [...heads.values()];
}

/** Copies each CLI head's output to <records>/cli-pairs/<pr>/<sha40>.txt. Same name = same head: an existing file is never rewritten. */
function savePairs(ctx, heads) {
  for (const h of heads) {
    const dst = path.join(ctx.records, 'cli-pairs', String(h.pr), `${h.sha40}.txt`);
    if (existsSync(dst)) { ctx.report.pairs.existing += 1; continue; }
    mkdirSync(path.dirname(dst), { recursive: true });
    try { copyFileSync(h.file, dst, fsc.COPYFILE_EXCL); ctx.report.pairs.saved += 1; } catch (err) {
      if (err.code === 'EEXIST') ctx.report.pairs.existing += 1; else ctx.log(`local-review-sweep: pair for ${h.sha40.slice(0, 12)} not saved: ${clip(err.message)}`);
    }
  }
}

// ---------- the engine copy (path F) ----------

const copyPresent = (dir) => existsSync(path.join(dir, ENGINE_FILE));

/** The git blob id of a file's bytes (as `git hash-object --no-filters`): no line-end filter, so a changed byte is a changed blob. */
function blobOf(file) {
  const buf = readFileSync(file);
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/** The files the copy must hold with their blob at the SHA: the reviewer set and the band set (computeVersions) and the config file. */
function wantedBlobs({ sha, git, root, computeVersions }) {
  const v = computeVersions({ sha, root, git });
  const cfg = String(git(['rev-parse', '--verify', '--quiet', `${sha}:${CONFIG_FILE}`]).stdout ?? '').trim();
  if (!SHA40.test(cfg)) throw new Error(`no ${CONFIG_FILE} at ${sha}`);
  return [...v.reviewerFiles, ...v.bandFiles, { path: CONFIG_FILE, blob: cfg }];
}

/**
 * Ruling D.8: proves a pinned copy. null when every reviewer-set file, scripts/github/review-router.mjs and review-router.config.json in
 * `dir` has the blob id it has at `sha`; else the first problem as text (a missing file, a changed file, or a list that cannot be read).
 * `want` (the wanted list) can be given to skip computeVersions.
 */
export function proveCopy({ dir, sha, git, root, computeVersions, want }) {
  let list;
  try { list = want ?? wantedBlobs({ sha, git, root, computeVersions }); } catch (err) { return `cannot list the blobs at ${sha.slice(0, 12)}: ${clip(err.message)}`; }
  for (const { path: rel, blob } of list) {
    let have;
    try { have = blobOf(path.join(dir, ...rel.split('/'))); } catch { return `${rel} is missing`; }
    if (have !== blob) return `${rel} differs from its blob at ${sha.slice(0, 12)}`;
  }
  return null;
}

/** proveCopy with the wanted list read once per sweep. */
function copyProblem(ctx, dir) {
  const sha = ctx.args.engineSha;
  if (!ctx.copyBlobs) {
    try { ctx.copyBlobs = wantedBlobs({ sha, git: ctx.git, root: ctx.root, computeVersions: ctx.computeVersions }); } catch (err) {
      return `cannot list the blobs at ${sha.slice(0, 12)}: ${clip(err.message)}`;
    }
  }
  return proveCopy({ dir, sha, want: ctx.copyBlobs });
}

/** The private extractEngine of local-review.mjs, rebuilt: read-tree into a temp index, checkout-index into a stage, rename into place. */
function extractCopy(git, sha, dir) {
  const engineRoot = path.dirname(dir);
  mkdirSync(engineRoot, { recursive: true });
  const work = mkdtempSync(path.join(engineRoot, '.tmp-'));
  const stage = path.join(work, 'tree');
  const env = { GIT_INDEX_FILE: path.join(work, 'index') };
  const step = (args, input) => {
    const r = git(args, { env, input });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${clip(String(r.stderr ?? '').trim())}`);
    return String(r.stdout ?? '');
  };
  try {
    step(['read-tree', sha]);
    const list = step(['ls-files', '-z', '--', 'scripts', CONFIG_FILE]);
    if (!list.split('\0').includes(ENGINE_FILE)) return { ok: false, reason: `commit ${sha} holds no review engine` };
    step(['checkout-index', '-f', '-z', '--stdin', `--prefix=${stage.replaceAll('\\', '/')}/`], list);
    rmSync(dir, { recursive: true, force: true }); // a copy without its engine file is replaced whole
    renameSync(stage, dir);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `extract failed: ${err.message}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function importFrom(ctx, dir, pinned) {
  try {
    return { engine: await ctx.importEngine(pathToFileURL(path.join(dir, ENGINE_FILE)).href), dir, pinned };
  } catch (err) {
    ctx.log(`local-review-sweep: ${pinned ? `engine copy ${dir}` : 'the checkout engine'} cannot be imported: ${clip(err.message)}`);
    return null;
  }
}

/**
 * { engine, dir, pinned } or null after one error line. Pinned: a copy whose engine file is gone (the engine's pruning removed the folder)
 * is extracted again. Then, before EACH run, the copy is proved by blob (proveCopy): a changed or partial copy is never repaired, the engine
 * is not started from it, and the sweep stops (exit 1) so the seat can see who changed it. The folder time is renewed (pruning keeps the 3
 * newest). write:false (dry run) extracts and proves nothing: without a copy the checkout engine plans.
 */
async function loadEngine(ctx, { write = true } = {}) {
  const sha = ctx.args.engineSha;
  if (!sha) return importFrom(ctx, CHECKOUT_DIR, false);
  const dir = path.join(ctx.records, 'engine', sha);
  if (!copyPresent(dir)) {
    if (!write) return importFrom(ctx, CHECKOUT_DIR, false);
    const x = extractCopy(ctx.git, sha, dir);
    if (!x.ok) { ctx.log(`local-review-sweep: engine copy ${sha.slice(0, 12)}: ${x.reason}`); return null; }
  }
  if (!write) return importFrom(ctx, dir, true);
  const problem = copyProblem(ctx, dir);
  if (problem) { ctx.log(`local-review-sweep: engine copy ${sha.slice(0, 12)}: ${problem}: the engine is not started from it; the sweep stops`); return null; }
  try { const t = new Date(ctx.now()); utimesSync(dir, t, t); } catch { /* best effort */ }
  return importFrom(ctx, dir, true);
}

// ---------- versions and labels ----------

/** engineVersion and bandVersion at one SHA, once per sweep. A failure gives nulls (and the rehearsal label) after one log line. */
function versionsAt(ctx, sha) {
  if (!sha) return { engineVersion: null, bandVersion: null };
  if (!ctx.versions.has(sha)) {
    let v = { engineVersion: null, bandVersion: null };
    try { const r = ctx.computeVersions({ sha, root: ctx.root, git: ctx.git }); v = { engineVersion: r.engineVersion, bandVersion: r.bandVersion }; }
    catch (err) { ctx.log(`local-review-sweep: no engineVersion at ${sha.slice(0, 12)}: ${clip(err.message)}`); }
    ctx.versions.set(sha, v);
  }
  return ctx.versions.get(sha);
}

/** The SHA whose versions describe the engine that ran: the pinned SHA, else the checkout HEAD. */
function versionSha(ctx, eng) {
  if (eng.pinned) return ctx.args.engineSha;
  if (ctx.headSha === undefined) ctx.headSha = gitText(ctx.git, ['rev-parse', 'HEAD'])?.trim() || null;
  return ctx.headSha;
}

/** "frozen" only for a pinned run whose engineVersion equals the engineVersion at --frozen-sha. An unpinned run is always rehearsal. */
function labelOf(ctx, eng, engineVersion) {
  if (!eng.pinned) return REHEARSAL_LABEL;
  const frozen = ctx.args.frozenSha ? versionsAt(ctx, ctx.args.frozenSha).engineVersion : null;
  return engineVersion && frozen && engineVersion === frozen ? FROZEN_LABEL : REHEARSAL_LABEL;
}

// ---------- targets and their risk band ----------

async function listOpenPulls(ctx) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const batch = await ctx.gh(['api', `repos/${ctx.repo}/pulls?state=open&per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function openTargets(ctx) {
  const out = [];
  for (const p of await listOpenPulls(ctx)) {
    // gh is not trusted for shape: the number and the head go into paths, gh calls and git arguments.
    if (!Number.isInteger(p?.number) || p.number <= 0 || !SHA40.test(String(p?.head?.sha))) {
      ctx.report.skipped.badPull += 1;
      ctx.log(`local-review-sweep: an open pull with number ${clip(JSON.stringify(p?.number), 40)} and head ${clip(JSON.stringify(p?.head?.sha), 60)} is skipped`);
      continue;
    }
    if (p.draft === true) { ctx.report.skipped.draft += 1; continue; }
    out.push({ kind: 'open-head', pr: p.number, head: p.head?.sha, branch: p.head?.ref ?? null });
  }
  return out;
}

/**
 * True when the list already holds this head for this engine (key head + engineSha, null for unpinned): an ok line or a void line blocks
 * for good; failed lines block from the second one. A failed line is a status other than ok (also the line of a start that gave no record),
 * or a run whose engine copy went away or changed (copyGone, copyChanged: the sweep reports that run as failed, though its record says ok).
 * So a failed run gets one more try, and a rehearsal line of the checkout engine never blocks a pinned run.
 */
function alreadyRun(rows, head, engineSha) {
  const mine = rows.filter((r) => r.head === head && (r.engineSha ?? null) === engineSha);
  const failed = (r) => r.status !== 'ok' || r.copyGone === true || r.copyChanged === true;
  if (mine.some((r) => r.audit === 'void' || !failed(r))) return true;
  return mine.filter(failed).length >= 2;
}

/** Earlier heads with a CLI Major. A head that is a PR's open head is covered there. fresh runs never repeat: see alreadyRun. */
function earlierTargets(ctx, eng, cliHeads, open) {
  const openHeads = new Set(open.map((t) => t.head));
  const rows = readList(ctx);
  const engineSha = eng.pinned ? ctx.args.engineSha : null;
  const out = [];
  for (const h of cliHeads.filter((x) => x.major && !openHeads.has(x.sha40))) {
    if (alreadyRun(rows, h.sha40, engineSha)) { ctx.report.skipped.alreadyRun += 1; continue; }
    out.push({ kind: 'earlier-head', pr: h.pr, head: h.sha40, branch: h.branch });
  }
  return out;
}

const engineGit = (ctx) => ctx.engineDeps.git ?? ctx.git;

/** The band config the engine would read: review-router.config.json at the merge base, else the engine's own copy (baseConfig in local-review.mjs). */
function baseConfig(ctx, eng, mergeBase) {
  const text = SHA40.test(String(mergeBase)) ? gitText(engineGit(ctx), ['cat-file', 'blob', `${mergeBase}:${CONFIG_FILE}`]) : null;
  for (const read of [() => text, () => readFileSync(path.join(eng.dir, CONFIG_FILE), 'utf8')]) {
    try { const j = JSON.parse(read()); if (j && typeof j === 'object') return j; } catch { /* next source */ }
  }
  return null;
}

/** Dry run only: true when the head and base commits are here, so resolveTarget will not fetch (a fetch writes). */
async function commitsHere(ctx, t, gh) {
  const git = engineGit(ctx);
  const here = (sha) => SHA40.test(String(sha)) && git(['cat-file', '-e', `${sha}^{commit}`]).status === 0;
  try { const pull = await gh(['api', `repos/${ctx.repo}/pulls/${t.pr}`]); return here(pull?.head?.sha) && here(pull?.base?.sha); } catch { return false; }
}

/** The risk band of a target from the engine's own resolveTarget and routeBand. null when it cannot be resolved (one log line). */
async function bandOfTarget(ctx, eng, t) {
  const gh = t.kind === 'earlier-head' ? headGh(ctx.gh, t.pr, t.head) : ctx.gh;
  if (ctx.args.dryRun && !(await commitsHere(ctx, t, gh))) { t.bandNote = DRY_NO_COMMITS; return null; }
  try {
    const target = await eng.engine.resolveTarget({ root: ctx.root, pr: t.pr, gh, repo: ctx.repo }, { git: engineGit(ctx), stateRoot: ctx.records, env: ctx.env });
    const labels = (target.pull?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
    t.branch = target.branch ?? t.branch;
    return eng.engine.routeBand({ files: target.files, configAtBase: baseConfig(ctx, eng, target.mergeBase), labels }).band ?? null;
  } catch (err) {
    ctx.log(`local-review-sweep: PR ${t.pr} at ${String(t.head).slice(0, 12)}: risk band not resolved: ${clip(err.message)}`);
    return null;
  }
}

/** The facts text: catchers.json of the worktree of the target's branch, only when that worktree is at the target head. */
function factsFor(ctx, t) {
  const wt = ctx.worktrees.find((w) => w.branch && w.branch === t.branch);
  if (!wt || wt.head !== t.head) return undefined;
  try { return readFileSync(path.join(wt.path, CATCHERS_JSON), 'utf8'); } catch { return undefined; }
}

const ratio = (q) => (q.w > 0 ? q.n / q.w : Infinity);

/** MID and ELEVATED interleaved so the runs so far follow the counts: the band with the lowest taken/count goes next. */
function shareOrder(mid, elevated, counts) {
  const q = [{ list: [...mid], w: counts.MID ?? 0, n: 0 }, { list: [...elevated], w: counts.ELEVATED ?? 0, n: 0 }];
  const out = [];
  for (let live = q.filter((x) => x.list.length); live.length > 0; live = q.filter((x) => x.list.length)) {
    const pick = live.sort((a, b) => ratio(a) - ratio(b) || b.w - a.w)[0]; // Infinity - Infinity is NaN: the count, then MID, breaks the tie
    out.push(pick.list.shift());
    pick.n += 1;
  }
  return out;
}

/**
 * The run order: CRITICAL (unless skipCritical), HIGH, then the MID / ELEVATED share. LOW and an unknown risk band never run.
 * Inside a risk band: open heads first, then by PR number. -> { order, skipped: { low, critical, noBand } }
 */
export function planOrder(targets, { bandCounts = DEFAULT_BAND_COUNTS, skipCritical = false } = {}) {
  const sorted = [...targets].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'open-head' ? -1 : 1) || a.pr - b.pr);
  const of = (band) => sorted.filter((t) => t.band === band);
  const skipped = { low: of('LOW').length, critical: skipCritical ? of('CRITICAL').length : 0, noBand: sorted.filter((t) => !RISK_BANDS.includes(t.band)).length };
  return { order: [...(skipCritical ? [] : of('CRITICAL')), ...of('HIGH'), ...shareOrder(of('MID'), of('ELEVATED'), bandCounts)], skipped };
}

// ---------- one run ----------

/** The reviewHead call. Pinned: LOCAL_REVIEW_PINNED and no selfPath, so the copy's own path meets checkPin. Unpinned: engineHere, no pin in env. */
async function callEngine(ctx, eng, t) {
  const env = { ...ctx.env };
  delete env.LOCAL_REVIEW_PINNED;
  if (eng.pinned) env.LOCAL_REVIEW_PINNED = ctx.args.engineSha;
  const extra = { ...ctx.engineDeps };
  if (eng.pinned) for (const k of ['selfPath', 'selfRoot', 'configPath']) delete extra[k];
  const earlier = t.kind === 'earlier-head';
  const opts = {
    pr: t.pr, root: ctx.root, repo: ctx.repo, factsText: t.factsText, ...(eng.pinned ? {} : { engineHere: true }), ...(earlier ? { withholdBody: true, fresh: true } : {}),
  };
  const d = {
    ...extra, git: engineGit(ctx), gh: earlier ? headGh(ctx.gh, t.pr, t.head) : ctx.gh, env, stateRoot: ctx.records, cursorLedger: ctx.cursorLedger,
    tmpRoot: ctx.tmpRoot, now: ctx.now, stderr: ctx.log, ...(ctx.runAgent ? { runAgent: ctx.runAgent } : {}), ...(ctx.agent ? { agent: ctx.agent } : {}),
  };
  try { return await eng.engine.reviewHead(opts, d); } catch (err) { return { exit: SWEEP_EXIT.FAILED, recordPath: null, reason: `reviewHead threw: ${err.message}` }; }
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const listPath = (ctx) => path.join(ctx.records, 'cli-pairs', 'sweep-runs.jsonl');
const readList = (ctx) => readLines(listPath(ctx));

/** Why a run with a record does not count, or null when it counts (the final definition: every condition below must hold). */
function notCounted({ eng, record, audit, copyGone, copyChanged, label }) {
  if (copyGone) return 'the engine copy went away during the run';
  if (copyChanged) return `the engine copy changed during the run (${copyChanged})`;
  if (!eng.pinned) return 'unpinned run (engineHere): rehearsal only, never counted';
  if (record?.status !== 'ok') return `record status ${record?.status ?? 'unreadable'}`;
  if (record.coverage?.complete !== true) return 'coverage incomplete';
  if (audit.verdict !== 'pass') return `read audit ${audit.verdict}`;
  if (audit.symlinkCheck !== 'pass') return `symlinkCheck ${audit.symlinkCheck ?? 'missing'}`;
  if (label !== FROZEN_LABEL) return 'engineVersion is not the frozen value (rehearsal)';
  return null;
}

/**
 * auditReplay on the stream beside the record, as replay.mjs replayEngine does. runOk is true only for an ok, complete record: a failed run
 * keeps its status and the other rules still read its stream (the read-audit API). A record with no stream file is 'not-run' (a crash before
 * any output). A failed state write is a void (the patch says so).
 */
function auditRun(ctx, t, res, record) {
  const streamPath = res.recordPath.replace(/\.json$/, '.stream.jsonl.gz');
  if (record?.status !== 'ok' && !existsSync(streamPath)) return { verdict: 'not-run', symlinkCheck: null };
  const a = ctx.audit({
    kind: 'engine', runOk: record?.status === 'ok' && record.coverage?.complete === true, streamPath, runId: record?.runId ?? res.runId,
    head: record?.head ?? t.head, pr: t.pr, round: null, git: ctx.git, statePath: ctx.auditStatePath, tmpdir: ctx.tmpRoot, env: ctx.env,
  });
  return { verdict: a.patch?.void ? 'void' : (a.line?.verdict ?? 'void'), symlinkCheck: a.line?.symlinkCheck ?? null };
}

/** The fields every list line carries: the key alreadyRun reads (head + engineSha), the versions, and what the label was tested against (F2). */
function lineBase(ctx, eng, t) {
  const vsha = versionSha(ctx, eng);
  const { engineVersion, bandVersion } = versionsAt(ctx, vsha);
  const frozenSha = ctx.args.frozenSha ?? null;
  return {
    v: 1, ts: new Date(ctx.now()).toISOString(), pr: t.pr, kind: t.kind, pinned: eng.pinned, engineSha: eng.pinned ? ctx.args.engineSha : null,
    versionSha: vsha, versionSource: eng.pinned ? 'engine-sha' : 'checkout-head', engineVersion, bandVersion, label: labelOf(ctx, eng, engineVersion),
    frozenSha, frozenEngineVersion: frozenSha ? versionsAt(ctx, frozenSha).engineVersion : null, facts: t.factsText !== undefined,
  };
}

function listLine(ctx, eng, t, record, res, audit, copy) {
  const base = lineBase(ctx, eng, t);
  const reason = notCounted({ eng, record, audit, copyGone: copy.gone, copyChanged: copy.changed, label: base.label });
  return {
    ...base, runId: record?.runId ?? res.runId ?? null, head: record?.head ?? t.head, recordPath: res.recordPath, bodyMode: record?.bodyMode ?? null,
    audit: audit.verdict, symlinkCheck: audit.symlinkCheck, band: record?.band?.band ?? t.band ?? null, status: record?.status ?? null,
    counted: reason === null, ...(reason ? { reason } : {}), ...(copy.gone ? { copyGone: true } : {}), ...(copy.changed ? { copyChanged: true } : {}),
  };
}

/** The line of an answer that can follow a reserved start but gave no record: failed, not counted, with the key fields alreadyRun reads. */
function failedLine(ctx, eng, t, res, reason) {
  return {
    ...lineBase(ctx, eng, t), runId: res.runId ?? null, head: t.head, recordPath: null, bodyMode: null, audit: 'not-run', symlinkCheck: null,
    band: t.band ?? null, status: 'failed', counted: false, reason: clip(reason, 300),
  };
}

/** Appends a list line. A failed append is logged and marks the sweep failed; it never throws, so a void stop is never lost to an I/O error. */
function appendList(ctx, line) {
  try {
    mkdirSync(path.dirname(listPath(ctx)), { recursive: true });
    ctx.appendFile(listPath(ctx), `${JSON.stringify(line)}\n`);
  } catch (err) {
    ctx.log(`local-review-sweep: the list line of run ${line.runId ?? '(no run id)'} (PR ${line.pr}) was not written: ${clip(String(err?.message ?? err))}`);
    ctx.failed = true;
  }
  ctx.report.runs.push({ pr: line.pr, head: line.head, kind: line.kind, band: line.band, runId: line.runId, audit: line.audit, counted: line.counted });
}

/** After the run of a pinned copy: is the copy still there, and still the blobs at the SHA? -> { gone, changed: problem text | null }. */
function copyAfterRun(ctx, eng, t) {
  if (!eng.pinned) return { gone: false, changed: null };
  if (!copyPresent(eng.dir)) {
    ctx.log(`local-review-sweep: engine copy ${eng.dir} went away during the run of PR ${t.pr}: the run is not counted`);
    ctx.failed = true;
    return { gone: true, changed: null };
  }
  const changed = copyProblem(ctx, eng.dir);
  if (changed) {
    ctx.log(`local-review-sweep: engine copy ${eng.dir} changed during the run of PR ${t.pr} (${changed}): the run is not counted`);
    ctx.failed = true;
  }
  return { gone: false, changed };
}

/** After a run with a record: copy check, read audit, the list line. Returns 'void' to stop the sweep, else null. */
function afterRun(ctx, eng, t, res) {
  const record = readJson(res.recordPath);
  const copy = copyAfterRun(ctx, eng, t);
  if (record?.status !== 'ok') {
    ctx.log(`local-review-sweep: PR ${t.pr} at ${String(t.head).slice(0, 12)}: the run failed (${clip(res.reason ?? record?.status ?? 'unreadable record')})`);
    ctx.failed = true;
  }
  const line = listLine(ctx, eng, t, record, res, auditRun(ctx, t, res, record), copy);
  appendList(ctx, line);
  if (line.audit !== 'void') return null;
  ctx.log(`local-review-sweep: read audit VOID for run ${line.runId} (PR ${t.pr}, head ${line.head}): the sweep stops; the seat reads the stream first`);
  return 'void';
}

/**
 * The engine's exit 2 (a refusal, given before any ledger start) makes the SWEEP exit 1 (failed), never 2: the sweep's 2 is its own usage or
 * repo refusal. A pin refusal also stops the sweep (every later run would be refused the same way).
 */
function refused(ctx, t, res) {
  ctx.report.skipped.refused += 1;
  ctx.failed = true;
  if (!PIN_REFUSAL.test(res.reason ?? '')) {
    ctx.log(`local-review-sweep: PR ${t.pr} at ${String(t.head).slice(0, 12)}: the engine refused the run: ${clip(res.reason ?? '')}`);
    return null;
  }
  ctx.log(`local-review-sweep: the engine refused the pin for PR ${t.pr} (${clip(res.reason)}): the sweep stops`);
  return 'error';
}

/**
 * An engine answer without a record. Before any ledger start (counters only, no list line; local-review.mjs line numbers): a skip row,
 * exit 0 with a skipReason (skip() :484, from stepTarget :517-518, stepBand :526, stepRange :583/:598, all before withSlot :815); a
 * refusal, exit 2 (refuse() :479 from checkPin :803, loadConfig :805, stepTarget :511/:513, stepBand :525, writeReviewDir :775 before
 * runAttempts :776); a busy slot, exit 3 (withSlot :796, before stepRun); a reserveRun refusal, exit 3 'cap'/'ref-cap' (:777 when no
 * attempt ran; cursor-review.mjs reserveRun :163/:165 returns before its append :168). Every other answer can follow a reserved start
 * (:671), so it writes a failed list line: exit 1 with no record (record write failed :748 after the start; also a lock refusal or an
 * agent that cannot be resolved, which come before it: kept conservative), exit 0 with no record and no skipReason, a throw. -> stop or null.
 */
function noRecord(ctx, eng, t, res) {
  const s = ctx.report.skipped;
  const reason = res.reason ?? '';
  if (res.exit === 0 && res.skipReason) { bump(s.engineSkip, res.skipReason); return null; }
  if (res.exit === 2) return refused(ctx, t, res);
  if (res.exit === 3 && /^ref-cap/.test(reason)) { s.perBranchCap += 1; return null; }
  if (res.exit === 3 && /^cap reached/.test(reason)) {
    ctx.log(`local-review-sweep: the engine's weekly cap refused PR ${t.pr}: the sweep stops`);
    return 'engine-cap';
  }
  if (res.exit === 3) { s.busy += 1; return null; }
  const why = reason || `engine exit ${res.exit ?? '(none)'} with no record`;
  ctx.log(`local-review-sweep: PR ${t.pr} at ${String(t.head).slice(0, 12)}: engine exit ${res.exit}: ${clip(why)}`);
  s.failed += 1;
  ctx.failed = true;
  ctx.runsStarted += 1;
  appendList(ctx, failedLine(ctx, eng, t, res, why));
  return null;
}

/** Engine copy proof, cap check (with the retry room of that engine), the run, then the record steps. Returns a stop reason or null. */
async function runTarget(ctx, t) {
  const eng = await loadEngine(ctx);
  if (!eng) { ctx.failed = true; return 'error'; }
  const load = ledgerLoad(ctx, eng);
  if (load.unreadable) {
    ctx.log(`local-review-sweep: the Cursor ledger ${ctx.cursorLedger} exists and cannot be read (${load.unreadable}): no run without the live count; the sweep stops`);
    return 'ledger-unreadable';
  }
  if (noRoom(load)) {
    ctx.log(`local-review-sweep: live cap: ${load.liveStarts} live starts in 7 days + 1 + retry_max ${load.retryMax} pass the cap of ${load.cap}: the sweep stops`);
    return 'live-cap';
  }
  const res = (await callEngine(ctx, eng, t)) ?? {};
  if (!res.recordPath) return noRecord(ctx, eng, t, res);
  ctx.runsStarted += 1;
  return afterRun(ctx, eng, t, res);
}

// ---------- the report ----------

const nearestRank = (sorted, p) => (sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null);

function hasRecord(ctx, branch, sha40) {
  try {
    return readdirSync(path.join(ctx.records, branchSlug(branch), sha40)).some((n) => n.endsWith('.json') && !n.endsWith('.trace.json'));
  } catch { return false; }
}

function runsWindow(ctx, rows) {
  const byBand = {};
  const perPr = {};
  for (const r of rows) { bump(byBand, r.band ?? 'unknown'); bump(perPr, String(r.pr)); }
  const counts = Object.values(perPr).sort((a, b) => a - b);
  const withFacts = rows.filter((r) => r.facts).length;
  return {
    runs: rows.length, runsByBand: byBand, runsPerPr: { prs: counts.length, p50: nearestRank(counts, 0.5), p90: nearestRank(counts, 0.9) },
    facts: { with: withFacts, without: rows.length - withFacts, share: rows.length ? withFacts / rows.length : null },
  };
}

/** The read-audit summary of the window's runs: void runs with their heads (newest audit line, or the list line), and runs with no audit line. */
function auditWindow(ctx, rows) {
  const newest = newestByRunId(readLines(ctx.auditStatePath));
  const voids = rows.filter((r) => r.audit === 'void' || newest.get(r.runId)?.verdict === 'void').map((r) => ({ runId: r.runId, pr: r.pr, head: r.head }));
  return { voids, unaudited: rows.filter((r) => !newest.has(r.runId)).length };
}

/** Per risk band: CLI-reviewed heads, those with an engine record, the share; and the same for the CLI-Major heads. */
function cliWindow(ctx, heads, bands) {
  const share = (a, b) => (b ? a / b : null);
  const byBand = {};
  for (const h of heads) {
    const b = (byBand[bands.get(h.sha40) ?? 'unknown'] ??= { cliHeads: 0, withRecord: 0, share: null });
    b.cliHeads += 1;
    if (hasRecord(ctx, h.branch, h.sha40)) b.withRecord += 1;
  }
  for (const b of Object.values(byBand)) b.share = share(b.withRecord, b.cliHeads);
  const majors = heads.filter((h) => h.major);
  const majorWithRecord = majors.filter((h) => hasRecord(ctx, h.branch, h.sha40)).length;
  return { heads: heads.length, byBand, majorHeads: majors.length, majorWithRecord, majorShare: share(majorWithRecord, majors.length) };
}

/** The risk band of each CLI head in the window: from the list, from the plan, else from the engine (not in --pairs-only). */
async function cliBands(ctx, eng, heads) {
  const bands = new Map([...ctx.planBands, ...readList(ctx).map((r) => [r.head, r.band])].filter(([, b]) => b));
  if (!eng) return bands;
  for (const h of heads.filter((x) => !bands.has(x.sha40))) {
    const band = await bandOfTarget(ctx, eng, { kind: 'earlier-head', pr: h.pr, head: h.sha40, branch: h.branch });
    if (band) bands.set(h.sha40, band);
  }
  return bands;
}

async function finish(ctx, stopped, cliHeads, eng) {
  const since = ctx.now() - WINDOW_DAYS * DAY;
  const rows = readList(ctx).filter((r) => Date.parse(r.ts) >= since);
  const inWindow = cliHeads.filter((h) => Date.parse(`${h.date}T23:59:59.999Z`) >= since);
  const bands = await cliBands(ctx, eng, inWindow);
  const window = { days: WINDOW_DAYS, ...runsWindow(ctx, rows), readAudit: auditWindow(ctx, rows), cli: cliWindow(ctx, inWindow, bands) };
  Object.assign(ctx.report, { stopped, ledger: ledgerLoad(ctx, eng), window });
  return { exit: exitOf(stopped, ctx.failed), report: ctx.report };
}

/** The exit code table of the header. */
function exitOf(stopped, failed) {
  if (stopped === 'void') return SWEEP_EXIT.VOID;
  if (stopped === 'live-cap' || stopped === 'engine-cap' || stopped === 'ledger-unreadable') return SWEEP_EXIT.CAP;
  return stopped === 'error' || failed ? SWEEP_EXIT.FAILED : SWEEP_EXIT.OK;
}

const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);

/** The plain-text report. */
export function textReport(r) {
  const w = r.window;
  const s = r.skipped;
  const head = `local-review-sweep: ${r.dryRun ? 'DRY RUN, ' : ''}${r.mode ?? 'no'} engine${r.engineSha ? ` (--engine-sha ${r.engineSha.slice(0, 12)})` : ''}`;
  const planned = (p) => `#${p.pr} ${p.band ?? p.note} ${p.kind} ${String(p.head).slice(0, 7)}`;
  const skips = `draft ${s.draft}, noPr ${s.noPr}, gh error ${s.ghError}, ambiguous PR ${s.ambiguousPr}, ambiguous sha ${s.ambiguousSha}, per-branch cap ${s.perBranchCap}, `
    + `failed CLI files ${s.failedCli}, CRITICAL ${s.critical}, LOW ${s.low}, no risk band ${s.noBand}, already run ${s.alreadyRun}, `
    + `refused ${s.refused}, failed ${s.failed}, busy ${s.busy}, engine skips ${JSON.stringify(s.engineSkip)}`;
  const runs = `window ${w.days} days: ${w.runs} run(s); per risk band ${JSON.stringify(w.runsByBand)}; `
    + `runs per PR p50 ${w.runsPerPr.p50 ?? 'n/a'}, p90 ${w.runsPerPr.p90 ?? 'n/a'}; runs with facts ${w.facts.with}, without ${w.facts.without} (${pct(w.facts.share)})`;
  const voids = w.readAudit.voids.map((v) => ` [${v.runId} PR ${v.pr} head ${v.head}]`).join('');
  const lines = [
    `${head}, repo ${r.repo}${r.stopped ? `, STOPPED: ${r.stopped}` : ''}`,
    `planned: ${r.planned.map(planned).join('; ') || 'none'}`,
    `this sweep: ${r.runs.length} run(s), ${r.runs.filter((x) => x.counted).length} counted; pairs saved ${r.pairs.saved}, already there ${r.pairs.existing}`,
    `skipped: ${skips}`,
    (r.ledger.unreadable ? `ledger load: UNKNOWN, the Cursor ledger cannot be read (${r.ledger.unreadable}); cap ${r.ledger.cap}`
      : `ledger load: ${r.ledger.liveStarts} live starts in 7 days of a cap of ${r.ledger.cap} (retry_max ${r.ledger.retryMax})${r.ledger.overCap ? ', OVER THE CAP' : ''}`)
      + (r.ledger.damaged ? `; ${r.ledger.damaged} ledger line(s) cannot be read and count as starts` : ''),
    runs,
    ...Object.entries(w.cli.byBand).map(([b, x]) => `  risk band ${b}: ${x.cliHeads} CLI head(s), ${x.withRecord} with an engine record (${pct(x.share)})`),
    `CLI-Major heads: ${w.cli.majorHeads}, ${w.cli.majorWithRecord} with an engine record (${pct(w.cli.majorShare)})`,
    `read audit: ${w.readAudit.voids.length} void run(s)${voids}, ${w.readAudit.unaudited} unaudited`,
  ];
  return lines.join('\n');
}

// ---------- the sweep ----------

function newReport(ctx) {
  return {
    // mode is set from the engine that was loaded (null in --pairs-only): a dry run without a copy plans with the checkout engine, unpinned.
    v: 1, ts: new Date(ctx.now()).toISOString(), repo: ctx.repo, mode: null, engineSha: ctx.args.engineSha ?? null, frozenSha: ctx.args.frozenSha ?? null,
    dryRun: Boolean(ctx.args.dryRun), pairsOnly: Boolean(ctx.args.pairsOnly), stopped: null, planned: [], runs: [],
    skipped: {
      badPull: 0, draft: 0, noPr: 0, ghError: 0, ambiguousPr: 0, ambiguousSha: 0, perBranchCap: 0, failedCli: 0, critical: 0, low: 0, noBand: 0, alreadyRun: 0,
      refused: 0, failed: 0, busy: 0, engineSkip: {},
    },
    pairs: { saved: 0, existing: 0 },
  };
}

function makeCtx(args, deps) {
  const env = deps.env ?? process.env;
  const root = deps.root ?? repoRoot();
  const records = recordsRoot({ stateRoot: deps.stateRoot, env });
  const ctx = {
    // parseArgs allows the fork only (any case), so the canonical name is used for every call.
    args, env, root, records, repo: DEFAULT_REPO, git: deps.git ?? defaultGit(root), gh: deps.gh ?? defaultGh(), now: deps.now ?? Date.now,
    cursorLedger: deps.cursorLedger ?? env.CURSOR_REVIEW_LEDGER ?? path.join(path.dirname(records), 'cursor-review-ledger.jsonl'),
    tmpRoot: deps.tmpRoot ?? os.tmpdir(), auditStatePath: deps.auditStatePath ?? defaultStatePath(env), importEngine: deps.importEngine ?? ((u) => import(u)),
    laneState: deps.laneState ?? null, computeVersions: deps.computeVersions ?? realComputeVersions, audit: deps.audit ?? auditReplay,
    log: deps.log ?? ((s) => process.stderr.write(`${s}\n`)), out: deps.out ?? ((s) => process.stdout.write(`${s}\n`)),
    runAgent: deps.runAgent, agent: deps.agent, engineDeps: deps.engineDeps ?? {}, versions: new Map(), planBands: new Map(), runsStarted: 0, failed: false,
    readLedgerText: deps.readLedgerText ?? ((f) => readFileSync(f, 'utf8')), appendFile: deps.appendFile ?? appendFileSync,
  };
  ctx.report = newReport(ctx);
  return ctx;
}

/** Plans the targets: open heads and earlier heads, their risk band and facts, in run order. */
async function plan(ctx, eng, cliHeads, bandCounts) {
  const open = await openTargets(ctx);
  const targets = [...open, ...earlierTargets(ctx, eng, cliHeads, open)];
  for (const t of targets) {
    t.band = await bandOfTarget(ctx, eng, t);
    if (t.band) ctx.planBands.set(t.head, t.band);
    t.factsText = factsFor(ctx, t);
  }
  // skipCritical defaults to false: only an injected laneState that says the model check is open holds CRITICAL back.
  const skipCritical = ctx.laneState ? ctx.laneState()?.criticalModelCheckDone !== true : false;
  const { order, skipped } = planOrder(targets.filter((t) => !t.bandNote), { bandCounts, skipCritical });
  for (const k of ['low', 'critical', 'noBand']) ctx.report.skipped[k] += skipped[k];
  // A dry-run target whose commits are not here keeps its line in the plan, with the note in place of a risk band.
  const unknown = targets.filter((t) => t.bandNote);
  ctx.report.planned = [...order, ...unknown].map((t) => ({
    pr: t.pr, head: t.head, kind: t.kind, band: t.band, facts: t.factsText !== undefined, ...(t.bandNote ? { note: t.bandNote } : {}),
  }));
  return order;
}

/** One sweep. -> { exit, report }. */
export async function sweep(ctx, bandCounts) {
  ctx.worktrees = parseWorktrees(gitText(ctx.git, ['worktree', 'list', '--porcelain']));
  const cliHeads = await collectCliHeads(ctx);
  if (!ctx.args.dryRun) savePairs(ctx, cliHeads);
  if (ctx.args.pairsOnly) return finish(ctx, null, cliHeads, null);
  const eng = await loadEngine(ctx, { write: !ctx.args.dryRun });
  if (!eng) return finish(ctx, 'error', cliHeads, null);
  ctx.report.mode = eng.pinned ? 'pinned' : 'unpinned';
  const order = await plan(ctx, eng, cliHeads, bandCounts);
  if (ctx.args.dryRun) return finish(ctx, null, cliHeads, eng);
  for (const t of order) {
    if (ctx.args.maxRuns && ctx.runsStarted >= ctx.args.maxRuns) break;
    const stop = await runTarget(ctx, t);
    if (stop) return finish(ctx, stop, cliHeads, eng);
  }
  return finish(ctx, null, cliHeads, eng);
}

/**
 * Returns the exit code. deps (tests): { root, gh, git, stateRoot, cursorLedger, tmpRoot, auditStatePath, env, now, importEngine, laneState,
 *   computeVersions, audit, runAgent, agent, engineDeps (more reviewHead deps), log, out }.
 */
export async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  const log = deps.log ?? ((s) => process.stderr.write(`${s}\n`));
  if (args.error) { log(`local-review-sweep: ${args.error}\n${USAGE}`); return SWEEP_EXIT.USAGE; }
  const counts = readBandCounts(args.bandCounts);
  if (counts.error) { log(`local-review-sweep: ${counts.error}`); return SWEEP_EXIT.USAGE; }
  const ctx = makeCtx(args, { ...deps, log });
  let result;
  try { result = await sweep(ctx, counts.value); } catch (err) { log(`local-review-sweep: stopped by an error: ${clip(err.message)}`); return SWEEP_EXIT.FAILED; }
  ctx.out(args.json ? JSON.stringify(result.report) : textReport(result.report));
  return result.exit;
}

/** Real paths, case-blind on Windows: "c:\..." and "C:\..." name one file there. */
function isMain() {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return fold(real(process.argv[1])) === fold(real(fileURLToPath(import.meta.url)));
}

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}
