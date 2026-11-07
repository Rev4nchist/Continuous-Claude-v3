/**
 * reminder-tick -- the engine behind `lane.mjs remind tick` (lane reminders, phase 5, part A).
 *
 * lane.mjs runs its commands at the top level, so a test cannot import from it. The tick lives here and takes
 * everything it touches as an argument: the database client, the clock, the state folder, the toast and the sync
 * seam. Design: .claudedocs/2026-11-06-lane-reminders-design.md, "Trigger and run".
 *
 * One tick, in order:
 *   1. Take ~/.claude/state/reminders/tick.lock (stale after 10 minutes). Held and fresh: exit 0, do nothing.
 *   2. Fire. ONE UPDATE is the only fire gate: remind_state 'scheduled' becomes 'due' where the time has passed.
 *      Two ticks cannot fire one reminder twice, because the second UPDATE waits for the row lock and then
 *      finds no 'scheduled' row. The UPDATE sets updated_at too, because the Notion sync keys on updated_at.
 *   3. Write one lane_event per fired row in the SAME transaction. An error rolls the fire back (the reminders
 *      stay 'scheduled' and fire on the next tick). The tick is cross-board: each event carries the fired row's own
 *      project_key, and the session id is the literal 'reminder-tick' (the column is NOT NULL).
 *   4. Toast P0 and P1, best effort. A toast error never changes the result.
 *   5. Count the reminders that still need a Notion sync. The Notion sync is OFF by default. It runs only when the file
 *      <state dir>/sync-enabled exists (`lane.mjs remind sync on` makes it). When it is off, the tick never loads
 *      reminder-sync.mjs, never starts claude and never touches the headless ledger. When it is on and any reminder needs a
 *      sync, or the 2 hour Done-poll is due, the tick hands them to reminder-sync.mjs (one headless claude -p).
 *      The sync keeps its backoff keys in latest.json through `patch`.
 *   6. Write latest.json (the heartbeat, with syncEnabled) and release the lock.
 *
 * This module has no top-level work and imports only node built-ins and reminder-core.mjs, so an idle tick stays fast.
 * logEvent() of lane.mjs is not used: it stamps the default board and swallows an INSERT error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fmtCT, overdueLabel, pollDue } from './reminder-core.mjs';

const LOCK_STALE_MS = 10 * 60_000;
const GUARD_STALE_MS = 2 * 60_000;
const TOAST_MAX = 140;
const TOAST_LIST = 3;
const UNSYNCED_LIMIT = 25;

const FIRE_SQL = `UPDATE agentic_os.lane SET remind_state = 'due', fired_at = now(), updated_at = now()
  WHERE remind_state = 'scheduled' AND due_at <= now() AND state <> 'done'
  RETURNING id, title, project_key, band, due_at, fired_at, action_id,
    (extract(epoch FROM (fired_at - due_at)) / 60)::int AS late_min`;

const WOULD_FIRE_SQL = `SELECT id, title, project_key, band, due_at, action_id,
    (extract(epoch FROM (now() - due_at)) / 60)::int AS late_min
  FROM agentic_os.lane
  WHERE remind_state = 'scheduled' AND due_at <= now() AND state <> 'done'
  ORDER BY band NULLS LAST, due_at, id`;

const EVENT_SQL = `INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body, detail, project_key)
  VALUES ($1, 'reminder', $5, NULL, $2, $3, $4)`;
const TICK_SESSION = 'reminder-tick'; // the session_id column is NOT NULL; no real session fires a tick

// updated_at is read as TEXT: a JS Date keeps milliseconds and timestamptz keeps microseconds, so a Date round trip
// would store a notion_synced_at below updated_at and the row would resync for ever (part B stamps from this text).
const UNSYNCED_SQL = `SELECT id, project_key, title, band, state, due_at, remind_state, fired_at, action_id, scope, rationale,
    done_when, notion_page_id, updated_at::text AS updated_at_txt, count(*) OVER ()::int AS total
  FROM agentic_os.lane
  WHERE (remind_state IS NOT NULL AND (notion_page_id IS NULL OR notion_synced_at IS NULL OR updated_at > notion_synced_at))
     OR (remind_state IS NULL AND notion_page_id IS NOT NULL AND (notion_synced_at IS NULL OR updated_at > notion_synced_at))
  ORDER BY band NULLS LAST, due_at, id
  LIMIT ${UNSYNCED_LIMIT}`;

/** Where the lock and the heartbeat live: CCV3_REMINDER_STATE_DIR, else ~/.claude/state/reminders. */
export const defaultStateDir = (env = process.env) => env.CCV3_REMINDER_STATE_DIR || join(homedir(), '.claude', 'state', 'reminders');

// ---------------------------------------------------------------- sync switch

const SWITCH_FILE = 'sync-enabled';
const SWITCH_USAGE = 'usage: lane.mjs remind sync on|off|status';

/** True when the Notion sync switch is on: the file <state dir>/sync-enabled exists. Default OFF. */
export const isSyncEnabled = (dir) => existsSync(join(dir, SWITCH_FILE));

