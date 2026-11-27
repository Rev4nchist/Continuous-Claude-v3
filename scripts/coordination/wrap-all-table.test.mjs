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
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
  worktrees: [{ path: 'C:/r/wt/base', branch: 'coord/my-card', tracked: 0, untracked: 0, behind: 0, ahead: 0 }], publishLock: null, forkMain: { sha: '92492fd8', fetchedAt: '2026-11-26T17:40:00Z' }, now: NOW, me: 'c64e660e',
  ...over,
});
const rowOf = (table, name) => table.rows.find((r) => r.name === name);

test('W5: the words with no time and no pid are a rule, not a START (a wrap word says no new PRE-PR START)', () => {
  assert.equal(W.noteSignals('WRAP: no new PRE-PR START, HOOK BUILD START or paid run.').prePrOpen, false);
  assert.equal(W.noteSignals('WRAP: no new PRE-PR START, HOOK BUILD START or paid run.').hookBuildOpen, false);
  assert.equal(W.noteSignals('HOOK BUILD START without an END').hookBuildOpen, false);
});

test('W6: uncommitted tracked work in the worktree of the lane is SAVE PATCH', () => {
  const t = W.buildTable(base({ worktrees: [{ path: 'C:/r/.claude/worktrees/mc', branch: 'coord/my-card', tracked: 3, untracked: 0, behind: 0, ahead: 0 }] }));
  assert.equal(rowOf(t, 'Coord standard').stop, W.STOP.SAVE_PATCH);
  assert.equal(rowOf(t, 'Coord standard').uncommitted, 3);
});

test('W7: untracked files alone do not make SAVE PATCH, and they are counted', () => {
  const t = W.buildTable(base({ worktrees: [{ path: 'C:/r/.claude/worktrees/mc', branch: 'coord/my-card', tracked: 0, untracked: 40, behind: 0, ahead: 0 }] }));
  assert.equal(rowOf(t, 'Coord standard').stop, W.STOP.READY);
  assert.equal(rowOf(t, 'Coord standard').untracked, 40);
});

test('W8: a worktree behind fork/main is MERGE MAIN BY V7.10 when it is clean', () => {
  const t = W.buildTable(base({ worktrees: [{ path: 'C:/r/.claude/worktrees/mc', branch: 'coord/my-card', tracked: 0, untracked: 0, behind: 2, ahead: 0 }] }));
  assert.equal(rowOf(t, 'Coord standard').stop, W.STOP.MERGE_MAIN);
  assert.equal(rowOf(t, 'Coord standard').behind, 2);
});

test('W9: a held FleetOps publish lock is RELEASE LOCK FIRST and wins over every other stop', () => {
  const t = W.buildTable(base({
    lanes: [lane('re-program', '1dcd1fc7', ''), lane('my-card', 'c64e660e', 'PRE-PR START 11:48 CST x.')],
    worktrees: [{ path: 'C:/r/.claude/worktrees/mc', branch: 'coord/my-card', tracked: 2, untracked: 0, behind: 1, ahead: 0 }],
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
  const runLockDir = path.join(dir, 'runlocks');
  mkdirSync(runLockDir);
  const env = { ...process.env, WRAP_ALL_LANE_CLI: cli, CLAUDE_CODE_SESSION_ID: 'bbbbbbbb-0000-0000-0000-000000000000', RUN_LOCK_DIR: runLockDir, WRAP_ALL_PUBLISH_LOCK: path.join(dir, 'publish.lock') };
  return { dir, repo, sha, cli, env, runLockDir };
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
    worktrees: [{ path: 'C:/r/wt/sw', branch: 'feat/save-work', tracked: 2, untracked: 0, behind: 0, ahead: 0 }],
  }));
  assert.equal(A('Coord standard')(t).stop, W.STOP.SAVE_PATCH);
  assert.equal(t.unmatchedWorktrees.length, 0);
});

