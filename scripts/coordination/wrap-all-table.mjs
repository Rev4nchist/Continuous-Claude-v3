#!/usr/bin/env node
// Dry run of /wrap-all (card seat-wrap-all-skill): print the stop-point table of every live session on the board and the WRAP WORD text.
//   node scripts/coordination/wrap-all-table.mjs [--json]
// READ-ONLY. It sends nothing: no lane DM, no SendMessage, no note, no claim, no git fetch (a fetch writes refs), no file write, no delete.
// The behind counts use the fork/main ref as it is on disk. The output names that sha and the time of the last fetch, so the seat sees how old they are.
// Only the seat sends (the holder of the re-program lane). Any other session gets this table and the line "only the seat sends; run /wrap-all in the seat session".
// A test (W14) scans this file's source and fails if it holds a write, a delete, a fetch or a lane write verb.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STOP = {
  READY: 'READY TO WRAP',
  WAIT_END: 'WAIT FOR END',
  SAVE_PATCH: 'SAVE PATCH',
  MERGE_MAIN: 'MERGE MAIN BY V7.10',
  RELEASE_LOCK: 'RELEASE LOCK FIRST',
  UNKNOWN: 'UNKNOWN (READ FAILED)',
};

const NEXT = {
  [STOP.READY]: 'rewrite the lane note (WAITS ON, NEXT), write the Notion handoff, reply HANDOFF DONE',
  [STOP.WAIT_END]: 'let the run end and send its END word, then the handoff',
  [STOP.SAVE_PATCH]: 'save the uncommitted work as a patch in the lane e2e folder, then the handoff',
  [STOP.MERGE_MAIN]: 'merge fork/main by V7.10 and push, then the handoff',
  [STOP.RELEASE_LOCK]: 'finish the step or run the failed release with its step number, then the handoff',
  [STOP.UNKNOWN]: 'a read failed: read the worktree status, the commits behind or publish.lock by hand before any handoff word',
};

const SEAT_ONLY_LINE = 'only the seat sends; run /wrap-all in the seat session';
const sid8Of = (id) => String(id ?? '').slice(0, 8);

/**
 * Running work in one lane note. A START word carries a time (PRE-PR START 11:48 CST); the words with no time are a rule, not a START.
 * A START is closed by a later END with a time, or by the word VOID after it (a run the lock refused).
 */
export function runningWork(note) {
  const text = String(note ?? '');
  const open = (kind) => {
    const starts = [...text.matchAll(new RegExp(`\\b${kind} START \\d{1,2}:\\d{2}`, 'g'))];
    if (!starts.length) return false;
    const at = starts[starts.length - 1].index;
    const rest = text.slice(at + 1);
    if (new RegExp(`\\b${kind} END \\d{1,2}:\\d{2}`).test(rest)) return false;
    return !/\bVOID\b/.test(rest);
  };
  return { prePr: open('PRE-PR'), hookBuild: open('HOOK BUILD') };
}

/**
 * The stop point of one session. A held FleetOps lock wins, then running work, then known unsaved work. A failed read (tracked or behind
 * is null) is UNKNOWN: it is never READY and it never hides known unsaved work. Then a main merge.
 */
export function stopPoint({ refresh, prePr, hookBuild, tracked, behind, lockUnreadable = false }) {
  if (refresh) return STOP.RELEASE_LOCK;
  if (prePr || hookBuild) return STOP.WAIT_END;
  if (tracked > 0) return STOP.SAVE_PATCH;
  if (tracked === null || behind === null || lockUnreadable) return STOP.UNKNOWN;
  if (behind > 0) return STOP.MERGE_MAIN;
  return STOP.READY;
}

