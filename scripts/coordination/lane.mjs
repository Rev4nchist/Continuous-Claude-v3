#!/usr/bin/env node
/**
 * lane -- the coordination surface for concurrent sessions, one board per project.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two or more Claude Code sessions run on one project at once and cannot see
 * each other's conversation. This is how they see each other: a lane is a
 * durable, human-named work thread with a declared scope, and a session claims
 * one before it starts. The claim is atomic, so two sessions racing produce
 * exactly one winner and one loser that is TOLD it lost, by name.
 *
 * Schema and the full design rationale: apps/agentic-os/src/db/schema/lane.ts.
 *
 * BOARDS
 * ------
 * Every lane and event belongs to a board (`project_key`). The board comes from the
 * project registry (scripts/coordination/lane-board.mjs): `--project <key>`, then
 * LANE_PROJECT, then the longest registry root that holds the cwd. A directory with no
 * board exits 1 and prints how to register it. The board key is cooperative: it picks
 * what a session sees and is never a security boundary. Broadcasts stay on their board;
 * a direct message may cross boards. Migration 0004 adds the columns and a trigger that
 * refuses a write to a foreign-board lane unless the client says `lane.client_version`.
 * Every verb that opens the database checks first that migration 0004 is applied, and exits 1 if not (no degraded mode).
 * A directory that can never be registered (home, ~/.claude, the OS temp dir) is told to pass `--project continuous-claude`.
 * note, state, release and done are keyed on the lane owner: with no board from the cwd they use the board of a lane the caller owns.
 *
 * IDENTITY -- READ THIS BEFORE CHANGING IT
 * ----------------------------------------
 * The session id comes from `CLAUDE_CODE_SESSION_ID`, the per-process uuid
 * Claude Code injects into every Bash/PowerShell call. It matches the uuid the
 * hooks coordinate on and the one in `sessions.id`.
 *
 * It must NEVER fall back to `~/.claude/.coordination-session-id`. That file is
 * a SINGLE GLOBAL PATH: with two sessions live, whichever registered last owns
 * it, so every session reading it would answer with the same id and the lock
 * would be coordinating one imaginary session with itself. That is precisely the
 * identity bug this project spent a session root-causing (8,179 claims, 0 owned
 * by a live session). Explicit `--as <id>` is the only override.
 *
 * FAILURE POSTURE
 * ---------------
 * This is a CLI a human or agent runs deliberately, not a hook in the Edit path,
 * so it fails LOUD -- a coordination command that silently no-ops is worse than
 * one that errors, because the caller would proceed believing it had the lane.
 *
 * USAGE
 *   node scripts/coordination/lane.mjs board [--all] [--by priority]   # this board, grouped by track; --all = every board, read-only
 *                                                       # --by priority: one flat list of open lanes, band shown before each id
 *   node scripts/coordination/lane.mjs next             # first claimable lane in the shared order (band, due_at, priority, id)
 *   node scripts/coordination/lane.mjs mine             # my lanes + lease time left
 *   node scripts/coordination/lane.mjs claim <id> [--note "..."]
 *   node scripts/coordination/lane.mjs note  <id> "status line"
 *   node scripts/coordination/lane.mjs state <id> <backlog|ready|active|blocked|review|done>
 *   node scripts/coordination/lane.mjs release <id> [--note "why"]
 *   node scripts/coordination/lane.mjs done <id> [--note "evidence"]
 *   node scripts/coordination/lane.mjs renew            # push my leases out
 *   node scripts/coordination/lane.mjs say "message" [--to <name|sid-prefix>] [--lane <id>]
 *   node scripts/coordination/lane.mjs inbox [--peek]   # unread; advances watermark unless --peek
 *   node scripts/coordination/lane.mjs add <id> --title "..." [--track t] [--scope "..."] [--band P0|P1|P2|none] [--priority 1-999]
 *                                                       # on an existing lane an omitted --band / --priority keeps the stored value
 *   node scripts/coordination/lane.mjs band <id> P0|P1|P2|none   # set the importance band; needs migration 0005; no claim needed
 *   node scripts/coordination/lane.mjs band-backfill --dry-run [--p0 id,id|none] [--json]   # read-only: band table (now, after), a triage list,
 *                                                       # and the exact "to apply:" line to copy (it carries --expect N)
 *   node scripts/coordination/lane.mjs band-backfill --apply --p0 id,id,...|none --expect N   # first banding, after Dave's yes. Only lanes with
 *                                                       # band IS NULL get the map (priority 1..9 P1, 10..40 P2, else Unsorted); a lane named in
 *                                                       # --p0 gets P0 whatever band it has (never automatic; soft cap 5). Done lanes are skipped.
 *                                                       # --expect N must equal the lanes that would change, else it rolls back (the board changed
 *                                                       # since the dry run). One transaction; a lock wait over 5s fails with 0 writes; updated_at
 *                                                       # kept; per-lane 'band' events go to the caller only, plus ONE broadcast summary line
 *                                                       # (actor 'backfill'); a second run with the same --p0 list changes 0 rows
 *   node scripts/coordination/lane.mjs remind set <id> --at <time> [--title "..."] [--pri P0|P1|P2] [--action <id>] [--done-when "..."] [--allow-past]
 *                                                       # a reminder is a lane with a due time. <time>: ISO with an offset, 'YYYY-MM-DD HH:MM' (America/Chicago)
 *                                                       # or 'YYYY-MM-DD' (08:00 CT). A new id needs --title (track reminders, state backlog).
 *                                                       # --pri omitted keeps the stored band, else P1. P0 only with a literal --pri P0 (soft cap 5).
 *                                                       # --action is an allowlist id, shown as text; v1 never runs it. Needs migration 0005.
 *   node scripts/coordination/lane.mjs remind list [--all] [--due] [--json]   # open reminders in the shared order; --all adds acked and done; --due: due now
 *   node scripts/coordination/lane.mjs remind snooze <id> --for 30m|2h|1d | --at <time>   # new due time, state scheduled, fired_at cleared
 *   node scripts/coordination/lane.mjs remind ack <id>  # alias: remind done. Marks the reminder acked; the lane state stays
 *   node scripts/coordination/lane.mjs remind clear <id>  # the lane stops being a reminder; band and notion_page_id stay
 *   node scripts/coordination/lane.mjs seed <file.json> # idempotent bulk add; items may carry band and priority (omitted = keep)
 *   node scripts/coordination/lane.mjs peers [--all]    # who else is live on this board (--all: on the machine)
 *   node scripts/coordination/lane.mjs whoami           # my label, uuid and lanes
 *   node scripts/coordination/lane.mjs adopt --from <old-uuid>
 *                                                       # take over lanes + unread DMs after /clear, resume, fork
 *   node scripts/coordination/lane.mjs apply-kanban <file.json> [--dry-run] [--json]
 *                                                       # carry Dave's kanban changes into the lanes
 *   node scripts/coordination/lane.mjs project which    # the resolved board, the rule that won, the registry entry
 *   node scripts/coordination/lane.mjs project register <path> [--key k] [--board parent]
 *                                                       # edits the PRIMARY checkout's registry and ~/.claude's; refuses when they differ;
 *                                                       # a board other than continuous-claude needs the PR2 hook build live
 *   node scripts/coordination/lane.mjs project unregister <key>   # not continuous-claude
 *
 * Global flags: --as <session-id>, --json, --project <board-key>
 */

import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { repoPath } from './canon-home.mjs';
import { DEFAULT_BOARD, boardRoots, laneCliCmd, loadRegistry, normalizeRoot, resolveBoard, wmKey } from './lane-board.mjs';
import { planKanban } from './kanban-apply.mjs';
import { parseBand, parseExpect, parseP0List, parsePriority } from './lane-band.mjs';
import { bandTag, laneOrderSql } from './lane-sort.mjs';
import { processMatchSummary } from './process-match.mjs';
import {
  assertFuture, fmtCT, overdueLabel, parseAction, parseDue, parseFor, remindDetail, resolvePri,
} from './reminder-core.mjs';
import { mirrorRegistryPath, registryDrift } from './registry-drift.mjs';
import {
  adoptAllowed, isSafeId, label, labelWithAgent, listIdentities, readIdentity, resolveName, short, validAgent,
} from './session-label.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

/**
 * `pg` is not a dependency of the repo root -- it lives in the hooks bundle and
 * in apps/agentic-os, of this checkout or of the primary (scripts/lib/resolve-deps.mjs).
 * A miss throws the one ENV error that names every folder tried and the fix.
 */
function loadPg() {
  return requireDep('pg', { repoRoot: REPO });
}

const LANE_STATES = ['backlog', 'ready', 'active', 'blocked', 'review', 'done'];

/** 90 minutes. Long on purpose: a lane spans hours of work across many edits,
 *  so a file-lock-sized lease would lapse mid-thought and invite a takeover of
 *  work still in flight. See the schema comment. */
const LEASE_MINUTES = 90;
/** A session quiet for this long is treated as gone, matching the file-claims rule. */
const STALE_MINUTES = 5;

function connString() {
  return process.env.CONTINUOUS_CLAUDE_DB_URL
    || process.env.DATABASE_URL
    || process.env.OPC_POSTGRES_URL
    || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';
}

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  } else positional.push(a);
}
const JSON_OUT = flags.json === true;

function me() {
  const id = typeof flags.as === 'string' ? flags.as : process.env.CLAUDE_CODE_SESSION_ID;
  if (!id) {
    throw new Error(
      'no session id. CLAUDE_CODE_SESSION_ID is unset and --as was not given.\n' +
      'Deliberately NOT falling back to ~/.claude/.coordination-session-id -- that\n' +
      'file is global and would make every session claim the same identity.',
    );
  }
  return id;
}

/** What this CLI tells the DB trigger (migration 0004): "I know about boards". */
const CLIENT_VERSION = '2';
const BOARD_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
let BOARD = null;
const fwd = (p) => String(p).replace(/[\\]/g, '/');
/** The primary checkout (`~/continuous-claude`, or CCV3_USER_HOME/continuous-claude). Registry edits and the
 *  hints name this one, never the worktree this script may run from: a worktree has its own copy of the registry. */
const PRIMARY = repoPath();

/** The resolver's answer for this cwd, or null. Throws only for an unknown --project / LANE_PROJECT. */
function softBoard() {
  if (BOARD === null) {
    BOARD = resolveBoard(process.cwd(), { cli: true, projectFlag: typeof flags.project === 'string' ? flags.project : undefined }) ?? false;
    if (BOARD) warnIfMirrorStale();
  }
  return BOARD || null;
}

/**
 * The board came from the home mirror (~/.claude/project-registry.json). Until the post-merge sync, a stale mirror can give a
 * nested app the wrong board, and `add` then writes lanes with that project_key (PR 297). Say so on stderr, once per run. Never blocks.
 * An explicit LANE_REGISTRY_PATH is a deliberate override (tests, probes): no warning.
 */
function warnIfMirrorStale() {
  if (process.env.LANE_REGISTRY_PATH) return;
  try {
    const repoFile = registryRepoFile();
    const mirror = mirrorRegistryPath(process.env);
    if (resolve(repoFile) === resolve(mirror)) return;
    const d = registryDrift(repoFile, mirror);
    if (d.state !== 'differ') return;
    const shown = d.diffs.slice(0, 3).join('; ') + (d.diffs.length > 3 ? `; and ${d.diffs.length - 3} more` : '');
    console.error(`WARNING: board '${BOARD.key}' came from ${fwd(mirror)}, which differs from the repo copy ${fwd(repoFile)}: ${shown}. ` +
      'The board may be wrong. Fix: on main, run scripts/sync-to-active.sh --changed (or run lane.mjs with LANE_REGISTRY_PATH set to the repo copy).');
  } catch { /* a warning must never break a lane command */ }
}

/** The board for this run. A cwd with no board is an error that says how to register it. */
function projectOf() {
  const b = softBoard();
  if (!b) {
    const cwd = fwd(process.cwd());
    const never = unsafeRootReason(realOrSelf(process.cwd()));
    // A directory register would refuse (home, ~/.claude, the OS temp dir) can never get a board: do not send the caller there.
    if (never) {
      throw new Error(`no lane board for ${cwd}; this directory cannot be registered (${never}). ` +
        `Pass --project ${DEFAULT_BOARD} or set LANE_PROJECT=${DEFAULT_BOARD} (or the key of another registered board).`);
    }
    throw new Error(`no lane board for ${cwd}; register it: ${laneCliCmd()} project register ${cwd}`);
  }
  return b;
}

/**
 * The board for a verb keyed on the lane owner (note, state, release, done). A cwd that resolves to no board
 * (a session started in the home dir, T7) falls back to the board of the lane row, but only for the session that
 * owns the lane -- the way `renew` is keyed on the owner. An explicit --project / LANE_PROJECT never reaches the
 * fallback: softBoard() already answered (or threw) for it.
 */
async function projectForOwnedLane(c, id, myId) {
  const b = softBoard();
  if (b || !id) return projectOf();
  const row = (await c.query(`SELECT project_key FROM agentic_os.lane WHERE id=$1 AND owner_session_id=$2`, [id, myId])).rows[0];
  if (!row) return projectOf();
  BOARD = { key: row.project_key, root: null, source: 'lane-owner', via: id };
  return BOARD;
}
/** Board key for an event row: the resolved board, else the default board. */
const eventBoard = () => (BOARD ? BOARD.key : DEFAULT_BOARD);

