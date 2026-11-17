/**
 * learning-counts-db.test.mjs -- card coord-seat-counts, part C, tests on a SCRATCH Postgres (scratch-db.mjs). Never the live database:
 * the scratch url is passed on every call and assertScratchUrl refuses any other name. A missing scratch url fails with one line (no skip,
 * no default url). Names C2, C6, C8 are the failure list of the note.
 * LEARNING_COUNTS_CLI points the tests at another copy of the script (a mutation run).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl } from './scratch-db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const SCRIPT = process.env.LEARNING_COUNTS_CLI ? path.resolve(process.env.LEARNING_COUNTS_CLI) : path.join(HERE, 'learning-counts.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');
const { Client } = requireDep('pg', { repoRoot: REPO });

const s = { url: '', db: null };

before(async () => {
  const c = spawnSync(process.execPath, [SCRATCH, 'create', '--through', '6'], { encoding: 'utf8', windowsHide: true });
  assert.equal(c.status, 0, `scratch create failed: ${c.stderr}`);
  s.url = JSON.parse(c.stdout).url;
  // Never a skip and never a default url (seat condition): a missing scratch url is one failing line.
  assert.ok(s.url, 'learning-counts-db: the scratch database url is missing');
  assertScratchUrl(s.url);
  s.db = new Client({ connectionString: s.url });
  await s.db.connect();
  // The scratch database holds this table when init-schema.sql applied whole (local, pgvector present) and not when it fell back to the
  // minimal schema (CI): the test never assumes either. It drops and makes the table in the throwaway database (assertScratchUrl above).
  // Columns of docker/init-schema.sql, without the embedding column (it needs the vector extension).
  await s.db.query('DROP TABLE IF EXISTS archival_memory CASCADE');
  await s.db.query(`CREATE TABLE archival_memory (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id text NOT NULL, agent_id text, project_id text,
    scope text CHECK (scope IN ('PROJECT', 'GLOBAL')) DEFAULT 'PROJECT', content text NOT NULL, metadata jsonb DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(), valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz)`);
  const ins = (at, source, type) => s.db.query(`INSERT INTO archival_memory (session_id, content, metadata, created_at) VALUES ('s', 'zebra-quartz-secret', $1, $2)`, [JSON.stringify({ source, learning_type: type, type: 'session_learning' }), at]);
  await ins('2026-11-09T05:59:00Z', 'hook', 'WORKING_SOLUTION'); // Sunday 23:59 in Chicago: the week of 2026-11-02
  await ins('2026-11-09T06:01:00Z', 'manual', 'ERROR_FIX'); // Monday 00:01 in Chicago: the week of 2026-11-09
  await ins('2026-11-16T05:30:00Z', 'hook', 'WORKING_SOLUTION'); // Sunday 23:30 in Chicago: the week of Monday 2026-11-09
  await ins('2026-11-16T06:30:00Z', 'hook', 'WORKING_SOLUTION'); // Monday 00:30 in Chicago: the week of 2026-11-16
  await ins('2026-11-17T12:00:00Z', 'manual', 'FAILED_APPROACH');
  await ins('2026-01-05T12:00:00Z', 'hook', 'WORKING_SOLUTION'); // far outside an 8 week window
});

after(async () => {
  await s.db?.end().catch(() => {});
  if (s.url) { assertScratchUrl(s.url); spawnSync(process.execPath, [SCRATCH, 'drop', s.url], { encoding: 'utf8', windowsHide: true }); }
});

const cli = (extra = []) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--now', '2026-11-18T00:00:00Z', ...extra], { encoding: 'utf8', env: { ...process.env, CONTINUOUS_CLAUDE_DB_URL: s.url, DATABASE_URL: '', OPC_POSTGRES_URL: '' } });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};

describe('part C on a scratch database', () => {
  it('C2: weeks run Monday to Sunday in Chicago time; rows outside the window are not counted', () => {
    const r = cli(['--weeks', '8']);
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out);
    assert.deepEqual(j.weeks.map((w) => [w.week, w.total]), [['2026-11-02', 1], ['2026-11-09', 2], ['2026-11-16', 2]]);
    assert.deepEqual(j.weeks[1].bySource, { hook: 1, manual: 1 });
    assert.deepEqual(j.weeks[2].bySource, { hook: 1, manual: 1 });
    assert.deepEqual(j.weeks[2].byType, { FAILED_APPROACH: 1, WORKING_SOLUTION: 1 });
    assert.equal(j.hookTotal, 3);
  });

  it('C8: N weeks start at the Chicago Monday N-1 weeks back, so the oldest week is whole', () => {
    const r = cli(['--weeks', '2']);
    assert.equal(r.code, 0, r.err);
    // The row of Sunday 23:59 (week 2026-11-02) is outside; the row of Monday 00:01 (week 2026-11-09) is inside.
    assert.deepEqual(JSON.parse(r.out).weeks.map((w) => [w.week, w.total]), [['2026-11-09', 2], ['2026-11-16', 2]]);
    assert.deepEqual(JSON.parse(cli(['--weeks', '1']).out).weeks.map((w) => [w.week, w.total]), [['2026-11-16', 2]]);
  });

  it('C6: the real query goes through the read-only opener, returns counts only and changes nothing in the table', async () => {
    const before = (await s.db.query('SELECT count(*)::int AS n FROM archival_memory')).rows[0].n;
    const r = cli(['--weeks', '8']);
    assert.equal(r.code, 0, r.err); // a plain (not read-only) client makes the script exit 4
    for (const bad of ['zebra-quartz-secret', 'session_id', '"s"']) assert.ok(!r.out.includes(bad), `output holds ${bad}`);
    assert.equal((await s.db.query('SELECT count(*)::int AS n FROM archival_memory')).rows[0].n, before);
    // A window with no row exits 2.
    assert.equal(cli(['--weeks', '1', '--now', '2026-03-01T00:00:00Z']).code, 2);
  });
});
