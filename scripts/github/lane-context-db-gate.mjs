/**
 * lane-context-db-gate.mjs: run .claude/hooks/src/__tests__/lane-context-db.test.ts on a scratch database, and FAIL when
 * the file is skipped. Without LANE_TEST_DB_URL that file skips all its tests and vitest exits 0, so no gate ran it before.
 *
 *   node scripts/github/lane-context-db-gate.mjs          from any folder; pre-pr (surface lane-context-db) and CI job coordination-db
 *
 * Steps:
 *   1. scripts/coordination/scratch-db.mjs create --through 6 makes lanes_pr1_<hex> on the server of CONTINUOUS_CLAUDE_DB_URL,
 *      DATABASE_URL or OPC_POSTGRES_URL (scratch-db's own chain). The url comes from its one JSON line on stdout.
 *   2. The url must pass scratch-db's own assertScratchUrl (imported): never the live database.
 *   3. vitest (resolved from .claude/hooks by module resolution, so a worktree's walk-up link works) runs that one file with
 *      LANE_TEST_DB_URL set and the JSON reporter to a temp file.
 *   4. Exit 0 only when vitest exits 0, the file has tests, every test passed and none was skipped (pending or todo).
 *   5. In finally: drop the scratch database (only when create gave a scratch url) and delete the temp file.
 * The url holds a password: no line this program prints carries it (redact). No Postgres: exit 1 with one ENV: line.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertScratchUrl, maskUrl } from '../coordination/scratch-db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SCRATCH_DB = path.join(REPO, 'scripts', 'coordination', 'scratch-db.mjs');
const HOOKS_DIR = path.join(REPO, '.claude', 'hooks');
// Child limits: create 2 + vitest 4 + drop 1 = 7 min, under the CI step (8) and the pre-pr gate (10), so finally always drops.
const MIN = 60_000;
export const TEST_FILE = 'src/__tests__/lane-context-db.test.ts';
export const THROUGH = '6';
const USAGE = 'usage: node scripts/github/lane-context-db-gate.mjs\n'
  + 'Makes a scratch database (scratch-db.mjs create --through 6), runs vitest on .claude/hooks/' + TEST_FILE + ' with LANE_TEST_DB_URL,\n'
  + 'drops the database. Exit 0 only when every test of the file ran and passed; a skipped file fails. No Postgres: exit 1, one ENV: line.\n';

/** Hide each url, its password and any other scheme://user:pass@ in text before it is printed. */
export function redact(text, ...urls) {
  let s = String(text ?? '');
  for (const url of urls.filter(Boolean)) {
    s = s.split(url).join(maskUrl(url));
    let pw = '';
    try { pw = decodeURIComponent(new URL(url).password); } catch { /* not a url: nothing more to hide */ }
    if (pw.length >= 3) s = s.split(pw).join('***');
  }
  return s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi, (m) => maskUrl(m));
}

/** The server urls scratch-db may read (its env chain). Their passwords are hidden too: create can fail before it gives a url. */
const baseUrls = (env) => [env.CONTINUOUS_CLAUDE_DB_URL, env.DATABASE_URL, env.OPC_POSTGRES_URL];

const lastLine = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '';

/** The verdict of one vitest run: { ok, line }. `report` is the parsed JSON report, or null. Pure. */
export function verdict(status, report) {
  if (!report || typeof report !== 'object') return { ok: false, line: 'lane-context-db: FAIL: vitest wrote no readable JSON report' };
  const t = Number(report.numTotalTests ?? 0);
  const p = Number(report.numPassedTests ?? 0);
  const s = Number(report.numPendingTests ?? 0) + Number(report.numTodoTests ?? 0);
  return { ok: status === 0 && t > 0 && p === t && s === 0, line: `lane-context-db: ${p} of ${t} passed, ${s} skipped` };
}

/** vitest.mjs found the way Node finds a package from .claude/hooks (walk up, so a worktree uses the shared store link). */
export function vitestEntry(hooksDir) {
  const pkg = createRequire(path.join(hooksDir, 'package.json')).resolve('vitest/package.json');
  return path.join(path.dirname(pkg), 'vitest.mjs');
}

const spawnOpts = (cwd, env, timeout) => ({ cwd, env, encoding: 'utf8', shell: false, windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 });

