/**
 * coord-drill-2 / lib.mjs -- the shared contract of the coordination drill.
 *
 * Every scenario imports this file. It gives a scenario four things: a throwaway sandbox (temp
 * registry, identity dir, fake home), a child env that points lane.mjs at ONE scratch database,
 * a way to run lane.mjs and other node scripts without a shell, and the row object a scenario
 * returns. It never creates or drops a database: run.mjs does that.
 *
 * Verdict words: PASS = the rule IS enforced. FAIL = the gap is open. ERROR = the harness or its
 * positive control is broken. ERROR must never look like FAIL, so result() turns a broken control
 * into ERROR by itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertScratchUrl, maskUrl } from '../scratch-db.mjs';
import { lookupDep, requireDep } from '../../lib/resolve-deps.mjs';

/** A harness fault (not a verdict about the rule). run.mjs maps it to an ERROR row. */
export class HarnessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HarnessError';
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The checkout that holds this script. In a linked worktree this is the worktree, not the primary.
const REPO = path.resolve(HERE, '..', '..', '..');

export const PATHS = {
  HERE,
  REPO,
  LANE: path.join(REPO, 'scripts', 'coordination', 'lane.mjs'),
  SCRATCH: path.join(REPO, 'scripts', 'coordination', 'scratch-db.mjs'),
  HOOK_DIST: path.join(REPO, '.claude', 'hooks', 'dist'),
};

const fwd = (p) => String(p).replace(/\\/g, '/');

// ---------------------------------------------------------------- abort after a timeout

// Set by abortDrill when a scenario times out. The timed-out scenario keeps running at its next await, so
// lane, runNode and ctx.pg refuse to work after this, or it would change the state of the rows that follow.
let drillAborted = null;

/** Stop every scenario call that reaches a child process or the scratch database. run.mjs calls this on a timeout. */
export function abortDrill(ctx, why) {
  if (ctx) ctx.aborted = true;
  drillAborted = String(why ?? 'aborted');
}

export function assertNotAborted(what) {
  if (drillAborted) throw new HarnessError(`${what}: refused, the drill was aborted (${drillAborted})`);
}

// ---------------------------------------------------------------- database access

/** The pg module, through the one shared lookup (own checkout, primary checkout, NODE_PATH). */
export function loadPg() {
  try {
    return requireDep('pg', { repoRoot: REPO });
  } catch (e) {
    throw new HarnessError(`cannot load pg: ${e.message}`);
  }
}

/**
 * Run fn(client) on a connected pg client, then close it. The client sets lane.client_version
 * first, because a script that writes agentic_os.lane must do that (the board trigger denies it
 * otherwise). That setting is what lets a writer past the board trigger, so this refuses any
 * url that is not a scratch database. run.mjs reads the live board with its own client.
 * Connect is inside the try, so a failed connect still closes the client. Every statement stops
 * after 30 seconds, so a lock wait ends in an error and cleanup still runs.
 */
export async function withPg(url, fn) {
  assertScratch(url);
  const { Client } = loadPg();
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query(`SET statement_timeout = '30s'`);
    await client.query(`SELECT set_config('lane.client_version','drill',false)`);
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Throw a HarnessError unless url names a scratch database (lanes_pr1_*). The message never holds the password. */
export function assertScratch(url) {
  if (!url) throw new HarnessError('no database url: a scratch database url is required');
  try {
    assertScratchUrl(url);
  } catch (e) {
    throw new HarnessError(`not a scratch database (${maskUrl(url)}): ${e.message}`);
  }
}

// ---------------------------------------------------------------- sandbox and env

/**
 * A temp folder with everything a child reads or writes outside the database: one registry entry
 * for projectDir (the board registry, plus a repo copy and an active copy for the `project` verbs),
 * an empty identity dir, a fake user home with its .claude folder, and the hook trace, guard log and
 * router log paths. Nothing here touches the real ~/.claude or the real registry.
 */
export function makeSandbox(runId) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `coord-drill-2-${runId}-`)));
  const projectDir = path.join(dir, 'proj');
  const identityDir = path.join(dir, 'ids');
  const homeDir = path.join(dir, 'home');
  const traceDir = path.join(homeDir, '.claude', 'cache');
  const stateDir = path.join(homeDir, '.claude', 'state');
  for (const d of [projectDir, identityDir, homeDir, traceDir, stateDir]) fs.mkdirSync(d, { recursive: true });
  const boardKey = `zz-drill-${runId}`;
  const registryText = JSON.stringify({
    version: '1.0',
    projects: [{ name: boardKey, key: boardKey, path: fwd(projectDir), status: 'active' }],
  });
  const registryPath = path.join(dir, 'registry.json');
  const registryRepoPath = path.join(dir, 'registry-repo.json');
  const registryActivePath = path.join(dir, 'registry-active.json');
  for (const f of [registryPath, registryRepoPath, registryActivePath]) fs.writeFileSync(f, registryText);
  return {
    dir, projectDir, registryPath, registryRepoPath, registryActivePath, identityDir, homeDir, boardKey,
    guardLog: path.join(dir, 'guard-decisions.jsonl'),
    traceDir,
    traceModeFile: path.join(stateDir, 'hook-trace-mode'),
    routerLog: path.join(dir, 'rule-router.jsonl'),
    // maxRetries: Windows can hold a git worktree folder for a moment (EBUSY) after the child ends.
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }),
  };
}

