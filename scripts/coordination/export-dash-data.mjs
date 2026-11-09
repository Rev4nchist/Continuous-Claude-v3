#!/usr/bin/env node
/**
 * export-dash-data -- export the lane board as eight local JSON documents for the lane dashboard and the Fleet app.
 *
 *   node scripts/coordination/export-dash-data.mjs [--out <dir>] [--rules <file>] [--config <file>]
 *   node scripts/coordination/export-dash-data.mjs --out <dir> --clear-refresh <key>
 *
 * It only writes local files. It uploads nothing and writes to no artifact (a later step does that).
 *
 * Documents (each {sql, exportedAt, rows}, one exportedAt in all eight, each under 256 KB):
 *   lanes, assignments, projects, targets, meta, snapshots, tiles, flow
 *   tiles = flat rows of every tile figure, verdict word and sentence, computed here in Node by lane-dash-metrics.mjs
 *   (schema in that file). The page only marks and draws them. Ages use meta.exported_at, never a clock.
 *   flow = flat rows of the Flow figures (claimed, done, created and reopened per day, week totals, median claim to done,
 *   rework rate), computed in Node by lane-dash-flow.mjs (schema in that file). The Fleet app reads it. It is NOT a
 *   FleetOps dashboard source: the fleetops-refresh skill copies seven files and never uploads flow.json.
 * Plus refresh.json, the refresh trigger doc (not a dataset). See buildRefreshDoc.
 *
 * Database: SELECT only, in BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY with default_transaction_read_only=on.
 * Connection chain as lane.mjs: CONTINUOUS_CLAUDE_DB_URL, DATABASE_URL, OPC_POSTGRES_URL, local default.
 * Scope: project_key = the config board ('continuous-claude'). Another board's lanes and events never appear.
 * The DB clock is UTC. Every day bucket is America/Chicago.
 *
 * What is NOT exported: lane.note, scope, rationale, done_when text, event bodies, session ids or 8-hex handles.
 * Lane titles are exported (cut at a word boundary to TITLE_MAX characters, with an ellipsis). A '#' plus 8 hex digits in a title becomes '#[handle]'. The lanes rows follow a column allowlist.
 *
 * Meanings:
 *   done      the lane's state is done. done_at is the latest done signal and is null for a lane that was
 *             reopened. A done signal is a lane_event kind 'done', or kind 'kanban' with detail {kind:'state', to:'done'}
 *             (kanban-apply writes that and never kind 'done'). Done counts use distinct lane ids (a repeat done is one lane).
 *   work      last_work_at is the latest claimed, state_changed or done event. A note is not work.
 *   an ask    dave_ask_at is the time of the latest note or state_changed EVENT, or kanban event that moved a card
 *             into Waiting (detail.text 'moved into waiting'), whose body says "needs Dave" or "waiting on Dave".
 *             Only the text before " || before:" is read (the rest is the old note). A negation such as
 *             "no longer needs Dave" is no ask. lane.note is never read: it changes only on a new note.
 *   project   from lane-projects.json through the shared projectOf (lane-dash-project.mjs).
 *
 * Checks (exit 1, nothing written): a document over 256 KB, exportedAt not equal in all eight, a lane project
 * that is not in the projects rows, and a rebuilt open count (created minus done at the last day) that differs
 * from the direct count.
 *
 * Snapshots: one row per Chicago day, upserted into <out>/snapshots.json under a lock. The old file is kept
 * as snapshots.json.bak, written once per Chicago day (on the first export of the day), so it covers a day, not one run. A file that does not parse fails the export and is never overwritten.
 *
 * Importing this file does nothing: no I/O, no connection.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { loadConfig } from './lane-dash-config.mjs';
import { loadProjectRules, projectOf, UNASSIGNED } from './lane-dash-project.mjs';
import { buildFlowRows } from './lane-dash-flow.mjs';
import { buildTileRows } from './lane-dash-metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');

export const DOC_CAP_BYTES = 256 * 1024;
/** Longest exported lane title, ellipsis included. The page clamps a row to two lines; this keeps the file small. */
export const TITLE_MAX = 160;

