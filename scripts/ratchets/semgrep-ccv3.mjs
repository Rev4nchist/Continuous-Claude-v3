#!/usr/bin/env node
/**
 * semgrep-ccv3.mjs - run the repo's own Semgrep rules (scripts/ratchets/semgrep-ccv3/) and ratchet the result.
 *
 * One scan with the pack only, then scan-ratchet.mjs against semgrep-ccv3-baseline.json. The engine is opengrep when
 * the binary is found (CCV3_OPENGREP, else the newest ~/tools/review-scanners/opengrep/<ver>/), else Docker on the
 * pinned Semgrep image. The engine that ran is printed. A finding in a file the change did not touch is DRIFT: printed, not blocking.
 * It does not run p/default (that needs a registry fetch; the CI semgrep job runs it).
 *
 * Usage:
 *   node scripts/ratchets/semgrep-ccv3.mjs [--changed <file>] [--report <file>] [--root <dir>]
 *   node scripts/ratchets/semgrep-ccv3.mjs --update --reason "<why>"   (rewrite the baseline)
 * Env: CCV3_OPENGREP, SEMGREP_IMAGE (default: the digest CI pins), DOCKER_BIN, CCV3_SEMGREP_TIMEOUT_S (tests and proofs only: a whole number from 1 to 300,
 * anything else exits 2 before any scan).
 * Per-file limit: PER_FILE_TIMEOUT_S (90 s) for both engines. The limit covers the PARSE of a file, which does not follow its size
 * (card semgrep-timeout-large-files: a 330 KB test file parses in 11 s here, and a CI runner that is 2 times slower failed it at 30 s). A file that still
 * times out is a scan-error and FAILS the ratchet as before (a skipped file must never pass); the wrapper says it was a timeout, in which file and rule.
 * Both scans run with --time: one line names the slowest file, and a NOTE says so when it took over half the limit.
 * Docker mounts the rule folder at /rules, so its check ids are rules.<id>. The opengrep report is rewritten to the same
 * form (and to forward slashes), so one baseline serves both engines.
 *
 * Exit: 0 no new finding, 1 new finding or Docker is not running, 2 bad input or a scan that did not return JSON.
 * Node builtins only.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InputError, run as runRatchet } from './scan-ratchet.mjs';

// Keep equal to SEMGREP_IMAGE in .github/workflows/ccv3-checks.yml (semgrep-ccv3.test.mjs SG2 checks it).
export const DEFAULT_IMAGE = 'semgrep/semgrep@sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RULES_DIR = path.join(here, 'semgrep-ccv3');
export const BASELINE = path.join(here, 'semgrep-ccv3-baseline.json');
const DOCKER_WIN = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';

// The fixtures are wrong on purpose; the cache holds archived pre-fix trees; worktrees are other checkouts.
export const EXCLUDES = ['scripts/ratchets/semgrep-ccv3', '.claude/cache', '.claude/worktrees', 'node_modules'];

export const DOCKER_DOWN_MESSAGE = 'semgrep-ccv3: Docker is not running or not installed. Start Docker Desktop, then run this again.';
const DAEMON_DOWN = /daemon|docker_engine|dockerDesktopLinuxEngine|error during connect|connection refused|cannot connect|is the docker/i;

/** The per-file limit of both engines, in seconds. The worst file takes 17 s on a loaded developer machine; 90 leaves 5 times room and stays far under the 5 minute CI step. */
export const PER_FILE_TIMEOUT_S = 90;

/** The limit in force: the default, or CCV3_SEMGREP_TIMEOUT_S when it is a whole number from 1 to 300. { seconds, overridden } or { error }. A typo is refused, never ignored. */
export function limitInForce(env = process.env) {
  const raw = env.CCV3_SEMGREP_TIMEOUT_S;
  if (raw === undefined || raw === '') return { seconds: PER_FILE_TIMEOUT_S, overridden: false };
  if (/^[0-9]+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 300) return { seconds: Number(raw), overridden: true };
  return { error: `semgrep-ccv3: CCV3_SEMGREP_TIMEOUT_S must be a whole number from 1 to 300 (got ${JSON.stringify(raw)}). Nothing was scanned.` };
}