// Session names live in identity files (session-label.mjs). Read once per run.
let IDS = null;
const ids = () => (IDS ??= listIdentities());
const L = (uuid) => label(uuid, ids());
const nameOf = (uuid) => ids().get(uuid)?.name || null;
/** --agent <type> tags a subagent's say/note. An invalid value is ignored. */
const agentDetail = () => { const a = validAgent(flags.agent); return a ? { agent: a } : {}; };

/** Inbox times: America/Chicago, with the zone abbreviation that is in force (CST or CDT). */
function chicagoTime(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(new Date(d));
  const p = (t) => parts.find((x) => x.type === t)?.value;
  return `${p('hour')}:${p('minute')} ${p('timeZoneName')}`;
}

// ---------------------------------------------------------------- db

async function withDb(fn) {
  const { Client } = loadPg();
  const client = new Client({
    connectionString: connString(),
    connectionTimeoutMillis: 4000,
    query_timeout: 8000,
  });
  await client.connect();
  try {
    // Session level: most writes here are single statements outside a transaction. The
    // 0004 trigger reads this setting to tell a board-aware client from an old copy.
    await client.query(`SELECT set_config('lane.client_version', $1, false)`, [CLIENT_VERSION]);
    // One check before any verb runs. Without it a database that lacks migration 0004 fails halfway:
    // `adopt` commits its moves and then throws, `mine` prints [undefined]. Strict on purpose: no degraded mode.
    await assertMigrated(client);
    return await fn(client);
  } finally { await client.end().catch(() => {}); }
}

/** SQLSTATE 42703 on project_key: the database has not had migration 0004 applied. */
const isMissingMigration = (e) => e?.code === '42703' && /project_key/.test(e.message || '');

/** SQLSTATE 42703 on `band`: the database has not had migration 0005 applied. Returns the error to throw (the original when it is something else). */
const bandMigrationError = (e) => (e?.code === '42703' && /\bband\b/.test(e.message || '')
  ? new Error('migration 0005 (lane band) is not applied to this database; apply it before you set a band')
  : e);

/** SQLSTATE 42703 on a reminder column (or band): the database has not had migration 0005 applied. One message, no stack. */
const remindMigrationError = (e) => (e?.code === '42703' && /\b(band|due_at|remind_state|fired_at|action_id)\b/.test(e.message || '')
  ? new Error('migration 0005 (lane reminders) is not applied to this database; apply it before you use remind')
  : e);

/**
 * The open, due reminders: a due time that has passed and a state that still waits for Dave. Nothing sets
 * remind_state='due' until the tick exists (a later PR), so "due" is read from the clock: due_at <= now().
 * TWIN of REMINDER_DUE_PRED in .claude/hooks/src/lane-context.ts; lane-context-reminders.test.ts compares the two texts.
 */
const REMINDER_DUE_PRED = `l.due_at IS NOT NULL AND l.due_at <= now()
  AND l.remind_state IN ('scheduled','due','needs_dave','failed')`;

/**
 * What `next` may offer as work: a lane that is not a reminder (track 'reminders', made by `remind set`) and whose
 * due time, if it has one, has passed. A reminder lane is never work: an acked one would stay at the top for ever.
 * TWIN of CLAIMABLE_NOT_REMINDER in .claude/hooks/src/lane-context.ts; lane-context-reminders.test.ts compares the two texts.
 */
const CLAIMABLE_NOT_REMINDER = `l.track <> 'reminders' AND (l.due_at IS NULL OR l.due_at <= now())`;

/** The P0 soft cap (Dave): a warning, never a refusal. */
const P0_CAP = 5;

/** Record a lane event on the current board. Never throws into the caller's result path --
 *  a failed log line must not make a successful claim look like a failure. The one
 *  exception is a database without migration 0004: that is a setup error, and a `say`
 *  that reports "sent" while recording nothing would be worse than a loud failure. */
