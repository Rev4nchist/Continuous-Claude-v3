#!/usr/bin/env node
/**
 * Lane Board Stop Gate Hook
 *
 * lane-board-republish-reminder.ts writes a pending file per (session, board) when a session changes the lane
 * DB. Only the agent's Artifact tool can publish a board page, and a reminder alone did not make sessions do it
 * (the phone board went stale on 2026-11-04). This hook blocks the end of a turn ONCE per batch of lane
 * changes until the board is published. The account allows 200 Artifact publishes per UTC day for all sessions
 * together, so the gate asks only when a publish is due (publish budget, below).
 *
 * Hook: Stop (settings.json.template). No matcher.
 * State: <pending dir>/<sid>.json (default board) and <sid>@<board>.json, written by the reminder hook:
 *   {since, verbs, board, askAt?, v?}. `askAt` is the time (ms) of the last ask verb. A file without it uses its mtime.
 *   `v: 2` marks a file that the new reminder made.
 *   The reminder deletes a file when that board's page is published.
 *   This hook adds {stopBlocked: true} after it blocks, so a second Stop in the same batch passes.
 *   A new ask verb rewrites the file without that flag, which starts a new batch. Any other verb keeps the flag.
 *   Files older than 24 h are deleted on every Stop. The sweep skips the `budget` folder (no `.json` end).
 *
 * Publish budget. One file per session: <pending dir>/budget/<session uuid>.json
 *   {day, n, limit, pages: {<artifact id>: ms}, asked: {<artifact id>: ms}}
 *   day    UTC date. A new day restarts n and limit.
 *   n      accepted Artifact PAGE publishes of the session in that day, any url (the reminder hook counts them).
 *          An asset upload adds nothing: on 2026-11-11 the server limit tripped at 200 page publishes.
 *   limit  read here; no writer exists yet (a refused publish gives no PostToolUse event).
 *   pages  last accepted publish of a board page by the session (reminder hook). Kept across days.
 *   asked  last ask by this gate for a page. Kept across days.
 *   The write takes <file>.lock (flag `wx`, at most 200 ms wait, a lock older than 5 s is stale), then goes
 *   through <file>.<pid>.tmp and a rename. The rename is tried again up to 3 times on EPERM, EBUSY or EACCES:
 *   on Windows it fails while a reader has the file open. A write that does not win the lock, or whose rename
 *   keeps failing, returns false: the gate then approves, and the reminder loses that one count.
 *   A reader takes no lock. It skips a name that does not end in `.json`, a file over 65536 bytes, a file that
 *   does not parse, and any bad value (n not an integer >= 0, a stamp that is not a finite number or is more
 *   than 60 s later than now). The 60 s cover two hook processes that read their clocks a few ms apart; the
 *   same tolerance keeps the day and the count of a file that another process moved to the new UTC day.
 *   A file not written for 48 h is deleted here (`.tmp` and `.lock` too).
 *   Only a session id in uuid form gets a budget file. The count and the stamps are best effort: a write that
 *   returns false, or two blocks in the same second, are accepted. The count cannot see a cloud session or
 *   another machine.
 *
 * Order at each Stop, after the early approves:
 *   1. Candidates.
 *      Own: a pending file of this session with no stopBlocked, whose board has a phone page
 *      (boardArtifact(board) is not null, or the default board's artifacts.json entry is bad: then the block holds
 *      the fix line of blockReason, keyed UNRECORDED_PAGE_ID), and whose verbs hold an ask verb (claim, release, done, park).
 *      A new-shape file (marker `v: 2`, written by the reminder) also asks with `askAt` alone: the ask verb
 *      dropped out of a full list. With no ask signal it never asks, also with 50 verbs.
 *      An old-shape file (no marker) with no verbs list, or with 50 verbs, counts as an ask.
 *      Foreign (uuid session only, never a headless run): a pending file of ANOTHER session for the board of
 *      payload.cwd, with no stopBlocked, a verbs list with an ask signal (an ask verb in the list, or `askAt`),
 *      a change time 10 minutes old or more, and newer than the last ask for that page. A full list of 50
 *      verbs with no ask signal does not ask. One at most. No string cwd, no board, no page: none.
 *      Cover rule, own and foreign: a change older than the last publish of its page minus 120 s is on the
 *      page already and is not a candidate. The margin covers the time between the render and the publish.
 *   2. No candidate: approve.
 *   3. `limit` of today in any budget file, or 150 or more publishes today in all files: approve.
 *   4. The first candidate (own in file-name order, then the foreign one) whose page had no publish and no ask
 *      in the last 10 minutes blocks. Before the block the gate writes asked[id] = now to its own budget file,
 *      then (own candidate) stopBlocked to the pending file. If either write fails it approves: a block
 *      without a stamp would repeat. A session id that is not a uuid writes no stamp and blocks once per batch.
 *      A headless run that opted in writes no stamp either. A pending file that the reminder changed since
 *      this Stop read it is not marked: the gate approves, and a later Stop asks.
 *   5. Every candidate inside its 10 minutes: approve, files unmarked. The change is asked at a later Stop.
 *      Known limit: with one session on a board, that is the session's next Stop after the window.
 *
 * Approve (no output: no stdout, no stderr, exit 0) when:
 *   - stop_hook_active is true (Claude Code is already continuing because of a Stop hook)
 *   - the entrypoint starts with "sdk" (headless claude -p has no Artifact tool);
 *     LANE_CONTEXT_HEADLESS=1 opts back in for the run's OWN candidates, the same switch as lane-context.
 *     It never opts in to a foreign candidate: the run cannot publish, and its `asked` stamp would close
 *     the one ask for that change.
 *   - there is no session id, no candidate, the day is at its cap, or every page is inside its 10 minutes
 *   - anything fails (fail open). A missing, unreadable or corrupt budget file never blocks and never throws.
 * Block: stdout {"decision":"block","reason":"..."} and exit 0.
 *
 * FleetOps line: when this hook blocks, it may add one more line to the reason.
 * The text lives in staleLine() in shared/lane-dash-refresh.ts.
 * The line never causes a block. With nothing to say about the lane board, the hook approves.
 * Then it does not read the FleetOps state.
 * The line shows at most once an hour per machine.
 * The marker is ~/.claude/state/lane-dash/.refresh-shown.json. A new export (new key) shows it at once.
 * The marker is written after the stopBlocked flag.
 * If it cannot be written, the block still happens, without the line.
 * A headless run (entrypoint "sdk...") never gets the line, even when LANE_CONTEXT_HEADLESS=1 opts it in.
 *
 * The file names, the pending dir and the board constants come from shared/lane-board-pending.ts and
 * shared/lane-board.ts, which the reminder hook imports too. The budget helpers and the ask verbs live in THIS
 * file, and the reminder hook imports them from here. So the reminder's bundle holds this module: main() below
 * runs only when process.argv[1] is this hook's own file (basename test). This file must never import the
 * reminder hook (an import cycle, and its `pg` and spawn code would enter the Stop bundle).
 * The drift test in __tests__/lane-board-stop-gate.test.ts keeps the file names in step.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_BOARD, boardArtifact, boardArtifactProblem, pendingKey, primaryRepo, renderBoardCmd, resolveBoard, type BoardArtifact,
} from './shared/lane-board.js';

/**
 * Budget key of the default board while its page is not recorded (card coord-board-id-followup). The gate then
 * asks once with the fix line instead of the publish steps, under the same 10-minute window and stopBlocked flag.
 */
