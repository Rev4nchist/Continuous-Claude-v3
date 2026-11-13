/**
 * coord-drill-2 / judge.test.mjs -- the exit code, the live-board zero check, the scratch create, the report text,
 * the --out guard and the signal handler of run.mjs (they live in judge.mjs so that a test can import them).
 *
 *   node --test scripts/coordination/coord-drill-2/judge.test.mjs
 *
 * Nothing here opens a pg client or runs scratch-db.mjs: the counts, the runner and the drop are injected fakes.
 * Each test imports judge.mjs on its own, so one missing export fails one test.
 * Failure modes, one test each (names say which):
 *   exit codes   judge returns 0, 1 or 2 wrongly; an ERROR in an info row (2-old, 2-cross) forces exit 2 (F5);
 *                loadExpected accepts a missing entry; run.mjs exit codes end to end (--help, --rows, row 8).
 *   F1           the live check passes with no positive control; a table with 0 scratch rows is accepted; the claim
 *                query cannot match a repo-relative key as the hook stores it; a partial run needs a table it cannot fill.
 *   F8           a failed or timed-out scratch create leaves a database that is not dropped, or drops a non-scratch name.
 *   F7           a password in a reason, a control detail or the evidence reaches the console or the --out file.
 *   item 12      --out with no value, an existing file, a path under the real .claude folder.
 *   F4/F6        a signal during clean-up exits before the clean-up ends.
 *   F9           a run id shorter than 12 hex characters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const J = () => import('./judge.mjs');
const row = (id, verdict, extra = {}) => ({ id, verdict, title: `t${id}`, reason: 'r', control: { name: 'c', ok: true, detail: 'd' }, ...extra });
const GOOD_SANDBOX = { ok: true };
const NO_LIVE = { checked: true, ok: true };
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-drill-2-judgetest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---------------------------------------------------------------- exit codes

test('judge: every row equals expected -> exit 0', async () => {
  const { judge } = await J();
  const lines = [];
  assert.equal(judge([row('2', 'PASS'), row('3', 'FAIL')], { 2: 'PASS', 3: 'FAIL' }, false, NO_LIVE, GOOD_SANDBOX, (l) => lines.push(l)), 0);
  assert.deepEqual(lines, []);
});

test('judge: a row that differs from expected -> exit 1 with a DIFFERS line', async () => {
  const { judge } = await J();
  const lines = [];
  assert.equal(judge([row('3', 'PASS')], { 3: 'FAIL' }, false, NO_LIVE, GOOD_SANDBOX, (l) => lines.push(l)), 1);
  assert.match(lines.join('\n'), /DIFFERS: row 3 expected FAIL got PASS/);
});

test('judge: an ERROR in an expected row, a failed harness, a bad live check or a bad sandbox -> exit 2', async () => {
  const { judge } = await J();
  const quiet = () => {};
  assert.equal(judge([row('3', 'ERROR')], { 3: 'FAIL' }, false, NO_LIVE, GOOD_SANDBOX, quiet), 2);
  assert.equal(judge([row('3', 'FAIL')], { 3: 'FAIL' }, true, NO_LIVE, GOOD_SANDBOX, quiet), 2);
  assert.equal(judge([row('3', 'FAIL')], { 3: 'FAIL' }, false, { checked: true, ok: false }, GOOD_SANDBOX, quiet), 2);
  assert.equal(judge([row('3', 'FAIL')], { 3: 'FAIL' }, false, NO_LIVE, { ok: false }, quiet), 2);
});

test('judge: an ERROR in an info row (not in expected.json) is a NOTE, not exit 2 (F5)', async () => {
  const { judge } = await J();
  const lines = [];
  const rows = [row('2', 'PASS'), row('2-old', 'ERROR', { reason: 'rev 900124e6 is not in a shallow clone' })];
  assert.equal(judge(rows, { 2: 'PASS' }, false, NO_LIVE, GOOD_SANDBOX, (l) => lines.push(l)), 0);
  assert.match(lines.join('\n'), /NOTE: info row 2-old is ERROR/);
  // The same info ERROR does not hide a real difference in a counted row.
  assert.equal(judge([row('3', 'PASS'), row('2-old', 'ERROR')], { 3: 'FAIL' }, false, NO_LIVE, GOOD_SANDBOX, () => {}), 1);
});

test('loadExpected: reads the verdicts; a missing entry, a non PASS/FAIL entry and a bad file are a HarnessError', async (t) => {
  const { loadExpected } = await J();
  const { HarnessError } = await import('./lib.mjs');
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify({ rows: { 2: 'PASS', 3: 'FAIL', 9: 'ERROR' } }));
  assert.deepEqual(loadExpected(['2', '3'], dir), { 2: 'PASS', 3: 'FAIL', 9: 'ERROR' });
  assert.throws(() => loadExpected(['5'], dir), HarnessError);
  assert.throws(() => loadExpected(['9'], dir), HarnessError);
  fs.writeFileSync(path.join(dir, 'expected.json'), '{not json');
  assert.throws(() => loadExpected(['2'], dir), HarnessError);
});

test('normalise: a PASS or FAIL without a working control, or a non-row, becomes ERROR', async () => {
  const { normalise } = await J();
  assert.equal(normalise(row('3', 'FAIL', { control: { name: 'c', ok: false } }), '3').verdict, 'ERROR');
  assert.equal(normalise(null, '3').verdict, 'ERROR');
  assert.equal(normalise({ id: 3, verdict: 'MAYBE' }, '3').verdict, 'ERROR');
  assert.equal(normalise(row(3, 'PASS'), '3').id, '3');
});

// run.mjs end to end: exit 0 and exit 2 without any database (row 8 is static; a bad row fails at once).
function runDrill(args) {
  const env = { ...process.env };
  for (const k of ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL']) delete env[k];
  return spawnSync(process.execPath, [path.join(HERE, 'run.mjs'), ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
}

test('run.mjs --help exits 0; an unknown row exits 2 with a DRILL line', () => {
  const help = runDrill(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: node run\.mjs/);
  const bad = runDrill(['--rows', '99']);
  assert.equal(bad.status, 2, bad.stdout);
  assert.match(bad.stdout, /DRILL: 0 rows, 0 PASS, 0 FAIL, 0 ERROR, exit 2/);
});

test('run.mjs --rows 8 (static, no database) ends exit 0 when row 8 equals expected.json', () => {
  const r = runDrill(['--rows', '8']);
  assert.match(r.stdout, /DRILL: 1 rows, \d PASS, \d FAIL, 0 ERROR, exit 0/, r.stdout);
  assert.equal(r.status, 0);
});

// ---------------------------------------------------------------- F1: the live check and its positive control

const TRACKED = { session: ['drill-s1'], lane: ['zz-d5-x'], file: ['C:/tmp/s3/src/f.ts'], claim: [{ project: 'proj-a', file: 'src/x.ts' }] };

/** A fake pg client: records each query and answers with counts[sqlName] by matching the table in the sql text. */
function fakeClient(answer) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ n: answer(sql, params) }] }; } };
}

