#!/usr/bin/env node
// Dry run of /wrap-all (cards seat-wrap-all-skill, wrap-all-limits, wrap-all-limits-2): print the stop-point table of every live session on the board and the WRAP WORD text.
//   node scripts/coordination/wrap-all-table.mjs [--json]
// READ-ONLY. It sends nothing: no lane DM, no SendMessage, no note, no claim, no git fetch (a fetch writes refs), no file write, no delete.
// Running work comes from the run lock state (the lock files and runs.jsonl of scripts/coordination/run-lock.mjs), never from lane note prose.
// A lane note only warns ("the note says a run is open, the lock log does not"). One exception: a hook build takes no lock, so a note that holds more
// HOOK BUILD START words than HOOK BUILD END words reads UNKNOWN (note only) until the build launcher takes a lock (card hook-build-run-lock).
// The behind and ahead counts use the fork refs as they are on disk. The output names the fork/main sha and the time of the last fetch.
// Only the seat sends (the holder of the re-program lane). Any other session gets this table and the line "only the seat sends; run /wrap-all in the seat session".
// A test (W14) scans this file's source and fails if it holds a write, a delete, a fetch or a lane write verb.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STOP = {
  READY: 'READY TO WRAP',
  WAIT_END: 'WAIT FOR END',
  SAVE_PATCH: 'SAVE PATCH',
  PUSH_FIRST: 'PUSH FIRST',
  MERGE_MAIN: 'MERGE MAIN BY V7.10',
  RELEASE_LOCK: 'RELEASE LOCK FIRST',
  UNKNOWN: 'UNKNOWN (READ FAILED)',
};

const NEXT = {
  [STOP.READY]: 'rewrite the lane note (WAITS ON, NEXT), write the Notion handoff, reply HANDOFF DONE',
  [STOP.WAIT_END]: 'let the run end and send its END word, then the handoff',
  [STOP.SAVE_PATCH]: 'save the uncommitted work as a patch in the lane e2e folder, then the handoff',
  [STOP.PUSH_FIRST]: 'push the branch to the fork (a push on a card you hold needs no question), then the handoff',
  [STOP.MERGE_MAIN]: 'merge fork/main by V7.10 and push, then the handoff',
  [STOP.RELEASE_LOCK]: 'finish the step or run the failed release with its step number, then the handoff',
  [STOP.UNKNOWN]: 'a read failed: read the worktree status, the commits behind or ahead, the locks or publish.lock by hand before any handoff word',
};

const SEAT_ONLY_LINE = 'only the seat sends; run /wrap-all in the seat session';
// A session handle holds only hex digits and dashes, cut to eight characters: an id with other characters cannot start a new line in the table.
const sid8Of = (id) => String(id ?? '').replace(/[^0-9a-f-]/gi, '').slice(0, 8);
// Text from the board or a lock prints on one line, cut to 80 characters: no forged Send line or WRAP WORD header (C0 and C1 controls, line and paragraph
// separators, zero-width and bidi controls become a space).
const oneLine = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').slice(0, 80);
/** A publish.lock record: an object with an 8-hex session, as fleetops-html.mjs writes it. An array or an empty object has none. */
const validLock = (l) => !!l && typeof l === 'object' && /^[0-9a-f]{8}/i.test(String(l.session ?? ''));
/** A run lock record, as run-lock.mjs writes it: kind, an integer pid and a session label. Any other shape is unreadable. */
const runLockOk = (r) => !!r && typeof r === 'object' && !Array.isArray(r) && !r.unreadable && /^[a-z][a-z-]*$/.test(String(r.kind ?? '')) && Number.isInteger(r.pid) && typeof r.session === 'string';

const cstClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hhmm = (ms) => (Number.isFinite(ms) ? cstClock.format(ms) : '?');

const MAX_NOTE = 64 * 1024;
const MAX_RUNS_SHOWN = 5;

/**
 * What a lane note says about runs. It never closes a run and never decides a stop point alone.
 *   prePrOpen: more PRE-PR START words (a clock time or a pid after the word) than PRE-PR END and VOID words. A warning only: the lock state decides.
 *   hookBuildWord: more HOOK BUILD START words than HOOK BUILD END words. A warning only: a hook build takes a hook-build run lock (card hook-build-run-lock).
 *   tooLong: the note is over 64 KB and is not read.
 * No tie by head, time or pid: a count errs toward "open", never toward "closed".
 */
