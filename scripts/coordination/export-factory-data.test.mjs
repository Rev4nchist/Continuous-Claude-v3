/**
 * export-factory-data.test -- the reader, the CLI and the write of factory.json. Temp files only: no real log, no real
 * state folder, no database, no clock (the run's "now" is injected).
 *
 *   node --test scripts/coordination/export-factory-data.test.mjs
 *
 * The pure rows are in factory-rows.test.mjs. Design: .claudedocs/2026-11-09-factory-json-design.md section 8
 * (the numbers below are the design's test numbers).
 *
 * Ways the reader and the CLI can fail (one test each, every test names the change that breaks it):
 *   27  a bad line throws, garbage becomes rows, or a missing / empty / corrupt file is mistaken for a quiet one
 *   28  a future row, a row with no status, or a row with no run_id reaches the grid
 *   29  the 64 MB cap is checked after the read
 *   29b a reader error reaches a row, or is lost
 *   30  line order or CRLF changes the result
 *   31  the handoffs reader reads the body, a # line, a second key, or counts a file with no second ---
 *   31b the default --handoffs is under the script's own checkout (a worktree run would show a false dark family)
 *   31c the default --router-config is the script's own folder, or a missing file throws
 *   32  a reader passes the raw row through
 *   33  a path, branch, head, session id, prompt, finding or handoff body line reaches the file (end to end)
 *   34  the write is not temp then rename, the lock is not taken or not released, the old file is lost, a neighbour file changes
 *   35  one dark family stops the run
 *   36  the envelope has the wrong shape or goes over 256 KB
 *   CLI an unknown flag runs, or --dash-config is ignored
 *
 * Phase B2 (PR counts per Chicago day), design .claudedocs/2026-11-09-factory-json-b2-design.md section 8. Fake runners only:
 * no real git, no real gh, no network.
 *   R45  a squash is missed, a `|` subject is split, a chore counts, a duplicate doubles, a CR defeats the anchor     (F5, F6, F25, M9)
 *   R45b the commit time goes through the local zone                                                                  (F11, M11)
 *   R45c pre-grid lines are filtered, or skipped lines count as lines                                                 (F7, F7b, M14)
 *   R46  a git failure is exit 1, or a null status passes as success                                                  (F4)
 *   R47  paging never stops, a boundary duplicate doubles, the grid-start stop is missing                             (F8, F9)
 *   R48  a gh failure is a zero, exit 1, or its stdout or stderr tail is logged                                       (F1, F14, M8)
 *   R48b the per-call timeout is a constant, or the budget is dropped                                                 (F2, M15)
 *   R48c the fallback gh path is missing                                                                              (F3)
 *   R48d a partial page set is kept                                                                                   (F9b, M13)
 *   R50  the pager is not a GET or loses the jq cut                                                                   (F18)
 *   R51  HEAD replaces main, --since is a bare day                                                                    (F10, F20, M10)
 *   R52  the search bound is UTC midnight, or loses its upper bound, base:main or its guard; a trusted 0 is refused, or an untrusted bound is called     (F23, F24, F26, F28, M16, M20)
 *   R48e an empty --repo garbles the stderr line                                                                      (N1)
 *   R51b git log loses --no-show-signature                                                                            (N3)
 *   R53  a reader writes its budget into the caller deps; R53b a caller budget is replaced                            (N2)
 *   38b  a USAGE option column is out of line                                                                         (N5)
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  defaultPaths, main, MAX_BYTES, readDashTargets, readHandoffs, readJsonlFamily, readRouterCap, writeFactory,
} from './export-factory-data.mjs';
// A namespace import: a named import of a missing reader is a SyntaxError that hides every other test in the file.
import * as EX from './export-factory-data.mjs';
import { buildFactoryRows } from './factory-rows.mjs';

const NOW = '2026-11-08T20:00:00.000Z';
const tmp = () => mkdtempSync(path.join(tmpdir(), 'factory-test-'));
const put = (dir, name, text) => { const f = path.join(dir, name); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); return f; };
const jsonl = (rows, eol = '\n') => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join(eol) + eol;
const quiet = () => ({ err: () => {}, log: () => {} });

const HEX40 = '0123456789abcdef0123456789abcdef01234567';
const good = (i, extra = {}) => ({ ts: `2026-11-08T1${i}:00:00.000Z`, run_id: `run-${i}`, head: HEX40, status: 'PASS', step: 'x', ...extra });
const read = (file, family, deps = {}) => readJsonlFamily(file, family, NOW, { ...quiet(), ...deps });

// ---------------------------------------------------------------- B2 fakes: one `run(file, args, opts)` for git and gh

const SEP = '\x1f';
const P1 = 'aaaa1111';
const P2 = 'aaaa1111 bbbb2222';
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
const gl = (parents, iso, subject) => `${parents}${SEP}${unix(iso)}${SEP}${subject}`;
const gitText = (lines) => lines.join('\n') + '\n';
/** An error as execFileSync throws it. The message holds the command line, as the real one does. */
const fail = (o) => Object.assign(new Error('Command failed: gh api repos/Rev4nchist/Continuous-Claude-v3 SECRET'), o);
const TIMEOUT = () => fail({ code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' });
const item = (number, created_at, extra = {}) => ({ number, created_at, ...extra });
const pageOf = (url) => Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? 1);
const kindOf = (args) => (args[0] === 'log' ? 'git' : (args.some((a) => String(a).includes('search/issues')) ? 'search' : 'pager'));

const WORLD_GIT = () => gitText([
  gl(P2, '2026-11-07T18:00:00Z', 'Merge pull request #999 from Rev4nchist/feat/SECRET-branch'),
  gl(P1, '2026-11-08T17:00:00Z', 'feat: SECRET title (#998)'),
  gl(P2, '2026-11-05T18:00:00Z', 'Merge pull request #997 from Rev4nchist/feat/SECRET-branch'),
  gl(P1, '2026-11-08T01:00:00Z', 'chore(security): daily blocklist update [automated]'),
]);
const WORLD_ITEMS = () => [
  item(997, '2026-11-08T17:30:00Z', { title: 'SECRET title', user: { login: 'SECRET' }, head: { ref: 'feat/SECRET' }, draft: true, merged_at: '2026-11-08T18:00:00Z' }),
  item(996, '2026-11-07T17:30:00Z', { title: 'SECRET title', user: { login: 'SECRET' }, head: { ref: 'feat/SECRET' }, draft: false }),
  item(995, '2026-11-02T17:30:00Z', { title: 'SECRET title', user: { login: 'SECRET' }, head: { ref: 'feat/SECRET' }, draft: false }),
];
const WORLD_SEARCH = () => '{"total_count": 7, "items": [{"title": "SECRET"}]}';

/**
 * A fake run. `h` = {git, pager, search}: each (call, calls) => string, or throws. A call is {kind, file, args, opts}. The
 * handler is picked by the args, never by the call order. Returns {run, calls}.
 */
function fakeRun(h = {}) {
  const calls = [];
  const handlers = { git: WORLD_GIT, pager: () => JSON.stringify(WORLD_ITEMS()), search: WORLD_SEARCH, ...h };
  const run = (file, args, opts) => {
    const call = { kind: kindOf(args), file, args, opts };
    calls.push(call);
    return handlers[call.kind](call, calls);
  };
  return { run, calls };
}
const ghDown = () => { throw fail({ status: 1, stderr: 'error connecting to api.github.com', stdout: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/pulls/pulls#list-pull-requests","status":"404"}' }); };
const gitDown = () => { throw fail({ status: 128, stderr: 'fatal: not a git repository' }); };
const readerDeps = (run, extra = {}) => ({ run, err: () => {}, clock: () => 0, ...extra });

// ---------------------------------------------------------------- 27 file states

test('27 missing, empty, blank-only and all-garbage files are dark with a reason; 2 bad lines in 10 stay readable', async () => {
  // Breaks when a bad line throws, garbage becomes rows, or a dark file is read as a quiet one.
  const d = tmp();
  assert.deepEqual(await read(path.join(d, 'nope.jsonl'), 'prpr'), { ok: false, reason: 'missing' });
  assert.deepEqual(await read(put(d, 'empty.jsonl', ''), 'prpr'), { ok: false, reason: 'empty' });
  assert.deepEqual(await read(put(d, 'blank.jsonl', '\n  \n\r\n'), 'prpr'), { ok: false, reason: 'empty' });
  assert.deepEqual(await read(put(d, 'junk.jsonl', 'not json\n{{\nnope\n'), 'prpr'), { ok: false, reason: 'corrupt' });
  const ten = Array.from({ length: 8 }, (_, i) => good(i)).concat(['garbage', '{"half":']);
  const r = await read(put(d, 'ten.jsonl', jsonl(ten)), 'prpr');
  assert.equal(r.ok, true);
  assert.equal(r.bad, 2);
  assert.equal(r.rows.length, 8);
  const mostlyBad = await read(put(d, 'bad.jsonl', jsonl([good(1), 'x', 'y', 'z'])), 'prpr');
  assert.deepEqual(mostlyBad, { ok: false, reason: 'corrupt' }, 'more than half bad is corrupt');
});

test('28 a future ts, a missing field, no run_id and a non-object line are bad lines, one each', async () => {
  // Breaks when a future row lands on the grid, a missing field becomes "undefined", or rows of different runs merge.
  const d = tmp();
  const cases = {
    prpr: [
      { ...good(4), ts: '2031-01-01T00:00:00.000Z' }, { ...good(4), status: undefined }, { ...good(4), run_id: undefined },
      { ...good(4), run_id: '' }, { ...good(4), ts: 'garbage' }, { ...good(4), status: 7 }, '[1]', '42', 'null',
      { ...good(4), ts: '2026-11-08T20:00:00.001Z' },
    ],
    rev: [{ ts: NOW }, { phase: 'start' }, { ts: 'nope', phase: 'start' }, { ts: '2031-01-01T00:00:00.000Z', phase: 'start' }],
    coderabbit: [{ ts: NOW, files: '4', cost: 1 }, { ts: NOW, files: 4 }, { files: 4, cost: 1 }, { ts: NOW, files: 4, cost: null }],
  };
  const okRow = { prpr: good, rev: (i) => ({ ts: `2026-11-08T1${i}:00:00.000Z`, phase: 'start' }), coderabbit: (i) => ({ ts: `2026-11-08T1${i}:00:00.000Z`, files: 1, cost: 0.25 }) };
  for (const [family, bads] of Object.entries(cases)) {
    for (const [i, bad] of bads.entries()) {
      const rows = [okRow[family](1), okRow[family](2), okRow[family](3), okRow[family](4), bad];
      const r = await read(put(d, `${family}-${i}.jsonl`, jsonl(rows)), family);
      assert.equal(r.ok, true, `${family} ${i}`);
      assert.equal(r.bad, 1, `${family} case ${i} ${JSON.stringify(bad)} is one bad line`);
      assert.equal(r.rows.length, 4, `${family} case ${i}`);
    }
  }
});

test('28b a row at exactly exportedAt is valid; a CodeRabbit row without kind has kind null', async () => {
  // Breaks when the future check is >= instead of >, or a missing kind becomes the string "undefined".
  const d = tmp();
  const r = await read(put(d, 'c.jsonl', jsonl([{ ts: NOW, files: 2, cost: 0.5 }, { ts: NOW, files: 1, cost: 0.25, kind: 'cli' }])), 'coderabbit');
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map((x) => x.kind), [null, 'cli']);
});

test('29 a file over 64 MB is "too large" and is never opened', async () => {
  // Breaks when the cap is checked after the read. No real file of that size is written (NTFS fills a truncate with real zeros).
  const open = mock.fn(() => { throw new Error('must not open'); });
  const stat = () => ({ size: 65 * 1024 * 1024 });
  assert.deepEqual(await read('/does/not/exist.jsonl', 'prpr', { stat, open }), { ok: false, reason: 'too large' });
  assert.equal(open.mock.callCount(), 0);
  assert.equal(MAX_BYTES, 64 * 1024 * 1024);
});

test('29b a reader exception is "reader error" with the message on stderr, never in a row', async () => {
  // Breaks when the exception escapes, or the message is lost.
  const errs = [];
  const r = await readJsonlFamily('/x.jsonl', 'prpr', NOW, { stat: () => ({ size: 10 }), open: () => { throw new Error('boom'); }, err: (m) => errs.push(m) });
  assert.deepEqual(r, { ok: false, reason: 'reader error' });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /boom/);
});

test('30 line order and CRLF do not change the result', async () => {
  // Breaks when the reader keeps the first line seen, or a trailing \r breaks JSON.parse.
  const d = tmp();
  const rows = [
    { ts: '2026-11-07T18:00:00.000Z', run_id: 'a', head: 'H1', status: 'PASS' }, { ts: '2026-11-07T18:00:00.000Z', run_id: 'a', head: 'H1', status: 'FAIL' },
    { ts: '2026-11-08T18:00:00.000Z', run_id: 'b', head: 'H1', status: 'PASS' }, { ts: '2026-11-08T18:00:00.000Z', run_id: 'c', head: 'H2', status: 'PASS' },
  ];
  const build = (r) => buildFactoryRows({ today: '2026-11-08', exportedAt: NOW, targets: [], cap: null, prpr: r, rev: { ok: false, reason: 'missing' }, coderabbit: { ok: false, reason: 'missing' }, hand: { ok: false, reason: 'missing' } });
  const lf = await read(put(d, 'lf.jsonl', jsonl(rows)), 'prpr');
  const crlf = await read(put(d, 'crlf.jsonl', jsonl(rows, '\r\n')), 'prpr');
  const shuffled = await read(put(d, 'sh.jsonl', jsonl([rows[3], rows[2], rows[1], rows[0]])), 'prpr');
  assert.deepEqual(crlf, lf);
  assert.deepEqual(build(shuffled), build(lf));
  const out = build(lf);
  assert.equal(out.find((r) => r.id === 'prpr.week.first_pass').value, 1, 'H1 first run (a) fails, H2 passes');
  assert.equal(out.find((r) => r.id === 'prpr.week.heads').value, 2);
});

// ---------------------------------------------------------------- 31 handoffs

const HEADER = (date, outcome, more = '') => `---\nsession: abcdef12-aaaa\ndate: ${date}\nstatus: complete\noutcome: ${outcome}\nnotion_url: https://notion.so/SECRET\n${more}---\n\ngoal: SECRET goal\nnow: SECRET now\n`;

test('31 the handoffs reader counts both subfolders, skips # lines, reads only date and outcome, and a file with no second --- is bad', async () => {
  // Breaks when the body is read (h.yaml would pass), a # line breaks the header, another key leaks, or a half header counts.
  const d = tmp();
  put(d, 'general/a.yaml', HEADER('2026-11-08', 'SUCCEEDED'));
  put(d, 'general/b.yaml', HEADER('2026-11-07', 'PARTIAL_PLUS', '# a comment inside the header\n'));
  put(d, 'ccv3-compact-quick-wins/c.yaml', HEADER('"2026-11-06"', "'FAILED'"));
  put(d, 'd.yaml', HEADER('2026-11-05', 'PARTIAL_MINUS'));
  put(d, 'general/e.yaml', '---\ndate: 2026-11-04\noutcome: SUCCEEDED\n');
  put(d, 'general/f.yaml', '---\ndate: 2026-11-03\nstatus: x\n---\nbody\n');
  put(d, 'general/g.yaml', HEADER('2026/11/03', 'SUCCEEDED'));
  put(d, 'general/h.yaml', '---\nsession: x\n---\ndate: 2026-11-02\noutcome: SUCCEEDED\n');
  put(d, 'general/notes.txt', HEADER('2026-11-01', 'SUCCEEDED'));
  const r = await readHandoffs(d, quiet());
  assert.equal(r.ok, true);
  assert.equal(r.bad, 4, 'e, f, g and h are bad files');
  assert.deepEqual(r.rows.map((x) => `${x.date} ${x.outcome}`).sort(), ['2026-11-05 PARTIAL_MINUS', '2026-11-06 FAILED', '2026-11-07 PARTIAL_PLUS', '2026-11-08 SUCCEEDED']);
  for (const row of r.rows) assert.deepEqual(Object.keys(row).sort(), ['date', 'outcome']);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});

test('31a handoffs: a missing folder is missing, a folder with no yaml is empty, a folder of bad files is corrupt', async () => {
  // Breaks when a missing folder is created, or a dark folder is counted as zero handoffs.
  const d = tmp();
  assert.deepEqual(await readHandoffs(path.join(d, 'nope'), quiet()), { ok: false, reason: 'missing' });
  assert.equal(existsSync(path.join(d, 'nope')), false, 'the reader never creates a folder');
  mkdirSync(path.join(d, 'empty', 'general'), { recursive: true });
  assert.deepEqual(await readHandoffs(path.join(d, 'empty'), quiet()), { ok: false, reason: 'empty' });
  put(d, 'bad/general/a.yaml', 'nothing\n');
  put(d, 'bad/general/b.yaml', '---\n');
  assert.deepEqual(await readHandoffs(path.join(d, 'bad'), quiet()), { ok: false, reason: 'corrupt' });
});

test('31b with no --handoffs the default is <primaryRoot>/thoughts/shared/handoffs', () => {
  // Breaks when the default is the script's own checkout (a worktree has no thoughts/ and would show a false dark family).
  const p = defaultPaths({ primaryRoot: () => path.join('X', 'primary'), home: path.join('X', 'home') });
  assert.equal(p.handoffs, path.join('X', 'primary', 'thoughts', 'shared', 'handoffs'));
  assert.equal(p.out, path.join('X', 'home', '.claude', 'state', 'lane-dash'));
  assert.equal(p.gates, path.join('X', 'home', '.claude', 'logs', 'pre-pr-gates.jsonl'));
  assert.equal(p.reviews, path.join('X', 'home', '.claude', 'state', 'cursor-review-ledger.jsonl'));
  assert.equal(p.coderabbit, path.join('X', 'home', '.claude', 'state', 'coderabbit-paid.jsonl'));
});

test('31b2 when git fails primaryRoot returns its input; the default is still under the repo root, not scripts/coordination', () => {
  // Breaks when defaultPaths hands HERE (scripts/coordination) to primaryRoot: the fallback then points inside scripts/.
  const p = defaultPaths({ primaryRoot: (from) => from, home: 'H' });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  assert.equal(p.handoffs, path.join(root, 'thoughts', 'shared', 'handoffs'));
  assert.equal(p.routerConfig, path.join(root, 'review-router.config.json'));
});

test('31c with no --router-config the default is <primaryRoot>/review-router.config.json; a missing file gives no cap and no throw', () => {
  // Breaks when the default is the script's own folder, or a missing or bad file throws.
  const p = defaultPaths({ primaryRoot: () => path.join('X', 'primary'), home: 'H' });
  assert.equal(p.routerConfig, path.join('X', 'primary', 'review-router.config.json'));
  assert.equal(p.dashConfig, path.join(path.dirname(fileURLToPath(import.meta.url)), 'lane-dash.config.json'));
  const d = tmp();
  assert.equal(readRouterCap(path.join(d, 'nope.json')), null);
  assert.equal(readRouterCap(put(d, 'ok.json', '{"coderabbit":{"monthly_file_cap":160}}')), 160);
  assert.equal(readRouterCap(put(d, 'zero.json', '{"coderabbit":{"monthly_file_cap":0}}')), 0, 'a cap of 0 is a cap');
  for (const [i, text] of ['{"coderabbit":{}}', '{}', '{"coderabbit":{"monthly_file_cap":"160"}}', '{"coderabbit":{"monthly_file_cap":-1}}', '{"coderabbit":{"monthly_file_cap":1.5}}', 'not json'].entries()) {
    assert.equal(readRouterCap(put(d, `bad${i}.json`, text)), null, text);
  }
});

test('31d --dash-config: window_days comes from the file; a missing file gives window_days 7 and one stderr line', () => {
  // Breaks when the grid length is a constant, or a missing config throws.
  const d = tmp();
  const errs = [];
  const missing = readDashTargets(path.join(d, 'nope.json'), (m) => errs.push(m));
  assert.equal(missing.find((t) => t.key === 'window_days').value, 7);
  assert.equal(errs.length, 1);
  const set = readDashTargets(put(d, 'c.json', JSON.stringify({ targets: [{ key: 'window_days', value: 3 }] })), (m) => errs.push(m));
  assert.equal(set.find((t) => t.key === 'window_days').value, 3);
  assert.equal(errs.length, 1, 'no line for a good file');
});

// ---------------------------------------------------------------- 32 reducers

test('32 the reducers keep only the allowed keys, and run and head are opaque', async () => {
  // Breaks when a reader passes the raw row through (a path, a branch, a 40-hex head or a session id would ride along).
  const d = tmp();
  const prpr = await read(put(d, 'p.jsonl', jsonl([{ ts: '2026-11-08T18:00:00.000Z', branch: 'feat/SECRET-branch', head: HEX40, base: 'main', run_id: 'RUN-SECRET', step: 'unowned:scripts/secret.mjs', status: 'FAIL', ms: 3, detail: 'C:\\Users\\x\\secret.ts' }])), 'prpr');
  assert.deepEqual(Object.keys(prpr.rows[0]).sort(), ['head', 'run', 'status', 'ts']);
  assert.ok(!/SECRET|feat\/|[0-9a-f]{40}|secret/.test(JSON.stringify(prpr)), JSON.stringify(prpr));
  assert.equal(prpr.rows[0].status, 'FAIL');
  const headless = await read(put(d, 'p2.jsonl', jsonl([{ ts: '2026-11-08T18:00:00.000Z', run_id: 'x', head: '', status: 'PASS' }, { ts: '2026-11-08T18:00:00.000Z', run_id: 'y', status: 'PASS' }])), 'prpr');
  assert.deepEqual(headless.rows.map((r) => r.head), ['', ''], 'an empty or missing head stays empty');
  const rev = await read(put(d, 'r.jsonl', jsonl([
    { ts: '2026-11-04T18:00:00.000Z', phase: 'start', id: 'SECRET-id', ref: 'feat/SECRET', model: 'SECRET', sessionId: '#abcdef12', purpose: 'review' },
    { ts: '2026-11-04T18:05:00.000Z', phase: 'end', id: 'SECRET-id', error: 'SECRET error', timedOut: true, notStarted: true, usage: { x: 1 } },
  ])), 'rev');
  for (const row of rev.rows) assert.deepEqual(Object.keys(row).sort(), ['phase', 'purpose', 'timedOut', 'ts']);
  assert.deepEqual(rev.rows.map((r) => r.timedOut), [false, true]);
  assert.ok(!/SECRET|abcdef12/.test(JSON.stringify(rev)));
  assert.equal(rev.rows.length, 2, 'an end row with notStarted is a row, and notStarted is not read (12)');
  const cr = await read(put(d, 'c.jsonl', jsonl([{ ts: '2026-11-04T18:00:00.000Z', date: '2026-11-04', pr: 5, head: HEX40, files: 4, cost: 1, session: '#abcdef12', branch: 'feat/SECRET' }])), 'coderabbit');
  assert.deepEqual(Object.keys(cr.rows[0]).sort(), ['cost', 'files', 'kind', 'ts']);
  assert.ok(!/SECRET|abcdef12|[0-9a-f]{40}/.test(JSON.stringify(cr)));
});

// ---------------------------------------------------------------- the CLI

function world({ dark = false, extra = {}, handlers = {}, deps: moreDeps = {} } = {}) {
  const d = tmp();
  const f = {
    out: path.join(d, 'out'),
    gates: put(d, 'gates.jsonl', jsonl([
      { ts: '2026-11-08T17:00:00.000Z', branch: 'feat/SECRET-branch', head: HEX40, base: 'main', run_id: 'run-1', step: 'unowned:scripts/secret.mjs', status: 'FAIL', ms: 5, detail: 'C:\\Users\\x\\secret.ts SECRET error' },
      { ts: '2026-11-08T17:00:00.000Z', branch: 'feat/SECRET-branch', head: HEX40, base: 'main', run_id: 'run-1', step: 'lint', status: 'PASS', ms: 5, detail: 'ok' },
      { ts: '2026-11-07T17:00:00.000Z', branch: 'b', head: 'fedcba9876543210fedcba9876543210fedcba98', base: 'main', run_id: 'run-0', step: 'lint', status: 'PASS', ms: 5, detail: '#abcdef12' },
    ])),
    reviews: put(d, 'rev.jsonl', jsonl([
      { ts: '2026-11-04T18:00:00.000Z', phase: 'start', id: 'SECRET-id', ref: 'feat/SECRET', model: 'SECRET', sessionId: '#abcdef12', purpose: 'review' },
      { ts: '2026-11-04T18:05:00.000Z', phase: 'end', id: 'SECRET-id', error: 'SECRET error', timedOut: false },
    ])),
    coderabbit: put(d, 'cr.jsonl', jsonl([{ ts: '2026-11-04T18:00:00.000Z', date: '2026-11-04', pr: 5, head: HEX40, files: 4, cost: 1, session: '#abcdef12' }])),
    handoffs: path.join(d, 'handoffs'),
    routerConfig: put(d, 'router.json', '{"coderabbit":{"monthly_file_cap":160}}'),
    dashConfig: put(d, 'dash.json', JSON.stringify({ targets: [{ key: 'window_days', value: 7 }] })),
    ...extra,
  };
  put(f.handoffs, 'general/a.yaml', HEADER('2026-11-08', 'SUCCEEDED'));
  put(f.handoffs, 'general/b.yaml', HEADER('2026-11-07', 'PARTIAL_PLUS'));
  if (dark) for (const k of ['gates', 'reviews', 'coderabbit', 'handoffs']) f[k] = path.join(d, `missing-${k}`);
  const argv = ['--out', f.out, '--gates', f.gates, '--reviews', f.reviews, '--coderabbit', f.coderabbit, '--handoffs', f.handoffs, '--router-config', f.routerConfig, '--dash-config', f.dashConfig, '--git-root', d, '--repo', 'owner/repo'];
  const logs = [];
  const errs = [];
  const { run, calls } = fakeRun(handlers);
  const deps = { now: () => NOW, log: (m) => logs.push(m), err: (m) => errs.push(m), run, ...moreDeps };
  return { d, f, argv, logs, errs, deps, calls, file: path.join(f.out, 'factory.json') };
}
const readOut = (w) => JSON.parse(readFileSync(w.file, 'utf8'));

test('33 privacy, end to end: no path, branch, head, session id, prompt, finding or handoff body reaches the file or the log', async () => {
  // Breaks when any field leaks. The parsed ids and texts are checked by name; the raw bytes only for the hex patterns
  // (JSON escapes a backslash, so a raw grep for "C:\" could never fail).
  const w = world();
  assert.equal(await main(w.argv, w.deps), 0, w.errs.join('\n'));
  const doc = readOut(w);
  const forbidden = [/SECRET/i, /abcdef12/i, /C:\\/, /Users/, /notion/i, /unowned/i, /feat\//, /secret\.(ts|mjs)/i,
    /Rev4nchist/, /#\d+/, /Merge pull request/, /\(#/, /https?:\/\//, /search\/issues/];
  for (const r of doc.rows) for (const s of [r.id, r.text ?? '']) for (const re of forbidden) assert.ok(!re.test(s), `${r.id}: ${s} matches ${re}`);
  const raw = readFileSync(w.file, 'utf8');
  for (const re of forbidden) assert.ok(!re.test(raw), `raw bytes match ${re}`);
  assert.ok(w.calls.some((c) => c.kind === 'git') && w.calls.some((c) => c.kind === 'pager') && w.calls.some((c) => c.kind === 'search'), 'all three fake runners were used');
  assert.ok(!/[0-9a-f]{40}/.test(raw), 'a 40-hex head in the raw bytes');
  assert.ok(!/#[0-9a-f]{8}/.test(raw), 'a session handle in the raw bytes');
  assert.ok(!/SECRET|abcdef12/i.test(raw), 'a seeded string in the raw bytes');
  for (const line of w.logs.concat(w.errs)) {
    assert.ok(!/SECRET|abcdef12|[0-9a-f]{40}/i.test(line), `log line leaks: ${line}`);
  }
  const prpr = doc.rows.find((r) => r.id === 'prpr.rows');
  assert.equal(prpr.value, 3);
  const landed = doc.rows.find((r) => r.id === 'prpr.prs.landed.week');
  assert.equal(landed.value, 3, 'the PR families are in the file, so the privacy check ran over them');
});

test('33b the log has one counts-only line per family and one for the file', async () => {
  // Breaks when a family or the file has no line, or a line carries a name.
  const w = world();
  await main(w.argv, w.deps);
  assert.equal(w.logs.length, 8, w.logs.join('\n'));
  assert.match(w.logs[0], /^prpr: 3 rows, 0 bad lines, as of 2026-11-08$/);
  assert.match(w.logs[1], /^rev: 2 rows, 0 bad lines, as of 2026-11-04$/);
  assert.match(w.logs[2], /^rev\.coderabbit: 1 rows, 0 bad lines, as of 2026-11-04$/);
  assert.match(w.logs[3], /^hand: 2 files, 0 bad lines, as of 2026-11-08$/);
  assert.match(w.logs[4], /^prpr\.prs\.landed: 3 events, 0 bad lines, as of 2026-11-08$/);
  assert.match(w.logs[5], /^prpr\.prs\.opened: 3 events, 0 bad lines, as of 2026-11-08$/);
  assert.match(w.logs[6], /^prpr\.prs\.check: 7 merged this week$/);
  assert.match(w.logs[7], /^factory\.json: \d+ rows, \d+ bytes/);
});

const NEIGHBOURS = ['lanes', 'assignments', 'projects', 'targets', 'meta', 'snapshots', 'tiles', 'flow'].map((n) => `${n}.json`).concat('refresh.json');

test('34 the write is temp then rename, under .factory.lock; a held lock gives exit 1 and keeps the old file; neighbours stay byte-identical', async () => {
  // Breaks when the file is written in place, the lock is left behind, a fresh lock is ignored, or the 8 export files change.
  const w = world();
  mkdirSync(w.f.out, { recursive: true });
  for (const n of NEIGHBOURS) writeFileSync(path.join(w.f.out, n), `{"sentinel":"${n}"}`);
  writeFileSync(path.join(w.f.out, '.export.lock'), '1');
  const before = NEIGHBOURS.map((n) => readFileSync(path.join(w.f.out, n)));
  const renames = [];
  const rename = (a, b) => { renames.push([a, b]); renameSync(a, b); };
  assert.equal(await main(w.argv, { ...w.deps, rename }), 0, w.errs.join('\n'));
  assert.equal(renames.length, 1);
  assert.ok(renames[0][0].endsWith('.tmp'), renames[0][0]);
  assert.equal(path.basename(renames[0][1]), 'factory.json');
  assert.deepEqual(readdirSync(w.f.out).sort(), [...NEIGHBOURS, '.export.lock', 'factory.json'].sort(), 'no .tmp and no .factory.lock left');
  NEIGHBOURS.forEach((n, i) => assert.deepEqual(readFileSync(path.join(w.f.out, n)), before[i], n));
  assert.equal(readFileSync(path.join(w.f.out, '.export.lock'), 'utf8'), '1', 'the export lock is not touched');

  const old = readFileSync(w.file);
  writeFileSync(path.join(w.f.out, '.factory.lock'), '999');
  const w2 = { ...w, logs: [], errs: [] };
  assert.equal(await main(w.argv, { ...w.deps, log: (m) => w2.logs.push(m), err: (m) => w2.errs.push(m) }), 1);
  assert.match(w2.errs.join('\n'), /lock/);
  assert.deepEqual(readFileSync(w.file), old, 'the old factory.json is kept');
  assert.ok(existsSync(path.join(w.f.out, '.factory.lock')), 'a lock we did not take is not removed');

  const stale = new Date(Date.now() - 30 * 60 * 1000); // the lock rule reads file times, so it uses the real clock
  utimesSync(path.join(w.f.out, '.factory.lock'), stale, stale);
  assert.equal(await main(w.argv, w.deps), 0, 'a lock older than 10 minutes is taken over');
  assert.equal(existsSync(path.join(w.f.out, '.factory.lock')), false);
});

test('35 all four families dark, git and gh down: exit 0, the shared rows and six notes, no check row', async () => {
  // Breaks when one dark family stops the run, or the run writes nothing.
  const w = world({ dark: true, handlers: { git: gitDown, pager: ghDown, search: ghDown } });
  assert.equal(await main(w.argv, w.deps), 0, w.errs.join('\n'));
  const doc = readOut(w);
  const byId = Object.fromEntries(doc.rows.map((r) => [r.id, r]));
  for (const id of ['prpr.note', 'rev.note', 'rev.coderabbit.note', 'hand.note']) assert.equal(byId[id].text, 'no data: missing', id);
  assert.equal(byId['factory.days'].value, 14);
  assert.equal(byId['factory.today'].text, '2026-11-08');
  assert.equal(byId['prpr.prs.landed.note'].text, 'no data: reader error');
  assert.equal(byId['prpr.prs.opened.note'].text, 'no data: unreachable');
  assert.equal(byId['prpr.prs.note'], undefined, 'the placeholder is gone');
  assert.equal(byId['prpr.prs.landed.check'], undefined, 'no check row when landed and opened are dark');
  assert.ok(!doc.rows.some((r) => r.kind === 'bar'), 'no bar rows from dark families');
  assert.ok(w.logs.some((l) => l === 'prpr: no data: missing'), w.logs.join('\n'));
});

test('36 the envelope is {sql, exportedAt, rows}, under 256 KB, with the run clock; an oversize envelope is refused', async () => {
  // Breaks when the envelope shape changes, exportedAt is not the run clock, or a document over 256 KB is written.
  const w = world();
  await main(w.argv, w.deps);
  const doc = readOut(w);
  assert.deepEqual(Object.keys(doc), ['sql', 'exportedAt', 'rows']);
  assert.equal(doc.exportedAt, NOW);
  assert.ok(Number.isFinite(Date.parse(doc.exportedAt)));
  assert.match(doc.sql, /^Computed in Node by scripts\/coordination\/factory-rows\.mjs from four local files, git log on main and two GitHub reads\. No query\.$/);
  assert.ok(readFileSync(w.file).length < 256 * 1024);
  const d = tmp();
  assert.throws(() => writeFactory(d, { sql: 's', exportedAt: NOW, rows: [{ id: 'x'.repeat(300 * 1024) }] }), /256 KB/);
  assert.equal(existsSync(path.join(d, 'factory.json')), false);
  assert.equal(existsSync(path.join(d, '.factory.lock')), false, 'no lock is taken for a refused write');
});

test('36b a failed rename leaves no lock and no tmp file', () => {
  // Breaks when the finally block stops releasing the lock or the tmp file.
  const d = tmp();
  assert.throws(() => writeFactory(d, { sql: 's', exportedAt: NOW, rows: [] }, { rename: () => { throw new Error('rename failed'); } }), /rename failed/);
  assert.equal(existsSync(path.join(d, '.factory.lock')), false);
  assert.equal(existsSync(path.join(d, 'factory.json.tmp')), false);
  assert.equal(existsSync(path.join(d, 'factory.json')), false);
});

test('37 the cap and the window come from the two config files in the run', async () => {
  // Breaks when --router-config or --dash-config is ignored.
  const w = world();
  writeFileSync(w.f.dashConfig, JSON.stringify({ targets: [{ key: 'window_days', value: 3 }] }));
  writeFileSync(w.f.routerConfig, '{"coderabbit":{"monthly_file_cap":8}}');
  await main(w.argv, w.deps);
  const byId = Object.fromEntries(readOut(w).rows.map((r) => [r.id, r]));
  assert.equal(byId['factory.days'].value, 6);
  assert.equal(byId['rev.coderabbit.month.cap.files'].value, 8);
  assert.equal(byId['rev.coderabbit.month.cap.pct'].text, '50.0%');
});

test('38 an unknown flag or a flag with no value exits 2 and writes nothing', async () => {
  // Breaks when a typo runs the export against the default real folder.
  const w = world();
  assert.equal(await main(['--out', w.f.out, '--bogus', 'x'], w.deps), 2);
  assert.equal(await main(['--out'], w.deps), 2);
  assert.equal(existsSync(w.file), false);
  assert.equal(await main(['--help'], w.deps), 0);
});

test('38b --help: every option in USAGE starts its description in one column (N5)', async () => {
  // Breaks when an option line in USAGE is padded by a different width than the rest.
  const logs = [];
  assert.equal(await main(['--help'], { ...quiet(), log: (m) => logs.push(m) }), 0);
  const cols = logs.join('\n').split('\n').flatMap((l) => {
    const m = /^(  --[\w-]+)( +)\S/.exec(l);
    return m ? [{ name: m[1].trim(), col: m[1].length + m[2].length }] : [];
  });
  assert.equal(cols.length, 9, 'nine option lines');
  assert.deepEqual([...new Set(cols.map((c) => c.col))].length, 1, JSON.stringify(cols));
});

// ---------------------------------------------------------------- B2: PR counts per Chicago day

const rowsById = (w) => Object.fromEntries(readOut(w).rows.map((r) => [r.id, r]));
const landedOf = (lines, deps = {}) => EX.readLanded({ cwd: '/x', since: '2026-07-28T00:00:00Z' }, readerDeps(fakeRun({ git: () => gitText(lines) }).run, deps));
const CHORE = () => gl(P1, '2026-11-08T01:00:00Z', 'chore(security): daily blocklist update [automated]');

test('R45 git lines: merge, squash, a squash with | and a CR are rows; chores and plain merges are skipped; a duplicate and a bad ct are lines', async () => {
  // Breaks when the squash is missed (M9), a plain split drops the | subject, a chore counts, a duplicate doubles, or a CR defeats the $ anchor.
  const r = landedOf([
    gl(P2, '2026-11-07T18:00:00Z', 'Merge pull request #101 from o/feat/x'),
    gl(P1, '2026-11-07T19:00:00Z', 'feat: a thing (#102)'),
    gl(P1, '2026-11-07T20:00:00Z', 'fix: a | b (#998)'),
    CHORE(),
    gl(P2, '2026-11-07T21:00:00Z', "Merge remote-tracking branch 'fork/main' into x"),
    gl(P2, '2026-11-07T22:00:00Z', 'Merge pull request #101 from o/feat/x'),
    `${P2}${SEP}x${SEP}Merge pull request #103 from o/feat/y`,
    `${gl(P1, '2026-11-07T23:00:00Z', 'feat: crlf (#997)')}\r`,
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.bad, 1);
  assert.deepEqual(r.rows.map((x) => x.ts), ['2026-11-07T18:00:00.000Z', '2026-11-07T19:00:00.000Z', '2026-11-07T20:00:00.000Z', '2026-11-07T23:00:00.000Z']);
  for (const row of r.rows) assert.deepEqual(Object.keys(row), ['ts'], 'a row is {ts} and nothing else');
});

test('R45 plain one-parent lines (a rebase land, a direct push) are skipped, not bad', () => {
  // Breaks when a plain commit with no PR shape is a bad line (F5b).
  const r = landedOf([gl(P2, '2026-11-07T18:00:00Z', 'Merge pull request #101 from o/x'), gl(P1, '2026-11-07T19:00:00Z', 'fix: a plain commit'), gl(P1, '2026-11-07T19:30:00Z', 'fix: another plain commit')]);
  assert.deepEqual([r.ok, r.rows.length, r.bad], [true, 1, 0]);
});

test('R45b the ct is unix seconds read as UTC: 06:30Z on 11-01 is exactly that ISO instant (M11)', () => {
  // Breaks when the reader goes through the local zone, the commit offset or a slice.
  const r = landedOf([gl(P2, '2026-11-01T06:30:00Z', 'Merge pull request #5 from o/x'), gl(P2, '2026-11-01T07:30:00Z', 'Merge pull request #6 from o/x')]);
  assert.deepEqual(r.rows.map((x) => x.ts), ['2026-11-01T06:30:00.000Z', '2026-11-01T07:30:00.000Z']);
});

test('R45c lines before the grid stay rows; only chores is "empty"; skipped lines are not lines', async () => {
  // Breaks when pre-grid lines are filtered in the reader or the collector (M14), or a skipped line counts in `lines`.
  const pre = landedOf([gl(P2, '2026-10-20T18:00:00Z', 'Merge pull request #7 from o/x'), gl(P1, '2026-10-21T18:00:00Z', 'feat: y (#8)')]);
  assert.deepEqual(pre.rows.map((x) => x.ts), ['2026-10-20T18:00:00.000Z', '2026-10-21T18:00:00.000Z']);
  const chores = landedOf(Array.from({ length: 14 }, CHORE));
  assert.deepEqual(chores, { ok: false, reason: 'empty' }, 'chores only is empty, never corrupt');
  const mostlyBad = landedOf([gl(P2, '2026-11-07T18:00:00Z', 'Merge pull request #9 from o/x'), `${P2}${SEP}x${SEP}Merge pull request #10 from o/x`, `${P1}${SEP}y${SEP}feat: z (#11)`, ...Array.from({ length: 6 }, CHORE)]);
  assert.deepEqual(mostlyBad, { ok: false, reason: 'corrupt' }, '2 bad of 3 lines: the 6 chores are not lines');
  const w = world({ handlers: { git: () => gitText([gl(P2, '2026-10-20T18:00:00Z', 'Merge pull request #7 from o/x')]) } });
  assert.equal(await main(w.argv, w.deps), 0, w.errs.join('\n'));
  const byId = rowsById(w);
  assert.equal(byId['prpr.prs.landed.as_of'].text, '2026-10-20');
  assert.equal(byId['prpr.prs.landed.note'].text, 'no data since Oct 20');
  assert.equal(byId['prpr.prs.landed.rows'].value, 1);
  for (let i = 1; i <= 14; i++) assert.strictEqual(byId[`prpr.prs.landed.bar.${i}`].value, 0);
});

test('R46 git fails (ENOENT, exit 128, a timeout with a null status): landed is "reader error", one stderr line, opened rows stay, exit 0', async () => {
  // Breaks when a git failure is exit 1, throws, or a null status passes as success.
  const downs = [() => { throw fail({ code: 'ENOENT' }); }, gitDown, () => { throw TIMEOUT(); }];
  for (const git of downs) {
    const errs = [];
    const direct = EX.readLanded({ cwd: '/x', since: 'S' }, readerDeps(fakeRun({ git }).run, { err: (m) => errs.push(m) }));
    assert.deepEqual(direct, { ok: false, reason: 'reader error' });
    assert.equal(errs.length, 1);
    assert.ok(errs[0].length <= 200 && !/Rev4nchist/.test(errs[0]), errs[0]);
    const w = world({ handlers: { git } });
    assert.equal(await main(w.argv, w.deps), 0, w.errs.join('\n'));
    const byId = rowsById(w);
    assert.equal(byId['prpr.prs.landed.note'].text, 'no data: reader error');
    assert.ok(byId['prpr.prs.opened.bar.14'], 'opened still has rows');
    assert.equal(byId['prpr.prs.landed.check'], undefined);
  }
});

const itemsOn = (from, n, day = '2026-11-08T17:00:00Z') => Array.from({ length: n }, (_, i) => item(from + i, day));
const opened = (pager, deps = {}) => {
  const f = fakeRun({ pager });
  return { f, result: EX.readOpened({ repo: 'o/r', start: '2026-10-26' }, readerDeps(f.run, deps)) };
};

test('R47 paging: a short page stops it, a boundary duplicate counts once, 10 full pages is "too large", a page past the grid start stops at once', () => {
  // Breaks when paging never stops, a duplicate doubles, pre-grid items are dropped, or the grid-start stop is missing.
  const one = opened((c) => JSON.stringify(pageOf(c.args.join(' ')) === 1 ? itemsOn(1, 100) : [...itemsOn(100, 30, '2026-10-01T17:00:00Z')]));
  assert.equal(one.f.calls.length, 2);
  assert.equal(one.result.ok, true);
  assert.equal(one.result.rows.length, 129, '130 items, one boundary duplicate (#100), pre-grid items kept');
  assert.equal(one.result.bad, 0);
  const many = opened((c) => JSON.stringify(itemsOn(pageOf(c.args.join(' ')) * 1000, 100)));
  assert.equal(many.f.calls.length, 10);
  assert.deepEqual(many.result, { ok: false, reason: 'too large' });
  const past = opened(() => JSON.stringify([...itemsOn(1, 99), item(500, '2026-10-20T17:00:00Z')]));
  assert.equal(past.f.calls.length, 1, 'page 1 crosses the grid start: no second call');
  assert.equal(past.result.rows.length, 100);
});

test('R47 items with no usable created_at or number are bad; an empty first page is "empty"', () => {
  // Breaks when a malformed item becomes a row or an empty list is read as zero PRs.
  const r = opened(() => JSON.stringify([item(1, '2026-11-08T17:00:00Z'), item(2, 'nope'), { number: 3 }, item(4, '2026-11-08T17:00:00Z'), item(5, '2026-11-08T17:00:00Z')])).result;
  assert.deepEqual([r.ok, r.rows.length, r.bad], [true, 3, 2]);
  assert.deepEqual(opened(() => '[]').result, { ok: false, reason: 'empty' });
});

test('R48 gh fails with a body that holds a URL: opened is "unreachable", landed stays, no check row, exit 0, one short stderr line, no URL or repo in any log', async () => {
  // Breaks when a gh failure is exit 1 or a zero (M8), or when e.stdout, the command line or the repo reach a log.
  const w = world({ handlers: { pager: ghDown, search: ghDown } });
  assert.equal(await main(w.argv, w.deps), 0, w.errs.join('\n'));
  const byId = rowsById(w);
  assert.equal(byId['prpr.prs.opened.note'].text, 'no data: unreachable');
  assert.deepEqual(Object.keys(byId).filter((id) => id.startsWith('prpr.prs.opened.')), ['prpr.prs.opened.note']);
  assert.ok(byId['prpr.prs.landed.bar.14']);
  assert.equal(byId['prpr.prs.landed.check'], undefined);
  assert.ok(w.logs.includes('prpr.prs.opened: no data: unreachable'), w.logs.join('\n'));
  assert.ok(w.logs.includes('prpr.prs.check: no data: unreachable'), w.logs.join('\n'));
  const mine = w.errs.filter((m) => /prpr\.prs\.opened/.test(m));
  assert.equal(mine.length, 1, w.errs.join('\n'));
  assert.ok(mine[0].length <= 200, mine[0]);
  for (const line of w.logs.concat(w.errs)) assert.ok(!/https?:\/\/|owner\/repo|Rev4nchist|documentation_url|Command failed/.test(line), `log leaks: ${line}`);
});

test('R48 a gh stderr line is cut after its (HTTP nnn) token: the user id and request id never reach the log', () => {
  // Breaks when the whole stderr line is logged.
  const errs = [];
  const run = () => { throw fail({ status: 1, stderr: 'gh: API rate limit exceeded (HTTP 403) user ID 123456789 request ABCD-1234\nmore' }); };
  const r = EX.readOpened({ repo: 'o/r', start: '2026-10-26' }, readerDeps(run, { err: (m) => errs.push(m) }));
  assert.deepEqual(r, { ok: false, reason: 'unreachable' });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /\(HTTP 403\)$/);
  assert.ok(!/123456789|ABCD/.test(errs[0]), errs[0]);
});

test('R48e an empty repo does not garble the gh stderr line (N1)', () => {
  // Breaks when ghTail splits the line on '' (every character) instead of skipping an empty repo.
  const errs = [];
  const run = () => { throw fail({ status: 1, stderr: 'gh: Not Found (HTTP 404) more' }); };
  EX.readOpened({ repo: '', start: '2026-10-26' }, readerDeps(run, { err: (m) => errs.push(m) }));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /gh: Not Found \(HTTP 404\)$/);
});

/** A fake gh that honours the timeout it is given: it takes 9.9 s a call, or the whole timeout when that is shorter, and then times out. */
function slowWorld() {
  const clock = { t: 0 };
  const timeouts = [];
  let n = 0;
  const handlers = {
    git: () => { clock.t += 10_000; return WORLD_GIT(); },
    search: () => { throw new Error('the search must not be called when no budget is left'); },
    pager: (call) => {
      timeouts.push(call.opts.timeout);
      clock.t += Math.min(9_900, call.opts.timeout);
      if (call.opts.timeout < 9_900) throw TIMEOUT();
      return JSON.stringify(itemsOn(++n * 1000, 100));
    },
  };
  return { clock, timeouts, handlers };
}

test('R48b the per-call timeout shrinks with the budget: 10000 x4 then 400; the pager takes at most 40 s, pager plus git at most 50 s', async () => {
  // Breaks when the timeout is a constant 10 s (M15: 49.5 s of gh), the budget is checked only between pages, or the budget is dropped.
  const s = slowWorld();
  const direct = EX.readOpened({ repo: 'o/r', start: '2026-10-26' }, readerDeps(fakeRun(s.handlers).run, { clock: () => s.clock.t }));
  assert.deepEqual(direct, { ok: false, reason: 'unreachable' });
  assert.deepEqual(s.timeouts, [10_000, 10_000, 10_000, 10_000, 400]);
  assert.equal(s.clock.t, 40_000);

  const s2 = slowWorld();
  const w = world({ handlers: s2.handlers, deps: { clock: () => s2.clock.t } });
  assert.equal(await main(w.argv, w.deps), 0, w.errs.join('\n'));
  assert.deepEqual(s2.timeouts, [10_000, 10_000, 10_000, 10_000, 400]);
  assert.ok(s2.clock.t <= 50_000, `pager plus git took ${s2.clock.t} ms`);
  assert.equal(w.calls.filter((c) => c.kind === 'search').length, 0, 'no budget left: no search call');
  const byId = rowsById(w);
  assert.equal(byId['prpr.prs.opened.note'].text, 'no data: unreachable');
  assert.ok(byId['prpr.prs.landed.bar.14'], 'landed present');
  assert.equal(byId['prpr.prs.landed.check'], undefined);
  assert.equal(w.calls.find((c) => c.kind === 'git').opts.timeout, 10_000);
});

test('R48c gh missing from PATH (ENOENT): the next call uses the fallback file; two ENOENT is "unreachable"; the default fallback is the machine-wide gh.exe', () => {
  // Breaks when the fallback is missing.
  const files = [];
  const only = (okFile) => (call) => { files.push(call.file); if (call.file !== okFile) throw fail({ code: 'ENOENT' }); return '[]'; };
  const fb = 'X:\\fake\\gh.exe';
  const ok = EX.readOpened({ repo: 'o/r', start: '2026-10-26' }, readerDeps(fakeRun({ pager: only(fb) }).run, { ghFallback: fb }));
  assert.deepEqual(files, ['gh', fb]);
  assert.deepEqual(ok, { ok: false, reason: 'empty' }, 'the fallback call worked: an empty list is empty, not unreachable');
  files.length = 0;
  const none = EX.readOpened({ repo: 'o/r', start: '2026-10-26' }, readerDeps(fakeRun({ pager: only('never') }).run, { ghFallback: fb }));
  assert.deepEqual(none, { ok: false, reason: 'unreachable' });
  if (process.platform === 'win32') {
    files.length = 0;
    EX.readOpened({ repo: 'o/r', start: '2026-10-26' }, readerDeps(fakeRun({ pager: only('never') }).run));
    assert.deepEqual(files, ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe']);
  }
});

test('R48d page 1 is fine and page 2 fails: the whole opened family is dark, no bar from page 1 (M13)', async () => {
  // Breaks when the reader keeps the pages it read.
  const pager = (c) => (pageOf(c.args.join(' ')) === 1 ? JSON.stringify(itemsOn(1, 100)) : ghDown());
  assert.deepEqual(opened(pager).result, { ok: false, reason: 'unreachable' });
  const w = world({ handlers: { pager } });
  assert.equal(await main(w.argv, w.deps), 0, w.errs.join('\n'));
  const byId = rowsById(w);
  assert.deepEqual(Object.keys(byId).filter((id) => id.startsWith('prpr.prs.opened.')), ['prpr.prs.opened.note']);
});

test('R50 the pager is a GET with the jq cut: no write method, no field flag, no merged_at', () => {
  // Breaks when the call becomes a write or loses the jq cut.
  const { f } = opened(() => '[]');
  const args = f.calls[0].args;
  const flat = args.join(' ');
  assert.equal(args[0], 'api');
  assert.equal(args[args.indexOf('-X') + 1], 'GET');
  assert.ok(args.includes('--jq'));
  assert.match(flat, /per_page=100/);
  assert.match(flat, /sort=created/);
  assert.match(flat, /state=all/);
  assert.match(flat, /repos\/o\/r\/pulls\?/);
  assert.ok(!/merged_at/.test(args[args.indexOf('--jq') + 1]), 'the jq filter does not read merged_at');
  assert.ok(!args.some((a) => /^(POST|PATCH|PUT|DELETE)$/.test(a)) && !args.includes('-f') && !args.includes('-F'));
  assert.equal(f.calls[0].opts.windowsHide, true);
});

test('R51 the git call names main, never HEAD, with --since as a UTC instant 90 days before the grid start', async () => {
  // Breaks when HEAD replaces main (M10), --since becomes a bare day, or the 90 changes.
  const w = world();
  assert.equal(await main(w.argv, w.deps), 0, w.errs.join('\n'));
  const call = w.calls.find((c) => c.kind === 'git');
  assert.equal(call.file, 'git');
  assert.deepEqual(call.args, ['log', '--first-parent', 'main', '--since', '2026-07-28T00:00:00Z', '--no-show-signature', '--format=%P%x1f%ct%x1f%s']);
  assert.ok(!call.args.includes('HEAD'));
  assert.equal(call.opts.cwd, w.d, '--git-root is the cwd');
  assert.equal(call.opts.timeout, 10_000);
});

test('R51b the git call turns signature lines off, so log.showSignature=true cannot add malformed lines (N3)', () => {
  // Breaks when --no-show-signature is dropped from the git args.
  const f = fakeRun();
  EX.readLanded({ cwd: '/x', since: '2026-07-28T00:00:00Z' }, readerDeps(f.run));
  assert.ok(f.calls[0].args.includes('--no-show-signature'), f.calls[0].args.join(' '));
});

test('R53 a reader leaves the caller deps untouched: no ghBudget is written into them (N2)', () => {
  // Breaks when a reader writes its gh budget into the caller's deps (`deps.ghBudget ??=`).
  const make = (run) => Object.freeze({ run, err: () => {}, clock: () => 0 });
  const f = fakeRun();
  const d1 = make(f.run);
  assert.deepEqual(EX.readOpened({ repo: 'o/r', start: '2026-10-26' }, d1).ok, true);
  assert.equal('ghBudget' in d1, false);
  const d2 = make(f.run);
  assert.equal(EX.readMergedWeek(MW, d2).ok, true);
  assert.equal('ghBudget' in d2, false);
});

test('R53b a budget the caller passes is still shared across its calls (the collector relies on it)', () => {
  // Breaks when a reader ignores deps.ghBudget and starts a new one.
  const budget = { start: 0 };
  const f = fakeRun({ search: () => { throw new Error('must not run'); } });
  const r = EX.readMergedWeek(MW, readerDeps(f.run, { ghBudget: budget, clock: () => 41_000 }));
  assert.deepEqual(r, { ok: false, reason: 'unreachable' });
  assert.equal(f.calls.length, 0, 'the caller budget was already used up, so no call is made');
});

const MW = { repo: 'o/r', weekStart: '2026-11-03', from: '2026-11-03T06:00:00Z', to: '2026-11-10T05:55:01.000Z' };
const search = (reply, mw = MW) => {
  const f = fakeRun({ search: typeof reply === 'function' ? reply : () => reply });
  return { f, result: EX.readMergedWeek(mw, readerDeps(f.run)) };
};

test('R52 readMergedWeek: the exact merged: literal, a GET, base:main, one integer; 0 is trusted; a non-integer or a failure is "unreachable"', () => {
  // Breaks when the bound is UTC midnight (M16), the upper bound or base:main is missing, a non-integer passes, or a failure is a number.
  const ok = search('{"total_count": 173}');
  assert.deepEqual(ok.result, { ok: true, apiCount: 173, weekStart: '2026-11-03' });
  const args = ok.f.calls[0].args;
  assert.equal(ok.f.calls.length, 1);
  assert.equal(args[args.indexOf('-X') + 1], 'GET');
  assert.equal(args[args.indexOf('--jq') + 1], '.total_count');
  const url = args.find((a) => a.includes('search/issues'));
  for (const part of ['is:pr', 'base:main', 'per_page=1', 'repo:o/r', 'merged:2026-11-03T06:00:00Z..2026-11-10T05:55:01.000Z']) assert.ok(url.includes(part), `${part} in ${url}`);
  assert.ok(!args.some((a) => /^(POST|PATCH|PUT|DELETE)$/.test(a)) && !args.includes('-f') && !args.includes('-F'));
  assert.deepEqual(search('173\n').result, { ok: true, apiCount: 173, weekStart: '2026-11-03' }, 'gh prints the bare integer when --jq cuts');
  assert.equal(search('{"total_count": 0}').result.apiCount, 0, 'a 0 that passes the guard is trusted');
  for (const bad of ['{"total_count": "173"}', '{}', '{"total_count": -1}', '{"total_count": 1.5}', 'not json', '']) {
    assert.deepEqual(search(bad).result, { ok: false, reason: 'unreachable' }, bad);
  }
  assert.deepEqual(search(ghDown).result, { ok: false, reason: 'unreachable' });
  assert.deepEqual(search(() => { throw TIMEOUT(); }).result, { ok: false, reason: 'unreachable' });
});

test('R52 a malformed bound makes no call and is "reader error" (GitHub would answer 0 with exit 0) (M20)', () => {
  // Breaks when the bound guard is dropped.
  for (const mw of [{ ...MW, to: '2026-11-10T05:55:01.XYZZ' }, { ...MW, from: '2026-11-03' }, { ...MW, from: '2026-13-45T00:00:00Z' }, { ...MW, to: '2026-11-10T05:55:01.12Z' }]) {
    const s = search('{"total_count": 0}', mw);
    assert.deepEqual(s.result, { ok: false, reason: 'reader error' }, JSON.stringify(mw));
    assert.equal(s.f.calls.length, 0, 'no call is made');
  }
});

test('R52 through main: the week starts at Chicago midnight, the check agrees when the counts match, a search failure darkens the check only', async () => {
  // Breaks when the collector passes the wrong weekStart, a UTC-midnight from, or lets a search failure darken opened.
  const w = world({ handlers: { search: () => '3' } });
  assert.equal(await main(w.argv, w.deps), 0, w.errs.join('\n'));
  const url = w.calls.find((c) => c.kind === 'search').args.find((a) => a.includes('search/issues'));
  assert.ok(url.includes('merged:2026-11-02T06:00:00Z..2026-11-08T20:00:00.000Z'), url);
  const check = rowsById(w)['prpr.prs.landed.check'];
  assert.deepEqual([check.text, check.value, check.kind], ['GitHub agrees', 0, 'figure']);
  assert.ok(w.logs.includes('prpr.prs.check: 3 merged this week'));
  const w2 = world({ handlers: { search: ghDown } });
  assert.equal(await main(w2.argv, w2.deps), 0, w2.errs.join('\n'));
  const byId = rowsById(w2);
  assert.ok(byId['prpr.prs.opened.bar.14'], 'opened stays');
  assert.equal(byId['prpr.prs.landed.check'], undefined);
  assert.equal(byId['prpr.prs.opened.note'], undefined);
});