test('checksFor: a partial run checks only the tables its rows fill (rule for partial runs)', async () => {
  const { checksFor } = await J();
  const only5 = checksFor(['5']);
  assert.ok(only5.includes('lane') && only5.includes('sessions'));
  assert.ok(!only5.includes('file_claims_by_path') && !only5.includes('lane_event'), `row 5 fills no file claim or event: ${only5}`);
  const only2 = checksFor(['2']);
  assert.ok(only2.includes('file_claims_by_path') && only2.includes('file_claims_by_session'));
  assert.ok(!only2.includes('lane'));
  assert.deepEqual(checksFor(['8']), []);
});

test('countChecks: the repo-relative claim key and its project reach the file-path query as the hook stores them', async () => {
  const { countChecks } = await J();
  const client = fakeClient(() => 1);
  const counts = await countChecks(client, TRACKED, 'zz-drill-board', ['file_claims_by_path']);
  assert.deepEqual(Object.keys(counts), ['file_claims_by_path']);
  const params = client.calls.flatMap((c) => c.params).flat();
  assert.ok(params.includes('src/x.ts'), 'the relative key is not a parameter');
  assert.ok(params.includes('proj-a'), 'the project of the claim is not a parameter: a bare src/x.ts could match another repo');
  assert.ok(params.includes('C:/tmp/s3/src/f.ts'), 'the absolute path of a claim outside a repo is not a parameter');
});

