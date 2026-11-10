#!/usr/bin/env node
/**
 * harness-doctor: a slim, read-only health check of the harness.
 *
 * Usage: node scripts/harness-doctor.mjs [--json] [--out <file>] [--home <dir>] [--repo <dir>]
 *   --home  the dir that holds .claude (default: the user home)
 *   --repo  the repo root (default: the repo that holds this script)
 *   --json  also write <repo>/.claude/cache/e2e/<YYYY-MM-DD>-harness-doctor.json
 *   --out   also write the same JSON to <file> (parent dirs are created). Needs no --json. A failed write exits 2.
 *
 * It runs no Docker, no network and no paid call. It writes only the --json and --out artifacts.
 * schedule:* reads scripts/scheduled/tasks.json and runs `schtasks /query /v /fo csv` (read-only, Windows only).
 * schedule:readme-tasks reads docs/harness-strategy/README.md and FAILs when it names a CCv3-* task that tasks.json does not list.
 * blocklist:age reads git history. Test seam: HARNESS_DOCTOR_SCHTASKS_DIR holds fake <task>.csv schtasks output.
 * registry:* and lanes:* read <home>/.claude/project-registry.json (the copy lane.mjs reads), the worktree lane.mjs files, and,
 * for registry:mirror-drift, <repo>/.claude/project-registry.json too (FAIL when the two differ in keys, roots, status, laneBoard or laneArtifact),
 * registry:artifact-url judges each board's laneArtifact (phone page) url in the home copy (FAIL on a bad or repeated url, WARN on an ignored one),
 * for registry:project-rows, lanes:board-columns and lanes:schema (agentic_os.__migrations rows vs apps/agentic-os/drizzle/meta/_journal.json,
 * plus the lane_guard_foreign_board trigger), the database named by CONTINUOUS_CLAUDE_DB_URL, DATABASE_URL or OPC_POSTGRES_URL
 * (first one set; no default). That read is one READ ONLY transaction in a child process. No URL is a WARN, an unreachable database is a WARN.
 * Test seam: HARNESS_DOCTOR_NO_DB=1 skips the database read (a PASS that says skipped).
 * One line per check: PASS|WARN|FAIL  <section>:<check>  <detail>. Last line: harness: N pass / N warn / N fail.
 * Info is not a status: a state that is owed later or not yet due is a PASS whose detail starts "info:" (an unlisted worktree folder under 24 h old,
 * a task that never ran before its first scheduled time, a worktree lane.mjs ahead of main on a feature branch). A WARN is a real fault.
 * logs:* WARN at 3 or more distinct (hook, message, folder) pairs in 24 h, FAIL at 5 or more error rows. A "directory not found" row for a path that is gone is benign. In guard-decisions.jsonl a row with a `source` of "test" or "probe" (a test or probe wrote it) is ignored and counted.
 * hooks:trace-fresh: the per-process hook tracer still writes live rows (see hookTraceFresh). FAIL when the newest live row is more than 30 min older
 * than the newest activity (<repo>/.claude/logs/identity-probe.jsonl, <home>/.claude/logs/guard-decisions.jsonl), when the hook of that activity (a hot guard or
 * identity-probe) has no live row of its own within 30 min, or when there is activity and no day file; PASS "info: idle" when the newest activity is over 6 h old
 * and a day file exists; WARN when there is no activity signal or tracing is off (mode file, or CCV3_HOOK_TRACE=0 in the env or settings.json). Never a vacuous PASS.
 * Exit 1 on any FAIL, else 0.
 *
 * lanes:shim, lanes:hook-client-version, hooks:render-check, hooks:dist-parity and lanes:relative-path-guard read the lane propagation files:
 * <home>/.claude/scripts/lane.mjs, the lane hook dists under <home>/.claude/hooks/dist, <home>/.claude/settings.json against the rendered
 * <repo>/.claude/settings.json.template, and the ratchet baseline scripts/coordination/lane-path-guard.baseline.json. Each is a WARN when an
 * input is absent or differs. Only lanes:hook-client-version can FAIL (a second board exists and the live hook build cannot renew its lease).
 *
 * deps:hooks-install reads the PRIMARY checkout's .claude/hooks/node_modules (git rev-parse --git-common-dir, scripts/lib/resolve-deps.mjs):
 * FAIL when there is no .package-lock.json there or pg does not resolve, WARN with the version pair when installed typescript differs
 * from package-lock.json. No network and no install.
 * deps:store-link runs only when that install is complete. It checks the shared store link <primary>/.claude/worktrees/node_modules
 * (scripts/worktree/shared-deps.mjs): PASS when it resolves to the hooks install, WARN when absent, FAIL when dangling,
 * wrong-target, a real file or folder, or no-target.
 *
 * Where each input is written (read these writers before you change a path here):
 *   sync cursor, .sync.pending, .sync-quarantine/<YYYY-MM-DD-HHMMSS>   scripts/sync-to-active.sh
 *   <repo>/.claude/hooks/dist/.build-inputs.json                        .claude/hooks/scripts/write-build-inputs.mjs
 *   logs/pre-pr-gate-errors.jsonl {ts,error}                            .claude/hooks/src/pre-pr-gate.ts
 *   logs/guard-decisions.jsonl {ts,kind,reason}                         .claude/hooks/src/shared/guard-log.ts
 *   logs/hooks.log {ts,level,msg}                                       .claude/hooks/src/shared/logger.ts
 *   state/memory-write-failures.jsonl {ts,error}                        .claude/hooks/src/shared/memory-health.ts
 *   state/coderabbit-paid.jsonl {date,cost}                             scripts/github/cr-paid.mjs
 *   review-router.config.json coderabbit.reviews_7d_manual_date         scripts/github/pr-checkpoint.mjs
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { primaryRoot, resolveDep } from './lib/resolve-deps.mjs';
import { checkStore } from './worktree/shared-deps.mjs';
import { artifactIdOf, boardArtifact, loadRegistry, normalizeRoot } from './coordination/lane-board.mjs';
import { checkLanePaths } from './coordination/lane-path-guard.mjs';
import { registryDrift } from './coordination/registry-drift.mjs';
import { resolveMachineProfile } from './settings/machine-profile.mjs';
import { registrationKey, registrations, renderSettings, varsFromPaths } from './settings/render-settings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const DAY_CAP_USD = 15;
const CAP_WARN_FRACTION = 0.8;
const STALE_REVIEW_DAYS = 7;
const CHILD_TIMEOUT_MS = 60000;

const result = (status, section, check, detail) => ({ status, section, check, detail });
const absent = (section, check, file) => result('PASS', section, check, `absent: ${file}`);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// ---- options ----
export function parseArgs(argv) {
  const o = { json: false, out: null, home: homedir(), repo: resolve(HERE, '..') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') o.json = true;
    else if (argv[i] === '--out') {
      if (!argv[i + 1]) throw new Error('--out needs a file');
      o.out = resolve(argv[++i]);
    } else if (argv[i] === '--home' || argv[i] === '--repo') {
      if (!argv[i + 1]) throw new Error(`${argv[i]} needs a directory`);
      o[argv[i].slice(2)] = resolve(argv[++i]);
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return o;
}

// ---- git ----
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const msg = (err) => String(err?.stderr || err?.message || err).trim().split('\n')[0];
// git prints real paths; --repo may come through a link (a junction, macOS /var -> /private/var, an 8.3 short name).
const realOrResolved = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
const samePath = (a, b) => {
  const norm = (p) => realOrResolved(p).replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

// ---- hooks ----
const HOOK_CHECKS = [
  ['registration-reconcile', ['scripts', 'hooks', 'registration-reconcile.mjs']],
  ['hook-contract-guard', ['scripts', 'hooks', 'hook-contract-guard.mjs']],
  ['hook-parity', ['scripts', 'settings', 'hook-parity.mjs']],
];

function summaryLine(out) {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(PASS|FAIL|WARN)\b/.test(l)) ?? lines.at(-1) ?? '(no output)';
}

/** Runs one repo check as a child process with the doctor's home. Exit 0 is PASS, anything else FAIL. */
function runRepoCheck(o, name, rel) {
  const script = join(o.repo, ...rel);
  // A missing check script is a WARN, not a PASS: a moved script would hide the drift it exists to catch.
  if (!existsSync(script)) return result('WARN', 'hooks', name, `missing ${script}: the check cannot run (was it renamed or moved?)`);
  const env = { ...process.env, USERPROFILE: o.home, HOME: o.home };
  const r = spawnSync(process.execPath, [script], { cwd: o.repo, env, encoding: 'utf8', windowsHide: true, timeout: CHILD_TIMEOUT_MS });
  if (r.error) return result('FAIL', 'hooks', name, `${script} did not finish: ${msg(r.error)}`);
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return result(r.status === 0 ? 'PASS' : 'FAIL', 'hooks', name, `${script} exit ${r.status}: ${summaryLine(text)}`);
}

function baselineClean(o) {
  const rel = '.claude/hooks/registration-baseline.json';
  const file = join(o.repo, ...rel.split('/'));
  try {
    const dirty = git(o.repo, ['status', '--porcelain', '--', rel]);
    return dirty ? result('WARN', 'hooks', 'baseline-clean', `${file} has uncommitted changes (${dirty.slice(0, 2).trim()})`)
      : result('PASS', 'hooks', 'baseline-clean', `${file} matches git`);
  } catch (err) { return result('WARN', 'hooks', 'baseline-clean', `git status failed for ${file}: ${msg(err)}`); }
}

/** The manifest lives in the repo dist. The sync copies only dist/*.mjs to the active copy, and never builds there. */
function buildInputs(o) {
  const hooks = join(o.repo, '.claude', 'hooks');
  const file = join(hooks, 'dist', '.build-inputs.json');
  return existsSync(file) ? result('PASS', 'hooks', 'build-inputs', `found ${file}`)
    : result('WARN', 'hooks', 'build-inputs', `missing ${file}: run npm run build in ${hooks}, then scripts/sync-to-active.sh --changed`);
}

// hooksRenderCheck and hooksDistParity are defined in the lane propagation block below; they run when the section runs.
const hooksSection = (o) => [...HOOK_CHECKS.map(([n, rel]) => runRepoCheck(o, n, rel)), baselineClean(o), buildInputs(o), hooksRenderCheck(o), hooksDistParity(o), hookTraceFresh(o)];

