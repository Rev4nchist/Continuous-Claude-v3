#!/usr/bin/env node
/**
 * program-probe -- the hand-run end-to-end check of the program.mjs board verbs (design C.4, cases P1 to P14, plus P15 for the board filter of check --claims).
 *
 * It runs the REAL program.mjs of this checkout, in --test-mode, as a child process against a SCRATCH database
 * (lanes_pr1_*, migrations through 0006) that this probe creates and drops. The map is fixtures/r9-map.fixture.md.
 * sync-board --apply writes through the shim (~/.claude/scripts/lane.mjs, the primary checkout's lane.mjs), also on the scratch URL.
 * The live database is never opened: every child gets the scratch URL in all three variables, and a temp board registry.
 * Lanes, edges, the program seed event and the done events are put in place by direct SQL on the scratch database only.
 *
 *   node scripts/review-engine/program-probe.mjs
 *
 * Not a node:test file. Needs Docker with Postgres up, and the pg package (resolved like the other probes).
 * Transcript: .claude/cache/e2e/2026-11-10-program-probe.txt (overwritten). Exit 0: all cases pass. Exit 1: a case failed. Exit 2: refused to start.
 * P1 seeds through the shim with the object form (gate-2, on main since PR #486). An older lane.mjs refuses an object with
 * 'JSON array of lanes': the probe then falls back to the array form plus direct SQL for the edges, and prints which path ran.
 * P14 runs `ready` in live mode on purpose: the self-check refuses before any connection, and all three URL variables hold the scratch URL.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl } from '../coordination/scratch-db.mjs';
import { laneEnv, makeBoards } from '../coordination/probe-boards.mjs';
import { maskDbUrl } from './lib/db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const PROGRAM = join(HERE, 'program.mjs');
const SCRATCH = join(REPO, 'scripts', 'coordination', 'scratch-db.mjs');
const SHIM = join(homedir(), '.claude', 'scripts', 'lane.mjs');
const MAP = join(HERE, 'fixtures', 'r9-map.fixture.md');
const OUT_DIR = join(REPO, '.claude', 'cache', 'e2e');
const OUT = join(OUT_DIR, '2026-11-10-program-probe.txt');
const SHA_A = 'ab'.repeat(20);
const SHA_MAIN = 'cd'.repeat(20);
const WAVE_0 = ['re-dummy-1', 're-dummy-4', 're-dummy-5', 'ext-dummy'];

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, '');
const log = (s = '') => { appendFileSync(OUT, `${s}\n`); console.log(s); };
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  -- ${detail}` : ''}`); };
/** The command and its full output go to the transcript file only, so the file is the evidence and the console stays short. */
const record = (cmd, all) => appendFileSync(OUT, `  $ ${cmd}\n${String(all).trim().split('\n').map((l) => `    | ${l}`).join('\n')}\n`);
const lines = (text) => text.split(/\r?\n/);
const has = (text, re) => re.test(text);

function refuseToStart(why) {
  log(`REFUSED TO START: ${why}`);
  process.exit(2);
}

let Client;
try {
  ({ Client } = requireDep('pg', { repoRoot: REPO }));
} catch (e) {
  refuseToStart(`the pg package is not available (${e.message})`);
}

const scratchCli = (...args) => spawnSync(process.execPath, [SCRATCH, ...args], { encoding: 'utf8' });

// ---- the run helpers (set after the scratch database exists)
let url = null;
let boards = null;
let board = null;
let db = null;
let MAP_GO = null;
let DECISIONS = null;

function childEnv(session) {
  return laneEnv(url, boards, session ? { CLAUDE_CODE_SESSION_ID: session } : {});
}

/** program.mjs in test mode on the scratch URL. extra: { session, map, env }. Returns { code, out, err, all }. */
function prog(args, extra = {}) {
  const project = args[0] === 'seed-file' ? [] : ['--project', board];
  const base = ['--test-mode', '--map', extra.map ?? MAP, '--repo', REPO, ...project];
  const r = spawnSync(process.execPath, [PROGRAM, ...args, ...base, ...(extra.more ?? [])], {
    cwd: boards.boards.a.dir, encoding: 'utf8', env: { ...childEnv(extra.session), ...(extra.env ?? {}) },
  });
  const all = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  record(`program.mjs ${args.join(' ')} (exit ${r.status})`, all);
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all };
}