async function logEvent(c, { laneId = null, kind, sessionId, to = null, body = null, detail = {} }) {
  try {
    await c.query(
      `INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body, detail, project_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [laneId, kind, sessionId, to, body, JSON.stringify(detail), eventBoard()],
    );
  } catch (e) {
    if (isMissingMigration(e)) throw e;
    process.stderr.write(`[lane] warn: event not recorded (${e.message})\n`);
  }
}

/**
 * WHEN A SESSION WAS LAST ALIVE -- one expression, so no reader invents its own.
 *
 * NOT bare `last_heartbeat`. `heartbeat.ts` fires on UserPromptSubmit ONLY, so
 * that column measures the HUMAN typing, not the agent working. Measured peak
 * staleness during a 12-agent workflow: 505s, while the session was editing
 * continuously. Keying liveness on it alone means a session that is mid-edit
 * reads as dead and its lane or file claim becomes reclaimable out from under it
 * -- demonstrated live on session 079ae1e7 (heartbeat age 1521s, activity age
 * 25s, lock said dead, truth said alive).
 *
 * GREATEST ignores NULLs and returns NULL only when EVERY argument is NULL, so
 * rows written before `last_activity_at` had a writer degrade exactly to the old
 * behaviour rather than to "never alive".
 *
 * Takes the table alias so the SAME text is used in every query. The reason this
 * bug existed at all is that the predicate was spelled out at eight separate
 * sites and only some were updated; `scripts/coordination/liveness-predicate-guard.mjs`
 * now asserts a nonzero count of this form and zero of the bare form.
 */
const ALIVE_AT = (alias = '') => `GREATEST(${alias}last_heartbeat, ${alias}last_activity_at)`;

/**
 * The reclaimability predicate, in one place so every query agrees.
 *
 * BOTH conditions, never either: an expired lease on a live session means the
 * owner is still working and merely slow, and a dead session inside its lease is
 * still dead. This mirrors the rule that shipped for file_claims -- when the two
 * layers disagree about what "abandoned" means, the humans reading them stop
 * trusting either.
 */
const RECLAIMABLE = `(
  l.owner_session_id IS NULL
  OR (
    (l.lease_expires_at IS NULL OR l.lease_expires_at < now())
    AND NOT EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = l.owner_session_id
        AND ${ALIVE_AT('s.')} > now() - interval '${STALE_MINUTES} minutes'
    )
  )
)`;

// ---------------------------------------------------------------- render

const STATE_MARK = {
  backlog: '·', ready: 'o', active: '>', blocked: '!', review: '?', done: 'x',
};

function laneLine(l, myId, showBoard = false) {
  const mine = l.owner_session_id === myId;
  const who = l.owner_session_id ? (mine ? 'YOU' : L(l.owner_session_id)) : '';
  const lease = l.lease_expires_at
    ? Math.round((new Date(l.lease_expires_at) - Date.now()) / 60000)
    : null;
  const leaseTag = l.owner_session_id
    ? (lease === null ? '' : lease > 0 ? ` ${lease}m` : ` LAPSED`)
    : '';
  const head = `${STATE_MARK[l.state] || '·'} ${bandTag(l.band)} ${l.id.padEnd(26)} ${String(l.state).padEnd(8)} ${(who + leaseTag).padEnd(30)}`;
  const lines = [`${head} ${showBoard ? `[${l.project_key}] ` : ''}${l.title}`];
  if (l.note) lines.push(`${' '.repeat(30)}${l.note}`);
  if (l.scope) lines.push(`${' '.repeat(30)}scope: ${l.scope}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- board helpers

/** `sessions.project` folded the way normalizeRoot folds a path (the SQL twin, steps in the same order): forward
 *  slashes (chr(92) is a backslash), the `//?/` or `//./` extended-length prefix dropped, lower case, a leading
 *  /c/ becomes c:/, runs of slashes collapse to one (not at the very start), no trailing slash. */
const FOLDED_PROJECT = (alias = 's.') =>
  `rtrim(regexp_replace(regexp_replace(lower(regexp_replace(replace(${alias}project, chr(92), '/'), '^//[?.]/', '')), ` +
  `'^/([a-z])(/|$)', '\\1:\\2'), '(?<=.)/{2,}', '/', 'g'), '/')`;

/** SQL: the session's project is a root of the board, or under one. starts_with, never LIKE: paths hold `_`. */
const underRootsSql = (rootsParam) => `EXISTS (SELECT 1 FROM unnest(${rootsParam}::text[]) r
           WHERE ${FOLDED_PROJECT()} = r OR starts_with(${FOLDED_PROJECT()}, r || '/'))`;

/** SQL: a peer of the board = under its roots, or it owns a lane there (T7: a session started in the home dir). */
const peerOfBoardSql = (rootsParam, boardParam) => `(
  ${underRootsSql(rootsParam)}
  OR EXISTS (SELECT 1 FROM agentic_os.lane bl
              WHERE bl.owner_session_id = s.id AND bl.project_key = ${boardParam}::text))`;

/**
 * The events a session has not read. $1 = me, $2 = board, $3 = this board's cursor row key.
 * Broadcasts use this board's cursor. A direct message uses ONE cursor, the highest across all
 * of my rows (`<id>` and every `<id>@<board>`), so a DM never shows twice across boards (T4).
 */
const UNREAD_SQL = `e.session_id <> $1::text AND (
  (e.to_session_id IS NULL AND e.project_key = $2::text
     AND e.id > COALESCE((SELECT last_event_id FROM agentic_os.lane_watermark WHERE session_id = $3::text), 0))
  OR (e.to_session_id = $1::text
     AND e.id > COALESCE((SELECT MAX(last_event_id) FROM agentic_os.lane_watermark
                           WHERE session_id = $1::text OR starts_with(session_id, $1::text || '@')), 0)))`;
const unreadParams = (myId, board) => [myId, board, wmKey(myId, board)];

/** Live sessions on a board (ALIVE_AT as everywhere), or on the whole machine when `all`. */
async function livePeers(c, board, all) {
  const roots = board ? boardRoots(board.key) : [];
  return (await c.query(
    `SELECT s.id, s.working_on, ${ALIVE_AT('s.')} AS last_alive,
            (SELECT string_agg(l.id, ', ' ORDER BY l.id) FROM agentic_os.lane l
              WHERE l.owner_session_id = s.id AND l.state <> 'done'
                AND ($1::boolean OR l.project_key = $2::text)) AS lanes
     FROM sessions s
     WHERE ${ALIVE_AT('s.')} > now() - interval '${STALE_MINUTES} minutes'
       AND ($1::boolean OR ${peerOfBoardSql('$3', '$2')})
     ORDER BY ${ALIVE_AT('s.')} DESC`,
    [all, board ? board.key : null, roots],
  )).rows;
}

/**
 * "Open, quiet" sessions: not active (beat more than STALE_MINUTES ago), and either seen inside QUIET_HOURS or holding a
 * non-done lane. Heartbeat moves on a tool call or a prompt only, so a session waiting for Dave looks dead after
 * STALE_MINUTES while it still holds lanes. This is a display count: it changes no claim or reclaim rule.
 * An ended session (ended_at is its latest signal, the agentic-os rule) is never open, even when it still holds a lane.
 * The active count and this one are two statements with two now() values; a session on the 5 minute line can be missed once.
 * TWIN of quietCount in render-board.mjs (the phone page prints the same number); render-board.test.mjs pins both.
 */
const QUIET_HOURS = 2;
async function quietCount(c, board, all) {
  const roots = board ? boardRoots(board.key) : [];
  return (await c.query(
    `SELECT count(*)::int AS n FROM sessions s
     WHERE ${ALIVE_AT('s.')} <= now() - interval '${STALE_MINUTES} minutes'
       AND NOT COALESCE(s.ended_at >= GREATEST(s.last_heartbeat, COALESCE(s.last_activity_at, s.last_heartbeat)), false)
       AND ($1::boolean OR ${peerOfBoardSql('$3', '$2')})
       AND (${ALIVE_AT('s.')} > now() - interval '${QUIET_HOURS} hours'
            OR EXISTS (SELECT 1 FROM agentic_os.lane ql WHERE ql.owner_session_id = s.id AND ql.state <> 'done'
                       AND ($1::boolean OR ql.project_key = $2::text)))`,
    [all, board ? board.key : null, roots],
  )).rows[0].n;
}

/** The error for a lane id that is not on this board; names the board that has it. */
async function noLane(c, id, board) {
  const other = (await c.query(`SELECT project_key FROM agentic_os.lane WHERE id=$1`, [id])).rows[0];
  const hint = other
    ? `; it exists on board ${other.project_key} (run with --project ${other.project_key})`
    : `. Run: lane.mjs board`;
  return new Error(`no lane ${id} on board ${board.key}${hint}`);
}

/** The error for an add/seed that hit a lane id owned by another board. */
async function foreignId(c, id) {
  const other = (await c.query(`SELECT project_key FROM agentic_os.lane WHERE id=$1`, [id])).rows[0];
  return new Error(`lane id '${id}' belongs to board '${other ? other.project_key : '?'}'`);
}

const badId = (id) => `lane id '${id}' is not valid: use lower case letters, digits and '-', starting with a letter or digit`;

/** Which of these sessions sit on the board (their project is under a board root)? Keeps the order.
 *  Roots only: owning a lane there does not count, so adopting a lane does not decide who a name means. */
async function sessionsOnBoard(c, uuids, boardKey) {
  if (!uuids.length) return [];
  const rows = (await c.query(
    `SELECT s.id FROM sessions s WHERE s.id = ANY($1::text[]) AND ${underRootsSql('$2')}`,
    [uuids, boardRoots(boardKey)],
  )).rows.map((r) => r.id);
  return uuids.filter((u) => rows.includes(u));
}

/**
 * Who does `--to <want>` mean? A name first (exact, recent sessions), then a uuid prefix.
 * Several sessions with the name: prefer the one on this board; otherwise ask for `name@board`.
 * `name@board` picks the session on that board. A DM may cross boards, so a unique name
 * anywhere on the machine is fine.
 */
async function resolveRecipient(c, want, board) {
  const at = /^(.*\S)@([a-z0-9][a-z0-9-]*)$/.exec(want);
  const wantBoard = at && boardRoots(at[2]).length ? at[2] : null;
  const name = wantBoard ? at[1] : want;
  // 1. An exact session name among recent sessions. The old half of a /clear is skipped.
  const named = [...ids()].filter(([, i]) => typeof i.name === 'string').map(([u]) => u);
  const recent = named.length ? new Set((await c.query(
    `SELECT id FROM sessions WHERE id = ANY($1) AND ${ALIVE_AT()} > now() - interval '2 hours'`, [named],
  )).rows.map((r) => r.id)) : new Set();
  const byName = resolveName(name, ids(), recent);
  if (wantBoard) {
    const there = await sessionsOnBoard(c, byName, wantBoard);
    if (there.length === 1) return there[0];
    throw new Error(there.length ? `"${want}" still names ${there.length} sessions: ${there.map(L).join(', ')}. Use #sid8 or the uuid prefix.`
      : `no live session named "${name}" on board ${wantBoard}`);
  }
  if (byName.length > 1) {
    const here = await sessionsOnBoard(c, byName, board.key);
    if (here.length === 1) return here[0];
    throw new Error(`"${want}" names ${byName.length} live sessions: ${byName.map(L).join(', ')}. Use name@board, #sid8 or the uuid prefix.`);
  }
  if (byName.length === 1) return byName[0];
  // 2. Fall back to a uuid prefix. % _ \ are literal characters, not wildcards.
  const prefix = want.replace(/^#/, '').replace(/[\\%_]/g, '\\$&');
  const m = await c.query(
    `SELECT id FROM sessions WHERE id LIKE $1 || '%' ESCAPE '\\'
     AND ${ALIVE_AT()} > now() - interval '2 hours'
     ORDER BY ${ALIVE_AT()} DESC LIMIT 2`, [prefix],
  );
  if (m.rows.length === 0) throw new Error(`no recent session matching "${want}"`);
  if (m.rows.length > 1) throw new Error(`"${want}" is ambiguous -- give more characters`);
  return m.rows[0].id;
}

/** Validate a seed file before any write: id rule, item project, and ids owned by another board. */
async function checkSeedItems(c, items, board) {
  if (!Array.isArray(items)) throw new Error('seed file must hold a JSON array of lanes');
  for (const it of items) {
    if (!it || typeof it.id !== 'string' || !BOARD_KEY_RE.test(it.id)) throw new Error(badId(it?.id));
    if (it.project !== undefined && it.project !== board.key) {
      throw new Error(`seed item '${it.id}' names project '${it.project}' but this run resolved board '${board.key}'`);
    }
    // A bad band or priority rejects the whole file here, before any write.
    parseBand(it.band, `seed item '${it.id}': band`);
    parsePriority(it.priority, `seed item '${it.id}': priority`);
  }
  const foreign = (await c.query(
    `SELECT id, project_key FROM agentic_os.lane WHERE id = ANY($1::text[]) AND project_key <> $2`,
    [items.map((i) => i.id), board.key],
  )).rows[0];
  if (foreign) throw new Error(`lane id '${foreign.id}' belongs to board '${foreign.project_key}'`);
}

// ---------------------------------------------------------------- remind
// A reminder is a lane with a due time (design: .claudedocs/2026-11-06-lane-reminders-design.md). Pure rules live in
// reminder-core.mjs. Every write sets updated_at=now() (the later Notion sync reads it) and logs ONE broadcast
// lane_event of kind 'reminder'. A no-op (the same ack twice, a clear of a non-reminder) writes and logs nothing.

const REMIND_USAGE = 'usage: lane.mjs remind set <id> --at <time> [--title "..."] [--pri P0|P1|P2] [--action <id>] [--done-when "..."] [--allow-past] '
  + '| list [--all] [--due] | snooze <id> --for 30m|2h|1d (or --at <time>) | ack <id> | clear <id>';

function reminderLine(l, now) {
  const late = l.remind_state === 'acked' ? '' : overdueLabel(l.due_at, now);
  return `${bandTag(l.band)} ${l.id.padEnd(26)} ${(l.due_at ? fmtCT(l.due_at) : '(no time)').padEnd(20)} ${String(l.remind_state).padEnd(10)} `
    + `${late ? `${late}  ` : ''}${l.title}${l.action_id ? `  [action: ${l.action_id}]` : ''}`;
}

/** An Error with a `reason` code, so a caller branches on the code and not on the wording of the message. */
const missError = (reason, message) => Object.assign(new Error(message), { reason });

/** Why an ack, snooze or clear changed no row: no such lane on this board, or a state that rules it out. */
async function remindMiss(c, id, board) {
  const cur = (await c.query(`SELECT remind_state, state FROM agentic_os.lane WHERE id=$1 AND project_key=$2`, [id, board.key])).rows[0];
  if (!cur) return noLane(c, id, board);
  if (cur.remind_state === null) return missError('none', `lane ${id} has no reminder; make one with: ${laneCliCmd()} remind set ${id} --at <time>`);
  if (cur.remind_state === 'acked') return missError('acked', `reminder ${id} is acked; reopen it with: ${laneCliCmd()} remind set ${id} --at <time>`);
  return missError('done', `lane ${id} is done; reopen it first: ${laneCliCmd()} state ${id} backlog`);
}

/**
 * A lane another session holds keeps its title and band: remind set may change only the reminder columns on it.
 * The band counts when it would change, including the P1 written for a lane with no band. A title only goes in on create.
 */
function assertNotHeldAway(cur, id, myId, pri) {
  if (!cur?.owner_session_id || cur.owner_session_id === myId) return;
  const changes = [];
  if (flags.title !== undefined && flags.title !== cur.title) changes.push('title');
  if (pri !== cur.band) changes.push(`band ${cur.band ?? 'none'} -> ${pri}`);
  if (!changes.length) return;
  throw new Error(`lane ${id} is held by ${L(cur.owner_session_id)}; remind set would change its ${changes.join(' and ')}. `
    + `Set the band first with: ${laneCliCmd()} band ${id} <P0|P1|P2>, and leave --title out.`);
}

async function remindSet(c) {
  const myId = me();
  const board = projectOf();
  const id = positional[2];
  if (!id) throw new Error(REMIND_USAGE);
  if (!BOARD_KEY_RE.test(id)) throw new Error(badId(id));
  if (flags.at === undefined) throw new Error('--at <time> is required: remind set <id> --at <time>');
  const due = parseDue(flags.at);
  assertFuture(due, new Date(), flags['allow-past'] === true);
  const action = parseAction(flags.action);
  for (const f of ['title', 'done-when']) if (flags[f] !== undefined && typeof flags[f] !== 'string') throw new Error(`--${f} needs a text`);
  const cur = (await c.query(`SELECT project_key, title, state, band, owner_session_id FROM agentic_os.lane WHERE id=$1`, [id])).rows[0];
  if (cur && cur.project_key !== board.key) throw await foreignId(c, id);
  if (cur?.state === 'done') throw new Error(`lane ${id} is done, so a reminder on it would never show; reopen it first: ${laneCliCmd()} state ${id} backlog`);
  if (!cur && flags.title === undefined) throw new Error(`lane ${id} does not exist; a new reminder needs --title "..."`);
  const pri = resolvePri(flags.pri, cur?.band);
  assertNotHeldAway(cur, id, myId, pri);
  if (pri === 'P0' && cur?.band !== 'P0') {
    const open = (await c.query(
      `SELECT count(*)::int AS n FROM agentic_os.lane WHERE project_key=$1 AND state <> 'done' AND band='P0' AND id <> $2`, [board.key, id],
    )).rows[0].n;
    if (open >= P0_CAP) process.stderr.write(`WARNING: board ${board.key} already has ${open} open P0 lanes (soft cap ${P0_CAP}). P0 means this week; the reminder is set anyway.\n`);
  }
  const { rows } = await c.query(
    `INSERT INTO agentic_os.lane (id,title,track,state,priority,project_key,band,due_at,remind_state,fired_at,action_id,done_when)
     VALUES ($1,$2,'reminders','backlog',50,$3,$4,$5,'scheduled',NULL,$6,$7)
     ON CONFLICT (id) DO UPDATE SET
       title = CASE WHEN $8::boolean THEN EXCLUDED.title ELSE agentic_os.lane.title END,
       band = CASE WHEN $9::boolean THEN EXCLUDED.band ELSE COALESCE(agentic_os.lane.band, 'P1') END,
       due_at = EXCLUDED.due_at, remind_state = 'scheduled', fired_at = NULL,
       action_id = CASE WHEN $10::boolean THEN EXCLUDED.action_id ELSE agentic_os.lane.action_id END,
       done_when = COALESCE(EXCLUDED.done_when, agentic_os.lane.done_when),
       updated_at = now()
     WHERE agentic_os.lane.project_key = EXCLUDED.project_key AND agentic_os.lane.state <> 'done'
     RETURNING band, (xmax = 0) AS inserted`,
    [id, flags.title ?? cur?.title, board.key, pri, due.toISOString(), action ?? null, flags['done-when'] ?? null,
     flags.title !== undefined, flags.pri !== undefined, action !== undefined],
  );
  if (!rows.length) throw new Error(`lane ${id} changed while the reminder was set (another board or done now); run it again`);
  await logEvent(c, {
    laneId: id, kind: 'reminder', sessionId: myId, body: `reminder set ${fmtCT(due)} ${rows[0].band}`,
    detail: remindDetail({ op: 'set', due_at: due.toISOString(), pri: rows[0].band, via: 'cli' }),
  });
  if (JSON_OUT) return { id, due_at: due.toISOString(), band: rows[0].band, created: rows[0].inserted };
  return `reminder set on ${id}: ${fmtCT(due)}, ${rows[0].band}${rows[0].inserted ? ' (new lane, track reminders)' : ''}`;
}

async function remindList(c) {
  const board = projectOf();
  const open = `l.state <> 'done' AND l.remind_state IS NOT NULL`;
  const where = flags.due === true ? `l.state <> 'done' AND ${REMINDER_DUE_PRED}`
    : flags.all === true ? `l.remind_state IS NOT NULL` : `${open} AND l.remind_state <> 'acked'`;
  const { rows } = await c.query(
    `SELECT l.* FROM agentic_os.lane l WHERE l.project_key = $1 AND ${where} ORDER BY ${laneOrderSql('l')}`, [board.key],
  );
  if (JSON_OUT) return rows;
  if (!rows.length) return flags.due === true ? 'no reminders due' : 'no reminders';
  const now = new Date();
  return rows.map((l) => reminderLine(l, now)).join('\n');
}

async function remindSnooze(c) {
  const myId = me();
  const id = positional[2];
  if (!id) throw new Error(REMIND_USAGE);
  const hasFor = flags.for !== undefined; const hasAt = flags.at !== undefined;
  if (hasFor === hasAt) throw new Error('remind snooze needs exactly one of --for <30m|2h|1d> or --at <time>');
  const now = new Date();
  const due = hasFor ? new Date(now.getTime() + parseFor(flags.for)) : parseDue(flags.at);
  assertFuture(due, now, false);
  const board = await projectForOwnedLane(c, id, myId);
  const { rows } = await c.query(
    `WITH old AS (SELECT id, due_at, remind_state FROM agentic_os.lane WHERE id=$1 AND project_key=$2 FOR UPDATE)
     UPDATE agentic_os.lane l SET due_at=$3, remind_state='scheduled', fired_at=NULL, updated_at=now()
     FROM old WHERE l.id = old.id AND old.remind_state IS NOT NULL AND old.remind_state <> 'acked' AND l.state <> 'done'
     RETURNING old.due_at AS from_due_at, l.band`,
    [id, board.key, due.toISOString()],
  );
  if (!rows.length) throw await remindMiss(c, id, board);
  await logEvent(c, {
    laneId: id, kind: 'reminder', sessionId: myId, body: `reminder snoozed to ${fmtCT(due)}`,
    detail: remindDetail({ op: 'snooze', due_at: due.toISOString(), from_due_at: rows[0].from_due_at?.toISOString(), pri: rows[0].band, via: 'cli' }),
  });
  return JSON_OUT ? { id, due_at: due.toISOString(), from_due_at: rows[0].from_due_at } : `${id} snoozed to ${fmtCT(due)}`;
}

async function remindAck(c) {
  const myId = me();
  const id = positional[2];
  if (!id) throw new Error(REMIND_USAGE);
  const board = await projectForOwnedLane(c, id, myId);
  const { rows } = await c.query(
    `WITH old AS (SELECT id, remind_state FROM agentic_os.lane WHERE id=$1 AND project_key=$2 FOR UPDATE)
     UPDATE agentic_os.lane l SET remind_state='acked', updated_at=now()
     FROM old WHERE l.id = old.id AND old.remind_state IS NOT NULL AND old.remind_state <> 'acked'
     RETURNING old.remind_state AS from_state, l.band, l.due_at`,
    [id, board.key],
  );
  if (!rows.length) {
    const miss = await remindMiss(c, id, board);
    if (miss.reason !== 'acked') throw miss;
    return JSON_OUT ? { id, changed: false } : `${id} ack unchanged: already acked`;
  }
  await logEvent(c, {
    laneId: id, kind: 'reminder', sessionId: myId, body: `reminder acked (was ${rows[0].from_state})`,
    detail: remindDetail({ op: 'ack', due_at: rows[0].due_at?.toISOString(), pri: rows[0].band, via: 'cli' }),
  });
  return JSON_OUT ? { id, changed: true, from: rows[0].from_state } : `${id} acked (was ${rows[0].from_state})`;
}

async function remindClear(c) {
  const myId = me();
  const id = positional[2];
  if (!id) throw new Error(REMIND_USAGE);
  const board = await projectForOwnedLane(c, id, myId);
  const { rows } = await c.query(
    `WITH old AS (SELECT id, due_at, remind_state, fired_at, action_id FROM agentic_os.lane WHERE id=$1 AND project_key=$2 FOR UPDATE)
     UPDATE agentic_os.lane l SET due_at=NULL, remind_state=NULL, fired_at=NULL, action_id=NULL, updated_at=now(),
       track = CASE WHEN l.track = 'reminders' THEN 'unsorted' ELSE l.track END
     FROM old WHERE l.id = old.id
       AND (old.due_at IS NOT NULL OR old.remind_state IS NOT NULL OR old.fired_at IS NOT NULL OR old.action_id IS NOT NULL)
     RETURNING old.due_at AS from_due_at, l.band`,
    [id, board.key],
  );
  if (!rows.length) {
    const exists = (await c.query(`SELECT 1 FROM agentic_os.lane WHERE id=$1 AND project_key=$2`, [id, board.key])).rowCount;
    if (!exists) throw await noLane(c, id, board);
    return JSON_OUT ? { id, changed: false } : `${id} clear unchanged: it is not a reminder`;
  }
  await logEvent(c, {
    laneId: id, kind: 'reminder', sessionId: myId, body: 'reminder cleared',
    detail: remindDetail({ op: 'clear', due_at: rows[0].from_due_at?.toISOString(), pri: rows[0].band, via: 'cli' }),
  });
  return JSON_OUT ? { id, changed: true } : `${id} cleared: it is no longer a reminder (a lane on track reminders moves to unsorted)`;
}

const REMIND_VERBS = { set: remindSet, list: remindList, snooze: remindSnooze, ack: remindAck, done: remindAck, clear: remindClear };

// ---------------------------------------------------------------- band-backfill
// One-off first banding of the open lanes (design: .claudedocs/2026-11-06-lane-priority-design.md, "Backfill plan").
// Both modes read the same plan. --apply is one transaction over locked open rows (lock_timeout 5s), checks --expect against
// the plan, keeps updated_at, logs one 'band' event per changed lane (actor 'backfill', addressed to the caller) and one broadcast
// summary, and a second run with the same --p0 list changes nothing. The end-to-end proof is band-backfill-probe.mjs.

const BACKFILL_USAGE = 'usage: lane.mjs band-backfill --dry-run [--p0 id,id,...|none] [--json] | --apply --p0 id,id,...|none --expect N [--json]'
  + ' (give exactly one of --dry-run and --apply; N is the change count the dry run printed)';
/** How long --apply waits for a row lock before it gives up and writes nothing. */
const BACKFILL_LOCK_TIMEOUT = '5s';
const BACKFILL_BANDS = ['P0', 'P1', 'P2', 'Unsorted'];
const BACKFILL_TRIAGE_STATES = ['active', 'ready', 'blocked'];

/**
 * The map from a drag rank to a first band: priority 1..9 is P1, 10..40 is P2, anything else (the default 50 and up) gives NULL,
 * which stays Unsorted. P0 is never in this map. The ONE copy: the dry run and the apply both read it.
 */
const BACKFILL_MAP_SQL = `CASE WHEN l.priority BETWEEN 1 AND 9 THEN 'P1' WHEN l.priority BETWEEN 10 AND 40 THEN 'P2' END`;

async function hasBandColumn(c) {
  return (await c.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='agentic_os' AND table_name='lane' AND column_name='band'`,
  )).rowCount > 0;
}

/**
 * The lanes of the board. `which` is 'open' (state <> 'done'), 'done' or 'all'. `lock` takes a row lock, and the caller
 * locks only the open ones: a done lane is never written, so it never blocks the run. A database without 0005 has no band: all read NULL.
 */
async function backfillLanes(c, boardKey, hasBand, which, lock = false) {
  const cond = { open: `AND l.state <> 'done'`, done: `AND l.state = 'done'`, all: '' }[which];
  return (await c.query(
    `SELECT l.id, l.title, l.state, l.priority, ${hasBand ? 'l.band' : 'NULL::text AS band'}, ${BACKFILL_MAP_SQL} AS mapped, NOT ${RECLAIMABLE} AS held
       FROM agentic_os.lane l WHERE l.project_key = $1 ${cond} ORDER BY l.priority, l.id${lock ? ' FOR UPDATE OF l' : ''}`,
    [boardKey],
  )).rows;
}

/** The text a human or model copies to apply this plan: the shim path, the P0 list ('none' when empty) and the change count. */
const backfillApplyCommand = (p0, n) => `${laneCliCmd()} band-backfill --apply --p0 ${p0.length ? p0.join(',') : 'none'} --expect ${n}`;

/** Every --p0 id must be an open lane of this board. One error lists them all; it is thrown before any write. */
async function checkP0Ids(c, rows, p0, board) {
  const byId = new Map(rows.map((l) => [l.id, l]));
  const problems = [];
  for (const id of p0) {
    const l = byId.get(id);
    if (l && l.state !== 'done') continue;
    if (l) { problems.push(`'${id}' is done (P0 needs an open lane)`); continue; }
    const other = (await c.query(`SELECT project_key FROM agentic_os.lane WHERE id=$1`, [id])).rows[0];
    problems.push(other ? `'${id}' is a lane of board ${other.project_key}, not ${board.key}` : `'${id}' is not a lane on board ${board.key}`);
  }
  if (problems.length) throw new Error(`--p0 refused, nothing was written: ${problems.join('; ')}`);
}

/**
 * The plan. Only open lanes change. A named lane gets P0 whatever it has now (Dave named it). Any other lane
 * with a band keeps it; one with no band gets the mapped band (NULL stays NULL). A lane whose band would not move is not a change.
 */
function planBackfill(rows, p0) {
  const named = new Set(p0);
  const open = rows.filter((l) => l.state !== 'done');
  const changes = [];
  for (const l of open) {
    const isNamed = named.has(l.id);
    const to = isNamed ? 'P0' : l.band === null ? l.mapped : l.band;
    if (to === l.band) continue;
    changes.push({
      id: l.id, from: l.band, to, source: isNamed ? 'p0' : 'priority',
      ...(isNamed && l.band !== null ? { note: `already ${l.band}, set to P0 because Dave named it` } : {}),
    });
  }
  const after = new Map(open.map((l) => [l.id, l.band]));
  for (const ch of changes) after.set(ch.id, ch.to);
  const tally = (f) => {
    const m = new Map();
    for (const l of open) { const b = f(l) ?? 'Unsorted'; m.set(b, (m.get(b) || 0) + 1); }
    return m;
  };
  const now = tally((l) => l.band);
  const next = tally((l) => after.get(l.id));
  const table = BACKFILL_BANDS.map((band) => ({ band, now: now.get(band) || 0, after: next.get(band) || 0 }));
  const done = { total: rows.length - open.length, banded: rows.filter((l) => l.state === 'done' && l.band !== null).length };
  const triage = open.flatMap((l) => {
    const to = after.get(l.id);
    const why = [...(BACKFILL_TRIAGE_STATES.includes(l.state) ? [l.state] : []), ...(to === 'P1' ? ['P1 candidate'] : []), ...(named.has(l.id) ? ['named P0'] : [])];
    return why.length ? [{ id: l.id, state: l.state, priority: l.priority, band: l.band, after: to, held: l.held, title: l.title, why }] : [];
  });
  return { changes, table, done, triage, open: open.length };
}

/** One transaction body: the band UPDATE and its events are two statements, and the caller COMMITs or ROLLBACKs both. */
async function writeBackfill(c, changes, boardKey, myId) {
  const ids = changes.map((x) => x.id);
  const { rowCount } = await c.query(
    `UPDATE agentic_os.lane l SET band = v.to_band
       FROM unnest($1::text[], $2::text[]) AS v(id, to_band)
      WHERE l.id = v.id AND l.project_key = $3 AND l.state <> 'done'`,
    [ids, changes.map((x) => x.to), boardKey],
  );
  if (rowCount !== changes.length) throw new Error(`band-backfill: expected ${changes.length} rows and updated ${rowCount}; nothing was written`);
  // Direct INSERT, not logEvent: logEvent swallows its error, and inside a transaction a failed INSERT would abort the rest.
  // Each per-lane event is a message to the caller (to_session_id = the caller): neither unread branch of UNREAD_SQL shows it to
  // anyone else, and the caller's own events are never unread. One broadcast summary line tells the board what happened.
  await c.query(
    `INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body, detail, project_key)
     SELECT v.id, 'band', $1, $1, v.body, v.detail::jsonb, $2 FROM unnest($3::text[], $4::text[], $5::text[]) AS v(id, body, detail)`,
    [myId, boardKey, ids,
     changes.map((x) => `band ${x.from ?? 'none'} -> ${x.to ?? 'none'} (backfill)`),
     changes.map((x) => JSON.stringify({ from: x.from, to: x.to, actor: 'backfill' }))],
  );
  const per = BACKFILL_BANDS.filter((b) => b !== 'Unsorted').map((b) => [b, changes.filter((x) => x.to === b).length]).filter(([, n]) => n > 0);
  await c.query(
    `INSERT INTO agentic_os.lane_event (kind, session_id, body, detail, project_key) VALUES ('band', $1, $2, $3::jsonb, $4)`,
    [myId, `band backfill: ${changes.length} lane${changes.length === 1 ? '' : 's'} banded (${per.map(([b, n]) => `${b} ${n}`).join(', ')})`,
     JSON.stringify({ actor: 'backfill', changed: changes.length, counts: Object.fromEntries(per) }), boardKey],
  );
}

function renderBackfill(r) {
  const w = (s, n) => String(s).padEnd(n);
  const head = r.mode === 'apply'
    ? `band-backfill applied on board ${r.board}: ${r.changed} row${r.changed === 1 ? '' : 's'} changed`
      + (r.changed === 0 ? ' (nothing to do: no open lane with no band maps to a band, and no --p0 lane needs P0)' : '')
    : `band-backfill dry run on board ${r.board} (nothing written)`;
  const out = [head];
  if (!r.band_column) out.push('NOTE: migration 0005 (lane band) is not applied to this database: no lane has a band yet, and --apply needs it.');
  out.push(`open lanes: ${r.open}   done lanes: ${r.done.total} (${r.done.banded} with a band; done lanes are never touched)`, '',
    `${w('band', 10)}${w('now', 6)}after`, ...r.table.map((t) => `${w(t.band, 10)}${w(t.now, 6)}${t.after}`), '');
  const verb = r.mode === 'apply' ? 'changed' : 'would change';
  out.push(`${verb} ${r.changes.length} lane(s)${r.p0.length ? `; named P0: ${r.p0.join(', ')}` : ''}`);
  for (const ch of r.changes) {
    out.push(`  ${w(ch.id, 30)} ${w(ch.from ?? 'none', 5)} -> ${w(ch.to ?? 'none', 5)} ${ch.source === 'p0' ? `named by Dave${ch.note ? ` (${ch.note})` : ''}` : 'priority map'}`);
  }
  out.push('', 'triage (open active, ready and blocked lanes, P1 candidates and named lanes):');
  for (const t of r.triage) {
    out.push(`  ${w(t.id, 30)} ${w(t.state, 8)} prio ${w(t.priority, 4)} ${w(t.band ?? 'none', 5)} -> ${w(t.after ?? 'none', 5)} ${t.held ? 'HELD ' : ''}[${t.why.join(', ')}] ${t.title}`);
  }
  if (r.apply_command) {
    out.push('', `to apply: ${r.apply_command}`);
    if (!r.p0.length) out.push('  (no P0 lane named: to name some, run --dry-run --p0 id,id first; the count and this line change with the list)');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- commands

const commands = {
  async board(c) {
    const myId = me();
    const all = flags.all === true;
    const board = all ? softBoard() : projectOf();
    if (flags.by !== undefined && flags.by !== 'priority') throw new Error('usage: lane.mjs board [--all] [--by priority]');
    // --by priority: one flat list of open lanes in the shared order. The plain board keeps its track groups.
    const flat = flags.by === 'priority';
    const { rows } = await c.query(
      `SELECT l.* FROM agentic_os.lane l
       WHERE ${flat ? `l.state <> 'done' AND ($1::boolean OR l.project_key = $2::text)` : `$1::boolean OR (l.project_key = $2::text AND l.state <> 'done')`}
       ORDER BY l.project_key, ${flat ? '' : 'l.track, '}${laneOrderSql('l')}`,
      [all, board ? board.key : null],
    );
    const peers = (await livePeers(c, board, all)).map((r) => ({ id: r.id, working_on: r.working_on }));
    const quiet = await quietCount(c, board, all);
    // claude.exe processes (whole machine) matched to sessions by start time; null when the list is not available.
    const procs = await processMatchSummary(c);

    if (JSON_OUT) {
      return {
        board: all ? '*' : board.key,
        lanes: rows.map((l) => ({ ...l, owner_name: l.owner_session_id ? nameOf(l.owner_session_id) : null })),
        peers,
        quiet,
        processes: procs,
        me: myId,
        me_short: short(myId),
        me_name: nameOf(myId),
      };
    }

    const out = [];
    out.push(`LANE BOARD   ${all ? 'board (all boards, read-only)' : `board ${board.key}`}   me=${L(myId)}   ${rows.length} ${all ? '' : 'open '}lane(s)   ${peers.length} active (${STALE_MINUTES} min), ${quiet} open, quiet${procs ? `, ${procs.matched}/${procs.total} claude.exe matched${procs.unmatchedPids.length ? ` (no session for pid ${procs.unmatchedPids.join(', ')})` : ''}` : ''}`);
    let group = null;
    if (flat) out.push(``);
    for (const l of rows) {
      const g = flat ? null : all ? `${l.project_key}/${l.track}` : l.track;
      if (!flat && g !== group) { group = g; out.push(``, `-- ${g} ${'-'.repeat(Math.max(0, 60 - g.length))}`); }
      out.push(laneLine(l, myId, all));
    }
    const unread = board ? (await c.query(
      `SELECT count(*)::int AS n FROM agentic_os.lane_event e WHERE ${UNREAD_SQL}`, unreadParams(myId, board.key),
    )).rows[0].n : 0;
    out.push(``, unread > 0 ? `${unread} unread -- run: lane.mjs inbox` : `inbox empty`);
    return out.join('\n');
  },

  async peers(c) {
    const myId = me();
    const all = flags.all === true;
    const rows = await livePeers(c, all ? softBoard() : projectOf(), all);
    if (JSON_OUT) return rows.map((r) => ({ ...r, name: nameOf(r.id), label: L(r.id) }));
    return rows.map((r) => {
      const held = r.lanes ? r.lanes.split(', ') : [];
      const lanes = held.length ? `${held[0]}${held.length > 1 ? ` +${held.length - 1}` : ''}` : '(none)';
      return `${r.id === myId ? '*' : ' '} ${L(r.id)}  lanes: ${lanes}`;
    }).join('\n') || 'no live sessions';
  },

  /** Who am I: the label, the full uuid and the lanes I hold (with their boards). Keyed on the owner, not the cwd. */
  async whoami(c) {
    const myId = me();
    const held = (await c.query(
      `SELECT id, project_key FROM agentic_os.lane WHERE owner_session_id=$1 AND state <> 'done' ORDER BY id`, [myId],
    )).rows;
    const ids = held.map((r) => r.id);
    if (JSON_OUT) {
      return { label: L(myId), uuid: myId, short: short(myId), name: nameOf(myId), lanes: ids, boards: Object.fromEntries(held.map((r) => [r.id, r.project_key])) };
    }
    return [L(myId), `uuid: ${myId}`, `lanes: ${held.map((r) => `${r.id} [${r.project_key}]`).join(', ') || '(none)'}`].join('\n');
  },

  /**
   * Take over the open lanes, unread direct messages and inbox cursor of a session
   * that /clear, resume or fork replaced. Hooks call this at SessionStart.
   *
   * Refused unless the two identity files agree it is the same session (see
   * adoptAllowed) AND the old session has ended (endedAt, or quiet for STALE_MINUTES):
   * this moves another session's lanes, so a stranger or a live session gets nothing.
   * One transaction. A second run finds nothing left to move. The cursor is carried
   * only when the new session has none, so an adopt cannot rewind a live inbox; if
   * the new session already read past a moved message, the cursor steps back to it.
   *
   * Boards: a /clear successor is the same thread, so lanes, DMs and cursors move across
   * every board. Cursor rows are `<id>` and `<id>@<board>`; each old row is carried to the
   * new id's equivalent. The DM cursor is the highest of a session's rows (see UNREAD_SQL).
   */
  async adopt(c) {
    const newId = me();
    const oldId = flags.from;
    if (typeof oldId !== 'string') throw new Error('usage: lane.mjs adopt --from <old-session-uuid>');
    if (oldId === newId) throw new Error('adopt --from must be a different session than me');
    if (!isSafeId(oldId)) throw new Error(`adopt --from "${oldId}" is not a session id`);
    const oldIdentity = readIdentity(oldId);
    if (!adoptAllowed(oldId, newId, oldIdentity, readIdentity(newId))) {
      const e = new Error(
        `REFUSED adopt from ${L(oldId)}: ${L(newId)} does not share its name and does not name it as previous.\n` +
        `  Identity files: ${nameOf(oldId) || '(no name)'} / ${nameOf(newId) || '(no name)'}`);
      e.soft = true; throw e;
    }
    // A live session keeps its lanes. The old one must have ended: its identity file says so,
    // or its sessions row has been quiet for STALE_MINUTES (same liveness predicate as claim).
    if (!oldIdentity?.endedAt) {
      const live = (await c.query(
        `SELECT 1 FROM sessions WHERE id=$1 AND ${ALIVE_AT()} > now() - interval '${STALE_MINUTES} minutes'`, [oldId],
      )).rows.length > 0;
      if (live) {
        const e = new Error(
          `REFUSED adopt from ${L(oldId)}: it has not ended (no endedAt, alive in the last ${STALE_MINUTES}m).\n` +
          `  Retry after it ends or goes quiet.`);
        e.soft = true; throw e;
      }
    }
    // Resolve the board BEFORE anything moves. It can throw (unknown --project / LANE_PROJECT), and a throw after
    // the COMMIT would report failure for an adopt that succeeded. A cwd with no board returns null: the audit
    // event then goes to the default board.
    softBoard();
    await c.query('BEGIN');
    let moved;
    try {
      const lanes = (await c.query(
        `UPDATE agentic_os.lane SET owner_session_id=$2, updated_at=now()
         WHERE owner_session_id=$1 AND state <> 'done' RETURNING id`, [oldId, newId],
      )).rows.map((r) => r.id).sort();
      const wmRows = async (sid) => (await c.query(
        `SELECT session_id, last_event_id::bigint AS n FROM agentic_os.lane_watermark
          WHERE session_id=$1::text OR starts_with(session_id, $1::text || '@')`, [sid],
      )).rows;
      const top = (rows) => (rows.length ? rows.reduce((m, r) => Math.max(m, Number(r.n)), 0) : undefined);
      const oldRows = await wmRows(oldId);
      const newRows = await wmRows(newId);
      const oldWm = top(oldRows);
      const newWm = top(newRows);
      const dms = (await c.query(
        `UPDATE agentic_os.lane_event
            SET to_session_id=$2, detail = detail || jsonb_build_object('adoptedFrom', $1::text)
          WHERE to_session_id=$1 AND id > $3::bigint RETURNING id`, [oldId, newId, oldWm ?? 0],
      )).rows.map((r) => Number(r.id));
      let cursor = 'unchanged';
      const have = new Set(newRows.map((r) => r.session_id));
      for (const r of oldRows) {
        const target = newId + r.session_id.slice(oldId.length);
        if (have.has(target)) continue;
        await c.query(
          // lane-context can write this row at SessionStart while adopt runs; a key clash must not roll back the adopt.
          `INSERT INTO agentic_os.lane_watermark (session_id, last_event_id, updated_at) VALUES ($1,$2,now())
           ON CONFLICT (session_id) DO NOTHING`, [target, r.n]);
        cursor = 'carried';
      }
      if (newWm !== undefined && dms.length && Math.min(...dms) <= Number(newWm)) {
        await c.query(
          `UPDATE agentic_os.lane_watermark SET last_event_id=$2, updated_at=now()
            WHERE (session_id=$1::text OR starts_with(session_id, $1::text || '@')) AND last_event_id >= $2 + 1`,
          [newId, Math.min(...dms) - 1]);
        cursor = 'stepped back';
      }
      await c.query('COMMIT');
      moved = { from: oldId, to: newId, lanes, messages: dms.length, cursor };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    }
    // Addressed to the new session itself: inbox and the DM hook skip a session's own events,
    // so this is an audit row nobody gets paged for.
    if (moved.lanes.length || moved.messages) {
      await logEvent(c, {
        kind: 'note', sessionId: newId, to: newId,
        body: `${L(newId)} adopted ${moved.lanes.length} lane(s) and ${moved.messages} message(s) from ${L(oldId)}`,
        detail: { adopted: true, from: oldId },
      });
    }
    if (JSON_OUT) return moved;
    if (!moved.lanes.length && !moved.messages && moved.cursor === 'unchanged') return `adopt from ${L(oldId)}: nothing to move`;
    return `adopted from ${L(oldId)}: ${moved.lanes.length} lane(s) [${moved.lanes.join(', ')}], ${moved.messages} message(s), cursor ${moved.cursor}`;
  },

  async next(c) {
    const myId = me();
    const board = projectOf();
    const { rows } = await c.query(
      `SELECT l.* FROM agentic_os.lane l
       WHERE l.project_key = $1 AND l.state IN ('ready','backlog') AND ${RECLAIMABLE}
         AND ${CLAIMABLE_NOT_REMINDER}
       ORDER BY ${laneOrderSql('l')} LIMIT ${Number(flags.n) > 0 ? Number(flags.n) : 5}`,
      [board.key],
    );
    if (JSON_OUT) return rows;
    if (!rows.length) return 'nothing claimable';
    return rows.map((l) => laneLine(l, myId)).join('\n');
  },

  async mine(c) {
    const myId = me();
    const { rows } = await c.query(
      `SELECT l.* FROM agentic_os.lane l WHERE l.owner_session_id=$1 AND l.state <> 'done' ORDER BY ${laneOrderSql('l')}`, [myId],
    );
    if (JSON_OUT) return rows;
    return rows.length ? rows.map((l) => laneLine(l, myId, true)).join('\n') : 'you hold no lanes';
  },

  /**
   * Atomic claim. The whole point of the layer.
   *
   * One statement decides it: the UPDATE only matches an unclaimed-or-reclaimable
   * row, so two sessions issuing this in the same millisecond produce one row
   * updated and one row not, with no read-then-write window between them. The
   * loser is then told who won -- an unexplained "no" would send it looking for
   * a bug instead of a person.
   */
  async claim(c) {
    const myId = me();
    const board = projectOf();
    const id = positional[1];
    if (!id) throw new Error('usage: lane.mjs claim <lane-id> [--note "..."]');

    const { rows } = await c.query(
      `UPDATE agentic_os.lane l SET
         owner_session_id = $2,
         claimed_at       = now(),
         lease_expires_at = now() + interval '${LEASE_MINUTES} minutes',
         fence            = l.fence + 1,
         state            = CASE WHEN l.state IN ('backlog','ready') THEN 'active' ELSE l.state END,
         note             = COALESCE($3, l.note),
         updated_at       = now()
       WHERE l.id = $1 AND l.project_key = $4 AND ${RECLAIMABLE}
       RETURNING l.*`,
      [id, myId, typeof flags.note === 'string' ? flags.note : null, board.key],
    );

    if (rows.length) {
      const l = rows[0];
      await logEvent(c, {
        laneId: id, kind: 'claimed', sessionId: myId,
        body: typeof flags.note === 'string' ? flags.note : null,
        detail: { fence: l.fence, state: l.state },
      });
      return JSON_OUT ? l
        : `CLAIMED ${id} (fence ${l.fence}, lease ${LEASE_MINUTES}m)\n  ${l.title}\n  scope: ${l.scope || '(undeclared -- set one)'}`;
    }

    const cur = (await c.query(`SELECT * FROM agentic_os.lane WHERE id=$1 AND project_key=$2`, [id, board.key])).rows[0];
    if (!cur) throw await noLane(c, id, board);
    if (cur.owner_session_id === myId) {
      return JSON_OUT ? cur : `you already hold ${id} -- use "renew" to extend, "note" to update it`;
    }
    // Displayed, not decided -- but it must answer the SAME question the deny
    // message goes on to state the rule for. Rendering bare last_heartbeat here
    // next to "a holder quiet Nm" told the reader a working holder had been
    // silent for 25 minutes while RECLAIMABLE, correctly, refused to release the
    // lane. AT TIME ZONE 'UTC' because these are `timestamp without time zone`
    // holding UTC and node-postgres parses that as LOCAL -- the same confusion
    // put a future date on this board on 2026-07-26.
    const holder = (await c.query(
      `SELECT ${ALIVE_AT()} AT TIME ZONE 'UTC' AS last_alive, working_on
         FROM sessions WHERE id=$1`, [cur.owner_session_id],
    )).rows[0];
    await logEvent(c, {
      laneId: id, kind: 'note', sessionId: myId, to: cur.owner_session_id,
      body: `tried to claim ${id}, denied -- you hold it`,
      detail: { denied: true },
    });
    const err = [
      `DENIED ${id} -- held by ${L(cur.owner_session_id)}`,
      `  their note: ${cur.note || '(none)'}`,
      `  lease: ${cur.lease_expires_at ? new Date(cur.lease_expires_at).toISOString() : 'none'}`,
      `  they were last alive: ${holder?.last_alive ? new Date(holder.last_alive).toISOString() : 'never seen'}`,
      `  Reclaim needs BOTH an expired lease AND a holder quiet ${STALE_MINUTES}m.`,
      `  They have been told you wanted it. Pick another: lane.mjs next`,
    ].join('\n');
    const e = new Error(err); e.soft = true; throw e;
  },

  async renew(c) {
    const myId = me();
    const { rows } = await c.query(
      `UPDATE agentic_os.lane SET lease_expires_at = now() + interval '${LEASE_MINUTES} minutes', updated_at = now()
       WHERE owner_session_id=$1 AND state <> 'done' RETURNING id, project_key`, [myId],
    );
    // Keyed on the owner, on every board: a lane held on another board must not lapse because I ran this elsewhere.
    return JSON_OUT ? rows : `renewed ${rows.length} lane(s): ${rows.map((r) => `${r.id} [${r.project_key}]`).join(', ') || '(none)'}`;
  },

  async note(c) {
    const myId = me();
    const id = positional[1];
    const board = await projectForOwnedLane(c, id, myId);
    const body = positional.slice(2).join(' ') || (typeof flags.note === 'string' ? flags.note : '');
    if (!id || !body) throw new Error('usage: lane.mjs note <lane-id> "status line"');
    const { rows } = await c.query(
      `UPDATE agentic_os.lane SET note=$2, updated_at=now(),
         lease_expires_at = CASE WHEN owner_session_id=$3
           THEN now() + interval '${LEASE_MINUTES} minutes' ELSE lease_expires_at END
       WHERE id=$1 AND project_key=$4 RETURNING *`, [id, body, myId, board.key],
    );
    if (!rows.length) throw await noLane(c, id, board);
    await logEvent(c, { laneId: id, kind: 'note', sessionId: myId, body, detail: agentDetail() });
    return JSON_OUT ? rows[0] : `noted on ${id}: ${body}`;
  },

  async state(c) {
    const myId = me();
    const id = positional[1];
    const board = await projectForOwnedLane(c, id, myId);
    const to = positional[2];
    if (!id || !LANE_STATES.includes(to)) {
      throw new Error(`usage: lane.mjs state <lane-id> <${LANE_STATES.join('|')}>`);
    }
    // NOTE: `myId` is deliberately NOT a bind parameter here. It used to be passed as
    // $3, but the SQL below never referenced $3 -- Postgres cannot infer the type of an
    // unreferenced parameter, so it rejected the whole statement with "could not
    // determine data type of parameter $3". That broke `state`, and with it `release`
    // and `done`, which delegate here. The result: nothing was EVER markable done
    // through this CLI, so the board silently degraded into an intake register that
    // could record work starting but never work finishing.
    //
    // `myId` is still read below for logEvent attribution -- it just has no business in
    // the SQL. It could not be recovered from `rows[0]` either, because this same
    // UPDATE nulls owner_session_id on the done/ready transitions.
    //
    // Known gap, deliberately left alone: WHERE is `id=$1` with no ownership check, so
    // any session can transition any lane. That is a behaviour change affecting other
    // live sessions and does not belong in a parameter-binding bug fix.
    const { rows } = await c.query(
      `UPDATE agentic_os.lane SET state=$2, updated_at=now(),
         note = COALESCE($3, note),
         owner_session_id = CASE WHEN $2 IN ('done','ready') THEN NULL ELSE owner_session_id END,
         lease_expires_at = CASE WHEN $2 IN ('done','ready') THEN NULL ELSE lease_expires_at END
       WHERE id=$1 AND project_key=$4 RETURNING *`,
      [id, to, typeof flags.note === 'string' ? flags.note : null, board.key],
    );
    if (!rows.length) throw await noLane(c, id, board);
    await logEvent(c, {
      laneId: id, kind: to === 'done' ? 'done' : 'state_changed', sessionId: myId,
      body: `${id} -> ${to}${typeof flags.note === 'string' ? ` (${flags.note})` : ''}`,
      detail: { state: to },
    });
    return JSON_OUT ? rows[0] : `${id} -> ${to}${to === 'done' || to === 'ready' ? ' (released)' : ''}`;
  },

  async release(c) {
    positional[2] = 'ready';
    return commands.state(c);
  },

  async done(c) {
    positional[2] = 'done';
    return commands.state(c);
  },

  /** Message the board, or one peer (who may be on another board). This is the bus; `inbox` is the reader. */
  async say(c) {
    const myId = me();
    const board = projectOf();
    const body = positional.slice(1).join(' ');
    if (!body) throw new Error('usage: lane.mjs say "message" [--to <name|name@board|sid-prefix>] [--lane <id>]');
    const to = typeof flags.to === 'string' ? await resolveRecipient(c, flags.to, board) : null;
    const laneId = typeof flags.lane === 'string' ? flags.lane : null;
    // A tag must name a lane of this board: an event tagged with another board's lane would show up in that lane's history.
    if (laneId && !(await c.query(`SELECT 1 FROM agentic_os.lane WHERE id=$1 AND project_key=$2`, [laneId, board.key])).rowCount) {
      throw await noLane(c, laneId, board);
    }
    await logEvent(c, { laneId, kind: 'note', sessionId: myId, to, body, detail: agentDetail() });
    return `sent to ${to ? L(to) : `board ${board.key}`}${laneId ? ` re ${laneId}` : ''}`;
  },

  /**
   * Unread events for me, then advance the watermark of THIS board.
   *
   * Excludes my own events -- a session does not need to be told what it just
   * did, and including them would make every action generate its own noise.
   * Broadcasts are this board's; direct messages come from any board and are
   * tagged [from <board>] when they crossed. See UNREAD_SQL for the cursors.
   */
  async inbox(c) {
    const myId = me();
    const board = projectOf();
    const { rows } = await c.query(
      `SELECT e.* FROM agentic_os.lane_event e WHERE ${UNREAD_SQL} ORDER BY e.id`, unreadParams(myId, board.key),
    );
    if (rows.length && flags.peek !== true) {
      await c.query(
        `INSERT INTO agentic_os.lane_watermark (session_id, last_event_id, updated_at)
         VALUES ($1,$2,now())
         ON CONFLICT (session_id) DO UPDATE SET last_event_id=EXCLUDED.last_event_id, updated_at=now()`,
        [wmKey(myId, board.key), rows[rows.length - 1].id],
      );
    }
    if (JSON_OUT) return rows;
    if (!rows.length) return 'inbox empty';
    return rows.map((e) => {
      const to = e.to_session_id ? L(e.to_session_id) : 'all';
      const kind = e.kind === 'note' ? '' : ` (${e.kind})`;
      const from = e.to_session_id && e.project_key !== board.key ? ` [from ${e.project_key}]` : '';
      return `${chicagoTime(e.occurred_at)}  ${labelWithAgent(e.session_id, ids(), e.detail?.agent)}${from} -> ${to}${e.lane_id ? ` [${e.lane_id}]` : ''}${kind}\n     ${e.body || ''}`;
    }).join('\n');
  },

  async add(c) {
    const myId = me();
    const board = projectOf();
    const id = positional[1];
    if (!id || typeof flags.title !== 'string') {
      throw new Error('usage: lane.mjs add <lane-id> --title "..." [--track t] [--scope "..."] [--band P0|P1|P2|none] [--priority 1-999]');
    }
    if (!BOARD_KEY_RE.test(id)) throw new Error(badId(id));
    // undefined = the flag was not given: a new lane gets the default, an existing lane keeps its stored value.
    const band = parseBand(flags.band);
    const priority = parsePriority(flags.priority);
    // The band column exists only after migration 0005. Name it in the SQL only when the caller passed --band,
    // so an add with no band flag still works on a database that has not had 0005 yet.
    const withBand = band !== undefined;
    // The WHERE keeps an add from rewriting a lane that belongs to another board: no row back means a foreign id.
    let rows;
    try {
      ({ rows } = await c.query(
        `INSERT INTO agentic_os.lane (id,title,track,scope,branch,state,priority,note,project_key${withBand ? ',band' : ''})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9${withBand ? ',$11' : ''})
         ON CONFLICT (id) DO UPDATE SET
           title=EXCLUDED.title, track=EXCLUDED.track,
           scope=COALESCE(EXCLUDED.scope, agentic_os.lane.scope),
           priority=CASE WHEN $10::boolean THEN EXCLUDED.priority ELSE agentic_os.lane.priority END,
           ${withBand ? 'band=EXCLUDED.band,' : ''} updated_at=now()
         WHERE agentic_os.lane.project_key = EXCLUDED.project_key
         RETURNING *`,
        [id, flags.title, flags.track || 'unsorted', flags.scope || null, flags.branch || null,
         LANE_STATES.includes(flags.state) ? flags.state : 'backlog',
         priority ?? 50, typeof flags.note === 'string' ? flags.note : null, board.key,
         priority !== undefined, ...(withBand ? [band] : [])],
      ));
    } catch (e) { throw bandMigrationError(e); }
    if (!rows.length) throw await foreignId(c, id);
    await logEvent(c, { laneId: id, kind: 'seeded', sessionId: myId, body: flags.title });
    if (JSON_OUT) return rows[0];
    const l = rows[0];
    return `lane ${id} upserted on board ${board.key} (${'band' in l ? `band ${l.band ?? 'none'}, ` : ''}priority ${l.priority})`;
  },

  /**
   * Set the importance band of a lane: P0, P1, P2, or none (NULL, "Unsorted"). Needs migration 0005.
   * Needs no claim: Dave or any session may set a band. Scoped to the board like `state`. One 'band' lane_event
   * per real change; the same value as stored writes nothing and says "unchanged".
   * The lock and the update are one statement, so two racing callers log one event each for their own change.
   */
  async band(c) {
    const myId = me();
    const id = positional[1];
    const board = await projectForOwnedLane(c, id, myId);
    const to = parseBand(positional[2], 'band');
    if (!id || to === undefined) throw new Error('usage: lane.mjs band <lane-id> <P0|P1|P2|none>');
    let rows;
    try {
      ({ rows } = await c.query(
        `WITH old AS (SELECT id, band FROM agentic_os.lane WHERE id=$1 AND project_key=$3 FOR UPDATE)
         UPDATE agentic_os.lane l SET band=$2::text, updated_at=now()
         FROM old WHERE l.id = old.id AND l.band IS DISTINCT FROM $2::text
         RETURNING old.band AS from_band`,
        [id, to, board.key],
      ));
    } catch (e) { throw bandMigrationError(e); }
    const word = (v) => v ?? 'none';
    if (!rows.length) {
      // No row changed: the lane is missing from this board, or it already has this band.
      const cur = (await c.query(`SELECT band FROM agentic_os.lane WHERE id=$1 AND project_key=$2`, [id, board.key])).rows[0];
      if (!cur) throw await noLane(c, id, board);
      return JSON_OUT ? { id, from: cur.band, to, changed: false } : `${id} band unchanged: ${word(cur.band)}`;
    }
    const from = rows[0].from_band;
    await logEvent(c, {
      laneId: id, kind: 'band', sessionId: myId,
      body: `band ${word(from)} -> ${word(to)}`, detail: { from, to },
    });
    return JSON_OUT ? { id, from, to, changed: true } : `${id} band: ${word(from)} -> ${word(to)}`;
  },

  /**
   * The first banding of the open lanes. `--dry-run` reads and prints the plan (a band table and a triage list) and
   * changes nothing. `--apply --p0 id,id|none` writes it: needs Dave's explicit P0 list, one transaction, updated_at kept,
   * one 'band' event per changed lane (session_id = the caller, detail.actor = 'backfill'). Scoped to the board of the cwd.
   * `lane.client_version` is already set for the session by withDb, before any write here.
   */
  async 'band-backfill'(c) {
    const given = (v) => v !== undefined && v !== false;
    const dry = given(flags['dry-run']);
    const apply = given(flags.apply);
    if (dry === apply) throw new Error(BACKFILL_USAGE);
    const board = projectOf();
    const p0 = apply || flags.p0 !== undefined ? parseP0List(flags.p0) : [];
    const expect = apply ? parseExpect(flags.expect) : null;
    const myId = apply ? me() : null;
    const hasBand = await hasBandColumn(c);
    if (apply && !hasBand) throw new Error('migration 0005 (lane band) is not applied to this database; apply it before you run band-backfill --apply');

    let plan;
    let changed = 0;
    if (dry) {
      const rows = await backfillLanes(c, board.key, hasBand, 'all');
      await checkP0Ids(c, rows, p0, board);
      plan = planBackfill(rows, p0);
    } else {
      await c.query('BEGIN');
      try {
        // A lock wait longer than this fails the run (SQLSTATE 55P03) instead of hanging on a busy lane.
        await c.query(`SET LOCAL lock_timeout = '${BACKFILL_LOCK_TIMEOUT}'`);
        const open = await backfillLanes(c, board.key, hasBand, 'open', true);
        const rows = [...open, ...await backfillLanes(c, board.key, hasBand, 'done')];
        await checkP0Ids(c, rows, p0, board);
        plan = planBackfill(rows, p0);
        if (plan.changes.length !== expect) {
          throw new Error(`band-backfill: the board changed since the dry run: the plan now changes ${plan.changes.length} lane(s), not the ${expect} in --expect. `
            + 'Nothing was written. Run --dry-run again and use its "to apply" line.');
        }
        if (plan.changes.length) await writeBackfill(c, plan.changes, board.key, myId);
        changed = plan.changes.length;
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e.code === '55P03'
          ? new Error(`band-backfill: another transaction holds a lock on a lane of this board (waited ${BACKFILL_LOCK_TIMEOUT}). Nothing was written. Try again in a moment.`)
          : e;
      }
    }
    const p0After = plan.table.find((t) => t.band === 'P0').after;
    if (p0After > P0_CAP) {
      console.error(`WARNING: ${p0After} open lanes ${apply ? 'are' : 'would be'} P0, above the soft cap of ${P0_CAP}. Nothing is refused; check that this is what Dave means.`);
    }
    const result = {
      board: board.key, mode: dry ? 'dry-run' : 'apply', band_column: hasBand, p0, open: plan.open, done: plan.done,
      table: plan.table, changes: plan.changes, triage: plan.triage,
      ...(apply ? { changed } : { apply_command: backfillApplyCommand(p0, plan.changes.length) }),
    };
    return JSON_OUT ? result : renderBackfill(result);
  },

  /**
   * Timed reminders on lanes: set, list, snooze, ack (alias done), clear. Needs migration 0005.
   * `remind tick` (fire due reminders, toast, Notion) is a later phase and is refused here.
   */
  async remind(c) {
    const sub = positional[1];
    if (sub === 'tick') throw new Error('remind tick is not built yet (a later phase); due reminders show in the SessionStart banner');
    if (!Object.hasOwn(REMIND_VERBS, sub)) throw new Error(REMIND_USAGE);
    try {
      return await REMIND_VERBS[sub](c);
    } catch (e) { throw remindMigrationError(e); }
  },

  /** Bulk idempotent add from JSON. Re-running never clobbers live claims,
   *  because it only ever touches the descriptive columns. Every item lands on the
   *  resolved board; an item that names another board, or an id that another board
   *  owns, stops the run before anything is written. */
  async seed(c) {
    const myId = me();
    const board = projectOf();
    const file = positional[1];
    if (!file) throw new Error('usage: lane.mjs seed <file.json>');
    const items = JSON.parse(readFileSync(file, 'utf8'));
    await checkSeedItems(c, items, board);
    // Name the band column only when some item carries a band, so a seed with no bands works before migration 0005.
    // An omitted band or priority (undefined) keeps the stored value on conflict; a new lane gets NULL / 50.
    const withBand = items.some((it) => parseBand(it.band) !== undefined);
    let n = 0;
    for (const it of items) {
      const band = parseBand(it.band);
      const priority = parsePriority(it.priority);
      // Deliberately asymmetric on conflict: descriptive columns are refreshed
      // from the seed, but `state`, `note` and every ownership column are NOT.
      // Re-seeding must never revert a live claim or overwrite the status line
      // the holder is currently maintaining -- the seed knows the shape of the
      // work, the session knows what is happening to it right now.
      let res;
      try {
        res = await c.query(
          `INSERT INTO agentic_os.lane (id,title,track,scope,branch,state,priority,note,rationale,done_when,project_key${withBand ? ',band' : ''})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11${withBand ? ',$13' : ''})
           ON CONFLICT (id) DO UPDATE SET
             title=EXCLUDED.title, track=EXCLUDED.track,
             scope=COALESCE(EXCLUDED.scope, agentic_os.lane.scope),
             branch=COALESCE(EXCLUDED.branch, agentic_os.lane.branch),
             priority=CASE WHEN $12::boolean THEN EXCLUDED.priority ELSE agentic_os.lane.priority END,
             ${withBand ? 'band=CASE WHEN $14::boolean THEN EXCLUDED.band ELSE agentic_os.lane.band END,' : ''}
             note=COALESCE(agentic_os.lane.note, EXCLUDED.note),
             rationale=COALESCE(EXCLUDED.rationale, agentic_os.lane.rationale),
             done_when=COALESCE(EXCLUDED.done_when, agentic_os.lane.done_when),
             updated_at=now()
           WHERE agentic_os.lane.project_key = EXCLUDED.project_key`,
          [it.id, it.title, it.track || 'unsorted', it.scope || null, it.branch || null,
           LANE_STATES.includes(it.state) ? it.state : 'backlog', priority ?? 50, it.note || null,
           it.rationale || null, it.doneWhen || null, board.key, priority !== undefined,
           ...(withBand ? [band ?? null, band !== undefined] : [])],
        );
      } catch (e) { throw bandMigrationError(e); }
      if (res.rowCount === 0) throw await foreignId(c, it.id);
      n++;
    }
    await logEvent(c, { kind: 'seeded', sessionId: myId, body: `seeded ${n} lanes from ${file}` });
    return `seeded ${n} lane(s) on board ${board.key}`;
  },

  /**
   * Carry Dave's kanban changes (order, status, notes, questions) into the lane table.
   *
   * The artifact db is reachable only through the agent's ArtifactData tool, so the
   * agent writes its content to <file> and this command applies it. All rules live in
   * the pure planner (kanban-apply.mjs). This function only does the I/O.
   *
   * One transaction, rows locked, so a half-applied board cannot exist. Events are
   * logged AFTER the commit: logEvent swallows its own errors, but a failed INSERT
   * inside a transaction would abort every later statement in it.
   *
   * --dry-run reads and plans. It opens no transaction and writes nothing.
   */
  async 'apply-kanban'(c) {
    const dry = flags['dry-run'] !== undefined && flags['dry-run'] !== false;
    // `--dry-run <file>` makes the flag parser swallow the file name as the flag value.
    const file = positional[1] ?? (typeof flags['dry-run'] === 'string' ? flags['dry-run'] : undefined);
    if (!file) throw new Error('usage: lane.mjs apply-kanban <file.json> [--dry-run] [--json]');
    const board = projectOf();
    let input;
    try { input = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
      throw new Error(`cannot read kanban file "${file}": ${e.message}`);
    }
    // A file in the wrong shape would plan zero actions and look like "nothing changed".
    if (!input?.board?.columns && !(Array.isArray(input?.cards) && input.cards.length)) {
      throw new Error(`"${file}" has no board.columns and no cards. Expected { board: {columns, updatedAt}, cards: [...] }`);
    }
    const declared = kanbanFileBoard(input);
    if (declared !== null && declared !== board.key) {
      throw new Error(`"${file}" is for board '${declared}' but this run resolved board '${board.key}'. Nothing was applied.`);
    }
    // Every board has its own page db. A file that does not name its board could come from another board's page, so a
    // non-default board refuses it. The default board keeps taking an undeclared file: old input files still work.
    if (declared === null && board.key !== DEFAULT_BOARD) {
      throw new Error(`"${file}" does not declare its board, and board '${board.key}' is not the default board. Add "project": "${board.key}" to the file. Nothing was applied.`);
    }
    const myId = dry ? null : me();
    const readAt = Date.parse(input?.readAt);
    const syncedAt = new Date(Number.isNaN(readAt) ? Date.now() : readAt).toISOString();

    let plan;
    if (dry) {
      plan = planKanban(input, (await c.query(KANBAN_LANES, [board.key])).rows);
    } else {
      await c.query('BEGIN');
      try {
        const lanes = (await c.query(`${KANBAN_LANES} FOR UPDATE OF l`, [board.key])).rows;
        plan = planKanban(input, lanes);
        for (const a of plan.actions) await applyKanbanAction(c, a, board.key);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      }
      for (const a of plan.actions) {
        await logEvent(c, {
          laneId: a.laneId, kind: 'kanban', sessionId: myId,
          body: a.kind === 'note' ? a.to : `${a.laneId} ${a.kind} ${a.from ?? '(none)'} -> ${a.to}`,
          detail: { kind: a.kind, from: a.from, to: a.to, text: a.text },
        });
      }
    }

    const count = (k) => plan.actions.filter((a) => a.kind === k).length;
    const summary = { priority: count('priority'), state: count('state'), note: count('note'), skipped: plan.skipped.length };
    const line = `kanban${dry ? ' (dry run, nothing written)' : ''}: ${summary.priority} priority, ${summary.state} state, ${summary.note} notes, ${summary.skipped} skipped`;
    if (JSON_OUT) {
      const results = plan.results.map((r) => (r.applied && !dry ? { ...r, syncedAt } : r));
      return { dryRun: dry, summary, syncedAt, appliedColumns: plan.appliedColumns, boardDone: plan.boardDone, actions: plan.actions, results, skipped: plan.skipped };
    }
    const clip = (v) => String(v ?? '(none)').replace(/\s+/g, ' ').slice(0, 70);
    return [
      line,
      ...plan.actions.map((a) => `  ${a.laneId.padEnd(28)} ${a.kind.padEnd(8)} ${clip(a.from)} -> ${clip(a.to)}`),
      ...plan.skipped.map((k) => `  ${k.laneId.padEnd(28)} skipped  ${k.reason}`),
    ].join('\n');
  },

  /** project which | register <path> | unregister <key>. `which` needs no database. */
  async project(c) {
    const sub = positional[1];
    if (sub === 'which') return projectWhich();
    if (sub === 'register') return projectRegister(c);
    if (sub === 'unregister') return projectUnregister(c);
    throw new Error('usage: lane.mjs project which | register <path> [--key k] [--board parent] | unregister <key>');
  },
};

/**
 * The lanes the kanban planner sees. `held` is NOT RECLAIMABLE: a live session owns the
 * lane, so a card or column must not change its state. Same predicate as claim and next.
 */
const KANBAN_LANES = `SELECT l.id, l.state, l.priority, l.note, NOT ${RECLAIMABLE} AS held FROM agentic_os.lane l WHERE l.project_key = $1`;

/** The board a kanban file says it is for: a string `board`, a top-level `project`, or `board.project`. null = it does not say. */
function kanbanFileBoard(input) {
  const b = input?.board;
  const v = typeof b === 'string' ? b : typeof input?.project === 'string' ? input.project : b?.project;
  return typeof v === 'string' && v ? v : null;
}

/** One planned action as one UPDATE. The state SQL mirrors the `state` command: done and ready release the lane. */
async function applyKanbanAction(c, a, boardKey) {
  const sql = {
    priority: `UPDATE agentic_os.lane SET priority=$2, updated_at=now() WHERE id=$1 AND project_key=$3`,
    note: `UPDATE agentic_os.lane SET note=$2, updated_at=now() WHERE id=$1 AND project_key=$3`,
    state: `UPDATE agentic_os.lane SET state=$2, updated_at=now(),
              owner_session_id = CASE WHEN $2 IN ('done','ready') THEN NULL ELSE owner_session_id END,
              lease_expires_at = CASE WHEN $2 IN ('done','ready') THEN NULL ELSE lease_expires_at END
            WHERE id=$1 AND project_key=$3`,
  }[a.kind];
  if (!sql) throw new Error(`unknown kanban action kind "${a.kind}"`);
  const { rowCount } = await c.query(sql, [a.laneId, a.to, boardKey]);
  if (rowCount !== 1) throw new Error(`kanban action on "${a.laneId}" matched ${rowCount} rows`);
}

// ---------------------------------------------------------------- project verbs

const MIGRATION_MSG = 'migration 0004 is not applied to this database';
const slugOf = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const isUnder = (child, root) => child === root || child.startsWith(root + '/');
const homeDir = () => process.env.USERPROFILE || process.env.HOME || os.homedir();
// The repo registry is the PRIMARY checkout's copy, never the one beside this script: a worktree has its own copy,
// and editing it would then overwrite the live copy with the worktree's bytes.
// LANE_REGISTRY_REPO and LANE_REGISTRY_ACTIVE are overrides for tests.
const registryRepoFile = () => process.env.LANE_REGISTRY_REPO || join(PRIMARY, '.claude', 'project-registry.json');
const registryActiveFile = () => process.env.LANE_REGISTRY_ACTIVE || join(homeDir(), '.claude', 'project-registry.json');
const PRIMARY_NOTE = 'This edits the repo registry in the primary checkout (an uncommitted change on main) and the live copy. ' +
  'The next sync removes the live copy unless the change is committed to main.';

function realOrSelf(p) {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

/** The real path of a directory the user named; throws if it is missing or not a directory. */
function existingDir(arg) {
  const abs = resolve(arg);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(`refusing ${fwd(abs)}: the path does not exist`); }
  if (!st.isDirectory()) throw new Error(`refusing ${fwd(abs)}: it is not a directory`);
  return fs.realpathSync.native(abs);
}

/** Why a board root must not be this path, or null. Not the home dir (or one that holds it), ~/.claude, or the OS temp dir (or in it, or around it). */
function unsafeRootReason(real) {
  const norm = normalizeRoot(real);
  const home = normalizeRoot(realOrSelf(homeDir()));
  const tmp = normalizeRoot(realOrSelf(os.tmpdir()));
  return isUnder(home, norm) ? 'it is the home directory or holds it'
    : isUnder(norm, `${home}/.claude`) ? 'it is ~/.claude or inside it'
      : (isUnder(norm, tmp) || isUnder(tmp, norm)) ? 'it is the OS temp directory, or inside or around it'
        : null;
}

function refuseUnsafeRoot(real) {
  const why = unsafeRootReason(real);
  if (why) throw new Error(`refusing ${fwd(real)}: ${why}`);
}

// ---- registry files

const readIfExists = (file) => {
  try { return fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
const foldEol = (buf) => buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

/**
 * Both registry copies must agree (beyond line endings) before a write. Otherwise the write would replace
 * the live copy with bytes built from a repo copy that is behind it, or the other way round, and lose an edit.
 * A missing live copy is allowed: there is nothing to overwrite.
 */
function assertRegistriesAgree() {
  const repoFile = registryRepoFile();
  const activeFile = registryActiveFile();
  const repo = readIfExists(repoFile);
  if (repo === null) throw new Error(`refusing: the repo registry ${fwd(repoFile)} does not exist`);
  const active = readIfExists(activeFile);
  if (active !== null && foldEol(repo) !== foldEol(active)) {
    throw new Error(
      'refusing: the repo registry and the live registry differ beyond line endings, so a write would lose one of them.\n' +
      `  repo:   ${fwd(repoFile)}\n  active: ${fwd(activeFile)}\n` +
      '  Compare the two files, make them equal, then run this again.');
  }
}

/**
 * Plan an edit of the registry. The repo copy is the base: its line endings, BOM, indent and key order survive.
 * `mutate(doc)` edits the parsed document. Returns the new text and the original bytes of both copies.
 */
function planRegistry(mutate) {
  const repoFile = registryRepoFile();
  const activeFile = registryActiveFile();
  const originalRepo = fs.readFileSync(repoFile);
  const raw = originalRepo.toString('utf8');
  const text = raw.replace(/^﻿/, '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = (/\n([ \t]+)"/.exec(text) || [])[1] || '  ';
  const doc = JSON.parse(text);
  if (!Array.isArray(doc.projects)) throw new Error(`${fwd(repoFile)} has no "projects" array`);
  mutate(doc);
  const body = JSON.stringify(doc, null, indent).replace(/\n/g, eol) + (/\n$/.test(text) ? eol : '');
  const out = (raw.startsWith('﻿') ? '﻿' : '') + body;
  return { repoFile, activeFile, out, originalRepo, originalActive: readIfExists(activeFile) };
}

/**
 * Write both copies (the same bytes), then run `afterFiles` (the database step). Files go FIRST: a database
 * step that fails then has something to undo, and a file step that fails never leaves a database row without
 * its registry entry. On ANY failure both copies go back to their original bytes and every temp file is removed,
 * so a retry starts clean.
 */
async function writeRegistries(plan, afterFiles) {
  const temps = [];
  const done = { repo: false, active: false };
  const stage = (file) => {
    fs.mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    temps.push(tmp);
    fs.writeFileSync(tmp, plan.out);
    return tmp;
  };
  try {
    const repoTmp = stage(plan.repoFile);
    const activeTmp = stage(plan.activeFile);
    fs.renameSync(repoTmp, plan.repoFile); done.repo = true;
    fs.renameSync(activeTmp, plan.activeFile); done.active = true;
    await afterFiles();
  } catch (e) {
    try {
      if (done.repo) fs.writeFileSync(plan.repoFile, plan.originalRepo);
      if (done.active) {
        if (plan.originalActive === null) fs.rmSync(plan.activeFile, { force: true });
        else fs.writeFileSync(plan.activeFile, plan.originalActive);
      }
    } catch (undoErr) {
      e.message += `\n  and the registry files could not be put back (${undoErr.message}): restore ${fwd(plan.repoFile)} and ${fwd(plan.activeFile)} by hand`;
    }
    for (const t of temps) fs.rmSync(t, { force: true });
    throw e;
  }
  return { repoFile: plan.repoFile, activeFile: plan.activeFile };
}

const rawIndex = (doc, key) => doc.projects.findIndex(
  (p) => p && typeof p === 'object' && (p.key === key || (!p.key && slugOf(p.name || '') === key)),
);

async function assertMigrated(c) {
  const n = (await c.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='agentic_os' AND table_name IN ('lane','lane_event') AND column_name='project_key'`,
  )).rows[0].n;
  if (n !== 2) throw new Error(MIGRATION_MSG);
}