// ---- sync ----
function syncCursor(o) {
  const file = join(o.home, '.claude', 'state', 'sync-cursor');
  if (!existsSync(file)) return result('FAIL', 'sync', 'cursor', `missing ${file}: no sync has run`);
  const cursor = readFileSync(file, 'utf8').trim();
  let main;
  try { main = git(o.repo, ['rev-parse', 'main']); } catch (err) { return result('WARN', 'sync', 'cursor', `cannot read main in ${o.repo}: ${msg(err)}`); }
  return cursor === main ? result('PASS', 'sync', 'cursor', `${file} equals main ${main.slice(0, 7)}`)
    : result('WARN', 'sync', 'cursor', `${file} is ${cursor.slice(0, 7)}, main is ${main.slice(0, 7)}: run scripts/sync-to-active.sh --changed`);
}

function syncPending(o) {
  const file = join(o.home, '.claude', '.sync.pending');
  return existsSync(file) ? result('WARN', 'sync', 'pending', `marker ${file} exists: a sync is owed`) : result('PASS', 'sync', 'pending', `no ${file}`);
}

/** The time a quarantine dir was made. The name is a local YYYY-MM-DD-HHMMSS stamp; an odd name uses its mtime. */
export function quarantineTime(name, mtimeMs) {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : mtimeMs;
}

function syncQuarantine(o) {
  const dir = join(o.home, '.claude', '.sync-quarantine');
  if (!existsSync(dir)) return absent('sync', 'quarantine', dir);
  const fresh = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
    .filter((d) => Date.now() - quarantineTime(d.name, statSync(join(dir, d.name)).mtimeMs) < 7 * DAY).map((d) => d.name);
  return fresh.length ? result('WARN', 'sync', 'quarantine', `${fresh.length} quarantine dir(s) in the last 7 days under ${dir}: ${fresh.slice(0, 3).join(', ')}`)
    : result('PASS', 'sync', 'quarantine', `no quarantine dir newer than 7 days under ${dir}`);
}

const ORPHAN_GRACE_MS = DAY; // a folder under .claude/worktrees that git does not list is an orphan only after this long (a session may be mid-setup)
const ORPHAN_HELPER = 'node scripts/worktree/orphans.mjs'; // the dry-run helper (package D14)
const STORE_LINK_NAME = 'node_modules';

function worktreeFolders(o) {
  const dir = join(o.repo, '.claude', 'worktrees');
  if (!existsSync(dir)) return absent('sync', 'worktrees', dir);
  let listed;
  try { listed = git(o.repo, ['worktree', 'list', '--porcelain']).split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)); }
  catch (err) { return result('WARN', 'sync', 'worktrees', `git worktree list failed in ${o.repo}: ${msg(err)}`); }
  const now = Date.now();
  // node_modules here is the shared store link (scripts/worktree/shared-deps.mjs), never a worktree and never an orphan. deps:store-link judges it.
  const orphans = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== STORE_LINK_NAME && !listed.some((w) => samePath(w, join(dir, d.name))))
    .map((d) => ({ name: d.name, age: now - statSync(join(dir, d.name)).mtimeMs }));
  const old = orphans.filter((x) => x.age >= ORPHAN_GRACE_MS);
  const young = orphans.filter((x) => x.age < ORPHAN_GRACE_MS);
  if (old.length) {
    const oldest = Math.floor(Math.max(...old.map((x) => x.age)) / HOUR);
    const ignored = young.length ? `; ${young.length} younger than 24 h ignored` : '';
    return result('WARN', 'sync', 'worktrees', `${old.length} folder(s) under ${dir} not in git worktree list and 24 h old or older (oldest ${oldest} h): ${old.map((x) => x.name).join(', ')}; dry run: ${ORPHAN_HELPER}${ignored}`);
  }
  return young.length ? result('PASS', 'sync', 'worktrees', `info: ${young.length} folder(s) under ${dir} not in git worktree list but under 24 h old, so not an orphan yet: ${young.map((x) => x.name).join(', ')}`)
    : result('PASS', 'sync', 'worktrees', `every folder under ${dir} is a git worktree`);
}

const syncSection = (o) => [syncCursor(o), syncPending(o), syncQuarantine(o), worktreeFolders(o)];

// ---- logs ----
/** The last MAX_LOG_BYTES of a file as text. A cut file drops its first, partial line. */
function readTail(file) {
  const size = statSync(file).size;
  if (size <= MAX_LOG_BYTES) return readFileSync(file, 'utf8');
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_LOG_BYTES);
    readSync(fd, buf, 0, MAX_LOG_BYTES, size - MAX_LOG_BYTES);
    return buf.toString('utf8').split('\n').slice(1).join('\n');
  } finally { closeSync(fd); }
}

/** The path of a "directory not found: <path>" error whose path no longer exists, else null. Such a row is a stale path, not a live fault. */
function goneDirectory(message, exists) {
  const path = /^directory not found: (.+)$/.exec(message)?.[1];
  return path && !exists(path) ? path : null;
}

/**
 * Counts the error lines of the last `windowMs`. `isError` picks the lines; a line that is not JSON or has no valid ts is skipped and counted.
 * `pairs` is the number of distinct (hook, message, folder) pairs; the folder is the row's cwd (only some logs carry one).
 * A benign row ("directory not found" for a path that is gone) is counted in `benign` and in nothing else.
 * A row that `isIgnored` picks (guard-decisions: a `source` of "test" or "probe", so a test or a probe wrote it) is counted in `ignored` and in nothing else.
 * `top` names the biggest (hook, message) group as `hook: message`; a row with no hook gives the bare message.
 */
export function scanLog(text, isError, windowMs, nowMs = Date.now(), exists = existsSync, isIgnored = () => false) {
  const tally = new Map();
  const seen = new Set();
  let count = 0;
  let benign = 0;
  let ignored = 0;
  let unparsable = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { unparsable++; continue; }
    if (!obj || typeof obj !== 'object' || !isError(obj)) continue;
    const t = Date.parse(obj.ts);
    if (Number.isNaN(t)) { unparsable++; continue; }
    if (nowMs - t > windowMs) continue;
    if (isIgnored(obj)) { ignored++; continue; }
    const full = String(obj.error ?? obj.reason ?? obj.msg ?? obj.message ?? '(no message)');
    if (goneDirectory(full, exists)) { benign++; continue; }
    count++;
    const m = full.slice(0, 100);
    const group = typeof obj.hook === 'string' && obj.hook ? `${obj.hook}: ${m}` : m;
    seen.add(`${group}\u0000${obj.cwd ?? obj.data?.cwd ?? ''}`);
    tally.set(group, (tally.get(group) ?? 0) + 1);
  }
  const [top, topN] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return { count, pairs: seen.size, benign, ignored, unparsable, top, topN };
}

const LOG_FAIL_ROWS = 5; // this many error rows in 24 h is a FAIL
const LOG_WARN_PAIRS = 3; // this many distinct (hook, message, folder) pairs is a WARN; one repeating error is not
/** FAIL at 5 or more error rows, WARN at 3 or more distinct (hook, message, folder) pairs, else PASS. */
export const logLevel = ({ count, pairs }) => (count >= LOG_FAIL_ROWS ? 'FAIL' : pairs >= LOG_WARN_PAIRS ? 'WARN' : 'PASS');

const LOGS = [
  { check: 'pre-pr-gate-errors', dir: 'logs', file: 'pre-pr-gate-errors.jsonl', isError: () => true },
  { check: 'guard-decisions', dir: 'logs', file: 'guard-decisions.jsonl', isError: (o) => o.kind === 'error', isIgnored: (o) => o.source === 'test' || o.source === 'probe' },
  { check: 'memory-write-failures', dir: 'state', file: 'memory-write-failures.jsonl', isError: () => true },
  { check: 'hooks.log', dir: 'logs', file: 'hooks.log', isError: (o) => (o.level !== undefined ? o.level === 'error' : /error/i.test(JSON.stringify(o))) },
];

function logCheck(o, spec) {
  const file = join(o.home, '.claude', spec.dir, spec.file);
  if (!existsSync(file)) return absent('logs', spec.check, file);
  const s = scanLog(readTail(file), spec.isError, DAY, Date.now(), existsSync, spec.isIgnored);
  const skipped = s.unparsable ? `; ${s.unparsable} unparsable line(s) skipped` : '';
  const top = s.top ? `; ${s.pairs} distinct (hook, message, folder) pair(s); top: "${s.top}" x${s.topN}` : '';
  const benign = s.benign ? `; ${s.benign} benign (directory not found, path no longer exists), not counted` : '';
  const ignored = s.ignored ? `; ${s.ignored} ignored (source is test or probe: a test or probe wrote them)` : '';
  return result(logLevel(s), 'logs', spec.check, `${s.count} error(s) in the last 24 h in ${file}${top}${benign}${ignored}${skipped}`);
}

const logsSection = (o) => LOGS.map((spec) => logCheck(o, spec));

// ---- review ----
const chicagoDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

/** Sums the ledger cost of one day in cents. A line that is not JSON or has no usable cost is counted, not summed. */
export function ledgerTotal(text, day) {
  let cents = 0;
  let unparsable = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!Number.isFinite(r?.cost)) throw new Error('no cost');
      // CLI spend rows (kind "cli") have their own daily cap in cr-paid.mjs; the $15 cap counts PR rounds only.
      if (r.date === day && (r.kind ?? 'pr') === 'pr') cents += Math.round(r.cost * 100);
    } catch { unparsable++; }
  }
  return { cents, unparsable };
}

function crPaidCap(o) {
  const file = join(o.home, '.claude', 'state', 'coderabbit-paid.jsonl');
  if (!existsSync(file)) return absent('review', 'cr-paid-cap', file);
  const { cents, unparsable } = ledgerTotal(readFileSync(file, 'utf8'), chicagoDay(new Date()));
  const warn = cents >= DAY_CAP_USD * 100 * CAP_WARN_FRACTION;
  const skipped = unparsable ? `; ${unparsable} unparsable line(s) skipped` : '';
  const over = cents > DAY_CAP_USD * 100 ? ' (over the cap)' : '';
  return result(warn ? 'WARN' : 'PASS', 'review', 'cr-paid-cap', `paid today $${(cents / 100).toFixed(2)} of $${DAY_CAP_USD} cap${over} in ${file}${skipped}`);
}

const dayNumber = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY : NaN; };

