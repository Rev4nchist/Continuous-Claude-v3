/**
 * coord-drill-2 / judge.mjs -- the importable part of run.mjs: argument parsing and the --out guard, row normalising,
 * the exit code, the live-board zero check with its positive control, the scratch create, report output and the
 * signal handler. run.mjs runs only main(); everything here takes its dependencies as arguments, so a test needs no
 * database and no child process.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { maskUrl, assertScratchUrl } from '../scratch-db.mjs';
import { HarnessError, PATHS, assertScratch, result } from './lib.mjs';

export const STATIC_ROWS = ['8'];

// ---------------------------------------------------------------- text helpers

export const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Hide the password of any url inside a message. */
export const maskText = (s) => String(s ?? '').replace(/\b[a-z]+:\/\/\S+/gi, (m) => maskUrl(m));
export const errText = (e) => maskText(e?.message ?? e);

/** A copy of any value with every string passed through maskText. Walks objects and arrays; never edits serialized JSON. */
export function maskDeep(v) {
  if (typeof v === 'string') return maskText(v);
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]));
  return v;
}

// ---------------------------------------------------------------- args and the --out guard

/** A run id of 6 random bytes: 12 hex characters (48 bits; a collision of two runs is not a concern). */
export const newRunId = () => randomBytes(6).toString('hex');

const realOf = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const isUnder = (p, base) => norm(p) === norm(base) || norm(p).startsWith(norm(base) + path.sep);

/**
 * --out may not already exist and may not sit under the home .claude folder (rules and settings that every session
 * loads: no new file there). The folder of --out need not exist yet: the nearest existing folder above it is resolved
 * through links, so a junction into .claude is caught too. `home` is for a test; it defaults to the real home.
 */
export function guardOut(out, { home = os.homedir() } = {}) {
  if (!out) throw new HarnessError('--out needs a file path');
  const abs = path.resolve(out);
  try { fs.lstatSync(abs); throw new HarnessError(`refusing an --out that already exists: ${abs}`); } catch (e) { if (e instanceof HarnessError) throw e; }
  let anchor = path.dirname(abs);
  while (!fs.existsSync(anchor) && path.dirname(anchor) !== anchor) anchor = path.dirname(anchor);
  const realAnchor = realOf(anchor);
  const candidates = [abs, ...(realAnchor ? [path.join(realAnchor, path.relative(anchor, abs))] : [])];
  const claudeHome = path.join(home, '.claude');
  for (const base of [path.resolve(claudeHome), realOf(claudeHome)].filter(Boolean)) {
    if (candidates.some((c) => isUnder(c, base))) throw new HarnessError('refusing an --out under the home .claude folder');
  }
}

export function parseArgs(argv, scenarios, usage) {
  const opts = { rows: Object.keys(scenarios), out: null, keepDb: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--keep-db') opts.keepDb = true;
    else if (a === '--rows') opts.rows = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new HarnessError(`--out needs a file path\n${usage}`);
      opts.out = path.resolve(v);
    } else throw new HarnessError(`unknown argument '${a}'\n${usage}`);
  }
  opts.rows = [...new Set(opts.rows)];
  const bad = opts.rows.filter((r) => !scenarios[r]);
  if (opts.rows.length === 0 || bad.length) throw new HarnessError(`unknown row(s) '${bad.join(',')}'. Rows: ${Object.keys(scenarios).join(', ')}`);
  if (opts.out && !opts.help) guardOut(opts.out); // at parse time: before any database is made
  return opts;
}

// ---------------------------------------------------------------- rows and exit code

export const errorRow = (id, title, reason, controlName) => result({
  id, title, rule: '', verdict: 'ERROR', reason: oneLine(reason),
  control: { name: controlName, ok: false, detail: oneLine(reason) },
});

/** A row a scenario returns must have an id and a verdict, and a PASS or FAIL needs a working control. Else it is ERROR. */
export function normalise(row, id) {
  const known = row && typeof row === 'object' && ['PASS', 'FAIL', 'ERROR'].includes(row.verdict) && row.id !== undefined;
  if (!known) return errorRow(id, '(bad row)', `scenario ${id} returned a row that is not a result() object`, 'row shape');
  if (row.verdict !== 'ERROR' && row.control?.ok !== true) {
    return errorRow(String(row.id), row.title, `row ${row.id} asked for ${row.verdict} without a working control`, 'positive control');
  }
  return { ...row, id: String(row.id) };
}

