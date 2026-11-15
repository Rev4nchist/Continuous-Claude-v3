#!/usr/bin/env node
/**
 * Proves the lane read that file-claims uses in a deny (card coord-file-guard-named-file, seat diff read of 68a33182, item 3).
 * The statement is HOLDER_OPEN_LANE_SQL in .claude/hooks/src/shared/holder-lane.ts, read out of that source at run time
 * (the same rule as list-claims-sql-probe.mjs: a copy here would be the drift). Every unit test mocks the lookup, so a wrong
 * table or column name would degrade to "unknown" in silence. This probe runs the real statement against seeded lane rows.
 *
 * Cases: a holder with an open lane gives a row; a holder whose lanes are all done gives none; an unknown session gives none;
 * the state word `done` is the only closed state (a parked or review lane still counts as open).
 *
 * Usage: node scripts/coordination/holder-lane-probe.mjs
 * Runs on a scratch database only (rule O3.9): CONTINUOUS_CLAUDE_DB_URL from `scratch-db.mjs create`.
 * Exits non-zero on any failed case. Removes its own fixtures.
 */
import { readFileSync } from 'node:fs';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl, dbNameOf } from './scratch-db.mjs';

const DB_URL = process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL || process.env.OPC_POSTGRES_URL || '';
try { assertScratchUrl(DB_URL); } catch {
  process.stderr.write(`holder-lane-probe: refusing to run: database '${dbNameOf(DB_URL) || '(no name)'}' is not a scratch database. `
    + "Set CONTINUOUS_CLAUDE_DB_URL to one made by 'node scripts/coordination/scratch-db.mjs create' (name starts with lanes_pr1_).\n");
  process.exit(2);
}
let pg;
try { pg = requireDep('pg'); } catch (e) { console.error(`holder-lane-probe: ${e.message}`); process.exit(2); }

function extractSql() {
  const src = readFileSync(new URL('../../.claude/hooks/src/shared/holder-lane.ts', import.meta.url), 'utf-8');
  const marker = 'export const HOLDER_OPEN_LANE_SQL = `';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('holder-lane-probe: HOLDER_OPEN_LANE_SQL not found in holder-lane.ts. Update this extractor; never paste a copy.');
  const end = src.indexOf('`', start + marker.length);
  if (end === -1) throw new Error('holder-lane-probe: unterminated literal');
  const sql = src.slice(start + marker.length, end);
  for (const token of ['agentic_os.lane', 'owner_session_id', "state <> 'done'", 'LIMIT 1']) {
    if (!sql.includes(token)) throw new Error(`holder-lane-probe: extracted SQL is missing ${token}: truncated or changed`);
  }
  return sql;
}
const SQL = extractSql();

const results = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(got)}${ok ? '' : ` (wanted ${JSON.stringify(want)})`}`);
}

async function main() {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 4000 });
  c.on('error', () => {});
  await c.connect();
  const holds = async (id) => (await c.query(SQL, [id])).rows.length > 0;
  try {
    await c.query("DELETE FROM agentic_os.lane WHERE id LIKE 'hlprobe-%'");
    await c.query(
      `INSERT INTO agentic_os.lane (id, title, state, owner_session_id) VALUES
         ('hlprobe-open',   't', 'active', 'hlprobe-sess-open'),
         ('hlprobe-review', 't', 'review', 'hlprobe-sess-review'),
         ('hlprobe-done',   't', 'done',   'hlprobe-sess-done'),
         ('hlprobe-mixed-a', 't', 'done',   'hlprobe-sess-mixed'),
         ('hlprobe-mixed-b', 't', 'active', 'hlprobe-sess-mixed')`,
    );
    check('holder with an active lane', await holds('hlprobe-sess-open'), true);
    check('holder with a lane in review (parked) still counts as open', await holds('hlprobe-sess-review'), true);
    check('holder whose only lane is done', await holds('hlprobe-sess-done'), false);
    check('holder with one done lane and one active lane', await holds('hlprobe-sess-mixed'), true);
    check('a session that owns no lane', await holds('hlprobe-sess-none'), false);
  } finally {
    await c.query("DELETE FROM agentic_os.lane WHERE id LIKE 'hlprobe-%'").catch(() => {});
    await c.end();
  }
}

main().then(() => {
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} of ${results.length} cases passed`);
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(`holder-lane-probe: ${e.message}`); process.exit(1); });
