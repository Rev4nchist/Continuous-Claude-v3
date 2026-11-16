#!/usr/bin/env node
/**
 * learning-counts -- a weekly count of the learnings the memory hooks stored (card coord-seat-counts, part C).
 * Design note: .claudedocs/coordination/2026-11-16-coord-seat-counts-design.md. Dave (milestone 726): keep the hooks, add a weekly count.
 *
 * One read-only query on archival_memory (the table store_learning.py writes): rows per Chicago week (Monday to Sunday), per
 * metadata.learning_type and per metadata.source (hook, manual, handoff, llm). It selects no content and no session id. The READ ONLY
 * transaction comes from openReadOnly of export-dash-data.mjs. Counts say how many learnings were stored, not whether they were good.
 * A type or a source that is not a short word becomes OTHER. A listed id in the output stops the run (exit 3). No pass line: 2 weeks of baseline first.
 *
 * Usage: node scripts/coordination/learning-counts.mjs [--weeks N] [--now <iso>] [--root <repo root of the id list>]
 * The database url is the chain of lane.mjs (CONTINUOUS_CLAUDE_DB_URL, DATABASE_URL, OPC_POSTGRES_URL, the local default). Tests set it
 * to a scratch database. Exit: 0 ok | 1 usage | 2 no learning stored in the window | 3 id list unreadable or an id in the output | 4 store unreadable.
 */
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countListed, readIdList } from './board-mask.mjs';
import { connString, openReadOnly } from './export-dash-data.mjs';

export const defaultOpen = openReadOnly;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const WORD = /^[A-Za-z0-9 _.:/-]{1,40}$/;
const word = (v) => (v === null || v === undefined || v === '' ? 'NONE' : WORD.test(String(v)) ? String(v) : 'OTHER');

const SQL = `SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'America/Chicago'), 'YYYY-MM-DD') AS week,
       metadata->>'learning_type' AS learning_type, metadata->>'source' AS source, count(*)::int AS n
FROM archival_memory
WHERE created_at <= $1::timestamptz AND created_at > $1::timestamptz - make_interval(weeks => $2::int)
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;

/** Counts per week from query rows. Only week, learning_type, source and n are read: any other field of a row is ignored. */
export function formatCounts(rows) {
  const weeks = new Map();
  for (const r of rows) {
    const w = weeks.get(r.week) || weeks.set(r.week, { week: String(r.week), total: 0, bySource: {}, byType: {} }).get(r.week);
    const n = Number(r.n) || 0;
    const src = word(r.source);
    const typ = word(r.learning_type);
    w.total += n;
    w.bySource[src] = (w.bySource[src] || 0) + n;
    w.byType[typ] = (w.byType[typ] || 0) + n;
  }
  const list = [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
  return { weeks: list, hookTotal: list.reduce((s, w) => s + (w.bySource.hook || 0), 0) };
}

function parseArgs(argv) {
  const a = { weeks: 8, now: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!['--weeks', '--now', '--root'].includes(k)) throw new Error('unknown argument');
    if (v === undefined || v.startsWith('--')) throw new Error('missing value');
    if (k === '--weeks') { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 520) throw new Error('bad weeks'); a.weeks = n; }
    else if (k === '--now') { if (!Number.isFinite(Date.parse(v))) throw new Error('bad time'); a.now = v; }
    else a.root = v;
    i++;
  }
  return a;
}

function primaryRoot() {
  try {
    return path.dirname(execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { return REPO; }
}

/** { code, out, err } of one run. `open` opens the store client (a test passes a fake). */
export async function run(argv, { open = defaultOpen } = {}) {
  let a;
  try { a = parseArgs(argv); } catch (e) { return { code: 1, out: '', err: `learning-counts: ${e.message}\n` }; }
  let rows;
  let client = null;
  try {
    client = await open(connString());
    rows = (await client.query(SQL, [a.now || new Date().toISOString(), a.weeks])).rows;
  } catch {
    return { code: 4, out: '', err: 'learning-counts: the memory store could not be read; no output\n' };
  } finally {
    if (client) { await client.query('ROLLBACK').catch(() => {}); await client.end().catch(() => {}); }
  }
  if (!rows.length) return { code: 2, out: '', err: `learning-counts: no learning stored in the last ${a.weeks} weeks\n` };
  const text = `${JSON.stringify({ weeks: a.weeks, ...formatCounts(rows) }, null, 1)}\n`;
  let note = '';
  try {
    const ids = readIdList(a.root || primaryRoot());
    if (ids.length === 0 || countListed(text, ids) > 0) return { code: 3, out: '', err: 'learning-counts: a listed id reached the output; no output\n' };
  } catch (e) {
    if (e && e.kind === 'absent') note = 'learning-counts: note: no listed-id list in this root; the output holds counts only\n';
    else return { code: 3, out: '', err: 'learning-counts: the listed-id list could not be read; no output\n' };
  }
  return { code: 0, out: text, err: note };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await run(process.argv.slice(2));
  process.stdout.write(r.out);
  process.stderr.write(r.err);
  process.exitCode = r.code;
}
