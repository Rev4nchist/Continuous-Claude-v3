import { redact } from '../sources/redact';
import { scrubPathsInText, stripControl } from '../sources/safe-message';

import { laneOrderSql } from './lane-sort';

/**
 * Lane coordination rules for the Fleet app (read only), copied from the lane CLI. PURE: no 'server-only', no
 * '@/' import, no Next import, so the drift spec loads it in Node. No client component imports the VALUE side
 * of this file (ruling R2): the server formats every time as text in the row mappers below.
 *
 * Sources, all in scripts/coordination (the app cannot import from scripts/: next.config.ts pins the Turbopack root):
 *   lane.mjs          LEASE_MINUTES 156, STALE_MINUTES 158, REMINDER_DUE_PRED 327-328, ALIVE_AT 378,
 *                     reclaimableSql 389-399, the parked rule 411-418, UNREAD_SQL 452-457, remind list --due 1413
 *   lane-dep.mjs      the five builders (typed twin: .claude/hooks/src/shared/lane-dep.ts)
 *   reminder-core.mjs fmtCT 144-148 (the time text)
 * e2e/lane-coord-drift.spec.ts fails when a copy drifts. Change the CLI and this file in one commit.
 */

export const LEASE_MINUTES = 90; // lane.mjs:156
export const STALE_MINUTES = 5; // lane.mjs:158
export const PARK_WINDOW_SECONDS = 48 * 60 * 60;
export const IDLE_WINDOW_HOURS = 24;
/** Rows shown per kind. The SQL fetches one more, to know that more exist. */
export const COORD_KIND_LIMIT = 20;
export const BANDS = ['P0', 'P1', 'P2'] as const;
export type Band = (typeof BANDS)[number];

// --- Unread direct messages (lane.mjs:452-457) -------------------------------------------------

/** lane.mjs:452, the self-exclusion. Byte-identical: the drift spec finds it at the start of UNREAD_SQL. */
export const UNREAD_SELF_SOURCE = 'e.session_id <> $1::text';
/**
 * lane.mjs:455-457, the DM branch. Byte-identical (5 and 27 leading spaces). The cursor is the MAX over the rows
 * `<uuid>` and `<uuid>@...`. Phase 1 copies no broadcast branch.
 */
export const DM_UNREAD_SOURCE = `(e.to_session_id = $1::text
     AND e.id > COALESCE((SELECT MAX(last_event_id) FROM agentic_os.lane_watermark
                           WHERE session_id = $1::text OR starts_with(session_id, $1::text || '@')), 0))`;
const COLUMN_RE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
/** The DM unread predicate for one session column of this file (c.id). Never user input. Leaves no $n. */
export function unreadDmSql(column: string): string {
  if (!COLUMN_RE.test(column)) throw new Error(`unreadDmSql: bad column ${JSON.stringify(column)}`);
  return `${UNREAD_SELF_SOURCE} AND ${DM_UNREAD_SOURCE}`.split('$1::text').join(column);
}

// --- Reclaimable (lane.mjs:378, 389-399) -------------------------------------------------------

export const ALIVE_AT = (alias = ''): string => `GREATEST(${alias}last_heartbeat, ${alias}last_activity_at)`;
/**
 * Byte-identical to lane.mjs reclaimableSql. RISKS (ruling R4, checked on the live database 2026-11-12):
 * `sessions` is not schema-qualified, so it resolves through search_path (role agentic_os_app has none set, the
 * default is "$user", public, and public.sessions is the only table of that name); and the timestamps of
 * `sessions` have no time zone, so the bare now() equals the CLI only while the server time zone is UTC (it is).
 * A miss fails the whole board read.
 */
export const reclaimableSql = (alias: string): string => `(
  ${alias}.owner_session_id IS NULL
  OR (
    (${alias}.lease_expires_at IS NULL OR ${alias}.lease_expires_at < now())
    AND NOT EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = ${alias}.owner_session_id
        AND ${ALIVE_AT('s.')} > now() - interval '${STALE_MINUTES} minutes'
    )
  )
)`;
/** The card tag: an owner AND the CLI rule. The rule alone is true for every lane with no owner. Alias 'l' only. */
export const RECLAIMABLE_TAG_SQL = `(l.owner_session_id IS NOT NULL AND ${reclaimableSql('l')})`;