export const UNRECORDED_PAGE_ID = 'unrecorded-default-board-page';
import { MAX_BYTES, fleetopsLine } from './shared/lane-dash-refresh.js';
import {
  listPending, pendingDir, pendingFile, readPending, sweepStalePending, type Pending, type PendingEntry,
} from './shared/lane-board-pending.js';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const isPlain = (v: unknown): v is Record<string, unknown> => isObj(v) && !Array.isArray(v);

type Env = Record<string, string | undefined>;

// ---- publish budget (the reminder hook imports this part) ----

/** lane.mjs verbs after which a publish is asked. Every other changing verb only marks the change. */
export const ASK_VERBS = new Set(['claim', 'release', 'done', 'park']);
/** The reminder keeps this many verbs in a pending file. A full list may have lost an ask verb. */
export const VERB_CAP = 50;
/** At most one ask per board page in this time. */
export const ASK_WINDOW_MS = 10 * 60_000;
/** No ask at this many publishes in the UTC day. The server limit is 200; the rest is the margin. */
export const DAY_CAP = 150;
/** A change this close before a publish may be missing from the page (render, then publish). */
export const COVER_MARGIN_MS = 120_000;
/** A budget file not written for this long is deleted. */
export const BUDGET_MAX_AGE_MS = 48 * 3_600_000;
/** Two hook processes read their clocks at different times. A stamp this far ahead of `now` is still good. */
export const CLOCK_SKEW_MS = 60_000;
/** The budget write waits this long for the lock of another writer, then gives up. */
const LOCK_WAIT_MS = 200;
const LOCK_STEP_MS = 10;
/** A lock this old belongs to a process that died. The next writer takes it over. */
const LOCK_STALE_MS = 5_000;
/** On Windows a rename fails while a reader has the target open. Tries after the first one, and the wait between them. */
const RENAME_RETRIES = 3;
const RENAME_WAIT_MS = 15;
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** The shape marker `v` of a pending file that the reminder writes now. A file with no marker is the old shape. */
export const PENDING_SHAPE = 2;