/** `remind sync on|off|status`. State folder only, no database. Returns the text to print. Any other word throws the usage. */
export function syncSwitch(dir, action) {
  const file = join(dir, SWITCH_FILE);
  if (action === 'on') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, 'on');
  } else if (action === 'off') {
    rmSync(file, { force: true });
  } else if (action !== 'status') {
    throw new Error(SWITCH_USAGE);
  }
  return isSyncEnabled(dir) ? `sync on (${file})` : `sync off (${file} is absent)`;
}

// ---------------------------------------------------------------- lock and heartbeat

/** The time a lock file was written. Its own `ts` field wins (the clock is injectable); a broken file falls back to the file time. */
function lockWrittenAt(file) {
  try {
    const ts = Date.parse(JSON.parse(readFileSync(file, 'utf8')).ts);
    if (!Number.isNaN(ts)) return ts;
  } catch { /* unreadable: use the file time */ }
  try { return statSync(file).mtimeMs; } catch { return null; }
}

function tryCreate(file, now) {
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, ts: now.toISOString() }), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

const isStale = (file, now, staleMs) => {
  const at = lockWrittenAt(file);
  return at !== null && now.getTime() - at > staleMs;
};

/**
 * Replaces a stale lock. Two ticks can both read the same stale time, and a plain remove-then-create would let the
 * second one delete the fresh lock of the first. So the takeover itself takes a guard file (tick.lock.takeover, create-only)
 * and reads the lock AGAIN inside the guard: a lock that is fresh now was replaced by a faster tick, and we stop.
 * A guard over GUARD_STALE_MS old belongs to a dead tick and is replaced (the one window left is two ticks racing on that dead guard).
 * `seam.beforeTakeover` runs between the first stale read and the guard (tests only).
 */
function takeOverStale(file, now, staleMs, seam) {
  if (!isStale(file, now, staleMs)) return false;
  seam.beforeTakeover?.();
  const guard = `${file}.takeover`;
  if (!tryCreate(guard, now)) {
    if (!isStale(guard, now, GUARD_STALE_MS)) return false;
    rmSync(guard, { force: true });
    if (!tryCreate(guard, now)) return false;
  }
  try {
    if (!isStale(file, now, staleMs)) return false;
    rmSync(file, { force: true });
    return tryCreate(file, now);
  } finally {
    rmSync(guard, { force: true });
  }
}

/** { ok: true, release() } or { ok: false }. A lock over `staleMs` old is replaced by exactly one tick; a lost race counts as held. */
export function acquireLock(dir, now, staleMs = LOCK_STALE_MS, seam = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'tick.lock');
  const got = tryCreate(file, now) || takeOverStale(file, now, staleMs, seam);
  if (!got) return { ok: false };
  const release = () => {
    try {
      if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) rmSync(file, { force: true });
    } catch { /* gone or not ours */ }
  };
  return { ok: true, release };
}

/** The last heartbeat, or {} when there is none or it is broken. */
export function readState(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')); } catch { return {}; }
}

