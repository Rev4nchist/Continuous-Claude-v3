#!/usr/bin/env node
/**
 * learning-counts -- a weekly count of the learnings the memory hooks stored (card coord-seat-counts, part C).
 * Design note: .claudedocs/coordination/2026-11-16-coord-seat-counts-design.md. Dave (milestone 726): keep the hooks, add a weekly count.
 *
 * One read-only query on archival_memory (the table store_learning.py writes): rows per Chicago week (Monday to Sunday), per
 * metadata.learning_type and per metadata.source. It selects no content and no session id. The READ ONLY transaction comes from
 * openReadOnly of export-dash-data.mjs, and the run refuses to read when the connection says transaction_read_only is not on.
 * A type or a source word that is not in the allowlist below becomes OTHER, so no free text, no session id and no listed id can reach the
 * output: only week dates, allowlisted words and counts. Counts say how many learnings were stored, not whether they were good.
 * No pass line: 2 weeks of baseline first.
 *
 * Usage: node scripts/coordination/learning-counts.mjs [--weeks N] [--now <iso>]
 * N weeks = the Chicago week of --now (partial) and the N-1 full weeks before it. The database url is the chain of lane.mjs
 * (CONTINUOUS_CLAUDE_DB_URL, DATABASE_URL, OPC_POSTGRES_URL, the local default). Tests set it to a scratch database.
 * Exit: 0 ok | 1 usage | 2 no learning stored in the window | 4 the store could not be read, or it is not read-only.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connString, openReadOnly } from './export-dash-data.mjs';

export const defaultOpen = openReadOnly;

// opc/scripts/core/memory_candidate.py: LearningType and Source.
export const LEARNING_TYPES = ['FAILED_APPROACH', 'WORKING_SOLUTION', 'USER_PREFERENCE', 'CODEBASE_PATTERN', 'ARCHITECTURAL_DECISION', 'ERROR_FIX', 'OPEN_THREAD'];
export const SOURCES = ['hook', 'manual', 'handoff', 'llm'];
const word = (v, allowed) => (v === null || v === undefined || v === '' ? 'NONE' : allowed.includes(String(v)) ? String(v) : 'OTHER');

const SQL = `SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'America/Chicago'), 'YYYY-MM-DD') AS week,
       metadata->>'learning_type' AS learning_type, metadata->>'source' AS source, count(*)::int AS n
FROM archival_memory
WHERE created_at <= $1::timestamptz
  AND created_at >= (date_trunc('week', $1::timestamptz AT TIME ZONE 'America/Chicago') - make_interval(weeks => $2::int - 1)) AT TIME ZONE 'America/Chicago'
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;

/** Counts per week from query rows. Only week, learning_type, source and n are read: any other field of a row is ignored. */
export function formatCounts(rows) {
  const weeks = new Map();
  for (const r of rows) {
    const w = weeks.get(r.week) || weeks.set(r.week, { week: String(r.week), total: 0, bySource: {}, byType: {} }).get(r.week);
    const n = Number(r.n) || 0;
    const src = word(r.source, SOURCES);
    const typ = word(r.learning_type, LEARNING_TYPES);
    w.total += n;
    w.bySource[src] = (w.bySource[src] || 0) + n;
    w.byType[typ] = (w.byType[typ] || 0) + n;
  }
  const list = [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
  return { weeks: list, hookTotal: list.reduce((s, w) => s + (w.bySource.hook || 0), 0) };
}

function parseArgs(argv) {
  const a = { weeks: 8, now: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!['--weeks', '--now'].includes(k)) throw new Error('unknown argument');
    if (v === undefined || v.startsWith('--')) throw new Error('missing value');
    if (k === '--weeks') { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 520) throw new Error('bad weeks'); a.weeks = n; }
    else { const t = Date.parse(v); if (!Number.isFinite(t)) throw new Error('bad time'); a.now = new Date(t).toISOString(); }
    i++;
  }
  return a;
}

/** { code, out, err } of one run. `open` opens the store client (a test passes a fake). */
export async function run(argv, { open = defaultOpen } = {}) {
  let a;
  try { a = parseArgs(argv); } catch (e) { return { code: 1, out: '', err: `learning-counts: ${e.message}\n` }; }
  let rows;
  let client = null;
  try {
    client = await open(connString());
    const ro = await client.query('SHOW transaction_read_only');
    if (!ro.rows.length || String(Object.values(ro.rows[0])[0]) !== 'on') {
      return { code: 4, out: '', err: 'learning-counts: the store connection is not read-only; no query run\n' };
    }
    rows = (await client.query(SQL, [a.now || new Date().toISOString(), a.weeks])).rows;
  } catch {
    return { code: 4, out: '', err: 'learning-counts: the memory store could not be read; no output\n' };
  } finally {
    if (client) { await client.query('ROLLBACK').catch(() => {}); await client.end().catch(() => {}); }
  }
  if (!rows.length) return { code: 2, out: '', err: `learning-counts: no learning stored in the last ${a.weeks} weeks\n` };
  return { code: 0, out: `${JSON.stringify({ weeks: a.weeks, ...formatCounts(rows) }, null, 1)}\n`, err: '' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await run(process.argv.slice(2));
  process.stdout.write(r.out);
  process.stderr.write(r.err);
  process.exitCode = r.code;
}