// --- Parked (lane.mjs:156, 411-418) ------------------------------------------------------------

/** lane.mjs:411-413: whole minutes left, rounded as the CLI rounds. Null with no lease. Epochs in seconds. */
export function leaseMinutes(leaseEpoch: number | null, nowEpoch: number): number | null {
  return leaseEpoch === null ? null : Math.round(((leaseEpoch - nowEpoch) * 1000) / 60000);
}
/** lane.mjs:416-417: parked = an owner AND lease > LEASE_MINUTES + 1. */
export function isParked(hasOwner: boolean, leaseEpoch: number | null, nowEpoch: number): boolean {
  const lease = leaseMinutes(leaseEpoch, nowEpoch);
  return hasOwner && lease !== null && lease > LEASE_MINUTES + 1;
}

// --- Reminder due (lane.mjs:327-328, 1413) -----------------------------------------------------

export const REMINDER_DUE_PRED = `l.due_at IS NOT NULL AND l.due_at <= now()
  AND l.remind_state IN ('scheduled','due','needs_dave','failed')`;
/** remind list --due (lane.mjs:1413). */
export const REMINDER_DUE_WHERE = `l.state <> 'done' AND ${REMINDER_DUE_PRED}`;

// --- Waits on: the lane-dep builders (lane-dep.mjs:22-71; twin .claude/hooks/src/shared/lane-dep.ts) ---

const ALIAS_RE = /^[a-z_][a-z0-9_]*$/;

/** Return `alias` when it is a plain SQL identifier that does not start with ld_. Throws otherwise. */
function checkAlias(alias: string): string {
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias) || alias.startsWith('ld_')) {
    throw new Error(`lane-dep: bad alias "${alias}"`);
  }
  return alias;
}

// Internal builders: no alias check, so they can use the inner aliases. Only the public functions check.
const lifecycle = (a: string): string =>
  `(${a}.kind IN ('done','state_changed') OR (${a}.kind = 'kanban' AND ${a}.detail->>'kind' = 'state'))`;

const landedSha = (a: string): string =>
  `(SELECT ld_e.detail->>'merged' FROM agentic_os.lane_event ld_e WHERE ld_e.lane_id = ${a}.id AND ` +
  `${lifecycle('ld_e')} ORDER BY ld_e.id DESC LIMIT 1)`;

const laneMet = (a: string): string => `(${a}.state = 'done' AND COALESCE(${landedSha(a)} ~ '^[0-9a-f]{40}$', false))`;

/** The one definition of "open edge", shared by openDepSql and waitsOnSql. */
const openEdgeWhere = (a: string): string =>
  `ld_d.lane_id = ${a}.id AND NOT EXISTS (SELECT 1 FROM agentic_os.lane ld_x WHERE ld_x.id = ld_d.depends_on ` +
  `AND ld_x.project_key = ld_d.project_key AND ${laneMet('ld_x')})`;

/** Scalar SQL: the merged SHA of the latest lifecycle event of lane `alias`, or NULL. */
export function landedShaSql(alias: string): string {
  return landedSha(checkAlias(alias));
}

/** Boolean SQL: lane `alias` is met. True or false, never NULL. */
export function laneMetSql(alias: string): string {
  return laneMet(checkAlias(alias));
}

