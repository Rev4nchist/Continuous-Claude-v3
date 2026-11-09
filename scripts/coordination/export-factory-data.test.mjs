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
import { buildFactoryRows } from './factory-rows.mjs';

const NOW = '2026-11-08T20:00:00.000Z';
const tmp = () => mkdtempSync(path.join(tmpdir(), 'factory-test-'));
const put = (dir, name, text) => { const f = path.join(dir, name); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); return f; };
const jsonl = (rows, eol = '\n') => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join(eol) + eol;
const quiet = () => ({ err: () => {}, log: () => {} });

const HEX40 = '0123456789abcdef0123456789abcdef01234567';
const good = (i, extra = {}) => ({ ts: `2026-11-08T1${i}:00:00.000Z`, run_id: `run-${i}`, head: HEX40, status: 'PASS', step: 'x', ...extra });
const read = (file, family, deps = {}) => readJsonlFamily(file, family, NOW, { ...quiet(), ...deps });

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

function world({ dark = false, extra = {} } = {}) {
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
  const argv = ['--out', f.out, '--gates', f.gates, '--reviews', f.reviews, '--coderabbit', f.coderabbit, '--handoffs', f.handoffs, '--router-config', f.routerConfig, '--dash-config', f.dashConfig];
  const logs = [];
  const errs = [];
  const deps = { now: () => NOW, log: (m) => logs.push(m), err: (m) => errs.push(m) };
  return { d, f, argv, logs, errs, deps, file: path.join(f.out, 'factory.json') };
}
const readOut = (w) => JSON.parse(readFileSync(w.file, 'utf8'));

test('33 privacy, end to end: no path, branch, head, session id, prompt, finding or handoff body reaches the file or the log', async () => {
  // Breaks when any field leaks. The parsed ids and texts are checked by name; the raw bytes only for the hex patterns
  // (JSON escapes a backslash, so a raw grep for "C:\" could never fail).
  const w = world();
  assert.equal(await main(w.argv, w.deps), 0, w.errs.join('\n'));
  const doc = readOut(w);
  const forbidden = [/SECRET/i, /abcdef12/i, /C:\\/, /Users/, /notion/i, /unowned/i, /feat\//, /secret\.(ts|mjs)/i];
  for (const r of doc.rows) for (const s of [r.id, r.text ?? '']) for (const re of forbidden) assert.ok(!re.test(s), `${r.id}: ${s} matches ${re}`);
  const raw = readFileSync(w.file, 'utf8');
  assert.ok(!/[0-9a-f]{40}/.test(raw), 'a 40-hex head in the raw bytes');
  assert.ok(!/#[0-9a-f]{8}/.test(raw), 'a session handle in the raw bytes');
  assert.ok(!/SECRET|abcdef12/i.test(raw), 'a seeded string in the raw bytes');
  for (const line of w.logs.concat(w.errs)) {
    assert.ok(!/SECRET|abcdef12|[0-9a-f]{40}/i.test(line), `log line leaks: ${line}`);
  }
  const prpr = doc.rows.find((r) => r.id === 'prpr.rows');
  assert.equal(prpr.value, 3);
});

test('33b the log has one counts-only line per family and one for the file', async () => {
  // Breaks when a family or the file has no line, or a line carries a name.
  const w = world();
  await main(w.argv, w.deps);
  assert.equal(w.logs.length, 5, w.logs.join('\n'));
  assert.match(w.logs[0], /^prpr: 3 rows, 0 bad lines, as of 2026-11-08$/);
  assert.match(w.logs[1], /^rev: 2 rows, 0 bad lines, as of 2026-11-04$/);
  assert.match(w.logs[2], /^rev\.coderabbit: 1 rows, 0 bad lines, as of 2026-11-04$/);
  assert.match(w.logs[3], /^hand: 2 files, 0 bad lines, as of 2026-11-08$/);
  assert.match(w.logs[4], /^factory\.json: \d+ rows, \d+ bytes/);
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

test('35 all four families dark: exit 0, the shared rows and four notes', async () => {
  // Breaks when one dark family stops the run, or the run writes nothing.
  const w = world({ dark: true });
  assert.equal(await main(w.argv, w.deps), 0, w.errs.join('\n'));
  const doc = readOut(w);
  const byId = Object.fromEntries(doc.rows.map((r) => [r.id, r]));
  for (const id of ['prpr.note', 'rev.note', 'rev.coderabbit.note', 'hand.note']) assert.equal(byId[id].text, 'no data: missing', id);
  assert.equal(byId['factory.days'].value, 14);
  assert.equal(byId['factory.today'].text, '2026-11-08');
  assert.equal(byId['prpr.prs.note'].text, 'no writer yet');
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
  assert.match(doc.sql, /^Computed in Node by scripts\/coordination\/factory-rows\.mjs from four local files\. No query\.$/);
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
