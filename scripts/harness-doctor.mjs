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
 * blocklist:age reads git history. Test seam: HARNESS_DOCTOR_SCHTASKS_DIR holds fake <task>.csv schtasks output.
 * One line per check: PASS|WARN|FAIL  <section>:<check>  <detail>. Last line: harness: N pass / N warn / N fail.
 * Exit 1 on any FAIL, else 0.
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
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const hooksSection = (o) => [...HOOK_CHECKS.map(([n, rel]) => runRepoCheck(o, n, rel)), baselineClean(o), buildInputs(o)];

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

function worktreeFolders(o) {
  const dir = join(o.repo, '.claude', 'worktrees');
  if (!existsSync(dir)) return absent('sync', 'worktrees', dir);
  let listed;
  try { listed = git(o.repo, ['worktree', 'list', '--porcelain']).split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)); }
  catch (err) { return result('WARN', 'sync', 'worktrees', `git worktree list failed in ${o.repo}: ${msg(err)}`); }
  const orphans = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !listed.some((w) => samePath(w, join(dir, d.name)))).map((d) => d.name);
  return orphans.length ? result('WARN', 'sync', 'worktrees', `${orphans.length} folder(s) under ${dir} not in git worktree list: ${orphans.join(', ')}`)
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

/** Counts the error lines of the last `windowMs`. `isError` picks the lines; a line that is not JSON or has no valid ts is skipped and counted. */
export function scanLog(text, isError, windowMs, nowMs = Date.now()) {
  const tally = new Map();
  let count = 0;
  let unparsable = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { unparsable++; continue; }
    if (!obj || typeof obj !== 'object' || !isError(obj)) continue;
    const t = Date.parse(obj.ts);
    if (Number.isNaN(t)) { unparsable++; continue; }
    if (nowMs - t > windowMs) continue;
    count++;
    const m = String(obj.error ?? obj.reason ?? obj.msg ?? obj.message ?? '(no message)').slice(0, 100);
    tally.set(m, (tally.get(m) ?? 0) + 1);
  }
  const [top, topN] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return { count, unparsable, top, topN };
}

export const levelOf = (n) => (n === 0 ? 'PASS' : n < 5 ? 'WARN' : 'FAIL');

const LOGS = [
  { check: 'pre-pr-gate-errors', dir: 'logs', file: 'pre-pr-gate-errors.jsonl', isError: () => true },
  { check: 'guard-decisions', dir: 'logs', file: 'guard-decisions.jsonl', isError: (o) => o.kind === 'error' },
  { check: 'memory-write-failures', dir: 'state', file: 'memory-write-failures.jsonl', isError: () => true },
  { check: 'hooks.log', dir: 'logs', file: 'hooks.log', isError: (o) => (o.level !== undefined ? o.level === 'error' : /error/i.test(JSON.stringify(o))) },
];

function logCheck(o, spec) {
  const file = join(o.home, '.claude', spec.dir, spec.file);
  if (!existsSync(file)) return absent('logs', spec.check, file);
  const s = scanLog(readTail(file), spec.isError, DAY);
  const skipped = s.unparsable ? `; ${s.unparsable} unparsable line(s) skipped` : '';
  const top = s.top ? `; top: "${s.top}" x${s.topN}` : '';
  return result(levelOf(s.count), 'logs', spec.check, `${s.count} error(s) in the last 24 h in ${file}${top}${skipped}`);
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
      if (r.date === day) cents += Math.round(r.cost * 100);
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

/** Test seam: HARNESS_DOCTOR_SCHTASKS_DIR holds <task name>.csv files of fake schtasks output. A missing file answers like an unknown task. */
function fakeSchtasksQuery(dir) {
  return (name) => {
    const file = join(dir, `${name}.csv`);
    return existsSync(file) ? { status: 0, stdout: readFileSync(file, 'utf8'), stderr: '' }
      : { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
  };
}

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
  return null;
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

/** Judges one registered task's last run and result. */
function judgeTask(t, row, now) {
  const code = Number(row.lastResult);
  if (!Number.isInteger(code)) return result('WARN', 'schedule', t.name, `Last Result "${row.lastResult}" is not a number`);
  const ran = parseRunTime(row.lastRun);
  if (code === TASK_NEVER_RAN || row.lastRun === 'N/A' || new Date(ran).getFullYear() === 1999) return result('WARN', 'schedule', t.name, `task is registered but never ran (trigger ${t.trigger})`);
  if (code !== TASK_RUNNING && !t.allowedExit.includes(code)) return result('FAIL', 'schedule', t.name, `last result ${code} is not in allowedExit [${t.allowedExit}]; last run ${row.lastRun}`);
  if (Number.isNaN(ran)) return result('WARN', 'schedule', t.name, `Last Run Time "${row.lastRun}" is not a date the doctor reads`);
  const hours = (now - ran) / HOUR;
  return hours > t.maxAgeHours ? result('WARN', 'schedule', t.name, `last run ${row.lastRun} is ${hours.toFixed(1)} h old, over maxAgeHours ${t.maxAgeHours}`)
    : result('PASS', 'schedule', t.name, `last result ${code}, last run ${row.lastRun} (${hours.toFixed(1)} h ago, limit ${t.maxAgeHours})`);
}

function checkTask(t, query, now) {
  const problem = entryProblem(t);
  if (problem) return result('WARN', 'schedule', t?.name || 'entry', `tasks.json entry ${problem}`);
  const q = query(t.name);
  if (q.error) return result('WARN', 'schedule', t.name, `cannot run schtasks: ${q.error}`);
  if (q.status !== 0) return result('WARN', 'schedule', t.name, `task is not registered (schtasks exit ${q.status}: ${String(q.stderr).trim().split('\n')[0]}); trigger ${t.trigger}`);
  const row = taskRow(q.stdout, t.name);
  return row.warn ? result('WARN', 'schedule', t.name, row.warn) : judgeTask(t, row, now);
}

/** One check per task in scripts/scheduled/tasks.json. `deps` (platform, query, now) is injectable for tests. */
export function scheduleChecks(o, deps = {}) {
  const seam = process.env.HARNESS_DOCTOR_SCHTASKS_DIR;
  const platform = deps.platform ?? (seam ? 'win32' : process.platform);
  const query = deps.query ?? (seam ? fakeSchtasksQuery(seam) : schtasksQuery);
  if (platform !== 'win32') return [result('PASS', 'schedule', 'tasks', `skipped: Task Scheduler exists only on Windows (this is ${platform})`)];
  const file = join(o.repo, ...SCHEDULE_REL);
  if (!existsSync(file)) return [result('WARN', 'schedule', 'tasks', `missing ${file}: no scheduled task is checked`)];
  let tasks;
  try { tasks = readJson(file).tasks; } catch (err) { return [result('WARN', 'schedule', 'tasks', `${file} is not valid JSON: ${msg(err)}`)]; }
  if (!Array.isArray(tasks)) return [result('WARN', 'schedule', 'tasks', `${file} has no "tasks" array`)];
  if (!tasks.length) return [result('PASS', 'schedule', 'tasks', `${file} lists 0 tasks`)];
  return tasks.map((t) => checkTask(t, query, deps.now ?? Date.now()));
}

const scheduleSection = (o) => scheduleChecks(o);

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

// ---- run ----
const SECTIONS = [['repo', repoSection], ['hooks', hooksSection], ['sync', syncSection], ['logs', logsSection], ['review', reviewSection],
  ['schedule', scheduleSection], ['blocklist', blocklistSection]];

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