/** Cuts a title at a word boundary and ends it with "…". A title that fits is returned as it is. */
export function cutTitle(title, max = TITLE_MAX) {
  const s = String(title ?? '');
  if (s.length <= max) return s;
  const room = s.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  // A cut on the next character being a space keeps every word whole; with no usable space, cut hard.
  const keep = s[max - 1] === ' ' ? room : (space > 0 ? room.slice(0, space) : room);
  return `${keep.trimEnd()}…`;
}
export const DATASETS = ['lanes', 'assignments', 'projects', 'targets', 'meta', 'snapshots', 'tiles', 'flow'];
const TZ = 'America/Chicago';
const LOCK_STALE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- pure helpers

const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const toDate = (v) => (v instanceof Date ? v : new Date(v));

/** YYYY-MM-DD in America/Chicago for a Date or timestamp string. Null for null or an invalid value. */
export function chicagoDay(v) {
  if (v === null || v === undefined) return null;
  const d = toDate(v);
  return Number.isNaN(d.getTime()) ? null : fmtDay.format(d);
}
const iso = (v) => {
  if (v === null || v === undefined) return null;
  const d = toDate(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** A new array: `row` replaces the row of the same day, or is added. Sorted by day. */
export function upsertSnapshot(rows, row) {
  return [...rows.filter((r) => r.day !== row.day), row].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** One snapshot row from the lanes rows. `exportedAt` is the clock for the lease check. */
export function buildSnapshotRow(lanes, exportedAt) {
  const open = lanes.filter((l) => l.state !== 'done');
  const now = Date.parse(exportedAt);
  const inState = (s) => open.filter((l) => l.state === s).length;
  const inBand = (b) => open.filter((l) => l.band === b).length;
  return {
    day: chicagoDay(exportedAt),
    snapshot_at: exportedAt,
    open: open.length,
    done: lanes.length - open.length,
    backlog: inState('backlog'),
    ready: inState('ready'),
    active: inState('active'),
    blocked: inState('blocked'),
    review: inState('review'),
    lapsed: open.filter((l) => l.state === 'active' && (!l.lease_expires_at || Date.parse(l.lease_expires_at) < now)).length,
    p0_open: inBand('P0'),
    p1_open: inBand('P1'),
    p2_open: inBand('P2'),
    unbanded_open: open.filter((l) => !l.band).length,
    never_claimed_open: open.filter((l) => l.claims === 0).length,
    never_started_open: open.filter((l) => !l.last_work_at).length,
  };
}

/**
 * The project rows. A project is Done when EVERY terminal lane is done ("N of M"). A project with no terminal
 * lane is 'no_end', never Done. A terminal lane missing from the board counts in M and is not done. A Done
 * project stays in the rows; `visible_until` is done_day plus done_visible_days (28) and the page decides.
 */
export function buildProjectRows(rules, lanes, config) {
  const byId = new Map(lanes.map((l) => [l.id, l]));
  const visibleDays = config.targets.find((t) => t.key === 'done_visible_days')?.value ?? 28;
  const rows = rules.projects.map((p) => {
    const ids = [...new Set(p.terminalLanes)];
    const done = ids.map((id) => byId.get(id)).filter((l) => l && l.state === 'done');
    const status = ids.length === 0 ? 'no_end' : done.length === ids.length ? 'done' : 'open';
    const doneAts = status === 'done' ? done.map((l) => l.done_at).filter(Boolean).sort() : [];
    const doneAt = doneAts.length ? doneAts[doneAts.length - 1] : null;
    const doneDay = chicagoDay(doneAt);
    return {
      key: p.key, name: p.name, goal: p.goal, done_when: p.done,
      terminal_lanes: ids.join(', '), terminal_total: ids.length, terminal_done: done.length,
      status, done_at: doneAt, done_day: doneDay, visible_until: doneDay ? addDays(doneDay, visibleDays) : null,
      parked: p.parked, proposed: p.proposed, focus: p.focus,
    };
  });
  rows.push({
    key: UNASSIGNED, name: 'Unassigned', goal: 'No project rule matches yet.', done_when: 'Give each lane a project rule.',
    terminal_lanes: '', terminal_total: 0, terminal_done: 0, status: 'no_end', done_at: null, done_day: null, visible_until: null,
    parked: false, proposed: false, focus: false,
  });
  return rows;
}

/** Throws one Error (with .problems) listing every failed check. */
export function checkInvariants({ envelopes, directOpen, bornDone = [] }) {
  const born = new Set(bornDone);
  const problems = [];
  const stamps = new Set();
  for (const d of DATASETS) {
    const env = envelopes?.[d];
    if (!env || !Array.isArray(env.rows)) { problems.push(`${d}.json is missing or has no rows`); continue; }
    stamps.add(env.exportedAt);
    const bytes = Buffer.byteLength(JSON.stringify(env));
    if (bytes > DOC_CAP_BYTES) problems.push(`${d}.json is ${bytes} bytes, over the ${DOC_CAP_BYTES} byte (256 KB) cap`);
  }
  if (stamps.size > 1) problems.push(`exportedAt differs between documents: ${[...stamps].join(', ')}`);
  const lanes = envelopes?.lanes?.rows ?? [];
  const keys = new Set((envelopes?.projects?.rows ?? []).map((p) => p.key));
  for (const l of lanes) if (!keys.has(l.project)) problems.push(`lane ${l.id} has project '${l.project}', which is not in the projects rows`);
  const today = envelopes?.meta?.rows?.[0]?.today;
  if (today) {
    // A lane born done (lane.mjs add --state done) has no done event, so no done_day. It is done, with an unknown time.
    const rebuilt = lanes.filter((l) => l.created_day <= today && !(l.done_day && l.done_day <= today) && !born.has(l.id)).length;
    if (rebuilt !== directOpen) problems.push(`open count: ${rebuilt} rebuilt from lanes (created minus done on ${today}), ${directOpen} counted directly`);
  } else {
    problems.push('meta has no today value, so the open count cannot be rebuilt');
  }
  if (problems.length) {
    const err = new Error(`export checks failed: ${problems.join('; ')}`);
    err.problems = problems;
    throw err;
  }
}

// ---------------------------------------------------------------- refresh trigger doc

/**
 * The refresh trigger doc. The export writes it as pending with key = exportedAt: new data exists locally and the
 * dashboard has not been updated. The CLEARING CALL is an ArtifactData write to datasets/lanes (the step that
 * points the dashboard at the new files). After that write, run `--clear-refresh <key>` with the doc's key.
 * clearRefreshPending resets it only for the same key, so an older upload never hides a newer export.
 * Wiring the clearing call to a hook (HOOK_TOOLS and the settings matcher) is a later PR, not this file. It needs Dave's yes on hooks. A held lock makes clearRefreshFile throw, so that hook must retry.
 */
export function buildRefreshDoc(exportedAt, files) {
  return {
    pending: true,
    key: exportedAt,
    exported_at: exportedAt,
    files: [...files],
    cleared_at: null,
    clear_with: { tool: 'ArtifactData', action: 'write', target: 'datasets/lanes' },
  };
}

/** A new doc with pending false, when `key` is the doc's key. Anything else returns the doc unchanged. */
export function clearRefreshPending(doc, key, at) {
  if (!doc || !doc.pending || doc.key !== key) return doc;
  return { ...doc, pending: false, cleared_at: at };
}

// ---------------------------------------------------------------- files

/** The snapshot rows in a file. A missing file is []. A file that does not parse or has no rows array throws. */
export function readSnapshots(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw new Error(`${file}: cannot read: ${e.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: does not parse (${e.message}). Fix or move the file. The export never overwrites it.`);
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rows) || doc.rows.some((r) => !r || typeof r.day !== 'string')) {
    throw new Error(`${file}: not a snapshots document (needs a rows array of {day, ...}). The export never overwrites it.`);
  }
  return doc.rows;
}

function acquireLock(lock) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age < LOCK_STALE_MS) throw new Error(`export lock is held: ${lock} (another export is running; delete the file if it is older than 10 minutes)`);
      try { unlinkSync(lock); } catch { /* another process took it; the retry reports it */ }
    }
  }
  throw new Error(`export lock is held: ${lock}`);
}