// Names that would make a child act as the drill's own session, board or checkout. A whole family is removed, not a
// fixed list: a new CLAUDE_CODE_* or GIT_* name (GIT_CONFIG_COUNT, GIT_SSH_COMMAND, ...) must not reach a child.
// Env names are case-insensitive on Windows, so the match is too.
const SCRUBBED_ENV_RE = /^(?:CLAUDE_CODE_|GIT_)|^CLAUDECODE$/i;
const SCRUBBED_ENV = ['LANE_PROJECT', 'COORDINATION_BREAK_GLASS', 'COORDINATION_SESSION_ID', 'CLAUDE_PROJECT_DIR'];

/** Delete from env every name the child must not inherit. */
function scrub(env) {
  const named = new Set(SCRUBBED_ENV);
  for (const k of Object.keys(env)) {
    if (SCRUBBED_ENV_RE.test(k) || named.has(k.toUpperCase())) delete env[k];
  }
  return env;
}

// The node_modules folder that holds `pg`, found once in this process (own checkout, primary, NODE_PATH).
let pgModules;
function pgNodeModules() {
  if (pgModules === undefined) {
    const found = lookupDep('pg', { repoRoot: REPO }).path;
    const m = found ? /^(.*[\\/]node_modules)[\\/]pg[\\/]/.exec(found) : null;
    pgModules = m ? m[1] : null;
  }
  return pgModules;
}

/**
 * The env of every child: the scratch database in all three variables, the sandbox, and no inherited identity.
 * Every variable that lets a child write outside the sandbox points inside it: HOME and USERPROFILE (os.homedir()
 * reads USERPROFILE on Windows), the hook trace dir and mode file, the guard log, the two lane registries and the
 * router log. A fake home hides the real checkout from the `pg` lookup if git fails there, so NODE_PATH gets the
 * folder that holds pg. The real registry is not needed: the sandbox holds its own copies.
 * `extra` may not name a sandbox or database key (case-insensitive, as on Windows): that throws a HarnessError.
 * The sandbox keys are also applied after `extra`, so no caller can undo them.
 */
export function childEnv(url, sandbox, extra = {}) {
  assertScratch(url);
  const env = scrub({ ...process.env });
  const pgDir = pgNodeModules();
  const locked = {
    HOME: sandbox.homeDir,
    USERPROFILE: sandbox.homeDir,
    LANE_REGISTRY_PATH: sandbox.registryPath,
    LANE_REGISTRY_REPO: sandbox.registryRepoPath,
    LANE_REGISTRY_ACTIVE: sandbox.registryActivePath,
    CLAUDE_RULE_ROUTER_LOG: sandbox.routerLog,
    CCV3_IDENTITY_DIR: sandbox.identityDir,
    CCV3_USER_HOME: sandbox.homeDir,
    CCV3_GUARD_DECISIONS_LOG: sandbox.guardLog,
    CCV3_HOOK_TRACE_DIR: sandbox.traceDir,
    CCV3_HOOK_TRACE_MODE_FILE: sandbox.traceModeFile,
    CONTINUOUS_CLAUDE_DB_URL: url, DATABASE_URL: url, OPC_POSTGRES_URL: url,
    // git never looks for a repository in this folder or above it: a child that runs outside a test repo finds none.
    GIT_CEILING_DIRECTORIES: sandbox.dir,
  };
  const lockedNames = new Set(Object.keys(locked));
  const named = Object.keys(extra).filter((k) => lockedNames.has(k.toUpperCase()));
  if (named.length) throw new HarnessError(`childEnv: extra names sandbox key(s) ${named.join(', ')}; a child must stay in the sandbox`);
  return {
    ...env,
    ...(pgDir ? { NODE_PATH: [pgDir, env.NODE_PATH].filter(Boolean).join(path.delimiter) } : {}),
    // `project register` precheck only; harmless for the other verbs.
    LANE_SKIP_HOOK_PRECHECK: '1',
    ...extra,
    // After `extra`: the sandbox and the database url cannot be moved by a caller.
    ...locked,
  };
}