/** A pending file as the reminder writes it now: `askAt` is the time (ms) of the last ask verb, `v` the shape marker. */
export type AskPending = Pending & { askAt?: number; v?: number };

export interface Budget {
  day: string;
  n: number;
  limit: boolean;
  pages: Record<string, number>;
  asked: Record<string, number>;
}

/** What all budget files say together. */
export interface BudgetView {
  /** Accepted publishes of the UTC day, all sessions on this machine. */
  total: number;
  limit: boolean;
  /** Artifact id to the newest publish time. */
  lastPublish: Map<string, number>;
  /** Artifact id to the newest ask time. */
  lastAsk: Map<string, number>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only a session id in uuid form names a budget file. */
export const isUuid = (s: string): boolean => UUID_RE.test(s);
export const budgetDir = (env: Env = process.env): string => path.join(pendingDir(env), 'budget');
export const budgetFile = (sid: string, env: Env = process.env): string => path.join(budgetDir(env), `${sid}.json`);
export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);
export const emptyBudgetView = (): BudgetView => ({ total: 0, limit: false, lastPublish: new Map(), lastAsk: new Map() });

/** True when the verb list of a pending file holds an ask verb. */
export function holdsAskVerb(p: Pending | null): boolean {
  const verbs: unknown = p?.verbs;
  return Array.isArray(verbs) && verbs.some((v) => ASK_VERBS.has(v));
}

const countOf = (n: unknown): number => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0);

/**
 * The usable stamps of `pages` or `asked`: a plain object, finite numbers, none later than now + CLOCK_SKEW_MS.
 * The tolerance keeps a stamp that another hook process wrote a few ms after this one read its clock.
 */
function stampsOf(v: unknown, now: number): Array<[string, number]> {
  if (!isPlain(v)) return [];
  return Object.entries(v).filter(
    (e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]) && e[1] <= now + CLOCK_SKEW_MS,
  );
}

/** One budget file, or null: missing, over MAX_BYTES, not JSON, or not a plain object. Never throws. */
function readBudgetFile(file: string): Record<string, unknown> | null {
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    const d: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlain(d) ? d : null;
  } catch {
    return null;
  }
}

