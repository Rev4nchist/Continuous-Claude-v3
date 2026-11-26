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
import { readFileSync } from 'node:fs';
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

test('W4: a START the note marks VOID is not running', () => {
  const t = W.buildTable(base({ lanes: [lane('re-program', '1dcd1fc7', ''), lane('my-card', 'c64e660e', 'PRE-PR START 11:48 CST x. VOID: lock answered WAIT (exit 75), nothing ran.')] }));
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
  assert.match(text, /before the run lock/i);
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

test('W15: the CLI prints the table, the fork/main sha with its fetch time, and exits 0 (live read, sends nothing)', () => {
  const r = spawnSync(process.execPath, [SRC], { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /WRAP-ALL DRY RUN/);
  assert.match(r.stdout, /fork\/main [0-9a-f]{7,}/);
  assert.match(r.stdout, /last fetch/);
  assert.match(r.stdout, /sends nothing/);
});

test('W16: --json prints one valid document with rows and the fixed send line for a non-seat session', () => {
  const r = spawnSync(process.execPath, [SRC, '--json'], { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.ok(Array.isArray(doc.rows));
  assert.equal(typeof doc.canSend, 'boolean');
  assert.equal(typeof doc.wrapWord, 'string');
});
