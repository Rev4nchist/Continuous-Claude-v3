#!/usr/bin/env node
/**
 * Proves the SQL of the one-file release (card coord-file-claim-release-one) on a scratch database.
 * The statements are OWN_ROWS_SQL, DELETE_ONE_SQL and HOLDER_SQL in .claude/hooks/src/shared/claim-release.ts and
 * INSERT_EVENT in coordination-events.ts, read out of those sources at run time (same rule as
 * list-claims-sql-probe.mjs: a copy here would be the drift).
 *
 * What this proves: the DELETE frees only the holder's row (session_id is in the WHERE), only the row of that
 * project, the event is one row with reason one-file, no event row when nothing is freed, and the delete and the
 * event roll back together when the event insert fails. What it does not prove: the JS decision (which row a typed
 * path fits, the seat rule, "a dropped event throws"). The vitest file claim-release.test.ts proves those.
 * The transaction below is a replay of releaseInTransaction in the same order of statements.
 *
 * Usage: node scripts/coordination/release-one-probe.mjs
 * Scratch database only (rule O3.9): CONTINUOUS_CLAUDE_DB_URL from `scratch-db.mjs create` (name lanes_pr1_*).
 * Exits non-zero on any failed case. Removes its own fixtures.
 */
import { readFileSync } from 'node:fs';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl, dbNameOf } from './scratch-db.mjs';

const DB_URL = process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL || process.env.OPC_POSTGRES_URL || '';
try { assertScratchUrl(DB_URL); } catch {
  process.stderr.write(`release-one-probe: refusing to run: database '${dbNameOf(DB_URL) || '(no name)'}' is not a scratch database. `
    + "Set CONTINUOUS_CLAUDE_DB_URL to one made by 'node scripts/coordination/scratch-db.mjs create' (name starts with lanes_pr1_).\n");
  process.exit(2);
}
let pg;
try { pg = requireDep('pg'); } catch (e) { console.error(`release-one-probe: ${e.message}`); process.exit(2); }

const P1 = '__rprobe_p1__';
const P2 = '__rprobe_p2__';
const ME = 'rprobe-me';
const OTHER = 'rprobe-other';

/** The text of `<marker>...` up to the closing backtick. Fails loudly when the source moved. */
function extractConst(path, marker, tokens) {
  const src = readFileSync(new URL(path, import.meta.url), 'utf-8');
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`release-one-probe: ${marker} not found in ${path}. Update this extractor; never paste a copy.`);
  let out = '';
  let i = start + marker.length;
  for (; i < src.length; i++) {
    if (src[i] === '\\' && src[i + 1] === '`') { out += '`'; i++; continue; }
    if (src[i] === '`') break;
    out += src[i];
  }
  if (i >= src.length) throw new Error(`release-one-probe: unterminated literal for ${marker}`);
  for (const t of tokens) if (!out.includes(t)) throw new Error(`release-one-probe: ${marker} is missing ${t}: truncated or changed`);
  return out;
}
const CR = '../../.claude/hooks/src/shared/claim-release.ts';
const OWN_SQL = extractConst(CR, 'export const OWN_ROWS_SQL = `', ['file_claims', 'session_id = $1']);
const DELETE_SQL = extractConst(CR, 'export const DELETE_ONE_SQL = `', ['DELETE FROM file_claims', 'RETURNING']);
const HOLDER_SQL = extractConst(CR, 'export const HOLDER_SQL = `', ['file_claims', 'project = $2']);
const INSERT_EVENT = extractConst('../../.claude/hooks/src/shared/coordination-events.ts', 'const INSERT_EVENT = `', ['coordination_event', '$7::jsonb']);

