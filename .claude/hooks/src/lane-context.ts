/**
 * lane-context — carries the coordination board INTO each session.
 *
 * WHY A HOOK AND NOT JUST THE CLI
 * -------------------------------
 * The lane CLI (`lane.mjs`, run through the shim `<home>/.claude/scripts/lane.mjs`) can answer every question this hook answers.
 * That is exactly why the CLI alone is not enough: it requires a session to
 * remember to ask. The predecessor of this whole layer was a markdown file at
 * the repo root, and its fatal flaw was not its format — it was that nothing
 * carried it into a session that did not think to open it. Coordination that
 * depends on remembering to look is coordination that fails on the busy day.
 *
 * So the board is pushed, once per turn, unprompted.
 *
 * WHAT IT INJECTS
 * ---------------
 *   SessionStart      the full picture: lanes I hold, who else is live and on
 *                     what, and what is claimable.
 *   UserPromptSubmit  the DELTA only — events since my watermark. Silence when
 *                     nothing changed, because a banner that prints every turn
 *                     regardless is one the model learns to skip.
 *   PostToolUse       DIRECT messages only, mid-turn. See below.
 *
 * It also renews my lane leases on every prompt. A session actively working
 * should never lose its lane to a lapse; the lease exists to release the lanes
 * of sessions that have STOPPED, and the cheapest proof that I have not stopped
 * is that I am still taking turns.
 *
 * WHY A THIRD PATH — MID-TURN DELIVERY
 * ------------------------------------
 * Both paths above fire only when the HUMAN acts. A session twenty minutes into
 * an agent wave sees nothing until it stops, which is exactly when a warning is
 * worth most. A real example from this board: "AVOID editing those files until I
 * release" — a message whose entire value was time-sensitive, delivered at the
 * next prompt and no sooner.
 *
 * So PostToolUse carries direct messages between tool calls. Three properties
 * make that safe rather than merely faster:
 *
 *   NON-CONSUMING. This path NEVER advances the database watermark. It is a
 *   best-effort early copy; the prompt path remains the system of record and
 *   re-delivers the same message durably. This is not tidiness — it is the only
 *   reason the path is safe at all, see the subagent note below.
 *
 *   DIRECT MESSAGES ONLY. Broadcast notes stay on the prompt path. A branch-wide
 *   note interrupting every tool call in every live session is a denial of
 *   service dressed up as coordination.
 *
 *   THROTTLED BEFORE CONNECTING. PostToolUse fires orders of magnitude more often
 *   than UserPromptSubmit. The throttle is a single statSync-and-parse of a temp
 *   file, checked BEFORE the pg client is constructed, so the common case costs
 *   no socket and no query.
 *
 * SUBAGENTS ARE INDISTINGUISHABLE, AND THAT IS WHY THIS IS BUILT THIS WAY
 * ----------------------------------------------------------------------
 * The obvious design — consume the message here and mark it read — is unsafe,
 * because a hook CANNOT tell whether it is running inside a subagent.
 * identity-probe answered this on 2026-07-26: a scout subagent's PostToolUse
 * reported the SAME payload session_id as its parent, with CLAUDE_AGENT_ID unset
 * and an identical ppid (see identity-probe.ts, Q1). Re-checked 2026-08-10
 * against 361 logged rows: CLAUDE_AGENT_ID has never once been set.
 *
 * A consuming implementation would therefore let a subagent read a message
 * addressed to its parent, mark it read, and leave the orchestrator permanently
 * unaware — silent loss, the worst failure this layer can have. Because this
 * path consumes nothing, the worst a subagent can do is absorb one early copy,
 * and the message still arrives on the prompt path. The failure mode degrades to
 * today's behaviour instead of below it.
 *
 * FAILURE POSTURE — SILENT, ALWAYS
 * --------------------------------
 * This runs in EVERY Claude Code session on this machine, including projects
 * that have nothing to do with lanes. Every failure path — no database, no
 * tables, wrong project, slow connect — exits 0 with empty output. An
 * instrumentation hook may never be the reason a session cannot start, and a
 * coordination banner is worth strictly less than the turn it would interrupt.
 * The connect timeout is deliberately shorter than the file-claims path's,
 * because unlike a claim check, being late here costs a turn and buys nothing.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Client } from 'pg';
import { boardRoots, DEFAULT_BOARD, isHeadless, laneCliCmd, normalizeRoot, resolveBoard, wmKey } from './shared/lane-board.js';
import { openDepSql } from './shared/lane-dep.js';
import { bandTag, laneOrderSql } from './shared/lane-sort.js';
import { resolveDbUrl } from './shared/pg-client.js';
import { isEngineHost } from './shared/engine-host.js';
import { atomicWriteSync } from './shared/atomic-write.js';
import { identityDir, label } from './shared/session-identity.js';

/**
 * The context-injection output shape.
 *
 * Declared locally rather than imported: `HookOutput` in shared/types.ts is a
 * union of the PreToolUse permission shape and the legacy result shape, and
 * models neither `additionalContext` nor SessionStart. Casting through it would
 * have been a lie the compiler correctly refused.
 */
