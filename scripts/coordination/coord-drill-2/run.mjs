#!/usr/bin/env node
/**
 * coord-drill-2 / run.mjs -- the repeatable multi-session test of the coordination rules.
 *
 *   node run.mjs [--rows 2,3,5,7,8] [--out <json file>] [--keep-db] [--help]
 *
 * A row prints PASS when the rule IS enforced, FAIL when the gap is open, ERROR when the harness or its
 * positive control is broken. expected.json holds the verdict each row has on main today.
 *
 * Steps: make ONE scratch database (scratch-db.mjs, never the live one), run each scenario against it,
 * drop it and prove the drop, then check that nothing of this run reached the LIVE board (read only) or the
 * real home (read only; with a built-in positive control). Both checks print before any ROW line. If either
 * fails, RUN INVALID prints first and the --out summary holds "valid": false. A scenario that times out aborts
 * the drill: the rows that remain are ERROR "skipped after timeout".
 *
 * Exit code: 0 every row equals its expected verdict, 1 at least one differs, 2 a row is ERROR, the
 * harness failed, or the live board or the real home holds a row or write of this run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertScratchUrl, maskUrl } from '../scratch-db.mjs';
import {
  countChecks, createScratch, errText, errorRow, judge, liveZeroCheck, loadExpected, makeSignalHandler, maskText, newRunId, normalise, oneLine,
  parseArgs, printRow, scratchControl, writeSummary,
} from './judge.mjs';
import {
  HarnessError, PATHS, abortDrill, assertScratch, childEnv, diffRealHome, loadPg, makeSandbox, result, runNode,
  sandboxControl, scanRealHomeChanged, snapshotRealHome, withPg,
} from './lib.mjs';

const SCENARIOS = {
  2: 's2-worktree-claim.mjs',
  3: 's3-shell-write.mjs',
  5: 's5-as-override.mjs',
  7: 's7-parked-say.mjs',
  8: 's8-rule-size.mjs',
};
const STATIC_ROWS = ['8'];
const USAGE = `usage: node run.mjs [--rows 2,3,5,7,8] [--out <json file>] [--keep-db] [--help]
  --rows              the rows to run (default 2,3,5,7,8). Row 8 is static: with only row 8 no database is made.
  --out               write a JSON summary to this file
  --keep-db           do not drop the scratch database at the end (its masked url is printed)
exit: 0 every row equals expected.json, 1 a row differs, 2 a row is ERROR or the harness failed`;

// The live url, captured before anything else: the same env chain scratch-db.mjs uses. Never printed.
const LIVE_URL = process.env.CONTINUOUS_CLAUDE_DB_URL
  || process.env.DATABASE_URL
  || process.env.OPC_POSTGRES_URL
  || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';

// ---------------------------------------------------------------- args and output helpers

const parse = (argv) => parseArgs(argv, SCENARIOS, USAGE);

// ---------------------------------------------------------------- scratch database

/** Drop a database by name through scratch-db.mjs. The url is the server url with that name; it is never printed. */
function dropByName(name) {
  const url = urlOnDb(LIVE_URL, name);
  assertScratch(url);
  const d = runNode(PATHS.SCRATCH, ['drop', url], { env: process.env, harness: true });
  if (d.code !== 0) throw new HarnessError(`scratch-db drop failed (exit ${d.code}): ${maskText(oneLine(d.err))}`);
}

/** Make the scratch database through scratch-db.mjs (the only creator) and check its name. A failed create drops what it left. */
function makeScratch() {
  return createScratch({
    run: () => runNode(PATHS.SCRATCH, ['create', '--through', '6'], { env: process.env, harness: true }),
    dropByName,
  });
}