// ---------------------------------------------------------------- running children

/**
 * Run a node script with an argv array, no shell. A spawn error or a killed child is a HarnessError, not an exit code.
 * A timeout (timeoutMs, default 120 s) is a HarnessError that carries the output so far in .out and .err: the create of
 * the scratch database prints its name first, and the caller needs it to drop a database that was left behind.
 * env is required: a child with no env inherits process.env, and with it the live database url.
 * After abortDrill it refuses to run, except for the harness's own calls (harness: true: create and drop of the scratch database).
 */
export function runNode(script, args = [], { env, input, cwd, harness = false, timeoutMs = 120_000 } = {}) {
  if (!harness) assertNotAborted(`runNode(${path.basename(String(script))})`);
  if (!env) throw new HarnessError(`runNode(${path.basename(String(script))}): env is missing; a child without an explicit env would inherit the live database url`);
  const r = spawnSync(process.execPath, [script, ...args], {
    env, input, cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
  });
  if (r.error) {
    const e = new HarnessError(`could not run ${path.basename(script)}: ${r.error.message}`);
    e.out = r.stdout ?? '';
    e.err = r.stderr ?? '';
    e.timedOut = r.error.code === 'ETIMEDOUT';
    throw e;
  }
  if (r.status === null) throw new HarnessError(`${path.basename(script)} ended without an exit code (signal ${r.signal})`);
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * Run the worktree lane.mjs as session `asSession`, in the sandbox project folder. It refuses to run
 * without ctx.env: a child with no env inherits the live database url. It tracks the session id
 * for the live-board zero check.
 */
export function lane(ctx, args, asSession) {
  if (ctx?.aborted) throw new HarnessError('lane: refused, the drill was aborted after a timeout');
  if (!ctx?.env) throw new HarnessError('lane: ctx.env is missing; a child without the scratch env would reach the live board');
  track(ctx, 'session', asSession);
  return runNode(PATHS.LANE, [...args, '--as', asSession], { env: ctx.env, cwd: ctx.sandbox.projectDir });
}

// ---------------------------------------------------------------- fixtures

/** Write the identity file that maps a name to a session. The file name must be a uuid-like id (session-label.mjs). */
export function writeIdentity(ctx, sessionId, name) {
  const file = path.join(ctx.sandbox.identityDir, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    uuid: sessionId, short: String(sessionId).slice(0, 8), name,
    previous: null, cwd: fwd(ctx.sandbox.projectDir), endedAt: null, endReason: null,
    updatedAt: new Date().toISOString(),
  }));
  track(ctx, 'session', sessionId);
}

/** A sessions row. ageSeconds > 0 makes it look idle for that long (heartbeat and activity both). */
export async function insertSession(client, id, project, { ageSeconds = 0 } = {}) {
  await client.query(
    `INSERT INTO public.sessions (id, project, working_on, started_at, last_heartbeat, last_activity_at)
     VALUES ($1, $2, 'coord-drill-2', now() - make_interval(secs => $3::int),
             now() - make_interval(secs => $3::int), now() - make_interval(secs => $3::int))`,
    [id, project, ageSeconds],
  );
}

/** A lane row. An owner gets a lease that ends in leaseMinutes (negative: already lapsed). No owner: no lease. */
export async function insertLane(client, { id, title, state = 'active', owner = null, leaseMinutes = 30, projectKey }) {
  await client.query(
    `INSERT INTO agentic_os.lane (id, title, track, state, project_key, owner_session_id, claimed_at, lease_expires_at)
     VALUES ($1, $2, 'zz', $3, $4, $5::text,
             CASE WHEN $5::text IS NULL THEN NULL ELSE now() END,
             CASE WHEN $5::text IS NULL THEN NULL ELSE now() + make_interval(mins => $6::int) END)`,
    [id, title ?? `drill lane ${id}`, state, projectKey, owner, leaseMinutes],
  );
}