/** Atomic write (temp file, then rename), so a reader never sees half a file. */
export function writeState(dir, obj) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `latest.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, join(dir, 'latest.json'));
}

// ---------------------------------------------------------------- toast

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const lateText = (lateMin) => overdueLabel(new Date(0), new Date(Number(lateMin) * 60_000)); // '' up to 60 minutes late

/** { title, message } for the P0 and P1 rows among `fired`, or null when there are none. One toast per tick. */
export function toastText(fired) {
  const rows = fired.filter((r) => r.band === 'P0' || r.band === 'P1')
    .sort((a, b) => (a.band === b.band ? 0 : a.band === 'P0' ? -1 : 1));
  if (!rows.length) return null;
  const items = rows.slice(0, TOAST_LIST).map((r) => clean(`${r.band} ${r.id} ${r.title} ${lateText(r.late_min)}`));
  return { title: `CCv3 reminders: ${rows.length} due`, message: items.join('; ').slice(0, TOAST_MAX) };
}

/** Shows the toast through reminder-toast.ps1. spawnSync + windowsHide: a synchronous child shares the hidden console. */
export function defaultToast(title, message, env = process.env) {
  if (process.platform !== 'win32') return { ok: false, out: 'no toast: not Windows' };
  const script = env.CCV3_REMINDER_TOAST_SCRIPT || join(homedir(), '.claude', 'scripts', 'scheduled', 'reminder-toast.ps1');
  const extra = String(env.CCV3_REMINDER_TOAST_ARGS || '').split(/\s+/).filter(Boolean);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Title', title, '-Message', message, ...extra],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return { ok: r.status === 0 && !r.error, out: String(r.stdout ?? '').trim() };
}

// ---------------------------------------------------------------- fire

function eventParams(r) {
  const late = Number(r.late_min) || 0;
  const label = lateText(late);
  const body = `reminder due ${fmtCT(r.due_at)} ${r.band}${label ? ` ${label}` : ''}`;
  const detail = { op: 'fire', due_at: new Date(r.due_at).toISOString(), pri: r.band, late_min: late, via: 'tick' };
  return [r.id, body, JSON.stringify(detail), r.project_key, TICK_SESSION];
}

/** The fire UPDATE and one event per fired row, in one transaction. Returns the fired rows. Any error rolls back and is thrown. */
export async function fireDue(db) {
  await db.query('BEGIN');
  try {
    const { rows } = await db.query(FIRE_SQL);
    for (const r of rows) await db.query(EVENT_SQL, eventParams(r));
    await db.query('COMMIT');
    return rows;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------- sync seam

/**
 * The Notion sync lives in reminder-sync.mjs and is loaded only when it is needed, so an idle tick stays fast.
 * It gets the unsynced rows (at most 25; each row has `total`, the real count) and { db, now, stateDir, env, state,
 * reclaimable, ...deps.syncDeps }. `state` is the last latest.json. It returns { skipped: true } or { ok, error? },
 * and may add `patch`: latest.json keys to keep (failCount, nextSyncAt, failedLanes, lastDonePollAt).
 */
async function defaultSyncBatch(rows, ctx) {
  return (await import('./reminder-sync.mjs')).syncBatch(rows, ctx);
}

function syncOutcome(res, prev) {
  const patch = res?.patch ?? {};
  if (!res || res.skipped) return { status: 'skipped', lastSyncOk: prev.lastSyncOk ?? null, lastError: prev.lastError ?? null, patch };
  if (res.ok) return { status: 'ok', lastSyncOk: true, lastError: null, patch };
  const error = clean(res.error || 'sync failed').slice(0, 300);
  return { status: 'failed', lastSyncOk: false, lastError: error, patch };
}

async function runSync(deps, rows, prev) {
  // The switch comes first: with the sync off nothing below runs, so no claude and no headless ledger.
  if (!deps.syncEnabled) return { ...syncOutcome({ skipped: true }, prev), status: 'off' };
  // The Done-poll rule is shared with the sync (reminder-core). The sync itself finds out whether any reminder is open.
  if (deps.noSync || !(rows.length || pollDue(prev, deps.now().getTime()))) return syncOutcome({ skipped: true }, prev);
  const ctx = { db: deps.db, now: deps.now, stateDir: deps.stateDir, env: deps.env, state: prev, reclaimable: deps.reclaimable, ...deps.syncDeps };
  try {
    return syncOutcome(await (deps.syncBatch ?? defaultSyncBatch)(rows, ctx), prev);
  } catch (e) {
    return syncOutcome({ ok: false, error: e.message }, prev);
  }
}

// ---------------------------------------------------------------- the tick

function showToast(deps, fired, log) {
  const text = toastText(fired);
  if (!text) return false;
  try {
    const res = (deps.toast ?? defaultToast)(text.title, text.message);
    if (res?.out) log(res.out);
    return res?.ok !== false;
  } catch (e) {
    log(`toast failed: ${clean(e.message)}`);
    return false;
  }
}

async function dryRunTick(db, log) {
  const { rows } = await db.query(WOULD_FIRE_SQL);
  log(`tick (dry run): would fire ${rows.length}`);
  for (const r of rows) log(`  ${r.band ?? '--'} ${r.project_key}/${r.id} due ${fmtCT(r.due_at)} ${lateText(r.late_min)}`.trimEnd());
  return { dryRun: true, fired: rows };
}

/**
 * One tick. deps: { db, now, stateDir, toast, syncBatch, syncDeps, reclaimable, dryRun, noSync, log, env }. Everything is injectable.
 * Returns { locked } or { fired, toasted, sync: { status, error? }, state }. sync.status is 'off' while the switch is off. An error from the database is thrown.
 */
export async function runTick(deps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console.log;
  const env = deps.env ?? process.env;
  if (deps.dryRun) return dryRunTick(deps.db, log);
  const stateDir = deps.stateDir ?? defaultStateDir(env);
  const lock = acquireLock(stateDir, now());
  if (!lock.ok) { log('tick: locked, skipped'); return { locked: true, fired: [] }; }
  try {
    const fired = await fireDue(deps.db);
    const toasted = showToast(deps, fired, log);
    const rows = (await deps.db.query(UNSYNCED_SQL)).rows;
    const unsynced = rows[0]?.total ?? 0;
    const prev = readState(stateDir);
    const syncEnabled = isSyncEnabled(stateDir);
    const sync = await runSync({ ...deps, now, stateDir, env, syncEnabled }, rows, prev);
    const state = { ...prev, ...sync.patch, ranAt: now().toISOString(), fired: fired.length, unsynced, syncEnabled, lastSyncOk: sync.lastSyncOk, lastError: sync.lastError };
    writeState(stateDir, state);
    log(`tick: fired ${fired.length}, unsynced ${unsynced}, sync ${sync.status}${sync.status === 'failed' ? `: ${sync.lastError}` : ''}`);
    return { fired, toasted, sync: { status: sync.status, error: sync.lastError ?? undefined }, state };
  } finally {
    lock.release();
  }
}
