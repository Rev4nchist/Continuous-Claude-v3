// Tests for wrap-all-table.mjs (card seat-wrap-all-skill). The helper is the dry run of /wrap-all: it reads, prints a table, sends nothing.
// How each rule can fail, and the row that catches it:
//   a running pre-pr or hook build is not a WAIT FOR END                       -> W1, W2
//   a START that a later END closed still counts as running                    -> W3
//   a VOID START counts as running                                             -> W4
//   a plain mention of the words (no time) counts as a START                   -> W5
//   uncommitted tracked work is not SAVE PATCH                                 -> W6
//   an untracked file alone gives SAVE PATCH (the primary has many)            -> W7
//   a behind count above zero is not MERGE MAIN BY V7.10                       -> W8
//   a held FleetOps publish lock is not RELEASE LOCK FIRST, and it wins        -> W9
//   an idle clean session is not READY TO WRAP                                 -> W10
//   the seat is not found, or a non-seat session is allowed to send            -> W11, W12
//   the WRAP WORD misses a failure of 11-26, or tells a session to start       -> W13
//   the helper source runs say, SendMessage, rm or git fetch                   -> W14
//   the CLI prints no table, no fork/main sha and no fetch time                -> W15
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as W from './wrap-all-table.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'wrap-all-table.mjs');

const NOW = Date.parse('2026-11-26T18:00:00Z');
const peer = (name, sid8, lanes) => ({ id: `${sid8}-0000-0000-0000-000000000000`, name, label: `${name} #${sid8}`, lanes, last_alive: new Date(NOW - 20000).toISOString() });
const lane = (id, sid8, note = '', branch = null) => ({ id, owner_session_id: `${sid8}-0000-0000-0000-000000000000`, owner_name: 'x', note, branch, state: 'active' });
const base = (over = {}) => ({
  peers: [peer('RE program seat', '1dcd1fc7', 're-program'), peer('Coord standard', 'c64e660e', 'my-card')],
  lanes: [lane('re-program', '1dcd1fc7', 'seat tick'), lane('my-card', 'c64e660e', 'GOAL: x. WAITS ON: seat.', 'coord/my-card')],
  worktrees: [], publishLock: null, forkMain: { sha: '92492fd8', fetchedAt: '2026-11-26T17:40:00Z' }, now: NOW, me: 'c64e660e',
  ...over,
});
const rowOf = (table, name) => table.rows.find((r) => r.name === name);

test('W1: a PRE-PR START with a time and no END is running work: WAIT FOR END', () => {
  const t = W.buildTable(base({ lanes: [lane('re-program', '1dcd1fc7', ''), lane('my-card', 'c64e660e', 'PRE-PR START 11:48 CST head abc. WAITS ON: this run.')] }));
  assert.equal(rowOf(t, 'Coord standard').stop, W.STOP.WAIT_END);
  assert.match(rowOf(t, 'Coord standard').running, /pre-pr/);
});

test('W2: a HOOK BUILD START with no END is running work: WAIT FOR END', () => {
  const t = W.buildTable(base({ lanes: [lane('re-program', '1dcd1fc7', ''), lane('my-card', 'c64e660e', 'HOOK BUILD START 11:50 CST (clock read). WAITS ON: this build.')] }));
  assert.equal(rowOf(t, 'Coord standard').stop, W.STOP.WAIT_END);
  assert.match(rowOf(t, 'Coord standard').running, /hook build/);
});

test('W3: a START that a later END closed is not running', () => {
  const t = W.buildTable(base({ lanes: [lane('re-program', '1dcd1fc7', ''), lane('my-card', 'c64e660e', 'PRE-PR START 11:48 CST x. PRE-PR END 11:51 CST PASS.')] }));
  assert.equal(rowOf(t, 'Coord standard').stop, W.STOP.READY);
});

test('W4: a START that a VOID names (by its time and head) is not running', () => {
  const t = W.buildTable(base({ lanes: [lane('re-program', '1dcd1fc7', ''), lane('my-card', 'c64e660e', 'PRE-PR START 11:48 CST head abc1234. VOID 11:50 CST: the PRE-PR START of 11:48 for head abc1234 is VOID, the lock answered WAIT (exit 75), nothing ran.')] }));
  assert.equal(rowOf(t, 'Coord standard').stop, W.STOP.READY);
});

test('W5: the words with no time are a rule, not a START (a wrap word says no new PRE-PR START)', () => {
  assert.equal(W.runningWork('WRAP: no new PRE-PR START, hook build or paid run.').prePr, false);
  assert.equal(W.runningWork('HOOK BUILD START without an END').hookBuild, false);
});

