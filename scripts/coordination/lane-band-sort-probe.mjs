#!/usr/bin/env node
/**
 * lane-band-sort-probe -- the end-to-end gate for the lane band readers (phase 3 of the lane priority design).
 *
 * Runs the REAL scripts/coordination/lane.mjs and the BUILT hook .claude/hooks/dist/lane-context.mjs as child
 * processes against a SCRATCH database (lanes_pr1_*, migrations through 0005) that this probe creates and drops.
 * It never touches the live database. Boards come from a temp registry (probe-boards.mjs), never the real one.
 *
 * The shared sort key for open lanes: band (P0, P1, P2, then Unsorted), due_at (NULL last), priority, id.
 * Every check compares an EXACT id sequence that is written out below, not computed from the helper.
 *
 *   node scripts/coordination/lane-band-sort-probe.mjs
 *
 * Needs `npm run build` in .claude/hooks first (the hook check runs dist/lane-context.mjs).
 * Transcript: .claude/cache/e2e/2026-11-06-lane-band-sort-probe.txt (overwritten).
 * Hook output: .claude/cache/e2e/2026-11-06-lane-context-band.json (overwritten).
 * Exit 0: all checks pass. Exit 1: a check failed.
 * Design: .claudedocs/2026-11-06-lane-priority-design.md, "Build phases", phase 3.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl, maskUrl } from './scratch-db.mjs';
import { laneEnv, makeBoards } from './probe-boards.mjs';

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  console.log('usage: node scripts/coordination/lane-band-sort-probe.mjs' + String.fromCharCode(10)
    + 'Proves the lane band readers (board, board --by priority, next, mine, and the built lane-context hook) on a' + String.fromCharCode(10)
    + 'throwaway lanes_pr1_* database with the real lane.mjs. Needs a reachable Postgres, the pg package (set NODE_PATH to' + String.fromCharCode(10)
    + 'a folder that holds pg) and a built .claude/hooks/dist/lane-context.mjs. Takes no other arguments.' + String.fromCharCode(10)
    + 'Exit 1 if a check fails, 2 if pg is missing.');
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LANE = join(HERE, 'lane.mjs');
const SCRATCH = join(HERE, 'scratch-db.mjs');
const HOOK = join(REPO, '.claude', 'hooks', 'dist', 'lane-context.mjs');
const OUT_DIR = join(REPO, '.claude', 'cache', 'e2e');
const OUT = join(OUT_DIR, '2026-11-06-lane-band-sort-probe.txt');
const HOOK_OUT = join(OUT_DIR, '2026-11-06-lane-context-band.json');

let Client;
try {
  ({ Client } = requireDep('pg', { repoRoot: REPO }));
} catch (e) {
  console.error(`lane-band-sort-probe: the pg package is not available (${e.message}). Set NODE_PATH to a folder that holds pg.`);
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, '');

const log = (s = '') => { const t = String(s).replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/g, '$1***@'); appendFileSync(OUT, t + '\n'); console.log(t); };
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SESSION = 'zz-lsprobe-session';
const HOOK_SESSION = 'aaaaaaaa-0000-4000-8000-00000000b4d1';
const P = 'zz-ls-';
const scratch = (...args) => spawnSync(process.execPath, [SCRATCH, ...args], { encoding: 'utf8' });

/** Lane ids of the rows a lane.mjs table printout shows, in order. Lane rows read `<mark> <band tag> <id> ...`. */
const rowIds = (text) => text.split('\n').map((l) => l.match(/^\S+ (?:P[012]|--) (zz-l[sc]-\S+)\s/)?.[1]).filter(Boolean);
/** The same, with the band tag. */
const rowTags = (text) => text.split('\n').map((l) => l.match(/^\S+ (P[012]|--) (zz-l[sc]-\S+)\s/)).filter(Boolean).map((m) => `${m[1]} ${m[2]}`);
/** Lane ids per track header (`-- <track> ---`) of a `board` printout, in order. */
function byTrack(text) {
  const groups = []; let cur = null;
  for (const l of text.split('\n')) {
    const h = l.match(/^-- (\S+) -+$/);
    if (h) { cur = { track: h[1], ids: [] }; groups.push(cur); continue; }
    const id = l.match(/^\S+ (?:P[012]|--) (zz-l[sc]-\S+)\s/)?.[1];
    if (id && cur) cur.ids.push(id);
  }
  return groups;
}