/**
 * The tiles document: flat rows of figures, verdict words and sentences (see lane-dash-metrics.mjs for the schema).
 * Built from the other documents in memory. "Now" is meta.exported_at, never a clock.
 */
function buildTilesEnvelope(envelopes, exportedAt) {
  return {
    sql: 'Computed in Node by scripts/coordination/lane-dash-metrics.mjs from the lanes, assignments, projects, targets, meta and snapshots documents. No query.',
    exportedAt,
    rows: buildTileRows({
      lanes: envelopes.lanes.rows,
      assignments: envelopes.assignments.rows,
      projects: envelopes.projects.rows,
      targets: envelopes.targets.rows,
      meta: envelopes.meta.rows[0],
      snapshots: envelopes.snapshots.rows,
    }),
  };
}

/**
 * The flow document: flat rows of the Flow figures (see lane-dash-flow.mjs for the schema). Built from the other
 * documents and the in-memory rework rows. "Today" is meta.today, never a clock. The rework rows are not a document.
 */
function buildFlowEnvelope(envelopes, collected, exportedAt) {
  return {
    sql: `Computed in Node by scripts/coordination/lane-dash-flow.mjs from the lanes, assignments, targets and meta documents, plus one query for reopens:
${collected.reworkSql ?? '(no rework query)'}`,
    exportedAt,
    rows: buildFlowRows({
      lanes: envelopes.lanes.rows,
      assignments: envelopes.assignments.rows,
      rework: collected.rework ?? [],
      targets: envelopes.targets.rows,
      meta: envelopes.meta.rows[0],
    }),
  };
}