function reviews7d(o) {
  const file = join(o.repo, 'review-router.config.json');
  if (!existsSync(file)) return result('WARN', 'review', 'reviews-7d', `missing ${file}`);
  let cr;
  try { cr = readJson(file).coderabbit ?? {}; } catch (err) { return result('WARN', 'review', 'reviews-7d', `${file} is not valid JSON: ${msg(err)}`); }
  if (cr.reviews_7d_manual == null) return result('PASS', 'review', 'reviews-7d', `reviews_7d_manual is null (unknown) in ${file}`);
  const age = dayNumber(chicagoDay(new Date())) - dayNumber(cr.reviews_7d_manual_date);
  if (Number.isNaN(age)) return result('WARN', 'review', 'reviews-7d', `reviews_7d_manual_date missing or not YYYY-MM-DD in ${file}`);
  return age > STALE_REVIEW_DAYS ? result('WARN', 'review', 'reviews-7d', `count ${cr.reviews_7d_manual} is ${age} days old in ${file}: update reviews_7d_manual`)
    : result('PASS', 'review', 'reviews-7d', `count ${cr.reviews_7d_manual} read ${age} day(s) ago in ${file}`);
}

const reviewSection = (o) => [crPaidCap(o), reviews7d(o)];

// ---- repo ----
/** A scheduled run reads whatever branch another session left checked out. The result must say so. */
function repoBranch(o) {
  let branch;
  try { branch = git(o.repo, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch (err) { return result('WARN', 'repo', 'branch', `cannot read the branch of ${o.repo}: ${msg(err)}`); }
  if (branch === 'main') return result('PASS', 'repo', 'branch', `${o.repo} is on main`);
  const what = branch === 'HEAD' ? 'a detached HEAD' : `branch ${branch}`;
  return result('WARN', 'repo', 'branch', `${o.repo} is on ${what}, not main: every check here reads that tree, not main`);
}

const repoSection = (o) => [repoBranch(o)];

// ---- schedule ----
const SCHEDULE_REL = ['scripts', 'scheduled', 'tasks.json'];
const TASK_RUNNING = 267009; // SCHED_S_TASK_RUNNING
const TASK_NEVER_RAN = 267011; // SCHED_S_TASK_HAS_NOT_RUN

/** Rows of a CSV text. Handles quoted commas, doubled quotes and CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Runs the real schtasks. Read-only. */
function schtasksQuery(name) {
  const r = spawnSync('schtasks', ['/query', '/tn', name, '/v', '/fo', 'csv'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return r.error ? { error: msg(r.error) } : { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Runs the real `schtasks /query /tn <name> /xml`. Read-only. It holds the battery and wake settings and the trigger, which the CSV does not. */
function schtasksXml(name) {
  const r = spawnSync('schtasks', ['/query', '/tn', name, '/xml'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return r.error ? { error: msg(r.error) } : { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Test seam: HARNESS_DOCTOR_SCHTASKS_DIR holds <task name>.<ext> files of fake schtasks output. A missing file answers like an unknown task. */
function fakeSchtasksFile(dir, ext) {
  return (name) => {
    const file = join(dir, `${name}.${ext}`);
    return existsSync(file) ? { status: 0, stdout: readFileSync(file, 'utf8'), stderr: '' }
      : { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
  };
}
const fakeSchtasksQuery = (dir) => fakeSchtasksFile(dir, 'csv');
const fakeSchtasksXml = (dir) => fakeSchtasksFile(dir, 'xml');

/** schtasks prints the last run as M/D/YYYY h:mm:ss AM|PM (English locale), or an ISO-like stamp. NaN when it is neither. */
function parseRunTime(s) {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?$/i.exec(s);
  if (us) {
    const [, mo, d, y, h, mi, sec, ap] = us;
    const hour = ap ? (+h % 12) + (ap.toUpperCase() === 'PM' ? 12 : 0) : +h;
    return +mo > 12 ? NaN : new Date(+y, +mo - 1, +d, hour, +mi, +sec).getTime();
  }
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) ? new Date(s.replace(' ', 'T')).getTime() : NaN;
}

/** The problem with a tasks.json entry, or null. */
function entryProblem(t) {
  if (!t || typeof t.name !== 'string' || !t.name) return 'has no name';
  if (!Array.isArray(t.allowedExit) || !t.allowedExit.every(Number.isInteger)) return 'allowedExit is not an array of integers';
  if (!(t.maxAgeHours > 0)) return 'maxAgeHours is not a positive number';
  if ('warnExit' in t && (!Array.isArray(t.warnExit) || !t.warnExit.every(Number.isInteger))) return 'warnExit is not an array of integers';
  for (const field of ['llm', 'wake', 'battery', 'hidden']) if (field in t && typeof t[field] !== 'boolean') return `${field} is not true or false`;
  return null;
}

// ---- registration drift: the registered task XML against tasks.json (llm, wake, trigger) ----
/** A boolean setting of the task XML, or the Windows default when the tag is absent (Windows leaves out a tag that is at its default). */
function xmlFlag(settings, name, dflt) {
  const m = new RegExp(`<${name}>\\s*(true|false)\\s*</${name}>`, 'i').exec(settings);
  return m ? m[1].toLowerCase() === 'true' : dflt;
}

/** Minutes in an ISO interval such as PT5M or PT1H, else NaN (a day or longer is not a repeat the tasks.json grammar names). */
function isoMinutes(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(String(iso).trim());
  return m && (m[1] || m[2]) ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : NaN;
}

/** The repeat of a TimeTrigger in the task XML: { every: 'every 5m', duration } (duration null: repeats for ever), or null. */
function xmlRepeat(xml) {
  const block = /<TimeTrigger>[\s\S]*?<\/TimeTrigger>/.exec(xml)?.[0];
  const rep = /<Repetition>[\s\S]*?<\/Repetition>/.exec(block ?? '')?.[0];
  const minutes = isoMinutes(/<Interval>([^<]*)<\/Interval>/.exec(rep ?? '')?.[1] ?? '');
  if (!rep || Number.isNaN(minutes)) return null;
  return { every: `every ${minutes}m`, duration: /<Duration>([^<]*)<\/Duration>/.exec(rep)?.[1] ?? null };
}

/** The trigger of the task XML as text: "daily 07:50", "weekly Monday 09:20", "every 5m", or null when it has none of those. */
function xmlTrigger(xml) {
  const repeat = xmlRepeat(xml);
  if (repeat) return repeat.every;
  const block = /<CalendarTrigger>[\s\S]*?<\/CalendarTrigger>/.exec(xml)?.[0];
  const time = /<StartBoundary>[^<]*?T(\d{2}:\d{2})/.exec(block ?? '')?.[1];
  if (!block || !time) return null;
  if (/<ScheduleByDay>/.test(block)) return `daily ${time}`;
  const days = /<DaysOfWeek>([\s\S]*?)<\/DaysOfWeek>/.exec(block)?.[1];
  if (days === undefined) return `other ${time}`;
  return `weekly ${[...days.matchAll(/<(\w+)\s*\/>/g)].map((d) => d[1]).join('+')} ${time}`;
}

/** The drift between one task's XML and its tasks.json entry: a list of texts, or { warn } when the XML cannot be judged. */
function registrationDrift(t, q) {
  if (q.error) return { warn: `cannot read the task xml: ${q.error}` };
  if (q.status !== 0) return { warn: `cannot read the task xml (schtasks exit ${q.status}: ${String(q.stderr).trim().split('\n')[0]})` };
  const settings = /<Settings>[\s\S]*?<\/Settings>/.exec(q.stdout)?.[0];
  if (!settings) return { warn: 'the task xml has no Settings block: cannot compare battery and wake' };
  const llm = t.llm === true || t.battery === true; // either field asks for a start on battery
  const field = t.battery === true ? 'battery=true' : `llm=${t.llm === true}`;
  const want = llm ? 'allowed' : 'blocked';
  const drift = [];
  const disallow = xmlFlag(settings, 'DisallowStartIfOnBatteries', true);
  const stop = xmlFlag(settings, 'StopIfGoingOnBatteries', true);
  if (disallow === llm) drift.push(`battery: start on battery is ${disallow ? 'blocked' : 'allowed'}, tasks.json ${field} wants it ${want}`);
  if (stop === llm) drift.push(`battery: stop when going on battery is ${stop ? 'on' : 'off'}, tasks.json ${field} wants it ${llm ? 'off' : 'on'}`);
  const wake = xmlFlag(settings, 'WakeToRun', false);
  if (wake !== (t.wake === true)) drift.push(`wake: WakeToRun is ${wake}, tasks.json wake=${t.wake === true}`);
  const trigger = xmlTrigger(q.stdout);
  const wantTrigger = /^(daily \d{2}:\d{2}|weekly \w+ \d{2}:\d{2}|every \d+m)$/.test(t.trigger) ? t.trigger : null; // another grammar: not compared
  if (wantTrigger && trigger?.toLowerCase() !== wantTrigger.toLowerCase()) drift.push(`trigger: the task has "${trigger ?? 'no calendar trigger'}", tasks.json says "${t.trigger}"`);
  const stop1 = xmlRepeat(q.stdout)?.duration;
  if (stop1 && wantTrigger?.startsWith('every') && !/^P[1-9]\d*[DWMY]/.test(stop1)) drift.push(`trigger: the repetition stops after ${stop1} (under one day), so the task stops running`);
  const hidden = hiddenDrift(t, q.stdout);
  if (hidden) drift.push(hidden);
  return { drift };
}

/**
 * Text when the registered action differs from tasks.json hidden; null when equal or when the XML has no Arguments to read.
 * hidden=true wants Command conhost.exe and Arguments that start with --headless. Anything else is the plain form.
 */
function hiddenDrift(t, xml) {
  const args = /<Arguments>([^<]*)<\/Arguments>/.exec(xml)?.[1];
  if (args === undefined) return null;
  const command = /<Command>([^<]*)<\/Command>/.exec(xml)?.[1] ?? '';
  const isConhost = /(^|[\\/])conhost\.exe"?$/i.test(command.trim());
  const headless = /^\s*--headless\b/i.test(args);
  if (t.hidden === true) {
    if (isConhost && headless) return null;
    const got = isConhost ? 'conhost.exe without --headless first' : `${command.trim() || 'no command'} (not conhost.exe --headless)`;
    return `hidden: the registered action is ${got}, tasks.json hidden=true wants conhost.exe --headless powershell.exe`;
  }
  return isConhost && headless ? 'hidden: the registered action runs through conhost.exe --headless, tasks.json hidden is not true' : null;
}

/** The header-name lookup of one schtasks answer, or the WARN text. */
function taskRow(out, name) {
  const rows = parseCsv(out);
  const header = rows[0] ?? [];
  const col = Object.fromEntries(['TaskName', 'Last Run Time', 'Last Result'].map((h) => [h, header.indexOf(h)]));
  const missing = ['Last Run Time', 'Last Result'].filter((h) => col[h] < 0);
  if (missing.length) return { warn: `schtasks has no column ${missing.join(', ')} (headers: ${header.slice(0, 8).join('|')}): another Windows language?` };
  const data = rows.slice(1).find((r) => col.TaskName < 0 || r[col.TaskName] === `\\${name}`);
  return data ? { lastRun: data[col['Last Run Time']], lastResult: data[col['Last Result']] } : { warn: `schtasks answered with no row for \\${name}` };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad2 = (n) => String(n).padStart(2, '0');
const fmtLocal = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

/**
 * The first time the task XML says it fires, in ms (local time), or NaN when the XML has no trigger it can read.
 * A daily, repeating or one-time trigger first fires at its StartBoundary. A weekly trigger first fires on the first listed weekday
 * at or after the StartBoundary date, at the StartBoundary time. The boundary is read as wall-clock time: the offset in it is the machine's own.
 */
export function firstFire(xml) {
  const block = /<(CalendarTrigger|TimeTrigger)>[\s\S]*?<\/\1>/.exec(xml)?.[0];
  const m = /<StartBoundary>\s*(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(block ?? '');
  if (!m) return NaN;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const start = new Date(y, mo - 1, d, h, mi).getTime();
  const days = /<DaysOfWeek>([\s\S]*?)<\/DaysOfWeek>/.exec(block)?.[1];
  if (days === undefined) return start;
  const want = new Set([...days.matchAll(/<(\w+)\s*\/>/g)].map((x) => WEEKDAYS.indexOf(x[1])).filter((i) => i >= 0));
  for (let i = 0; i < 7; i++) {
    const at = new Date(y, mo - 1, d + i, h, mi);
    if (want.has(at.getDay())) return at.getTime();
  }
  return start;
}

/** Judges one registered task's last run and result. `xml` is the answer of schtasks /xml (or null): it dates the first scheduled run. */
function judgeTask(t, row, now, xml = null) {
  const code = Number(row.lastResult);
  if (!Number.isInteger(code)) return result('WARN', 'schedule', t.name, `Last Result "${row.lastResult}" is not a number`);
  const ran = parseRunTime(row.lastRun);
  if (code === TASK_NEVER_RAN || row.lastRun === 'N/A' || new Date(ran).getFullYear() === 1999) {
    const first = xml && xml.status === 0 ? firstFire(xml.stdout) : NaN;
    // Not due yet is not a fault: nothing was owed. Info is a PASS whose detail starts "info:". Once a fire time has passed, never ran is a WARN.
    if (first > now) return result('PASS', 'schedule', t.name, `info: registered, never ran, not due yet: first scheduled run ${fmtLocal(first)} (trigger ${t.trigger})`);
    return result('WARN', 'schedule', t.name, `task is registered but never ran (trigger ${t.trigger}${first <= now ? `; first scheduled run ${fmtLocal(first)} has passed` : ''})`);
  }
  if (code !== TASK_RUNNING && !t.allowedExit.includes(code) && t.warnExit?.includes(code)) return result('WARN', 'schedule', t.name, `last result ${code} is in warnExit [${t.warnExit}]: the task ran and reported a warning; read its log; last run ${row.lastRun}`);
  if (code !== TASK_RUNNING && !t.allowedExit.includes(code)) return result('FAIL', 'schedule', t.name, `last result ${code} is not in allowedExit [${t.allowedExit}]; last run ${row.lastRun}`);
  if (Number.isNaN(ran)) return result('WARN', 'schedule', t.name, `Last Run Time "${row.lastRun}" is not a date the doctor reads`);
  const hours = (now - ran) / HOUR;
  return hours > t.maxAgeHours ? result('WARN', 'schedule', t.name, `last run ${row.lastRun} is ${hours.toFixed(1)} h old, over maxAgeHours ${t.maxAgeHours}`)
    : result('PASS', 'schedule', t.name, `last result ${code}, last run ${row.lastRun} (${hours.toFixed(1)} h ago, limit ${t.maxAgeHours})`);
}

/** Folds registration drift into the task's one row. A FAIL stays a FAIL, a WARN stays a WARN, a PASS with drift becomes a WARN. No XML query: no drift check. */
function withDrift(base, t, xml) {
  if (!xml) return base;
  const found = registrationDrift(t, xml);
  const text = found.warn ?? found.drift.join('; ');
  if (!text) return base;
  return result(base.status === 'PASS' ? 'WARN' : base.status, 'schedule', t.name, `${base.detail}; registration drift: ${text}`);
}

function checkTask(t, query, queryXml, now) {
  const problem = entryProblem(t);
  if (problem) return result('WARN', 'schedule', t?.name || 'entry', `tasks.json entry ${problem}`);
  const q = query(t.name);
  if (q.error) return result('WARN', 'schedule', t.name, `cannot run schtasks: ${q.error}`);
  if (q.status !== 0) return result('WARN', 'schedule', t.name, `task is not registered (schtasks exit ${q.status}: ${String(q.stderr).trim().split('\n')[0]}); trigger ${t.trigger}`);
  const row = taskRow(q.stdout, t.name);
  if (row.warn) return result('WARN', 'schedule', t.name, row.warn);
  const xml = queryXml ? queryXml(t.name) : null; // one XML read serves the first-run date and the drift check
  return withDrift(judgeTask(t, row, now, xml), t, xml);
}

/**
 * One check per task in scripts/scheduled/tasks.json, with registration drift folded into the same row.
 * `deps` (platform, query, queryXml, now) is injectable for tests. An injected `query` with no `queryXml` skips the drift
 * check, so a test of the last result never reads the real Task Scheduler.
 */
export function scheduleChecks(o, deps = {}) {
  const seam = process.env.HARNESS_DOCTOR_SCHTASKS_DIR;
  const platform = deps.platform ?? (seam ? 'win32' : process.platform);
  const query = deps.query ?? (seam ? fakeSchtasksQuery(seam) : schtasksQuery);
  const queryXml = deps.queryXml ?? (deps.query ? null : seam ? fakeSchtasksXml(seam) : schtasksXml);
  if (platform !== 'win32') return [result('PASS', 'schedule', 'tasks', `skipped: Task Scheduler exists only on Windows (this is ${platform})`)];
  const file = join(o.repo, ...SCHEDULE_REL);
  if (!existsSync(file)) return [result('WARN', 'schedule', 'tasks', `missing ${file}: no scheduled task is checked`)];
  let tasks;
  try { tasks = readJson(file).tasks; } catch (err) { return [result('WARN', 'schedule', 'tasks', `${file} is not valid JSON: ${msg(err)}`)]; }
  if (!Array.isArray(tasks)) return [result('WARN', 'schedule', 'tasks', `${file} has no "tasks" array`)];
  if (!tasks.length) return [result('PASS', 'schedule', 'tasks', `${file} lists 0 tasks`)];
  return tasks.map((t) => checkTask(t, query, queryXml, deps.now ?? Date.now()));
}

/**
 * The Notion sync of the reminder tick, from its heartbeat ~/.claude/state/reminders/latest.json. WARN when the last sync failed or
 * failCount is 3 or more (a connector login that fails under Task Scheduler retries every hour and nothing else shows it). No file: PASS.
 * The sync is off unless the file sync-enabled sits next to latest.json (`lane.mjs remind sync on`). Off: PASS "sync off", never a WARN.
 */
export function reminderSyncCheck(o) {
  const dir = join(o.home, '.claude', 'state', 'reminders');
  const file = join(dir, 'latest.json');
  if (!existsSync(join(dir, 'sync-enabled'))) return result('PASS', 'schedule', 'reminder-sync', 'sync off (turn it on with: lane.mjs remind sync on)');
  if (!existsSync(file)) return absent('schedule', 'reminder-sync', file);
  let s;
  try { s = readJson(file); } catch (err) { return result('WARN', 'schedule', 'reminder-sync', `${file} is not valid JSON: ${msg(err)}`); }
  const fails = Number(s?.failCount) || 0;
  if (s?.lastSyncOk === false || fails >= 3) {
    return result('WARN', 'schedule', 'reminder-sync', `the Notion sync is failing (failCount ${fails}, last run ${s?.ranAt ?? 'unknown'}): ${String(s?.lastError ?? 'no error recorded').slice(0, 200)}`);
  }
  return result('PASS', 'schedule', 'reminder-sync', `last sync ok or not run yet (failCount ${fails}, last tick ${s?.ranAt ?? 'unknown'})`);
}

const README_REL = ['docs', 'harness-strategy', 'README.md'];
const README_TASK_TOKEN = /\bCCv3-[A-Za-z]\w*(?:-\w+)*/gi;

/** Each CCv3-* token in a text, with the line numbers where it appears: Map(token, [line, ...]). */
function taskTokens(text) {
  const found = new Map();
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [token] of line.matchAll(README_TASK_TOKEN)) found.set(token, [...(found.get(token) ?? []), i + 1]);
  });
  return found;
}

/**
 * The README must not name a CCv3-* scheduled task that scripts/scheduled/tasks.json does not list. The Snapshot task stayed in the
 * README after it was gone, and the doctor read only tasks.json, so it reported green. FAIL names each missing token and its lines.
 * No README: PASS (absent). tasks.json missing or not valid JSON: WARN. Zero tokens: PASS that reports 0, so a reader sees the check read nothing.
 * Names match without case, as schtasks does. A retired name has no exemption: write it without the "CCv3-" prefix.
 * Limit: a hyphenated word such as CCv3-Lane-Snapshot-style reads as one token and gives a false FAIL. Rephrase the prose.
 */
export function readmeTaskCheck(o) {
  const readme = join(o.repo, ...README_REL);
  if (!existsSync(readme)) return absent('schedule', 'readme-tasks', readme);
  const file = join(o.repo, ...SCHEDULE_REL);
  let names;
  try { names = readJson(file).tasks.map((t) => t.name); } catch (err) { return result('WARN', 'schedule', 'readme-tasks', `cannot read task names from ${file}: ${msg(err)}`); }
  const tokens = taskTokens(readFileSync(readme, 'utf8'));
  const known = names.map((n) => String(n).toLowerCase());
  const missing = [...tokens].filter(([token]) => !known.includes(token.toLowerCase()));
  if (!missing.length) return result('PASS', 'schedule', 'readme-tasks', `${[...tokens.values()].flat().length} task name(s) in ${readme} are all in tasks.json`);
  const list = missing.map(([token, lines]) => `${token} (line ${lines.join(', ')})`).join('; ');
  return result('FAIL', 'schedule', 'readme-tasks', `${readme} names a task that is not in tasks.json: ${list}`);
}

const scheduleSection = (o) => [...scheduleChecks(o), reminderSyncCheck(o), readmeTaskCheck(o)];

// ---- blocklist ----
const BLOCKLIST_REL = '.claude/hooks/src/shared/malicious-packages.json';
const BLOCKLIST_WARN_DAYS = 3;
const BLOCKLIST_FAIL_DAYS = 14;

/** The last commit that touched the blocklist: { sec, sha }, or null when none did. */
function blocklistCommit(repo) {
  const out = git(repo, ['log', '-1', '--format=%ct %h', '--', BLOCKLIST_REL]);
  const [sec, sha] = out.split(' ');
  return out ? { sec: Number(sec), sha } : null;
}

/** The blocklist job stopped for 16 days once and nobody knew. WARN over 3 days, FAIL over 14. `deps` (now, lastCommit) is injectable. */
export function blocklistAge(o, deps = {}) {
  const commit = (deps.lastCommit ?? blocklistCommit)(o.repo);
  if (!commit) return result('WARN', 'blocklist', 'age', `no commit touches ${BLOCKLIST_REL} in ${o.repo}`);
  const days = ((deps.now ?? Date.now()) - commit.sec * 1000) / DAY;
  const detail = `${BLOCKLIST_REL} last changed in commit ${commit.sha}, ${days.toFixed(1)} days ago`;
  if (days > BLOCKLIST_FAIL_DAYS) return result('FAIL', 'blocklist', 'age', `${detail} (over ${BLOCKLIST_FAIL_DAYS}): is the update job running?`);
  return days > BLOCKLIST_WARN_DAYS ? result('WARN', 'blocklist', 'age', `${detail} (over ${BLOCKLIST_WARN_DAYS})`) : result('PASS', 'blocklist', 'age', detail);
}

const blocklistSection = (o) => [blocklistAge(o)];

// ---- registry ----
const REGISTRY_REL = ['.claude', 'project-registry.json'];
const DB_VARS = ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL'];
const isLiveEntry = (e) => e.status.toLowerCase() !== 'inactive';

/** The non-inactive entries of the registry copy lane.mjs reads, or { result } when the file cannot be judged. */
function liveRegistry(o, check) {
  const file = join(o.home, ...REGISTRY_REL);
  if (!existsSync(file)) return { result: absent('registry', check, file) };
  try { JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (err) { return { result: result('WARN', 'registry', check, `${file} is not valid JSON: ${msg(err)}`) }; }
  return { file, entries: loadRegistry({ registryPath: file, env: {} }).filter(isLiveEntry) };
}

/** Premortem T1: six of eight registry roots did not exist, and a board root that is gone gives a board no session can reach. */
export function registryRootsExist(o) {
  const reg = liveRegistry(o, 'roots-exist');
  if (reg.result) return reg.result;
  const missing = reg.entries.filter((e) => !e.path || !existsSync(e.path));
  if (!missing.length) return result('PASS', 'registry', 'roots-exist', `all ${reg.entries.length} non-inactive registry root(s) exist on disk in ${reg.file}`);
  const names = missing.map((e) => `${e.key} (${e.path || 'no path'})`).join(', ');
  return result('FAIL', 'registry', 'roots-exist', `${missing.length} non-inactive registry root(s) missing on disk in ${reg.file}: ${names}; fix the path or set status inactive`);
}

/**
 * The home mirror (the copy lane.mjs reads) and the repo copy must agree on what picks a lane board and its phone page: keys, roots, status, laneBoard, laneArtifact.
 * A stale mirror gives a nested app the board of its own key, and `lane add` then writes lanes with that project_key (PR 297).
 * FAIL on drift: it is silent and writes wrong rows. A missing copy is a PASS that says absent (roots-exist reports a missing mirror).
 */
export function registryMirrorDrift(o) {
  const repoFile = join(o.repo, ...REGISTRY_REL);
  const mirror = join(o.home, ...REGISTRY_REL);
  const r = registryDrift(repoFile, mirror);
  if (r.state === 'repo-absent') return absent('registry', 'mirror-drift', repoFile);
  if (r.state === 'mirror-absent') return absent('registry', 'mirror-drift', mirror);
  if (r.state === 'unreadable') return result('WARN', 'registry', 'mirror-drift', `${repoFile} or ${mirror} is not valid JSON with a projects array`);
  if (r.state === 'same') return result('PASS', 'registry', 'mirror-drift', `${mirror} matches ${repoFile} on keys, roots, status, laneBoard and laneArtifact`);
  const shown = r.diffs.slice(0, 8).join('; ') + (r.diffs.length > 8 ? `; and ${r.diffs.length - 8} more` : '');
  return result('FAIL', 'registry', 'mirror-drift', `${r.diffs.length} difference(s) between the repo copy ${repoFile} and the mirror ${mirror} that lane.mjs reads: ${shown}; run scripts/sync-to-active.sh --changed on main`);
}

/**
 * A board's phone page is the `laneArtifact` url on its own registry entry (board === key, not the default board). The hooks nag for
 * that page, so a bad url nags for nothing and one url on two boards lets one publish clear both boards' pending files. FAIL on a
 * url that is not https://claude.ai/artifact/<id>, on a repeated id and on the default board's id. WARN on a laneArtifact the
 * resolvers ignore (a nested entry, or the default board's entry). The PASS line counts the pages, so 0 is visible, not vacuous.
 * Reads the home mirror (the copy the hooks read); the default board's id comes from <repo>/.claude/artifacts.json, else the fallback.
 */
export function registryArtifactUrl(o) {
  const reg = liveRegistry(o, 'artifact-url');
  if (reg.result) return reg.result;
  const withUrl = reg.entries.filter((e) => e.artifact !== null);
  const ignored = withUrl.filter((e) => e.board !== e.key || e.key === DEFAULT_BOARD);
  const owners = withUrl.filter((e) => !ignored.includes(e));
  const defaultId = boardArtifact(DEFAULT_BOARD, { artifactsPath: join(o.repo, '.claude', 'artifacts.json'), env: {} })?.id ?? null;
  const fails = [];
  const seen = new Map();
  for (const e of owners) {
    const id = artifactIdOf(e.artifact);
    if (!id) { fails.push(`${e.key}: laneArtifact "${e.artifact}" is not https://claude.ai/artifact/<id>`); continue; }
    if (id === defaultId) fails.push(`${e.key}: laneArtifact is the default board's page (${id})`);
    if (seen.has(id)) fails.push(`${e.key}: duplicate id ${id}, also the page of ${seen.get(id)}`); else seen.set(id, e.key);
  }
  if (fails.length) return result('FAIL', 'registry', 'artifact-url', `${fails.join('; ')} in ${reg.file}; fix the laneArtifact line (a board has its own page)`);
  if (ignored.length) {
    const names = ignored.map((e) => `${e.key} (${e.board !== e.key ? `nested on board ${e.board}` : 'default board'})`).join(', ');
    return result('WARN', 'registry', 'artifact-url', `laneArtifact on ${names} in ${reg.file}: a nested entry or the default board's entry is ignored; put it on the entry where board equals key`);
  }
  return result('PASS', 'registry', 'artifact-url', `${owners.length} boards with a phone page in ${reg.file}; urls are strict, unique, and none is the default board's`);
}

// ---- lanes ----
const DB_CHILD_TIMEOUT_MS = 20000;
/** The pg module lives in the hooks bundle or apps/agentic-os of this checkout or the primary: the shared resolver, same as lane.mjs. */
const RESOLVER_URL = pathToFileURL(join(HERE, 'lib', 'resolve-deps.mjs')).href;
const DOCTOR_CHECKOUT = resolve(HERE, '..');

/** One READ ONLY transaction, in a child process so the doctor stays synchronous. Prints one JSON object. */
const DB_READER = `
import { requireDep } from ${JSON.stringify(RESOLVER_URL)};
const out = {};
let pg = null;
try { pg = requireDep('pg', { repoRoot: ${JSON.stringify(DOCTOR_CHECKOUT)} }); } catch (e) { out.error = e.message; }
if (pg) {
  const c = new pg.Client({ connectionString: process.env.HARNESS_DOCTOR_DB_URL, connectionTimeoutMillis: 4000, query_timeout: 8000 });
  try {
    await c.connect();
    await c.query('BEGIN READ ONLY');
    out.columns = Number((await c.query("SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='agentic_os' AND table_name IN ('lane','lane_event') AND column_name='project_key'")).rows[0].n);
    out.trigger = Number((await c.query("SELECT count(*) AS n FROM pg_trigger WHERE tgname='lane_guard_foreign_board' AND NOT tgisinternal")).rows[0].n);
    // to_regclass: a missing table must not abort the read-only transaction.
    if ((await c.query("SELECT to_regclass('agentic_os.__migrations') AS t")).rows[0].t) out.migrations = Number((await c.query('SELECT count(*) AS n FROM agentic_os.__migrations')).rows[0].n);
    else out.migrationsError = 'agentic_os.__migrations does not exist';
    try { out.projects = (await c.query('SELECT key, root_path, status FROM agentic_os.project')).rows; } catch (e) { out.projectsError = e.message; }
    await c.query('ROLLBACK').catch(() => {});
  } catch (e) { out.error = e.message; }
  await c.end().catch(() => {});
}
process.stdout.write(JSON.stringify(out));
`;

const dbUrl = (env = process.env) => DB_VARS.map((n) => env[n]).find((v) => typeof v === 'string' && v.trim())?.trim() ?? null;
const dbFactsCache = new WeakMap();

/** What the doctor reads from the database: { skipped } | { noUrl } | { error } | { columns, projects?, projectsError? }. Read once per run. */
function dbFacts(o) {
  if (dbFactsCache.has(o)) return dbFactsCache.get(o);
  let facts;
  const url = dbUrl();
  if (process.env.HARNESS_DOCTOR_NO_DB === '1') facts = { skipped: true };
  else if (!url) facts = { noUrl: true };
  else {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', DB_READER], {
      env: { ...process.env, HARNESS_DOCTOR_DB_URL: url }, encoding: 'utf8', windowsHide: true, timeout: DB_CHILD_TIMEOUT_MS,
    });
    try { facts = r.error ? { error: msg(r.error) } : JSON.parse(r.stdout); } catch { facts = { error: `the database reader printed no JSON (exit ${r.status}): ${String(r.stderr).trim().split('\n')[0]}` }; }
  }
  dbFactsCache.set(o, facts);
  return facts;
}

/** The WARN or PASS a check gives when the database cannot be read, or null when `facts` holds the answer. */
function dbUnavailable(section, check, facts, what) {
  if (facts.skipped) return result('PASS', section, check, 'skipped: HARNESS_DOCTOR_NO_DB is set');
  if (facts.noUrl) return result('WARN', section, check, `no database URL in ${DB_VARS.join(', ')}: ${what} not checked`);
  if (facts.error) return result('WARN', section, check, `cannot read the database: ${facts.error}`);
  return null;
}

/** Every non-inactive registry key needs an agentic_os.project row with the same normalised root. A drift is a WARN: nothing breaks, the Agentic OS pane shows the wrong project. */
export function registryProjectRows(o, deps = {}) {
  const reg = liveRegistry(o, 'project-rows');
  if (reg.result) return reg.result;
  const facts = deps.facts ?? dbFacts(o);
  const gone = dbUnavailable('registry', 'project-rows', facts, 'agentic_os.project rows');
  if (gone) return gone;
  if (!facts.projects) return result('WARN', 'registry', 'project-rows', `agentic_os.project cannot be read: ${facts.projectsError}`);
  const byKey = new Map(facts.projects.map((r) => [r.key, r]));
  const drift = reg.entries.filter((e) => e.root).flatMap((e) => {
    const row = byKey.get(e.key);
    if (!row) return [`${e.key}: no project row`];
    const have = normalizeRoot(row.root_path);
    return have === e.root ? [] : [`${e.key}: row has ${have}, registry has ${e.root}`];
  });
  return drift.length ? result('WARN', 'registry', 'project-rows', `${drift.length} registry key(s) differ from agentic_os.project: ${drift.join('; ')}`)
    : result('PASS', 'registry', 'project-rows', `every non-inactive registry key in ${reg.file} has a project row with the same root`);
}

/** Migration 0004 is not applied to the live database yet, so a missing column is a WARN today. Only one of the two columns is a FAIL: that is a half-applied migration. */
export function laneBoardColumns(o, deps = {}) {
  const facts = deps.facts ?? dbFacts(o);
  const gone = dbUnavailable('lanes', 'board-columns', facts, 'agentic_os.lane.project_key');
  if (gone) return gone;
  if (facts.columns === 2) return result('PASS', 'lanes', 'board-columns', 'agentic_os.lane and agentic_os.lane_event both have project_key (migration 0004 applied)');
  if (facts.columns === 0) return result('WARN', 'lanes', 'board-columns', 'migration 0004 not applied: agentic_os.lane has no project_key, so no board can be registered yet');
  return result('FAIL', 'lanes', 'board-columns', `project_key is on ${facts.columns} of 2 tables (agentic_os.lane, agentic_os.lane_event): migration 0004 is half applied`);
}

/** The migration tags the repo's drizzle journal lists, or { result } (a WARN) when the journal cannot be read. */
function journalTags(o, deps) {
  if (deps.journal) return deps.journal;
  const file = join(o.repo, 'apps', 'agentic-os', 'drizzle', 'meta', '_journal.json');
  if (!existsSync(file)) return { result: result('WARN', 'lanes', 'schema', `missing ${file}: migrations cannot be compared`) };
  try { return { file, tags: readJson(file).entries.map((e) => e.tag) }; } catch (err) { return { result: result('WARN', 'lanes', 'schema', `${file} cannot be read: ${msg(err)}`) }; }
}

/**
 * The database has every migration the repo journal lists, and the lane fence trigger exists. Read only.
 * Unreachable is a WARN, never a FAIL. Behind by exactly migration 0004 is a WARN today: 0004 is not applied live yet
 * (apply it first, then merge). Behind by anything else is a FAIL. Ahead of the journal is a WARN: this checkout is behind the database.
 * The trigger is required only when the journal lists 0004.
 */
export function laneSchema(o, deps = {}) {
  const facts = deps.facts ?? dbFacts(o);
  const gone = dbUnavailable('lanes', 'schema', facts, 'agentic_os.__migrations');
  if (gone) return gone;
  const journal = journalTags(o, deps);
  if (journal.result) return journal.result;
  if (facts.migrationsError) return result('WARN', 'lanes', 'schema', `cannot count agentic_os.__migrations: ${facts.migrationsError}`);
  const want = journal.tags.length;
  const have = facts.migrations;
  const last = journal.tags[want - 1] ?? '';
  if (have < want) {
    if (want - have === 1 && last.startsWith('0004')) return result('WARN', 'lanes', 'schema', `migration 0004 not applied: the database has ${have} of the ${want} migrations in the journal (${last} is missing)`);
    return result('FAIL', 'lanes', 'schema', `the database is behind the repo: ${have} migrations applied, the journal lists ${want} (last: ${last}); apply them with drizzle-kit migrate before the code that needs them`);
  }
  if (have > want) return result('WARN', 'lanes', 'schema', `the database has ${have} migrations, this checkout's journal lists ${want}: this checkout is behind the database`);
  if (journal.tags.some((t) => t.startsWith('0004')) && facts.trigger !== 1) {
    return result('FAIL', 'lanes', 'schema', `all ${want} migrations are applied but the trigger lane_guard_foreign_board is missing (found ${facts.trigger}): the foreign-board fence is off`);
  }
  return result('PASS', 'lanes', 'schema', `${have} of ${want} migrations applied${journal.tags.some((t) => t.startsWith('0004')) ? ', trigger lane_guard_foreign_board present' : ''}`);
}

/** The hash of a file with CRLF folded to LF: the tree mixes line endings, and a checkout must not look like a code change. */
const laneHash = (file) => createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

/** Premortem T3: a worktree that carries an older lane.mjs cannot see boards. The DB trigger stops it on a foreign lane; this names the worktree. */
export function worktreeLaneMjs(o) {
  const rel = ['scripts', 'coordination', 'lane.mjs'];
  const dir = join(o.repo, '.claude', 'worktrees');
  if (!existsSync(dir)) return absent('lanes', 'worktree-lane-mjs', dir);
  const primary = join(o.repo, ...rel);
  if (!existsSync(primary)) return result('WARN', 'lanes', 'worktree-lane-mjs', `missing ${primary}: worktree copies cannot be compared`);
  const want = laneHash(primary);
  const copies = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ name: d.name, file: join(dir, d.name, ...rel) })).filter((c) => existsSync(c.file));
  const differ = copies.filter((c) => laneHash(c.file) !== want);
  const last = differ.length ? lastLaneChange(o.repo) : null;
  const judged = differ.map((c) => ({ name: c.name, ...laneCopyState(join(dir, c.name), last) }));
  const stale = judged.filter((j) => j.stale);
  const ahead = judged.filter((j) => j.ahead).map((j) => j.name);
  if (stale.length) {
    const info = ahead.length ? `; ${ahead.length} more on feature branches ahead of main (info): ${ahead.join(', ')}` : '';
    return result('WARN', 'lanes', 'worktree-lane-mjs', `${stale.length} worktree(s) under ${dir} have a lane.mjs that differs from ${primary}: ${stale.map((j) => `${j.name} (${j.stale})`).join(', ')}; a stale copy cannot see boards (rebase that worktree)${info}`);
  }
  if (ahead.length) return result('PASS', 'lanes', 'worktree-lane-mjs', `info: ${ahead.length} worktree(s) under ${dir} carry a lane.mjs ahead of ${primary} (feature work, main's last lane.mjs change is in their history): ${ahead.join(', ')}; ${copies.length - ahead.length} other copies match`);
  return result('PASS', 'lanes', 'worktree-lane-mjs', copies.length ? `all ${copies.length} worktree lane.mjs copies match ${primary}` : `no worktree under ${dir} holds a lane.mjs`);
}

/** The newest commit on main that changed scripts/coordination/lane.mjs, or null when main or that history is absent. */
function lastLaneChange(repo) {
  try { return git(repo, ['rev-list', '-1', 'main', '--', 'scripts/coordination/lane.mjs']) || null; } catch { return null; }
}

/**
 * Judges one worktree copy of lane.mjs that differs from the primary's. { ahead: true } when the worktree's history holds main's last
 * lane.mjs change (it forked from main's current lane.mjs and then edited it: feature work, not stale). { stale: <reason> } when it lacks
 * that change, is no git worktree root, or main has no history to compare. No database read: a lane-holding session is not looked up.
 */
function laneCopyState(folder, last) {
  const top = spawnSync('git', ['-C', folder, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (top.status !== 0 || !samePath(top.stdout.trim(), folder)) return { stale: 'not a git worktree' };
  if (!last) return { stale: 'main has no lane.mjs history to compare' };
  const anc = spawnSync('git', ['-C', folder, 'merge-base', '--is-ancestor', last, 'HEAD'], { windowsHide: true, timeout: 20000 });
  return anc.status === 0 ? { ahead: true } : { stale: "lacks main's last lane.mjs change" };
}

const registrySection = (o) => [registryRootsExist(o), registryMirrorDrift(o), registryArtifactUrl(o), registryProjectRows(o)];
// ---- lane propagation (the shim, the hook dists, the hook registrations, the relative-path ratchet) ----
const DEFAULT_BOARD = 'continuous-claude';
/** Hooks whose registration the lane work changes. prompt-submit bundles lane-context but is not itself a lane registration. */
const LANE_HOOKS = ['lane-context', 'lane-board-stop-gate', 'lane-board-republish-reminder', 'lane-agent-tag'];
/** Hook bundles that carry lane code: the lane hooks, prompt-submit (bundles lane-context) and session-register (prints the board line). */
const LANE_DISTS = [...LANE_HOOKS, 'prompt-submit', 'session-register'];
const SYNC_FIX = 'run scripts/sync-to-active.sh --changed on main';
const fwdPath = (p) => String(p).replace(/\\/g, '/');
/** The hash of a file with CRLF folded to LF (see laneHash). */
const textHash = (file) => createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
const distFile = (root, name) => join(root, '.claude', 'hooks', 'dist', `${name}.mjs`);

/** The home shim (<home>/.claude/scripts/lane.mjs) is what model-run lane commands name. It must equal the repo copy. */
export function lanesShim(o) {
  const repoShim = join(o.repo, '.claude', 'scripts', 'lane.mjs');
  const homeShim = join(o.home, '.claude', 'scripts', 'lane.mjs');
  if (!existsSync(repoShim)) return result('WARN', 'lanes', 'shim', `missing ${fwdPath(repoShim)}: the shim source is not in this checkout`);
  if (!existsSync(homeShim)) return result('WARN', 'lanes', 'shim', `missing ${fwdPath(homeShim)}: model-run lane commands name this path; ${SYNC_FIX}`);
  return textHash(repoShim) === textHash(homeShim) ? result('PASS', 'lanes', 'shim', `${fwdPath(homeShim)} equals ${fwdPath(repoShim)}`)
    : result('WARN', 'lanes', 'shim', `${fwdPath(homeShim)} differs from ${fwdPath(repoShim)} beyond line endings; ${SYNC_FIX}`);
}

/** Live board keys other than the default one, from the registry copy lane.mjs reads. A missing or broken registry gives none. */
function otherLiveBoards(o) {
  const reg = liveRegistry(o, 'hook-client-version');
  return reg.result ? [] : [...new Set(reg.entries.map((e) => e.board).filter((b) => b !== DEFAULT_BOARD))];
}

/**
 * The live hook build must set lane.client_version (migration 0004 trigger). Without it a session that owns a lane on a second board
 * fails its lease renew with 42501 and the hook goes quiet. FAIL only when a live board other than continuous-claude exists and a bundle
 * lacks the string. Any other gap is a WARN: today only continuous-claude has lanes, and the old build still works there.
 */
export function laneHookClientVersion(o) {
  const names = ['lane-context', 'prompt-submit'];
  const files = names.map((n) => distFile(o.home, n));
  const missing = files.filter((f) => !existsSync(f));
  const lacking = files.filter((f) => existsSync(f) && !readFileSync(f, 'utf8').includes('lane.client_version'));
  if (!missing.length && !lacking.length) return result('PASS', 'lanes', 'hook-client-version', `${names.map((n) => `${n}.mjs`).join(' and ')} in ${fwdPath(join(o.home, '.claude', 'hooks', 'dist'))} set lane.client_version`);
  const list = (fs) => fs.map((f) => fwdPath(f)).join(', ');
  const boards = otherLiveBoards(o);
  if (lacking.length && boards.length) {
    return result('FAIL', 'lanes', 'hook-client-version', `${list(lacking)} lack lane.client_version but the registry has live board(s) ${boards.join(', ')}: a session that holds a lane there fails its lease renew with 42501; ${SYNC_FIX}, then restart the sessions`);
  }
  const parts = [missing.length && `missing: ${list(missing)}`, lacking.length && `no lane.client_version in: ${list(lacking)}`].filter(Boolean).join('; ');
  const need = boards.length ? `the registry already has live board(s) ${boards.join(', ')}, so the build is required now` : `fine while only ${DEFAULT_BOARD} has lanes, required before a second board`;
  return result('WARN', 'lanes', 'hook-client-version', `${parts}; ${need}; ${SYNC_FIX}`);
}

/** The rendered template and the live settings.json, or { result } (a WARN) when either cannot be read. */
function renderedAndLive(o, check) {
  const templatePath = join(o.repo, '.claude', 'settings.json.template');
  const livePath = join(o.home, '.claude', 'settings.json');
  if (!existsSync(templatePath)) return { result: result('WARN', 'hooks', check, `missing ${fwdPath(templatePath)}: the registrations cannot be compared`) };
  if (!existsSync(livePath)) return { result: result('WARN', 'hooks', check, `missing ${fwdPath(livePath)}: the registrations cannot be compared`) };
  try {
    const resolved = resolveMachineProfile({ repoRoot: o.repo, home: o.home, argv: [], env: process.env });
    const rendered = renderSettings({ templateText: readFileSync(templatePath, 'utf8'), vars: varsFromPaths(resolved.paths), overlay: resolved.paths.settingsOverlay });
    return { rendered, live: JSON.parse(readFileSync(livePath, 'utf8').replace(/^﻿/, '')), livePath };
  } catch (err) { return { result: result('WARN', 'hooks', check, `cannot compare ${fwdPath(templatePath)} with ${fwdPath(livePath)}: ${msg(err)}`) }; }
}

/**
 * Every lane hook registration in the rendered template is live with the same event and matcher. Read only: a gap is a WARN that names
 * the hook and the fix. The Stop gate is in the template but in no live file until apply-registrations runs with Dave's yes.
 */
export function hooksRenderCheck(o) {
  const both = renderedAndLive(o, 'render-check');
  if (both.result) return both.result;
  const liveKeys = new Set(registrations(both.live).map(registrationKey));
  const want = registrations(both.rendered).filter((r) => LANE_HOOKS.includes(r.hook));
  const missing = want.filter((r) => !liveKeys.has(registrationKey(r)));
  if (!missing.length) return result('PASS', 'hooks', 'render-check', `all ${want.length} lane hook registration(s) of the rendered template are live with the same matcher in ${fwdPath(both.livePath)}`);
  const only = [...new Set(missing.map((r) => r.hook))].sort().join(',');
  const rows = missing.map((r) => `${r.hook} on ${r.event}${r.matcher ? ` (matcher ${r.matcher})` : ''}`).join('; ');
  return result('WARN', 'hooks', 'render-check', `${missing.length} lane hook registration(s) are in the rendered template but not live: ${rows}; fix: node ${fwdPath(join(o.repo, 'scripts', 'settings', 'apply-registrations.mjs'))} --only ${only} (dry run first, then --apply after Dave's yes)`);
}

/** The lane hook bundles in the home equal the repo's built bundles (CRLF folded). A gap is a WARN: the sync is owed. */
export function hooksDistParity(o) {
  const bad = [];
  for (const n of LANE_DISTS) {
    const repoFile = distFile(o.repo, n);
    const homeFile = distFile(o.home, n);
    if (!existsSync(repoFile)) bad.push(`${n}.mjs missing in the repo`);
    else if (!existsSync(homeFile)) bad.push(`${n}.mjs missing in the home`);
    else if (textHash(repoFile) !== textHash(homeFile)) bad.push(`${n}.mjs differs`);
  }
  return bad.length ? result('WARN', 'hooks', 'dist-parity', `${bad.length} lane hook bundle(s) out of step between ${fwdPath(join(o.repo, '.claude', 'hooks', 'dist'))} and ${fwdPath(join(o.home, '.claude', 'hooks', 'dist'))}: ${bad.join('; ')}; ${SYNC_FIX}`)
    : result('PASS', 'hooks', 'dist-parity', `all ${LANE_DISTS.length} lane hook bundles in the home equal the repo build`);
}

// ---- hooks:trace-fresh ----
const TRACE_GRACE_MS = 30 * 60 * 1000; // the newest live trace row may lag the newest activity by this much
const TRACE_DAY_FILE = /^hook-trace-\d{4}-\d{2}-\d{2}\.jsonl$/;
const TRACE_DAY_FILES_READ = 3; // the newest day files scanned for a live row (covers a UTC midnight and an idle day)
const notTestOrProbe = (r) => r.source !== 'test' && r.source !== 'probe';

const TRACE_IDLE_MS = 6 * 60 * 60 * 1000; // activity older than this is idle: nothing to judge the tracer by

/** The newest valid ts (ms) and its row among the rows `counted` picks in a JSONL file, or null. */
function newestRow(file, counted) {
  let best = null;
  for (const line of readTail(file).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object' || !counted(r)) continue;
    const t = Date.parse(r.ts);
    if (!Number.isNaN(t) && (best === null || t > best.ts)) best = { ts: t, row: r };
  }
  return best;
}

/** The newest live trace row ts (ms) in the newest day files, among rows `counted` picks (source live is always required), or null. */
function newestLiveTrace(cacheDir, days, counted = () => true) {
  return days.slice(0, TRACE_DAY_FILES_READ).map((f) => newestRow(join(cacheDir, f), (r) => r.source === 'live' && counted(r))?.ts ?? null)
    .filter((t) => t !== null).sort((a, b) => b - a)[0] ?? null;
}

/** The HOT_PROGRAMS names in the tracer source of this repo (the one list trace-boot.test.ts checks against the template), or null when unreadable. */
function hotPrograms(repo) {
  try {
    const text = readFileSync(join(repo, '.claude', 'hooks', 'src', 'lib', 'trace-boot.ts'), 'utf8');
    const block = /HOT_PROGRAMS[^=]*=\s*\[([\s\S]*?)\]/.exec(text)?.[1];
    const names = [...(block ?? '').matchAll(/'([A-Za-z0-9._-]+)'/g)].map((m) => m[1]);
    return names.length ? new Set(names) : null;
  } catch { return null; }
}

/** True when CCV3_HOOK_TRACE is 0 in the doctor's env or in the env block of <home>/.claude/settings.json (the tracer reads the process env that block feeds). */
function traceOffByEnv(home) {
  if (process.env.CCV3_HOOK_TRACE === '0') return 'the process env';
  try { if (String(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))?.env?.CCV3_HOOK_TRACE ?? '') === '0') return fwdPath(join(home, '.claude', 'settings.json')); } catch { /* no settings file, or not JSON */ }
  return null;
}

/**
 * The per-process hook tracer (.claude/hooks/src/lib/trace-boot.ts) still writes rows. It cannot pass on an idle machine:
 * the activity signal is independent of the tracer (the newest live row of <repo>/.claude/logs/identity-probe.jsonl, written by
 * every SessionStart, and of <home>/.claude/logs/guard-decisions.jsonl). Rules, in order:
 *   mode file <home>/.claude/state/hook-trace-mode says off, or CCV3_HOOK_TRACE is 0 in the process env or in the env block of
 *     <home>/.claude/settings.json: WARN (a missing file means hot, not off).
 *   neither activity file has a live row: WARN "no activity signal" (never a vacuous PASS).
 *   activity and no <home>/.claude/cache/hook-trace-YYYY-MM-DD.jsonl: FAIL (also when the activity is old).
 *   the newest activity is more than 6 h old (a day file exists): PASS, detail starts "info: idle".
 *   activity and no live row (source live) in the newest day files: FAIL.
 *   the newest activity is more than 30 min newer than the newest live trace row of any name: FAIL.
 *   per name: the newest activity is a guard-decisions row whose hook is in HOT_PROGRAMS, or an identity-probe row. The newest live
 *     trace row WITH THAT NAME must be no more than 30 min older than the activity, or FAIL. Rows of other hooks must not hide a gap.
 *   else PASS.
 * A live trace row is one with source live: a test, a probe, or a run of the repo dist writes source test or probe.
 */
export function hookTraceFresh(o) {
  const cacheDir = join(o.home, '.claude', 'cache');
  const modeFile = join(o.home, '.claude', 'state', 'hook-trace-mode');
  let mode = 'hot';
  try { mode = readFileSync(modeFile, 'utf8').trim().toLowerCase() || 'hot'; } catch { /* a missing file means hot */ }
  if (mode === 'off') return result('WARN', 'hooks', 'trace-fresh', `tracing off by flag: ${fwdPath(modeFile)} says off; delete it or write hot to turn the hook tracer on`);
  const offBy = traceOffByEnv(o.home);
  if (offBy) return result('WARN', 'hooks', 'trace-fresh', `tracing off by flag: CCV3_HOOK_TRACE is 0 in ${offBy}; remove it to turn the hook tracer on`);
  const probeLog = join(o.repo, '.claude', 'logs', 'identity-probe.jsonl');
  const guardLog = join(o.home, '.claude', 'logs', 'guard-decisions.jsonl');
  const signals = [{ file: probeLog, name: () => 'identity-probe' }, { file: guardLog, name: (row) => (typeof row.hook === 'string' ? row.hook : null) }]
    .map((s) => ({ file: s.file, newest: existsSync(s.file) ? newestRow(s.file, notTestOrProbe) : null, nameOf: s.name })).filter((s) => s.newest !== null);
  if (!signals.length) return result('WARN', 'hooks', 'trace-fresh', `no activity signal: ${fwdPath(probeLog)} and ${fwdPath(guardLog)} have no live row, so the trace cannot be judged`);
  const top = signals.sort((a, b) => b.newest.ts - a.newest.ts)[0];
  const activity = { file: top.file, ts: top.newest.ts, hook: top.nameOf(top.newest.row) };
  const seen = `activity at ${new Date(activity.ts).toISOString()} in ${fwdPath(activity.file)}`;
  const days = existsSync(cacheDir) ? readdirSync(cacheDir).filter((f) => TRACE_DAY_FILE.test(f)).sort().reverse() : [];
  if (!days.length) return result('FAIL', 'hooks', 'trace-fresh', `${seen}, but no hook-trace-YYYY-MM-DD.jsonl under ${fwdPath(cacheDir)}: the tracer writes nothing (run the hooks build and sync-to-active.sh --changed, then check the mode file)`);
  if (Date.now() - activity.ts > TRACE_IDLE_MS) return result('PASS', 'hooks', 'trace-fresh', `info: idle, the newest ${seen} is more than 6 h old, so the tracer is not judged now`);
  const live = newestLiveTrace(cacheDir, days);
  if (live === null) return result('FAIL', 'hooks', 'trace-fresh', `${seen}, but no live trace row (source live) in the newest ${Math.min(days.length, TRACE_DAY_FILES_READ)} day file(s) under ${fwdPath(cacheDir)}: only test or probe rows, or none`);
  const lag = activity.ts - live;
  if (lag > TRACE_GRACE_MS) return result('FAIL', 'hooks', 'trace-fresh', `newest live trace row ${new Date(live).toISOString()} is ${Math.round(lag / 60000)} min older than the newest ${seen}: the tracer stopped (limit 30 min) under ${fwdPath(cacheDir)}`);
  const hot = hotPrograms(o.repo);
  const wanted = activity.hook && (activity.hook === 'identity-probe' || (hot !== null && hot.has(activity.hook))) ? activity.hook : null;
  if (wanted) {
    const named = newestLiveTrace(cacheDir, days, (r) => r.name === wanted);
    if (named === null || activity.ts - named > TRACE_GRACE_MS) {
      const was = named === null ? 'none' : `${new Date(named).toISOString()}, ${Math.round((activity.ts - named) / 60000)} min older`;
      return result('FAIL', 'hooks', 'trace-fresh', `no live trace row named ${wanted} within 30 min of the newest ${seen} (newest ${wanted} row: ${was}); rows of other hooks are fresh, so the tracer is missing from ${wanted}'s bundle or stopped for it`);
    }
  }
  return result('PASS', 'hooks', 'trace-fresh', `newest live trace row ${new Date(live).toISOString()} under ${fwdPath(cacheDir)}, within 30 min of the newest ${seen}${wanted ? `; ${wanted} has its own live row` : ''}; mode ${mode}`);
}

/** The relative-path ratchet (scripts/coordination/lane-path-guard.mjs): bare `scripts/coordination/lane.mjs` text may only fall. */
export function lanePathGuardCheck(o) {
  const r = checkLanePaths({ repo: o.repo });
  if (r.baselineMissing) return result('WARN', 'lanes', 'relative-path-guard', `no ratchet baseline at ${fwdPath(r.baselinePath)} (${r.total} bare relative lane.mjs path(s) in ${r.scanned} file(s)); create it with node scripts/coordination/lane-path-guard.mjs --update`);
  if (!r.ok) {
    const rows = r.over.map((f) => `${f.file} has ${f.count} (baseline ${f.baseline})`).join('; ');
    return result('WARN', 'lanes', 'relative-path-guard', `${r.over.length} file(s) over the ratchet baseline: ${rows}; name the shim path (laneCliCmd) instead of a bare scripts/coordination/lane.mjs`);
  }
  return result('PASS', 'lanes', 'relative-path-guard', `${r.total} bare relative lane.mjs path(s) in ${r.scanned} file(s), none over baseline (baseline allows ${r.baselineTotal})`);
}

const lanesSection = (o) => [laneBoardColumns(o), laneSchema(o), worktreeLaneMjs(o), lanesShim(o), laneHookClientVersion(o), lanePathGuardCheck(o)];

// ---- deps (the one install of .claude/hooks, in the primary checkout) ----
/** The version of node_modules/<name> that a lock-shaped file records, or null. */
function lockedVersion(file, name) {
  try { return readJson(file).packages?.[`node_modules/${name}`]?.version ?? null; } catch { return null; }
}

/**
 * The primary checkout's .claude/hooks install is whole: node_modules/.package-lock.json exists (npm writes it last, so a lone
 * node_modules/.vite does not count) and `pg` resolves from it. A gap is a FAIL: every worktree borrows this install through the
 * shared resolver (scripts/lib/resolve-deps.mjs). Installed typescript that differs from package-lock.json is a WARN with the pair:
 * the gates then run an older compiler than the lock names. Read only: no network, no install.
 */
export function depsHooksInstall(o) {
  const primary = primaryRoot(o.repo);
  const hooks = join(primary, '.claude', 'hooks');
  const fix = `run npm ci in ${hooks} (needs Dave's yes)`;
  const installed = join(hooks, 'node_modules', '.package-lock.json');
  if (!existsSync(installed)) return result('FAIL', 'deps', 'hooks-install', `${join(hooks, 'node_modules')} has no .package-lock.json: no complete install in the primary checkout; ${fix}`);
  if (!resolveDep('pg', { repoRoot: primary, anchors: [hooks] })) return result('FAIL', 'deps', 'hooks-install', `pg does not resolve from ${hooks}: the install is partial; ${fix}`);
  const have = lockedVersion(installed, 'typescript');
  const want = lockedVersion(join(hooks, 'package-lock.json'), 'typescript');
  if (have && want && have !== want) return result('WARN', 'deps', 'hooks-install', `installed typescript ${have}, lock says ${want}: ${fix}`);
  return result('PASS', 'deps', 'hooks-install', `${hooks}: complete install, pg resolves${have ? `, typescript ${have}` : ''}`);
}

/**
 * The shared store link <primary>/.claude/worktrees/node_modules points at <primary>/.claude/hooks/node_modules
 * (scripts/worktree/shared-deps.mjs). PASS when it does. WARN when it is absent: the link is optional and needs Dave's yes.
 * FAIL for a link that dangles or points elsewhere, a real file or folder at that path, or a target without a complete install.
 * Read only.
 */
export function depsStoreLink(o) {
  const r = checkStore({ primary: primaryRoot(o.repo) });
  if (r.state === 'ok') return result('PASS', 'deps', 'store-link', r.detail);
  if (r.state === 'absent') return result('WARN', 'deps', 'store-link', "no shared store link: run node scripts/worktree/shared-deps.mjs --apply in the primary (needs Dave's yes)");
  return result('FAIL', 'deps', 'store-link', `${r.state}: ${r.detail}; ${storeFix(r.state)}`);
}

/** The fix text for a store state that is not ok and not absent. The script never replaces a path, so each fix is two steps or a question. */
function storeFix(state) {
  if (state === 'not-a-link') return "a real folder or file sits at the link path: ask Dave, do not delete it, then run node scripts/worktree/shared-deps.mjs --check";
  if (state === 'no-target') return "the hooks install is incomplete: run npm ci in the primary's .claude/hooks (needs Dave's yes), then run node scripts/worktree/shared-deps.mjs --check";
  return "run node scripts/worktree/shared-deps.mjs --unlink then --apply in the primary (Dave's yes)";
}

/** store-link runs only when the hooks install is complete: a FAIL there already names the one fix. */
const depsSection = (o) => {
  const install = depsHooksInstall(o);
  return install.status === 'FAIL' ? [install] : [install, depsStoreLink(o)];
};

// ---- run ----
const SECTIONS = [['repo', repoSection], ['hooks', hooksSection], ['sync', syncSection], ['logs', logsSection], ['review', reviewSection],
  ['schedule', scheduleSection], ['blocklist', blocklistSection], ['registry', registrySection], ['lanes', lanesSection], ['deps', depsSection]];

/** Runs every section. A section that throws becomes one WARN, so one bad input never hides the rest. */
export function collect(o) {
  return SECTIONS.flatMap(([name, fn]) => {
    try { return fn(o); } catch (err) { return [result('WARN', name, 'section', `could not run: ${msg(err)}`)]; }
  });
}

export function summarize(checks) {
  const n = (s) => checks.filter((c) => c.status === s).length;
  return { pass: n('PASS'), warn: n('WARN'), fail: n('FAIL') };
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Writes the JSON result to `file` and creates its parent dir. */
function writeArtifact(file, o, checks, summary) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), repo: o.repo, home: o.home, summary, checks }, null, 2)}\n`);
  return file;
}

const defaultArtifact = (o) => join(o.repo, '.claude', 'cache', 'e2e', `${localDay(new Date())}-harness-doctor.json`);

/** Writes the --json and --out files. A write that fails is reported and returns false: the caller exits 2. */
function writeArtifacts(o, checks, summary) {
  const files = [o.json && defaultArtifact(o), o.out].filter(Boolean);
  // Try every file: a failed repo artifact must not skip --out, which feeds the session-start line.
  const ok = files.map((file) => {
    try { console.error(`artifact: ${writeArtifact(file, o, checks, summary)}`); return true; } catch (err) { console.error(`cannot write ${file}: ${msg(err)}`); return false; }
  });
  return ok.every(Boolean);
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (err) {
    console.error(`${msg(err)}\nusage: harness-doctor.mjs [--json] [--out <file>] [--home <dir>] [--repo <dir>]`);
    process.exit(2);
  }
  const checks = collect(o);
  for (const c of checks) console.log(`${c.status}  ${c.section}:${c.check}  ${c.detail}`);
  const s = summarize(checks);
  console.log(`harness: ${s.pass} pass / ${s.warn} warn / ${s.fail} fail`);
  if (!writeArtifacts(o, checks, s)) process.exit(2);
  process.exit(s.fail > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
