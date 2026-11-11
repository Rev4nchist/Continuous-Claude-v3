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
 *   node scripts/coordination/lane.mjs claim <id> [--note "..."] [--dep-override --reason "..."]
 *                                                       # a rule refusal prints `REFUSED claim <id> [token] -- text` and exits 4; a lane held by a live session exits 3
 *   node scripts/coordination/lane.mjs note  <id> "status line"   # refused ([not-holder], exit 4) only on a lane that a live session other than you holds
 *   node scripts/coordination/lane.mjs compact <id> "text"   # log a compaction as an event; the note stays (PreCompact hook)
 *   node scripts/coordination/lane.mjs state <id> <backlog|ready|active|blocked|review|done> [--if-state <from>] [--reason "..."] [--override --reason "..."]
 *                                                       # state, release and done change a lane only for its holder. A lane with no holder opens for any session; a quiet
 *                                                       # holder or an unowned blocked lane needs --reason; --override --reason (cooperative) also changes a held lane and
 *                                                       # sends the old holder a DM. A refusal prints `REFUSED <verb> <id> [not-holder|needs-reason|if-state] -- text`, exit 4
 *   node scripts/coordination/lane.mjs release <id> [--note "why"]   # state ready
 *   node scripts/coordination/lane.mjs release <id> --blocked --reason "text"   # holder only: state blocked, no owner, no lease, note = text, in one statement
 *   node scripts/coordination/lane.mjs park <id> [--until <time> | --for 2h..7d] --reason "text"   # holder only; you keep the lane and the lease runs to the end (default 24h).
 *                                                       # State review (a blocked lane stays blocked), note = PARKED until <time> -- <reason> || <old note>. Your next state,
 *                                                       # release or done ends it (state <id> active resumes). A hold of more than 7 days is release --blocked, not a park.
 *                                                       # Warns when the active hook ~/.claude/hooks/dist/lane-context.mjs lacks GREATEST(lease_expires_at (the old hook cuts a park)
 *   node scripts/coordination/lane.mjs done <id> [--note "evidence"]   # plain: meets no dependency; a lane already met is not written
 *   node scripts/coordination/lane.mjs done <id> --merged <sha> [--note "..."]   # <sha> must be on local main of the board root (the cwd only when the board has no root); meets dependencies
 *   node scripts/coordination/lane.mjs done <id> --no-pr --evidence <path> [--note "..."]   # <path>: a file under .claudedocs/e2e-<id>/; records the main SHA
 *                                                       # a rule refusal prints `REFUSED done <id> [token] -- text` and exits 4; --merged, --evidence, --reason need a value
 *   node scripts/coordination/lane.mjs renew            # push my leases out to now+90m; a later lease (a park) stays
 *   node scripts/coordination/lane.mjs say "message" [--to <name|sid-prefix>] [--lane <id>]
 *   node scripts/coordination/lane.mjs inbox [--peek]   # unread; advances watermark unless --peek
 *   node scripts/coordination/lane.mjs add <id> --title "..." [--track t] [--scope "..."] [--band P0|P1|P2|none] [--priority 1-999]
 *                                                       # on an existing lane an omitted --track / --band / --priority keeps the stored value; a lane that a live
 *                                                       # session other than you holds is refused: `REFUSED add <id> [not-holder] -- text`, exit 4
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
 *   node scripts/coordination/lane.mjs remind sync on|off|status  # the Notion sync switch (default off): a file in the reminder state folder, no database
 *   node scripts/coordination/lane.mjs remind tick [--dry-run] [--no-sync]  # the 5-minute job: fire due reminders on every board, event, toast P0/P1. Exit 2: database down or no migration 0005
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

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { repoPath, userHome } from './canon-home.mjs';
import { DEFAULT_BOARD, boardRoots, laneCliCmd, loadRegistry, normalizeRoot, resolveBoard, wmKey } from './lane-board.mjs';
import { planKanban } from './kanban-apply.mjs';
import { parseBand, parseExpect, parseP0List, parsePriority } from './lane-band.mjs';
import { landedShaSql, laneMetSql, openDepSql, waitsOnSql } from './lane-dep.mjs';
import { findCycle, parseSeedFile } from './lane-seed-file.mjs';
import { bandTag, laneOrderSql } from './lane-sort.mjs';
import { processMatchSummary } from './process-match.mjs';
import {
  assertFuture, fmtCT, isDbUnreachable, overdueLabel, parseAction, parseDue, parseFor, remindDetail, resolvePri,
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

/** Flags that never take a value: `done --no-pr re-x` keeps `re-x` as the lane id. Every other flag takes the next token that is not a flag. */
const BOOLEAN_FLAGS = new Set(['no-pr', 'dep-override', 'override', 'blocked']);
/** Flags that need a text. A bare one (no value) is a usage error. */
const TEXT_FLAGS = ['merged', 'evidence', 'reason', 'if-state'];

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  } else positional.push(a);
}
const JSON_OUT = flags.json === true;
const BARE_TEXT_FLAG = TEXT_FLAGS.find((k) => flags[k] === true);

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
const reclaimableSql = (alias) => `(
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
const RECLAIMABLE = reclaimableSql('l');

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
  // The lease is the park (the writers keep the later lease). Parked tag: the lease is more than one lease length ahead. The note plays
  // no part: it can hold a stale PARKED prefix. A park that ended, or a lease that ran out, shows as a plain lease or LAPSED.
  const parked = lease > LEASE_MINUTES + 1;
  const leaseTag = l.owner_session_id
    ? (lease === null ? '' : parked ? ` parked to ${fmtCT(l.lease_expires_at)}` : lease > 0 ? ` ${lease}m` : ` LAPSED`)
    : '';
  const head = `${STATE_MARK[l.state] || '·'} ${bandTag(l.band)} ${l.id.padEnd(26)} ${String(l.state).padEnd(8)} ${(who + leaseTag).padEnd(30)}`;
  const lines = [`${head} ${showBoard ? `[${l.project_key}] ` : ''}${l.title}`];
  if (l.note) lines.push(`${' '.repeat(30)}${l.note}`);
  if (l.scope) lines.push(`${' '.repeat(30)}scope: ${l.scope}`);
  if (l.waits_on?.length) lines.push(`${' '.repeat(30)}waits on: ${l.waits_on.join(', ')}`);
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

// ---------------------------------------------------------------- refusals, done --merged, the met guard

/**
 * A lane rule refused the command and nothing was written: exit 4 (contract t2.1, point 6). Line 1 is
 * `REFUSED <verb> <id> [<token>] -- <text>`; `hint` is line 2. Under --json the exit handler adds one stderr JSON line from `refusal`.
 */
function refusal(verb, id, token, text, hint, extra = {}) {
  const e = new Error(`REFUSED ${verb} ${id} [${token}] -- ${text}${hint ? `\n  ${hint}` : ''}`);
  e.exitCode = 4;
  e.refusal = { refused: true, verb, id, rule: token, ...extra };
  return e;
}

// ---------------------------------------------------------------- the owner rule (contract park-owner, point 1)

/** `--override` and `--reason`, checked before any write. A usage error is exit 1 and nothing runs. */
function ownerFlags() {
  const override = flags.override === true;
  const reason = typeof flags.reason === 'string' ? flags.reason : null;
  if (reason !== null && !reason.trim()) throw new Error('--reason needs a text that is not empty (usage error; nothing was run)');
  if (override && reason === null) throw new Error('--override needs --reason "<text>" (usage error; nothing was run)');
  return { override, reason };
}

/**
 * The holder test: one clause in the WHERE of the one UPDATE that writes (alias `l`). `p` names the bound parameters.
 * A lane with no holder (RECLAIMABLE, which counts a NULL owner) opens for any session when its owner is NULL and it is not blocked.
 * A quiet owner (RECLAIMABLE with an owner) or a blocked lane with no owner needs a reason. `unownedBlockedFree` is for done --merged
 * and --no-pr: the SHA or the file is the reason. `holderOnly` is release --blocked: the holder or an override, nothing else.
 */
function ownerWhere(p, { holderOnly = false, unownedBlockedFree = false, ifState = false } = {}) {
  const open = holderOnly
    ? `(l.owner_session_id = ${p.me}::text OR ${p.override}::boolean)`
    : `(l.owner_session_id = ${p.me}::text
         OR (${RECLAIMABLE} AND (${p.reason}::text IS NOT NULL OR (l.owner_session_id IS NULL${unownedBlockedFree ? '' : " AND l.state <> 'blocked'"})))
         OR ${p.override}::boolean)`;
  return `AND ${open}${ifState ? ` AND (${p.ifState}::text IS NULL OR l.state = ${p.ifState}::text)` : ''}`;
}

/** One transaction. `fn` returns { value, commit = true }; commit false rolls back (nothing was written) and still returns the value. Any throw rolls back. */
async function inLaneTx(c, fn) {
  await c.query('BEGIN');
  try {
    const { value, commit = true } = await fn();
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/** Lock the lane row for the rest of the transaction. No row on this board: the noLane error (exit 1), before any holder test. */
async function lockLane(c, id, board) {
  const cur = (await c.query(
    `SELECT owner_session_id, state FROM agentic_os.lane WHERE id=$1 AND project_key=$2 FOR UPDATE`, [id, board.key],
  )).rows[0];
  if (!cur) throw await noLane(c, id, board);
  return cur;
}

/** A direct INSERT, never logEvent: logEvent swallows an error, and in a failed transaction the COMMIT would turn into a ROLLBACK unseen. */
async function insertEvent(c, { id, kind, myId, to = null, body, detail }) {
  await c.query(
    `INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body, detail, project_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, kind, myId, to, body, JSON.stringify(detail), eventBoard()],
  );
}