/**
 * Check, then write the eight documents and refresh.json. `collected` = {envelopes: {lanes, assignments, projects,
 * targets, meta}, directOpen, rework}. The snapshots, tiles and flow documents are built here (snapshots from the previous
 * file under a lock, tiles and flow from the in-memory documents). Nothing is written unless every check passes. Each
 * file is a temp file renamed into place.
 */
export function writeExport(outDir, collected) {
  mkdirSync(outDir, { recursive: true });
  const lock = path.join(outDir, '.export.lock');
  acquireLock(lock);
  const temps = [];
  try {
    const exportedAt = collected.envelopes.lanes.exportedAt;
    const snapFile = path.join(outDir, 'snapshots.json');
    const prior = readSnapshots(snapFile);
    const row = buildSnapshotRow(collected.envelopes.lanes.rows, exportedAt);
    const withSnaps = {
      ...collected.envelopes,
      snapshots: {
        sql: 'One row per America/Chicago day, counted from the lanes document and upserted by the export script. Earlier days are kept from the previous run.',
        exportedAt,
        rows: upsertSnapshot(prior, row),
      },
    };
    const envelopes = { ...withSnaps, tiles: buildTilesEnvelope(withSnaps, exportedAt), flow: buildFlowEnvelope(withSnaps, collected, exportedAt) };
    checkInvariants({ envelopes, directOpen: collected.directOpen, bornDone: collected.bornDone });
    const files = DATASETS.map((d) => ({ name: `${d}.json`, text: JSON.stringify(envelopes[d]) }));
    files.push({ name: 'refresh.json', text: JSON.stringify(buildRefreshDoc(exportedAt, DATASETS.map((d) => `${d}.json`)), null, 2) });
    for (const f of files) {
      const tmp = path.join(outDir, `${f.name}.tmp`);
      writeFileSync(tmp, f.text);
      temps.push(tmp);
    }
    // The .bak is the file as the last day left it: copy it on the first export of a Chicago day only (the file has no row for
    // today yet). The 30-minute task would otherwise overwrite it every run and it would cover 30 minutes. No .bak yet: copy once.
    const firstOfDay = !prior.some((r) => r.day === row.day);
    if (existsSync(snapFile) && (firstOfDay || !existsSync(`${snapFile}.bak`))) copyFileSync(snapFile, `${snapFile}.bak`);
    for (const f of files) renameSync(path.join(outDir, `${f.name}.tmp`), path.join(outDir, f.name));
    temps.length = 0;
    return { exportedAt, files: files.map((f) => ({ name: f.name, bytes: Buffer.byteLength(f.text) })), envelopes };
  } finally {
    for (const t of temps) { try { unlinkSync(t); } catch { /* already gone */ } }
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

/**
 * Clear the refresh doc in `outDir` for `key`. Returns the doc after the call (null when there is none).
 * It takes the same .export.lock as writeExport, so it never renames refresh.json while an export writes it.
 * A held lock throws like writeExport does. The temp file name has the pid, so it never collides with
 * writeExport's refresh.json.tmp.
 */
export function clearRefreshFile(outDir, key, at = new Date().toISOString()) {
  const file = path.join(outDir, 'refresh.json');
  if (!existsSync(file)) return null;
  const lock = path.join(outDir, '.export.lock');
  acquireLock(lock);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const next = clearRefreshPending(doc, key, at);
    if (next !== doc) {
      writeFileSync(tmp, JSON.stringify(next, null, 2));
      renameSync(tmp, file);
    }
    return next;
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or never written */ }
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------- database

export function connString(env = process.env) {
  return env.CONTINUOUS_CLAUDE_DB_URL || env.DATABASE_URL || env.OPC_POSTGRES_URL
    || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';
}

/** A connected client inside BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY. The caller ends it. */
export async function openReadOnly(url = connString()) {
  const pg = requireDep('pg', { repoRoot: REPO });
  const Client = pg.Client || pg.default?.Client;
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 4000,
    query_timeout: 15000,
    options: '-c default_transaction_read_only=on',
  });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  } catch (e) {
    await client.end().catch(() => {});
    throw e;
  }
  return client;
}