test('controlOf: a checked table with 0 rows on the scratch database fails the control and is named', async () => {
  const { controlOf } = await J();
  assert.deepEqual(controlOf({ sessions: 4, file_claims_by_path: 0 }), { ok: false, zero: ['file_claims_by_path'], counts: { sessions: 4, file_claims_by_path: 0 } });
  assert.equal(controlOf({ sessions: 4, lane: 2 }).ok, true);
  assert.equal(controlOf({}).ok, false, 'an empty list of checks proves nothing');
});

test('scratchControl: the same counter runs on the scratch database; a thrown error is a failed control, not a pass', async () => {
  const { scratchControl } = await J();
  const seen = [];
  const ok = await scratchControl(async (tracked, board, names) => { seen.push(names); return Object.fromEntries(names.map((n) => [n, 3])); }, TRACKED, 'b', ['2']);
  assert.equal(ok.ok, true);
  assert.deepEqual(seen[0], ok.names);
  const bad = await scratchControl(async () => { throw new Error('boom'); }, TRACKED, 'b', ['2']);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /boom/);
});

const RAN = [row('5', 'FAIL')];
const GOOD_CONTROL = { ok: true, names: ['sessions', 'lane'], counts: { sessions: 4, lane: 2 }, zero: [] };

test('liveZeroCheck: no positive control from the scratch database -> the check FAILS, even when live shows 0', async () => {
  const { liveZeroCheck } = await J();
  const lines = [];
  const live = await liveZeroCheck('run1', TRACKED, true, RAN, 'b', (l) => lines.push(l), true, { countLive: async () => ({ sessions: 0 }) });
  assert.equal(live.ok, false);
  assert.match(lines.join('\n'), /LIVE BOARD: check FAILED.*positive control/);
});

test('liveZeroCheck: a control with a 0 table fails the check and names the table', async () => {
  const { liveZeroCheck } = await J();
  const lines = [];
  const control = { ok: false, names: ['sessions', 'lane'], counts: { sessions: 4, lane: 0 }, zero: ['lane'] };
  const live = await liveZeroCheck('run1', TRACKED, true, RAN, 'b', (l) => lines.push(l), true, { countLive: async () => ({ lane: 0 }), control });
  assert.equal(live.ok, false);
  assert.match(lines.join('\n'), /lane/);
});

test('liveZeroCheck: control ok and 0 live rows -> ok, with a control line before the live line; live rows -> not ok', async () => {
  const { liveZeroCheck } = await J();
  const lines = [];
  const asked = [];
  const countLive = async (tracked, board, names) => { asked.push(names); return { sessions: 0, lane: 0 }; };
  const live = await liveZeroCheck('run1', TRACKED, true, RAN, 'b', (l) => lines.push(l), true, { countLive, control: GOOD_CONTROL });
  assert.equal(live.ok, true);
  assert.deepEqual(asked[0], ['sessions', 'lane'], 'live must count the same tables as the control');
  const text = lines.join('\n');
  assert.match(text, /LIVE BOARD CONTROL: .*sessions 4.*lane 2/);
  assert.match(text, /LIVE BOARD: 0 rows of run run1/);
  assert.ok(text.indexOf('LIVE BOARD CONTROL') < text.indexOf('LIVE BOARD: 0 rows'));
  const hit = await liveZeroCheck('run1', TRACKED, true, RAN, 'b', () => {}, true, { countLive: async () => ({ sessions: 1, lane: 0 }), control: GOOD_CONTROL });
  assert.equal(hit.ok, false);
});

// ---------------------------------------------------------------- F8: the scratch create

const NAMED = 'creating scratch database lanes_pr1_abcd1234 on localhost:5432\n';
const GOOD_URL = 'postgresql://u:p@localhost:5432/lanes_pr1_abcd1234';

function harness() {
  const dropped = [];
  const logs = [];
  return { dropped, logs, dropByName: (n) => { dropped.push(n); }, log: (l) => logs.push(l) };
}