/** The text the seat sends. It forbids new starts. It never tells a session to start a run. */
export function wrapWordText() {
  return [
    'WRAP WORD (the seat, for Dave\'s all-session handoff). Reach a clean handoff point, then reply HANDOFF DONE <lane> <head> <Notion url>.',
    '1. Stop point: no new PRE-PR START, HOOK BUILD START or paid run. A running pre-pr finishes and sends its END word.',
    '2. Save uncommitted work as a patch in your lane e2e folder. Do a pending merge of main by V7.10 and push it.',
    '3. Rewrite your lane note with WAITS ON and NEXT. Write the Notion handoff.',
    '4. A lock in progress ends cleanly: run the failed release with its step number. Never leave a lock held.',
    'Failures of 11-26 this word stops:',
    '- START words sent before the run lock granted: the lock answered WAIT (exit 75) and nothing ran. Run pre-pr.mjs --preflight first. A START goes out after PREFLIGHT PASS and the V7.3 reads, and before the run. When the run lock answers WAIT (exit 75), write VOID in the note: nothing ran.',
    '- A folder removed before the seat named it. Remove no folder and no worktree. The seat names each one. Unlink a junction first.',
    '- A FleetOps refresh cut at step 6.1. The holder of the publish lock finishes the step or runs the failed release with the step number.',
    'Never: /compact another session, kill a session, force-delete a folder.',
  ].join('\n');
}

/**
 * input: { peers, lanes, worktrees, publishLock, forkMain, now, me, runLocks? }
 *   peers: lane.mjs peers --json rows (id, name, label, lanes, last_alive). Only sessions active in the last 5 minutes are here.
 *   lanes: lane.mjs board --json lanes (id, owner_session_id, owner_name, note, branch, state). A holder that is not in peers is an idle session.
 *   worktrees: every worktree the caller read: { path, branch, tracked, untracked, behind }. A failed read is null, never zero.
 *   publishLock: the FleetOps publish.lock record ({ session, key, at }), null when there is no lock, or { unreadable: true } when the file is there and cannot be read
 *   me: the sid8 of the session that runs the command
 */