async function projectWhich() {
  const b = projectOf();
  const entries = loadRegistry();
  const e = entries.find((x) => x.key === b.via) ?? entries.find((x) => x.root === b.root && x.status.toLowerCase() !== 'inactive');
  if (JSON_OUT) return { board: b.key, source: b.source, via: b.via, root: b.root, entry: e ?? null };
  const lines = [`board: ${b.key}`, `source: ${b.source}`, `via: ${b.via}`, `root: ${b.root}`];
  if (e) lines.push(`entry: ${e.key} (${e.name}) ${e.path} [${e.status}]${e.board !== e.key ? ` laneBoard=${e.board}` : ''}`);
  return lines.join('\n');
}

/**
 * Refuse a root that equals, holds or sits inside a live root, unless --board names that root's board.
 * An entry that sits on the board of the key being registered is that board's own nested entry, not a clash:
 * it is how a board comes back after an unregister that left a nested entry behind.
 */
function checkOverlap(norm, key, live, board) {
  const joining = board !== undefined && board !== key;
  if (joining && !live.some((e) => e.board === board)) {
    throw new Error(`unknown board '${board}'; registered boards: ${[...new Set(live.map((e) => e.board))].join(', ') || '(none)'}`);
  }
  const hit = live.filter((e) => e.key !== key && e.board !== key && (isUnder(norm, e.root) || isUnder(e.root, norm)));
  if (hit.length && !(joining && hit.every((e) => e.board === board))) {
    const names = hit.map((e) => `${e.key} (board ${e.board}, ${e.root})`).join('; ');
    throw new Error(`refusing: the root overlaps ${names}. To join one of those boards: --board <board>`);
  }
}