/**
 * The events of one change, in the transaction of the change. A --reason makes the main event carry {from, reason, prevOwner}. An override of
 * another session's lane writes a DM to that session FIRST (kind note: not a lifecycle event), then the main event (to_session_id NULL, the
 * board broadcast) LAST, so a done --merged --override stays met.
 */
async function writeChangeEvents(c, { id, myId, cur, to, kind, body, detail, override, reason, extraDetail = {} }) {
  const prev = cur.owner_session_id ?? null;
  const overrode = override && prev !== null && prev !== myId;
  if (overrode) {
    await insertEvent(c, {
      id, kind: 'note', myId, to: prev,
      body: `${id}: ${L(myId)} changed it from ${cur.state} to ${to} over your hold (override). Reason: ${reason}`,
      detail: { override: true, reason, state: to, from: cur.state },
    });
  }
  const via = reason === null ? '' : overrode ? ` [override of ${L(prev)}, reason: ${reason}]` : ` [reason: ${reason}]`;
  const more = reason === null ? {} : { from: cur.state, reason, prevOwner: prev, ...(override ? { override: true } : {}), ...extraDetail };
  await insertEvent(c, { id, kind, myId, body: `${body}${via}`, detail: { ...detail, ...more } });
}

/** M5: the sentence that names `adopt`, for a caller whose own earlier session holds the lane (see adoptAllowed). */
const adoptHint = (owner) => `If that was your session before a restart, run: ${laneCliCmd()} adopt --from ${owner}.`;

/**
 * REFUSED <verb> <id> [not-holder]. A holder who looks like the caller's own earlier session gets the adopt command (M5).
 * `withOverride` false (note, add and park take no --override) leaves the override sentence out and says "claim it first" in line 1.
 */
function notHolderRefusal(verb, id, owner, myId, { withOverride = true } = {}) {
  const cmd = laneCliCmd();
  const override = withOverride ? ' The seat may add --override --reason "<why>".' : '';
  if (!owner) {
    return refusal(verb, id, 'not-holder', withOverride ? 'the lane has no holder' : 'the lane has no holder; claim it first',
      withOverride ? `Claim it first: ${cmd} claim ${id}.${override}` : null, { holder: null });
  }
  const adopt = adoptAllowed(owner, myId, readIdentity(owner), readIdentity(myId)) ? `${adoptHint(owner)} Otherwise: ` : '';
  // --to takes the first 8 hex of the owner id, quoted and with no "#": a bare # starts a shell comment, and a bare --to broadcasts the DM.
  return refusal(verb, id, 'not-holder', `the lane is held by ${L(owner)}`,
    `${adopt}Only the holder changes it. Ask them: ${cmd} say "..." --to '${owner.slice(0, 8)}'.${override}`, { holder: owner });
}

/** The error for a note or add that matched no row: no lane on this board (exit 1), else a live holder other than the caller ([not-holder], exit 4). */
async function heldByOther(c, verb, id, board, myId) {
  const cur = (await c.query(`SELECT owner_session_id FROM agentic_os.lane WHERE id=$1 AND project_key=$2`, [id, board.key])).rows[0];
  if (!cur) return await noLane(c, id, board);
  return notHolderRefusal(verb, id, cur.owner_session_id, myId, { withOverride: false });
}

/**
 * A park shows in the note as a prefix: `PARKED until <time> -- <reason> || <old note>`. SQL: the note with that prefix cut off (NULL when
 * nothing follows the separator). A note that does not start with the prefix stays as it is. The reason never holds " || " (park writes "|").
 */
const unparkedNote = (col) => `(CASE WHEN ${col} LIKE 'PARKED until %' THEN substr(${col}, NULLIF(position(' || ' IN ${col}), 0) + 4) ELSE ${col} END)`;

/**
 * Why the one UPDATE matched no row, read under the same row lock. The order (contract point 1): no row, held by another session
 * without --override, no holder but no --reason, a wrong --if-state. Returns the error to throw, or null when none applies.
 */
async function ownerRefusal(c, { verb, id, board, myId, reason, override, ifState = null, holderOnly = false, unownedBlockedFree = false }) {
  const cur = (await c.query(
    `SELECT l.owner_session_id AS owner, l.state, ${RECLAIMABLE} AS reclaimable FROM agentic_os.lane l WHERE l.id=$1 AND l.project_key=$2`,
    [id, board.key],
  )).rows[0];
  if (!cur) return await noLane(c, id, board);
  const { owner } = cur;
  if (!override) {
    if (holderOnly ? owner !== myId : owner && owner !== myId && !cur.reclaimable) return notHolderRefusal(verb, id, owner, myId);
    const free = owner === null && (unownedBlockedFree || cur.state !== 'blocked');
    if (cur.reclaimable && owner !== myId && reason === null && !free) {
      return refusal(verb, id, 'needs-reason',
        owner === null ? 'the lane is blocked' : `its holder ${L(owner)} is quiet and the lease ended`,
        'Add --reason "<why>". The change is logged and sent to the board.');
    }
  }
  if (ifState !== null && cur.state !== ifState) {
    return refusal(verb, id, 'if-state', `the lane is ${cur.state}, not ${ifState}`, null, { state: cur.state });
  }
  return null;
}

const SHA_ARG_RE = /^[0-9a-fA-F]{7,40}$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const DONE_USAGE = 'usage: lane.mjs done <id> [--note "..."] | done <id> --merged <sha> [--note "..."] | done <id> --no-pr --evidence <path> [--note "..."]; any form takes [--reason "..."] [--override --reason "..."]';
/** The usage line of each verb that runs through stateChange, named by the verb the caller typed. */
const STATE_USAGE = {
  state: `usage: lane.mjs state <lane-id> <${LANE_STATES.join('|')}> [--if-state <from>] [--reason "..."] [--override --reason "..."]`,
  release: 'usage: lane.mjs release <lane-id> [--blocked --reason "<text>"] [--reason "..."] [--override --reason "..."]',
  done: DONE_USAGE,
};