// kanban-apply marks a lane done with kind 'kanban' and detail {kind:'state', to:'done'}, never kind 'done'.
// An ask is read from the text before " || before:" (kanban-apply keeps the old note after it). A kanban event
// is an ask only when it moved the card into Waiting. A negation before the phrase ("no longer needs Dave") is no ask.
const SQL_LANES = `WITH ev AS (
  SELECT e.lane_id,
    min(e.occurred_at) FILTER (WHERE e.kind = 'claimed') AS first_claim,
    max(e.occurred_at) FILTER (WHERE e.kind = 'done'
      OR (e.kind = 'kanban' AND e.detail->>'kind' = 'state' AND e.detail->>'to' = 'done')) AS done_ev,
    max(e.occurred_at) FILTER (WHERE e.kind IN ('claimed', 'state_changed', 'done')
      OR (e.kind = 'kanban' AND e.detail->>'kind' = 'state' AND e.detail->>'to' = 'done')) AS last_work,
    max(e.occurred_at) FILTER (WHERE (e.kind IN ('note', 'state_changed')
        OR (e.kind = 'kanban' AND e.detail->>'text' = 'moved into waiting'))
      AND (h.head ILIKE '%needs dave%' OR h.head ILIKE '%waiting on dave%')
      AND h.head !~* '(\\y(no longer|not|never|stopped)\\y|n''t)[^|]{0,30}(needs|waiting on) dave') AS dave_ask,
    count(*) FILTER (WHERE e.kind = 'claimed') AS claims
  FROM agentic_os.lane_event e JOIN agentic_os.lane l2 ON l2.id = e.lane_id
  CROSS JOIN LATERAL (SELECT split_part(coalesce(e.body, ''), ' || before:', 1) AS head) h
  WHERE l2.project_key = $1 GROUP BY e.lane_id)
SELECT l.id, left(regexp_replace(l.title, '#[0-9a-f]{8}', '#[handle]', 'g'), 400) AS title, l.track, l.band, l.state, l.priority, l.created_at, l.lease_expires_at,
  (l.owner_session_id IS NOT NULL) AS held, (coalesce(l.done_when, '') <> '') AS has_done_when,
  ev.first_claim, CASE WHEN l.state = 'done' THEN ev.done_ev END AS done_at, ev.last_work, ev.dave_ask,
  coalesce(ev.claims, 0) AS claims
FROM agentic_os.lane l LEFT JOIN ev ON ev.lane_id = l.id
WHERE l.project_key = $1 ORDER BY l.created_at, l.id`;

const SQL_CLAIMS = `SELECT e.occurred_at, e.lane_id,
  CASE WHEN e.detail->>'fence' ~ '^[0-9]+$' THEN (e.detail->>'fence')::int END AS fence,
  (lag(e.session_id) OVER w IS NOT NULL AND lag(e.session_id) OVER w <> e.session_id) AS reassigned
FROM agentic_os.lane_event e JOIN agentic_os.lane l ON l.id = e.lane_id
WHERE e.kind = 'claimed' AND l.project_key = $1
WINDOW w AS (PARTITION BY e.lane_id ORDER BY e.occurred_at, e.id)
ORDER BY e.occurred_at, e.id`;

const SQL_DAVE = `SELECT DISTINCT ON (e.lane_id, (e.occurred_at AT TIME ZONE 'America/Chicago')::date, lower(split_part(e.detail->>'text', ' ', 1)))
  e.occurred_at, e.lane_id, lower(split_part(e.detail->>'text', ' ', 1)) AS column_name
FROM agentic_os.lane_event e JOIN agentic_os.lane l ON l.id = e.lane_id
WHERE e.kind = 'kanban' AND l.project_key = $1 AND lower(split_part(e.detail->>'text', ' ', 1)) IN ('now', 'next')
ORDER BY e.lane_id, (e.occurred_at AT TIME ZONE 'America/Chicago')::date, lower(split_part(e.detail->>'text', ' ', 1)), e.occurred_at`;