/** Boolean SQL: lane `alias` has at least one edge that is not met. */
export function openDepSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM agentic_os.lane_dep ld_d WHERE ${openEdgeWhere(checkAlias(alias))})`;
}

/** text[] SQL: the ids of the open edges of lane `alias`, sorted. '{}' when none. */
export function waitsOnSql(alias: string): string {
  return `ARRAY(SELECT ld_d.depends_on FROM agentic_os.lane_dep ld_d WHERE ${openEdgeWhere(checkAlias(alias))} ` +
    'ORDER BY ld_d.depends_on)';
}

/** Boolean SQL on a lane_event alias: the row is a lifecycle event (done, state_changed, or a kanban state tap). */
export function lifecycleWhere(alias: string): string {
  return lifecycle(checkAlias(alias));
}

/**
 * The waits_on column of the board SELECT. The CLI board has no state filter (lane.mjs:1098, 2357): copy it exactly (R1).
 * Without the lane_dep table (migration 0006 not applied) the column is the empty array.
 */
export const waitsOnCol = (withDeps: boolean): string => (withDeps ? waitsOnSql('l') : `'{}'::text[]`);

// --- Text and card fields ----------------------------------------------------------------------

// A lane title is free text. Phase 1 shows no url and no full session id (the brief's privacy rule), so both are replaced.
const URL_TEXT = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g;
const UUID_TEXT = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;

/**
 * Strip invisible characters, replace urls and full uuids, redact, scrub absolute paths, flatten whitespace, then clip.
 * Null when nothing is left. The url goes before redact() on purpose: its host and path are as private as its password.
 */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const plain = stripControl(value.slice(0, 20_000)).replace(URL_TEXT, '[link]').replace(UUID_TEXT, '[id]');
  const flat = scrubPathsInText(redact(plain).text).replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 3))}...`;
}

export function bandOf(value: unknown): Band | null {
  return (BANDS as readonly unknown[]).includes(value) ? (value as Band) : null;
}

function epochOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Same format as fmtCT (reminder-core.mjs:144-148): 'Fri 11-06 08:00 CST'. Fixed zone and locale. */
const CT_WHEN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  weekday: 'short',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});
export function formatCtWhen(epochSeconds: number): string {
  const p = Object.fromEntries(CT_WHEN.formatToParts(epochSeconds * 1000).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

export type LaneCoordRaw = {
  owner_session_id: string | null;
  band: string | null;
  due_epoch: number | string | null;
  lease_epoch: number | string | null;
  now_epoch: number | string | null;
  reclaimable: boolean | null;
  waits_on: unknown;
  /** Optional: a row without them keeps its due time. The board SELECT sends both. */
  state?: string | null;
  remind_state?: string | null;
};
/** What a board card carries. Times are text, formatted on the server (R2). */
export type LaneCoordFields = {
  band: Band | null;
  due: string | null;
  parkedUntil: string | null;
  reclaimable: boolean;
  waitsOn: string[];
  waitsOnMore: number;
};
const WAITS_SHOWN = 10;
const WAITS_CLIP = 60;

export function laneCoordFields(row: LaneCoordRaw): LaneCoordFields {
  const hasOwner = typeof row.owner_session_id === 'string' && row.owner_session_id !== '';
  const lease = epochOf(row.lease_epoch);
  const now = epochOf(row.now_epoch);
  // R11: a closed reminder shows no due time (a done lane, or a reminder Dave acked). A future time still shows.
  const closed = row.state === 'done' || row.remind_state === 'acked';
  const due = closed ? null : epochOf(row.due_epoch);
  const waits = (Array.isArray(row.waits_on) ? row.waits_on : [])
    .map((id) => cleanText(id, WAITS_CLIP))
    .filter((id): id is string => id !== null);
  return {
    band: bandOf(row.band),
    due: due === null ? null : formatCtWhen(due),
    parkedUntil: lease !== null && now !== null && isParked(hasOwner, lease, now) ? formatCtWhen(lease) : null,
    reclaimable: hasOwner && row.reclaimable === true,
    waitsOn: waits.slice(0, WAITS_SHOWN),
    waitsOnMore: Math.max(0, waits.length - WAITS_SHOWN),
  };
}

// --- The Ready query (one statement, no bound value) -------------------------------------------

/**
 * Idle session = not ended, a signal in the last 24 hours, no heartbeat or activity for STALE_MINUTES or more.
 * The filter keeps the 3-argument GREATEST and `s.id NOT LIKE 's-%'` byte for byte: that is sessions_last_signal_idx
 * (docker/init-schema.sql:51-53). The not-ended test is the NULL-safe COALESCE form (a NOT (a AND b) form drops rows).
 * No LIMIT here: a LIMIT before the count could drop a session that has unread messages.
 */
const IDLE_CANDIDATES = `SELECT s.id,
    EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - ${ALIVE_AT('s.')}))::int AS idle_seconds
  FROM public.sessions s
  WHERE s.id NOT LIKE 's-%'
    AND GREATEST(s.last_heartbeat, s.last_activity_at, s.ended_at)
        > (now() AT TIME ZONE 'UTC') - interval '${IDLE_WINDOW_HOURS} hours'
    AND NOT COALESCE(
      s.ended_at >= GREATEST(s.last_heartbeat, COALESCE(s.last_activity_at, s.last_heartbeat)),
      s.ended_at IS NOT NULL)
    AND ${ALIVE_AT('s.')} <= (now() AT TIME ZONE 'UTC') - interval '${STALE_MINUTES} minutes'`;

const KIND = (kind: string): string => `'${kind}'::text AS kind`;
const NOW_EPOCH = 'EXTRACT(EPOCH FROM now())::float8 AS now_epoch';
const FETCH = COORD_KIND_LIMIT + 1;

/**
 * Three UNION ALL branches: unread direct messages (a count per idle session), parks that end within 48 hours
 * (SQL pre-filters loosely; isParked applies the exact rule in TypeScript), and due reminders on every board.
 * It names no column of lane_event except id, session_id and to_session_id: never body or detail.
 * Every literal is a constant of this module. A later runtime value must go through the drizzle sql tag.
 */
export function readyCoordSql(): string {
  return `WITH cand AS (${IDLE_CANDIDATES})
(SELECT ${KIND('unread')}, c.id AS sid, NULL::text AS lane_id, NULL::text AS title, NULL::text AS project_key,
   NULL::text AS band, count(*)::int AS n, c.idle_seconds, NULL::float8 AS at_epoch, ${NOW_EPOCH}
 FROM cand c JOIN agentic_os.lane_event e ON ${unreadDmSql('c.id')}
 GROUP BY c.id, c.idle_seconds ORDER BY c.idle_seconds DESC, c.id LIMIT ${FETCH})
UNION ALL
(SELECT ${KIND('park')}, NULL::text, l.id, left(l.title, 200), l.project_key, l.band, NULL::int, NULL::int,
   EXTRACT(EPOCH FROM l.lease_expires_at)::float8, ${NOW_EPOCH}
 FROM agentic_os.lane l
 WHERE l.owner_session_id IS NOT NULL AND l.state <> 'done'
   AND l.lease_expires_at > now() + interval '${LEASE_MINUTES + 1} minutes'
   AND l.lease_expires_at <= now() + interval '${PARK_WINDOW_SECONDS} seconds'
 ORDER BY l.lease_expires_at, l.id LIMIT ${FETCH})
UNION ALL
(SELECT ${KIND('reminder')}, NULL::text, l.id, left(l.title, 200), l.project_key, l.band, NULL::int, NULL::int,
   EXTRACT(EPOCH FROM l.due_at)::float8, ${NOW_EPOCH}
 FROM agentic_os.lane l
 WHERE ${REMINDER_DUE_WHERE}
 ORDER BY ${laneOrderSql('l')} LIMIT ${FETCH})`;
}

// --- Ready rows --------------------------------------------------------------------------------

export type CoordRaw = {
  kind: string;
  sid: string | null;
  lane_id: string | null;
  title: string | null;
  project_key: string | null;
  band: string | null;
  n: number | string | null;
  idle_seconds: number | string | null;
  at_epoch: number | string | null;
  now_epoch: number | string | null;
};
/** `text` is the whole line for Dave (ruling R8). The other fields are for tests and data attributes. */
export type CoordUnread = { kind: 'unread'; shortId: string; name: string | null; count: number; idleMinutes: number; text: string };
export type CoordPark = { kind: 'park'; laneId: string; title: string; board: string; band: Band | null; text: string };
export type CoordReminder = { kind: 'reminder'; laneId: string; title: string; board: string; band: Band | null; text: string };
export type CoordRow = CoordUnread | CoordPark | CoordReminder;
export type ReadyCoord = { status: 'ok' | 'error'; error: string | null; rows: CoordRow[]; truncated: boolean; nowEpoch: number | null };
export const coordError = (error: string): ReadyCoord => ({ status: 'error', error, rows: [], truncated: false, nowEpoch: null });

const messages = (n: number): string => `${n} unread direct ${n === 1 ? 'message' : 'messages'}`;

/** The full session id dies here: only the first 8 characters go on. */
function toUnread(r: CoordRaw, names: ReadonlyMap<string, string>): CoordUnread | null {
  const shortId = typeof r.sid === 'string' ? cleanText(r.sid.slice(0, 8), 12) : null;
  const count = Number(r.n ?? 0);
  if (shortId === null || !(count > 0)) return null;
  const name = names.get(r.sid as string) ?? null;
  const idleMinutes = Math.max(0, Math.floor(Number(r.idle_seconds ?? 0) / 60));
  const text = `${name ?? 'unnamed'} #${shortId}: ${messages(count)}, idle ${idleMinutes} min`;
  return { kind: 'unread', shortId, name, count, idleMinutes, text };
}

function laneBase(r: CoordRaw) {
  const laneId = cleanText(r.lane_id, 60);
  const board = cleanText(r.project_key, 64);
  if (laneId === null || board === null) return null;
  return { laneId, board, title: cleanText(r.title, 120) ?? '', band: bandOf(r.band) };
}

function toPark(r: CoordRaw): CoordPark | null {
  const base = laneBase(r);
  const ends = epochOf(r.at_epoch);
  const now = epochOf(r.now_epoch);
  if (base === null || ends === null || now === null) return null;
  // The SQL branch already requires an owner.
  if (!isParked(true, ends, now) || ends - now > PARK_WINDOW_SECONDS) return null;
  return { kind: 'park', ...base, text: `${base.laneId} parked until ${formatCtWhen(ends)} (${base.board})` };
}

function toReminder(r: CoordRaw): CoordReminder | null {
  const base = laneBase(r);
  const due = epochOf(r.at_epoch);
  if (base === null || due === null) return null;
  return { kind: 'reminder', ...base, text: `${base.laneId} reminder due ${formatCtWhen(due)} (${base.board})` };
}

/**
 * Order shown (ruling R10): first one row of each kind that has rows, in the order unread, park, reminder; then every
 * other row in the same kind order. Inside a kind the order is the order the SQL gave. No kind hides another: the page
 * draws only the first rows. At most COORD_KIND_LIMIT per kind. `names` is keyed by the full session id.
 */
export function toReadyCoord(rows: readonly CoordRaw[], names: ReadonlyMap<string, string>): ReadyCoord {
  const of = (k: string) => rows.filter((r) => r.kind === k);
  // Map and drop first, then cut: a raw row that a mapper rejects (a lease under the exact park rule) takes no place.
  const pick = <T>(k: string, map: (r: CoordRaw) => T | null): T[] =>
    of(k).map(map).filter((x): x is T => x !== null).slice(0, COORD_KIND_LIMIT);
  const truncated = ['unread', 'park', 'reminder'].some((k) => of(k).length > COORD_KIND_LIMIT);
  const byKind: CoordRow[][] = [
    pick('unread', (r) => toUnread(r, names)),
    pick('park', toPark),
    pick('reminder', toReminder),
  ];
  const out: CoordRow[] = [...byKind.flatMap((list) => list.slice(0, 1)), ...byKind.flatMap((list) => list.slice(1))];
  return { status: 'ok', error: null, rows: out, truncated, nowEpoch: epochOf(rows[0]?.now_epoch) };
}