interface ContextInjectionOutput {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

/**
 * Tools this hook is registered under on PostToolUse (settings.json matcher
 * `Edit|Write|Bash|PowerShell|Task|Agent`; the subagent tool is named Agent now, Task stays for
 * old transcripts). The hook is deliberately tool-agnostic:
 * any post-tool event means only "the session is alive — renew leases, maybe
 * inject the delta", so there is NO runtime tool_name gate that could fall out
 * of sync with the matcher. This roster exists so the matcher/runtime
 * consistency guard can see each named tool (PowerShell included) is
 * intentional, not an inert registration.
 */
const REGISTERED_TOOLS = ['Edit', 'Write', 'Bash', 'PowerShell', 'Task', 'Agent'] as const;
void REGISTERED_TOOLS;

/** Shorter than the claim path's 2000ms: a missed banner is free, a stalled prompt is not. */
const CONNECT_TIMEOUT_MS = 1200;
const QUERY_TIMEOUT_MS = 1500;
const LEASE_MINUTES = 90;
const STALE_MINUTES = 5;
/**
 * The reclaim test of lane.mjs (rule L2.8) as a SQL boolean on `agentic_os.lane`: the lease ended AND the holder is
 * quiet. One definition, for the Related line and the SEAT line.
 */
export const RECLAIMABLE_SQL = `((lease_expires_at IS NULL OR lease_expires_at < now())
             AND NOT EXISTS (
               SELECT 1 FROM sessions s
               WHERE s.id = agentic_os.lane.owner_session_id
                 AND GREATEST(s.last_heartbeat, s.last_activity_at) > now() - interval '${STALE_MINUTES} minutes'
             ))`;
/** Past this, an injected digest stops being a summary and starts being a wall. */
const MAX_EVENTS = 12;
/**
 * Peer sessions listed at SessionStart. The rest become a "+N more sessions" line.
 * Limit: the peer scopes share BUDGETS.scopes (2,400 bytes), so each cut scope gets at least 240 bytes. That is
 * more than the scope cut marker. Raise this only with that pool, or a cut scope can be the marker alone.
 */
const MAX_PEERS = 10;

/**
 * Mid-turn delivery budget.
 *
 * 15s is the whole latency contract: a direct message lands within 15s of a tool
 * call rather than within one human turn, and no more than four database checks
 * happen per minute per session no matter how fast the tools run. Lower it and
 * PostToolUse starts paying for a socket on nearly every call; raise it and the
 * path stops being meaningfully "mid-turn".
 */
export const DM_THROTTLE_MS = 15_000;
/** An interruption is worth reading only while it stays short. */
const DM_MAX_EVENTS = 5;
/** Ends every block that shows a direct message: the prompt page (unreadLines) and the mid-turn block (M4.14). */
const REPLY_FOOTER = 'A DM with a decision, a finding or a request: reply one time (M4.14).';
/** The Related line in the SessionStart banner shows at most this many ids. */
const RELATED_MAX = 8;
const RELATES_TO = 'RELATES TO:';

export interface DmState { ts: number; lastShownDmId: number }

/**
 * Per-session throttle + de-duplication state.
 *
 * Deliberately a temp file and not a database row: its whole job is to be
 * readable without paying for the connection we are trying to avoid.
 */
export function dmStatePath(sessionId: string): string {
  return join(tmpdir(), `claude-lane-dm-${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

export function readDmState(sessionId: string): DmState {
  try {
    const s = JSON.parse(readFileSync(dmStatePath(sessionId), 'utf8')) as Partial<DmState>;
    return {
      ts: Number(s.ts) || 0,
      lastShownDmId: Number(s.lastShownDmId) || 0,
    };
  } catch {
    // Absent, unreadable or corrupt all mean the same thing: nothing shown yet,
    // never throttled. A missing file must not suppress delivery.
    return { ts: 0, lastShownDmId: 0 };
  }
}

export function writeDmState(sessionId: string, state: DmState): void {
  try {
    writeFileSync(dmStatePath(sessionId), JSON.stringify(state), 'utf8');
  } catch { /* a throttle we failed to record is a check we repeat; harmless */ }
}

interface LaneRow {
  id: string; title: string; track: string; state: string;
  scope: string | null; note: string | null;
  owner_session_id: string | null; lease_expires_at: string | null;
  project_key?: string;
  /** P0, P1, P2 or NULL (Unsorted). Absent on a database without migration 0005. */
  band?: string | null;
  due_at?: string | null;
  /** Reminder columns (migration 0005). `total` is the window count the reminders query adds. */
  remind_state?: string | null;
  action_id?: string | null;
  total?: string | number;
}
interface EventRow {
  id: number; occurred_at: string; lane_id: string | null; kind: string;
  session_id: string; to_session_id: string | null; body: string | null;
  project_key?: string;
  /** The board's cursor row at read time. NULL = no row yet (a first look at this board). Board path only. */
  board_wm?: number | string | null;
}

function connString(): string | null {
  return resolveDbUrl();
}

/** "<name> #sid8" for a session, from its identity file. Falls back to "#sid8". */
const who = (s: string | null, name?: string): string => (s ? label(s, name) : '#--------');

/** Echo back the event we were actually invoked for — a SessionStart injection
 *  labelled UserPromptSubmit is a mismatch the harness has no reason to honour. */
function emit(context: string, eventName: string): void {
  process.stdout.write(JSON.stringify(buildOutput(context, eventName)));
}

/** The object emit() prints: `{}` for no context, else the injection envelope. */
function buildOutput(context: string, eventName: string): ContextInjectionOutput | Record<string, never> {
  if (!context.trim()) return {};
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------- board SQL
// Copies of the lane.mjs text. Source drift tests (lane-context-board.test.ts) compare UNREAD_SQL with
// the primary checkout's lane CLI source (lane.mjs); the peer SQL below is compared there too.

/** What this hook tells the 0004 trigger: "I know about boards". Same value as lane.mjs CLIENT_VERSION. */
const CLIENT_VERSION = '2';

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

/**
 * The direct messages a session has not read, for a session with NO board (an unregistered cwd). $1 = me.
 * The DM half of UNREAD_SQL, same single cursor: the highest across all of my rows. No broadcasts: a broadcast
 * belongs to a board, and this session has none.
 */
const DM_ONLY_SQL = `e.session_id <> $1::text AND e.to_session_id = $1::text
  AND e.id > COALESCE((SELECT MAX(last_event_id) FROM agentic_os.lane_watermark
                        WHERE session_id = $1::text OR starts_with(session_id, $1::text || '@')), 0)`;

/** `sessions.project` folded the way normalizeRoot folds a path (the SQL twin, steps in the same order). */
const FOLDED_PROJECT = (alias = 's.') =>
  `rtrim(regexp_replace(regexp_replace(lower(regexp_replace(replace(${alias}project, chr(92), '/'), '^//[?.]/', '')), ` +
  `'^/([a-z])(/|$)', '\\1:\\2'), '(?<=.)/{2,}', '/', 'g'), '/')`;

/** SQL: the session's project is a root of the board, or under one. starts_with, never LIKE: paths hold `_`. */
const underRootsSql = (rootsParam: string) => `EXISTS (SELECT 1 FROM unnest(${rootsParam}::text[]) r
           WHERE ${FOLDED_PROJECT()} = r OR starts_with(${FOLDED_PROJECT()}, r || '/'))`;

/** SQL: a peer of the board = under its roots, or it owns a lane there (T7: a session started in the home dir). */
const peerOfBoardSql = (rootsParam: string, boardParam: string) => `(
  ${underRootsSql(rootsParam)}
  OR EXISTS (SELECT 1 FROM agentic_os.lane bl
              WHERE bl.owner_session_id = s.id AND bl.project_key = ${boardParam}::text))`;

// ---------------------------------------------------------------- reminders

/**
 * The open, due reminders: a due time that has passed and a state that still waits for Dave. Nothing sets
 * remind_state='due' until the tick exists (a later PR), so "due" is read from the clock: due_at <= now().
 * TWIN of REMINDER_DUE_PRED in the lane CLI source (lane.mjs); lane-context-reminders.test.ts compares the two texts.
 */
const REMINDER_DUE_PRED = `l.due_at IS NOT NULL AND l.due_at <= now()
  AND l.remind_state IN ('scheduled','due','needs_dave','failed')`;

/**
 * What Claimable (claim by id) may offer as work: not a reminder lane (track 'reminders'), and no due time still ahead.
 * A reminder lane is never work: an acked one would stay at the top for ever. Reminders show in their own block.
 * TWIN of CLAIMABLE_NOT_REMINDER in the lane CLI source (lane.mjs); lane-context-reminders.test.ts compares the two texts.
 */
const CLAIMABLE_NOT_REMINDER = `l.track <> 'reminders' AND (l.due_at IS NULL OR l.due_at <= now())`;

/** Same order as every other lane list: band, due_at, priority, id. LIMIT 5 keeps the block short; total counts the rest. */
const REMINDERS_SQL = `SELECT l.id, l.title, l.band, l.due_at, l.remind_state, l.action_id,
       count(*) OVER () AS total
  FROM agentic_os.lane l
 WHERE l.project_key = $1 AND l.state <> 'done' AND ${REMINDER_DUE_PRED}
 ORDER BY ${laneOrderSql('l')} LIMIT 5`;

const CT_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23', timeZoneName: 'short',
});

/** 'Fri 11-06 08:00 CST'. Same text as fmtCT in scripts/coordination/reminder-core.mjs (hooks cannot import from scripts/). */
export function dueCT(due: string | Date): string {
  const p = Object.fromEntries(CT_FORMAT.formatToParts(new Date(due)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** '' up to 60 minutes late, else 'OVERDUE 2h' (days from 24 hours). Same rule as overdueLabel in reminder-core.mjs. */
export function overdue(due: string | Date, now: Date): string {
  const late = Math.floor((now.getTime() - new Date(due).getTime()) / 60_000);
  if (!(late > 60)) return '';
  const h = Math.floor(late / 60);
  return h < 24 ? `OVERDUE ${h}h` : `OVERDUE ${Math.floor(h / 24)}d`;
}

/**
 * The "Reminders due (N)" lines, or [] when nothing is due (the empty case is silent: no heading).
 * A row due after `now` is dropped here as well as in SQL. An action_id is shown as plain text and nothing runs:
 * version 1 only notifies.
 */
export type ReminderRow = Pick<LaneRow, 'id' | 'title' | 'band' | 'due_at' | 'remind_state' | 'action_id' | 'total'>;

export function formatReminderLines(rows: ReminderRow[], now: Date = new Date()): string[] {
  const due = rows.filter((r) => r.due_at && new Date(r.due_at).getTime() <= now.getTime());
  if (!due.length) return [];
  const total = Number(rows[0].total) || 0;
  const n = due.length === rows.length ? Math.max(total, due.length) : due.length;
  const cmd = laneCliCmd();
  const lines = [`## Reminders due (${n})`];
  // C4 of coord-banner-page-budget: an id over 64 bytes is not printed and counts in "+N more"; titles are clipped.
  const shown = due.filter((r) => fitsId(r.id));
  for (const r of shown) {
    const late = overdue(r.due_at as string, now);
    const title = cutToBytes(r.title || '', TITLE_MAX_BYTES);
    lines.push(`  ${bandTag(r.band)} ${r.id.padEnd(28)} ${dueCT(r.due_at as string)}  ${late ? `${late}  ` : ''}${title}`);
    if (r.action_id) lines.push(`     action: ${r.action_id} (shown only, nothing runs it)`);
  }
  if (n > shown.length) lines.push(`  +${n - shown.length} more: \`${cmd} remind list --due\``);
  lines.push(`  Ack: \`${cmd} remind ack <id>\` | Snooze: \`${cmd} remind snooze <id> --for 2h\``);
  return lines;
}

// ---------------------------------------------------------------- board resolver cache

const BOARD_CACHE_TTL_MS = 10 * 60_000;
const safeId = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');
const boardCachePath = (sid: string): string => join(tmpdir(), `claude-lane-board-${safeId(sid)}.json`);

/** The registry file the resolver reads (same rule as the twin's registryFile). */
function registryPath(env: NodeJS.ProcessEnv): string {
  return env.LANE_REGISTRY_PATH || join(env.USERPROFILE || env.HOME || homedir(), '.claude', 'project-registry.json');
}

/** mtime:size of the registry, so a `project register` shows up on the next call even with a warm cache. */
function registryStamp(env: NodeJS.ProcessEnv): string {
  try { const st = statSync(registryPath(env)); return `${st.mtimeMs}:${st.size}`; } catch { return 'none'; }
}

interface BoardCacheRecord { cwd: string; board: string | null; reg: string; headless: boolean; ts: number }

/**
 * The board key for this session at `cwd`, or null (headless, or no registered folder).
 *
 * The answer is cached per session in the temp dir (key: session id; validated by the normalised cwd,
 * the registry stamp, the headless switch and a 10 minute age). A `cd` or a registry edit invalidates it.
 * LANE_BOARD_CACHE=0 turns the cache off (tests). The resolver reads the registry and stats no root,
 * so a miss is cheap; the cache keeps the common prompt to one small file read (T2).
 */
export function resolveBoardKey(
  sid: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): string | null {
  const useCache = env.LANE_BOARD_CACHE !== '0';
  const here = normalizeRoot(cwd);
  const reg = registryStamp(env);
  const headless = isHeadless(env);
  if (useCache) {
    try {
      const c = JSON.parse(readFileSync(boardCachePath(sid), 'utf8')) as Partial<BoardCacheRecord>;
      if (c.cwd === here && c.reg === reg && c.headless === headless && now - Number(c.ts) < BOARD_CACHE_TTL_MS
        && (c.board === null || typeof c.board === 'string')) return c.board as string | null;
    } catch { /* no cache, or a corrupt one: resolve */ }
  }
  const board = resolveBoard(cwd, { env })?.key ?? null;
  if (useCache) {
    try {
      writeFileSync(boardCachePath(sid), JSON.stringify({ cwd: here, board, reg, headless, ts: now } satisfies BoardCacheRecord), 'utf8');
    } catch { /* a cache we failed to write is a resolve we repeat */ }
  }
  return board;
}

// ---------------------------------------------------------------- throttled error line

const ERROR_LINE_EVERY_MS = 10 * 60_000;

/**
 * Failure posture stays "return {}", but a silent hook is a hook nobody can debug (the old dist failed 42501
 * with no trace). Append ONE JSON line to ~/.claude/logs/lane-context-errors.jsonl, at most once per
 * 10 minutes per session. Never throws.
 */
export function logLaneContextError(sid: string, eventName: string, err: unknown, now: number = Date.now()): void {
  try {
    const stamp = join(tmpdir(), `claude-lane-err-${safeId(sid)}.json`);
    let last = 0;
    try { last = Number((JSON.parse(readFileSync(stamp, 'utf8')) as { ts?: number }).ts) || 0; } catch { /* first error */ }
    if (now - last < ERROR_LINE_EVERY_MS) return;
    writeFileSync(stamp, JSON.stringify({ ts: now }), 'utf8');
    const e = err as { message?: unknown; code?: unknown } | null;
    const file = process.env.LANE_CONTEXT_ERROR_LOG || join(homedir(), '.claude', 'logs', 'lane-context-errors.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    const message = String(e?.message ?? err).replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://***').slice(0, 300);
    appendFileSync(file, JSON.stringify({
      ts: new Date(now).toISOString(), session: sid, event: eventName, error: message,
      ...(e?.code ? { code: String(e.code) } : {}),
    }) + '\n', 'utf8');
  } catch { /* logging must never break the hook */ }
}

// ---------------------------------------------------------------- byte budgets (coord-banner-page-budget, CONTRACT v2)
// The harness cuts a long hook text to a short preview (about 10,000 characters; the unit is not settled), and the
// model then reads none of the rest. Every text this hook sends has a budget in UTF-8 bytes (C3). Bytes are never
// fewer than characters, so the count is safe for both units.

/** The byte budget of each text (C3) and of two parts of the SessionStart text (C4). */
export interface Budgets { start: number; prompt: number; noBoard: number; midTurn: number; header: number; scopes: number }
export const BUDGETS: Readonly<Budgets> = Object.freeze({
  start: 8000, prompt: 6000, noBoard: 6000, midTurn: 4000, header: 5000, scopes: 2400,
});
/** A cut board event keeps at least this many bytes of its body (C5c). */
const MIN_BODY_BYTES = 240;
/** Past this hook age no cursor is written (C10): the harness may kill the hook before its text is out. */
const UPTIME_LIMIT_S = 3.0;
/** A lane id longer than this is never printed, and never printed cut (C4). It counts in the "+N more" text. */
const ID_MAX_BYTES = 64;
const TITLE_MAX_BYTES = 100;
const HOLD_MAX = 8;
const PEER_LANES_MAX = 3;

/** Test seams. `uptime` is read at call time, so a spy on process.uptime works too. `now` is epoch ms (CUT line ages). */
export interface RunOpts { uptime?: () => number; budgets?: Partial<Budgets>; now?: () => number }
interface PageCtx { budgets: Budgets; late: () => boolean; age: () => number; now: () => number }

function pageCtx(opts: RunOpts): PageCtx {
  const clock = opts.uptime ?? (() => process.uptime());
  return { budgets: { ...BUDGETS, ...opts.budgets }, late: () => clock() > UPTIME_LIMIT_S, age: clock, now: opts.now ?? Date.now };
}

// ---------------------------------------------------------------- CUT, NOT READ line (card coord-seat-label-and-cut-line)
// A page that cuts an event body keeps the event id in a small state file of this hook (no database). Each later board
// text starts, after the SEAT line, with one line that names the ids still pending. An id leaves after CUT_MAX_PRINTS
// prints or CUT_TTL_MS. The line marks nothing as read. Every failure here drops the line, never the banner.

const CUT_MAX_PRINTS = 3;
const CUT_TTL_MS = 30 * 60 * 1000;
const CUT_MAX_IDS = 8;
const CUT_PREFIX = 'CUT, NOT READ:';

interface CutEntry { id: number; at: number; prints: number }
/** What the next board text prints: the line (or null), the ids on it, and the live entries the write starts from. */
interface CutPending { line: string | null; shown: number[]; entries: CutEntry[] }

/** The folder of the state files. It follows the identity folder, so a test that moves that one moves this one. */
export function cutStateDir(): string {
  return process.env.LANE_CUT_STATE_DIR || join(dirname(identityDir()), 'lane-cut');
}
const cutStatePath = (me: string): string => join(cutStateDir(), `${safeId(me)}.json`);

/**
 * The live entries: 0 to 2 prints, and kept for less than 30 minutes (an `at` in the future is not read). A missing,
 * corrupt or unreadable file gives [].
 */
function readCutEntries(me: string, now: number): CutEntry[] {
  try {
    const raw = JSON.parse(readFileSync(cutStatePath(me), 'utf8')) as { entries?: unknown };
    if (!Array.isArray(raw.entries)) return [];
    return raw.entries
      .map((e: Partial<CutEntry>) => ({ id: Number(e?.id), at: Number(e?.at), prints: Number(e?.prints) }))
      .filter((e) => Number.isSafeInteger(e.id) && e.id > 0 && Number.isFinite(e.at) && Number.isFinite(e.prints)
        && e.prints >= 0 && e.prints < CUT_MAX_PRINTS && e.at <= now && now - e.at < CUT_TTL_MS);
  } catch { return []; }
}

function cutPending(me: string, now: number): CutPending {
  const entries = readCutEntries(me, now);
  if (!entries.length) return { line: null, shown: [], entries };
  const shown = entries.slice(0, CUT_MAX_IDS).map((e) => e.id);
  const more = entries.length - shown.length;
  return { line: `${CUT_PREFIX} ${shown.join(' ')}${more > 0 ? ` +${more} more` : ''}`, shown, entries };
}

/**
 * After a text went out: one more print for each id on its line, and the ids this page cut. Never throws.
 * No write when nothing changed. The write is a temp file and a rename: the read above and this write have database
 * queries between them, so two runs of one session must never leave half a file.
 */
function recordCuts(me: string, now: number, pending: CutPending, printed: boolean, cutIds: number[]): void {
  try {
    const known = new Set(pending.entries.map((e) => e.id));
    const counted = printed ? pending.shown : [];
    const added = cutIds.filter((id) => !known.has(id));
    if (!counted.length && !added.length) return;
    const entries = pending.entries
      .map((e) => (counted.includes(e.id) ? { ...e, prints: e.prints + 1 } : e))
      .filter((e) => e.prints < CUT_MAX_PRINTS)
      .concat(added.map((id) => ({ id, at: now, prints: 0 })));
    mkdirSync(cutStateDir(), { recursive: true });
    atomicWriteSync(cutStatePath(me), JSON.stringify({ entries }));
  } catch { /* a state we could not write is a line we do not print; the banner stays */ }
}

/** The ids of events on this page whose printed body is cut. */
function cutOnPage(page: UnreadPage<EventRow>): number[] {
  return page.events.filter((e) => page.bodies?.has(e.id) && page.bodies.get(e.id) !== (e.body ?? '')).map((e) => e.id);
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** The longest start of `s` that is at most `max` bytes. It never splits a code point. */
export function cutToBytes(s: string, max: number): string {
  if (max <= 0) return '';
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1; // buf[end] is a continuation byte: the cut is inside a character
  return buf.subarray(0, end).toString('utf8');
}

/**
 * The share rule (C6). Shares `pool` bytes between texts of the given sizes, in input order. A text smaller than
 * its share keeps its size and gives the rest back; the larger texts get one level. Returns null when a text that
 * must be cut gets less than `min`, and when the pool is negative and there is a text: the caller's fixed bytes
 * (the line prefixes of C5c) do not fit, so no share can fit, not even an empty one. No I/O.
 */
export function shareBytes(sizes: number[], pool: number, min = 0): number[] | null {
  if (pool < 0 && sizes.length > 0) return null;
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
  const out = sizes.map(() => 0);
  let left = pool;
  for (let k = 0; k < order.length; k += 1) {
    const i = order[k];
    const level = Math.floor(left / (order.length - k));
    if (sizes[i] > level && level < min) return null;
    out[i] = Math.min(sizes[i], level);
    left -= out[i];
  }
  return out;
}

/** The end of a cut event body (C5b), word for word. */
export function cutMarker(more: number, id: number | string): string {
  return ` …[cut, ${more} more bytes. Full text: ${laneCliCmd()} inbox --id ${id}]`;
}

/** The end of a cut peer scope (C4), word for word. */
export function scopeCutMarker(): string {
  return ` …[cut: ${laneCliCmd()} board]`;
}

/**
 * The body whole when it fits `allowance` bytes, else cut with the marker. The room for the marker assumes that
 * all of the body is cut, so the real marker is never longer than the room. The result fits when the allowance
 * is larger than that marker.
 */
export function cutBody(body: string, allowance: number, id: number | string): string {
  const size = utf8Bytes(body);
  if (size <= allowance) return body;
  const kept = cutToBytes(body, allowance - utf8Bytes(cutMarker(size, id)));
  return kept + cutMarker(size - utf8Bytes(kept), id);
}

const boardHeading = (board: string): string => `## Lane board ${board} (concurrent sessions on this board)`;

/** C2: the text a board path sends when its own text is over its budget. It marks nothing as read. */
export function boardFallback(board: string, me: string, oldestDmId: number | null): string {
  const cmd = laneCliCmd();
  const lines = [boardHeading(board), `You are ${me}.`, `Lane text over its budget. Run: ${cmd} board`];
  if (oldestDmId !== null) lines.push(`Oldest direct message: ${cmd} inbox --id ${oldestDmId}`);
  return lines.join('\n');
}

/** C2: the text the no-board path sends when its own text is over its budget. */
export function noBoardFallback(oldestDmId: number): string {
  return `A direct message waits. Run: ${laneCliCmd()} inbox --id ${oldestDmId}`;
}

/** C9: the "more unread" line names `inbox` only when a board row exists after this page. */
export function namesInbox(o: { rowBefore: boolean; rowWritten: boolean }): boolean {
  return o.rowBefore || o.rowWritten;
}

/** Bytes of one printed line plus its newline. */
const lineBytes = (s: string): number => utf8Bytes(s) + 1;
const fitsId = (id: string): boolean => utf8Bytes(id) <= ID_MAX_BYTES;
/** The lane id part of an event line prefix. An id over 64 bytes is not printed, so no line prefix grows without a bound (C4). */
const laneTag = (id: string | null): string => (!id ? '' : fitsId(id) ? ` [${id}]` : ' [lane id not shown]');
/** The board key part of a crossed event line. A key over 64 bytes is not printed (C4). */
const fromTag = (key: string): string => (fitsId(key) ? ` [from ${key}]` : ' [from board not shown]');
/** The kind of an event line. A kind over 64 bytes is not printed (C4). */
const kindText = (kind: string): string => (fitsId(kind) ? kind : 'kind not shown');

/** "a, b, c" with at most `max` ids, then ", +N". An id over 64 bytes is not printed and counts in N (C4). */
function idList<T>(items: T[], idOf: (x: T) => string, show: (x: T) => string, max: number, more: (n: number) => string): string {
  const shown = items.filter((x) => fitsId(idOf(x))).slice(0, max);
  const rest = items.length - shown.length;
  return [...shown.map(show), ...(rest > 0 ? [more(rest)] : [])].join(', ');
}

/**
 * C7: the newest direct messages, at most `max`, each whole, while they fit `space`. When the newest alone does not
 * fit, it shows alone, cut. Returns the shown ones in id order and the body to print for each.
 */
function newestThatFit<T extends { id: number; body: string | null }>(
  dms: T[], space: number, max: number, prefix: (e: T) => string,
): { shown: T[]; bodies: Map<number, string> } {
  const bodies = new Map<number, string>();
  const shown: T[] = [];
  let used = 0;
  for (const e of dms.slice(-max).reverse()) {
    const cost = lineBytes(prefix(e) + (e.body || ''));
    if (used + cost > space) break;
    used += cost; shown.unshift(e); bodies.set(e.id, e.body || '');
  }
  if (shown.length || !dms.length) return { shown, bodies };
  const e = dms[dms.length - 1];
  bodies.set(e.id, cutBody(e.body || '', space - lineBytes(prefix(e)), e.id));
  return { shown: [e], bodies };
}

/**
 * The mid-turn path: direct messages, between tool calls.
 *
 * Reads nothing but messages addressed to me, writes nothing to the database,
 * and gives up instantly and silently on every failure — including the throttle,
 * which is checked before a client is even constructed.
 */
export async function deliverDirectMessages(
  me: string,
  now: number = Date.now(),
  emitFn: (context: string, eventName: string) => void = emit,
  budget: number = BUDGETS.midTurn,
): Promise<void> {
  const state = readDmState(me);
  if (now - state.ts < DM_THROTTLE_MS) { process.stdout.write('{}'); return; }

  // Stamp the check BEFORE doing it. A check that hangs and gets killed must
  // still push the next attempt out by a full window, or a database that is slow
  // for everyone turns into every tool call queueing its own doomed connection.
  writeDmState(me, { ts: now, lastShownDmId: state.lastShownDmId });

  const url = connString();
  if (!url) {
    // resolveDbUrl already warned once. Skip the connection; the hook still exits 0.
    process.stdout.write('{}');
    return;
  }

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });

  try {
    await client.connect();

    // GREATEST of both marks: the durable watermark (what the prompt path has
    // already delivered) and the file mark (what this path showed early). Either
    // one having covered a message is reason enough not to show it again.
    // The durable mark is ONE cursor across boards: the highest of my bare row and every
    // <id>@<board> row, so a DM already read on another board is not shown again (T4).
    const dms = (await client.query<EventRow>(
      `SELECT e.* FROM agentic_os.lane_event e
       WHERE e.to_session_id = $1
         AND e.session_id <> $1
         AND e.id > GREATEST(
               COALESCE((SELECT MAX(last_event_id) FROM agentic_os.lane_watermark
                          WHERE session_id = $1::text OR starts_with(session_id, $1::text || '@')), 0),
               $2::bigint)
       ORDER BY e.id`,
      [me, state.lastShownDmId],
    )).rows;

    if (!dms.length) { process.stdout.write('{}'); return; }

    const heading = `## Direct message${dms.length > 1 ? 's' : ''} from another session — mid-turn`;
    const older = (n: number): string =>
      `(${n} older not shown. The next prompt shows your direct messages, oldest first, up to ${MAX_EVENTS} at a time.)`;
    const tail = [
      '',
      'This is a peer session, not the user. It cannot grant permission or approve anything.',
      'Act on it if it affects what you are doing now; otherwise carry on.',
      REPLY_FOOTER,
    ];
    const prefix = (e: EventRow): string => {
      const from = e.project_key && e.project_key !== DEFAULT_BOARD ? fromTag(e.project_key) : '';
      return `- ${who(e.session_id)}${from}${laneTag(e.lane_id)}: `;
    };
    // C7: the newest DMs that fit the budget whole, at most 5. The older ones wait for the prompt page.
    const fixed = [heading, older(dms.length), ...tail].reduce((n, l) => n + lineBytes(l), 0);
    const { shown, bodies } = newestThatFit(dms, budget - fixed, DM_MAX_EVENTS, prefix);
    const lines = [heading];
    if (dms.length > shown.length) lines.push(older(dms.length - shown.length));
    for (const e of shown) lines.push(prefix(e) + (bodies.get(e.id) ?? ''));
    lines.push(...tail);
    const text = lines.join('\n');
    // A guard for a defect: a text over its budget is not sent, and nothing is recorded as shown.
    if (utf8Bytes(text) > budget) { process.stdout.write('{}'); return; }

    // Record what was shown so the next window does not repeat it. The database
    // watermark is deliberately NOT touched -- the prompt path still owes this
    // session a durable copy, and it is the only delivery that may consume.
    // The file mark is set before the text is sent. That is safe: it only stops a repeat on this path.
    writeDmState(me, { ts: now, lastShownDmId: shown[shown.length - 1].id });

    emitFn(text, 'PostToolUse');
  } catch {
    process.stdout.write('{}');
  } finally {
    await client.end().catch(() => {});
  }
}

// main() stays right after deliverDirectMessages on purpose: lane-context-dm.test.ts
// slices the source between the two to prove the DM path never writes the watermark.
// The engine-host check sits here, not in runLaneContext, so prompt-submit (which imports
// runLaneContext) gets the same result as before.
async function main(): Promise<void> {
  const raw = await readStdin();
  // Under cursor-agent (the review engine): no text, no lease UPDATE, no watermark write (seat
  // ruling, Tier B). SessionStart and PostToolUse text can reach the review model.
  let payload: unknown = null;
  try { payload = JSON.parse(raw); } catch { /* invalid: runLaneContext answers {} */ }
  if (isEngineHost(payload)) { process.stdout.write('{}'); return; }
  const out = await runLaneContext(raw);
  if (out !== null) process.stdout.write(JSON.stringify(out));
}

// ---------------------------------------------------------------- banner paging
// A page shows at most MAX_EVENTS events. What is cut stays above the cursors, so a later prompt shows it.

/** UNREAD_SQL plus this board's cursor row. board_wm NULL = no row = a first look (one snapshot, no second query). */
const UNREAD_BOARD_SQL = `SELECT e.*, (SELECT last_event_id FROM agentic_os.lane_watermark WHERE session_id = $3::text) AS board_wm
  FROM agentic_os.lane_event e WHERE ${UNREAD_SQL} ORDER BY e.id`;

/** The byte rule of a page (C5). `space` is the event space: the budget less the header and the fixed page lines. */
export interface PageBytes<T> {
  space: number;
  /** The start of an event line, up to and including ": ". */
  prefix: (e: T) => string;
  body: (e: T) => string;
}

export interface PageOpts<T = never> {
  /** The board has no cursor row yet. Only the newest `max` broadcasts count, the older ones are skipped. */
  cold: boolean;
  /** A session with no board: DMs only, no board row. */
  noBoard?: boolean;
  max?: number;
  /** No byte rule: the count rule only. */
  bytes?: PageBytes<T>;
}

export interface UnreadPage<T> {
  /** The events to print, in the order the rows came in (id order). */
  events: T[];
  /** Unread events that are not on this page and not skipped. */
  cut: number;
  cutDm: number;
  /** Older broadcasts a cold start leaves out. Not counted in `cut`. */
  skipped: number;
  /** The board row to write, or null for no write. */
  boardRow: number | null;
  /** The `<id>@` row to write, or null for no write. */
  sentinel: number | null;
  /** With a byte rule: the body to print for each event on the page, whole or cut with the marker. */
  bodies?: Map<number, string>;
}

/** pg returns bigint as a string. Convert here, once, and never sort again: the SQL order is the id order. */
async function readUnread(client: Client, sql: string, params: unknown[]): Promise<EventRow[]> {
  const rows = (await client.query<EventRow>(sql, params)).rows;
  return rows.map((r) => ({ ...r, id: Number(r.id), board_wm: r.board_wm == null ? null : Number(r.board_wm) }));
}

/**
 * The page rule. DMs first, oldest first, up to `max`. Then the oldest broadcasts fill the free places.
 * While a DM is cut, no broadcast is shown. Input is in id order and so is the page. No I/O.
 *
 * The board row never passes a cut event: it is one below the lowest event that is not shown. A cold start
 * counts the skipped older broadcasts as shown, so they do not hold the row back.
 *
 * With `opts.bytes` the page also fits the event space (C5). DMs are whole and a prefix in id order: the first one
 * that does not fit waits, with every later one (C5a). When the oldest DM alone does not fit, it shows alone, cut
 * (C5b). Board events share what the DMs leave (C5c). An event that waits counts in `cut`, so no cursor passes it.
 */
export function pageUnread<T extends { id: number; to_session_id: string | null }>(
  unread: T[], opts: PageOpts<T>,
): UnreadPage<T> {
  const max = opts.max ?? MAX_EVENTS;
  const dms = unread.filter((e) => e.to_session_id);
  const bcs = unread.filter((e) => !e.to_session_id);
  const skipped = opts.cold && !opts.noBoard ? Math.max(0, bcs.length - max) : 0;
  const live = bcs.slice(skipped);
  const bytes = opts.bytes ? memoPrefix(opts.bytes) : undefined;
  const bodies = new Map<number, string>();
  const dmPick = pickDms(dms.slice(0, max), bytes, bodies);
  const shownDms = dmPick.shown;
  const cutDms = dms.slice(shownDms.length);
  const shownBcs = cutDms.length || dmPick.alone ? []
    : pickBoardEvents(live.slice(0, max - shownDms.length), bytes, dmPick.left, bodies);
  const cutBcs = live.slice(shownBcs.length);
  const onPage = new Set<T>([...shownDms, ...shownBcs]);
  const rows = cursorRows(unread, shownDms, [cutDms[0], cutBcs[0]], opts);
  return {
    events: unread.filter((e) => onPage.has(e)),
    cut: cutDms.length + cutBcs.length, cutDm: cutDms.length, skipped, ...rows,
    ...(bytes ? { bodies } : {}),
  };
}

/** The prefix of an event line once per event: it reads an identity file. */
function memoPrefix<T extends { id: number }>(b: PageBytes<T>): PageBytes<T> {
  const seen = new Map<number, string>();
  const prefix = (e: T): string => {
    let p = seen.get(e.id);
    if (p === undefined) { p = b.prefix(e); seen.set(e.id, p); }
    return p;
  };
  return { ...b, prefix };
}

/** C5a and C5b. `left` is the event space that the DMs leave for board events. */
function pickDms<T extends { id: number }>(
  dms: T[], b: PageBytes<T> | undefined, bodies: Map<number, string>,
): { shown: T[]; left: number; alone: boolean } {
  if (!b) return { shown: dms, left: 0, alone: false };
  const shown: T[] = [];
  let left = b.space;
  for (const e of dms) {
    const cost = lineBytes(b.prefix(e) + b.body(e));
    if (cost > left) break;
    left -= cost; shown.push(e); bodies.set(e.id, b.body(e));
  }
  if (shown.length || !dms.length) return { shown, left, alone: false };
  const e = dms[0];
  bodies.set(e.id, cutBody(b.body(e), b.space - lineBytes(b.prefix(e)), e.id));
  return { shown: [e], left: 0, alone: true };
}

/**
 * C5c. The oldest board events whose bodies share `room` bytes, each body at least MIN_BODY_BYTES plus its marker.
 * When the minimum does not fit, the newest is removed and the share runs again. No byte rule: all of them.
 */
function pickBoardEvents<T extends { id: number }>(
  cands: T[], b: PageBytes<T> | undefined, room: number, bodies: Map<number, string>,
): T[] {
  if (!b) return cands;
  for (let n = cands.length; n > 0; n -= 1) {
    const take = cands.slice(0, n);
    const sizes = take.map((e) => utf8Bytes(b.body(e)));
    const pool = room - take.reduce((s, e) => s + lineBytes(b.prefix(e)), 0);
    const marker = Math.max(...take.map((e, i) => utf8Bytes(cutMarker(sizes[i], e.id))));
    const shares = shareBytes(sizes, pool, MIN_BODY_BYTES + marker);
    if (!shares) continue;
    take.forEach((e, i) => bodies.set(e.id, cutBody(b.body(e), shares[i], e.id)));
    return take;
  }
  return [];
}

/** The two cursor values for a page. `firstCut` holds the first cut DM and the first cut broadcast, if any. */
function cursorRows<T extends { id: number }>(
  unread: T[], shownDms: T[], firstCut: Array<T | undefined>, opts: PageOpts,
): { boardRow: number | null; sentinel: number | null } {
  const lastDm = shownDms.length ? shownDms[shownDms.length - 1].id : null;
  const cutIds = firstCut.filter((e): e is T => e !== undefined).map((e) => e.id);
  if (opts.noBoard) return { boardRow: null, sentinel: lastDm };
  // A cold start with a cut DM writes no board row: a row there would bring the skipped history back, page by page.
  if (opts.cold && firstCut[0]) return { boardRow: null, sentinel: lastDm };
  if (!unread.length) return { boardRow: null, sentinel: null };
  const boardRow = cutIds.length ? Math.min(...cutIds) - 1 : unread[unread.length - 1].id;
  return { boardRow, sentinel: lastDm !== null && lastDm > boardRow ? lastDm : null };
}

/** The cursor rows to write for a page: the board row (never on the no-board path), then the `<id>@` sentinel. */
function cursorWrites(me: string, board: string | null, page: UnreadPage<unknown>): Array<[string, number]> {
  const rows: Array<[string, number]> = [];
  if (board !== null && page.boardRow !== null) rows.push([wmKey(me, board), page.boardRow]);
  if (page.sentinel !== null) rows.push([wmKey(me, ''), page.sentinel]);
  return rows;
}

/**
 * Move my cursors in ONE statement, awaited. Called only for events that were actually injected.
 * GREATEST: another writer (inbox) may have moved a row further since this hook read it. Never move back.
 */
async function writeCursors(client: Client, rows: Array<[string, number]>): Promise<void> {
  if (!rows.length) return;
  const values = rows.map((_, i) => `($${2 * i + 1},$${2 * i + 2},now())`).join(', ');
  await client.query(
    `INSERT INTO agentic_os.lane_watermark AS w (session_id, last_event_id, updated_at)
     VALUES ${values}
     ON CONFLICT (session_id) DO UPDATE
       SET last_event_id = GREATEST(w.last_event_id, EXCLUDED.last_event_id), updated_at = now()`,
    rows.flat(),
  );
}

/**
 * C10: write the cursor rows of a page, or skip the write when the hook is late. A skip that had rows to write
 * leaves one throttled line in the error log, so a late hook is findable. No rows: no write and no line.
 * B1: a write that throws leaves one such line too and returns normally, so the caller still sends the page.
 */
async function finishCursors(
  client: Client, ctx: PageCtx, o: { me: string; eventName: string; rows: Array<[string, number]>; late: boolean },
): Promise<void> {
  if (!o.rows.length) return;
  if (!o.late) {
    // B1: a failed write (the client timer can fire while the upsert still commits) must not drop the page.
    // The page goes out; at worst a message shows twice. Never a message marked read and not shown.
    try { await writeCursors(client, o.rows); } catch (err) { logLaneContextError(o.me, o.eventName, err); }
    return;
  }
  logLaneContextError(o.me, o.eventName, new Error(`late ${ctx.age().toFixed(2)}s: cursor write skipped`));
}

/**
 * The "(N more unread ...)" line. The cut events stay unread, so a later prompt shows them, oldest first.
 * `withCmd` adds the inbox command. It is true only when the board has a cursor row: `inbox` with no row
 * prints every broadcast since event 1, and with no board it cannot run at all.
 *
 * `coldBoard`: a board page with no cursor row. When it cuts a DM and a board event, the cut board events
 * come back only while they are among the newest MAX_EVENTS of the board (the cold start skips the rest).
 */
function moreLine(page: Pick<UnreadPage<unknown>, 'cut' | 'cutDm'>, withCmd: boolean, coldBoard: boolean, onBoard = true): string {
  // G2 (card coord-banner-dm-never-cut): on a board, a waiting DM is always one command away, with or without a cursor row.
  // A session with no board (`onBoard` false) has no inbox to read: that line stays as it was.
  const inbox = `${laneCliCmd()} inbox`;
  if (coldBoard && page.cutDm > 0 && page.cut > page.cutDm) {
    return `  (${page.cut} more unread, ${page.cutDm} direct to you. Later prompts show the direct ones, oldest first, or run: ${inbox}. `
      + `The board events show only while they are among the newest ${MAX_EVENTS} of this board.)`;
  }
  const direct = page.cutDm > 0 ? `, ${page.cutDm} direct to you` : '';
  const cmd = withCmd || (onBoard && page.cutDm > 0) ? `, or run: ${inbox}` : '.';
  return `  (${page.cut} more unread${direct}. Later prompts show them, oldest first${cmd})`;
}

interface UnreadLineOpts {
  /** The board already has a cursor row (see moreLine). */
  withCmd: boolean;
  /** A board page with no cursor row yet. Always false on the no-board path. */
  coldBoard: boolean;
}

/**
 * The "lane update(s)" lines. `board` null = a session with no board: a DM from a non-default board is tagged.
 * A page that shows a direct message ends with REPLY_FOOTER.
 */
function unreadLines(page: UnreadPage<EventRow>, board: string | null, opts: UnreadLineOpts): string[] {
  const here = board ?? DEFAULT_BOARD;
  const lines = [countLine(page.events.length + page.cut)];
  for (const e of page.events) lines.push(eventPrefix(e, here) + (page.bodies?.get(e.id) ?? e.body ?? ''));
  if (page.cut > 0) lines.push(moreLine(page, opts.withCmd, opts.coldBoard, board !== null));
  // The cold line prints once: on the page that writes the board row. A page that writes only the sentinel stays cold.
  if (page.skipped > 0 && page.boardRow !== null) lines.push(coldLine(page.skipped));
  if (page.events.some((e) => e.to_session_id)) lines.push(REPLY_FOOTER);
  return lines;
}

const countLine = (n: number): string => `## ${n} lane update(s) since you last looked`;
const coldLine = (n: number): string => `  (${n} older board events are not shown on your first look at this board.)`;

/** The start of an event line, up to and including ": ". `here` is the board of the page. */
function eventPrefix(e: EventRow, here: string): string {
  const dm = e.to_session_id ? ' (direct to you)' : '';
  const crossed = e.to_session_id && e.project_key && e.project_key !== here ? fromTag(e.project_key) : '';
  const lane = laneTag(e.lane_id);
  return `- ${who(e.session_id)}${crossed} ${kindText(e.kind)}${lane}${dm}: `;
}

/**
 * C5: bytes of the fixed page lines at their longest (the count line, the longest "more unread" line, the cold line,
 * the reply footer), each with its newline. The event space is the budget less this and less the header.
 */
function pageReserve(unread: EventRow[]): number {
  const shape = { cut: unread.length, cutDm: unread.filter((e) => e.to_session_id).length };
  const more = Math.max(lineBytes(moreLine(shape, true, false)), lineBytes(moreLine(shape, false, true)));
  return more + [countLine(unread.length), coldLine(unread.length), REPLY_FOOTER].reduce((n, l) => n + lineBytes(l), 0);
}

/** The byte rule of a board or no-board page. */
function eventBytes(space: number, board: string | null): PageBytes<EventRow> {
  const here = board ?? DEFAULT_BOARD;
  return { space, prefix: (e) => eventPrefix(e, here), body: (e) => e.body || '' };
}

const oldestDmId = (unread: EventRow[]): number | null => unread.find((e) => e.to_session_id)?.id ?? null;

/**
 * An interactive session whose cwd has no board (T7: started in the home folder) still gets its direct messages.
 * DMs are keyed by session id, not board. Nothing else: no banner, no broadcasts, no peers.
 *
 * The cursor moves on a SENTINEL row, `<id>@` (empty board). The bare `<id>` row is continuous-claude's BROADCAST
 * cursor: moving it to a DM id would hide every CCv3 broadcast with a lower id after a later cd into CCv3. The
 * sentinel is read by the same MAX over `session_id = <id> OR starts_with(session_id, <id> || '@')`, so the DM is
 * not shown again on any board, and no board key is empty, so no board cursor is ever this row.
 */
async function directMessagesOnly(client: Client, me: string, eventName: string, ctx: PageCtx): Promise<object> {
  const dms = await readUnread(client, `SELECT e.* FROM agentic_os.lane_event e WHERE ${DM_ONLY_SQL} ORDER BY e.id`, [me]);
  if (!dms.length) return {};
  const late = ctx.late();
  const budget = ctx.budgets.noBoard;
  // The sentinel moves to the newest DM shown. A DM that waits stays above it for the next prompt.
  const page = pageUnread(dms, { cold: false, noBoard: true, bytes: eventBytes(budget - pageReserve(dms), null) });
  const text = unreadLines(page, null, { withCmd: false, coldBoard: false }).join('\n');
  // C2: built and measured first. Over its budget: the fallback, and no cursor moves.
  if (utf8Bytes(text) > budget) return buildOutput(noBoardFallback(dms[0].id), eventName);
  await finishCursors(client, ctx, { me, eventName, rows: cursorWrites(me, null, page), late });
  return buildOutput(text, eventName);
}

/**
 * The lane ids a scope names after its LAST "RELATES TO:". Split on commas and white space, one trailing
 * full stop stripped, only [A-Za-z0-9._-] ids kept, no repeats, order of first use. No marker gives []. No I/O.
 */
export function parseRelatesTo(scope: string | null | undefined): string[] {
  if (!scope) return [];
  const at = scope.lastIndexOf(RELATES_TO);
  if (at < 0) return [];
  const ids = scope.slice(at + RELATES_TO.length).split(/[\s,]+/)
    .map((t) => t.replace(/\.$/, ''))
    .filter((t) => /^[A-Za-z0-9._-]+$/.test(t));
  return [...new Set(ids)];
}

/**
 * The "Related:" line for the lanes I hold on this board (`held`), or null when their scopes name no other lane.
 * `own` is every lane I hold on any board: lane ids are global, so none of them is a peer to DM.
 * One lookup for the ids shown. The caller catches a failure: the line drops, the banner stays.
 */
async function relatedLine(client: Client, held: LaneRow[], own: LaneRow[]): Promise<string | null> {
  const mine = new Set(own.map((l) => l.id));
  const ids = [...new Set(held.flatMap((l) => parseRelatesTo(l.scope)))].filter((id) => !mine.has(id));
  // An id over 64 bytes is not printed and counts in "+N more" (C4). The line is never cut: when no id is left
  // to print, it is the count alone, and no lookup runs.
  if (!ids.length) return null;
  const shown = ids.filter(fitsId).slice(0, RELATED_MAX);
  if (!shown.length) return `Related: +${ids.length} more`;
  // `reclaimable` is the reclaim test of lane.mjs (rule L2.8): the lease ended AND the holder is quiet. Such a lane
  // gets no DM (M4.12), so the line must not name its old holder as a peer to message.
  const rows = (await client.query<{ id: string; owner_session_id: string | null; reclaimable: boolean | null }>(
    `SELECT id, owner_session_id,
            ${RECLAIMABLE_SQL} AS reclaimable
       FROM agentic_os.lane WHERE id = ANY($1::text[])`,
    [shown],
  )).rows;
  const found = new Map(rows.map((r) => [r.id, r]));
  const tag = (id: string): string => {
    const row = found.get(id);
    if (!row) return 'no such lane';
    if (!row.owner_session_id) return 'no holder';
    return row.reclaimable ? 'reclaimable' : who(row.owner_session_id);
  };
  const more = ids.length > shown.length ? `, +${ids.length - shown.length} more` : '';
  return `Related: ${shown.map((id) => `${id} (${tag(id)})`).join(', ')}${more}`;
}

// ---------------------------------------------------------------- SessionStart banner (C4)

interface PeerRow { sid: string; lanes: string | null; scopes: string | null; total: string | number }

/** What the SessionStart banner shows, read from the database. Each optional part fails alone (its own try/catch). */
interface Banner {
  here: LaneRow[];
  elsewhere: LaneRow[];
  peers: PeerRow[];
  claimable: LaneRow[];
  related: string | null;
  reminderLines: string[];
  /** The label of the session that holds the master card, or null (M4.17). */
  seat: string | null;
}

/** The master card: the lane that stands for a program (CONTEXT.md). Its holder is the coordinator seat. */
const MASTER_CARD_ID = 're-program';
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

/** A part of the banner and the one line it becomes when the header is over its budget (C4). */
interface Section { full: string[]; short: string[] }

/** The banner reads, in the order of today: my lanes, peers, claimable, the Related lookup, reminders. */
async function loadBanner(client: Client, me: string, board: string, eventName: string): Promise<Banner> {
  // Every lane I own, on any board: the banner shows this board's and summarises the rest.
  const mine = (await client.query<LaneRow>(
    `SELECT * FROM agentic_os.lane l WHERE owner_session_id=$1 AND state<>'done' ORDER BY ${laneOrderSql('l')}`,
    [me],
  )).rows;
  const here = mine.filter((l) => (l.project_key ?? DEFAULT_BOARD) === board);
  const elsewhere = mine.filter((l) => (l.project_key ?? DEFAULT_BOARD) !== board);

  // Peers on THIS board that are alive. A peer with no lane is listed too ("holds no lane"):
  // the reader needs its label to address it, and the LEFT JOIN keeps it.
  //
  // A peer of the board = its folder is under a board root, or it owns a lane on the board (T7: a
  // session started in the home dir). starts_with, never LIKE: paths hold underscores.
  //
  // "Alive" is GREATEST(last_heartbeat, last_activity_at), never the heartbeat
  // alone: heartbeat.ts fires on UserPromptSubmit only, so a peer that has been
  // editing continuously for 25 minutes without its human typing reads as dead
  // and is silently DROPPED from this warning -- the one place the collision
  // was supposed to surface. GREATEST returns NULL only when both are NULL, so
  // pre-writer rows degrade to the old behaviour rather than to "never alive".
  //
  // Sessions that hold a lane come first, then the newest heartbeat. LIMIT keeps the
  // banner short on a busy day; `total` (a window count, taken before the LIMIT) lets
  // the banner say how many were cut.
  const peers = (await client.query<PeerRow>(
    `SELECT s.id AS sid,
            string_agg(l.id, ', ' ORDER BY l.id)              AS lanes,
            string_agg(COALESCE(l.scope,''), ' | ')           AS scopes,
            count(*) OVER ()                                  AS total
     FROM sessions s
     LEFT JOIN agentic_os.lane l ON l.owner_session_id = s.id AND l.state <> 'done' AND l.project_key = $3::text
     WHERE GREATEST(s.last_heartbeat, s.last_activity_at) > now() - interval '${STALE_MINUTES} minutes'
       AND s.id <> $1
       AND ${peerOfBoardSql('$2', '$3')}
     GROUP BY s.id
     ORDER BY (count(l.id) > 0) DESC,
              max(GREATEST(s.last_heartbeat, s.last_activity_at)) DESC NULLS LAST,
              s.id
     LIMIT ${MAX_PEERS}`,
    [me, boardRoots(board), board],
  )).rows;

  // Own try/catch: a missing lane_dep table (or any error here) drops the claimable block and logs it, never the banner.
  // openDepSql keeps a lane with an open dependency off the list; owner_session_id IS NULL stays (it offers fewer lanes than `next`).
  let claimable: LaneRow[] = [];
  try {
    claimable = (await client.query<LaneRow>(
      `SELECT * FROM agentic_os.lane l
       WHERE project_key = $1 AND state IN ('ready','backlog') AND owner_session_id IS NULL
         AND ${CLAIMABLE_NOT_REMINDER}
         AND NOT ${openDepSql('l')}
       ORDER BY ${laneOrderSql('l')} LIMIT 5`,
      [board],
    )).rows;
  } catch (err) { logLaneContextError(me, eventName, err); }

  // Own try/catch, like the reminders block: a failing lookup drops the Related line, never the banner.
  let related: string | null = null;
  if (here.length) {
    try { related = await relatedLine(client, here, mine); } catch (err) { logLaneContextError(me, eventName, err); }
  }
  // Own try/catch: a failing reminders query (or a formatter bug) drops this block and logs it, never the banner.
  let reminderLines: string[] = [];
  try {
    reminderLines = formatReminderLines((await client.query<ReminderRow>(REMINDERS_SQL, [board])).rows, new Date());
  } catch (err) { logLaneContextError(me, eventName, err); }
  // Own try/catch: a failing lookup drops the SEAT line, never the banner. No holder, no line (M4.17).
  let seat: string | null = null;
  try {
    // This board's master card only (a NULL project_key is the default board). A holder who is reclaimable gets no DM
    // (M4.12), so he is not the seat either.
    const row = (await client.query<{ owner_session_id: string | null; reclaimable: boolean | null }>(
      `SELECT owner_session_id, ${RECLAIMABLE_SQL} AS reclaimable
         FROM agentic_os.lane
        WHERE id = $1 AND COALESCE(project_key, $3::text) = $2::text AND state <> 'done'`,
      [MASTER_CARD_ID, board, DEFAULT_BOARD],
    )).rows[0];
    // A name is read from a file. Control characters (0x00-0x1f, 0x7f) could break the line or paint the terminal.
    if (row?.owner_session_id && !row.reclaimable) seat = who(row.owner_session_id).replace(CONTROL_CHARS, '');
  } catch (err) { logLaneContextError(me, eventName, err); }
  return { here, elsewhere, peers, claimable, related, reminderLines, seat };
}

/**
 * The banner header, at most `budgets.header` bytes (C4). The lines that are never cut come first. Peer scopes
 * share `budgets.scopes`. When the header is still over its budget, whole sections become one line each, in this
 * order: peer scopes, Claimable, Reminders.
 */
function buildHeader(b: Banner, meLabel: string, board: string, budgets: Budgets, cutLine: string | null = null): string[] {
  const cmd = laneCliCmd();
  const top = topLines(b, meLabel, board, cmd, cutLine);
  const order = [peerSection(b.peers, budgets.scopes, cmd), claimSection(b.claimable, cmd), reminderSection(b.reminderLines, cmd)];
  let lines: string[] = [];
  for (let n = 0; n <= order.length; n += 1) {
    const [peers, claim, rem] = order.map((s, i) => (i < n ? s.short : s.full));
    lines = [...top, '', ...peers];
    if (rem.length) lines.push('', ...rem);
    if (claim.length) lines.push('', ...claim);
    lines.push('', `Commands: ${cmd} board | claim <id> | note <id> "..." | say "..." | done <id> [--merged <sha>] | remind list|set|snooze|ack`);
    lines.push('Serialize commits — same branch, two committers race .git/index.lock.');
    if (utf8Bytes(lines.join('\n')) <= budgets.header) break;
  }
  return lines;
}

/** The lines that are never cut: SEAT, CUT NOT READ, heading, "You are", "You hold" or the three no-lane lines, Milestone, Related. */
function topLines(b: Banner, meLabel: string, board: string, cmd: string, cutLine: string | null): string[] {
  const lines = [boardHeading(board), `You are ${meLabel}.`, ''];
  if (cutLine) lines.unshift(cutLine);
  // The label is at most 16 name characters plus " #sid8", so the line stays near 64 bytes (M4.17: about 60).
  if (b.seat) lines.unshift(`SEAT: ${b.seat}`);
  if (b.here.length) {
    const held = idList(b.here, (l) => l.id, (l) => `${bandTag(l.band)} ${l.id}`, HOLD_MAX, (n) => `+${n} more: ${cmd} mine`);
    lines.push(`You hold: ${held}`);
    lines.push('Milestone (start, commit, decision by Dave, finding, block, done): send one DM to each holder in your RELATES TO list (M4.11).');
    if (b.related) lines.push(b.related);
  } else {
    lines.push(`You hold no lane. 1. kanban-sync when the board has a phone page. 2. ${cmd} mine. 3. ${cmd} board --by priority, then claim the lane for your work by id.`);
    lines.push(`No lane for it: ${cmd} add <new-id> --title "..." --scope "..." only when ${cmd} board --all shows the id in no state, then claim it. Never run add on an existing lane that you do not hold.`);
    lines.push('Rules: lane-board.md. Rule ids: docs/coordination/standard.md.');
  }
  if (b.elsewhere.length) {
    const shown = b.elsewhere.filter((l) => fitsId(l.id)).slice(0, 5).map((l) => `${l.id}@${l.project_key}`);
    // C4: the ids not shown (past 5, or over 64 bytes) count in "+N more".
    const hidden = b.elsewhere.length - shown.length;
    const rest = hidden > 0 ? (shown.length ? `, +${hidden} more: ${cmd} mine` : `${cmd} mine`) : '';
    lines.push(`+${b.elsewhere.length} on other boards: ${shown.join(', ')}${rest}`);
  }
  return lines;
}

/** Peer lines: 3 lane ids each, then "+N". The scope texts share `pool` bytes; a cut one ends with the scope marker. */
function peerSection(peers: PeerRow[], pool: number, cmd: string): Section {
  if (!peers.length) return { full: ['No other live session.'], short: ['No other live session.'] };
  const head = 'Other live sessions and their scope — do not edit inside these:';
  const scopes = peers.map((p) => (p.scopes || '').split('|').map((s) => s.trim()).filter(Boolean).join(' | '));
  const shares = shareBytes(scopes.map(utf8Bytes), pool) ?? scopes.map(() => 0);
  const full = [head];
  const short = [head];
  peers.forEach((p, i) => {
    const lanes = p.lanes ? `holds ${idList(p.lanes.split(', '), (x) => x, (x) => x, PEER_LANES_MAX, (n) => `+${n}`)}` : 'holds no lane';
    full.push(`  ${who(p.sid)} ${lanes}`);
    short.push(`  ${who(p.sid)} ${lanes}`);
    if (scopes[i]) full.push(`     scope: ${fitScope(scopes[i], shares[i])}`);
  });
  if (scopes.some(Boolean)) short.push(`     scopes: ${cmd} board`);
  const cut = Number(peers[0].total) - peers.length;
  const more = cut > 0 ? [`  +${cut} more sessions`] : [];
  return { full: [...full, ...more], short: [...short, ...more] };
}

function fitScope(scope: string, share: number): string {
  if (utf8Bytes(scope) <= share) return scope;
  const marker = scopeCutMarker();
  return cutToBytes(scope, share - utf8Bytes(marker)) + marker;
}

/** Claimable rows: an id over 64 bytes is not printed and counts in "+N more"; titles are clipped to 100 bytes. */
function claimSection(rows: LaneRow[], cmd: string): Section {
  if (!rows.length) return { full: [], short: [] };
  const shown = rows.filter((l) => fitsId(l.id));
  const full = ['Claimable (claim by id):',
    ...shown.map((l) => `  ${bandTag(l.band)} ${l.id.padEnd(28)} ${cutToBytes(l.title || '', TITLE_MAX_BYTES)}`)];
  if (rows.length > shown.length) full.push(`  +${rows.length - shown.length} more: ${cmd} next`);
  return { full, short: [`Claimable (claim by id): ${cmd} next`] };
}

/** The reminder block, or its heading with the command when the header is over its budget. */
function reminderSection(lines: string[], cmd: string): Section {
  return { full: lines, short: lines.length ? [`${lines[0]}: ${cmd} remind list`] : [] };
}

interface BoardPageArgs {
  me: string; meLabel: string; board: string; eventName: string;
  unread: EventRow[];
  /** The SessionStart header, or [] on the prompt path. */
  header: string[];
  /**
   * The same header with every optional section (peers, Claimable, Reminders) at its one-line form. Set on SessionStart when a
   * DM waits (card coord-banner-dm-never-cut): the page uses it only when it shows strictly more whole DMs than `header` does.
   */
  collapsedHeader?: string[];
  /** The CUT, NOT READ ids this text may print (the header already holds the line on SessionStart). */
  cut: CutPending;
}

/**
 * The board text: the header (SessionStart only) and the page of unread events, in its budget (C3).
 * C2: the text is built and measured before the write; over its budget the fallback goes out and no cursor moves.
 * C10: the time is read once, after the last read query, so the inbox hint (C9) and the write agree.
 */
async function boardPage(client: Client, a: BoardPageArgs, ctx: PageCtx): Promise<object> {
  const { me, board, unread, header } = a;
  const late = ctx.late();
  const budget = header.length ? ctx.budgets.start : ctx.budgets.prompt;
  const cold = unread.length > 0 && unread[0].board_wm === null;
  // The prompt path has no header: it leads with the CUT line when the page has text, so a prompt with no news stays silent.
  const lead1 = header.length ? header : (a.cut.line && unread.length ? [a.cut.line] : []);
  const pageFor = (lead: string[]): UnreadPage<EventRow> =>
    pageUnread(unread, { cold, bytes: eventBytes(budget - (lead.length ? utf8Bytes(lead.join('\n')) + 2 : 0) - pageReserve(unread), board) });
  let lead = lead1;
  let page = pageFor(lead1);
  // G1 (card coord-banner-dm-never-cut): DMs come before the optional header sections. When DMs wait behind the full header, page once more
  // with those sections at one line each. Both pages are pure: nothing is written or counted until the text below is chosen. The collapsed
  // page wins only when it shows strictly more whole DMs; with the same count the full header stays.
  const shownDms = (p: UnreadPage<EventRow>): number => p.events.filter((e) => e.to_session_id).length;
  if (header.length && a.collapsedHeader && page.cutDm > 0) {
    const page2 = pageFor(a.collapsedHeader);
    if (shownDms(page2) > shownDms(page)) { lead = a.collapsedHeader; page = page2; }
  }
  const withCmd = namesInbox({ rowBefore: !cold, rowWritten: !late && page.boardRow !== null });
  const lines = [...lead];
  if (unread.length) {
    if (lines.length) lines.push('');
    lines.push(...unreadLines(page, board, { withCmd, coldBoard: cold }));
  }
  const text = lines.join('\n');
  if (utf8Bytes(text) > budget) return buildOutput(boardFallback(board, a.meLabel, oldestDmId(unread)), a.eventName);
  // The text goes out: count a print for each id on its line, and keep the ids this page cut. Not on a fallback, and not
  // when the page is late: the text may never arrive, which is why the cursors are not written then either.
  if (!late) recordCuts(me, ctx.now(), a.cut, a.cut.line !== null && lead.includes(a.cut.line), cutOnPage(page));
  // Advance the cursors only for what was actually injected. Nothing was
  // shown on a turn that produced no output, so nothing may be marked read.
  // Events cut from the page stay above the cursors (see pageUnread).
  if (unread.length && lines.length) {
    await finishCursors(client, ctx, { me, eventName: a.eventName, rows: cursorWrites(me, board, page), late });
  }
  return buildOutput(text, a.eventName);
}

/**
 * The job. Takes the raw stdin text so prompt-submit can run it in one process with
 * the other prompt hooks. Returns the object main() prints, or null when the
 * PostToolUse path has already written its own output. Never writes on the
 * SessionStart / UserPromptSubmit path.
 */
export async function runLaneContext(raw: string, opts: RunOpts = {}): Promise<object | null> {
  let payload: { session_id?: string; hook_event_name?: string; session_title?: string; cwd?: string } = {};
  try { payload = JSON.parse(raw); } catch { /* fall through to the guard below */ }

  /**
   * The payload uuid, and nothing else.
   *
   * NOT ~/.claude/.coordination-session-id: that path is global, so with two
   * sessions live every one of them would read the same id and the board would
   * show one session coordinating with itself. That is the precise shape of the
   * identity bug this project spent a session root-causing.
   */
  const me = payload.session_id;
  if (!me) return {};

  const eventName = payload.hook_event_name || 'UserPromptSubmit';
  const isStart = eventName === 'SessionStart';

  if (eventName === 'PostToolUse') { await deliverDirectMessages(me); return null; }

  const url = connString();
  if (!url) return {};

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  // Without a listener, an error on an idle or abandoned client (prompt-submit can
  // walk away from this job at its deadline) is thrown as an uncaught exception.
  client.on('error', () => {});

  try {
    await client.connect();

    // ORDER IS A CONTRACT (tests: lane-context-board.test.ts B1-B4).
    //   1. Tell the migration-0004 trigger this client knows about boards. Session level, so every
    //      statement below carries it. A client that skips this cannot touch a foreign board's lane.
    //   2. Renew my leases keyed on the OWNER, with NO board filter. A board filter would stop
    //      renewing a lane held from another cwd and lapse it after 90 minutes.
    //   3. Only then resolve the board. A headless session has none and returns {} (T6). An interactive session in
    //      an unregistered cwd has none either: it gets its direct messages only (directMessagesOnly).
    //      Both have their leases renewed already.
    await client.query(`SELECT set_config('lane.client_version', '${CLIENT_VERSION}', false)`);

    // Proof of life for my own lanes. Harmless when I hold none. GREATEST keeps a later lease, so a parked
    // lane keeps its park lease (a NULL lease gets now + LEASE_MINUTES).
    await client.query(
      `UPDATE agentic_os.lane
         SET lease_expires_at = GREATEST(lease_expires_at, now() + interval '${LEASE_MINUTES} minutes')
       WHERE owner_session_id = $1 AND state <> 'done'`,
      [me],
    );

    const ctx = pageCtx(opts);
    const board = resolveBoardKey(me, payload.cwd || process.cwd());
    if (!board) return isHeadless() ? {} : await directMessagesOnly(client, me, eventName, ctx);

    // Broadcasts are this board's; direct messages come from any board. See UNREAD_SQL.
    const unread = await readUnread(client, UNREAD_BOARD_SQL, [me, board, wmKey(me, board)]);
    const meLabel = who(me, payload.session_title || undefined);
    const cut = cutPending(me, ctx.now());
    const banner = isStart ? await loadBanner(client, me, board, eventName) : null;
    const header = banner ? buildHeader(banner, meLabel, board, ctx.budgets, cut.line) : [];
    // G1: with a DM waiting, the one-line form of every optional section is the page's second choice (see boardPage).
    const collapsedHeader = banner && unread.some((e) => e.to_session_id)
      ? buildHeader(banner, meLabel, board, { ...ctx.budgets, header: 0 }, cut.line) : undefined;
    return await boardPage(client, { me, meLabel, board, eventName, unread, header, collapsedHeader, cut }, ctx);
  } catch (err) {
    // Nothing on stdout by contract. No database, no tables, no lanes, slow connect — all
    // the same answer: say nothing and let the turn proceed. One throttled line in the
    // error log keeps the failure findable (the old dist failed 42501 with no trace).
    logLaneContextError(me, eventName, err);
    return {};
  } finally {
    // Not awaited. The watermark write above has already committed, and a slow socket
    // close must not hold the return past prompt-submit's deadline: the output would be
    // dropped while the messages stay marked read.
    void client.end().catch(() => {});
  }
}

// Basename check, not `includes`: a directory named like a hook must not start it.
if (/(^|[\\/])lane-context\.(mjs|js|ts)$/.test(process.argv[1] || '')) {
  main().catch(() => process.stdout.write('{}'));
}