test('W19: a worktree that matches no live session is listed as unmatched', () => {
  const t = W.buildTable(base({ worktrees: [{ path: 'C:/r/wt/old', branch: 'feat/other', tracked: 1, untracked: 0, behind: 3, ahead: 0 }] }));
  assert.deepEqual(t.unmatchedWorktrees.map((w) => w.path), ['C:/r/wt/old']);
  assert.match(W.renderTable(t), /C:\/r\/wt\/old/);
});

test('W20: two lanes of one session: each note is counted alone, a finished hook build in one lane cannot hide an open one in the other', () => {
  const t = W.buildTable(base({
    lanes: [
      lane('re-program', '1dcd1fc7', ''),
      lane('card-a', 'c64e660e', 'HOOK BUILD START 11:48 CST head abc. WAITS ON: this build.', 'coord/card-a'),
      lane('card-b', 'c64e660e', 'HOOK BUILD START 10:00 CST x. HOOK BUILD END 10:10 CST.', 'coord/card-b'),
    ],
    peers: [peer('RE program seat', '1dcd1fc7', 're-program'), peer('Coord standard', 'c64e660e', 'card-a,card-b')],
    worktrees: [
      { path: 'C:/r/wt/a', branch: 'coord/card-a', tracked: 0, untracked: 0, behind: 0, ahead: 0 },
      { path: 'C:/r/wt/b', branch: 'coord/card-b', tracked: 0, untracked: 0, behind: 0, ahead: 0 },
    ],
  }));
  assert.equal(A('Coord standard')(t).stop, W.STOP.UNKNOWN);
  assert.match(A('Coord standard')(t).next, /hook build/);
  assert.match(A('Coord standard')(t).lanes, /card-a, card-b|card-b, card-a/);
});

test('W21: a failed read is UNKNOWN, never READY: tracked null and behind null', () => {
  const wt = (over) => ({ path: 'C:/r/wt/mc', branch: 'coord/my-card', tracked: 0, untracked: 0, behind: 0, ahead: 0, ...over });
  assert.equal(A('Coord standard')(W.buildTable(base({ worktrees: [wt({ tracked: null })] }))).stop, W.STOP.UNKNOWN);
  assert.equal(A('Coord standard')(W.buildTable(base({ worktrees: [wt({ behind: null, ahead: 0 })] }))).stop, W.STOP.UNKNOWN);
  assert.notEqual(W.STOP.UNKNOWN, W.STOP.READY);
});