const TRACK_KINDS = ['session', 'lane', 'file', 'claim'];

/**
 * Record an id the run created, for the live-board zero check. kind: 'session' | 'lane' | 'file' (an absolute path, as
 * the hook stores a file outside any repo) | 'claim' ({ project, file }: a file_claims row as the hook stores it, with the
 * repo-relative key for a file in a repo).
 */
export function track(ctx, kind, id) {
  if (!TRACK_KINDS.includes(kind)) throw new HarnessError(`track: unknown kind '${kind}' (use ${TRACK_KINDS.join(', ')})`);
  ctx.tracked ??= { session: [], lane: [], file: [], claim: [] };
  ctx.tracked.claim ??= [];
  const same = (x) => (kind === 'claim' ? x.project === id.project && x.file === id.file : x === id);
  if (!ctx.tracked[kind].some(same)) ctx.tracked[kind].push(kind === 'claim' ? { project: id.project, file: id.file } : id);
}

// ---------------------------------------------------------------- proof of "no file outside the sandbox"

// Read at most this many bytes of one watched file when it looks for a marker.
const WATCH_READ_CAP = 32 * 1024 * 1024;
// A changed file smaller than this is read whole: an overwritten file (the session-id file) shows no appended slice.
const WHOLE_FILE_CAP = 64 * 1024;
// Of a large file in the modified-time scan, only the last bytes are read.
const SCAN_TAIL_CAP = 8 * 1024 * 1024;
// The folders under <home>/.claude that the modified-time scan reads (top level, files only).
const SCAN_DIRS = [['logs'], ['state'], ['state', 'identity'], ['cache']];

/** Every home folder a child could have resolved before childEnv moved it: USERPROFILE, HOME and os.homedir(). */
function realHomes() {
  const homes = new Map();
  for (const h of [process.env.USERPROFILE, process.env.HOME, os.homedir()]) {
    if (!h) continue;
    const abs = path.resolve(h);
    homes.set(process.platform === 'win32' ? abs.toLowerCase() : abs, abs);
  }
  return [...homes.values()];
}

/**
 * The files under each home that a drill child could write: today's hook trace, the guard log, the session-id file.
 * homes defaults to the real homes; the positive control passes a temp home.
 */
function watchedFiles(homes = realHomes()) {
  const day = new Date().toISOString().slice(0, 10); // the hook names the trace file by the UTC day of the row
  const files = [];
  for (const home of homes) {
    files.push(
      path.join(home, '.claude', 'cache', `hook-trace-${day}.jsonl`),
      path.join(home, '.claude', 'logs', 'guard-decisions.jsonl'),
      path.join(home, '.claude', '.coordination-session-id'),
    );
  }
  return files;
}