const results = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(got)}${ok ? '' : ` (wanted ${JSON.stringify(want)})`}`);
}

/** Replay of releaseInTransaction for ONE row: BEGIN, DELETE, event only when a row went, COMMIT. */
async function releaseTx(c, session, file, project, detail = '{"reason":"one-file"}') {
  await c.query('BEGIN');
  try {
    const res = await c.query(DELETE_SQL, [file, project, session]);
    if (res.rows.length > 0) {
      await c.query('SAVEPOINT coordination_event');
      try {
        await c.query(INSERT_EVENT, ['claim_released', session, null, null, null, null, detail]);
        await c.query('RELEASE SAVEPOINT coordination_event');
      } catch {
        await c.query('ROLLBACK TO SAVEPOINT coordination_event');
        throw new Error('event dropped');
      }
    }
    await c.query('COMMIT');
    return res.rows.length;
  } catch (e) {
    await c.query('ROLLBACK');
    return `rolled back: ${e.message}`;
  }
}

const eventsOf = async (c, session) => (await c.query(
  `SELECT detail FROM agentic_os.coordination_event WHERE session_id = $1 AND kind = 'claim_released'`, [session])).rows.map((r) => r.detail);
const filesOf = async (c, session) => (await c.query(OWN_SQL, [session])).rows.filter((r) => r.project === P1 || r.project === P2).map((r) => `${r.file_path}@${r.project}`);

async function clean(c) {
  await c.query('DELETE FROM file_claims WHERE project = ANY($1)', [[P1, P2]]);
  await c.query("DELETE FROM agentic_os.coordination_event WHERE session_id LIKE 'rprobe-%'");
}
async function seed(c) {
  await clean(c);
  const claim = (f, p, s) => c.query('INSERT INTO file_claims (file_path, project, session_id) VALUES ($1, $2, $3)', [f, p, s]);
  await claim('src/a.ts', P1, ME);
  await claim('src/b.ts', P1, ME);
  await claim('src/a.ts', P2, ME);
  await claim('src/c.ts', P1, OTHER);
}

async function main() {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 4000 });
  c.on('error', () => {});
  await c.connect();
  try {
    await seed(c);
    check('0 the own-rows read returns the caller rows only', await filesOf(c, ME), [`src/a.ts@${P1}`, `src/a.ts@${P2}`, `src/b.ts@${P1}`]);

    check('1 the holder frees one row', await releaseTx(c, ME, 'src/a.ts', P1), 1);
    check('1b the other claims of the holder stay (same file in another project, another file)', await filesOf(c, ME), [`src/a.ts@${P2}`, `src/b.ts@${P1}`]);
    check('1c exactly one claim_released event with reason one-file', (await eventsOf(c, ME)).map((d) => d.reason), ['one-file']);

    check('2 a non-holder frees 0 rows', await releaseTx(c, OTHER, 'src/b.ts', P1), 0);
    check('2b the row is still the holder row', (await c.query(HOLDER_SQL, ['src/b.ts', P1])).rows.map((r) => r.session_id), [ME]);
    check('2c no event row when nothing is freed', (await eventsOf(c, OTHER)).length, 0);

    check('3 the not-holder read names the holder of that key only', (await c.query(HOLDER_SQL, ['src/c.ts', P1])).rows, [{ session_id: OTHER }]);
    check('3b a key nobody holds reads as no row', (await c.query(HOLDER_SQL, ['src/zzz.ts', P1])).rows.length, 0);

    // delete + event in ONE transaction: an invalid event detail makes the insert fail, the whole thing rolls back
    const before = await filesOf(c, ME);
    const out = await releaseTx(c, ME, 'src/b.ts', P1, 'not json{');
    check('4 a failing event insert rolls the delete back too', out, 'rolled back: event dropped');
    check('4b the claim is still held after the rollback', await filesOf(c, ME), before);
    check('4c no new event row after the rollback', (await eventsOf(c, ME)).length, 1);
  } finally {
    await clean(c).catch(() => {});
    await c.end();
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} of ${results.length} cases passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(`release-one-probe: ${e.message}`); process.exit(2); });