export function dockerArgs({ root, rulesDir = RULES_DIR, image, timeoutS = PER_FILE_TIMEOUT_S }) {
  return [
    'run', '--rm',
    '-v', `${root}:/src`,
    '-v', `${rulesDir}:/rules:ro`,
    '-w', '/src',
    image,
    'semgrep', 'scan', '--config', '/rules', '--metrics=off', '--json', '--quiet', '--timeout', String(timeoutS), '--time',
    ...EXCLUDES.flatMap((e) => ['--exclude', e]),
  ];
}

export const OPENGREP_EXE = 'opengrep_windows_x86.exe';

/** opengrep flags: the Docker scan without --metrics=off (opengrep rejects it), plus .git. The run starts in the repo root. */
export function opengrepArgs({ rulesDir = RULES_DIR, timeoutS = PER_FILE_TIMEOUT_S } = {}) {
  return ['scan', '--config', rulesDir, '--json', '--quiet', '--timeout', String(timeoutS), '--time', ...[...EXCLUDES, '.git'].flatMap((e) => ['--exclude', e]), '.'];
}

const versionKey = (name) => (/\d+(?:\.\d+)*/.exec(name)?.[0] ?? '0').split('.').map(Number);
const newer = (a, b) => { const [x, y] = [versionKey(a), versionKey(b)]; for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return 0; };

/** The opengrep binary: CCV3_OPENGREP when it names a file, else the newest version folder under <home>/tools/review-scanners/opengrep. Or null. */
export function findOpengrep({ env = process.env, home = homedir() } = {}) {
  const own = env.CCV3_OPENGREP ? path.resolve(env.CCV3_OPENGREP) : null;
  if (own && existsSync(own)) return own;
  const base = path.join(home, 'tools', 'review-scanners', 'opengrep');
  let versions = [];
  try { versions = readdirSync(base); } catch { return null; }
  const exe = versions.sort(newer).map((v) => path.join(base, v, OPENGREP_EXE)).find((p) => existsSync(p));
  return exe ?? null;
}

const slash = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);

/** Rewrites an opengrep report to the Docker form: check_id rules.<last part>, forward slashes. Rule ids hold no dot (OG5). */
export function normaliseOpengrepReport(report) {
  if (!report || !Array.isArray(report.results)) return report;
  const results = report.results.map((r) => ({ ...r, check_id: `rules.${String(r.check_id).split('.').pop()}`, path: slash(r.path) }));
  const errors = (report.errors ?? []).map((e) => ({ ...e, path: slash(e.path) }));
  const time = Array.isArray(report.time?.targets) ? { ...report.time, targets: report.time.targets.map((t) => ({ ...t, path: slash(t.path) })) } : null;
  return { ...report, results, errors, ...(time ? { time } : {}) };
}

const isTimeout = (e) => (Array.isArray(e?.type) ? e.type[0] : e?.type) === 'Timeout' || /^Timeout\b/.test(String(e?.message ?? ''));
const ruleOf = (e) => String(e.rule_id ?? /Timeout when running (\S+) on /.exec(String(e.message ?? ''))?.[1] ?? 'unknown rule').split('.').pop();
/** Seconds a target took: its run_time, else its parse and match times added up. */
const secondsOf = (t) => (typeof t.run_time === 'number' ? t.run_time : [...(t.parse_times ?? []), ...(t.match_times ?? [])].reduce((a, b) => a + b, 0));

/**
 * The lines about time, from the report: one TIMEOUT line for each file and rule that timed out (a scan-error that says what it was: not a finding of
 * a rule), then the slowest file with its seconds of the limit, and a NOTE when that is over half the limit. Reads only; the ratchet still decides the exit.
 */