test('W6: uncommitted tracked work in the worktree of the lane is SAVE PATCH', () => {
  const t = W.buildTable(base({ worktrees: [{ path: 'C:/r/.claude/worktrees/mc', branch: 'coord/my-card', tracked: 3, untracked: 0, behind: 0 }] }));
  assert.equal(rowOf(t, 'Coord standard').stop, W.STOP.SAVE_PATCH);
  assert.equal(rowOf(t, 'Coord standard').uncommitted, 3);
});

test('W7: untracked files alone do not make SAVE PATCH, and they are counted', () => {
  const t = W.buildTable(base({ worktrees: [{ path: 'C:/r/.claude/worktrees/mc', branch: 'coord/my-card', tracked: 0, untracked: 40, behind: 0 }] }));
  assert.equal(rowOf(t, 'Coord standard').stop, W.STOP.READY);
  assert.equal(rowOf(t, 'Coord standard').untracked, 40);
});

test('W8: a worktree behind fork/main is MERGE MAIN BY V7.10 when it is clean', () => {
  const t = W.buildTable(base({ worktrees: [{ path: 'C:/r/.claude/worktrees/mc', branch: 'coord/my-card', tracked: 0, untracked: 0, behind: 2 }] }));
  assert.equal(rowOf(t, 'Coord standard').stop, W.STOP.MERGE_MAIN);
  assert.equal(rowOf(t, 'Coord standard').behind, 2);
});

test('W9: a held FleetOps publish lock is RELEASE LOCK FIRST and wins over every other stop', () => {
  const t = W.buildTable(base({
    lanes: [lane('re-program', '1dcd1fc7', ''), lane('my-card', 'c64e660e', 'PRE-PR START 11:48 CST x.')],
    worktrees: [{ path: 'C:/r/.claude/worktrees/mc', branch: 'coord/my-card', tracked: 2, untracked: 0, behind: 1 }],
    publishLock: { session: 'c64e660e', key: 'k', at: new Date(NOW - 60000).toISOString() },
  }));
  assert.equal(rowOf(t, 'Coord standard').stop, W.STOP.RELEASE_LOCK);
  assert.equal(rowOf(t, 'RE program seat').stop, W.STOP.READY, 'only the holder of the lock gets the stop');
});

test('W10: an idle clean session is READY TO WRAP', () => {
  const t = W.buildTable(base());
  assert.equal(rowOf(t, 'Coord standard').stop, W.STOP.READY);
});

test('W11: the seat is the holder of re-program; no holder gives null and the skill sends nothing', () => {
  assert.equal(W.buildTable(base()).seat.name, 'RE program seat');
  const none = W.buildTable(base({ lanes: [lane('my-card', 'c64e660e', '')] }));
  assert.equal(none.seat, null);
  assert.equal(none.canSend, false);
  assert.match(none.sendLine, /no session holds re-program/);
});

test('W12: only the seat sends; any other session gets the dry run and the fixed line', () => {
  assert.equal(W.buildTable(base({ me: 'c64e660e' })).canSend, false);
  assert.equal(W.buildTable(base({ me: 'c64e660e' })).sendLine, 'only the seat sends; run /wrap-all in the seat session');
  assert.equal(W.buildTable(base({ me: '1dcd1fc7' })).canSend, true);
});

test('W13: the WRAP WORD names the three failures of 11-26, forbids new starts and never tells a session to start', () => {
  const text = W.wrapWordText();
  assert.match(text, /no new PRE-PR START, HOOK BUILD START or paid run/);
  assert.match(text, /after PREFLIGHT PASS and the V7\.3 reads, and before the run/);
  assert.match(text, /VOID/);
  assert.doesNotMatch(text, /only after PREFLIGHT PASS and the grant/);
  assert.match(text, /A folder removed before the seat named it/);
  assert.match(text, /Remove no folder and no worktree/);
  assert.match(text, /FleetOps refresh/);
  assert.match(text, /step 6\.1/);
  assert.match(text, /HANDOFF DONE/);
  assert.doesNotMatch(text, /(^|\n)\s*(send|write|run) (a )?(PRE-PR|HOOK BUILD) START/i);
});