async function withClient(url, fn) {
  const { Client } = loadPg();
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query(`SET statement_timeout = '30s'`);
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** The live url must not name a scratch database: the live zero check would then look at the scratch server only. */
function assertLiveUrlIsNotScratch() {
  let name = null;
  try { name = assertScratchUrl(LIVE_URL); } catch { return; /* not a scratch name: good */ }
  throw new HarnessError(`the live database url names a scratch database ('${name}'); refusing, the live zero check would prove nothing`);
}

const urlOnDb = (url, db) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

/** Drop through scratch-db.mjs, then ask the server's postgres database whether the name is gone. */
async function dropScratch(scratch) {
  assertScratch(scratch.url);
  const d = runNode(PATHS.SCRATCH, ['drop', scratch.url], { env: process.env, harness: true });
  if (d.code !== 0) throw new HarnessError(`scratch-db drop failed (exit ${d.code}): ${maskText(oneLine(d.err))}`);
  const left = await withClient(urlOnDb(scratch.url, 'postgres'),
    async (c) => (await c.query('SELECT count(*)::int AS n FROM pg_database WHERE datname = $1', [scratch.name])).rows[0].n);
  if (left !== 0) throw new HarnessError(`scratch database ${scratch.name} still exists after drop`);
  console.log(`DROP: scratch database ${scratch.name} dropped (pg_database rows: 0)`);
}

// ---------------------------------------------------------------- scenarios

// A scenario that waits on a hung database call would block the drop and the cleanup. spawnSync calls in a
// scenario block this timer, but each has its own 120 s limit in runNode; the timer covers the pg awaits.
const SCENARIO_TIMEOUT_MS = 300_000;

/** onTimeout runs first: the timed-out promise keeps running, so the drill must be aborted before the reject. */
function withTimeout(promise, ms, label, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new HarnessError(`${label} timed out after ${ms / 1000} seconds`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Load one scenario by row and run it. A missing module or a throw gives one ERROR row; the run goes on.
 * A timeout gives one ERROR row and aborts the drill (ctx.aborted): main skips the rows that remain.
 */
async function runScenario(id, ctx) {
  try {
    const mod = await import(pathToFileURL(path.join(PATHS.HERE, SCENARIOS[id])).href);
    const out = await withTimeout(Promise.resolve(mod.run(ctx)), SCENARIO_TIMEOUT_MS, `scenario ${id}`,
      () => abortDrill(ctx, `scenario ${id} timed out`));
    const rows = (Array.isArray(out) ? out : [out]).map((r) => normalise(r, id));
    if (!rows.some((r) => r.id === id)) rows.push(errorRow(id, mod.meta?.title ?? '(no title)', `scenario ${id} returned no row with id ${id}`, 'scenario result'));
    return rows;
  } catch (e) {
    const missing = e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(SCENARIOS[id]);
    return [errorRow(id, '(scenario not run)', missing ? `scenario module ${SCENARIOS[id]} is missing` : `scenario ${id} threw: ${errText(e)}`, 'scenario runs')];
  }
}

// ---------------------------------------------------------------- live zero check (seat condition C3)

/** Count the rows of this run on the live server. Read only. The same checks run on the scratch database (countScratch). */
async function countLive(tracked, boardKey, names) {
  return withClient(LIVE_URL, async (c) => {
    await c.query('SET default_transaction_read_only = on');
    return countChecks(c, tracked, boardKey, names);
  });
}

const countScratchWith = (url) => (tracked, boardKey, names) => withClient(url, (c) => countChecks(c, tracked, boardKey, names));

// ---------------------------------------------------------------- real-home check ("no file outside the sandbox")

/**
 * The real-home proof. First the positive control (a temp home; see sandboxControl): if it fails, SANDBOX is ERROR and
 * the run exits 2. Then it compares the watched real files with the snapshot (diffRealHome) and scans the real
 * {logs,state,state/identity,cache} for files changed during the run that hold a marker. It only reads. Never throws.
 */
function sandboxCheck(before, runId, sandbox, tracked, say = console.log) {
  const control = sandboxControl();
  if (!control.ok) {
    say(`SANDBOX: ERROR, the positive control failed, so the check proves nothing: ${oneLine(control.detail)}`);
    return { ok: false, error: 'positive control failed', control };
  }
  say(`SANDBOX CONTROL: ok -- ${oneLine(control.detail)}`);
  try {
    const markers = [runId, sandbox?.boardKey, sandbox ? path.basename(sandbox.dir) : null, ...tracked.session, ...tracked.lane].filter(Boolean);
    const changed = diffRealHome(before, markers);
    const scan = scanRealHomeChanged(before, markers);
    const hits = [...changed, ...scan.hits];
    const listed = Object.keys(before.files).length;
    const watched = Object.values(before.files).filter(Boolean).length; // a null entry is a file that did not exist
    const of = `${watched} existing of ${listed} listed`;
    say(hits.length === 0
      ? `SANDBOX: 0 writes to the watched real files (${of})`
      : `SANDBOX: ${hits.length} real-home writes FOUND (watched real files: ${of})`);
    say(`SANDBOX SCAN: ${scan.scanned + scan.unreadable} real files in logs, state, state/identity, cache changed during the run: ${scan.scanned} read, ${scan.unreadable} unreadable (not checked), ${scan.hits.length} marker hits`);
    for (const c of hits) say(`  real-home write: ${c}`);
    if (scan.scanIncomplete) say(`SANDBOX SCAN: INCOMPLETE: ${scan.unreadable} changed real file(s) could not be read and ${scan.unlisted ?? 0} folder(s) could not be listed, so a write of this run cannot be ruled out`);
    return { ok: hits.length === 0 && !scan.scanIncomplete, changed, scan, watched, listed, control };
  } catch (e) {
    say(`SANDBOX: ERROR, check failed: ${errText(e)}`);
    return { ok: false, error: errText(e), control };
  }
}

/** The commit of the checkout this drill runs from: rows 2, 3 and 8 read the hook dist, settings and rules of this checkout, not of main. */
function repoHead() {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[k];
  try {
    const r = spawnSync('git', ['-C', PATHS.REPO, 'rev-parse', 'HEAD'], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const sha = String(r.stdout ?? '').trim();
    return r.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------- report

// ---------------------------------------------------------------- main

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return 0; }
  const startedAt = new Date().toISOString();
  const runId = newRunId();
  const expected = loadExpected(opts.rows);
  const needDb = opts.rows.some((r) => !STATIC_ROWS.includes(r));
  if (needDb) assertLiveUrlIsNotScratch();
  // Taken before any child runs. Read only.
  const realBefore = snapshotRealHome();
  const tracked = { session: [], lane: [], file: [], claim: [] };
  const rows = [];
  let scratch = null;
  let sandbox = null;
  let harnessFailed = false;
  let control = null; // the positive control of the live zero check, run on the scratch database before it is dropped
  const head = repoHead();
  console.log(`coord-drill-2 run ${runId}, rows ${opts.rows.join(',')}, node ${process.version}, repo HEAD ${head}`);
  try {
    sandbox = makeSandbox(runId);
    RUN_STATE.sandbox = sandbox;
    RUN_STATE.opts = opts;
    let dbError = null;
    if (needDb) {
      try { scratch = makeScratch(); RUN_STATE.scratch = scratch; console.log(`scratch database ${scratch.name} (${maskUrl(scratch.url)})`); } catch (e) { dbError = e; }
    }
    // Test of the signal handler: Windows cannot send a SIGINT that a handler sees, so the test asks the runner to
    // raise it here, at the point where a database and a sandbox exist. main then waits; the handler exits.
    const testSignal = process.env.COORD_DRILL_TEST_SIGNAL;
    if (testSignal === 'SIGINT' || testSignal === 'SIGTERM') {
      process.emit(testSignal, testSignal);
      await new Promise(() => {});
    }
    const url = scratch?.url ?? null;
    const ctx = {
      runId, url, sandbox, opts, tracked,
      env: url ? childEnv(url, sandbox) : null,
      aborted: false, // set by abortDrill when a scenario times out; lane, runNode and pg then throw
      pg: (fn) => {
        if (ctx.aborted) throw new HarnessError('ctx.pg: refused, the drill was aborted after a timeout');
        return withPg(url, fn); // withPg refuses a null or non-scratch url
      },
      log: (line) => console.error(`  [drill] ${line}`),
    };
    RUN_STATE.ctx = ctx;
    for (const id of opts.rows) {
      if (ctx.aborted) { // an earlier scenario timed out and may still be running: no row may run against the shared state
        rows.push(errorRow(id, '(scenario not run)', 'skipped after timeout', 'drill not aborted'));
        continue;
      }
      const noDb = !STATIC_ROWS.includes(id) && !url;
      rows.push(...(noDb ? [errorRow(id, '(scenario not run)', `no scratch database: ${errText(dbError)}`, 'scratch database exists')] : await runScenario(id, ctx)));
      if (ctx.aborted) harnessFailed = true;
    }
    // The same queries as the live check, on the scratch database, while it still exists and holds this run's rows.
    if (scratch && !ctx.aborted) control = await scratchControl(countScratchWith(scratch.url), tracked, sandbox.boardKey, opts.rows);
  } catch (e) {
    harnessFailed = true;
    console.log(`HARNESS ERROR: ${errText(e)}`);
  } finally {
    if (!RUN_STATE.cleaning) {
      RUN_STATE.cleaning = true; // a signal from here on finds the clean-up started and does not run it twice
      RUN_STATE.cleanupPromise = cleanUp(scratch, sandbox, opts); // a signal waits for this promise before it exits
      harnessFailed = (await RUN_STATE.cleanupPromise) || harnessFailed;
    }
  }
  // Both checks run before any ROW line prints. A failed check makes the run invalid: say so first.
  const report = [];
  const say = (line) => report.push(line);
  const live = await liveZeroCheck(runId, tracked, needDb && !!scratch, rows, sandbox?.boardKey, say, needDb, { countLive, control });
  const sandboxProof = sandboxCheck(realBefore, runId, sandbox, tracked, say);
  const invalid = [...(live.checked && !live.ok ? ['live board check failed'] : []), ...(sandboxProof.ok ? [] : ['sandbox check failed'])];
  const valid = invalid.length === 0;
  if (!valid) console.log(`RUN INVALID: ${invalid.join(' and ')}; the rows below are not a result of this drill`);
  report.forEach((line) => console.log(line));
  rows.forEach((r) => printRow(r, expected));
  const code = judge(rows, expected, harnessFailed, live, sandboxProof);
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  console.log(`DRILL: ${rows.length} rows, ${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('ERROR')} ERROR, exit ${code}`);
  if (opts.out) writeSummary(opts.out, { runId, startedAt, node: process.version, repoHead: head, valid, harnessFailed, rows, liveZero: live, sandbox: sandboxProof, exit: code });
  return code;
}

/** Drop the database (unless --keep-db) and remove the sandbox. Returns true when something failed. */
async function cleanUp(scratch, sandbox, opts) {
  let failed = false;
  if (scratch && opts.keepDb) console.log(`KEEP: scratch database ${scratch.name} kept (${maskUrl(scratch.url)})`);
  else if (scratch) {
    try { await dropScratch(scratch); } catch (e) { failed = true; console.log(`HARNESS ERROR: drop failed: ${errText(e)}`); }
  }
  try { sandbox?.cleanup(); } catch (e) { failed = true; console.log(`HARNESS ERROR: sandbox cleanup failed: ${errText(e)}`); }
  return failed;
}

// ---------------------------------------------------------------- Ctrl-C and SIGTERM

// What a signal handler must clean up: set by main as each part comes to exist.
const RUN_STATE = { scratch: null, sandbox: null, opts: null, ctx: null, cleaning: false, cleanupPromise: null };

/**
 * On SIGINT or SIGTERM: stop new children (abortDrill), drop the scratch database, remove the sandbox, exit 130
 * (SIGINT) or 143 (SIGTERM). A child that runs now (spawnSync) gets the console Ctrl-C too; the handler runs when
 * it returns. When main's clean-up has started, the handler only exits. A second signal exits at once.
 */
const onSignal = makeSignalHandler(RUN_STATE, {
  cleanUp, abort: abortDrill, exit: (c) => process.exit(c), log: (l) => console.log(l), once: (s, fn) => process.once(s, fn),
});

// Run only as the entry script: a test can import this file without starting a drill.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => { onSignal(s); });
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.log(`HARNESS ERROR: ${errText(e)}`);
    console.log('DRILL: 0 rows, 0 PASS, 0 FAIL, 0 ERROR, exit 2');
    process.exitCode = 2;
  });
}