test('createScratch: success returns {url,name} and drops nothing', async () => {
  const { createScratch } = await J();
  const h = harness();
  const got = createScratch({ run: () => ({ code: 0, out: JSON.stringify({ url: GOOD_URL, name: 'lanes_pr1_abcd1234' }), err: NAMED }), ...h });
  assert.deepEqual(got, { url: GOOD_URL, name: 'lanes_pr1_abcd1234' });
  assert.deepEqual(h.dropped, []);
});

test('createScratch: each failure after the name was printed drops that database before it throws', async () => {
  const { createScratch } = await J();
  const { HarnessError } = await import('./lib.mjs');
  const cases = {
    'exit 1': { code: 1, out: '', err: `${NAMED}boom` },
    'exit 0, no JSON': { code: 0, out: 'not json', err: NAMED },
    'exit 0, url is not a scratch database': { code: 0, out: JSON.stringify({ url: 'postgresql://u:p@localhost:5432/continuous_claude', name: 'continuous_claude' }), err: NAMED },
    'exit 0, name differs from the url': { code: 0, out: JSON.stringify({ url: GOOD_URL, name: 'lanes_pr1_other' }), err: NAMED },
  };
  for (const [label, r] of Object.entries(cases)) {
    const h = harness();
    assert.throws(() => createScratch({ run: () => r, ...h }), HarnessError, label);
    assert.deepEqual(h.dropped, ['lanes_pr1_abcd1234'], `${label}: the named database was not dropped`);
  }
});

test('createScratch: a timeout that carries the output drops the database it named', async () => {
  const { createScratch } = await J();
  const { HarnessError } = await import('./lib.mjs');
  const h = harness();
  const timeout = () => { const e = new HarnessError('scratch-db.mjs timed out'); e.out = ''; e.err = NAMED; throw e; };
  assert.throws(() => createScratch({ run: timeout, ...h }), /timed out/);
  assert.deepEqual(h.dropped, ['lanes_pr1_abcd1234']);
});

test('createScratch: no name anywhere -> nothing dropped, a "may be left" line, and no url in the log', async () => {
  const { createScratch } = await J();
  const h = harness();
  assert.throws(() => createScratch({ run: () => ({ code: 1, out: '', err: 'connection refused' }), ...h }));
  assert.deepEqual(h.dropped, []);
  assert.match(h.logs.join('\n'), /may be left/);
  assert.ok(!/postgres(ql)?:\/\//.test(h.logs.join('\n')));
});

test('createScratch: a failed drop still throws the create error and says which database may be left', async () => {
  const { createScratch } = await J();
  const logs = [];
  assert.throws(() => createScratch({ run: () => ({ code: 1, out: '', err: `${NAMED}boom` }), dropByName: () => { throw new Error('no server'); }, log: (l) => logs.push(l) }), /scratch-db create failed/);
  assert.match(logs.join('\n'), /lanes_pr1_abcd1234.*may (?:still )?exist|may be left.*lanes_pr1_abcd1234/);
});

// ---------------------------------------------------------------- F7: masking

const PW = 'Sup3rSecretPw';
const DB = `postgresql://u:${PW}@db.example:5432/x`;

test('printRow: a password in the reason or the control detail is masked', async () => {
  const { printRow } = await J();
  const lines = [];
  printRow(row('3', 'ERROR', { reason: `could not reach ${DB}`, control: { name: 'c', ok: false, detail: `bad ${DB}` } }), { 3: 'FAIL' }, (l) => lines.push(l));
  assert.ok(lines.length === 2);
  assert.ok(!lines.join('\n').includes(PW), lines.join('\n'));
});

test('writeSummary: a password anywhere in the rows (reason, evidence at any depth, control) is masked in the file', async (t) => {
  const { writeSummary } = await J();
  const file = path.join(tmp(t), 'out.json');
  const r = row('3', 'ERROR', {
    reason: `x ${DB}`,
    evidence: { stdout: `connect ${DB}`, nested: { list: [`a ${DB}`, { deep: DB }] } },
    control: { name: 'c', ok: false, detail: DB },
  });
  writeSummary(file, { rows: [r], liveZero: { error: DB } });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(PW), 'the password reached the --out file');
  assert.ok(JSON.parse(text).rows[0].evidence.nested.list.length === 2, 'the file must stay valid JSON with the same shape');
});