/**
 * Exit code from the rows, the harness state and the live check. Prints one DIFFERS line per mismatch.
 * Only a row in expected.json counts toward exit 2 when it is ERROR. An info row (2-old, 2-cross) that is ERROR
 * (a shallow clone has no rev 900124e6) prints a NOTE line: it is not a verdict about a rule.
 */
export function judge(rows, expected, harnessFailed, live, sandbox, log = console.log) {
  const errors = rows.filter((r) => r.verdict === 'ERROR');
  for (const r of errors.filter((e) => !(e.id in expected))) log(`NOTE: info row ${r.id} is ERROR (not in expected.json, so not counted): ${oneLine(r.reason)}`);
  const err = harnessFailed || errors.some((r) => r.id in expected) || (live.checked && !live.ok) || !sandbox.ok;
  let differs = false;
  for (const r of rows) {
    if (!(r.id in expected) || r.verdict === 'ERROR' || r.verdict === expected[r.id]) continue;
    log(`DIFFERS: row ${r.id} expected ${expected[r.id]} got ${r.verdict}`);
    differs = true;
  }
  return err ? 2 : differs ? 1 : 0;
}

/** The expected verdict of every row. A requested row with no PASS or FAIL entry is a harness fault (exit 2), not a skip. */
export function loadExpected(requested, dir = PATHS.HERE) {
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')).rows ?? {};
  } catch (e) {
    throw new HarnessError(`cannot read expected.json: ${e.message}`);
  }
  const missing = requested.filter((r) => !['PASS', 'FAIL'].includes(rows[r]));
  if (missing.length) throw new HarnessError(`expected.json has no PASS or FAIL entry for requested row(s) ${missing.join(',')}`);
  return rows;
}

// ---------------------------------------------------------------- scratch create

/** The first scratch database name a create output names, or ''. A failed or timed-out create can leave this database behind. */
export const namedDb = (r) => (/lanes_pr1_[a-z0-9_]+/.exec(`${r.out}\n${r.err}`) ?? [''])[0];

/**
 * After a failed create: drop the database the output names (dropByName goes through scratch-db.mjs drop). With no name
 * in the output, say a database may be left. Never prints a url.
 */
function dropLeftover(r, dropByName, log) {
  const name = namedDb(r);
  if (!name) { log('scratch create failed and printed no database name: a database may be left behind (name unknown)'); return; }
  try {
    dropByName(name);
    log(`scratch create failed: dropped the leftover database ${name}`);
  } catch (e) {
    log(`scratch create failed and the drop of ${name} failed (${errText(e)}): database ${name} may still exist, drop it by hand`);
  }
}