export function buildTable({ peers = [], lanes = [], worktrees = [], publishLock = null, forkMain = null, now = Date.now(), me = '', runLocks = null }) {
  const used = new Set();
  const lockUnreadable = !!publishLock && publishLock.unreadable === true;
  const warnings = [];
  if (lockUnreadable) warnings.push('publish.lock exists but cannot be read: a FleetOps refresh may be in progress. No row is READY until the seat reads it by hand.');
  // Every live peer, plus every holder of an open lane that is not a live peer (an idle session is quiet for 5 minutes or more).
  const sessions = peers.map((p) => ({ ...p, idle: false }));
  const seen = new Set(sessions.map((p) => sid8Of(p.id)));
  for (const l of lanes) {
    const s8 = sid8Of(l.owner_session_id);
    if (!l.owner_session_id || /^done$/.test(String(l.state)) || seen.has(s8)) continue;
    seen.add(s8);
    sessions.push({ id: l.owner_session_id, name: l.owner_name || `session ${s8}`, lanes: '', last_alive: null, idle: true });
  }
  const rows = sessions.map((p) => {
    const sid8 = sid8Of(p.id);
    const mine = lanes.filter((l) => sid8Of(l.owner_session_id) === sid8);
    const laneIds = String(p.lanes ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const ids = [...new Set([...laneIds, ...mine.map((l) => l.id)])];
    // Each lane note is read alone: a finished run in one lane must not hide an active START in another.
    const runs = mine.map((l) => runningWork(l.note));
    const run = { prePr: runs.some((r) => r.prePr), hookBuild: runs.some((r) => r.hookBuild) };
    const wts = worktrees.filter((w) => ids.some((id) => String(w.branch ?? '').endsWith(`/${id}`)) || mine.some((l) => l.branch && l.branch === w.branch));
    wts.forEach((w) => used.add(w.path));
    const known = (v) => typeof v === 'number';
    const tracked = wts.reduce((n, w) => n + (known(w.tracked) ? w.tracked : 0), 0);
    const untracked = wts.reduce((n, w) => n + (known(w.untracked) ? w.untracked : 0), 0);
    const trackedUnknown = wts.some((w) => !known(w.tracked));
    const behindUnknown = wts.some((w) => !known(w.behind));
    const behind = wts.reduce((n, w) => Math.max(n, known(w.behind) ? w.behind : 0), 0);
    const refresh = !!publishLock && !lockUnreadable && sid8Of(publishLock.session) === sid8;
    const running = [run.prePr ? 'pre-pr' : '', run.hookBuild ? 'hook build' : '', refresh ? 'FleetOps refresh' : ''].filter(Boolean).join(', ') || 'nothing';
    const stop = stopPoint({
      refresh, prePr: run.prePr, hookBuild: run.hookBuild,
      tracked: tracked > 0 ? tracked : (trackedUnknown ? null : 0),
      behind: behindUnknown ? null : behind, lockUnreadable,
    });
    const alive = Date.parse(p.last_alive);
    return {
      name: p.name, sid8, idle: !!p.idle, lanes: ids.join(', ') || '-', running, stop,
      next: NEXT[stop] + (p.idle ? ' (idle: use SendMessage; a lane DM does not wake it)' : ''),
      uncommitted: tracked, untracked, behind: behindUnknown ? null : behind, trackedUnknown, worktrees: wts.map((w) => w.path),
      idleSec: Number.isFinite(alive) ? Math.max(0, Math.round((now - alive) / 1000)) : null,
    };
  });
  const seatLane = lanes.find((l) => l.id === 're-program' && l.owner_session_id);
  const seatPeer = seatLane ? sessions.find((p) => sid8Of(p.id) === sid8Of(seatLane.owner_session_id)) : null;
  const seat = seatPeer ? { name: seatPeer.name, sid8: sid8Of(seatPeer.id) } : null;
  const canSend = !!seat && sid8Of(me) === seat.sid8;
  const sendLine = !seat
    ? 'no session holds re-program on this board; /wrap-all sends nothing'
    : canSend ? `the seat (${seat.name} #${seat.sid8}) sends the WRAP WORD after Dave says go` : SEAT_ONLY_LINE;
  return {
    rows, seat, canSend, sendLine, forkMain, runLocks, warnings,
    unmatchedWorktrees: worktrees.filter((w) => !used.has(w.path)),
    wrapWord: wrapWordText(),
  };
}

const pad = (s, n) => String(s).padEnd(n).slice(0, Math.max(n, String(s).length));
const count = (v) => (typeof v === 'number' ? String(v) : '?');

export function renderTable(t) {
  const out = ['WRAP-ALL DRY RUN (read-only: this run sends nothing)'];
  const f = t.forkMain;
  out.push(f ? `behind counts use fork/main ${String(f.sha).slice(0, 8)}, last fetch ${f.fetchedAt ?? 'unknown'} (no fetch here)` : 'fork/main is not on disk; behind counts are unknown');
  if (t.runLocks != null) out.push(`run lock files held: ${t.runLocks}`);
  for (const w of t.warnings ?? []) out.push(`WARNING: ${w}`);
  out.push('');
  const head = ['SESSION', 'LANES', 'RUNNING', 'UNCOMMITTED', 'BEHIND', 'STOP POINT'];
  const lines = t.rows.map((r) => [
    `${r.name} #${r.sid8}${r.idle ? ' (idle)' : ''}`, r.lanes, r.running,
    r.trackedUnknown ? 'read failed' : `${r.uncommitted} tracked, ${r.untracked} untracked`, count(r.behind), r.stop,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
  out.push(head.map((h, i) => pad(h, w[i])).join('  '));
  for (const l of lines) out.push(l.map((c, i) => pad(c, w[i])).join('  '));
  out.push('');
  for (const r of t.rows) out.push(`${r.name} #${r.sid8}: next, ${r.next}`);
  if (t.unmatchedWorktrees.length) {
    out.push('', 'Worktrees with no live session (the seat names a folder before anyone removes it):');
    for (const u of t.unmatchedWorktrees) out.push(`  ${u.path} [${u.branch ?? 'detached'}] ${count(u.tracked)} tracked, ${count(u.untracked)} untracked, behind ${count(u.behind)}`);
  }
  out.push('', `Send: ${t.sendLine}`, '', 'WRAP WORD text (printed, not sent):', t.wrapWord);
  return out.join('\n');
}

// ---------- real reads (each one is read-only) ----------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANE_CLI = path.join(os.homedir(), '.claude', 'scripts', 'lane.mjs');

function runNode(args, opts = {}) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 120000, ...opts });
  return r.status === 0 ? r.stdout : null;
}
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return r.status === 0 ? r.stdout : null;
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * Every worktree of the repo, each read once. `sha` is the one full fork/main sha that every behind count uses.
 * A failed git read is null, never zero: the table shows UNKNOWN. A failed worktree list is an error (no table without it).
 * `git` is injectable for the tests.
 */
