/**
 * learning-counts.test.mjs -- card coord-seat-counts, part C, tests with no database: a fake client stands in for the memory store.
 * The tests that need Postgres (week edges, the real query, the real read-only opener) are in learning-counts-db.test.mjs.
 * LEARNING_COUNTS_CLI points the tests at another copy of the script (a mutation run). Names C1, C3, C4, C5, C7 are the failure list of the note.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openReadOnly } from './export-dash-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.LEARNING_COUNTS_CLI ? path.resolve(process.env.LEARNING_COUNTS_CLI) : path.join(HERE, 'learning-counts.mjs');
const load = () => import(pathToFileURL(SCRIPT).href);

// A fake store client. SHOW answers the read-only setting; every other query answers the rows. `log` records the statements.
const fake = (rows, { readOnly = 'on', log = [] } = {}) => async () => ({
  query: async (sql, params) => { log.push(String(sql).trim().split(/\s/)[0]); if (params) log.params = params; return /^\s*SHOW/i.test(sql) ? { rows: [{ transaction_read_only: readOnly }] } : { rows }; },
  end: async () => {},
});
const run = async (argv, rows, opts) => (await load()).run(argv, { open: fake(rows, opts) });

describe('part C: the count', () => {
  it('C1: only week, learning type, source and count reach the output; any word outside the allowlist becomes OTHER', async () => {
    const rows = [
      { week: '2026-11-09', learning_type: 'WORKING_SOLUTION', source: 'hook', n: 3, content: 'zebra-quartz-secret text', session_id: 'abcd1234-aaaa', metadata: { x: 1 } },
      { week: '2026-11-09', learning_type: 'a long free text that is not a type word at all, really', source: 'hook', n: 1 },
      { week: '2026-11-16', learning_type: 'WORKING_SOLUTION', source: 'manual', n: 2 },
      { week: '2026-11-16', learning_type: null, source: null, n: 4 },
    ];
    const r = await run([], rows);
    assert.equal(r.code, 0, r.err);
    for (const bad of ['zebra-quartz-secret', 'abcd1234', 'free text', 'metadata']) assert.ok(!r.out.includes(bad), `output holds "${bad}"`);
    const j = JSON.parse(r.out);
    assert.deepEqual(j.weeks.map((w) => [w.week, w.total]), [['2026-11-09', 4], ['2026-11-16', 6]]);
    assert.deepEqual(j.weeks[0].bySource, { hook: 4 });
    assert.deepEqual(j.weeks[0].byType, { OTHER: 1, WORKING_SOLUTION: 3 });
    assert.deepEqual(j.weeks[1].bySource, { NONE: 4, manual: 2 });
    assert.equal(j.hookTotal, 4);
  });

  it('C7: a session uuid, an 8-hex prefix, a path, a number or a phrase in a type or a source is OTHER, never printed', async () => {
    const odd = ['0f66d777-567c-41c4-b503-6f1779156c75', '0f66d777', 'C:/Users/someone/file.txt', '1234567890', 'two words'];
    const rows = odd.map((v) => ({ week: '2026-11-09', learning_type: v, source: v, n: 1 }));
    const r = await run([], rows);
    assert.equal(r.code, 0, r.err);
    for (const v of odd) assert.ok(!r.out.includes(v), `output holds "${v}"`);
    const w = JSON.parse(r.out).weeks[0];
    assert.deepEqual(w.bySource, { OTHER: 5 });
    assert.deepEqual(w.byType, { OTHER: 5 });
    // The allowlist words stay as they are.
    const ok = JSON.parse((await run([], [{ week: '2026-11-09', learning_type: 'OPEN_THREAD', source: 'llm', n: 2 }])).out).weeks[0];
    assert.deepEqual([ok.bySource, ok.byType], [{ llm: 2 }, { OPEN_THREAD: 2 }]);
  });

  it('C3: no row in the window exits 2 with one line and prints nothing', async () => {
    const r = await run([], []);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
    assert.match(r.err, /no learning stored/i);
    assert.equal(r.err.trim().split('\n').length, 1);
  });

  it('C4: a connection that is not read-only is refused before any query, and the default opener is the read-only one', async () => {
    const m = await load();
    assert.equal(m.defaultOpen, openReadOnly);
    const log = [];
    const r = await m.run([], { open: fake([{ week: '2026-11-09', learning_type: 'ERROR_FIX', source: 'hook', n: 1 }], { readOnly: 'off', log }) });
    assert.equal(r.code, 4);
    assert.equal(r.out, '');
    assert.deepEqual(log.filter((s) => s !== 'ROLLBACK'), ['SHOW'], 'a data query ran on a connection that is not read-only');
  });

  it('C5: a bad argument is a usage error, exit 1, and the store is not opened', async () => {
    let opened = false;
    const m = await load();
    for (const argv of [['--weeks', '0'], ['--weeks', 'x'], ['--weeks', '521'], ['--bogus'], ['--weeks'], ['--now', 'not a time'], ['--root', 'x']]) {
      const r = await m.run(argv, { open: async () => { opened = true; return fake([])(); } });
      assert.equal(r.code, 1, JSON.stringify(argv));
    }
    assert.equal(opened, false);
  });

  it('C10: --now goes to the query as one ISO instant (a date-only value is read as UTC, not in the session time zone of Postgres)', async () => {
    const log = [];
    const m = await load();
    const r = await m.run(['--now', '2026-11-18', '--weeks', '3'], { open: fake([{ week: '2026-11-16', learning_type: 'ERROR_FIX', source: 'hook', n: 1 }], { log }) });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(log.params, ['2026-11-18T00:00:00.000Z', 3]);
  });

  it('C9: a store that cannot be read is exit 4 with one fixed line (no url, no stack)', async () => {
    const m = await load();
    const r = await m.run([], { open: async () => { throw new Error('connect ECONNREFUSED postgresql://claude:secret@localhost:5432/x'); } });
    assert.equal(r.code, 4);
    assert.ok(!r.err.includes('secret') && !r.err.includes('postgresql'));
    assert.equal(r.err.trim().split('\n').length, 1);
  });
});