function statOrNull(file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Snapshot size and mtime of the real files a drill child could write (see watchedFiles). Read only.
 * Returns { files: { <path>: { size, mtimeMs } | null }, takenAtMs }. Pass it to diffRealHome and scanRealHomeChanged
 * after the run, with the same homes.
 */
export function snapshotRealHome(homes = realHomes()) {
  const files = {};
  for (const f of watchedFiles(homes)) files[f] = statOrNull(f);
  return { files, takenAtMs: Date.now() };
}

/**
 * The text a file gained since `before`. A file that is new, smaller than 64 KB, or not larger than before (shrunk or
 * overwritten in place) is read whole; a large file that grew is read from the old size. '' when there is nothing to
 * read; null when the read failed (the caller must report that, it is not the same as a clean read).
 */
function gainedText(file, before, now) {
  const whole = !before || now.size < WHOLE_FILE_CAP || now.size <= before.size;
  const from = whole ? 0 : before.size;
  const len = Math.min(now.size - from, WATCH_READ_CAP);
  if (len <= 0) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, from);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * Compare the real files with a snapshotRealHome() taken before the run. Returns an array of strings, one per
 * real file that this run wrote: [] means "no file outside the sandbox". Other Claude sessions on the machine
 * append to the same trace and guard log, so a size change alone is not proof. A file counts only when the
 * text it gained holds one of `markers` (the run id, the sandbox folder name, session and lane ids of the run;
 * a marker shorter than 8 characters is ignored because it would match unrelated rows).
 * A file that shrank, is new, is under 64 KB or was overwritten in place is read whole (see gainedText).
 * A watched file that cannot be read is reported, not ignored. homes defaults to the real homes.
 */
export function diffRealHome(before, markers = [], homes = realHomes()) {
  const needles = markerNeedles(markers, 'diffRealHome');
  const changed = [];
  for (const file of [...new Set([...Object.keys(before?.files ?? {}), ...watchedFiles(homes)])]) {
    const was = before?.files?.[file] ?? null;
    const now = statOrNull(file);
    if (!now || (was && was.size === now.size && was.mtimeMs === now.mtimeMs)) continue;
    const text = gainedText(file, was, now);
    if (text === null) { changed.push(`${fwd(file)}: changed (size ${was?.size ?? 0} -> ${now.size} bytes) and could not be read`); continue; }
    const hit = needles.find((m) => text.includes(m));
    if (hit) changed.push(`${fwd(file)}: gained text with marker '${hit}' (size ${was?.size ?? 0} -> ${now.size})`);
  }
  return changed;
}

function markerNeedles(markers, who) {
  const needles = [...new Set(markers.map(String).filter((m) => m.length >= 8))];
  if (needles.length === 0) throw new HarnessError(`${who}: no marker of 8 characters or more; the check would look for nothing`);
  return needles;
}

/** The last bytes of a file (all of it when small). '' for an empty file; null when the read failed. */
function tailText(file, size) {
  const from = Math.max(0, size - SCAN_TAIL_CAP);
  const len = size - from;
  if (len <= 0) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, from);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * The second real-home proof. Read only. In <home>/.claude/{logs,state,state/identity,cache} (top level of each folder,
 * files only) it finds the files whose modified time is later than the snapshot, and reports each one whose content holds
 * a marker. The watched files are left out: diffRealHome covers them. A file that cannot be read is not a hit, and it
 * is not counted as read: it is counted in `unreadable`, so the caller can say how many changed files were not checked.
 * Returns { hits: [string], scanned: number of changed files read, unreadable: number of changed files that could not be read }.
 * homes defaults to the real homes.
 */
export function scanRealHomeChanged(before, markers = [], homes = realHomes()) {
  const needles = markerNeedles(markers, 'scanRealHomeChanged');
  const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const watched = new Set(watchedFiles(homes).map(key));
  const since = (before?.takenAtMs ?? 0) - 1000; // a file changed before the snapshot cannot hold a marker of this run
  const hits = [];
  let scanned = 0;
  let unreadable = 0;
  for (const home of homes) {
    for (const sub of SCAN_DIRS) {
      const dir = path.join(home, '.claude', ...sub);
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isFile()) continue;
        const file = path.join(dir, e.name);
        const st = statOrNull(file);
        if (!st || st.mtimeMs < since || watched.has(key(file))) continue;
        const text = tailText(file, st.size);
        if (text === null) { unreadable++; continue; }
        scanned++;
        const hit = needles.find((m) => text.includes(m));
        if (hit) hits.push(`${fwd(file)}: changed during the run and holds marker '${hit}'`);
      }
    }
  }
  // scanIncomplete: a changed file was not read, so it can hide a marker. The caller must not report "0 writes".
  return { hits, scanned, unreadable, scanIncomplete: unreadable > 0 };
}

/**
 * The positive control of both real-home proofs. It builds a temp "home" in os.tmpdir() with the watched files, then:
 * (trace and guard log are seeded over 64 KB so the slice branch runs; the guard seed holds the marker in its old body)
 * appends one marker line to the trace file, appends one line with no marker to the guard log, overwrites the session-id
 * file with a same-length id that holds the marker, writes a marker file in state/identity, a no-marker file in logs,
 * and leaves an old marker file in cache. It requires exactly the expected hits from diffRealHome (trace, session-id) and
 * from scanRealHomeChanged (the identity file only). Returns { ok, detail }. Never throws; never touches a real home.
 */