let boards = null; let url = null; let db = null;
try {
  log('# lane band readers: scratch database probe, 2026-11-06');
  log('# Live database: NOT touched. The real lane.mjs and the built lane-context hook run against the scratch URL below.');
  const created = scratch('create', '--through', '5');
  if (created.status !== 0) throw new Error(`scratch create failed: ${created.stderr}`);
  url = JSON.parse(created.stdout).url;
  assertScratchUrl(url);
  log(`scratch database: ${maskUrl(url)}`);
  boards = makeBoards('zz-lsprobe', ['a', 'b', 'c']);
  const A = boards.boards.a; const B = boards.boards.b; const C = boards.boards.c;
  db = new Client({ connectionString: url });
  await db.connect();
  // This probe client writes lanes directly (due_at, owner). Say it knows about boards, like every writer.
  await db.query(`SELECT set_config('lane.client_version', '2', false)`);

  const lane = (dir, args, extra = {}) => {
    const r = spawnSync(process.execPath, [LANE, ...args], {
      cwd: dir, encoding: 'utf8', env: laneEnv(url, boards, { CLAUDE_CODE_SESSION_ID: SESSION, ...extra }),
    });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), all: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  };
  const a = (...args) => lane(A.dir, args);
  const json = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

  // ---- seed board a ---------------------------------------------------------------------------------------------
  // [suffix, track, state, band, priority, due_at offset in hours or null, held by SESSION]
  // The priority numbers are chosen so that sorting by priority alone gives the WRONG order.
  const seedA = [
    ['p0-late',   'alpha', 'ready',   'P0',   90, 120,  false],
    ['p0-soon',   'beta',  'ready',   'P0',   80,  24,  false],
    ['p0-nodue',  'alpha', 'backlog', 'P0',    5, null, false],
    ['p0-tie-a',  'beta',  'ready',   'P0',   70, null, false],
    ['p0-tie-b',  'alpha', 'ready',   'P0',   70, null, false],
    ['p1-x',      'beta',  'ready',   'P1',    1, null, false],
    ['p1-y',      'alpha', 'backlog', 'P1',    2,  72,  false],
    ['p2-z',      'alpha', 'ready',   'P2',    1, null, false],
    ['un-a',      'beta',  'ready',   'none',  1, null, false],
    ['un-b',      'alpha', 'backlog', 'none', 50,   1,  false],
    ['h-p0',      'alpha', 'active',  'P0',   99, null, true],
    ['h-p2',      'beta',  'active',  'P2',    1, null, true],
    ['h-un',      'beta',  'blocked', 'none',  1, null, true],
    ['h-done',    'beta',  'done',    'P0',    1, null, true],   // done: never in a board, next or mine list
    ['done-p0',   'alpha', 'done',    'P0',    1, null, false],
  ];
  for (const [s, track, state, band, prio, due, held] of seedA) {
    const r = a('add', P + s, '--title', `T ${s}`, '--track', track, '--state', state, '--band', band, '--priority', String(prio));
    if (r.code !== 0) throw new Error(`seed add ${s} failed: ${r.all}`);
    if (due !== null) await db.query(`UPDATE agentic_os.lane SET due_at = now() + make_interval(hours => $2) WHERE id = $1`, [P + s, due]);
    if (held) await db.query(`UPDATE agentic_os.lane SET owner_session_id = $2, lease_expires_at = now() + interval '30 minutes' WHERE id = $1`, [P + s, SESSION]);
  }
  // A P0 lane on board b must never show on board a.
  const fb = lane(B.dir, ['add', P + 'foreign', '--title', 'on b', '--band', 'P0', '--priority', '1']);
  if (fb.code !== 0) throw new Error(`seed foreign failed: ${fb.all}`);

  const flat = ['p0-soon', 'p0-late', 'p0-nodue', 'p0-tie-a', 'p0-tie-b', 'h-p0', 'p1-y', 'p1-x', 'h-p2', 'p2-z', 'un-b', 'h-un', 'un-a'].map((s) => P + s);

  log('\n## board --by priority: one flat list of open lanes in the shared order');
  let r = a('board', '--by', 'priority');
  check('exits 0', r.code === 0, r.all.split('\n')[0]);
  check('open lanes in exact key order (band, due_at NULLS LAST, priority, id)', same(rowIds(r.out), flat), JSON.stringify(rowIds(r.out)));
  check('no done lane, no lane of another board', !/zz-ls-(h-done|done-p0|foreign)/.test(r.out));
  const tags = rowTags(r.out).map((t) => t.split(' ')[0]);
  check('each row shows its band: P0 x6, P1 x2, P2 x2, "--" x3', same(tags, ['P0', 'P0', 'P0', 'P0', 'P0', 'P0', 'P1', 'P1', 'P2', 'P2', '--', '--', '--']), tags.join(' '));
  check('there are no track headers in the flat list', byTrack(r.out).length === 0 && !/^-- (alpha|beta) /m.test(r.out));
  r = a('board', '--by', 'priority', '--json');
  let j = json(r);
  check('--json lanes are in the same order and carry band and due_at', Array.isArray(j?.lanes) && same(j.lanes.map((l) => l.id), flat)
    && j.lanes.every((l) => 'band' in l && 'due_at' in l) && j.lanes[0].band === 'P0' && j.lanes[0].due_at !== null && j.lanes[2].due_at === null && j.lanes[12].band === null,
    r.err || JSON.stringify((j?.lanes || []).slice(0, 1)));
  r = a('board', '--by', 'nonsense');
  check('--by with an unknown value exits non-zero with a message', r.code !== 0 && r.err.length > 0, `exit ${r.code}: ${r.err.split('\n')[0]}`);

  log('\n## board: keeps its track groups, the key orders inside each track');
  r = a('board');
  const groups = byTrack(r.out);
  check('two track groups, alpha then beta', same(groups.map((g) => g.track), ['alpha', 'beta']), JSON.stringify(groups.map((g) => g.track)));
  check('alpha: key order', same(groups[0]?.ids, ['p0-late', 'p0-nodue', 'p0-tie-b', 'h-p0', 'p1-y', 'p2-z', 'un-b'].map((s) => P + s)), JSON.stringify(groups[0]?.ids));
  check('beta: key order', same(groups[1]?.ids, ['p0-soon', 'p0-tie-a', 'p1-x', 'h-p2', 'h-un', 'un-a'].map((s) => P + s)), JSON.stringify(groups[1]?.ids));
  r = a('board', '--json');
  j = json(r);
  check('board --json lanes carry band and due_at', Array.isArray(j?.lanes) && j.lanes.length === 13 && j.lanes.every((l) => 'band' in l && 'due_at' in l), r.err);

  log('\n## next: P0 before P1 before P2 before Unsorted, whatever the priority numbers');
  const claimable = ['p0-soon', 'p0-late', 'p0-nodue', 'p0-tie-a', 'p0-tie-b', 'p1-y', 'p1-x', 'p2-z', 'un-b', 'un-a'].map((s) => P + s);
  r = a('next', '--n', '20');
  check('claimable lanes in exact key order, bands shown', same(rowIds(r.out), claimable) && same(rowTags(r.out).map((t) => t.split(' ')[0]), ['P0', 'P0', 'P0', 'P0', 'P0', 'P1', 'P1', 'P2', '--', '--']), JSON.stringify(rowTags(r.out)));
  r = a('next');
  check('next with no --n returns the first 5 of that order', same(rowIds(r.out), claimable.slice(0, 5)), JSON.stringify(rowIds(r.out)));
  r = a('next', '--n', '20', '--json');
  j = json(r);
  check('next --json is an array in that order with band and due_at', Array.isArray(j) && same(j.map((l) => l.id), claimable) && j.every((l) => 'band' in l && 'due_at' in l), r.err);

  log('\n## mine: held lanes, same key, done excluded');
  const held = ['h-p0', 'h-p2', 'h-un'].map((s) => P + s);
  r = a('mine');
  check('held lanes in key order (P0 first although its priority number is 99), done lane left out', same(rowIds(r.out), held) && same(rowTags(r.out).map((t) => t.split(' ')[0]), ['P0', 'P2', '--']), JSON.stringify(rowTags(r.out)));
  r = a('mine', '--json');
  j = json(r);
  check('mine --json is an array in that order with band and due_at', Array.isArray(j) && same(j.map((l) => l.id), held) && j.every((l) => 'band' in l && 'due_at' in l), r.err);

  log('\n## the built lane-context hook (SessionStart payload into dist/lane-context.mjs)');
  // Board c: priority numbers run the opposite way to the bands, five claimable lanes (the hook shows 5), two held.
  const lc = (s, state, band, prio, due, held2) => ({ s, state, band, prio, due, held: held2 });
  const seedC = [lc('un', 'ready', 'none', 1, null, false), lc('p2', 'ready', 'P2', 2, null, false), lc('p1', 'backlog', 'P1', 3, null, false),
    lc('p0', 'ready', 'P0', 99, null, false), lc('p0d', 'ready', 'P0', 98, 48, false), lc('p0-done', 'done', 'P0', 1, null, false),
    lc('hp2', 'active', 'P2', 1, null, true), lc('hp0', 'active', 'P0', 99, null, true)];
  for (const x of seedC) {
    const rr = lane(C.dir, ['add', `zz-lc-${x.s}`, '--title', `C ${x.s}`, '--state', x.state, '--band', x.band, '--priority', String(x.prio)]);
    if (rr.code !== 0) throw new Error(`seed c ${x.s} failed: ${rr.all}`);
    if (x.due !== null) await db.query(`UPDATE agentic_os.lane SET due_at = now() + make_interval(hours => $2) WHERE id = $1`, [`zz-lc-${x.s}`, x.due]);
    if (x.held) await db.query(`UPDATE agentic_os.lane SET owner_session_id = $2, lease_expires_at = now() + interval '30 minutes' WHERE id = $1`, [`zz-lc-${x.s}`, HOOK_SESSION]);
  }
  const hookRun = spawnSync(process.execPath, [HOOK], {
    cwd: C.dir, encoding: 'utf8',
    input: JSON.stringify({ session_id: HOOK_SESSION, hook_event_name: 'SessionStart', cwd: C.dir }),
    env: laneEnv(url, boards, {
      LANE_BOARD_CACHE: join(boards.tmp, 'board-cache.json'), LANE_CONTEXT_ERROR_LOG: join(boards.tmp, 'lane-context-errors.log'),
      CCV3_USER_HOME: boards.tmp,
    }),
  });
  writeFileSync(HOOK_OUT, (hookRun.stdout || '{}') + '\n');
  let ctx = '';
  try { ctx = JSON.parse(hookRun.stdout).hookSpecificOutput.additionalContext; } catch { /* checked below */ }
  check('the hook exits 0 and prints a SessionStart banner', hookRun.status === 0 && ctx.includes(`Lane board ${C.key}`), (hookRun.stderr || '').split('\n')[0] || (hookRun.stdout || '').slice(0, 120));
  const claimLines = ctx.split('\n');
  const at = claimLines.findIndex((l) => l.startsWith('Claimable next:'));
  const got = []; if (at >= 0) for (const l of claimLines.slice(at + 1)) { const m = l.match(/^ {2}(P[012]|--) (zz-lc-\S+)\s/); if (!m) break; got.push(`${m[1]} ${m[2]}`); }
  check('Claimable next: band order with the band printed before each id (P0 due soonest, P0, P1, P2, Unsorted)',
    same(got, ['P0 zz-lc-p0d', 'P0 zz-lc-p0', 'P1 zz-lc-p1', 'P2 zz-lc-p2', '-- zz-lc-un']), JSON.stringify(got));
  check('the done P0 lane is not offered, not held', !ctx.split('Commands:')[0].includes('zz-lc-p0-done'));  // the event list below the banner may name it
  check('You hold: band order with the band printed (P0 first although its priority number is 99)',
    ctx.includes('You hold: P0 zz-lc-hp0, P2 zz-lc-hp2'), (ctx.match(/You hold:.*/) || [''])[0]);
  const noBandHook = spawnSync(process.execPath, [HOOK], { cwd: A.dir, encoding: 'utf8', input: JSON.stringify({ session_id: HOOK_SESSION, hook_event_name: 'UserPromptSubmit', cwd: A.dir }), env: laneEnv(url, boards, { LANE_BOARD_CACHE: join(boards.tmp, 'board-cache.json'), LANE_CONTEXT_ERROR_LOG: join(boards.tmp, 'lane-context-errors.log'), CCV3_USER_HOME: boards.tmp }) });
  check('a prompt-submit run (no banner) still exits 0', noBandHook.status === 0);
} catch (e) {
  log(`ERROR: ${e.stack || e.message}`);
  results.push(['driver error', false]);
} finally {
  if (db) await db.end().catch(() => {});
  if (url) {
    try { assertScratchUrl(url); const d = scratch('drop', url); log(`drop: ${d.stdout.trim() || d.stderr.trim()}`); } catch (e) { log(`drop failed: ${e.message}`); results.push(['drop', false]); }
  }
  if (boards) boards.cleanup();
  const failed = results.filter((x) => !x[1]).length;
  log(`\nSUMMARY: ${results.length - failed} passed, ${failed} failed (of ${results.length} checks)`);
  process.exitCode = failed ? 1 : 0;
}