/**
 * A second board is only safe once the live lane-context hook sets lane.client_version (PR2): without it a session
 * that owns a lane on that board fails its lease renew at the database fence and the hook goes silent.
 * LANE_SKIP_HOOK_PRECHECK=1 skips the check. It exists for tests and probes only; never set it by hand.
 */
function requireLiveHook(board) {
  if (board === DEFAULT_BOARD || process.env.LANE_SKIP_HOOK_PRECHECK === '1') return;
  const file = join(homeDir(), '.claude', 'hooks', 'dist', 'lane-context.mjs');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* a missing hook fails the check below */ }
  if (!text.includes('lane.client_version')) {
    throw new Error(
      `refusing to register board '${board}': the live lane-context hook (${fwd(file)}) does not set lane.client_version.\n` +
      '  A session that owns a lane on a second board would fail its lease renew, and the hook would go silent.\n' +
      "  PR2's hook build must be live first: build the hooks, sync them to ~/.claude, then run this again.");
  }
}

async function upsertProjectRow(c, e) {
  await c.query(
    `INSERT INTO agentic_os.project (key, display_name, root_path, root_path_norm, status, registry_source, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,'lane.mjs project register', now(), now())
     ON CONFLICT (key) DO UPDATE SET display_name=EXCLUDED.display_name, root_path=EXCLUDED.root_path,
       root_path_norm=EXCLUDED.root_path_norm, status=EXCLUDED.status, registry_source=EXCLUDED.registry_source, last_seen_at=now()`,
    [e.key, e.name, e.path, normalizeRoot(e.path), e.status],
  );
}