const lane = (args, session) => {
  const r = spawnSync(process.execPath, [SHIM, ...args], { cwd: boards.boards.a.dir, encoding: 'utf8', env: childEnv(session) });
  record(`lane.mjs ${args.join(' ')} (exit ${r.status})`, `${r.stdout ?? ''}${r.stderr ?? ''}`);
  return { code: r.status, all: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

// ---- direct SQL on the scratch database

const q = (text, params = []) => db.query(text, params);
const count = async (kind) => Number((await q('SELECT count(*) AS n FROM agentic_os.lane_event WHERE project_key = $1 AND kind = $2', [board, kind])).rows[0].n);

async function live(id) {
  await q(`INSERT INTO sessions (id, project, last_heartbeat, last_activity_at) VALUES ($1, 'probe', now(), now())
           ON CONFLICT (id) DO UPDATE SET last_heartbeat = now(), last_activity_at = now()`, [id]);
}

/** Put a lane in a state with an owner. lease: 'live' (a live session and a valid lease), 'dead' (no session, expired lease), none. */
async function setLane(id, state, owner = null, lease = 'live') {
  if (owner && lease === 'live') await live(owner);
  const expiry = !owner ? null : lease === 'live' ? "now() + interval '30 minutes'" : "now() - interval '1 hour'";
  await q(`UPDATE agentic_os.lane SET state = $2, owner_session_id = $3, lease_expires_at = ${expiry ?? 'NULL'} WHERE id = $1 AND project_key = $4`, [id, state, owner, board]);
}

async function event(laneId, kind, detail, session = 'zz-rp-seeder') {
  await q('INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, body, detail, project_key) VALUES ($1,$2,$3,$4,$5,$6)',
    [laneId, kind, session, `probe ${kind}`, JSON.stringify(detail), board]);
}

const mergedDone = async (id, sha = SHA_A) => { await setLane(id, 'done'); await event(id, 'done', { state: 'done', merged: sha }); };

/** Every program lane back to blocked with no owner; every event the cases added is removed; the seed events stay. */
async function reset() {
  await q(`UPDATE agentic_os.lane SET state = 'blocked', owner_session_id = NULL, lease_expires_at = NULL WHERE project_key = $1`, [board]);
  await q(`DELETE FROM agentic_os.lane_event WHERE project_key = $1 AND kind IN ('done','state_changed','claimed','dep_override','kanban')`, [board]);
  await q('DELETE FROM agentic_os.lane_dep WHERE project_key = $1', [board]);
  for (const e of seedEdges) await q('INSERT INTO agentic_os.lane_dep (lane_id, depends_on, project_key) VALUES ($1,$2,$3)', [e.lane, e.dependsOn, board]);
}

let seedEdges = [];

// ---- setup: seed through the real seed-file output and the shim, then the program seed event by direct SQL

const laneCount = async () => Number((await q('SELECT count(*) AS n FROM agentic_os.lane WHERE project_key = $1', [board])).rows[0].n);
const programSeedCount = async () => Number((await q(`SELECT count(*) AS n FROM agentic_os.lane_event WHERE project_key = $1 AND kind = 'seeded' AND (detail->'edges') IS NOT NULL`, [board])).rows[0].n);
let seedPath = null;

// Detects at run time whether the shim's lane.mjs accepts the object form { lanes, edges }. The object form first, on the scratch database.
// Only the exact 'JSON array of lanes' refusal falls back to the array form (and direct SQL for the edges and the program seed event);
// any other failure is an error. The path that ran is stored in seedPath and printed by p1.
async function shimSeed(file, seed) {
  const tried = lane(['seed', file], 'zz-rp-seeder');
  if (tried.code === 0) return 'object';
  if (!/JSON array of lanes/.test(tried.all)) throw new Error(`lane seed (object form) failed: ${tried.all}`);
  if ((await laneCount()) !== 0) throw new Error('the object form was refused but lanes were written');
  const arrayFile = join(boards.tmp, 'seed-array.json');
  writeFileSync(arrayFile, JSON.stringify(seed.lanes));
  const s = lane(['seed', arrayFile], 'zz-rp-seeder');
  if (s.code !== 0) throw new Error(`lane seed (array form) failed: ${s.all}`);
  return 'array';
}

async function seedBoard() {
  const file = join(boards.tmp, 'seed-object.json');
  const r = prog(['seed-file', '--out', file, '--project', board], { more: [] });
  const seed = JSON.parse(readFileSync(file, 'utf8'));
  if (r.code !== 0) throw new Error(`seed-file failed: ${r.all}`);
  seedEdges = seed.edges;
  seedPath = await shimSeed(file, seed);
  for (const [id, state] of [['ext-dummy', 'blocked'], ['re-program', 'blocked']]) {
    const a = lane(['add', id, '--title', `probe ${id}`, '--state', state, '--track', 'review-engine'], 'zz-rp-seeder');
    if (a.code !== 0) throw new Error(`lane add ${id} failed: ${a.all}`);
  }
  await q('UPDATE agentic_os.lane SET branch = $2 WHERE id = $1 AND project_key = $3', ['re-program', 're/re-program', board]);
  await reset();
  // The array form writes no edges and no program seed event: put them in by direct SQL. The object form wrote them (reset kept the seed events).
  if (seedPath === 'array') await event(null, 'seeded', { lanes: seed.lanes.length, edges: seed.edges.length });
  else if ((await programSeedCount()) === 0) throw new Error('the object form was accepted but wrote no program seed event');
  return seed;
}

const ready = (session, more = []) => prog(['ready', '--as', session], { session, more });
const sync = (apply, extra = {}) => prog(['sync-board', ...(apply ? ['--apply', '--as', 'zz-rp-me'] : [])], { session: 'zz-rp-me', ...extra });

// ---- the cases

async function p1() {
  log('\n## P1 seed rehearsal, then check --board');
  const seed = await seedBoard();
  check('seed-file wrote 6 lanes and 3 edges, 2 lanes on re/re-dummy-2, no band', seed.lanes.length === 6 && seed.edges.length === 3
    && seed.lanes.filter((l) => l.branch === 're/re-dummy-2').length === 2 && seed.lanes.every((l) => !('band' in l)));
  const r = prog(['check', '--board'], { session: 'zz-rp-me' });
  check('P1 check --board: 0 FAIL, exit 0', r.code === 0 && has(r.out, /RESULT pass \(0 errors\)/), r.out.split('\n').filter((l) => /^FAIL/.test(l)).join(' | ') || r.err);
  log(seedPath === 'object'
    ? 'NOTE P1 seed path: OBJECT form through the shim lane.mjs seed (it accepted { lanes, edges }); the edges and the program seed event came from lane.mjs.'
    : "NOTE P1 seed path: ARRAY form through the shim lane.mjs seed (it refused the object form with 'JSON array of lanes'); the edges and the program seed event came from direct SQL on the scratch database.");
}

async function p2() {
  log('\n## P2 sync-board dry run under HOLD');
  const before = await count('state_changed');
  const r = sync(false);
  const out = r.out;
  check('P2 exit 0, MOVE only the open-dependency lanes', r.code === 0 && has(out, /^MOVE re-dummy-2 blocked -> backlog \(open-dependency\)$/m)
    && has(out, /^MOVE re-dummy-3 blocked -> backlog \(open-dependency\)$/m) && !has(out, /^MOVE re-dummy-[1456]|^MOVE ext-dummy/m), r.all.slice(0, 300));
  check('P2 wave 0 lanes and the held lane STAY', WAVE_0.every((id) => has(out, new RegExp(`^STAY ${id} waits for GO$`, 'm'))) && has(out, /^STAY re-dummy-6 held seat-hold$/m));
  check('P2 RESULT dry-run 2 moves, the event count is unchanged', has(out, /^RESULT dry-run 2 moves$/m) && (await count('state_changed')) === before);
}

async function p3() {
  log('\n## P3 --apply, then a second run');
  const r = sync(true);
  const states = (await q(`SELECT id, state FROM agentic_os.lane WHERE project_key = $1 AND id IN ('re-dummy-2','re-dummy-3')`, [board])).rows;
  check('P3 --apply: exit 0, applied 2 moves, both lanes are backlog', r.code === 0 && has(r.out, /^RESULT applied 2 moves, 0 skipped$/m) && states.every((x) => x.state === 'backlog'), r.all.slice(0, 300));
  check('P3 two state_changed events with state backlog', (await q(`SELECT count(*) AS n FROM agentic_os.lane_event WHERE project_key = $1 AND kind = 'state_changed' AND detail->>'state' = 'backlog'`, [board])).rows[0].n === '2');
  const again = sync(true);
  check('P3 second run: 0 moves', again.code === 0 && has(again.out, /^RESULT applied 0 moves, 0 skipped$/m), again.all.slice(0, 200));
}

async function p4() {
  log('\n## P4 GO, a hand-blocked lane');
  await reset();
  writeFileSync(MAP_GO, readFileSync(MAP, 'utf8').replace('Program state: HOLD', 'Program state: GO (probe)'));
  await event('re-dummy-5', 'state_changed', { state: 'blocked' }, 'zz-rp-seat');
  const r = sync(true, { map: MAP_GO });
  const moved = (await q(`SELECT id FROM agentic_os.lane WHERE project_key = $1 AND state = 'backlog' ORDER BY id`, [board])).rows.map((x) => x.id);
  check('P4 wave 0 and the external move, the dependants move', JSON.stringify(moved) === JSON.stringify(['ext-dummy', 're-dummy-1', 're-dummy-2', 're-dummy-3', 're-dummy-4']), moved.join(','));
  check('P4 the hand-blocked lane STAYs, the held lane STAYs', has(r.out, /^STAY re-dummy-5 hand-blocked$/m) && has(r.out, /^STAY re-dummy-6 held seat-hold$/m), r.all.slice(0, 300));
}

async function p5() {
  log('\n## P5 ready before and after a merged done of the dependency');
  await reset();
  await setLane('re-dummy-2', 'backlog');
  const before = ready('zz-rp-me');
  check('P5 dependency not merged: re-dummy-2 is not printed', before.code === 0 && !has(before.out, /re-dummy-2/), before.all.slice(0, 300));
  await mergedDone('re-dummy-1');
  const after = ready('zz-rp-me');
  check('P5 after the merged done: READY re-dummy-2', has(after.out, /^READY re-dummy-2 /m), after.all.slice(0, 300));
}

async function p6() {
  log('\n## P6 two dummies share a file: owns-held while the other is active, then in review');
  for (const state of ['active', 'review']) {
    await reset();
    await setLane('re-dummy-1', 'backlog');
    await setLane('re-dummy-6', state, 'zz-rp-own1');
    const r = ready('zz-rp-me');
    check(`P6 re-dummy-6 ${state}: re-dummy-1 is HELD BACK owns-held re-dummy-6`, has(r.out, /^HELD BACK re-dummy-1 {2}owns-held re-dummy-6$/m) && !has(r.out, /^READY re-dummy-1 /m), r.all.slice(0, 300));
  }
}

async function p7() {
  log('\n## P7 cap: the seat is not counted, a pack counts one unit');
  await reset();
  await setLane('re-program', 'active', 'zz-rp-seat');
  await setLane('ext-dummy', 'backlog');
  await setLane('re-dummy-4', 'active', 'zz-rp-own1');
  await setLane('re-dummy-2', 'active', 'zz-rp-own2');
  await setLane('re-dummy-3', 'active', 'zz-rp-own3');
  const two = ready('zz-rp-me');
  check('P7 seat + one spender + a pack held by 2 owners: cap 2/3, ext-dummy is READY', has(two.out, /cap 2\/3 units/) && has(two.out, /^READY ext-dummy /m), two.all.slice(0, 300));
  await setLane('re-dummy-1', 'active', 'zz-rp-own4');
  const full = ready('zz-rp-me');
  check('P7 a third unit: cap 3/3, ext-dummy HELD BACK cap-full, RESULT cap-full', has(full.out, /cap 3\/3 units/) && has(full.out, /^HELD BACK ext-dummy {2}cap-full$/m) && has(full.out, /^RESULT cap-full$/m), full.all.slice(0, 300));
}

async function p8() {
  log('\n## P8 spend: one lane that spends the Cursor eval slot');
  await reset();
  await setLane('re-dummy-4', 'active', 'zz-rp-own1');
  await setLane('re-dummy-5', 'backlog');
  const r = ready('zz-rp-me');
  check('P8 slot held by re-dummy-4: re-dummy-5 HELD BACK slot-held', has(r.out, /slot held by re-dummy-4/) && has(r.out, /^HELD BACK re-dummy-5 {2}slot-held re-dummy-4$/m), r.all.slice(0, 300));
}

async function p9() {
  log('\n## P9 the caller already holds a lane');
  await reset();
  await setLane('re-dummy-1', 'active', 'zz-rp-me');
  const refused = ready('zz-rp-me');
  check('P9 caller holds re-dummy-1: exit 3 and the REFUSED line', refused.code === 3 && has(refused.err, /^REFUSED ready -- you hold re-dummy-1; one re- lane per session/m), refused.all.slice(0, 300));
  await reset();
  await mergedDone('re-dummy-1');
  await setLane('re-dummy-2', 'active', 'zz-rp-me');
  await setLane('re-dummy-3', 'backlog');
  await setLane('re-dummy-4', 'backlog');
  const pack = ready('zz-rp-me');
  check('P9 caller holds a pack lane: mode pack, only the sibling is printed', has(pack.out, /mode pack/) && has(pack.out, /^READY re-dummy-3 /m) && !has(pack.out, /^READY re-dummy-4 /m), pack.all.slice(0, 300));
}

async function p10() {
  log('\n## P10 orphans: a dead owner on a worker lane, on a long review lane and on the seat');
  await reset();
  await setLane('re-dummy-1', 'active', 'zz-rp-dead1', 'dead');
  await setLane('re-dummy-5', 'review', 'zz-rp-dead2', 'dead');
  await setLane('re-program', 'active', 'zz-rp-dead3', 'dead');
  const r = prog(['check', '--orphans'], { session: 'zz-rp-me' });
  check('P10 orphan, parked and seat lines, exit 1', r.code === 1 && has(r.out, /^orphan: re-dummy-1 active /m) && has(r.out, /^parked: re-dummy-5 /m) && has(r.out, /^seat: no live holder since /m), r.all.slice(0, 400));
  await reset();
  await setLane('re-program', 'active', 'zz-rp-seat');
  const ok = prog(['check', '--orphans'], { session: 'zz-rp-me' });
  check('P10 a live seat and no dead owner: exit 0', ok.code === 0 && has(ok.out, /^seat: re-program held live by zz-rp-s/m), ok.all.slice(0, 300));
}

async function p11() {
  log('\n## P11 claims: a claim before the dependency merged, a dep_override, a reclaim');
  await reset();
  await event('re-dummy-2', 'claimed', { state: 'active', fence: 1 }, 'zz-rp-own1');
  await event('re-dummy-3', 'dep_override', { reason: 'probe' }, 'zz-rp-own2');
  await event('re-dummy-4', 'claimed', { state: 'active', fence: 2 }, 'zz-rp-own3');
  await event('re-dummy-4', 'claimed', { state: 'active', fence: 3 }, 'zz-rp-own4');
  const r = prog(['check', '--claims'], { session: 'zz-rp-me' });
  check('P11 claim-open-dep, dep-override and a reclaim note; exit 1', r.code === 1 && has(r.out, /^FAIL claim-open-dep re-dummy-2 event \d+ waits on re-dummy-1$/m)
    && has(r.out, /^FAIL dep-override re-dummy-3 /m) && has(r.out, /^NOTE reclaim re-dummy-4 \d+$/m) && has(r.out, /^floor: event \d+ \(program seed\)$/m), r.all.slice(0, 500));
}

async function p12() {
  log('\n## P12 check --board finds a plain done, an extra edge and a shared SHA; a no-PR done is a note');
  await reset();
  await setLane('re-dummy-4', 'done');
  await event('re-dummy-4', 'done', { state: 'done' });
  await q('INSERT INTO agentic_os.lane_dep (lane_id, depends_on, project_key) VALUES ($1,$2,$3)', ['re-dummy-5', 're-dummy-4', board]);
  await mergedDone('re-dummy-1');
  await mergedDone('re-dummy-2');
  await setLane('re-dummy-5', 'done');
  await event('re-dummy-5', 'done', { state: 'done', merged: SHA_MAIN, noPr: true, evidence: '.claudedocs/probe.md' });
  const r = prog(['check', '--board'], { session: 'zz-rp-me' });
  check('P12 FAIL done-not-met, edge-extra and shared-sha; exit 1', r.code === 1 && has(r.out, /^FAIL done-not-met re-dummy-4 /m) && has(r.out, /^FAIL edge-extra re-dummy-5 /m) && has(r.out, /^FAIL shared-sha /m), r.all.slice(0, 600));
  check('P12 NOTE nopr re-dummy-5 with its evidence', has(r.out, /^NOTE nopr re-dummy-5 evidence \.claudedocs\/probe\.md$/m), r.out.split('\n').filter((l) => /^NOTE/.test(l)).join(' | '));
}

async function p13() {
  log('\n## P13 status');
  await reset();
  writeFileSync(DECISIONS, '# Decisions\n\n### DP1 (first)\n\n1. DECIDED yes\n\n### DP2 (second)\n\n1. open one\n2. open two\n');
  const r = prog(['status', '--json'], { session: 'zz-rp-me', more: ['--decisions', DECISIONS] });
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* checked below */ }
  const keys = ['ok', 'verb', 'testMode', 'mapSource', 'board', 'go', 'counts', 'waves', 'lanes', 'cap', 'slot', 'nextDecisionPoint'];
  check('P13 exit 0 and the B.8 keys', r.code === 0 && j && keys.every((k) => k in j), r.all.slice(0, 300));
  check('P13 7 lanes (6 Waves + 1 external), all blocked, next decision point DP2 with 2 open items', j?.counts?.lanes === 7 && j.counts.byState.blocked === 7 && j.nextDecisionPoint?.id === 'DP2' && j.nextDecisionPoint.open.length === 2, JSON.stringify(j?.nextDecisionPoint));
}

async function p14() {
  log('\n## P14 refusals: a live URL in test mode, and live mode from this worktree');
  const dead = 'postgresql://claude:claude_dev@127.0.0.1:1/continuous_claude';
  const t = prog(['status'], { env: { CONTINUOUS_CLAUDE_DB_URL: dead } });
  check('P14 test mode with the live database name: exit 3, no password in the text', t.code === 3 && !/claude_dev/.test(t.all), t.all.slice(0, 200));
  // Live mode on purpose: the self-check refuses before any connection, and every URL variable still holds the scratch URL,
  // so even a missing refusal could not reach the live database.
  const l = spawnSync(process.execPath, [PROGRAM, 'ready', '--as', 'zz-rp-me'], { cwd: REPO, encoding: 'utf8', env: childEnv('zz-rp-me') });
  record(`program.mjs ready --as zz-rp-me, live mode (exit ${l.status})`, `${l.stdout}\n${l.stderr}`);
  check('P14 live mode from a linked worktree: exit 3 by the self-check', l.status === 3 && /linked worktree|not the one on main/.test(l.stderr), (l.stderr ?? '').slice(0, 200));
}

async function p15() {
  log('\n## P15 check --claims does not judge events of a same-id lane on another board (F4)');
  await reset();
  const other = 'zz-other-board';
  for (const [laneId, kind, detail] of [['re-dummy-2', 'claimed', { state: 'active', fence: 1 }], ['re-dummy-3', 'dep_override', { reason: 'other board' }]]) {
    await q('INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, body, detail, project_key) VALUES ($1,$2,$3,$4,$5,$6)',
      [laneId, kind, 'zz-rp-other', `probe ${kind} other board`, JSON.stringify(detail), other]);
  }
  const r = prog(['check', '--claims'], { session: 'zz-rp-me' });
  check('P15 events of another board: no FAIL, exit 0', r.code === 0 && !has(r.out, /^FAIL /m) && has(r.out, /^RESULT pass \(0 errors\)$/m), r.all.slice(0, 400));
  await q('DELETE FROM agentic_os.lane_event WHERE project_key = $1', [other]);
}

// ---- driver

try {
  log('# program.mjs board verbs: scratch database probe, 2026-11-10');
  log('# Live database: NOT touched. program.mjs runs in --test-mode on the scratch URL below; sync-board --apply runs lane.mjs through the shim on the same URL.');
  const created = scratchCli('create', '--through', '6');
  if (created.status !== 0) throw new Error(`scratch create failed: ${created.stderr}`);
  url = JSON.parse(created.stdout).url;
  try { assertScratchUrl(url); } catch (e) { refuseToStart(`the database URL is not a scratch URL (${e.message})`); }
  log(`scratch database: ${maskDbUrl(url)}`);
  boards = makeBoards('zz-reprobe', ['a']);
  board = boards.boards.a.key;
  MAP_GO = join(boards.tmp, 'map-go.md');
  DECISIONS = join(boards.tmp, 'decisions.md');
  db = new Client({ connectionString: url });
  await db.connect();
  await q(`SELECT set_config('lane.client_version', '2', false)`);
  for (const c of [p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15]) await c();
} catch (e) {
  log(`ERROR: ${e.stack || e.message}`);
  results.push(['driver error', false]);
} finally {
  if (db) await db.end().catch(() => {});
  if (url) {
    try { assertScratchUrl(url); const d = scratchCli('drop', url); log(`drop: ${(d.stdout || d.stderr).trim()}`); } catch (e) { log(`drop failed: ${e.message}`); results.push(['drop', false]); }
  }
  if (boards) boards.cleanup();
  const failed = results.filter((x) => !x[1]).length;
  log(`\nSUMMARY: ${results.length - failed} passed, ${failed} failed (of ${results.length} checks)`);
  process.exitCode = failed ? 1 : 0;
}