/** Make the scratch database (run() is the one creator: scratch-db.mjs create) and check its name. A failure drops what it left. */
export function createScratch({ run, dropByName, log = console.log }) {
  let r;
  try {
    r = run();
  } catch (e) { // a timeout: runNode puts the output so far on the error
    dropLeftover({ out: e?.out ?? '', err: e?.err ?? '' }, dropByName, log);
    throw e;
  }
  try {
    const left = namedDb(r) ? ` (output names database ${namedDb(r)})` : '';
    if (r.code !== 0) throw new HarnessError(`scratch-db create failed (exit ${r.code}): ${maskText(oneLine(r.err))}${left}`);
    let parsed;
    try { parsed = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch { throw new HarnessError(`scratch-db create printed no {url,name} JSON${left}`); }
    assertScratch(parsed?.url);
    // The name that the drop proof counts must be the name of the url, not a field that could be missing or different.
    const name = assertScratchUrl(parsed.url);
    if (parsed.name !== name) throw new HarnessError(`scratch-db create: name '${parsed.name}' differs from the url's database '${name}'`);
    return { url: parsed.url, name };
  } catch (e) {
    dropLeftover(r, dropByName, log);
    throw e;
  }
}

// ---------------------------------------------------------------- live zero check (seat condition C3) and its positive control

// Each check takes exactly the lists it names (pg rejects a parameter that no placeholder uses). 'rows' are the scenario
// rows that fill the table: a partial run (--rows 5) checks only the tables its rows fill, so a table that must hold 0
// rows on scratch is never required to hold more. 'board' is the sandbox board key: it finds a lane that a child made
// under an id the drill never tracked. 'claimProject' and 'claimFile' are the file_claims rows as the hook stores them:
// a file in a repo is stored as the repo-relative key (src/x.ts) with the repo's project, so the pair is matched, not the
// bare key, which could be the claim of another session in another repo.
export const CHECKS = {
  sessions: { rows: ['2', '3', '5', '7'], use: ['session'], sql: 'SELECT count(*)::int AS n FROM public.sessions WHERE id = ANY($1::text[])' },
  lane: { rows: ['5', '7'], use: ['lane'], sql: 'SELECT count(*)::int AS n FROM agentic_os.lane WHERE id = ANY($1::text[])' },
  lane_by_board: { rows: ['5', '7'], use: ['board'], sql: 'SELECT count(*)::int AS n FROM agentic_os.lane WHERE project_key = ANY($1::text[])' },
  lane_event: {
    rows: ['7'],
    use: ['session', 'lane'],
    sql: 'SELECT count(*)::int AS n FROM agentic_os.lane_event WHERE session_id = ANY($1::text[]) OR to_session_id = ANY($1::text[]) OR lane_id = ANY($2::text[])',
  },
  file_claims_by_session: {
    rows: ['2', '3'],
    use: ['session'],
    sql: 'SELECT count(*)::int AS n FROM public.file_claims WHERE session_id = ANY($1::text[])',
  },
  file_claims_by_path: {
    rows: ['2', '3'],
    use: ['file', 'claimProject', 'claimFile'],
    sql: 'SELECT count(*)::int AS n FROM public.file_claims fc WHERE fc.file_path = ANY($1::text[]) '
      + 'OR EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS u(p, f) WHERE u.p = fc.project AND u.f = fc.file_path)',
  },
};
const MISSING_TABLE = new Set(['42P01', '3F000']); // undefined_table, invalid_schema_name

/** The checks that the requested rows can fill: the ones the control and the live count both run. */
export const checksFor = (requestedRows) => Object.entries(CHECKS).filter(([, c]) => c.rows.some((r) => requestedRows.includes(r))).map(([n]) => n);

/**
 * Run the named checks on a connected client. One function for scratch and for live: same sql, same parameters.
 * A table the server lacks is a failed check, not a 0.
 */
export async function countChecks(c, tracked, boardKey, names) {
  const claims = tracked.claim ?? [];
  const lists = { ...tracked, board: [boardKey], claimProject: claims.map((x) => x.project), claimFile: claims.map((x) => x.file) };
  const counts = {};
  for (const name of names) {
    const { sql, use } = CHECKS[name];
    try {
      counts[name] = (await c.query(sql, use.map((k) => lists[k] ?? []))).rows[0].n;
    } catch (e) {
      if (MISSING_TABLE.has(e.code)) throw new HarnessError(`the server has no table for '${name}' (${e.code}); the zero check cannot run`);
      throw e;
    }
  }
  return counts;
}

/** The positive control: every checked table must hold at least one row of this run on the scratch database. */
export function controlOf(counts) {
  const names = Object.keys(counts);
  const zero = names.filter((n) => !(counts[n] > 0));
  return { ok: names.length > 0 && zero.length === 0, zero, counts };
}

/**
 * Run the same checks on the SCRATCH database, before it is dropped. countScratch(tracked, boardKey, names) returns the
 * counts. If a query cannot see this run's rows there, a live "0 rows" means nothing: the control fails. An error fails it.
 */
export async function scratchControl(countScratch, tracked, boardKey, requestedRows) {
  const names = checksFor(requestedRows);
  try {
    return { ...controlOf(await countScratch(tracked, boardKey, names)), names };
  } catch (e) {
    return { ok: false, error: errText(e), names, zero: [], counts: {} };
  }
}

/** say collects the report lines: main prints them before the ROW lines, after RUN INVALID when a check failed. */
export async function liveZeroCheck(runId, tracked, ranDb, rows, boardKey, say, needDb, { countLive, control }) {
  if (!ranDb) {
    if (needDb) { // rows needed a database but the scratch create failed: the rows are ERROR, and this is the reason
      say('LIVE BOARD: not checked: scratch database was not created');
      return { checked: false, ok: true, reason: 'scratch database was not created' };
    }
    say('LIVE BOARD: not checked (only static rows ran, no database was opened)');
    return { checked: false, ok: true, reason: 'static rows only' };
  }
  const ids = { sessions: tracked.session.length, lanes: tracked.lane.length, files: tracked.file.length, claims: (tracked.claim ?? []).length };
  say(`  note: live check looks for ${ids.sessions} session ids, ${ids.lanes} lane ids, ${ids.files} file paths, ${ids.claims} file claims (project and repo-relative key)`);
  // A database row that ran to PASS or FAIL made sessions or lanes. Zero tracked ids then means the check looks for nothing.
  const dbRan = rows.some((r) => !STATIC_ROWS.includes(r.id) && r.verdict !== 'ERROR' && !STATIC_ROWS.includes(r.id.split('-')[0])); // 2-old and 2-cross touch the database too
  if (dbRan && ids.sessions + ids.lanes + ids.files + ids.claims === 0) {
    say(`LIVE BOARD: check FAILED for run ${runId}: database rows ran but no id was tracked, so the check would look for nothing`);
    return { checked: true, ok: false, error: 'no tracked ids', idsChecked: ids };
  }
  if (!control || !control.ok) {
    const why = !control ? 'there is no positive control from the scratch database'
      : control.error ? `the positive control on the scratch database failed: ${control.error}`
        : `the positive control found no row of this run on the scratch database in: ${control.zero.join(', ')}`;
    say(`LIVE BOARD: check FAILED for run ${runId}: ${why}, so a live 0 would prove nothing`);
    return { checked: true, ok: false, error: `positive control: ${why}`, idsChecked: ids, control };
  }
  const shown = Object.entries(control.counts).map(([n, v]) => `${n} ${v}`).join(', ');
  say(`LIVE BOARD CONTROL: the same queries on the scratch database found rows of this run in every checked table (${shown})`);
  try {
    const counts = await countLive(tracked, boardKey, control.names);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const checked = control.names.join(', ');
    say(total === 0
      ? `LIVE BOARD: 0 rows of run ${runId} (checked ${checked})`
      : `LIVE BOARD: ${total} rows of run ${runId} FOUND (${Object.entries(counts).filter(([, v]) => v > 0).map(([n, v]) => `${n} ${v}`).join(', ')})`);
    return { checked: true, ok: total === 0, total, counts, idsChecked: ids, control: { counts: control.counts, names: control.names } };
  } catch (e) {
    say(`LIVE BOARD: check FAILED for run ${runId}: ${errText(e)}`);
    return { checked: true, ok: false, error: errText(e), idsChecked: ids, control: { counts: control.counts, names: control.names } };
  }
}

// ---------------------------------------------------------------- report

/** One ROW line and its control line. Reason, title and control text can hold a child's output, so they are masked. */
export function printRow(row, expected, log = console.log) {
  const exp = expected[row.id] ?? '(info)';
  log(maskText(`ROW ${row.id}  ${row.verdict}  expected ${exp}  ${row.title} -- ${oneLine(row.reason)}`));
  const c = row.control ?? {};
  log(maskText(`  control: ${c.name} ${c.ok === true ? 'ok' : 'BROKEN'} -- ${oneLine(c.detail)}`));
}

/** Write the JSON summary with every string masked (the child output in evidence too). It never overwrites a file. */
export function writeSummary(file, summary) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(maskDeep(summary), null, 2)}\n`, { flag: 'wx' });
}

// ---------------------------------------------------------------- signals

/**
 * The handler for SIGINT and SIGTERM. state: { cleaning, cleanupPromise, ctx, scratch, sandbox, opts }.
 * deps: { cleanUp(scratch, sandbox, opts), abort(ctx, why), exit(code), log(line), once(signal, fn) }.
 * A signal that arrives while main's clean-up runs waits for that clean-up (state.cleanupPromise) before it exits:
 * an exit now would leave the scratch database that the clean-up was dropping.
 */
export function makeSignalHandler(state, deps) {
  return async function onSignal(signal) {
    const code = signal === 'SIGINT' ? 130 : 143;
    if (state.cleaning) {
      deps.log(`INTERRUPTED (${signal}): clean-up already running; waiting for it, then exit ${code}`);
      try { await state.cleanupPromise; } catch { /* the clean-up reports its own failure */ }
      deps.exit(code);
      return;
    }
    state.cleaning = true;
    deps.once(signal, () => deps.exit(code)); // a second signal exits at once
    deps.abort(state.ctx, `interrupted by ${signal}`);
    deps.log(`INTERRUPTED (${signal}): dropping the scratch database and removing the sandbox`);
    state.cleanupPromise = deps.cleanUp(state.scratch, state.sandbox, state.opts ?? { keepDb: false });
    const failed = await state.cleanupPromise;
    deps.log(`INTERRUPTED: clean-up ${failed ? 'FAILED (see HARNESS ERROR above)' : 'done'}; no verdict; exit ${code}`);
    deps.exit(code);
  };
}