test('W14: the helper source runs no say, SendMessage, rm or fetch', () => {
  const src = readFileSync(SRC, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /spawnSync\([^)]*['"]say['"]/);
  assert.doesNotMatch(src, /SendMessage\s*\(/);
  assert.doesNotMatch(src, /\brmSync\b|\bunlinkSync\b|\brmdirSync\b|\bwriteFileSync\b|\bappendFileSync\b/);
  assert.doesNotMatch(src, /['"]fetch['"]/);
  assert.doesNotMatch(src, /['"]note['"]|['"]claim['"]|['"]done['"]/);
});

// The CLI rows run the real helper against a fake lane CLI and a fake repo, so they need no ~/.claude and no real fork/main (a fresh CI runner has neither).
function hermetic() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wrapall-herm-'));
  const repo = path.join(dir, 'repo');
  mkdirSync(repo);
  const run = (...args) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', windowsHide: true });
  run('init', '-q', '-b', 'main');
  run('commit', '-q', '--allow-empty', '-m', 'base');
  const sha = run('rev-parse', 'HEAD').stdout.trim();
  run('update-ref', 'refs/remotes/fork/main', sha);
  const SEAT = 'aaaaaaaa-0000-0000-0000-000000000000';
  const cli = path.join(dir, 'lane-fake.mjs');
  writeFileSync(cli, [
    "const verb = process.argv[2];",
    `const seat = { id: '${SEAT}', name: 'Fake seat', label: 'Fake seat #aaaaaaaa', lanes: 're-program', last_alive: new Date().toISOString() };`,
    "if (verb === 'peers') console.log(JSON.stringify([seat]));",
    `else if (verb === 'board') console.log(JSON.stringify({ me: '${SEAT}', lanes: [{ id: 're-program', owner_session_id: '${SEAT}', owner_name: 'Fake seat', note: '', branch: null, state: 'active' }] }));`,
    "else process.exit(2);",
  ].join('\n'));
  const env = { ...process.env, WRAP_ALL_LANE_CLI: cli, CLAUDE_CODE_SESSION_ID: 'bbbbbbbb-0000-0000-0000-000000000000', RUN_LOCK_DIR: dir, WRAP_ALL_PUBLISH_LOCK: path.join(dir, 'publish.lock') };
  return { dir, repo, sha, cli, env };
}

test('W15: the CLI prints the table, the fork/main sha with its fetch time, and exits 0 (fake lane CLI and repo, sends nothing)', () => {
  const h = hermetic();
  const r = spawnSync(process.execPath, [SRC, '--root', h.repo], { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 60000, env: h.env });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /WRAP-ALL DRY RUN/);
  assert.match(r.stdout, /Fake seat #aaaaaaaa/);
  assert.ok(r.stdout.includes(`fork/main ${h.sha.slice(0, 8)}`), r.stdout);
  assert.match(r.stdout, /last fetch/);
  assert.match(r.stdout, /sends nothing/);
});

test('W16: --json prints one valid document with rows and the fixed send line for a non-seat session', () => {
  const h = hermetic();
  const r = spawnSync(process.execPath, [SRC, '--root', h.repo, '--json'], { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 60000, env: h.env });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.rows.length, 1);
  assert.equal(doc.rows[0].name, 'Fake seat');
  assert.equal(doc.canSend, false);
  assert.equal(doc.sendLine, 'only the seat sends; run /wrap-all in the seat session');
  assert.equal(doc.forkMain.sha, h.sha);
  assert.equal(typeof doc.wrapWord, 'string');
});

test('W37: a lane CLI path that does not exist stops the helper with one error line and exit 1 (no empty table)', () => {
  const h = hermetic();
  const r = spawnSync(process.execPath, [SRC, '--root', h.repo], { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...h.env, WRAP_ALL_LANE_CLI: path.join(h.dir, 'no-such-cli.mjs') } });
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /^wrap-all-table: /m);
  assert.equal(r.stdout.trim(), '');
});

// ---------- W17 to W24: the findings of the first CLI review (6 findings; four of them made a row read READY when it was not) ----------
//   an idle lane holder (not in peers) is missing from the table                                -> W17
//   a worktree whose branch is the lane branch but has no /<lane id> suffix is dropped          -> W18
//   a worktree that matches no live session is not listed                                       -> W19
//   the notes of two lanes of one session cancel each other's START and END                     -> W20
//   a failed read (null) counts as zero changes or zero behind and the row reads READY          -> W21
//   an unknown read hides known unsaved work                                                    -> W22
//   the counts use one fork/main sha and the table shows the same sha                           -> W23
//   an unreadable publish.lock gives no warning and a READY row                                 -> W24
const A = (name) => (t) => t.rows.find((r) => r.name === name);

test('W17: an idle lane holder (in no peers row) still gets a row, marked idle, with the SendMessage hint', () => {
  const t = W.buildTable(base({
    peers: [peer('RE program seat', '1dcd1fc7', 're-program')],
    lanes: [lane('re-program', '1dcd1fc7', ''), { ...lane('quiet-card', 'ab12cd34', 'WAITS ON: seat.'), owner_name: 'Quiet builder' }],
  }));
  const r = t.rows.find((x) => x.sid8 === 'ab12cd34');
  assert.ok(r, 'the idle holder has a row');
  assert.equal(r.idle, true);
  assert.equal(r.name, 'Quiet builder');
  assert.match(r.next, /SendMessage/);
  assert.equal(r.lanes, 'quiet-card');
});

test('W18: a worktree on the exact lane branch (no /<lane id> suffix) is matched and its tracked work is SAVE PATCH', () => {
  const t = W.buildTable(base({
    lanes: [lane('re-program', '1dcd1fc7', ''), lane('my-card', 'c64e660e', '', 'feat/save-work')],
    worktrees: [{ path: 'C:/r/wt/sw', branch: 'feat/save-work', tracked: 2, untracked: 0, behind: 0 }],
  }));
  assert.equal(A('Coord standard')(t).stop, W.STOP.SAVE_PATCH);
  assert.equal(t.unmatchedWorktrees.length, 0);
});

test('W19: a worktree that matches no live session is listed as unmatched', () => {
  const t = W.buildTable(base({ worktrees: [{ path: 'C:/r/wt/old', branch: 'feat/other', tracked: 1, untracked: 0, behind: 3 }] }));
  assert.deepEqual(t.unmatchedWorktrees.map((w) => w.path), ['C:/r/wt/old']);
  assert.match(W.renderTable(t), /C:\/r\/wt\/old/);
});

test('W20: two lanes of one session: a finished run in one lane cannot hide an active START in the other', () => {
  const t = W.buildTable(base({
    lanes: [
      lane('re-program', '1dcd1fc7', ''),
      lane('card-a', 'c64e660e', 'PRE-PR START 11:48 CST head abc. WAITS ON: this run.'),
      lane('card-b', 'c64e660e', 'PRE-PR START 10:00 CST x. PRE-PR END 10:10 CST PASS.'),
    ],
  }));
  assert.equal(A('Coord standard')(t).stop, W.STOP.WAIT_END);
  assert.match(A('Coord standard')(t).lanes, /card-a, card-b|card-b, card-a/);
});

test('W21: a failed read is UNKNOWN, never READY: tracked null and behind null', () => {
  const wt = (over) => ({ path: 'C:/r/wt/mc', branch: 'coord/my-card', tracked: 0, untracked: 0, behind: 0, ...over });
  assert.equal(A('Coord standard')(W.buildTable(base({ worktrees: [wt({ tracked: null })] }))).stop, W.STOP.UNKNOWN);
  assert.equal(A('Coord standard')(W.buildTable(base({ worktrees: [wt({ behind: null })] }))).stop, W.STOP.UNKNOWN);
  assert.notEqual(W.STOP.UNKNOWN, W.STOP.READY);
});

test('W22: known unsaved work still shows SAVE PATCH when another read failed', () => {
  const t = W.buildTable(base({ worktrees: [{ path: 'C:/r/wt/mc', branch: 'coord/my-card', tracked: 2, untracked: 0, behind: null }] }));
  assert.equal(A('Coord standard')(t).stop, W.STOP.SAVE_PATCH);
});

test('W23: readWorktrees passes one full fork/main sha to every rev-list, and a failed git read is null, not zero', () => {
  const sha = 'a'.repeat(40);
  const calls = [];
  const porcelain = 'worktree C:/r/one\nHEAD 1\nbranch refs/heads/feat/one\n\nworktree C:/r/two\nHEAD 2\nbranch refs/heads/feat/two\n';
  const git = (cwd, ...args) => {
    calls.push([cwd, ...args].join(' '));
    if (args[0] === 'worktree') return porcelain;
    if (args[0] === 'status') return cwd === 'C:/r/two' ? null : ' M a.txt\n?? b.txt\n';
    if (args[0] === 'rev-list') return cwd === 'C:/r/two' ? null : '2\n';
    return null;
  };
  const wts = W.readWorktrees('C:/r', { git, sha });
  assert.equal(wts.length, 2, 'every worktree is read');
  assert.deepEqual([wts[0].tracked, wts[0].untracked, wts[0].behind], [1, 1, 2]);
  assert.deepEqual([wts[1].tracked, wts[1].untracked, wts[1].behind], [null, null, null]);
  const revs = calls.filter((c) => /rev-list/.test(c));
  assert.equal(revs.length, 2);
  for (const c of revs) assert.ok(c.endsWith(`HEAD..${sha}`), c);
  const t = W.buildTable(base({ forkMain: { sha, fetchedAt: null } }));
  assert.match(W.renderTable(t), new RegExp(`fork/main ${sha.slice(0, 8)}`));
});

test('W24: an unreadable publish.lock gives a warning and no READY row', () => {
  const t = W.buildTable(base({ publishLock: { unreadable: true } }));
  assert.ok(t.warnings.some((w) => /publish\.lock/.test(w)));
  assert.equal(t.rows.some((r) => r.stop === W.STOP.READY), false);
  assert.ok(t.rows.every((r) => r.stop === W.STOP.UNKNOWN));
  assert.match(W.renderTable(t), /publish\.lock/);
});

// ---------- W25 to W35: the card wrap-all-limits (two gaps named in the PR of the skill) ----------
//   a publish.lock held by a session with no row shows nowhere, and a row reads READY            -> W25, W26
//   a lock held by a listed session now warns too, or an old orphan lock reads as fresh           -> W27, W28
//   a VOID of an earlier START closes the new run                                                  -> W29
//   a VOID that names a head closes the wrong START                                                -> W30
//   the VOID's own clock stamp counts as a tie                                                     -> W31
//   a VOID of one kind closes the other kind                                                       -> W32
//   an untied VOID closes a run (seat ruling: it closes nothing, also right after a START)        -> W33
//   the real note shape of 11-26 (START, then a VOID that names the time and the head)            -> W34
//   the open run does not print its time and head                                                  -> W35
const NOTE_RUN = (extra) => base({ lanes: [lane('re-program', '1dcd1fc7', ''), lane('my-card', 'c64e660e', extra)] });

test('W25: a publish.lock held by a session with no row gives a table warning that names the session and the lock time', () => {
  const t = W.buildTable(base({ publishLock: { session: 'dead0001', key: 'k1', at: new Date(NOW - 5 * 60000).toISOString() } }));
  assert.ok(t.warnings.some((w) => /publish\.lock/.test(w) && /dead0001/.test(w) && /no row/.test(w)), t.warnings.join('\n'));
  assert.match(W.renderTable(t), /dead0001/);
});

test('W26: with an orphan publish.lock no row reads READY; known stops stay', () => {
  const t = W.buildTable(base({
    publishLock: { session: 'dead0001', key: 'k1', at: new Date(NOW - 60000).toISOString() },
    worktrees: [{ path: 'C:/r/wt/mc', branch: 'coord/my-card', tracked: 2, untracked: 0, behind: 0 }],
  }));
  assert.equal(t.rows.some((r) => r.stop === W.STOP.READY), false);
  assert.equal(A('Coord standard')(t).stop, W.STOP.SAVE_PATCH);
  assert.equal(A('RE program seat')(t).stop, W.STOP.UNKNOWN);
});

test('W27: a lock held by a listed session gives RELEASE LOCK FIRST for that row only and no orphan warning', () => {
  const t = W.buildTable(base({ publishLock: { session: 'c64e660e', key: 'k1', at: new Date(NOW - 60000).toISOString() } }));
  assert.equal(A('Coord standard')(t).stop, W.STOP.RELEASE_LOCK);
  assert.equal(A('RE program seat')(t).stop, W.STOP.READY);
  assert.deepEqual(t.warnings, []);
});

test('W28: an orphan lock older than 20 minutes says it is stale and still blocks READY', () => {
  const t = W.buildTable(base({ publishLock: { session: 'dead0001', key: 'k1', at: new Date(NOW - 45 * 60000).toISOString() } }));
  assert.ok(t.warnings.some((w) => /over 20 minutes old/.test(w)), t.warnings.join('\n'));
  assert.equal(t.rows.some((r) => r.stop === W.STOP.READY), false);
});

test('W29: a VOID of an earlier START does not close the newer run', () => {
  const t = W.buildTable(NOTE_RUN('PRE-PR START 13:32 CST head ffc4e110. VOID 13:33 CST: the PRE-PR START of 13:32 for head ffc4e110 is VOID. PRE-PR START 14:03 CST head de0dd692, CLI run 2 of 2.'));
  assert.equal(A('Coord standard')(t).stop, W.STOP.WAIT_END);
  assert.match(A('Coord standard')(t).running, /14:03/);
  assert.doesNotMatch(A('Coord standard')(t).running, /13:32/);
});

test('W30: a VOID that names a head closes only the START of that head', () => {
  const t = W.buildTable(NOTE_RUN('PRE-PR START 13:32 CST head aaa1111. PRE-PR START 14:03 CST head bbb2222. VOID: the run of head aaa1111 never ran.'));
  const r = A('Coord standard')(t);
  assert.equal(r.stop, W.STOP.WAIT_END);
  assert.match(r.running, /bbb2222/);
  assert.doesNotMatch(r.running, /aaa1111/);
});

test('W31: the clock stamp of the VOID itself is not a tie', () => {
  const t = W.buildTable(NOTE_RUN('PRE-PR START 13:33 CST head aaa1111. PRE-PR START 13:32 CST head bbb2222. VOID 13:33 CST: the PRE-PR START of 13:32 never ran.'));
  const r = A('Coord standard')(t);
  assert.equal(r.stop, W.STOP.WAIT_END, 'the 13:33 START stays open');
  assert.match(r.running, /13:33/);
  assert.doesNotMatch(r.running, /13:32/);
});

test('W32: a VOID that names the PRE-PR kind does not close a HOOK BUILD START', () => {
  const t = W.buildTable(NOTE_RUN('HOOK BUILD START 12:00 CST. PRE-PR START 12:00 CST. VOID: the PRE-PR START of 12:00 never ran.'));
  const r = A('Coord standard')(t);
  assert.match(r.running, /hook build/);
  assert.doesNotMatch(r.running, /pre-pr/);
});

test('W33: an untied VOID closes nothing, also when it comes right after the START (seat ruling: a false running fails closed)', () => {
  const t = W.buildTable(NOTE_RUN('PRE-PR START 11:48 CST x. VOID: lock answered WAIT (exit 75), nothing ran.'));
  assert.equal(A('Coord standard')(t).stop, W.STOP.WAIT_END);
});

test('W34: the note shape of 11-26 (a START, then a VOID that names its time and head) closes that START', () => {
  const t = W.buildTable(NOTE_RUN('PRE-PR START 13:32 CST (clock read) head ffc4e110, new stamp. VOID 13:33 CST (clock read): the PRE-PR START of 13:32 for head ffc4e110 is VOID. The run lock answered WAIT (exit 75). Nothing ran.'));
  assert.equal(A('Coord standard')(t).stop, W.STOP.READY);
});

test('W35: an open run prints its kind, its time and its head in the running column', () => {
  const t = W.buildTable(NOTE_RUN('PRE-PR START 14:03 CST (clock read) head de0dd692, CLI run 2 of 2.'));
  const r = A('Coord standard')(t);
  assert.match(r.running, /pre-pr/);
  assert.match(r.running, /14:03/);
  assert.match(r.running, /de0dd692/);
});

test('W36: a START with no head does not take the head of the next START', () => {
  const t = W.buildTable(NOTE_RUN('PRE-PR START 13:00 CST. PRE-PR START 14:03 CST head bbb2222.'));
  const r = A('Coord standard')(t);
  assert.match(r.running, /pre-pr START 13:00(,|$)/);
  assert.match(r.running, /pre-pr START 14:03 head bbb2222/);
});

test('W38: the CLI reads the injected publish.lock: an orphan lock gives a warning and no READY row, an unparsable file is unreadable', () => {
  const h = hermetic();
  const lockFile = path.join(h.dir, 'publish.lock');
  writeFileSync(lockFile, JSON.stringify({ session: 'dead0001', key: 'k1', at: new Date().toISOString() }));
  const orphan = JSON.parse(spawnSync(process.execPath, [SRC, '--root', h.repo, '--json'], { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 60000, env: h.env }).stdout);
  assert.ok(orphan.warnings.some((w) => /dead0001/.test(w)), orphan.warnings.join('\n'));
  assert.equal(orphan.rows.some((r) => r.stop === W.STOP.READY), false);
  writeFileSync(lockFile, '{not json');
  const bad = JSON.parse(spawnSync(process.execPath, [SRC, '--root', h.repo, '--json'], { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 60000, env: h.env }).stdout);
  assert.ok(bad.warnings.some((w) => /cannot be read/.test(w)), bad.warnings.join('\n'));
});