export function timeLines(report, seconds) {
  const out = [];
  const seen = new Set();
  for (const e of report?.errors ?? []) {
    if (!isTimeout(e)) continue;
    const key = `${e.path}|${ruleOf(e)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`semgrep-ccv3: TIMEOUT ${e.path} (${ruleOf(e)}) over ${seconds} s: not a finding of a rule. Raise PER_FILE_TIMEOUT_S or split the file.`);
  }
  const perFile = new Map();
  for (const t of report?.time?.targets ?? []) perFile.set(t.path, (perFile.get(t.path) ?? 0) + secondsOf(t));
  const [slowest, took] = [...perFile.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (slowest !== undefined) {
    out.push(`semgrep-ccv3: slowest file ${slowest} ${took.toFixed(1)} s of ${seconds} s`);
    if (took > seconds / 2) out.push(`NOTE semgrep-ccv3: ${slowest} took over half the per-file limit (${took.toFixed(1)} s of ${seconds} s): it may time out on a slower runner.`);
  }
  return out;
}

function parseArgs(argv) {
  const o = { update: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') o.update = true;
    else if (['--changed', '--report', '--root', '--reason'].includes(a)) {
      if (i + 1 >= argv.length) throw new InputError(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else throw new InputError(`unknown argument: ${a}`);
  }
  return o;
}

const realSpawn = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true, ...opts });

/** Starts the scan. { engine, r }: opengrep when found, else Docker. */
function scan({ root, env, spawn, log, find, timeoutS }) {
  const og = find();
  if (og) {
    log(`semgrep-ccv3: engine: opengrep (${og})`);
    return { engine: 'opengrep', r: spawn(og, opengrepArgs({ timeoutS }), { cwd: root }) };
  }
  const docker = env.DOCKER_BIN ?? (existsSync(DOCKER_WIN) ? DOCKER_WIN : 'docker');
  log('semgrep-ccv3: engine: docker (no opengrep binary found)');
  return { engine: 'docker', r: spawn(docker, dockerArgs({ root, image: env.SEMGREP_IMAGE ?? DEFAULT_IMAGE, timeoutS })) };
}

/** deps: { spawn(cmd, args, opts) -> { status, stdout, stderr, error }, findOpengrep() -> path|null, ratchet(argv, log) -> code, env, log, tmp() -> dir } */
export function main(argv, deps = {}) {
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
  const env = deps.env ?? process.env;
  const spawn = deps.spawn ?? realSpawn;
  const ratchet = deps.ratchet ?? runRatchet;
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    log(`semgrep-ccv3: ${e.message}`);
    return 2;
  }
  const root = path.resolve(o.root ?? path.join(here, '..', '..'));
  const find = deps.findOpengrep ?? (() => findOpengrep({ env }));
  const limit = limitInForce(env);
  if (limit.error) {
    log(limit.error);
    return 2;
  }
  log(`semgrep-ccv3: per-file limit ${limit.seconds} s${limit.overridden ? ' (CCV3_SEMGREP_TIMEOUT_S)' : ''}`);
  const { engine, r } = scan({ root, env, spawn, log, find, timeoutS: limit.seconds });
  if (r.error) {
    // No binary at all (ENOENT) or it could not start.
    log(engine === 'docker' ? DOCKER_DOWN_MESSAGE : `semgrep-ccv3: opengrep did not start: ${r.error.message}`);
    return 1;
  }
  if (engine === 'docker' && r.status !== 0 && DAEMON_DOWN.test(String(r.stderr))) {
    log(DOCKER_DOWN_MESSAGE);
    return 1;
  }
  if (r.status !== 0) {
    log(`semgrep-ccv3: the scan failed (exit ${r.status}): ${String(r.stderr).trim().split('\n').slice(-3).join(' | ')}`);
    return 2;
  }
  let report;
  try {
    report = JSON.parse(String(r.stdout));
  } catch {
    log('semgrep-ccv3: the scan output is not JSON, so nothing was checked.');
    return 2;
  }
  if (engine === 'opengrep') report = normaliseOpengrepReport(report);
  for (const line of timeLines(report, limit.seconds)) log(line);
  const reportFile = o.report ?? path.join((deps.tmp ?? (() => mkdtempSync(path.join(tmpdir(), 'semgrep-ccv3-'))))(), 'report.json');
  writeFileSync(reportFile, JSON.stringify(report));
  const args = ['--tool', 'semgrep', '--report', reportFile, '--baseline', deps.baseline ?? BASELINE];
  if (o.changed) args.push('--changed', o.changed);
  if (o.update) args.push('--update', '--reason', o.reason ?? '');
  try {
    return ratchet(args, log);
  } catch (e) {
    log(`semgrep-ccv3: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