/** One git call: argument array, no shell, 10 s. A failed spawn or a timeout throws (exit 1). */
function gitRun(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (r.error) throw new Error(`git ${args[0]} failed in ${dir}: ${r.error.message}`);
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** The full SHA of refs/heads/main. --verify, so a missing branch is an error and never an echo of the argument. */
function mainSha(dir) {
  const r = gitRun(dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']);
  if (r.status !== 0 || !FULL_SHA_RE.test(r.out)) throw new Error(`cannot read refs/heads/main in ${dir}: ${r.err || 'no such branch'}`);
  return r.out;
}

/** The 4 git steps of `done --merged` (contract point 3). Returns the full SHAs git resolved, never the argument. */
function landedCommit(id, dir) {
  const sha = flags.merged;
  if (!SHA_ARG_RE.test(sha)) throw new Error(`--merged needs a commit SHA of 7 to 40 hex characters; got '${sha}'`);
  const c = gitRun(dir, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  // Only "git ran and says there is no such commit" (status 1, no output) is a refusal. Any other failure (not a repo,
  // a signal, status 128) is an error: it says nothing about the SHA (contract point 6, B6).
  if (c.status === 1 && !c.out) {
    throw refusal('done', id, 'not-a-commit', `${sha} is not a commit in ${fwd(dir)}`,
      'Run done from the repo of the lane, with the merge commit on main. Fetch and update local main first.');
  }
  if (c.status !== 0) throw new Error(`git rev-parse failed in ${fwd(dir)} (${c.status === null ? 'killed by a signal' : `status ${c.status}`}): ${c.err || 'no message'}`);
  if (!FULL_SHA_RE.test(c.out)) throw new Error(`git resolved '${sha}' to '${c.out}', which is not a 40 hex SHA`);
  const a = gitRun(dir, ['merge-base', '--is-ancestor', c.out, 'refs/heads/main']);
  if (a.status !== 0 && a.status !== 1) throw new Error(`git merge-base failed in ${dir} (status ${a.status}): ${a.err}`);
  const main = mainSha(dir);
  if (a.status === 1) {
    throw refusal('done', id, 'not-on-main', `${c.out.slice(0, 12)} is not on main (main is ${main.slice(0, 12)})`, 'Land the PR, update local main, then run done again.');
  }
  return { merged: c.out, main };
}

/**
 * The folder git runs in for `done --merged` and `--no-pr`: the root of the lane's board from the registry (the entry's own
 * path, real case), else the process cwd. A SHA of an unrelated repo must not meet a dependency (contract point 3, B2).
 */
function landedDir(board) {
  if (!board?.root) return process.cwd();
  const live = loadRegistry().filter((x) => x.status.toLowerCase() !== 'inactive');
  const e = live.find((x) => x.key === board.via) ?? live.find((x) => x.root === board.root);
  return realOrSelf(e?.path || board.root);
}

const pathSegs = (p) => {
  const s = fwd(p).split('/').filter(Boolean);
  return process.platform === 'win32' ? s.map((x) => x.toLowerCase()) : s;
};

/** The repo that holds the evidence folder: the board root, else the top level of the cwd repo. */
function evidenceBase(board, dir) {
  if (board?.root) return dir;
  const r = gitRun(dir, ['rev-parse', '--show-toplevel']);
  if (r.status !== 0 || !r.out) throw new Error(`cannot find the repo of ${fwd(dir)} for the evidence folder: ${r.err || 'not a git repository'}`);
  return r.out;
}

/**
 * The evidence rule of `done --no-pr`: a regular file whose REAL path (links resolved) is under
 * <board root>/.claudedocs/e2e-<id>/, compared by path segments. Returns that real path, forward slashes (contract point 3, B3).
 */
function evidencePath(id, board, dir) {
  let base;
  try { base = fs.realpathSync.native(evidenceBase(board, dir)); } catch (e) { throw new Error(`the evidence base folder cannot be read: ${e.code ?? e.message}`); }
  let real = null;
  try {
    const r = fs.realpathSync.native(resolve(flags.evidence));
    if (fs.statSync(r).isFile()) real = r;
  } catch { /* a missing path is the refusal below */ }
  const want = [...pathSegs(base), '.claudedocs', `e2e-${id}`];
  const got = real ? pathSegs(real) : [];
  if (real && got.length > want.length && want.every((x, i) => got[i] === x)) return fwd(real);
  throw refusal('done', id, 'no-evidence', `${flags.evidence} is not a file under .claudedocs/e2e-${id}/`, 'Save the evidence there first, then run done again.');
}

/** The two landed forms never mix, and each flag has one partner. Usage errors (exit 1). */
function assertDoneForm() {
  const noPr = flags['no-pr'] === true;
  const merged = typeof flags.merged === 'string';
  const evidence = typeof flags.evidence === 'string';
  if (merged && (noPr || evidence)) throw new Error(`use one form, never both. ${DONE_USAGE}`);
  if (noPr && !evidence) throw new Error(`--no-pr needs --evidence <path>. ${DONE_USAGE}`);
  if (evidence && !noPr) throw new Error(`--evidence goes with --no-pr. ${DONE_USAGE}`);
}

/**
 * One transaction: the row is locked, the lane goes done and released, and the events are direct INSERTs (a failed insert rolls the UPDATE back).
 * The holder clause is in the WHERE. A lane that has no owner needs no --reason here, a blocked one too: the SHA or the file is the reason (S3).
 */
async function writeDone(c, { board, id, myId, note, body, detail, owner }) {
  const { override, reason } = owner;
  return inLaneTx(c, async () => {
    const cur = await lockLane(c, id, board);
    const { rows } = await c.query(
      `UPDATE agentic_os.lane l SET state='done', note=COALESCE($3::text, ${unparkedNote('l.note')}), owner_session_id=NULL, lease_expires_at=NULL, updated_at=now()
       WHERE l.id=$1 AND l.project_key=$2
         ${ownerWhere({ me: '$4', reason: '$5', override: '$6' }, { unownedBlockedFree: true })}
       RETURNING l.*`,
      [id, board.key, note, myId, reason, override],
    );
    if (!rows.length) {
      throw (await ownerRefusal(c, { verb: 'done', id, board, myId, reason, override, unownedBlockedFree: true }))
        ?? new Error(`done ${id} refused for no known reason; run ${laneCliCmd()} board and retry`);
    }
    await writeChangeEvents(c, { id, myId, cur, to: 'done', kind: 'done', body, detail, override, reason });
    return { value: rows[0] };
  });
}

/** `done <id> --merged <sha>` and `done <id> --no-pr --evidence <path>`. Git and the evidence rule run before any write. */
async function doneLanded(c) {
  const myId = me();
  const id = positional[1];
  if (!id) throw new Error(DONE_USAGE);
  const board = await projectForOwnedLane(c, id, myId);
  const owner = ownerFlags();
  const dir = landedDir(board);
  const noPr = flags['no-pr'] === true;
  const evidence = noPr ? evidencePath(id, board, dir) : null;
  const { merged, main } = noPr ? ((m) => ({ merged: m, main: m }))(mainSha(dir)) : landedCommit(id, dir);
  const note = typeof flags.note === 'string' ? flags.note : null;
  const how = noPr ? `no PR, evidence ${flags.evidence}` : `merged ${merged.slice(0, 12)}`;
  const detail = { state: 'done', merged, main, ...(noPr ? { noPr: true, evidence } : {}) };
  const body = `${id} -> done (${how})${note ? ` (${note})` : ''}`;
  const row = await writeDone(c, { board, id, myId, note, body, detail, owner });
  if (JSON_OUT) return { ...row, merged, main };
  return `${id} -> done (${noPr ? `no PR; main ${main.slice(0, 12)}` : `merged ${merged.slice(0, 12)} on main`}; released)`;
}

/** The merged SHA of a lane that is already met (state done, latest lifecycle event a merged done), else null. Reads lane_event only. */
async function metSha(c, id, board) {
  const row = (await c.query(
    `SELECT ${laneMetSql('l')} AS met, ${landedShaSql('l')} AS sha FROM agentic_os.lane l WHERE l.id=$1 AND l.project_key=$2`,
    [id, board.key],
  )).rows[0];
  return row?.met ? row.sha : null;
}

/** After a plain done: one stderr hint when a lane_dep row waits on this lane. Silent without the table (0006) and never an error. */
async function hintPlainDone(c, id) {
  try {
    if (!(await c.query(`SELECT to_regclass('agentic_os.lane_dep') IS NOT NULL AS has`)).rows[0].has) return;
    if ((await c.query(`SELECT 1 FROM agentic_os.lane_dep WHERE depends_on=$1 LIMIT 1`, [id])).rowCount) {
      process.stderr.write('[lane] note: a done without --merged meets no dependency\n');
    }
  } catch { /* a hint must never fail a done that was written */ }
}

/**
 * The lease CASE (contract point 6): done and ready free the lane; the owner's own change sets now+90m, which ends a park (L2.9). A non-owner
 * --override (the seat) also ends a park: it caps a lease at now+90m (LEAST would turn a NULL lease into now+90m, so NULL stays NULL) and
 * strips the PARKED prefix; the owner stays. A reclaim with --reason leaves the lease. The prefix goes in the same cases as the lease.
 */
const STATE_SQL = `UPDATE agentic_os.lane l SET state=$2, updated_at=now(),
     note = COALESCE($3, CASE WHEN $2 IN ('done','ready') OR l.owner_session_id = $5::text OR $7::boolean THEN ${unparkedNote('l.note')} ELSE l.note END),
     owner_session_id = CASE WHEN $2 IN ('done','ready') THEN NULL ELSE l.owner_session_id END,
     lease_expires_at = CASE WHEN $2 IN ('done','ready') THEN NULL
                             WHEN l.owner_session_id = $5::text THEN now() + interval '${LEASE_MINUTES} minutes'
                             WHEN $7::boolean AND l.lease_expires_at IS NOT NULL THEN LEAST(l.lease_expires_at, now() + interval '${LEASE_MINUTES} minutes')
                             ELSE l.lease_expires_at END
   WHERE l.id=$1 AND l.project_key=$4
     ${ownerWhere({ me: '$5', reason: '$6', override: '$7', ifState: '$8' }, { ifState: true })}
   RETURNING l.*`;

/** release --blocked: state blocked, no owner, no lease and the note in ONE statement, so the lane is never ready and never ownerless-and-offered. */
const RELEASE_BLOCKED_SQL = `UPDATE agentic_os.lane l SET state='blocked', owner_session_id=NULL, lease_expires_at=NULL, note=$3::text, updated_at=now()
   WHERE l.id=$1 AND l.project_key=$2
     ${ownerWhere({ me: '$4', override: '$5' }, { holderOnly: true })}
   RETURNING l.*`;

/**
 * `state`, `release` and plain `done`: the owner rule in one transaction (contract park-owner, points 1 to 4 and S1).
 * 1. The row is locked. 2. A plain done reads the met test under that lock, so a concurrent done --merged cannot be undone. 3. The one UPDATE
 * carries the holder clause. 4. The events are direct INSERTs. A refusal is read under the same lock and writes nothing.
 * `verb` is the verb the caller typed: it names the REFUSED line and the usage line. Only `state` gets --if-state (the main block refuses it elsewhere).
 */
async function stateChange(c, verb) {
  const myId = me();
  const id = positional[1];
  const board = await projectForOwnedLane(c, id, myId);
  const blocked = verb === 'release' && flags.blocked === true;
  const to = blocked ? 'blocked' : { release: 'ready', done: 'done' }[verb] ?? positional[2];
  if (!id || !LANE_STATES.includes(to)) throw new Error(STATE_USAGE[verb]);
  const { override, reason } = ownerFlags();
  if (blocked && reason === null) throw new Error('release --blocked needs --reason "<text>" (usage error; nothing was run)');
  // --if-state belongs to `state` alone: the main block already refused it on release, done and park.
  const ifState = typeof flags['if-state'] === 'string' ? flags['if-state'] : null;
  if (ifState !== null && !LANE_STATES.includes(ifState)) {
    throw new Error(`--if-state needs one of ${LANE_STATES.join('|')}; got '${ifState}' (usage error; nothing was run)`);
  }
  const note = typeof flags.note === 'string' ? flags.note : null;
  const out = await inLaneTx(c, async () => {
    const cur = await lockLane(c, id, board);
    // A lane that is already met (done, with a merged done as its latest lifecycle event) is never written by a plain done:
    // one stray `done <id>` must not unmeet it and close every dependent (contract t2.1, point 3). Read under the row lock (point 4).
    if (to === 'done') {
      const sha = await metSha(c, id, board);
      if (sha) return { value: { met: sha }, commit: false };
    }
    const { rows } = blocked
      ? await c.query(RELEASE_BLOCKED_SQL, [id, board.key, reason, myId, override])
      : await c.query(STATE_SQL, [id, to, note, board.key, myId, reason, override, ifState]);
    if (!rows.length) {
      throw (await ownerRefusal(c, { verb, id, board, myId, reason, override, ifState, holderOnly: blocked }))
        ?? new Error(`${verb} ${id} refused for no known reason; run ${laneCliCmd()} board and retry`);
    }
    await writeChangeEvents(c, {
      id, myId, cur, to, kind: to === 'done' ? 'done' : 'state_changed', override, reason,
      body: blocked ? `${id} -> blocked (released)` : `${id} -> ${to}${note ? ` (${note})` : ''}`,
      detail: { state: to }, extraDetail: blocked ? { released: true } : {},
    });
    return { value: { row: rows[0] } };
  });
  if (out.met) return JSON_OUT ? { id, already_met: true, merged: out.met } : `${id} already met (merged ${out.met.slice(0, 12)}); nothing written`;
  if (to === 'done') await hintPlainDone(c, id);
  return JSON_OUT ? out.row : `${id} -> ${to}${to === 'done' || to === 'ready' ? ' (released)' : blocked ? ' (released; no owner)' : ''}`;
}

// ---------------------------------------------------------------- park (contract park-owner, point 6 and the review changes H1, M6, L9, L10, L11)

const PARK_USAGE = 'usage: lane.mjs park <lane-id> [--until <time> | --for <N>m|<N>h|<N>d] --reason "<text>"   (default --for 24h; from 2h to 7 days)';
const PARK_DEFAULT_MS = 24 * 3_600_000;
/** The park end, in SQL: $1 is an exact time (--until) or NULL, $2 the milliseconds from now (--for) or NULL. now() is the transaction time, so the bounds are exact. */
const PARK_END_SQL = `COALESCE($1::timestamptz, now() + $2::bigint * interval '1 millisecond')`;

/** The args of `park`, checked before the first query (the connection is already open, so a bad arg still opens it). A usage error is exit 1 and nothing is written. */
function parkArgs() {
  const id = positional[1];
  if (!id) throw new Error(PARK_USAGE);
  if (typeof flags.reason !== 'string' || !flags.reason.trim()) throw new Error(`park needs --reason "<text>" (usage error; nothing was run)\n${PARK_USAGE}`);
  if (flags.until !== undefined && flags.for !== undefined) throw new Error('park takes --until or --for, not both (usage error; nothing was run)');
  const until = flags.until === undefined ? null : parseDue(flags.until);
  const ms = flags.until !== undefined ? null : flags.for === undefined ? PARK_DEFAULT_MS : parseFor(flags.for);
  const reason = flags.reason.trim();
  // The note keeps one line, and a " || " in the reason must not look like the separator before the old note.
  return { id, reason, noteReason: reason.replace(/\s+/g, ' ').replace(/\|{2,}/g, '|'), until, ms };
}

/** The active hook bundles that renew a lease: lane-context.mjs (session start, compact) and prompt-submit.mjs (each prompt). Both must hold the fix. */
const LEASE_HOOK_BUNDLES = ['lane-context.mjs', 'prompt-submit.mjs'];

/** L11: until `sync-to-active.sh` copies the new hooks, each prompt of the parking session cuts the park back to 90 minutes. Returns the warning, or null when both bundles hold the fix. */
function activeHookWarning() {
  const lacking = LEASE_HOOK_BUNDLES.map((f) => join(userHome(), '.claude', 'hooks', 'dist', f)).filter((file) => {
    try { return !readFileSync(file, 'utf8').includes('GREATEST(lease_expires_at'); } catch { return true; /* a missing file warns too */ }
  });
  if (!lacking.length) return null;
  return `[lane] warn: ${lacking.map(fwd).join(' and ')} ${lacking.length > 1 ? 'do' : 'does'} not hold GREATEST(lease_expires_at yet. Until the hook sync, each prompt of this session sets the lease back to ${LEASE_MINUTES} minutes and ends the park early.`;
}

/**
 * `park`: the holder keeps the lane and the lease is pushed to the end time (no schema change). State becomes review (a blocked lane stays blocked),
 * the note gets the PARKED prefix, and one state_changed broadcast carries the detail. One transaction under the row lock; only the holder may park.
 * The end is read in SQL against now(): below 2 hours or above 7 days is a usage error (exit 1), not a REFUSED.
 */
async function parkLane(c) {
  const myId = me();
  const { id, reason, noteReason, until, ms } = parkArgs();
  const board = await projectForOwnedLane(c, id, myId);
  const row = await inLaneTx(c, async () => {
    const cur = await lockLane(c, id, board);
    if (cur.owner_session_id !== myId) throw notHolderRefusal('park', id, cur.owner_session_id, myId, { withOverride: false });
    if (cur.state === 'done') throw refusal('park', id, 'done', 'the lane is done', 'A done lane has nothing to park.');
    const end = (await c.query(
      `SELECT ${PARK_END_SQL} AS e, ${PARK_END_SQL} >= now() + interval '2 hours' AS ok_min, ${PARK_END_SQL} <= now() + interval '7 days' AS ok_max`,
      [until, ms],
    )).rows[0];
    if (!end.ok_min || !end.ok_max) {
      throw new Error(`park ends ${fmtCT(end.e)}, which is ${end.ok_min ? 'more than 7 days' : 'less than 2 hours'} from now (usage error; nothing was run). ` +
        'Use --for 2h up to 7d. A longer hold is: release <id> --blocked --reason "<text>".');
    }
    const when = fmtCT(end.e);
    const { rows } = await c.query(
      `UPDATE agentic_os.lane l SET
         state = CASE WHEN l.state = 'blocked' THEN 'blocked' ELSE 'review' END,
         lease_expires_at = ${PARK_END_SQL},
         note = 'PARKED until ' || $3::text || ' -- ' || $4::text || COALESCE(' || ' || NULLIF(${unparkedNote('l.note')}, ''), ''),
         updated_at = now()
       WHERE l.id=$5 AND l.project_key=$6 AND l.owner_session_id=$7::text AND l.state <> 'done'
       RETURNING l.*`,
      [until, ms, when, noteReason, id, board.key, myId],
    );
    if (!rows.length) throw new Error(`park ${id} refused for no known reason; run ${laneCliCmd()} board and retry`);
    await insertEvent(c, {
      id, kind: 'state_changed', myId, body: `${id} parked until ${when}: ${reason}`,
      detail: { state: rows[0].state, parked: true, until: end.e.toISOString(), reason, fromState: cur.state },
    });
    return { value: { ...rows[0], parked_until: end.e.toISOString(), parked_until_text: when } };
  });
  const warn = activeHookWarning();
  if (warn) process.stderr.write(`${warn}\n`);
  if (JSON_OUT) return row;
  return `${id} parked until ${row.parked_until_text} (state ${row.state}; you keep it; "${laneCliCmd()} state ${id} active" ends the park)`;
}

// ---------------------------------------------------------------- the lane_dep floor

const DEP_OFF_WARNING = '[lane] warn: migration 0006 (lane_dep) is not applied; the dependency gate is off';
let HAS_LANE_DEP = null;
let DEP_WARN_DUE = false;
let DEP_WARNED = false;

/** Is table lane_dep there? One query per run, asked only by the verbs that read edges (contract t2.1, point 4). */
async function hasLaneDep(c) {
  HAS_LANE_DEP ??= (await c.query(`SELECT to_regclass('agentic_os.lane_dep') IS NOT NULL AS has`)).rows[0].has;
  return HAS_LANE_DEP;
}

/** true: the dependency SQL may be used. false: the table is missing; the SQL is left out and the one warning is queued (see flushDepWarning). */
async function depGate(c) {
  const has = await hasLaneDep(c);
  if (!has) DEP_WARN_DUE = true;
  return has;
}

/** The floor warning goes to stderr once per run, after the result or after the error text: line 1 of a refusal stays its REFUSED line (contract point 6). */
function flushDepWarning() {
  if (!DEP_WARN_DUE || DEP_WARNED) return;
  DEP_WARNED = true;
  process.stderr.write(`${DEP_OFF_WARNING}\n`);
}

// ---------------------------------------------------------------- the claim rules (contract t2.1, point 6)

/** The caller's other `re-` lane on this board; a lane of the same `re/` pack does not count (open point 4). $2 is the caller. */
const secondReFrom = (select) => `SELECT ${select} FROM agentic_os.lane o
   WHERE o.project_key = l.project_key AND o.owner_session_id = $2 AND o.state <> 'done' AND left(o.id, 3) = 're-'
     AND o.id <> l.id AND NOT COALESCE(o.branch = l.branch AND l.branch LIKE 're/%', false)`;
/** A lane of the same `re/` pack that a live session other than the caller holds. $2 is the caller. */
const packHeldFrom = (select) => `SELECT ${select} FROM agentic_os.lane o
   WHERE o.project_key = l.project_key AND o.branch = l.branch AND o.id <> l.id AND left(o.id, 3) = 're-'
     AND o.owner_session_id <> $2 AND NOT ${reclaimableSql('o')}`;
const SECOND_RE_LANE = `(left(l.id, 3) = 're-' AND EXISTS (${secondReFrom('1')}))`;
const PACK_HELD = `(left(l.id, 3) = 're-' AND l.branch LIKE 're/%' AND EXISTS (${packHeldFrom('1')}))`;

/** The open-dependency clause of the claim WHERE: only for a lane that is not held (backlog, ready, or no owner). Contract 1.10 as changed. */
const claimDepClause = `AND NOT ((l.state IN ('backlog','ready') OR l.owner_session_id IS NULL) AND ${openDepSql('l')})`;

/** The one atomic claim UPDATE (see `claim`). Returns the claimed row, or null when no row matched. Nothing is written on null. */
async function claimUpdate(c, { id, myId, board, override, withDeps }) {
  const dep = withDeps && !override ? claimDepClause : '';
  const waits = withDeps && override ? `, ${waitsOnSql('l')} AS waits_on` : '';
  const sql = `UPDATE agentic_os.lane l SET
         owner_session_id = $2,
         claimed_at       = now(),
         lease_expires_at = now() + interval '${LEASE_MINUTES} minutes',
         fence            = l.fence + 1,
         state            = CASE WHEN l.state IN ('backlog','ready') THEN 'active' ELSE l.state END,
         note             = COALESCE($3, ${unparkedNote('l.note')}),
         updated_at       = now()
       WHERE l.id = $1 AND l.project_key = $4 AND ${RECLAIMABLE}
         AND l.state NOT IN ('done','blocked')
         ${dep}
         AND NOT ${PACK_HELD}
         AND NOT ${SECOND_RE_LANE}
       RETURNING l.*${waits}`;
  const params = [id, myId, typeof flags.note === 'string' ? flags.note : null, board.key];
  if (!override) return (await c.query(sql, params)).rows[0] ?? null;
  return claimWithOverride(c, sql, params, { id, myId });
}

/** --dep-override: the UPDATE and the dep_override event in one transaction. A failed insert rolls the claim back (exit 1). */
async function claimWithOverride(c, sql, params, { id, myId }) {
  await c.query('BEGIN');
  try {
    const row = (await c.query(sql, params)).rows[0];
    const waitsOn = row?.waits_on ?? [];
    if (row) { // every override claim that matches a row is on the record, also with no open edge (waitsOn [])
      await c.query(
        `INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body, detail, project_key)
         VALUES ($1,'dep_override',$2,NULL,$3,$4,$5)`,
        [id, myId, `${id} claimed with open dependencies ${waitsOn.length ? waitsOn.join(', ') : '(none)'}: ${flags.reason}`, JSON.stringify({ waitsOn, reason: flags.reason }), eventBoard()],
      );
    }
    await c.query(row ? 'COMMIT' : 'ROLLBACK');
    if (row) delete row.waits_on;
    return row ?? null;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/** One SELECT for the diagnosis after a claim matched no row. $1 lane, $2 caller, $3 board. `withDeps` false: no lane_dep table. */
async function diagnoseClaim(c, id, myId, board, withDeps) {
  const pack = `CASE WHEN left(l.id, 3) = 're-' AND l.branch LIKE 're/%' THEN (${packHeldFrom("json_build_object('id', o.id, 'owner', o.owner_session_id)")} LIMIT 1) END`;
  const other = `CASE WHEN left(l.id, 3) = 're-' THEN (${secondReFrom("json_build_object('id', o.id, 'state', o.state)")} LIMIT 1) END`;
  return (await c.query(
    `SELECT l.*, ${RECLAIMABLE} AS reclaimable, ${withDeps ? waitsOnSql('l') : "'{}'::text[]"} AS waits_on, ${pack} AS pack_held, ${other} AS other_re
     FROM agentic_os.lane l WHERE l.id = $1 AND l.project_key = $3`,
    [id, myId, board.key],
  )).rows[0];
}

/** The line of one open dependency for the [open-dependency] text (contract: the four <status> forms). Joins on the id alone (1.4). */
async function depStatusLines(c, id, boardKey, waits) {
  const { rows } = await c.query(
    `SELECT d.depends_on AS id, x.project_key, x.state, ${laneMetSql('x')} AS met
     FROM agentic_os.lane_dep d LEFT JOIN agentic_os.lane x ON x.id = d.depends_on
     WHERE d.lane_id = $1 ORDER BY d.depends_on`,
    [id],
  );
  return rows.filter((r) => waits.includes(r.id)).map((r) => {
    const status = r.project_key === null ? 'missing: no lane has this id'
      : r.project_key !== boardKey ? `on board ${r.project_key}`
      : r.state === 'done' ? 'done, but no SHA on main is recorded' : `state ${r.state}`;
    return `  ${r.id}: ${status}`;
  });
}

/** The refusal rows 4 to 8 of the diagnosis table, in that order. Returns nothing when none applies (row 9). `override` skips row 6. */
async function claimRefusal(c, cur, id, board, override) {
  const cmd = laneCliCmd();
  if (cur.state === 'done') {
    return refusal('claim', id, 'done', 'the lane is done', `A done lane is never claimed. To reopen it: ${cmd} state ${id} ready, then ${cmd} claim ${id}.`);
  }
  if (cur.state === 'blocked') {
    return refusal('claim', id, 'blocked', 'the lane is blocked', `It waits on a hold. Read its note and scope: ${cmd} board. It opens when the hold ends and it moves to backlog.`);
  }
  if (!override && (['backlog', 'ready'].includes(cur.state) || cur.owner_session_id === null) && cur.waits_on.length) {
    const lines = await depStatusLines(c, id, board.key, cur.waits_on);
    const hint = `${lines.join('\n')}\n  A dependency is met when its lane is done with a SHA on main: ${cmd} done <dep> --merged <sha>.\n  Claim another lane by id: ${cmd} board --by priority`;
    return refusal('claim', id, 'open-dependency', `waits on ${cur.waits_on.join(', ')}`, hint.replace(/^  /, ''), { waits_on: cur.waits_on });
  }
  if (cur.pack_held) {
    return refusal('claim', id, 'pack-held', `${cur.pack_held.id} on branch ${cur.branch} is held by ${L(cur.pack_held.owner)}`,
      `The lanes of one pack go to one session. Claim another lane by id: ${cmd} board --by priority`);
  }
  if (cur.other_re) {
    const o = cur.other_re;
    const finish = `One re- lane per session. Finish it (${cmd} done ${o.id} --merged <sha>)`;
    return refusal('claim', id, 'second-re-lane', `you hold ${o.id}`, o.state === 'review'
      ? `${finish}, or end this session so a fresh session can claim ${id} by id.`
      : `${finish} or release it (${cmd} release ${o.id}), then claim ${id}.`);
  }
  return null;
}

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

// ---------------------------------------------------------------- seed

/**
 * One lane item of a seed file as an upsert. Deliberately asymmetric on conflict: descriptive columns are refreshed
 * from the seed, but `state`, `note` and every ownership column are NOT.
 * Re-seeding must never revert a live claim or overwrite the status line
 * the holder is currently maintaining -- the seed knows the shape of the
 * work, the session knows what is happening to it right now.
 * Name the band column only when some item carries a band (withBand), so a seed with no bands works before migration 0005.
 * An omitted band or priority (undefined) keeps the stored value on conflict; a new lane gets NULL / 50.
 */
async function upsertSeedLane(c, it, board, withBand) {
  const band = parseBand(it.band);
  const priority = parsePriority(it.priority);
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
}

/** Rule 7 (contract t2.1, point 1.4): an edge to a lane that another board owns is refused, before any write. */
async function refuseForeignEdges(c, edges, board) {
  const rows = (await c.query(
    `SELECT id, project_key FROM agentic_os.lane WHERE id = ANY($1::text[]) AND project_key <> $2`,
    [edges.map((e) => e.dependsOn), board.key],
  )).rows;
  const owner = new Map(rows.map((r) => [r.id, r.project_key]));
  const bad = edges.find((e) => owner.has(e.dependsOn));
  if (bad) throw new Error(`edge ${bad.lane} -> ${bad.dependsOn}: lane '${bad.dependsOn}' belongs to board '${owner.get(bad.dependsOn)}'`);
}

/** The replace set is every lane id of lanes[]. The DELETE has no project_key filter: lane ids are global (1.10). */
async function replaceEdges(c, lanes, edges, board) {
  await c.query(`DELETE FROM agentic_os.lane_dep WHERE lane_id = ANY($1::text[])`, [lanes.map((l) => l.id)]);
  await c.query(
    `INSERT INTO agentic_os.lane_dep (lane_id, depends_on, project_key)
     SELECT t.l, t.d, $3 FROM unnest($1::text[], $2::text[]) AS t(l, d)`,
    [edges.map((e) => e.lane), edges.map((e) => e.dependsOn), board.key],
  );
}

/** After the replace: a cycle in the full edge set of the board refuses the file (1.7). The caller rolls back. */
async function refuseCycle(c, board) {
  const all = (await c.query(`SELECT lane_id, depends_on FROM agentic_os.lane_dep WHERE project_key = $1`, [board.key])).rows;
  const cycle = findCycle(all.map((r) => ({ lane: r.lane_id, dependsOn: r.depends_on })));
  if (cycle) throw new Error(`seed refused: cycle ${cycle.join(' -> ')}`);
}

/** Rule 8: the edges whose dependency has no lane row at all. They count as open; the seed warns. */
async function missingDeps(c, edges) {
  const have = new Set((await c.query(`SELECT id FROM agentic_os.lane WHERE id = ANY($1::text[])`, [edges.map((e) => e.dependsOn)])).rows.map((r) => r.id));
  return edges.filter((e) => !have.has(e.dependsOn));
}

/** The object form, in the order of 1.10: BEGIN, board lock, upserts, replace, cycle check, seeded event, COMMIT. */
async function seedObject(c, { lanes, edges, dropped }, { file, board, myId }) {
  if (!(await hasLaneDep(c))) throw new Error('migration 0006 (lane_dep) is not applied; an object-form seed needs the lane_dep table');
  await checkSeedItems(c, lanes, board);
  const withBand = lanes.some((it) => parseBand(it.band) !== undefined);
  let missing;
  await c.query('BEGIN');
  try {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('lane_dep:' || $1::text))`, [board.key]);
    await refuseForeignEdges(c, edges, board);
    for (const it of lanes) await upsertSeedLane(c, it, board, withBand);
    await replaceEdges(c, lanes, edges, board);
    await refuseCycle(c, board);
    missing = await missingDeps(c, edges);
    // A direct INSERT, not logEvent: logEvent swallows a failed insert, and the COMMIT would then be a ROLLBACK.
    await c.query(
      `INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body, detail, project_key)
       VALUES (NULL,'seeded',$1,NULL,$2,$3,$4)`,
      [myId, `seeded ${lanes.length} lanes and ${edges.length} edges from ${file}`, JSON.stringify({ lanes: lanes.length, edges: edges.length }), eventBoard()],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  }
  return [
    `seeded ${lanes.length} lane(s) and ${edges.length} edge(s) on board ${board.key}`,
    ...(dropped ? [`  dropped ${dropped} duplicate edge(s)`] : []),
    ...missing.map((e) => `  warning: ${e.lane} -> ${e.dependsOn}: no lane has this id; it counts as open`),
  ].join('\n');
}

// ---------------------------------------------------------------- remind
// A reminder is a lane with a due time (design: .claudedocs/2026-11-06-lane-reminders-design.md). Pure rules live in
// reminder-core.mjs. Every write sets updated_at=now() (the later Notion sync reads it) and logs ONE broadcast
// lane_event of kind 'reminder'. A no-op (the same ack twice, a clear of a non-reminder) writes and logs nothing.

const REMIND_USAGE = 'usage: lane.mjs remind set <id> --at <time> [--title "..."] [--pri P0|P1|P2] [--action <id>] [--done-when "..."] [--allow-past] '
  + '| list [--all] [--due] | snooze <id> --for 30m|2h|1d (or --at <time>) | ack <id> | clear <id> | tick [--dry-run] [--no-sync]';

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

/**
 * `remind tick`: fire the due reminders of EVERY board (no projectOf, no session). The engine is loaded on demand,
 * so no other command pays for it. A missing migration 0005 is exit 2, like a database that is down (see main).
 */
async function remindSync() {
  const { defaultStateDir, syncSwitch } = await import('./reminder-tick.mjs');
  return syncSwitch(defaultStateDir(), positional[2]);
}

async function remindTick(c) {
  const { runTick } = await import('./reminder-tick.mjs');
  const lines = [];
  try {
    const res = await runTick({ db: c, dryRun: flags['dry-run'] === true, noSync: flags['no-sync'] === true, reclaimable: RECLAIMABLE, log: (l) => lines.push(l) });
    return JSON_OUT ? { ...res, lines } : lines.join('\n');
  } catch (e) {
    const err = remindMigrationError(e);
    if (err !== e) err.exitCode = 2;
    throw err;
  }
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
    const waits = (await depGate(c)) ? `, ${waitsOnSql('l')} AS waits_on` : '';
    const { rows } = await c.query(
      `SELECT l.*${waits} FROM agentic_os.lane l
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
          WHERE to_session_id=$1 AND session_id <> $1 AND id > $3::bigint RETURNING id`, [oldId, newId, oldWm ?? 0],
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
    const noOpenDep = (await depGate(c)) ? `AND NOT ${openDepSql('l')}` : '';
    const { rows } = await c.query(
      `SELECT l.* FROM agentic_os.lane l
       WHERE l.project_key = $1 AND l.state IN ('ready','backlog') AND ${RECLAIMABLE}
         AND ${CLAIMABLE_NOT_REMINDER} ${noOpenDep}
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
    if (!id) throw new Error('usage: lane.mjs claim <lane-id> [--note "..."] [--dep-override --reason "..."]');
    const override = flags['dep-override'] === true;
    if (override && typeof flags.reason !== 'string') throw new Error('--dep-override needs --reason "<text>" (usage error; nothing was run)');
    const withDeps = await depGate(c);

    const l = await claimUpdate(c, { id, myId, board, override, withDeps });
    if (l) {
      await logEvent(c, {
        laneId: id, kind: 'claimed', sessionId: myId,
        body: typeof flags.note === 'string' ? flags.note : null,
        detail: { fence: l.fence, state: l.state },
      });
      return JSON_OUT ? l
        : `CLAIMED ${id} (fence ${l.fence}, lease ${LEASE_MINUTES}m)\n  ${l.title}\n  scope: ${l.scope || '(undeclared -- set one)'}`;
    }

    const cur = await diagnoseClaim(c, id, myId, board, withDeps);
    if (!cur) throw await noLane(c, id, board);
    if (cur.owner_session_id === myId) {
      return JSON_OUT ? cur : `you already hold ${id} -- use "renew" to extend, "note" to update it`;
    }
    if (cur.reclaimable) {
      const refused = await claimRefusal(c, cur, id, board, override);
      if (refused) throw refused;
      throw new Error(`claim ${id} refused for no known reason; run ${laneCliCmd()} board and retry`);
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
      // M5: a session that lost its own lane to a restart is told how to take it back, as the not-holder refusal tells it.
      ...(adoptAllowed(cur.owner_session_id, myId, readIdentity(cur.owner_session_id), readIdentity(myId)) ? [`  ${adoptHint(cur.owner_session_id)}`] : []),
      `  They have been told you wanted it. Claim another lane by id: ${laneCliCmd()} board --by priority`,
    ].join('\n');
    const e = new Error(err); e.soft = true; throw e;
  },

  async renew(c) {
    const myId = me();
    const { rows } = await c.query(
      `UPDATE agentic_os.lane SET lease_expires_at = GREATEST(lease_expires_at, now() + interval '${LEASE_MINUTES} minutes'), updated_at = now()
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
    // Refuse only a lane that a live session other than the caller holds (M7): a lane with no holder needs no reason.
    // The update and the diagnosis of a miss run under one row lock, so a release in between cannot turn into a wrong [not-holder].
    const rows = await inLaneTx(c, async () => {
      await lockLane(c, id, board);
      const res = await c.query(
        `UPDATE agentic_os.lane l SET note=$2, updated_at=now(),
           lease_expires_at = CASE WHEN l.owner_session_id=$3
             THEN GREATEST(l.lease_expires_at, now() + interval '${LEASE_MINUTES} minutes') ELSE l.lease_expires_at END
         WHERE l.id=$1 AND l.project_key=$4 AND (l.owner_session_id=$3 OR ${RECLAIMABLE}) RETURNING l.*`, [id, body, myId, board.key],
      );
      if (!res.rows.length) throw await heldByOther(c, 'note', id, board, myId);
      return { value: res.rows };
    });
    await logEvent(c, { laneId: id, kind: 'note', sessionId: myId, body, detail: agentDetail() });
    return JSON_OUT ? rows[0] : `noted on ${id}: ${body}`;
  },

  /**
   * Record a compaction on a lane I own as a 'compact' event. EVENT ONLY: lane.note is not touched, so the progress
   * note Dave or a session wrote stays. The PreCompact hook calls this (it used to call `note`, which replaced the note).
   * Addressed to me, like `adopt`: no peer gets an inbox line, and my own inbox skips my own events. The lease is
   * renewed as `note` did. updated_at is left alone, as nothing on the lane changed.
   */
  async compact(c) {
    const myId = me();
    const id = positional[1];
    const board = await projectForOwnedLane(c, id, myId);
    const body = positional.slice(2).join(' ');
    if (!id || !body) throw new Error('usage: lane.mjs compact <lane-id> "compaction text"  (event only; the note stays)');
    const { rows } = await c.query(
      `UPDATE agentic_os.lane SET lease_expires_at = CASE WHEN owner_session_id=$3
           THEN GREATEST(lease_expires_at, now() + interval '${LEASE_MINUTES} minutes') ELSE lease_expires_at END
       WHERE id=$1 AND project_key=$2 RETURNING id`, [id, board.key, myId],
    );
    if (!rows.length) throw await noLane(c, id, board);
    // Direct INSERT, not logEvent: logEvent swallows its error, and the event is the only effect of this verb.
    // A failed insert must reach the exit handler, or the hook would report success and start its cooldown.
    await c.query(
      `INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body, detail, project_key)
       VALUES ($1,'compact',$2,$2,$3,$4,$5)`,
      [id, myId, body, JSON.stringify(agentDetail()), eventBoard()],
    );
    return JSON_OUT ? { id, kind: 'compact', body } : `compact event on ${id}: ${body}`;
  },

  async state(c) { return stateChange(c, 'state'); },

  async release(c) { return stateChange(c, 'release'); },

  async park(c) { return parkLane(c); },

  async done(c) {
    assertDoneForm();
    if (flags['no-pr'] === true || typeof flags.merged === 'string') return doneLanded(c);
    return stateChange(c, 'done');
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
    // One transaction: a conflicting row stays locked when the WHERE is false, so the diagnosis below reads the same holder the WHERE saw.
    let rows;
    await c.query('BEGIN');
    try {
      ({ rows } = await c.query(
        `INSERT INTO agentic_os.lane AS l (id,title,track,scope,branch,state,priority,note,project_key${withBand ? ',band' : ''})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9${withBand ? ',$13' : ''})
         ON CONFLICT (id) DO UPDATE SET
           title=EXCLUDED.title,
           track=CASE WHEN $11::boolean THEN EXCLUDED.track ELSE l.track END,
           scope=COALESCE(EXCLUDED.scope, l.scope),
           priority=CASE WHEN $10::boolean THEN EXCLUDED.priority ELSE l.priority END,
           ${withBand ? 'band=EXCLUDED.band,' : ''} updated_at=now()
         WHERE l.project_key = EXCLUDED.project_key AND (l.owner_session_id = $12::text OR ${RECLAIMABLE})
         RETURNING l.*`,
        [id, flags.title, flags.track || 'unsorted', flags.scope || null, flags.branch || null,
         LANE_STATES.includes(flags.state) ? flags.state : 'backlog',
         priority ?? 50, typeof flags.note === 'string' ? flags.note : null, board.key,
         priority !== undefined, Boolean(flags.track), myId, ...(withBand ? [band] : [])],
      ));
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw bandMigrationError(e); }
    if (!rows.length) {
      // No row back: another board has the id, or a live session other than the caller holds the lane (M7: a lane with no holder opens).
      const cur = (await c.query(`SELECT project_key, owner_session_id FROM agentic_os.lane WHERE id=$1`, [id])).rows[0];
      await c.query('ROLLBACK');
      if (!cur || cur.project_key !== board.key) throw await foreignId(c, id);
      throw notHolderRefusal('add', id, cur.owner_session_id, myId, { withOverride: false });
    }
    await c.query('COMMIT');
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
   * Timed reminders on lanes: set, list, snooze, ack (alias done), clear, tick. Needs migration 0005.
   * `remind tick` is the 5-minute job (reminder-tick.mjs). It needs no board and no session.
   */
  async remind(c) {
    const sub = positional[1];
    if (sub === 'tick') return remindTick(c);
    if (sub === 'sync') return remindSync();
    if (!Object.hasOwn(REMIND_VERBS, sub)) throw new Error(REMIND_USAGE);
    try {
      return await REMIND_VERBS[sub](c);
    } catch (e) { throw remindMigrationError(e); }
  },

  /** Bulk idempotent add from JSON. Re-running never clobbers live claims,
   *  because it only ever touches the descriptive columns. Every item lands on the
   *  resolved board; an item that names another board, or an id that another board
   *  owns, stops the run before anything is written.
   *  Two forms (contract t2.1, point 2). An array upserts lanes only and never touches lane_dep.
   *  An object { lanes, edges } upserts the lanes and replaces the edges of every lane in lanes[], in one transaction. */
  async seed(c) {
    const myId = me();
    const board = projectOf();
    const file = positional[1];
    if (!file) throw new Error('usage: lane.mjs seed <file.json>');
    const parsed = parseSeedFile(JSON.parse(readFileSync(file, 'utf8')));
    if (parsed.form === 'object') return seedObject(c, parsed, { file, board, myId });
    await checkSeedItems(c, parsed.lanes, board);
    const withBand = parsed.lanes.some((it) => parseBand(it.band) !== undefined);
    for (const it of parsed.lanes) await upsertSeedLane(c, it, board, withBand);
    await logEvent(c, { kind: 'seeded', sessionId: myId, body: `seeded ${parsed.lanes.length} lanes from ${file}` });
    return `seeded ${parsed.lanes.length} lane(s) on board ${board.key}`;
  },

  /**
   * Carry Dave's kanban changes (order, status, band, notes, questions) into the lane table.
   * A band comes only from a pending card (never from a drag) and needs migration 0005.
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
      plan = planKanban(input, await kanbanLanes(c, board.key));
    } else {
      await c.query('BEGIN');
      try {
        const lanes = await kanbanLanes(c, board.key, ' FOR UPDATE OF l');
        plan = planKanban(input, lanes);
        for (const a of plan.actions) await applyKanbanAction(c, a, board.key);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      }
      for (const a of plan.actions) {
        // A band change is logged as kind 'band', the same as the band verb, so band history readers see it.
        if (a.kind === 'band') {
          const word = (v) => v ?? 'none';
          await logEvent(c, {
            laneId: a.laneId, kind: 'band', sessionId: myId,
            body: `band ${word(a.from)} -> ${word(a.to)}`, detail: { from: a.from, to: a.to, actor: 'kanban' },
          });
          continue;
        }
        await logEvent(c, {
          laneId: a.laneId, kind: 'kanban', sessionId: myId,
          body: a.kind === 'note' ? a.to : `${a.laneId} ${a.kind} ${a.from ?? '(none)'} -> ${a.to}`,
          detail: { kind: a.kind, from: a.from, to: a.to, text: a.text },
        });
      }
    }

    const count = (k) => plan.actions.filter((a) => a.kind === k).length;
    const summary = { priority: count('priority'), state: count('state'), band: count('band'), note: count('note'), skipped: plan.skipped.length };
    const line = `kanban${dry ? ' (dry run, nothing written)' : ''}: ${summary.priority} priority, ${summary.state} state, ${summary.band} band, ${summary.note} notes, ${summary.skipped} skipped`;
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
const kanbanLanesSql = (withDeps) => `SELECT l.id, l.state, l.priority, l.note, l.band, NOT ${RECLAIMABLE} AS held${withDeps ? `, ${waitsOnSql('l')} AS waits_on` : ''} FROM agentic_os.lane l WHERE l.project_key = $1`;

/** Read the lanes for the planner. l.band needs migration 0005: a database without it gets one clear message. */
async function kanbanLanes(c, boardKey, suffix = '') {
  const withDeps = await depGate(c);
  try { return (await c.query(`${kanbanLanesSql(withDeps)}${suffix}`, [boardKey])).rows; } catch (e) { throw bandMigrationError(e); }
}

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
    // band, not priority. The ::text cast types the NULL that 'none' sends.
    band: `UPDATE agentic_os.lane SET band=$2::text, updated_at=now() WHERE id=$1 AND project_key=$3`,
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

/** A flag a verb does not take is a usage error (exit 1) before any write. Without this the flag was dropped, and `release --if-state x` ran with no condition. */
const FOREIGN_FLAGS = {
  state: ['blocked'], release: ['if-state'], done: ['if-state', 'blocked'], park: ['if-state', 'override'],
  note: ['override'], add: ['override'], claim: ['override'],
};

try {
  const foreign = (FOREIGN_FLAGS[cmd] ?? []).find((k) => flags[k] !== undefined);
  if (foreign) throw new Error(`--${foreign} does not apply to ${cmd} (usage error; nothing was run)`);
  if (BARE_TEXT_FLAG) throw new Error(`--${BARE_TEXT_FLAG} needs a value (usage error; nothing was run)`);
  const needsDb = !(cmd === 'project' && positional[1] === 'which') && !(cmd === 'remind' && positional[1] === 'sync');
  const result = needsDb ? await withDb((c) => commands[cmd](c)) : await commands[cmd](null);
  process.stdout.write((JSON_OUT ? JSON.stringify(result, null, 2) : String(result)) + '\n');
  flushDepWarning();
} catch (e) {
  process.stderr.write(`${isMissingMigration(e) ? MIGRATION_MSG : e.message}\n`);
  flushDepWarning();
  // A refusal under --json also writes one machine line, last on stderr: { refused, verb, id, rule }.
  if (JSON_OUT && e.refusal) process.stderr.write(`${JSON.stringify(e.refusal)}\n`);
  // A denied claim is a correct, expected answer -- exit 3 so a caller can tell
  // "someone else has it" apart from "the tool broke" (exit 1).
  // remind tick exits 2 when the database is not there (down, login refused, no migration), so the doctor shows red.
  const tickDown = cmd === 'remind' && positional[1] === 'tick' && (isDbUnreachable(e) || isMissingMigration(e));
  process.exit(e.exitCode ?? (tickDown ? 2 : e.soft ? 3 : 1));
}