/** Step 1 and 2. Returns { url } or { lines } (one ENV line, or a refusal). */
function createScratch({ spawn, env }) {
  const r = spawn(process.execPath, [SCRATCH_DB, 'create', '--through', THROUGH], spawnOpts(REPO, env, 2 * MIN));
  let url = '';
  try { url = String(JSON.parse(lastLine(r.stdout)).url ?? ''); } catch { /* no JSON: create failed */ }
  if (r.status !== 0 || !url) {
    const cause = lastLine(r.stderr) || (r.error ? String(r.error.message) : '') || `create exited ${r.status} with no url`;
    const why = redact(cause, url, ...baseUrls(env)).replace(/\s+/g, ' ');
    return { lines: [`ENV: lane-context-db needs local Postgres for a scratch database: ${why}. This is the environment, not your change. Fix: start Postgres (docker compose up -d in docker/) or set CONTINUOUS_CLAUDE_DB_URL.`] };
  }
  try {
    assertScratchUrl(url);
  } catch (e) {
    return { lines: [`lane-context-db: FAIL: ${redact(e.message, url, ...baseUrls(env))}; vitest not run`] };
  }
  return { url };
}

/** Step 3 and 4. Returns { code, lines }. */
function runVitest({ spawn, env, url, hooksDir, report, resolveVitest }) {
  let entry;
  try { entry = resolveVitest(hooksDir); } catch (e) {
    return { code: 1, lines: [`ENV: lane-context-db needs vitest from ${hooksDir}: ${redact(lastLine(e.message), url)}. Fix: npm ci in .claude/hooks (Dave's yes).`] };
  }
  const args = [entry, 'run', TEST_FILE, '--testTimeout=30000', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
  const r = spawn(process.execPath, args, spawnOpts(hooksDir, { ...env, LANE_TEST_DB_URL: url }, 4 * MIN));
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(report, 'utf8')); } catch { /* verdict says so */ }
  const v = verdict(r.status, parsed);
  if (v.ok) return { code: 0, lines: [v.line] };
  const shown = redact(`${r.stdout ?? ''}${r.stderr ? `\n${r.stderr}` : ''}${r.error ? `\n${r.error.message}` : ''}`, url);
  return { code: 1, lines: [...shown.split(/\r?\n/).filter((l) => l.trim()), `${v.line}${r.status === 0 ? '' : ` (vitest exit ${r.status})`}`] };
}

/** Step 5, drop half. Returns the lines to add (empty when the drop worked). */
function dropScratch({ spawn, env, url }) {
  try {
    const r = spawn(process.execPath, [SCRATCH_DB, 'drop', url], spawnOpts(REPO, env, MIN));
    if (r.status === 0) return [];
    return [`lane-context-db: FAIL: could not drop the scratch database: ${redact(lastLine(r.stderr) || `exit ${r.status}`, url)}`];
  } catch (e) {
    return [`lane-context-db: FAIL: could not drop the scratch database: ${redact(e.message, url)}`];
  }
}

/**
 * The whole gate. Never throws. Returns { code, lines }: the caller prints the lines. `spawn` (spawnSync shape), `env`,
 * `tmpDir`, `hooksDir` and `resolveVitest` are injected so a test needs no database.
 */
export function run({ spawn = spawnSync, env = process.env, tmpDir = os.tmpdir(), hooksDir = HOOKS_DIR, resolveVitest = vitestEntry } = {}) {
  let made;
  try { made = createScratch({ spawn, env }); } catch (e) {
    return { code: 1, lines: [`ENV: lane-context-db could not run scratch-db create: ${redact(e.message, ...baseUrls(env)).replace(/\s+/g, ' ')}`] };
  }
  if (!made.url) return { code: 1, lines: made.lines };
  const { url } = made;
  const report = path.join(tmpDir, `lane-context-db-${randomBytes(4).toString('hex')}.json`);
  let out = { code: 1, lines: [] };
  try {
    out = runVitest({ spawn, env, url, hooksDir, report, resolveVitest });
  } catch (e) {
    out = { code: 1, lines: [`lane-context-db: FAIL: ${redact(e.message, url)}`] };
  } finally {
    const dropLines = dropScratch({ spawn, env, url });
    try { rmSync(report, { force: true }); } catch { /* the OS clears its temp folder */ }
    if (dropLines.length) out = { code: 1, lines: [...out.lines, ...dropLines] };
  }
  return out;
}

// main reads argv itself, inside the function: cli-smoke runs a script with a top-level argv read and no arguments, and a
// run of this gate with no arguments would build a scratch database in its sandbox.
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const r = run();
  for (const line of r.lines) process.stdout.write(`${line}\n`);
  return r.code;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) process.exitCode = main();