/**
 * The closing line of `project register`. register never publishes (a publish is confirm-first and needs the Artifact tool).
 * A board that owns its entry and has no laneArtifact gets one hint. One that has a laneArtifact keeps it, and the line shows
 * the url so a dead one is visible. A nested entry or the default board gets nothing.
 */
function phonePageLine(key, board, artifact) {
  if (board !== key || key === DEFAULT_BOARD) return '';
  if (artifact) return `\n  Phone page kept: laneArtifact ${artifact} (check it still exists; unregister keeps it too)`;
  return `\nPhone page: run /publish-board ${key}`;
}

async function projectRegister(c) {
  const arg = positional[2];
  if (!arg) throw new Error('usage: lane.mjs project register <path> [--key k] [--board parent]');
  const real = existingDir(arg);
  refuseUnsafeRoot(real);
  const norm = normalizeRoot(real);
  const name = real.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const key = typeof flags.key === 'string' ? flags.key : slugOf(name);
  if (!BOARD_KEY_RE.test(key)) throw new Error(`key '${key}' is not valid: use lower case letters, digits and '-' (pass --key)`);
  const board = typeof flags.board === 'string' ? flags.board : undefined;
  const target = board ?? key;
  assertRegistriesAgree();
  const entries = loadRegistry({ registryPath: registryRepoFile(), env: {} });
  const live = entries.filter((e) => e.status.toLowerCase() !== 'inactive' && e.root);
  const same = entries.find((e) => e.key === key);
  const active = same && same.status.toLowerCase() !== 'inactive';
  // The same key, path and board again is a repeat (a retry after a failure): it rewrites both files and the row.
  const repeat = active && normalizeRoot(same.path) === norm && same.board === target;
  if (active && !repeat) throw new Error(`key '${key}' is already registered (${same.path}); unregister it first or pass --key`);
  checkOverlap(norm, key, live, board);
  requireLiveHook(target);

  const entry = { name, key, path: fwd(real), status: 'active' };
  if (board !== undefined && board !== key) entry.laneBoard = board;
  const plan = planRegistry((doc) => {
    const i = rawIndex(doc, key);
    if (i < 0) { doc.projects.push(entry); return; }
    // Re-registering an inactive entry: reactivate it in place, keep its other fields and its position.
    const old = doc.projects[i];
    Object.assign(old, { path: entry.path, status: 'active' });
    if (entry.laneBoard !== undefined) old.laneBoard = entry.laneBoard; else delete old.laneBoard;
  });
  const files = await writeRegistries(plan, () => upsertProjectRow(c, { ...entry, name: same?.name || name }));
  return `registered ${key} (board ${target}) at ${entry.path}\n` +
    `  wrote ${fwd(files.repoFile)} and ${fwd(files.activeFile)}\n` +
    `  ${PRIMARY_NOTE}` + phonePageLine(key, target, same?.artifact ?? null);
}

