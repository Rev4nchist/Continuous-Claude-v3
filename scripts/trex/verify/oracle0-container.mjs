// oracle0, container side: runs a Playwright spec that needs the Next server and a database inside the TREX environment
// (env.mjs: app container + its own Postgres, no route out, torn down after the run). The host cannot run these specs.
// The TREX run lock is global: this takes it for the whole replay and gives it back, also on failure.
//
// Judging is prove-check's: the same judge() as the host rows. Only the way a run is made differs.
//   pre side: the head tree is the pre SHA; the fix's copy of the overlay files is written over it inside the container.
//   fix side: the head tree is the fix SHA, nothing is written.
// Note: startEnv is given flowsDir scripts/trex/bench/flows/S1 and one flow { needs: ['db'] } only so that it finds a non-empty grading
// set and starts Postgres. No S1 flow runs. If that folder moves, every container row breaks.
// The seed gives the e2e specs the one thing they ask of the database: a live session (see session-detail-review.spec.ts, liveSession()).

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { judge } from '../../checks/prove-check.mjs';
import { ensureImage, startEnv, stopEnv } from '../env.mjs';
import { acquireLock, lockPathFor, primaryRootOf } from '../lock.mjs';

export const APP_DIR = 'apps/agentic-os';
export const SEED_LIVE_SESSION = "INSERT INTO sessions (id, project, working_on, started_at, last_heartbeat, last_activity_at) VALUES ('aaaaaaaa-1111-2222-3333-444444444444', 'trex-oracle0', 'oracle0 seed', now() at time zone 'utc', now() at time zone 'utc', now() at time zone 'utc');";
const SPEC_TIMEOUT_SEC = 900;
// The container has no USER or USERNAME. raw-project.spec.ts fails on "no OS user name to check" at both SHAs without one (seen in the first replay, S13).
export const SPEC_ENV = Object.freeze({ USER: 'oracle0' });

/** The deps a container run needs. Tests pass fakes. `git` is (args) => {status, stdout, stderr}. */
export const realContainerDeps = (git, cwd = process.cwd()) => ({
  git, cwd, ensureImage, startEnv, stopEnv, acquireLock,
  lockFile: lockPathFor(primaryRootOf(git, cwd)),
  imageSha: git(['rev-parse', 'HEAD']).stdout.trim(),
  evidenceRoot: path.join(cwd, '.claude', 'cache', 'proof', 'container'),
});

/** The playwright argv for spec files given as repo paths. Paths are made relative to the app folder. */
export function specArgv(specs) {
  return ['npx', 'playwright', 'test', ...specs.map((s) => s.replace(`${APP_DIR}/`, '')), '--project=chromium', '--reporter=list'];
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Writes `files` (repo paths) from `fix` into the container, in the repo layout under /app. Returns the paths written. */
async function writeOverlay(env, git, fix, files) {
  for (const f of files) {
    const shown = git(['show', `${fix}:${f}`]);
    if (shown.status !== 0) throw new Error(`git show ${fix}:${f} failed`);
    const w = await env.exec(['sh', '-c', `mkdir -p ${shQuote(path.posix.dirname(f))} && cat > ${shQuote(f)}`], { cwd: '.', stdin: shown.stdout, timeoutSec: 30 });
    if (w.code !== 0) throw new Error(`write ${f} into the container failed (exit ${w.code}): ${String(w.stderr).trim().slice(0, 200)}`);
  }
  return files;
}

async function seed(env, sql) {
  const pg = env.app.replace(/-app-1$/, '-postgres-1');
  const r = await env.d.docker(['exec', '-i', pg, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'claude', '-d', 'continuous_claude', '-f', '-'], { stdin: sql, env: env.childEnv, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`seed failed (exit ${r.code}): ${String(r.stderr).trim().slice(0, 200)}`);
}

/**
 * One side: bring the environment up for `head`, seed it, write the overlay, run the specs, tear it down.
 * Never throws: a failure to start is a run with `error` set, which classifyRun reads as BROKEN.
 */
export async function runSide(deps, { head, fix, overlay, specs }) {
  const runId = randomBytes(4).toString('hex');
  const evidenceDir = path.join(deps.evidenceRoot, runId);
  const cmd = specArgv(specs);
  let env = null;
  try {
    mkdirSync(evidenceDir, { recursive: true });
    const image = await deps.ensureImage({ head, imageSha: deps.imageSha, evidenceDir }, { cwd: deps.cwd });
    env = await deps.startEnv({ head, flowsSha: deps.imageSha, imageSha: deps.imageSha, image: image.tag, flows: [{ needs: ['db'] }], flowsDir: 'scripts/trex/bench/flows/S1', evidenceDir, runId }, { cwd: deps.cwd });
    if (env.skipped) throw new Error(`environment skipped: ${JSON.stringify(env.skipped)}`);
    await seed(env, SEED_LIVE_SESSION);
    if (overlay.length) await writeOverlay(env, deps.git, fix, overlay);
    const r = await env.exec(cmd, { cwd: APP_DIR, timeoutSec: SPEC_TIMEOUT_SEC, env: { ...SPEC_ENV } });
    const timedOut = r.timedOut === true;
    return { code: timedOut ? null : r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: timedOut ? 'timed out' : undefined, cmd, tree: `container:${runId}`, image: image.tag };
  } catch (e) {
    return { code: null, stdout: '', stderr: '', error: String(e.message ?? e), cmd, tree: `container:${runId}` };
  } finally {
    if (env && !env.skipped) await deps.stopEnv(env, { cwd: deps.cwd }).catch(() => {});
  }
}

/** Run `fn` while holding the global TREX lock. Returns fn's value, or throws when another run holds the lock. */
export async function withTrexLock(deps, fn) {
  const lock = deps.acquireLock(deps.lockFile, { pid: process.pid, started: new Date().toISOString(), argv: ['oracle0'], runId: 'oracle0', benchRun: null });
  if (!lock.ok) throw new Error(`the TREX run lock is held${lock.pid ? ` by pid ${lock.pid}` : ''}`);
  try { return await fn(); } finally { lock.release(); }
}

/**
 * A prove-check shaped result for one row in the container. The lock must be held by the caller (withTrexLock).
 * row: a groupRow() row with oracle.overlay and oracle.specs. Returns { major, check, ok, reasons, pre, fix, raw } like proveRow.
 */
export async function proveRowInContainer(row, deps) {
  const specs = row.oracle.specs;
  const overlay = row.oracle.overlay.filter((f) => f.startsWith(`${APP_DIR}/`));
  const preRun = await runSide(deps, { head: row.pre, fix: row.fix, overlay, specs });
  const fixRun = await runSide(deps, { head: row.fix, fix: row.fix, overlay: [], specs });
  const j = judge(row, preRun, fixRun);
  const phase = (ref, v, r, copied) => ({ ref, sha: ref, tree: r.tree, copied, code: r.code, cmd: r.cmd, ...v });
  return {
    major: row.major, check: row.check, ok: j.ok, reasons: j.reasons, note: row.note,
    pre: phase(row.pre, j.pre, preRun, overlay.map((f) => ({ from: `${row.fix}:${f}`, to: f }))),
    fix: phase(row.fix, j.fix, fixRun, []),
    raw: { pre: preRun, fix: fixRun },
  };
}
