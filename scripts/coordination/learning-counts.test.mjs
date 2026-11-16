/**
 * learning-counts.test.mjs -- card coord-seat-counts, part C, tests with no database: a fake client stands in for the memory store.
 * The tests that need Postgres (week edges, the real query) are in learning-counts-db.test.mjs.
 * LEARNING_COUNTS_CLI points the tests at another copy of the script (a mutation run). Names C1, C3, C4 are the failure list of the note.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openReadOnly } from './export-dash-data.mjs';
import { DATASET_REL, EVAL_CONFIG_REL } from './board-mask.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.LEARNING_COUNTS_CLI ? path.resolve(process.env.LEARNING_COUNTS_CLI) : path.join(HERE, 'learning-counts.mjs');
const load = () => import(pathToFileURL(SCRIPT).href);
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-counts-root-'));

const fake = (rows) => async () => ({ query: async () => ({ rows }), end: async () => {} });
const run = async (argv, rows) => (await load()).run(argv, { open: fake(rows) });

describe('part C: the count', () => {
  it('C1: only week, learning type, source and count reach the output; free text in a type or a source becomes OTHER', async () => {
    const rows = [
      { week: '2026-11-09', learning_type: 'WORKING_SOLUTION', source: 'hook', n: 3, content: 'zebra-quartz-secret text', session_id: 'abcd1234-aaaa', metadata: { x: 1 } },
      { week: '2026-11-09', learning_type: 'a long free text that is not a type word at all, really', source: 'hook', n: 1 },
      { week: '2026-11-16', learning_type: 'WORKING_SOLUTION', source: 'manual', n: 2 },
      { week: '2026-11-16', learning_type: null, source: null, n: 4 },
    ];
    const r = await run(['--root', EMPTY], rows);
    assert.equal(r.code, 0, r.err);
    for (const bad of ['zebra-quartz-secret', 'abcd1234', 'free text', 'metadata']) assert.ok(!r.out.includes(bad), `output holds "${bad}"`);
    const j = JSON.parse(r.out);
    assert.deepEqual(j.weeks.map((w) => [w.week, w.total]), [['2026-11-09', 4], ['2026-11-16', 6]]);
    const w0 = j.weeks[0];
    assert.deepEqual(w0.bySource, { hook: 4 });
    assert.deepEqual(w0.byType, { OTHER: 1, WORKING_SOLUTION: 3 });
    assert.deepEqual(j.weeks[1].bySource, { NONE: 4, manual: 2 });
    assert.equal(j.hookTotal, 4);
  });

  it('C3: no row in the window exits 2 with one line and prints nothing', async () => {
    const r = await run(['--root', EMPTY], []);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
    assert.match(r.err, /no learning stored/i);
    assert.equal(r.err.trim().split('\n').length, 1);
  });

  it('C4: the default connection is the read-only opener of export-dash-data', async () => {
    const m = await load();
    assert.equal(m.defaultOpen, openReadOnly);
  });

  it('C7: a listed id in a source word stops the run with exit 3 and no output; an unreadable list does too', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-counts-ids-'));
    fs.mkdirSync(path.join(root, '.claudedocs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts', 'eval', 'review-eval'), { recursive: true });
    fs.writeFileSync(path.join(root, DATASET_REL), JSON.stringify({ prs: [{ pr: 7654321 }], findings: [{ pr: 7654321, comment_id: 1234567890 }] }));
    fs.writeFileSync(path.join(root, EVAL_CONFIG_REL), '{}');
    // A source that is only digits passes the word pattern: the final pass is what stops it.
    const hit = await run(['--root', root], [{ week: '2026-11-09', learning_type: 'WORKING_SOLUTION', source: '1234567890', n: 1 }]);
    assert.equal(hit.code, 3);
    assert.equal(hit.out, '');
    assert.ok(!hit.err.includes('1234567890'));
    const clean = await run(['--root', root], [{ week: '2026-11-09', learning_type: 'WORKING_SOLUTION', source: 'hook', n: 1 }]);
    assert.equal(clean.code, 0, clean.err);
    fs.writeFileSync(path.join(root, DATASET_REL), '{ not json 4242');
    const bad = await run(['--root', root], [{ week: '2026-11-09', learning_type: 'X', source: 'hook', n: 1 }]);
    assert.equal(bad.code, 3);
    assert.ok(!bad.err.includes('4242'));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('C5: a bad argument is a usage error, exit 1, and the store is not opened', async () => {
    let opened = false;
    const m = await load();
    for (const argv of [['--weeks', '0'], ['--weeks', 'x'], ['--bogus'], ['--weeks']]) {
      const r = await m.run(argv, { open: async () => { opened = true; return fake([])(); } });
      assert.equal(r.code, 1, JSON.stringify(argv));
    }
    assert.equal(opened, false);
  });
});