async function projectUnregister(c) {
  const key = positional[2];
  if (!key) throw new Error('usage: lane.mjs project unregister <key>');
  // The default board is where every old row and every old lane.mjs lives. No path registers it again.
  if (key === DEFAULT_BOARD) throw new Error(`refusing: '${DEFAULT_BOARD}' is the default board; if it were unregistered, no command could register it again`);
  assertRegistriesAgree();
  const e = loadRegistry({ registryPath: registryRepoFile(), env: {} }).find((x) => x.key === key);
  if (!e) throw new Error(`no registry entry with key '${key}'`);
  const plan = planRegistry((doc) => { doc.projects[rawIndex(doc, key)].status = 'inactive'; });
  const files = await writeRegistries(plan, () => c.query(`UPDATE agentic_os.project SET status='inactive', last_seen_at=now() WHERE key=$1`, [key]));
  // A nested entry (laneBoard) shares its parent's board: that board's lanes are not this entry's to report.
  const head = e.board !== e.key
    ? `unregistered ${key} (it joined board ${e.board}, which stays registered; its lanes are untouched)`
    : `unregistered ${key} (board ${e.board}); ${(await c.query(`SELECT count(*)::int AS n FROM agentic_os.lane WHERE project_key=$1`, [e.board])).rows[0].n} lane row(s) kept on that board`;
  const kept = e.board === e.key && e.artifact ? `\n  the phone page url stays in the entry (laneArtifact ${e.artifact}); register again keeps it` : '';
  return `${head}\n  wrote ${fwd(files.repoFile)} and ${fwd(files.activeFile)}\n  ${PRIMARY_NOTE}${kept}`;
}

// ---------------------------------------------------------------- main

const cmd = positional[0] || 'board';
if (!commands[cmd]) {
  process.stderr.write(`unknown command "${cmd}". Known: ${Object.keys(commands).join(', ')}\n`);
  process.exit(2);
}

try {
  const needsDb = !(cmd === 'project' && positional[1] === 'which');
  const result = needsDb ? await withDb((c) => commands[cmd](c)) : await commands[cmd](null);
  process.stdout.write((JSON_OUT ? JSON.stringify(result, null, 2) : String(result)) + '\n');
} catch (e) {
  process.stderr.write(`${isMissingMigration(e) ? MIGRATION_MSG : e.message}\n`);
  // A denied claim is a correct, expected answer -- exit 3 so a caller can tell
  // "someone else has it" apart from "the tool broke" (exit 1).
  process.exit(e.soft ? 3 : 1);
}