export function readWorktrees(root, { git: g = git, sha = 'refs/remotes/fork/main' } = {}) {
  const list = g(root, 'worktree', 'list', '--porcelain');
  if (list === null || list === undefined) throw new Error('git worktree list failed: no table without the worktrees');
  const out = [];
  for (const block of list.split(/\r?\n\r?\n/)) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    if (!wt) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    const status = g(wt, 'status', '--porcelain');
    const lines = status == null ? null : status.split(/\r?\n/).filter(Boolean);
    const untracked = lines ? lines.filter((l) => l.startsWith('??')).length : null;
    const countOut = g(wt, 'rev-list', '--count', `HEAD..${sha}`);
    const n = countOut == null ? NaN : Number(String(countOut).trim());
    out.push({ path: wt.replace(/\\/g, '/'), branch, tracked: lines ? lines.length - untracked : null, untracked, behind: Number.isInteger(n) ? n : null });
  }
  return out;
}

/** The full fork/main sha and the time of the last fetch. There is no fetch here. */
export function readForkMain(root) {
  const sha = (git(root, 'rev-parse', 'refs/remotes/fork/main') ?? '').trim();
  if (!sha) return null;
  let fetchedAt = null;
  try {
    const common = (git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir') ?? '').trim();
    fetchedAt = new Date(statSync(path.join(common, 'FETCH_HEAD')).mtimeMs).toISOString();
  } catch { /* no FETCH_HEAD: unknown */ }
  return { sha, fetchedAt };
}

export function readRunLocks() {
  const dir = process.env.RUN_LOCK_DIR || path.join(os.homedir(), '.claude', 'state', 'run-locks');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.lock') && f !== 'gate.lock').length;
}

/** null when there is no lock file; the record when it parses; { unreadable: true } when the file is there and does not parse. */
export function readPublishLock(file = path.join(os.homedir(), '.claude', 'state', 'lane-dash', 'publish.lock')) {
  if (!existsSync(file)) return null;
  const rec = readJson(file);
  return rec && typeof rec === 'object' ? rec : { unreadable: true };
}

export function gather(root = path.resolve(HERE, '..', '..')) {
  const peersOut = runNode([LANE_CLI, 'peers', '--json']);
  const boardOut = runNode([LANE_CLI, 'board', '--json']);
  if (peersOut === null || boardOut === null) throw new Error('the lane CLI read failed (peers or board): no table without the sessions');
  const peers = JSON.parse(peersOut);
  const board = JSON.parse(boardOut);
  const forkMain = readForkMain(root);
  const worktrees = readWorktrees(root, { sha: forkMain?.sha });
  const me = sid8Of(process.env.CLAUDE_CODE_SESSION_ID);
  return { peers, lanes: board.lanes, worktrees, publishLock: readPublishLock(), forkMain, now: Date.now(), me: me || sid8Of(board.me), runLocks: readRunLocks() };
}

function main() {
  let table;
  try { table = buildTable(gather()); } catch (err) {
    console.error(`wrap-all-table: ${String(err.message).split('\n')[0]}`);
    process.exit(1);
  }
  console.log(process.argv.includes('--json') ? JSON.stringify(table) : renderTable(table));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