function keepNewest(into: Map<string, number>, stamps: Array<[string, number]>): void {
  for (const [id, t] of stamps) {
    if (t > (into.get(id) ?? -Infinity)) into.set(id, t);
  }
}

/** Add one budget file to the view. `n` and `limit` count only for today; the stamps count for any day. */
function addToView(view: BudgetView, d: Record<string, unknown>, today: string, now: number): void {
  if (d.day === today) {
    view.total += countOf(d.n);
    view.limit = view.limit || d.limit === true;
  }
  keepNewest(view.lastPublish, stampsOf(d.pages, now));
  keepNewest(view.lastAsk, stampsOf(d.asked, now));
}

/** Read every budget file. A file that cannot be used is skipped. Makes no folder. Never throws. */
export function readBudgets(env: Env = process.env, now: number = Date.now()): BudgetView {
  const view = emptyBudgetView();
  try {
    const dir = budgetDir(env);
    const today = utcDay(now);
    for (const name of fs.readdirSync(dir)) {
      const d = name.endsWith('.json') ? readBudgetFile(path.join(dir, name)) : null;
      if (d) addToView(view, d, today, now);
    }
  } catch {
    // no budget folder, or a file in its place: the view stays empty
  }
  return view;
}

/**
 * One session's budget for the UTC day of `now`: the good values of its file, or a clean start.
 * Just before 00:00 UTC another hook process of the session, with a clock a few ms later, may have started
 * the new day in the file. Then the file's day and count are kept: the earlier clock must not write the old
 * day over them. Only the day of now + CLOCK_SKEW_MS counts as that case; any other day restarts the count.
 */
function loadBudget(file: string, now: number): Budget {
  const d = readBudgetFile(file) ?? {};
  const ahead = utcDay(now + CLOCK_SKEW_MS);
  const day = d.day === ahead ? ahead : utcDay(now);
  const sameDay = d.day === day;
  return {
    day,
    n: sameDay ? countOf(d.n) : 0,
    limit: sameDay && d.limit === true,
    pages: Object.fromEntries(stampsOf(d.pages, now)),
    asked: Object.fromEntries(stampsOf(d.asked, now)),
  };
}

const errCode = (err: unknown): unknown => (isObj(err) ? err.code : undefined);

/** Block this process for `ms`. A hook is a short-lived process with no other work to do. Never throws. */
function sleepMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // no wait: the callers stop at a deadline or a try count
  }
}

function removeQuiet(file: string): void {
  try {
    fs.rmSync(file, { force: true, maxRetries: 3, retryDelay: LOCK_STEP_MS });
  } catch {
    // nothing more to do
  }
}

/** True when the lock file is older than LOCK_STALE_MS on the real clock. A lock that is gone is not stale. */
function lockIsStale(lock: string): boolean {
  try {
    return Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Take `<budget file>.lock` (create with flag `wx`). Waits at most LOCK_WAIT_MS for another writer and takes
 * over a stale lock. False when the lock is not won. EEXIST means another writer holds it. A busy code is
 * tried again too: Windows gives EPERM while a lock that was just removed is still closing. Any other error
 * gives false at once. The wait and the lock age use the real clock, never the `now` of the caller.
 * Known limit: two writers that take over one stale lock in the same instant can both win. Never throws.
 */
function takeLock(lock: string): boolean {
  const end = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      const code = String(errCode(err));
      if (code !== 'EEXIST' && !BUSY_CODES.has(code)) return false;
    }
    if (Date.now() >= end) return false;
    if (lockIsStale(lock)) removeQuiet(lock);
    else sleepMs(LOCK_STEP_MS);
  }
}

/** Rename, and try again after a short wait while the target is busy (a reader has it open on Windows). */
function renameBusySafe(from: string, to: string): void {
  for (let retry = 0; ; retry++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (retry >= RENAME_RETRIES || !BUSY_CODES.has(String(errCode(err)))) throw err;
      sleepMs(RENAME_WAIT_MS);
    }
  }
}