const SQL_DIRECT = `SELECT count(*) FILTER (WHERE state <> 'done')::int AS open, count(*) FILTER (WHERE state = 'done')::int AS done
FROM agentic_os.lane WHERE project_key = $1`;

// Done lanes whose only events are 'seeded' (or none): created as done, never marked done. Any other done lane without a done signal stays a check failure.
const SQL_BORN_DONE = `SELECT l.id FROM agentic_os.lane l
WHERE l.project_key = $1 AND l.state = 'done'
  AND NOT EXISTS (SELECT 1 FROM agentic_os.lane_event e WHERE e.lane_id = l.id AND e.kind <> 'seeded')`;

const SQL_DONE_EVENTS =`SELECT count(DISTINCT e.lane_id)::int AS lanes, count(*)::int AS events
FROM agentic_os.lane_event e JOIN agentic_os.lane l ON l.id = e.lane_id
WHERE (e.kind = 'done' OR (e.kind = 'kanban' AND e.detail->>'kind' = 'state' AND e.detail->>'to' = 'done')) AND l.project_key = $1`;

// Rework: one row per done signal, with the first reopen signal after it (null when none). A reopen signal is a
// state_changed event (lane.mjs state <id> <not done> writes it) or a kanban state move to anything but done. Read in
// Node by lane-dash-flow.mjs; no body, note or session is selected, and it is not written as a document.
export const SQL_REWORK = `WITH d AS (
  SELECT e.lane_id, e.occurred_at AS done_at
  FROM agentic_os.lane_event e JOIN agentic_os.lane l ON l.id = e.lane_id
  WHERE l.project_key = $1 AND (e.kind = 'done' OR (e.kind = 'kanban' AND e.detail->>'kind' = 'state' AND e.detail->>'to' = 'done'))),
r AS (
  SELECT e.lane_id, e.occurred_at AS reopen_at
  FROM agentic_os.lane_event e JOIN agentic_os.lane l ON l.id = e.lane_id
  WHERE l.project_key = $1 AND (e.kind = 'state_changed' OR (e.kind = 'kanban' AND e.detail->>'kind' = 'state' AND e.detail->>'to' <> 'done')))
SELECT d.lane_id, d.done_at, min(r.reopen_at) AS reopen_at
FROM d LEFT JOIN r ON r.lane_id = d.lane_id AND r.reopen_at > d.done_at
GROUP BY d.lane_id, d.done_at ORDER BY d.done_at, d.lane_id`;

const showSql = (sql, board) => sql.replace(/\$1/g, `'${board}'`);

/** Run the SELECTs and build the five database documents, plus the rework rows flow.json needs. `client` must be a read-only client. */
export async function collect(client, { rules, config }) {
  const board = config.board;
  const rows = async (sql) => (await client.query(sql, [board])).rows;
  const now = (await client.query('SELECT now() AS now')).rows[0].now;
  const exportedAt = iso(now);
  const env = (sql, r) => ({ sql, exportedAt, rows: r });
  const terminal = new Set(rules.projects.flatMap((p) => p.terminalLanes));

  const lanes = (await rows(SQL_LANES)).map((l) => ({
    id: l.id, title: cutTitle(l.title), project: projectOf({ id: l.id, track: l.track }, rules), track: l.track, band: l.band,
    state: l.state, priority: l.priority,
    created_at: iso(l.created_at), created_day: chicagoDay(l.created_at),
    first_claim_at: iso(l.first_claim), done_at: iso(l.done_at), done_day: chicagoDay(l.done_at),
    last_work_at: iso(l.last_work), dave_ask_at: iso(l.dave_ask),
    lease_expires_at: iso(l.lease_expires_at), held: l.held, has_done_when: l.has_done_when,
    terminal: terminal.has(l.id), claims: Number(l.claims),
  }));

  const claims = (await rows(SQL_CLAIMS)).map((r) => ({
    at: iso(r.occurred_at), day: chicagoDay(r.occurred_at), lane_id: r.lane_id, who: 'session',
    how: r.fence > 1 ? 'reclaim' : 'claim', reassigned: r.reassigned === true,
  }));
  const dave = (await rows(SQL_DAVE)).map((r) => ({
    at: iso(r.occurred_at), day: chicagoDay(r.occurred_at), lane_id: r.lane_id, who: 'dave',
    how: r.column_name === 'now' ? 'placed in Now' : 'placed in Next', reassigned: false,
  }));
  const assignments = [...claims, ...dave].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const direct = (await rows(SQL_DIRECT))[0];
  const doneEvents = (await rows(SQL_DONE_EVENTS))[0];
  const bornDone = (await rows(SQL_BORN_DONE)).map((r) => r.id);
  const rework = (await rows(SQL_REWORK)).map((r) => ({ lane_id: r.lane_id, done_at: iso(r.done_at), reopen_at: iso(r.reopen_at) }));
  const history = lanes.map((l) => l.created_day).sort()[0] ?? null;
  const meta = [{
    exported_at: exportedAt, today: chicagoDay(now), history_start: history, band_history_start: config.band_history_start,
    board, board_url: config.board_url, stale_after_hours: config.stale_after_hours,
    projects_stale_after_hours: config.projects_stale_after_hours, timezone: TZ,
    open_check: lanes.filter((l) => l.state !== 'done').length, done_check: lanes.filter((l) => l.state === 'done').length,
    done_event_lanes: doneEvents.lanes, done_events: doneEvents.events,
  }];

  return {
    directOpen: direct.open,
    bornDone,
    rework,
    reworkSql: showSql(SQL_REWORK, board),
    envelopes: {
      lanes: env(showSql(SQL_LANES, board), lanes),
      assignments: env(`${showSql(SQL_CLAIMS, board)}\n-- plus --\n${showSql(SQL_DAVE, board)}`, assignments),
      projects: env('repo file scripts/coordination/lane-projects.json, with terminal counts from the lanes document', buildProjectRows(rules, lanes, config)),
      targets: env('repo file scripts/coordination/lane-dash.config.json', config.targets),
      meta: env('SELECT now(); counts from the lanes document and the database', meta),
    },
  };
}