test('writeSummary: refuses to overwrite an existing file', async (t) => {
  const { writeSummary } = await J();
  const file = path.join(tmp(t), 'out.json');
  fs.writeFileSync(file, 'keep');
  assert.throws(() => writeSummary(file, { rows: [] }));
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
});

// ---------------------------------------------------------------- item 12: --out guard

test('parseArgs: --out with no value is an error (path.resolve of "" is the current folder)', async () => {
  const { parseArgs } = await J();
  const { HarnessError } = await import('./lib.mjs');
  assert.throws(() => parseArgs(['--out'], { 8: 's8' }, 'usage'), HarnessError);
  assert.throws(() => parseArgs(['--out', '--keep-db'], { 8: 's8' }, 'usage'), HarnessError);
});

test('guardOut: refuses an existing file and anything under the home .claude folder; accepts a new file', async (t) => {
  const { guardOut } = await J();
  const { HarnessError } = await import('./lib.mjs');
  const dir = tmp(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
  const existing = path.join(dir, 'there.json');
  fs.writeFileSync(existing, '{}');
  assert.throws(() => guardOut(existing, { home }), HarnessError);
  assert.throws(() => guardOut(path.join(home, '.claude', 'out.json'), { home }), HarnessError);
  assert.throws(() => guardOut(path.join(home, '.claude', 'not', 'yet', 'out.json'), { home }), HarnessError, 'a folder that does not exist yet under .claude');
  assert.doesNotThrow(() => guardOut(path.join(dir, 'new.json'), { home }));
  assert.doesNotThrow(() => guardOut(path.join(dir, 'newfolder', 'new.json'), { home }));
});

test('run.mjs: --out with no value, and --out naming an existing file, exit 2 before any database is made', (t) => {
  const dir = tmp(t);
  const existing = path.join(dir, 'there.json');
  fs.writeFileSync(existing, 'keep');
  const none = runDrill(['--rows', '8', '--out']);
  assert.equal(none.status, 2, none.stdout);
  assert.doesNotMatch(none.stdout, /scratch database lanes_pr1_/);
  const old = runDrill(['--rows', '8', '--out', existing]);
  assert.equal(old.status, 2, old.stdout);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep');
});

// ---------------------------------------------------------------- F4 / F6: signals

function signalDeps(exits, logs, extra = {}) {
  return { cleanUp: async () => false, abort() {}, exit: (c) => exits.push(c), log: (l) => logs.push(l), once() {}, ...extra };
}

test('signal handler: a signal during main clean-up waits for that clean-up, then exits', async () => {
  const { makeSignalHandler } = await J();
  let release;
  const pending = new Promise((r) => { release = r; });
  const state = { cleaning: true, cleanupPromise: pending };
  const exits = [];
  const done = makeSignalHandler(state, signalDeps(exits, []))('SIGINT');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(exits, [], 'the handler exited while the clean-up was still running');
  release(false);
  await done;
  assert.deepEqual(exits, [130]);
});

test('signal handler: with no clean-up started it runs one clean-up, aborts new children, exits 143 on SIGTERM', async () => {
  const { makeSignalHandler } = await J();
  const exits = [];
  const calls = [];
  const state = { cleaning: false, ctx: { aborted: false }, scratch: { name: 's' }, sandbox: {}, opts: { keepDb: false } };
  await makeSignalHandler(state, signalDeps(exits, [], { cleanUp: async (s) => { calls.push(s.name); return false; }, abort: (c, why) => calls.push(why) }))('SIGTERM');
  assert.deepEqual(calls, ['interrupted by SIGTERM', 's']);
  assert.deepEqual(exits, [143]);
  assert.equal(state.cleaning, true);
});

// ---------------------------------------------------------------- F9

test('newRunId: 12 hex characters or more', async () => {
  const { newRunId } = await J();
  assert.match(newRunId(), /^[0-9a-f]{12,}$/);
});