export function sandboxControl() {
  let dir;
  try {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-drill-2-ctl-')));
    const home = path.join(dir, 'home');
    const marker = `ctl-${randomBytes(6).toString('hex')}`;
    const [trace, guard, sid] = watchedFiles([home]);
    const mk = (f) => fs.mkdirSync(path.dirname(f), { recursive: true });
    const old = new Date(Date.now() - 60_000);
    const seed = (f, text) => { mk(f); fs.writeFileSync(f, text); fs.utimesSync(f, old, old); };
    // Both logs are seeded over 64 KB, like the real ones, so the appended line goes through the slice branch of
    // gainedText (from = old size). The guard seed holds the marker in its OLD body: a read from the wrong offset
    // (0 instead of the old size) would see it and report a write that this run did not make.
    const pad = `{"pad":"${'a'.repeat(WHOLE_FILE_CAP + 1024)}"}\n`;
    seed(trace, `{"session_id":"seed-trace-line"}\n${pad}`);
    seed(guard, `{"session_id":"${marker}","note":"old line"}\n${pad}`);
    seed(sid, '0'.repeat(36));
    seed(path.join(home, '.claude', 'cache', 'old.json'), `${marker}\n`);
    const before = snapshotRealHome([home]);

    fs.appendFileSync(trace, `{"session_id":"${marker}"}\n`);
    fs.appendFileSync(guard, '{"session_id":"unrelated-session-line"}\n');
    fs.writeFileSync(sid, marker.padEnd(36, '-')); // same length as the seed: only a whole-file read sees it
    const idFile = path.join(home, '.claude', 'state', 'identity', 'ctl.json');
    const otherFile = path.join(home, '.claude', 'logs', 'other.log');
    mk(idFile); fs.writeFileSync(idFile, `{"uuid":"${marker}"}\n`);
    mk(otherFile); fs.writeFileSync(otherFile, 'a line with no marker\n');

    const diff = diffRealHome(before, [marker], [home]);
    const scan = scanRealHomeChanged(before, [marker], [home]);
    const has = (list, part) => list.filter((l) => l.includes(part)).length;
    const diffOk = diff.length === 2 && has(diff, 'hook-trace-') === 1 && has(diff, '.coordination-session-id') === 1 && has(diff, 'guard-decisions') === 0;
    const scanOk = scan.hits.length === 1 && has(scan.hits, 'ctl.json') === 1 && scan.scanned === 2 && scan.unreadable === 0;
    const sliceOk = (before.files[trace]?.size ?? 0) > WHOLE_FILE_CAP && (before.files[guard]?.size ?? 0) > WHOLE_FILE_CAP;
    return {
      ok: diffOk && scanOk && sliceOk,
      detail: `diffRealHome hits ${diff.length} (expected 2: trace append read from the old offset of a ${before.files[trace]?.size}-byte file, session-id overwrite; `
        + `guard append without marker ignored, old marker in its body not re-read); `
        + `scan hits ${scan.hits.length} of ${scan.scanned} changed files, ${scan.unreadable} unreadable (expected 1 of 2, 0 unreadable; old file ignored)`
        + `${sliceOk ? '' : '; seeded logs are not over 64 KB, so the slice branch was not exercised'}`,
    };
  } catch (e) {
    return { ok: false, detail: `control threw: ${e?.message ?? e}` };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* ignore */ } }
  }
}

// ---------------------------------------------------------------- the row object

const VERDICTS = ['PASS', 'FAIL', 'ERROR'];

/**
 * The row a scenario returns. control = { name, ok, detail } is the positive control: proof the
 * check can see the thing it looks for. A row with no control, or a control that failed, is ERROR
 * whatever verdict the scenario asked for, so a broken harness never reads as FAIL or PASS.
 */
export function result({ id, title, rule, verdict, reason, control, evidence }) {
  if (!VERDICTS.includes(verdict)) throw new HarnessError(`row ${id}: verdict must be PASS, FAIL or ERROR, got '${verdict}'`);
  let v = verdict;
  let why = reason;
  if (v !== 'ERROR' && !control) {
    v = 'ERROR';
    why = `row has no positive control (asked for ${verdict}). ${reason ?? ''}`.trim();
  } else if (control && control.ok !== true && v !== 'ERROR') {
    v = 'ERROR';
    why = `positive control '${control.name}' is broken (asked for ${verdict}): ${control.detail ?? ''} | ${reason ?? ''}`.trim();
  }
  return {
    id: String(id), title, rule, verdict: v, reason: why,
    control: control ?? { name: '(none)', ok: false, detail: 'no control given' },
    evidence,
  };
}