// ---------------------------------------------------------------- command line

const USAGE = `usage: export-dash-data.mjs [--out <dir>] [--rules <file>] [--config <file>]
       export-dash-data.mjs [--out <dir>] --clear-refresh <key>
  --out      output folder (default ~/.claude/state/lane-dash)
  --rules    project rules (default scripts/coordination/lane-projects.json)
  --config   dashboard config (default scripts/coordination/lane-dash.config.json)`;

function parseArgs(argv) {
  const opts = { out: path.join(homedir(), '.claude', 'state', 'lane-dash'), rules: path.join(HERE, 'lane-projects.json'), config: path.join(HERE, 'lane-dash.config.json'), clear: null, help: false, configGiven: false };
  const withValue = { '--out': 'out', '--rules': 'rules', '--config': 'config', '--clear-refresh': 'clear' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (!Object.hasOwn(withValue, a)) throw new Error(`unknown argument ${a}\n${USAGE}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value\n${USAGE}`);
    opts[withValue[a]] = v;
    if (a === '--config') opts.configGiven = true;
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return 0; }
  const out = path.resolve(opts.out);
  if (opts.clear !== null) {
    const doc = clearRefreshFile(out, opts.clear);
    console.log(doc ? `refresh doc: pending=${doc.pending} key=${doc.key}${doc.cleared_at ? ` cleared_at=${doc.cleared_at}` : ''}` : `no refresh doc in ${out}`);
    return 0;
  }
  const rules = loadProjectRules(path.resolve(opts.rules));
  const config = loadConfig(path.resolve(opts.config), { required: opts.configGiven });
  const client = await openReadOnly(connString());
  let collected;
  try {
    collected = await collect(client, { rules, config });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
  const result = writeExport(out, collected);
  console.log(`exported at ${result.exportedAt} (UTC) to ${out}`);
  for (const f of result.files) console.log(`  ${f.name.padEnd(18)} ${String(f.bytes).padStart(7)} bytes`);
  const lanes = result.envelopes.lanes.rows;
  const by = (key, rows) => rows.reduce((m, r) => ({ ...m, [r[key]]: (m[r[key]] || 0) + 1 }), {});
  console.log(`states ${JSON.stringify(by('state', lanes))}`);
  console.log(`open by project ${JSON.stringify(by('project', lanes.filter((l) => l.state !== 'done')))}`);
  console.log(`open ${collected.directOpen} (rebuilt equals direct); snapshot days ${result.envelopes.snapshots.rows.length}`);
  return 0;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then((code) => process.exit(code), (e) => {
    console.error(`export-dash-data: ${e.message}`);
    process.exit(1);
  });
}
