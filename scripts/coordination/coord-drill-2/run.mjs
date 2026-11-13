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
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertScratchUrl, maskUrl } from '../scratch-db.mjs';
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

function parseArgs(argv) {
  const opts = { rows: Object.keys(SCENARIOS), out: null, keepDb: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--keep-db') opts.keepDb = true;
    else if (a === '--rows') opts.rows = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') opts.out = path.resolve(argv[++i] ?? '');
    else throw new HarnessError(`unknown argument '${a}'\n${USAGE}`);
  }
  opts.rows = [...new Set(opts.rows)];
  const bad = opts.rows.filter((r) => !SCENARIOS[r]);
  if (opts.rows.length === 0 || bad.length) throw new HarnessError(`unknown row(s) '${bad.join(',')}'. Rows: ${Object.keys(SCENARIOS).join(', ')}`);
  return opts;
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Hide the password of any url inside a message. */
const maskText = (s) => String(s ?? '').replace(/\b[a-z]+:\/\/\S+/gi, (m) => maskUrl(m));
const errText = (e) => maskText(e?.message ?? e);

// ---------------------------------------------------------------- scratch database

/** The scratch database name a create or drop output names, or ''. A failed create can leave this database behind. */
const namedDb = (r) => (/lanes_pr1_[a-z0-9_]+/.exec(`${r.out}\n${r.err}`) ?? [''])[0];

/** Make the scratch database through scratch-db.mjs (the only creator) and check its name. */
function createScratch() {
  const r = runNode(PATHS.SCRATCH, ['create', '--through', '6'], { env: process.env, harness: true });
  const left = namedDb(r) ? ` (output names database ${namedDb(r)}: it may need a manual drop)` : '';
  if (r.code !== 0) throw new HarnessError(`scratch-db create failed (exit ${r.code}): ${maskText(oneLine(r.err))}${left}`);
  let parsed;
  try { parsed = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch { throw new HarnessError(`scratch-db create printed no {url,name} JSON${left}`); }
  assertScratch(parsed?.url);
  // The name that the drop proof counts must be the name of the url, not a field that could be missing or different.
  const name = assertScratchUrl(parsed.url);
  if (parsed.name !== name) throw new HarnessError(`scratch-db create: name '${parsed.name}' differs from the url's database '${name}'`);
  return { url: parsed.url, name };
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

const errorRow = (id, title, reason, controlName) => result({
  id, title, rule: '', verdict: 'ERROR', reason: oneLine(reason),
  control: { name: controlName, ok: false, detail: oneLine(reason) },
});

/** A row a scenario returns must have an id and a verdict, and a PASS or FAIL needs a working control. Else it is ERROR. */
function normalise(row, id) {
  const known = row && typeof row === 'object' && ['PASS', 'FAIL', 'ERROR'].includes(row.verdict) && row.id !== undefined;
  if (!known) return errorRow(id, '(bad row)', `scenario ${id} returned a row that is not a result() object`, 'row shape');
  if (row.verdict !== 'ERROR' && row.control?.ok !== true) {
    return errorRow(String(row.id), row.title, `row ${row.id} asked for ${row.verdict} without a working control`, 'positive control');
  }
  return { ...row, id: String(row.id) };
}

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

// Each query takes exactly the lists it names (pg rejects a parameter that no placeholder uses). 'board' is the
// sandbox board key: it finds a lane that a child made under an id the drill never tracked.
const LIVE_QUERIES = {
  sessions: { use: ['session'], sql: 'SELECT count(*)::int AS n FROM public.sessions WHERE id = ANY($1::text[])' },
  lane: { use: ['lane'], sql: 'SELECT count(*)::int AS n FROM agentic_os.lane WHERE id = ANY($1::text[])' },
  lane_by_board: { use: ['board'], sql: 'SELECT count(*)::int AS n FROM agentic_os.lane WHERE project_key = ANY($1::text[])' },
  lane_event: {
    use: ['session', 'lane'],
    sql: 'SELECT count(*)::int AS n FROM agentic_os.lane_event WHERE session_id = ANY($1::text[]) OR to_session_id = ANY($1::text[]) OR lane_id = ANY($2::text[])',
  },
  file_claims: {
    use: ['session', 'file'],
    sql: 'SELECT count(*)::int AS n FROM public.file_claims WHERE session_id = ANY($1::text[]) OR file_path = ANY($2::text[])',
  },
};
const MISSING_TABLE = new Set(['42P01', '3F000']); // undefined_table, invalid_schema_name

/**
 * Count the rows of this run on the live server. Read only. A table the live server lacks is a failed check, not a 0:
 * a zero from a server that cannot hold the rows proves nothing.
 */
async function liveCount(tracked, boardKey) {
  const counts = {};
  const lists = { ...tracked, board: [boardKey] };
  await withClient(LIVE_URL, async (c) => {
    await c.query('SET default_transaction_read_only = on');
    for (const [table, { sql, use }] of Object.entries(LIVE_QUERIES)) {
      try {
        counts[table] = (await c.query(sql, use.map((k) => lists[k]))).rows[0].n;
      } catch (e) {
        if (MISSING_TABLE.has(e.code)) throw new HarnessError(`the live server has no table for '${table}' (${e.code}); the zero check cannot run`);
        throw e;
      }
    }
  });
  return { counts };
}

/** say collects the report lines: main prints them before the ROW lines, after RUN INVALID when a check failed. */
async function liveZeroCheck(runId, tracked, ranDb, rows, boardKey, say = console.log, needDb = false) {
  if (!ranDb) {
    if (needDb) { // rows needed a database but the scratch create failed: the rows are ERROR, and this is the reason
      say('LIVE BOARD: not checked: scratch database was not created');
      return { checked: false, ok: true, reason: 'scratch database was not created' };
    }
    say('LIVE BOARD: not checked (only static rows ran, no database was opened)');
    return { checked: false, ok: true, reason: 'static rows only' };
  }
  const ids = { sessions: tracked.session.length, lanes: tracked.lane.length, files: tracked.file.length };
  say(`  note: live check looks for ${ids.sessions} session ids, ${ids.lanes} lane ids, ${ids.files} file paths`);
  // A database row that ran to PASS or FAIL made sessions or lanes. Zero tracked ids then means the check looks for nothing.
  const dbRan = rows.some((r) => !STATIC_ROWS.includes(r.id) && r.verdict !== 'ERROR' && !STATIC_ROWS.includes(r.id.split('-')[0])); // 2-old and 2-cross touch the database too
  if (dbRan && ids.sessions + ids.lanes + ids.files === 0) {
    say(`LIVE BOARD: check FAILED for run ${runId}: database rows ran but no id was tracked, so the check would look for nothing`);
    return { checked: true, ok: false, error: 'no tracked ids', idsChecked: ids };
  }
  try {
    const { counts } = await liveCount(tracked, boardKey);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    say(total === 0
      ? `LIVE BOARD: 0 rows of run ${runId} (checked sessions, lane, lane by board key, lane_event, file_claims)`
      : `LIVE BOARD: ${total} rows of run ${runId} FOUND`);
    return { checked: true, ok: total === 0, total, counts, idsChecked: ids };
  } catch (e) {
    say(`LIVE BOARD: check FAILED for run ${runId}: ${errText(e)}`);
    return { checked: true, ok: false, error: errText(e), idsChecked: ids };
  }
}

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
    if (scan.scanIncomplete) say(`SANDBOX SCAN: INCOMPLETE: ${scan.unreadable} changed real file(s) could not be read, so a write of this run cannot be ruled out`);
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

function printRow(row, expected) {
  const exp = expected[row.id] ?? '(info)';
  console.log(`ROW ${row.id}  ${row.verdict}  expected ${exp}  ${row.title} -- ${oneLine(row.reason)}`);
  const c = row.control ?? {};
  console.log(`  control: ${c.name} ${c.ok === true ? 'ok' : 'BROKEN'} -- ${oneLine(c.detail)}`);
}

/** Exit code from the rows, the harness state and the live check. Prints one DIFFERS line per mismatch. */
function judge(rows, expected, harnessFailed, live, sandbox) {
  const err = harnessFailed || rows.some((r) => r.verdict === 'ERROR') || (live.checked && !live.ok) || !sandbox.ok;
  let differs = false;
  for (const r of rows) {
    if (!(r.id in expected) || r.verdict === 'ERROR' || r.verdict === expected[r.id]) continue;
    console.log(`DIFFERS: row ${r.id} expected ${expected[r.id]} got ${r.verdict}`);
    differs = true;
  }
  return err ? 2 : differs ? 1 : 0;
}

/** The expected verdict of every row. A requested row with no PASS or FAIL entry is a harness fault (exit 2), not a skip. */
function loadExpected(requested) {
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(path.join(PATHS.HERE, 'expected.json'), 'utf8')).rows ?? {};
  } catch (e) {
    throw new HarnessError(`cannot read expected.json: ${e.message}`);
  }
  const missing = requested.filter((r) => !['PASS', 'FAIL'].includes(rows[r]));
  if (missing.length) throw new HarnessError(`expected.json has no PASS or FAIL entry for requested row(s) ${missing.join(',')}`);
  return rows;
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return 0; }
  const startedAt = new Date().toISOString();
  const runId = randomBytes(4).toString('hex');
  const expected = loadExpected(opts.rows);
  const needDb = opts.rows.some((r) => !STATIC_ROWS.includes(r));
  if (needDb) assertLiveUrlIsNotScratch();
  // Taken before any child runs. Read only.
  const realBefore = snapshotRealHome();
  const tracked = { session: [], lane: [], file: [] };
  const rows = [];
  let scratch = null;
  let sandbox = null;
  let harnessFailed = false;
  const head = repoHead();
  console.log(`coord-drill-2 run ${runId}, rows ${opts.rows.join(',')}, node ${process.version}, repo HEAD ${head}`);
  try {
    sandbox = makeSandbox(runId);
    let dbError = null;
    if (needDb) {
      try { scratch = createScratch(); console.log(`scratch database ${scratch.name} (${maskUrl(scratch.url)})`); } catch (e) { dbError = e; }
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
    for (const id of opts.rows) {
      if (ctx.aborted) { // an earlier scenario timed out and may still be running: no row may run against the shared state
        rows.push(errorRow(id, '(scenario not run)', 'skipped after timeout', 'drill not aborted'));
        continue;
      }
      const noDb = !STATIC_ROWS.includes(id) && !url;
      rows.push(...(noDb ? [errorRow(id, '(scenario not run)', `no scratch database: ${errText(dbError)}`, 'scratch database exists')] : await runScenario(id, ctx)));
      if (ctx.aborted) harnessFailed = true;
    }
  } catch (e) {
    harnessFailed = true;
    console.log(`HARNESS ERROR: ${errText(e)}`);
  } finally {
    harnessFailed = (await cleanUp(scratch, sandbox, opts)) || harnessFailed;
  }
  // Both checks run before any ROW line prints. A failed check makes the run invalid: say so first.
  const report = [];
  const say = (line) => report.push(line);
  const live = await liveZeroCheck(runId, tracked, needDb && !!scratch, rows, sandbox?.boardKey, say, needDb);
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

function writeSummary(file, summary) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  console.log(`HARNESS ERROR: ${errText(e)}`);
  console.log('DRILL: 0 rows, 0 PASS, 0 FAIL, 0 ERROR, exit 2');
  process.exitCode = 2;
});