/**
 * Change one session's budget file: take the lock, load, apply `change`, write through a .tmp file and a
 * rename, free the lock. The lock makes load-change-rename one step, so two hook processes of one session
 * (two publishes, or a publish beside a Stop) cannot both report success while one update is lost.
 * Keeps every field `change` does not touch. A corrupt file is replaced by a clean one.
 * False when nothing was written: the id is not a uuid, the lock was not won, or the write failed.
 * Never throws; no .tmp and no own .lock is left.
 */
export function updateBudget(sid: string, env: Env, now: number, change: (b: Budget) => void): boolean {
  if (!isUuid(sid)) return false;
  const file = budgetFile(sid, env);
  const lock = `${file}.lock`;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return false;
  }
  if (!takeLock(lock)) return false;
  try {
    const b = loadBudget(file, now);
    change(b);
    fs.writeFileSync(tmp, JSON.stringify(b));
    renameBusySafe(tmp, file);
    return true;
  } catch {
    return false;
  } finally {
    removeQuiet(tmp);
    removeQuiet(lock);
  }
}

function removeIfOld(file: string, now: number): void {
  try {
    const st = fs.statSync(file);
    if (st.isFile() && now - st.mtimeMs > BUDGET_MAX_AGE_MS) fs.rmSync(file, { force: true });
  } catch {
    // one unreadable file never stops the sweep
  }
}

/** Delete budget files (and leftover .tmp and .lock files) not written for 48 h. Best effort. Never throws. */
export function sweepBudget(env: Env = process.env, now: number = Date.now()): void {
  try {
    const dir = budgetDir(env);
    for (const name of fs.readdirSync(dir)) {
      if (/\.(json|tmp|lock)$/.test(name)) removeIfOld(path.join(dir, name), now);
    }
  } catch {
    // no budget folder
  }
}

// ---- the gate ----

/** A pending file the gate looks at. `mtimeMs` is the change time of a file with no `askAt`. */
export interface StopEntry {
  board: string;
  pending: AskPending;
  mtimeMs?: number;
}

/** What `decideStop` knows beyond the session's own files. All optional: the default is "no budget, no other session". */
export interface StopContext {
  now?: number;
  budget?: BudgetView;
  /** Pending files of other sessions for the board of the cwd. */
  foreign?: StopEntry[];
}

export type StopDecision =
  | { action: 'approve' }
  | { action: 'block'; reason: string; board: string; pageId: string; foreign: boolean };

interface Candidate {
  board: string;
  pageId: string;
  foreign: boolean;
}

/**
 * The block text. The retry sentence leaves out the daily limit: read alone, "if the publish is refused,
 * publish again" would tell the session to publish again after a daily-limit refusal too.
 */
export function blockReason(board: string, env: Env = process.env, foreign: boolean = false): string {
  const a = boardArtifact(board, { env });
  if (!a) {
    // The default board with a bad artifacts.json entry: no publish steps. Many sessions editing one shared file is
    // the fault the file-claims hook exists for, so the line sends the fix to the seat or Dave (seat, 2026-11-17).
    const problem = boardArtifactProblem(board, { env });
    if (!problem) return '';
    return (
      `The lane board page of ${board} is not recorded: ${problem}. Do not publish. ` +
      `Tell the seat (or Dave): the agentic-os-lane-board entry of ${primaryRepo(env)}/.claude/artifacts.json needs a fix.`
    );
  }
  const why = foreign
    ? `Another session changed the lane DB and did not publish. The lane board page for board ${board} is out of date. `
    : `The lane board page for board ${board} is out of date: this session changed the lane DB and has not republished it. `;
  return (
    why +
    `Other sessions update this page all day, so your held copy is old. In this order: ` +
    `1. Read the live page with the Artifact tool, action read, url ${a.url}, without path (a read with path does not count). Do not open or paste the saved file. ` +
    `2. Run ${renderBoardCmd(board, env)}. ` +
    `3. At once publish ${primaryRepo(env)}/${a.publishFrom} with the Artifact tool to url ${a.url} (omit capabilities). ` +
    `If the publish is refused for any reason other than the daily publish limit, publish the same file again: the refusal counts as the read. ` +
    `If the refusal names the daily publish limit, do not publish again today. ` +
    `Then finish your turn.`
  );
}