test('W22: known unsaved work still shows SAVE PATCH when another read failed', () => {
  const t = W.buildTable(base({ worktrees: [{ path: 'C:/r/wt/mc', branch: 'coord/my-card', tracked: 2, untracked: 0, behind: null, ahead: 0 }] }));
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
  const revs = calls.filter((c) => /rev-list --count HEAD\.\./.test(c));
  assert.equal(revs.length, 2);
  for (const c of revs) assert.ok(c.endsWith(`HEAD..${sha}`), c);
  assert.deepEqual([wts[0].ahead, wts[1].ahead], [2, null], 'an unpushed branch counts its commits beyond fork/main; a failed read is null');
  assert.equal(wts[0].primary, true);
  assert.equal(wts[1].primary, false);
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
const NOTE_RUN = (extra) => base({ lanes: [lane('re-program', '1dcd1fc7', ''), lane('my-card', 'c64e660e', extra)] });

test('W25: a publish.lock held by a session with no row gives a table warning that names the session and the lock time', () => {
  const t = W.buildTable(base({ publishLock: { session: 'dead0001', key: 'k1', at: new Date(NOW - 5 * 60000).toISOString() } }));
  assert.ok(t.warnings.some((w) => /publish\.lock/.test(w) && /dead0001/.test(w) && /no row/.test(w)), t.warnings.join('\n'));
  assert.match(W.renderTable(t), /dead0001/);
});

test('W26: with an orphan publish.lock no row reads READY; known stops stay', () => {
  const t = W.buildTable(base({
    publishLock: { session: 'dead0001', key: 'k1', at: new Date(NOW - 60000).toISOString() },
    worktrees: [{ path: 'C:/r/wt/mc', branch: 'coord/my-card', tracked: 2, untracked: 0, behind: 0, ahead: 0 }],
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

// ---------- W39 to W52: the fix commit of the card (seat ruling B after the first CLI review, aegis and critic) ----------
// Rule for every row: when the table cannot tie a word to a run, it fails closed (no READY).
//   an END of one kind closes the other kind                                                               -> W44 (guard row: it passed before the fix; the mutation check proves it)
//   a publish.lock that is not an object with a session reads as no lock                                   -> W47
//   a held run lock file is only counted and a row reads READY                                             -> W48, W52
//   a non-seat row with no matched worktree reads READY                                                    -> W49
//   the WRAP WORD and SKILL.md tell a session to write a VOID that closes nothing                          -> W50
//   a lock key or a session name with a newline forges lines in the table text                             -> W51
const SKILL = path.join(HERE, '..', '..', '.claude', 'skills', 'wrap-all', 'SKILL.md');

test('W44: an END of one kind does not close a START of the other kind', () => {
  const t = W.buildTable(NOTE_RUN('HOOK BUILD START 12:00 CST. PRE-PR END 12:05 CST PASS.'));
  const r = A('Coord standard')(t);
  assert.equal(r.stop, W.STOP.UNKNOWN);
  assert.match(r.next, /hook build/);
});

test('W47: a publish.lock that is not an object with an 8-hex session is unreadable: a warning and no READY row (also from the file reader)', () => {
  for (const lock of [{}, [], { session: null }, { key: 'k' }, { session: 'zz' }]) {
    const t = W.buildTable(base({ publishLock: lock }));
    assert.ok(t.warnings.some((w) => /publish\.lock/.test(w)), JSON.stringify(lock));
    assert.equal(t.rows.some((r) => r.stop === W.STOP.READY), false, JSON.stringify(lock));
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wrapall-lock-'));
  for (const body of ['{}', '[]', '{"session":null}']) {
    const file = path.join(dir, 'publish.lock');
    writeFileSync(file, body);
    assert.deepEqual(W.readPublishLock(file), { unreadable: true }, body);
  }
  writeFileSync(path.join(dir, 'ok.lock'), JSON.stringify({ session: 'dead0001', key: 'k', at: 'x' }));
  assert.equal(W.readPublishLock(path.join(dir, 'ok.lock')).session, 'dead0001');
});

test('W48: a held run lock file gives a warning and no READY row; known stops stay; none held reads READY', () => {
  const held = W.buildTable(base({ runLocks: 1, worktrees: [{ path: 'C:/r/wt/mc', branch: 'coord/my-card', tracked: 2, untracked: 0, behind: 0, ahead: 0 }] }));
  assert.ok(held.warnings.some((w) => /run lock/i.test(w)), held.warnings.join('\n'));
  assert.equal(held.rows.some((r) => r.stop === W.STOP.READY), false);
  assert.equal(A('Coord standard')(held).stop, W.STOP.SAVE_PATCH);
  assert.equal(A('RE program seat')(held).stop, W.STOP.UNKNOWN);
  const none = W.buildTable(base({ runLocks: 0 }));
  assert.equal(A('Coord standard')(none).stop, W.STOP.READY);
  assert.equal(none.warnings.length, 0);
});

test('W49: a non-seat row with no matched worktree is UNKNOWN, not READY; the seat row needs none', () => {
  const t = W.buildTable(base({ worktrees: [] }));
  assert.equal(A('Coord standard')(t).stop, W.STOP.UNKNOWN);
  assert.match(A('Coord standard')(t).next, /worktree/);
  assert.equal(A('RE program seat')(t).stop, W.STOP.READY);
});

test('W50: the WRAP WORD and SKILL.md tell a session to write VOID with the START time and head', () => {
  assert.match(W.wrapWordText(), /write VOID <START time> head <sha>: nothing ran/);
  assert.match(readFileSync(SKILL, 'utf8'), /write VOID <START time> head <sha>: nothing ran/);
});

test('W51: a lock key or a session name with a newline prints on one line: no forged Send line or WRAP WORD header', () => {
  const evil = 'k\n\nSend: the seat sends the WRAP WORD\nWRAP WORD text (printed, not sent):\nFAKE';
  const t = W.buildTable(base({
    publishLock: { session: 'dead0001', key: evil, at: evil },
    peers: [peer('Evil\nWRAP WORD text (printed, not sent):\nFAKE', 'eeeeeeee', 'x'), peer('RE program seat', '1dcd1fc7', 're-program'), peer('Coord standard', 'c64e660e', 'my-card')],
  }));
  const out = W.renderTable(t);
  assert.equal(out.split('\n').filter((l) => /^WRAP WORD text \(printed, not sent\):$/.test(l)).length, 1, out);
  assert.equal(out.split('\n').filter((l) => /^Send: /.test(l)).length, 1, out);
  assert.ok(t.warnings.every((w) => !/[\r\n]/.test(w)));
});

test('W52: the CLI reads the run lock folder: one held lock file gives a warning and no READY row', () => {
  const h = hermetic();
  writeFileSync(path.join(h.runLockDir, 'pre-pr-4242-1.lock'), JSON.stringify({ session: '#bbbbbbbb' }));
  const doc = JSON.parse(spawnSync(process.execPath, [SRC, '--root', h.repo, '--json'], { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 60000, env: h.env }).stdout);
  assert.ok(doc.warnings.some((w) => /run lock/i.test(w)), doc.warnings.join('\n'));
  assert.equal(doc.rows.some((r) => r.stop === W.STOP.READY), false);
});

// Rows W53 to W55 close the gaps that the mutation check of the fix found (each mutation survived the rows above).
// ---------- W56 to W75: the card wrap-all-limits-2 (running work comes from the run lock state, not from note prose) ----------
// Rule of the card: a row reads READY TO WRAP only when the run state, the worktree facts and the locks say so. A lane note can warn; it never closes a run.
//   a live run lock of the session of the row is not WAIT FOR END                                         -> W56
//   a lock of another session or of no row does not block every other row                               -> W57, W58
//   a stale lock, an unreadable lock record or a lock with an end line in runs.jsonl reads as free        -> W59, W60, W61
//   a note that says a pre-pr is open, with no lock, gives no warning                                     -> W62
//   a hook build START word with no END word reads READY (a build takes no lock); a VOID closes it         -> W63, W64
//   a lane with no matched worktree hides behind a lane that has one                                      -> W65
//   the seat row ignores the tracked changes of the primary checkout                                      -> W66
//   unpushed commits read READY; the ahead count is not read from git                                     -> W67, W68
//   the session handle or a name holds a newline or U+2028 and forges a line                              -> W69
//   an oversized or symlinked publish.lock reads as no lock or is read whole                              -> W70
//   one cell prints every open run, or a huge note is read whole                                          -> W71, W72
//   the lock and runs.jsonl readers                                                                       -> W73, W74, W75
const LOCK = (sid8, over = {}) => ({ kind: 'pre-pr', pid: 4242, pidStart: 1, holder: 'x', head: 'abcd1234', session: `#${sid8}`, startedAt: NOW - 600000, expiresAt: NOW + 3600000, phase: 'test', ...over });

test('W56: a live run lock of the session of the row is WAIT FOR END and the cell names the kind, the head and the start time', () => {
  const t = W.buildTable(base({ locks: [LOCK('c64e660e')], runLocks: 1 }));
  const r = A('Coord standard')(t);
  assert.equal(r.stop, W.STOP.WAIT_END);
  assert.match(r.running, /pre-pr/);
  assert.match(r.running, /abcd1234/);
  assert.match(r.running, /lock/);
});

test('W57: a lock of another session gives that row WAIT FOR END and every other row UNKNOWN; each lock is named in a warning', () => {
  const t = W.buildTable(base({ locks: [LOCK('1dcd1fc7')], runLocks: 1 }));
  assert.equal(A('RE program seat')(t).stop, W.STOP.WAIT_END);
  assert.equal(A('Coord standard')(t).stop, W.STOP.UNKNOWN);
  assert.ok(t.warnings.some((w) => /run lock/i.test(w) && /abcd1234/.test(w)), t.warnings.join('\n'));
});

test('W58: a lock held by a session with no row names the session and blocks every READY row', () => {
  const t = W.buildTable(base({ locks: [LOCK('dead0001')], runLocks: 1 }));
  assert.ok(t.warnings.some((w) => /dead0001/.test(w)), t.warnings.join('\n'));
  assert.equal(t.rows.some((r) => r.stop === W.STOP.READY), false);
});

test('W59: a lock past its expiresAt is named stale and still blocks', () => {
  const t = W.buildTable(base({ locks: [LOCK('c64e660e', { expiresAt: NOW - 60000 })], runLocks: 1 }));
  assert.ok(t.warnings.some((w) => /stale/i.test(w)), t.warnings.join('\n'));
  assert.equal(t.rows.some((r) => r.stop === W.STOP.READY), false);
});

test('W60: a lock record with no kind, pid or session is unreadable: a warning and no READY row', () => {
  for (const rec of [{ session: '#c64e660e' }, {}, null, 'x', [], { kind: 'pre-pr', pid: 'abc', session: '#c64e660e' }]) {
    const t = W.buildTable(base({ locks: [rec], runLocks: 1 }));
    assert.ok(t.warnings.some((w) => /unreadable/i.test(w)), JSON.stringify(rec));
    assert.equal(t.rows.some((r) => r.stop === W.STOP.READY), false, JSON.stringify(rec));
  }
});

test('W61: a lock whose pid and head have an end line in runs.jsonl is a left-over file: named in the warning, and it still blocks', () => {
  const t = W.buildTable(base({ locks: [LOCK('c64e660e')], runLocks: 1, endedRuns: ['4242:abcd1234'] }));
  assert.ok(t.warnings.some((w) => /left over|ended/i.test(w)), t.warnings.join('\n'));
  assert.equal(t.rows.some((r) => r.stop === W.STOP.READY), false);
});

test('W62: a note that says a pre-pr is open, with no lock, gives the row a note warning and does not change its stop', () => {
  const t = W.buildTable(NOTE_RUN('PRE-PR START 14:03 CST head de0dd692, CLI run 2 of 2.'));
  const r = A('Coord standard')(t);
  assert.equal(r.stop, W.STOP.READY);
  assert.match(r.noteWarning ?? '', /note says a run is open, the lock log does not/);
});

test('W63: a HOOK BUILD START word with no END word is UNKNOWN (a build takes no lock); the start forms "at", brackets and a colon count', () => {
  for (const start of ['HOOK BUILD START 12:00 CST.', 'HOOK BUILD START at 12:00 CST.', 'HOOK BUILD START (12:00 CST).', 'HOOK BUILD START: 12:00 CST.', 'HOOK BUILD START pid 4242 head abcd1234.']) {
    const t = W.buildTable(NOTE_RUN(`${start} V7.3 reads clean.`));
    const r = A('Coord standard')(t);
    assert.equal(r.stop, W.STOP.UNKNOWN, start);
    assert.match(r.next, /hook build|note only/i, start);
  }
  const ended = W.buildTable(NOTE_RUN('HOOK BUILD START 12:00 CST. HOOK BUILD END 12:08 CST.'));
  assert.equal(A('Coord standard')(ended).stop, W.STOP.READY);
  const two = W.buildTable(NOTE_RUN('HOOK BUILD START 12:00 CST. HOOK BUILD END 12:08 CST. HOOK BUILD START 13:00 CST.'));
  assert.equal(A('Coord standard')(two).stop, W.STOP.UNKNOWN);
});

test('W64: a VOID word never closes a hook build (the VOID of a pre-pr is in the same note)', () => {
  const t = W.buildTable(NOTE_RUN('HOOK BUILD START 12:00 CST. VOID 12:00 head abcd1234: the pre-pr never ran.'));
  assert.equal(A('Coord standard')(t).stop, W.STOP.UNKNOWN);
});

test('W65: a lane with no matched worktree makes the row UNKNOWN even when another lane of the session has one', () => {
  const t = W.buildTable(base({
    lanes: [lane('re-program', '1dcd1fc7', ''), lane('my-card', 'c64e660e', 'GOAL: x.', 'coord/my-card'), lane('side-card', 'c64e660e', 'GOAL: y.', null)],
    peers: [peer('RE program seat', '1dcd1fc7', 're-program'), peer('Coord standard', 'c64e660e', 'my-card,side-card')],
  }));
  assert.equal(A('Coord standard')(t).stop, W.STOP.UNKNOWN);
  assert.match(A('Coord standard')(t).next, /worktree/);
});

test('W66: the seat row reads the primary checkout: tracked changes there are SAVE PATCH, a clean primary is READY; no other row reads it', () => {
  const primary = (over) => ({ path: 'C:/r', branch: 'main', primary: true, tracked: 1, untracked: 0, behind: 0, ahead: 0, ...over });
  const mc = { path: 'C:/r/wt/mc', branch: 'coord/my-card', tracked: 0, untracked: 0, behind: 0, ahead: 0 };
  const dirty = W.buildTable(base({ worktrees: [primary({ tracked: 1 }), mc] }));
  assert.equal(A('RE program seat')(dirty).stop, W.STOP.SAVE_PATCH);
  assert.equal(A('Coord standard')(dirty).stop, W.STOP.READY);
  const clean = W.buildTable(base({ worktrees: [primary({ tracked: 0 }), mc] }));
  assert.equal(A('RE program seat')(clean).stop, W.STOP.READY);
});

test('W67: unpushed commits are PUSH FIRST; an unknown ahead count is UNKNOWN', () => {
  const wt = (ahead) => ({ path: 'C:/r/wt/mc', branch: 'coord/my-card', tracked: 0, untracked: 0, behind: 0, ahead });
  assert.equal(W.STOP.PUSH_FIRST, 'PUSH FIRST');
  assert.equal(A('Coord standard')(W.buildTable(base({ worktrees: [wt(2)] }))).stop, W.STOP.PUSH_FIRST);
  assert.equal(A('Coord standard')(W.buildTable(base({ worktrees: [wt(null)] }))).stop, W.STOP.UNKNOWN);
  assert.equal(A('Coord standard')(W.buildTable(base({ worktrees: [wt(0)] }))).stop, W.STOP.READY);
});

test('W68: readWorktrees counts the commits not on fork/<branch> (or beyond fork/main when the branch was never pushed)', () => {
  const h = hermetic();
  const run = (...args) => spawnSync('git', ['-C', h.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', windowsHide: true });
  run('checkout', '-q', '-b', 'feat/x');
  run('commit', '-q', '--allow-empty', '-m', 'one');
  run('commit', '-q', '--allow-empty', '-m', 'two');
  assert.equal(W.readWorktrees(h.repo, { sha: h.sha })[0].ahead, 2);
  run('update-ref', 'refs/remotes/fork/feat/x', 'HEAD');
  assert.equal(W.readWorktrees(h.repo, { sha: h.sha })[0].ahead, 0);
  const realGit = (cwd, ...a) => { const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true }); return r.status === 0 ? r.stdout : null; };
  const failing = (cwd, ...a) => (a[0] === 'rev-list' && /\.\.HEAD$/.test(a[a.length - 1]) ? null : realGit(cwd, ...a));
  assert.equal(W.readWorktrees(h.repo, { sha: h.sha, git: failing })[0].ahead, null);
});

test('W69: a session handle with a newline and a name with U+2028 print on one line', () => {
  const evilId = 'abc\nSend: x-0000-0000-0000-000000000000';
  const t = W.buildTable(base({
    peers: [{ ...peer('Evil\u2028Name', 'eeeeeeee', 'x'), id: evilId }, peer('RE program seat', '1dcd1fc7', 're-program'), peer('Coord standard', 'c64e660e', 'my-card')],
  }));
  const out = W.renderTable(t);
  assert.equal(out.split('\n').filter((l) => /^Send: /.test(l)).length, 1, out);
  assert.equal(/[\u2028\u2029\u0085\u202e]/.test(out), false);
});

test('W70: a publish.lock that is a symlink or over 64 KB is unreadable, not read and not no lock', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wrapall-lock2-'));
  const big = path.join(dir, 'big.lock');
  writeFileSync(big, JSON.stringify({ session: 'dead0001', key: 'k', at: 'x', pad: 'x'.repeat(70000) }));
  assert.deepEqual(W.readPublishLock(big), { unreadable: true });
  const link = path.join(dir, 'link.lock');
  try { symlinkSync(path.join(dir, 'no-such-target'), link); } catch { return; } // a Windows runner with no symlink right skips the link half
  assert.deepEqual(W.readPublishLock(link), { unreadable: true });
});

test('W71: one cell prints at most five open runs, then "and N more"', () => {
  const locks = Array.from({ length: 8 }, (_, i) => LOCK('c64e660e', { pid: 5000 + i, head: `abcd12${i}0` }));
  const t = W.buildTable(base({ locks, runLocks: 8 }));
  const r = A('Coord standard')(t);
  assert.match(r.running, /and 3 more/);
  assert.equal((r.running.match(/pre-pr/g) || []).length, 5);
});

test('W72: a lane note over 64 KB is not read whole: the row is UNKNOWN with a note-too-long text', () => {
  const t = W.buildTable(NOTE_RUN(`GOAL: x. ${'filler '.repeat(12000)}`));
  const r = A('Coord standard')(t);
  assert.equal(r.stop, W.STOP.UNKNOWN);
  assert.match(r.next, /note/i);
});

test('W73: readRunLockRecords reads every lock file of the folder, one record each; a file that does not parse is an unreadable record; gate.lock is not a run', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wrapall-runlocks-'));
  writeFileSync(path.join(dir, 'pre-pr-4242-1.lock'), JSON.stringify(LOCK('c64e660e')));
  writeFileSync(path.join(dir, 'pre-pr-4243-1.lock'), '{not json');
  writeFileSync(path.join(dir, 'gate.lock'), '{}');
  writeFileSync(path.join(dir, 'runs.jsonl'), '');
  const recs = W.readRunLockRecords(dir);
  assert.equal(recs.length, 2);
  assert.ok(recs.some((r) => r && r.pid === 4242 && r.head === 'abcd1234'));
  assert.ok(recs.some((r) => r === null || r.unreadable === true));
  assert.deepEqual(W.readRunLockRecords(path.join(dir, 'nothing-here')), []);
});

test('W74: readEndedRuns lists pid:head of the end lines in the last two hundred lines of runs.jsonl', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wrapall-runs-'));
  const lines = [{ ts: 1, event: 'start', pid: 1, head: 'aaaa1111' }, { ts: 2, event: 'end', pid: 1, head: 'aaaa1111', result: 'PASS' }, { ts: 3, event: 'wait', pid: 2, head: 'bbbb2222' }];
  writeFileSync(path.join(dir, 'runs.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{broken');
  assert.deepEqual(W.readEndedRuns(dir), ['1:aaaa1111']);
  assert.deepEqual(W.readEndedRuns(path.join(dir, 'nothing-here')), []);
});

test('W75: the CLI reads the lock folder: a lock of the seat gives the seat row WAIT FOR END', () => {
  const h = hermetic();
  writeFileSync(path.join(h.runLockDir, 'pre-pr-4242-1.lock'), JSON.stringify(LOCK('aaaaaaaa')));
  const doc = JSON.parse(spawnSync(process.execPath, [SRC, '--root', h.repo, '--json'], { cwd: HERE, encoding: 'utf8', windowsHide: true, timeout: 60000, env: h.env }).stdout);
  assert.equal(doc.rows[0].stop, W.STOP.WAIT_END);
  assert.match(doc.rows[0].running, /abcd1234/);
});
