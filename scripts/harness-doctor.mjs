#!/usr/bin/env node
/**
 * harness-doctor: a slim, read-only health check of the harness.
 *
 * Usage: node scripts/harness-doctor.mjs [--json] [--home <dir>] [--repo <dir>]
 *   --home  the dir that holds .claude (default: the user home)
 *   --repo  the repo root (default: the repo that holds this script)
 *   --json  also write <repo>/.claude/cache/e2e/<YYYY-MM-DD>-harness-doctor.json
 *
 * It runs no Docker, no network and no paid call. It writes only the --json artifact.
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
  const o = { json: false, home: homedir(), repo: resolve(HERE, '..') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') o.json = true;
    else if (argv[i] === '--home' || argv[i] === '--repo') {
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

// ---- run ----
const SECTIONS = [['hooks', hooksSection], ['sync', syncSection], ['logs', logsSection], ['review', reviewSection]];

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

function writeArtifact(o, checks, summary) {
  const dir = join(o.repo, '.claude', 'cache', 'e2e');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${localDay(new Date())}-harness-doctor.json`);
  writeFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), repo: o.repo, home: o.home, summary, checks }, null, 2)}\n`);
  return file;
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (err) {
    console.error(`${msg(err)}\nusage: harness-doctor.mjs [--json] [--home <dir>] [--repo <dir>]`);
    process.exit(2);
  }
  const checks = collect(o);
  for (const c of checks) console.log(`${c.status}  ${c.section}:${c.check}  ${c.detail}`);
  const s = summarize(checks);
  console.log(`harness: ${s.pass} pass / ${s.warn} warn / ${s.fail} fail`);
  if (o.json) console.error(`artifact: ${writeArtifact(o, checks, s)}`);
  process.exit(s.fail > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