/** True for a headless run (claude -p): it has no Artifact tool. LANE_CONTEXT_HEADLESS=1 does not change this. */
const isSdk = (env: Env): boolean => (env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk');

/** True for a headless run (claude -p) that has not opted back in. */
export function isHeadless(env: Env): boolean {
  return env.LANE_CONTEXT_HEADLESS !== '1' && isSdk(env);
}

/** False for the early approves: a bad payload, a Stop hook continuation, a headless run, no session id. */
function mayAsk(payload: unknown, env: Env): payload is Record<string, unknown> & { session_id: string } {
  if (!isObj(payload) || payload.stop_hook_active === true || isHeadless(env)) return false;
  return typeof payload.session_id === 'string' && payload.session_id !== '';
}

/** The `askAt` of a pending file when it is a finite number. The reminder sets it on every ask verb and keeps it. */
function askAtOf(p: AskPending): number | undefined {
  return typeof p.askAt === 'number' && Number.isFinite(p.askAt) ? p.askAt : undefined;
}

/** The time of the lane change a pending file stands for: `askAt`, else the file time, else "newer than all". */
function changedAt(e: StopEntry): number {
  return askAtOf(e.pending) ?? e.mtimeMs ?? Infinity;
}

/** Cover rule: the change is older than the last publish of its page, by more than the margin. */
function shown(e: StopEntry, lastPublish: number | undefined): boolean {
  return lastPublish !== undefined && changedAt(e) < lastPublish - COVER_MARGIN_MS;
}

/**
 * A new-shape own file (marker `v`) asks only with an ask signal: an ask verb in the list, or `askAt` when the
 * verb dropped out of a full list. So 50 say or note with no ask verb ask nothing (Dave's decision 2).
 * An old-shape file has no `askAt` to trust: it asks with an ask verb, with no verbs list, or with a full list.
 */
function ownAsks(p: AskPending): boolean {
  if (p.v === PENDING_SHAPE) return holdsAskVerb(p) || askAtOf(p) !== undefined;
  return !Array.isArray(p.verbs) || p.verbs.length >= VERB_CAP || holdsAskVerb(p);
}

/**
 * Another session's file asks only with a verbs list and an ask signal (an ask verb in the list, or `askAt`
 * when the verb dropped out of a full list), 10 minutes after its change, and when nobody was asked since.
 * A full list with no ask signal does not ask: with no `askAt` its change time is the file time, every say
 * moves that, and the same file would be asked again after each say.
 */
function foreignAsks(e: StopEntry, lastAsk: number | undefined, now: number): boolean {
  const verbs: unknown = e.pending.verbs;
  if (!Array.isArray(verbs) || !(holdsAskVerb(e.pending) || askAtOf(e.pending) !== undefined)) return false;
  const at = changedAt(e);
  return now - at >= ASK_WINDOW_MS && at > (lastAsk ?? -Infinity);
}

/** Own candidates in the given order, then at most one foreign candidate. */
function findCandidates(own: StopEntry[], foreign: StopEntry[], env: Env, view: BudgetView, now: number): Candidate[] {
  const pages = new Map<string, BoardArtifact | null>();
  const pageOf = (board: string): BoardArtifact | null => {
    if (!pages.has(board)) {
      const page = boardArtifact(board, { env });
      const unrecorded = !page && boardArtifactProblem(board, { env }) !== null;
      pages.set(board, unrecorded ? { id: UNRECORDED_PAGE_ID, url: '', publishFrom: '' } : page);
    }
    return pages.get(board) ?? null;
  };
  const pick = (list: StopEntry[], isForeign: boolean): Candidate[] => {
    const out: Candidate[] = [];
    for (const e of list) {
      const page = pageOf(e.board);
      if (!page || e.pending.stopBlocked === true || shown(e, view.lastPublish.get(page.id))) continue;
      const asks = isForeign ? foreignAsks(e, view.lastAsk.get(page.id), now) : ownAsks(e.pending);
      if (asks) out.push({ board: e.board, pageId: page.id, foreign: isForeign });
    }
    return out;
  };
  return [...pick(own, false), ...pick(foreign, true).slice(0, 1)];
}

/** The newest publish or ask of a page, or -Infinity. */
function lastTouch(view: BudgetView, pageId: string): number {
  return Math.max(view.lastPublish.get(pageId) ?? -Infinity, view.lastAsk.get(pageId) ?? -Infinity);
}

/**
 * Pure decision. `entries` are the session's pending files, parsed (file-name order). `ctx` adds the clock,
 * the budget files and the other sessions' files; without it there is no cap, no window and no foreign
 * candidate. A block is also the cue for the caller to stamp `asked` and to set stopBlocked on the file of
 * the board it names (own candidate only).
 */
export function decideStop(payload: unknown, env: Env, entries: StopEntry[], ctx: StopContext = {}): StopDecision {
  const approve: StopDecision = { action: 'approve' };
  if (!mayAsk(payload, env)) return approve;
  const now = ctx.now ?? Date.now();
  const view = ctx.budget ?? emptyBudgetView();
  const candidates = findCandidates(entries, ctx.foreign ?? [], env, view, now);
  if (!candidates.length || view.limit || view.total >= DAY_CAP) return approve;
  const due = candidates.find((c) => now - lastTouch(view, c.pageId) >= ASK_WINDOW_MS);
  if (!due) return approve;
  return { action: 'block', reason: blockReason(due.board, env, due.foreign), board: due.board, pageId: due.pageId, foreign: due.foreign };
}

// ---- thin IO ----

export const stateDir = pendingDir;
export const stateFile = pendingFile;

function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** The board of the payload cwd, or null. Never falls back to process.cwd(). Throws nothing. */
function cwdBoard(payload: Record<string, unknown>, env: Env): string | null {
  if (typeof payload.cwd !== 'string' || !payload.cwd) return null;
  try {
    return resolveBoard(payload.cwd, { headlessOk: true, env })?.key ?? null;
  } catch {
    return null;
  }
}

/** One pending file of another session. Its board: the `board` field, else the name part after `@`, else the default. */
function foreignEntry(file: string, base: string): StopEntry | null {
  const pending = readPending(file);
  const mtimeMs = mtimeOf(file);
  if (!pending || mtimeMs === undefined) return null;
  const at = base.indexOf('@');
  const named = at >= 0 ? base.slice(at + 1) : DEFAULT_BOARD;
  return { board: typeof pending.board === 'string' && pending.board ? pending.board : named, pending, mtimeMs };
}

/**
 * The pending files of OTHER sessions for one board, in file-name order. Read only: this hook never writes
 * another session's file. Dot-files (`.render-*`, `.said-*`) and the `budget` folder are not pending files.
 */
export function foreignPending(sid: string, board: string, env: Env = process.env): StopEntry[] {
  const dir = pendingDir(env);
  const stem = pendingKey(sid, DEFAULT_BOARD);
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: StopEntry[] = [];
  for (const name of names) {
    const base = name.slice(0, -5);
    if (!name.endsWith('.json') || name.startsWith('.') || base === stem || base.startsWith(`${stem}@`)) continue;
    const e = foreignEntry(path.join(dir, name), base);
    if (e && e.board === board) out.push(e);
  }
  return out;
}

/**
 * Other sessions' files for the board of the cwd. None for an id that is not a uuid: it cannot stamp `asked`.
 * None for a headless run, opted in or not: it cannot publish, and its stamp would close the one foreign ask.
 */
function foreignFor(payload: Record<string, unknown>, sid: string, env: Env): StopEntry[] {
  if (!isUuid(sid) || isSdk(env)) return [];
  const board = cwdBoard(payload, env);
  return board ? foreignPending(sid, board, env) : [];
}

/**
 * Make the block final: stamp asked[page] in the own budget file, then mark the own pending file.
 * False when a write failed. The caller then approves: a block with no stamp or no flag would repeat.
 */
function recordAsk(d: Extract<StopDecision, { action: 'block' }>, sid: string, own: PendingEntry[], env: Env, now: number): boolean {
  const uuid = isUuid(sid);
  // A headless run that opted in cannot publish. Its stamp would close the 10 minutes for the sessions that can.
  const stamps = uuid && !isSdk(env);
  let before: number | undefined;
  if (stamps && !updateBudget(sid, env, now, (b) => { before = b.asked[d.pageId]; b.asked[d.pageId] = now; })) return false;
  if (d.foreign) return uuid;
  // No block follows a failed mark, so the stamp of this Stop goes back to its old value. A stamp with no
  // block would close the 10 minutes, and the one ask of another session's change, for nothing.
  const unstamp = (): false => {
    if (stamps) {
      updateBudget(sid, env, now, (b) => {
        if (b.asked[d.pageId] !== now) return;
        if (before === undefined) delete b.asked[d.pageId];
        else b.asked[d.pageId] = before;
      });
    }
    return false;
  };
  const hit = own.find((e) => e.board === d.board);
  if (!hit) return unstamp();
  try {
    // Read the file again: the reminder can write a new ask verb between this Stop's read and this write.
    // A file that changed is not marked. The gate approves, and a later Stop asks for the new change.
    const fresh = readPending(hit.file) as AskPending | null;
    const was = hit.pending as AskPending;
    if (!fresh || fresh.askAt !== was.askAt || fresh.verbs?.length !== was.verbs?.length) return unstamp();
    fs.writeFileSync(hit.file, JSON.stringify({ ...fresh, stopBlocked: true }));
    return true;
  } catch {
    return unstamp();
  }
}

/** Sweep stale files, read this session's batches and the budget, decide, and record the block. */
export function stopGate(payload: unknown, env: Env = process.env, now: number = Date.now()): { output: object | null } {
  sweepStalePending(env, now);
  if (!mayAsk(payload, env)) return { output: null };
  const sid = payload.session_id;
  sweepBudget(env, now);
  const own = listPending(sid, env);
  const foreign = foreignFor(payload, sid, env);
  // Most Stops have nothing pending: then no budget file is read.
  const budget = own.length || foreign.length ? readBudgets(env, now) : emptyBudgetView();
  const entries = own.map(({ file, board, pending }) => ({ board, pending, mtimeMs: mtimeOf(file) }));
  const d = decideStop(payload, env, entries, { now, budget, foreign });
  if (d.action !== 'block' || !recordAsk(d, sid, own, env, now)) return { output: null };
  // The FleetOps line only rides on a block that already happens. It is computed after the block is final
  // and marked, so it can never turn an approve into a block.
  const line = isSdk(env) ? '' : fleetopsLine(env, now);
  return { output: { decision: 'block', reason: line ? `${d.reason}\n${line}` : d.reason } };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input.trim()) return;
  const { output } = stopGate(JSON.parse(input));
  if (output) console.log(JSON.stringify(output));
}

// Basename check, not only VITEST: the reminder hook imports this file, and its bundle must not run this
// main(). A directory named like the hook does not start it either.
if (!process.env.VITEST && /(^|[\\/])lane-board-stop-gate\.(mjs|js|ts)$/.test(process.argv[1] || '')) {
  main().catch(() => {
    // Fail open: no output, exit 0.
  });
}

export { main, DEFAULT_BOARD };