export function noteSignals(note) {
  const text = String(note ?? '');
  if (text.length > MAX_NOTE) return { tooLong: true, prePrOpen: false, hookBuildWord: false };
  const n = (re, kind) => [...text.matchAll(re)].filter((m) => m[1] === kind).length;
  const starts = (kind) => n(/\b(PRE-PR|HOOK BUILD) START(?:\s*(?:at|[(:]))?\s*\(?\d{1,2}:\d{2}/g, kind) + n(/\b(PRE-PR|HOOK BUILD) START pid \d+/g, kind);
  const ends = (kind) => n(/\b(PRE-PR|HOOK BUILD) END\b/g, kind);
  const voids = [...text.matchAll(/\bVOID\b/g)].length;
  return { tooLong: false, prePrOpen: starts('PRE-PR') > ends('PRE-PR') + voids, hookBuildWord: starts('HOOK BUILD') > ends('HOOK BUILD') };
}

/**
 * The stop point of one session. A held FleetOps lock wins, then a live run lock of the session, then known unsaved work (tracked changes, then
 * unpushed commits). A failed read (tracked, behind or ahead is null), a lock that blocks, a lane with no matched worktree or a note that cannot be
 * read is UNKNOWN: it is never READY and it never hides known unsaved work. Then a main merge.
 */
export function stopPoint({ refresh, prePr, tracked, behind, ahead = 0, lockBlocks = false, noWorktree = false, noteUnknown = false }) {
  if (refresh) return STOP.RELEASE_LOCK;
  if (prePr) return STOP.WAIT_END;
  if (tracked > 0) return STOP.SAVE_PATCH;
  if (ahead > 0) return STOP.PUSH_FIRST;
  if (tracked === null || behind === null || ahead === null || lockBlocks || noWorktree || noteUnknown) return STOP.UNKNOWN;
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
    '- START words sent before the run lock granted: the lock answered WAIT (exit 75) and nothing ran. Run pre-pr.mjs --preflight first. A START goes out after PREFLIGHT PASS and the V7.3 reads, and before the run. When the run lock answers WAIT (exit 75), write VOID <START time> head <sha>: nothing ran. Name the START you void: a VOID with no time and head closes nothing.',
    '- A folder removed before the seat named it. Remove no folder and no worktree. The seat names each one. Unlink a junction first.',
    '- A FleetOps refresh cut at step 6.1. The holder of the publish lock finishes the step or runs the failed release with the step number.',
    'Never: /compact another session, kill a session, force-delete a folder.',
  ].join('\n');
}

/**
 * input: { peers, lanes, worktrees, publishLock, forkMain, now, me, runLocks?, locks?, endedRuns? }
 *   peers: lane.mjs peers --json rows (id, name, label, lanes, last_alive). Only sessions active in the last 5 minutes are here.
 *   lanes: lane.mjs board --json lanes (id, owner_session_id, owner_name, note, branch, state). A holder that is not in peers is an idle session.
 *   worktrees: every worktree the caller read: { path, branch, primary?, tracked, untracked, behind, ahead }. A failed read is null, never zero.
 *     The primary checkout (primary: true) is read by the seat row only.
 *   publishLock: the FleetOps publish.lock record ({ session, key, at }), null when there is no lock, or { unreadable: true } when the file is there and cannot be read
 *   locks: the run lock records of run-lock.mjs, one for each file; a file that is not a valid record is null or { unreadable: true }
 *   runLocks: the count of run lock files, used when `locks` is not given (each file then counts as an unreadable record)
 *   endedRuns: "pid:head" of the end lines in runs.jsonl; a lock with an end line is a left-over file
 *   me: the sid8 of the session that runs the command
 */
export function buildTable({ peers = [], lanes = [], worktrees = [], publishLock = null, forkMain = null, now = Date.now(), me = '', runLocks = null, locks = null, endedRuns = [] }) {
  const used = new Set();
  // A publish.lock that is not an object with a session (an empty object, an array) is unreadable, never "no lock".
  const lockUnreadable = !!publishLock && (publishLock.unreadable === true || !validLock(publishLock));
  const warnings = [];
  if (lockUnreadable) warnings.push('publish.lock exists but cannot be read: a FleetOps refresh may be in progress. No row is READY until the seat reads it by hand.');
  const lockSid = publishLock && !lockUnreadable ? sid8Of(publishLock.session) : '';
  // Every live peer, plus every holder of an open lane that is not a live peer (an idle session is quiet for 5 minutes or more).
  const sessions = peers.map((p) => ({ ...p, name: oneLine(p.name), idle: false }));
  const seen = new Set(sessions.map((p) => sid8Of(p.id)));
  for (const l of lanes) {
    const s8 = sid8Of(l.owner_session_id);
    if (!l.owner_session_id || /^done$/.test(String(l.state)) || seen.has(s8)) continue;
    seen.add(s8);
    sessions.push({ id: l.owner_session_id, name: oneLine(l.owner_name) || `session ${s8}`, lanes: '', last_alive: null, idle: true });
  }
  const rowOfSid = (sid) => sessions.find((p) => sid8Of(p.id).toLowerCase() === String(sid ?? '').toLowerCase());
  // A publish.lock held by a session with no row (it exited, or it is not a peer and holds no lane) shows nowhere else: warn and block READY.
  const orphanLock = !!lockSid && !sessions.some((p) => sid8Of(p.id) === lockSid);
  if (orphanLock) {
    const ageMin = Number.isFinite(Date.parse(publishLock.at)) ? Math.round((now - Date.parse(publishLock.at)) / 60000) : null;
    warnings.push(`publish.lock is held by session ${lockSid} (key ${oneLine(publishLock.key) || 'unknown'}, since ${oneLine(publishLock.at) || 'unknown'}) and that session has no row. No row is READY until the seat reads the lock by hand.${ageMin !== null && ageMin > 20 ? ` It is over 20 minutes old: a refresh can take it over.` : ''}`);
  }
  // Run locks: one record for each lock file. A live lock of a session is that row's running work. Every lock blocks every other READY row.
  const lockList = Array.isArray(locks) ? locks : Array.from({ length: Number.isInteger(runLocks) && runLocks > 0 ? runLocks : 0 }, () => null);
  const ended = new Set(endedRuns);
  const runInfos = [];
  lockList.forEach((rec, i) => {
    if (!runLockOk(rec)) {
      warnings.push(`run lock file ${oneLine(rec && rec.file ? rec.file : String(i + 1))} is unreadable: it counts as a held lock (a pre-pr or hook build may be running). No row is READY until the seat reads it by hand.`);
      return;
    }
    const label = oneLine(rec.session);
    const sid = /#([0-9a-f]{8})/i.exec(rec.session)?.[1]?.toLowerCase() ?? null;
    const head = oneLine(rec.head);
    const stale = Number.isFinite(rec.expiresAt) && rec.expiresAt < now;
    const leftOver = ended.has(`${rec.pid}:${rec.head}`);
    const holder = sid && rowOfSid(sid) ? ` (${rowOfSid(sid).name})` : ' (no row)';
    runInfos.push({ sid, text: `${oneLine(rec.kind)} lock${head ? ` head ${head}` : ''} since ${hhmm(rec.startedAt)}` });
    warnings.push(`run lock: ${oneLine(rec.kind)}${head ? ` head ${head}` : ''} held by ${label}${holder} since ${hhmm(rec.startedAt)} CST${stale ? ' - STALE: past its expiresAt, it still blocks until the seat breaks it' : ''}${leftOver ? ' - LEFT OVER: runs.jsonl has its end line, the file was not removed' : ''}. No row is READY until the seat reads it.`);
  });
  const lockBlocks = lockUnreadable || orphanLock || lockList.length > 0;
  const seatLane = lanes.find((l) => l.id === 're-program' && l.owner_session_id);
  const seatPeer = seatLane ? sessions.find((p) => sid8Of(p.id) === sid8Of(seatLane.owner_session_id)) : null;
  const seat = seatPeer ? { name: seatPeer.name, sid8: sid8Of(seatPeer.id) } : null;
  const rows = sessions.map((p) => {
    const sid8 = sid8Of(p.id);
    const isSeat = !!seat && sid8 === seat.sid8;
    const mine = lanes.filter((l) => sid8Of(l.owner_session_id) === sid8 && !/^done$/.test(String(l.state)));
    const laneIds = String(p.lanes ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const ids = [...new Set([...laneIds, ...mine.map((l) => l.id)])];
    // Each lane is matched to a worktree alone (the lane branch, or a branch that ends with the lane id): a lane with none makes the row UNKNOWN.
    const matches = (w, id) => !w.primary && (String(w.branch ?? '').endsWith(`/${id}`) || mine.some((l) => l.id === id && l.branch && l.branch === w.branch));
    const wts = worktrees.filter((w) => ids.some((id) => matches(w, id)) || (isSeat && w.primary));
    wts.forEach((w) => used.add(w.path));
    const unmatchedLane = ids.some((id) => !(isSeat && id === 're-program') && !worktrees.some((w) => matches(w, id)));
    const known = (v) => typeof v === 'number';
    const tracked = wts.reduce((n, w) => n + (known(w.tracked) ? w.tracked : 0), 0);
    const untracked = wts.reduce((n, w) => n + (known(w.untracked) ? w.untracked : 0), 0);
    const trackedUnknown = wts.some((w) => !known(w.tracked));
    const behindUnknown = wts.some((w) => !known(w.behind));
    const aheadUnknown = wts.some((w) => !known(w.ahead));
    const behind = wts.reduce((n, w) => Math.max(n, known(w.behind) ? w.behind : 0), 0);
    const ahead = wts.reduce((n, w) => n + (known(w.ahead) ? w.ahead : 0), 0);
    const refresh = !!publishLock && !lockUnreadable && sid8Of(publishLock.session) === sid8;
    const own = runInfos.filter((r) => r.sid === sid8.toLowerCase());
    const shown = own.slice(0, MAX_RUNS_SHOWN).map((r) => r.text);
    if (own.length > MAX_RUNS_SHOWN) shown.push(`and ${own.length - MAX_RUNS_SHOWN} more`);
    if (refresh) shown.push('FleetOps refresh');
    const running = shown.join(', ') || 'nothing';
    // The notes of the lanes of the session: a warning only, except a hook build count (a build takes no lock).
    const signals = mine.map((l) => noteSignals(l.note));
    const hookBuildWord = signals.some((s) => s.hookBuildWord);
    const tooLong = signals.some((s) => s.tooLong);
    const noteWarning = [signals.some((s) => s.prePrOpen) && !own.some((r) => !/^hook-build/.test(r.text)) ? 'the note says a run is open, the lock log does not' : '', hookBuildWord && !own.some((r) => /^hook-build/.test(r.text)) ? 'the note has a HOOK BUILD START word and no END word, and the lock log has no hook-build lock' : ''].filter(Boolean).join('; ');
    // A non-seat row with no matched worktree has nothing read: its unsaved work is not seen, so it is never READY.
    const noWorktree = isSeat ? (unmatchedLane || !worktrees.some((w) => w.primary)) : (unmatchedLane || wts.length === 0);
    const stop = stopPoint({
      refresh, prePr: own.length > 0,
      tracked: tracked > 0 ? tracked : (trackedUnknown ? null : 0),
      behind: behindUnknown ? null : behind, ahead: aheadUnknown ? null : ahead,
      lockBlocks, noWorktree, noteUnknown: tooLong,
    });
    let next = NEXT[stop];
    if (stop === STOP.UNKNOWN) {
      if (tooLong) next = 'the lane note is over 64 KB and was not read: read the note by hand before any handoff word';
      else if (noWorktree) next = 'no worktree matched this session or one of its lanes: read its worktree status (git status) by hand before any handoff word';
    }
    const alive = Date.parse(p.last_alive);
    return {
      name: p.name, sid8, idle: !!p.idle, lanes: oneLine(ids.join(', ')) || '-', running, stop, noteWarning,
      next: next + (p.idle ? ' (idle: use SendMessage; a lane DM does not wake it)' : ''),
      uncommitted: tracked, untracked, behind: behindUnknown ? null : behind, ahead: aheadUnknown ? null : ahead, trackedUnknown, worktrees: wts.map((w) => w.path),
      idleSec: Number.isFinite(alive) ? Math.max(0, Math.round((now - alive) / 1000)) : null,
    };
  });
  const canSend = !!seat && sid8Of(me) === seat.sid8;
  const sendLine = !seat
    ? 'no session holds re-program on this board; /wrap-all sends nothing'
    : canSend ? `the seat (${seat.name} #${seat.sid8}) sends the WRAP WORD after Dave says go` : SEAT_ONLY_LINE;
  return {
    rows, seat, canSend, sendLine, forkMain, runLocks: lockList.length, warnings,
    unmatchedWorktrees: worktrees.filter((w) => !used.has(w.path)),
    wrapWord: wrapWordText(),
  };
}

const pad = (s, n) => String(s).padEnd(n).slice(0, Math.max(n, String(s).length));
const count = (v) => (typeof v === 'number' ? String(v) : '?');

export function renderTable(t) {
  const out = ['WRAP-ALL DRY RUN (read-only: this run sends nothing)'];
  const f = t.forkMain;
  out.push(f ? `behind and ahead counts use fork/main ${String(f.sha).slice(0, 8)} and the fork branches, last fetch ${f.fetchedAt ?? 'unknown'} (no fetch here)` : 'fork/main is not on disk; behind and ahead counts are unknown');
  if (t.runLocks != null) out.push(`run lock files held: ${t.runLocks}`);
  for (const w of t.warnings ?? []) out.push(`WARNING: ${w}`);
  out.push('');
  const head = ['SESSION', 'LANES', 'RUNNING', 'UNCOMMITTED', 'BEHIND', 'AHEAD', 'STOP POINT'];
  const lines = t.rows.map((r) => [
    `${r.name} #${r.sid8}${r.idle ? ' (idle)' : ''}`, r.lanes, r.running,
    r.trackedUnknown ? 'read failed' : `${r.uncommitted} tracked, ${r.untracked} untracked`, count(r.behind), count(r.ahead), r.stop,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
  out.push(head.map((h, i) => pad(h, w[i])).join('  '));
  for (const l of lines) out.push(l.map((c, i) => pad(c, w[i])).join('  '));
  out.push('');
  for (const r of t.rows) {
    out.push(`${r.name} #${r.sid8}: next, ${r.next}`);
    if (r.noteWarning) out.push(`${r.name} #${r.sid8}: NOTE: ${r.noteWarning}`);
  }
  if (t.unmatchedWorktrees.length) {
    out.push('', 'Worktrees with no live session (the seat names a folder before anyone removes it):');
    for (const u of t.unmatchedWorktrees) out.push(`  ${oneLine(u.path)} [${oneLine(u.branch) || 'detached'}] ${count(u.tracked)} tracked, ${count(u.untracked)} untracked, behind ${count(u.behind)}, ahead ${count(u.ahead)}`);
  }
  out.push('', `Send: ${t.sendLine}`, '', 'WRAP WORD text (printed, not sent):', t.wrapWord);
  return out.join('\n');
}

// ---------- real reads (each one is read-only) ----------

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The lane CLI path can be injected (WRAP_ALL_LANE_CLI) so a test, or a runner with no ~/.claude, reads a fake one.
const LANE_CLI = process.env.WRAP_ALL_LANE_CLI || path.join(os.homedir(), '.claude', 'scripts', 'lane.mjs');
const runLockDir = () => process.env.RUN_LOCK_DIR || path.join(os.homedir(), '.claude', 'state', 'run-locks');

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
 * Every worktree of the repo, each read once. `sha` is the one full fork/main sha that every behind count uses. The first worktree of the list is the
 * primary checkout (primary: true). `ahead` is the count of commits not on fork/<branch>, or beyond fork/main when the branch was never pushed.
 * A failed git read is null, never zero: the table shows UNKNOWN. A failed worktree list is an error (no table without it). `git` is injectable.
 */
export function readWorktrees(root, { git: g = git, sha = 'refs/remotes/fork/main' } = {}) {
  const list = g(root, 'worktree', 'list', '--porcelain');
  if (list === null || list === undefined) throw new Error('git worktree list failed: no table without the worktrees');
  const out = [];
  let first = true;
  for (const block of list.split(/\r?\n\r?\n/)) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    if (!wt) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    const status = g(wt, 'status', '--porcelain');
    const lines = status == null ? null : status.split(/\r?\n/).filter(Boolean);
    const untracked = lines ? lines.filter((l) => l.startsWith('??')).length : null;
    const countOut = g(wt, 'rev-list', '--count', `HEAD..${sha}`);
    const n = countOut == null ? NaN : Number(String(countOut).trim());
    let ahead = null;
    if (branch) {
      const remote = `refs/remotes/fork/${branch}`;
      const hasRemote = g(wt, 'rev-parse', '--verify', '--quiet', remote);
      const a = g(wt, 'rev-list', '--count', `${hasRemote ? remote : sha}..HEAD`);
      const m = a == null ? NaN : Number(String(a).trim());
      ahead = Number.isInteger(m) ? m : null;
    }
    out.push({ path: wt.replace(/\\/g, '/'), branch, primary: first, tracked: lines ? lines.length - untracked : null, untracked, behind: Number.isInteger(n) ? n : null, ahead });
    first = false;
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

/**
 * One record for each lock file of the run lock folder (gate.lock is not a run). A file that does not parse, or is not a record of run-lock.mjs, is
 * { unreadable: true, file }. A missing folder is no lock.
 */
export function readRunLockRecords(dir = runLockDir()) {
  let names;
  try { names = readdirSync(dir); } catch (e) {
    // A missing folder is no lock. A folder that exists and cannot be listed is a held lock: nothing proves that no run is there.
    return e && e.code === 'ENOENT' ? [] : [{ unreadable: true, file: '(lock folder)' }];
  }
  return names.filter((f) => f.endsWith('.lock') && f !== 'gate.lock').map((f) => {
    const file = path.join(dir, f);
    let st;
    try { st = lstatSync(file); } catch { return { unreadable: true, file: f }; }
    if (st.isSymbolicLink() || !st.isFile() || st.size > 64 * 1024) return { unreadable: true, file: f };
    const rec = readJson(file);
    return runLockOk(rec) ? rec : { unreadable: true, file: f };
  });
}

/** "pid:head" of the end lines in the last two hundred lines of runs.jsonl. A line that does not parse is skipped. A missing file is none. */
export function readEndedRuns(dir = runLockDir()) {
  const file = path.join(dir, 'runs.jsonl');
  if (!existsSync(file)) return [];
  const ended = new Set();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-200)) {
    try { const r = JSON.parse(line); if (r && r.event === 'end' && r.pid != null) ended.add(`${r.pid}:${r.head ?? ''}`); } catch { /* skip */ }
  }
  return [...ended];
}

/**
 * null when there is no lock file; the record when it parses; { unreadable: true } when the file is there and cannot be read: a symlink (also a
 * dangling one), a folder, a file over 64 KB, or a file that does not parse.
 */
export function readPublishLock(file = process.env.WRAP_ALL_PUBLISH_LOCK || path.join(os.homedir(), '.claude', 'state', 'lane-dash', 'publish.lock')) {
  let st;
  try { st = lstatSync(file); } catch { return null; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > 64 * 1024) return { unreadable: true };
  const rec = readJson(file);
  return validLock(rec) ? rec : { unreadable: true };
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
  const locks = readRunLockRecords();
  return { peers, lanes: board.lanes, worktrees, publishLock: readPublishLock(), forkMain, now: Date.now(), me: me || sid8Of(board.me), locks, runLocks: locks.length, endedRuns: readEndedRuns() };
}

/** --root <dir>: the repo whose fork/main and worktrees are read (default: the repo of this file). */
function rootArg(argv) {
  const i = argv.indexOf('--root');
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
}

function main() {
  let table;
  try { table = buildTable(gather(rootArg(process.argv))); } catch (err) {
    console.error(`wrap-all-table: ${String(err.message).split('\n')[0]}`);
    process.exit(1);
  }
  console.log(process.argv.includes('--json') ? JSON.stringify(table) : renderTable(table));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
