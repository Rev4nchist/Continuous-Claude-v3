#!/usr/bin/env node
/**
 * lane-band-probe -- the end-to-end gate for the lane band writers (phase 2 of the lane priority design).
 *
 * Runs the REAL scripts/coordination/lane.mjs as a child process against a SCRATCH database
 * (lanes_pr1_*, migrations through 0005) that this probe creates and drops. It never touches the live
 * database. Boards come from a temp registry (probe-boards.mjs), never the real one.
 *
 *   node scripts/coordination/lane-band-probe.mjs
 *
 * The transcript goes to .claude/cache/e2e/2026-11-06-lane-band-probe.txt (overwritten).
 * Exit 0: all checks pass. Exit 1: a check failed.
 * Design: .claudedocs/2026-11-06-lane-priority-design.md, "Build phases", phase 2.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertScratchUrl, maskUrl } from './scratch-db.mjs';
import { laneEnv, makeBoards } from './probe-boards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LANE = join(HERE, 'lane.mjs');
const SCRATCH = join(HERE, 'scratch-db.mjs');
const OUT = join(REPO, '.claude', 'cache', 'e2e', '2026-11-06-lane-band-probe.txt');
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, '');

function loadPg() {
  for (const anchor of [join(REPO, '.claude', 'hooks', 'package.json'), join(REPO, 'apps', 'agentic-os', 'package.json')]) {
    try { return createRequire(pathToFileURL(anchor)).call(null, 'pg'); } catch { /* next */ }
  }
  throw new Error('cannot resolve `pg`. Looked in .claude/hooks and apps/agentic-os.');
}
const { Client } = loadPg();

const log = (s = '') => { const t = String(s).replace(/(postgresql:\/\/[^:]+:)[^@]+@/g, '$1***@'); appendFileSync(OUT, t + '\n'); console.log(t); };
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };

const SESSION = 'zz-lbprobe-session';
const scratch = (...args) => spawnSync(process.execPath, [SCRATCH, ...args], { encoding: 'utf8' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** jsonb does not keep key order, so compare an event's detail field by field. */
const detailIs = (e, from, to) => e?.detail !== undefined && Object.keys(e.detail).length === 2 && e.detail.from === from && e.detail.to === to;

let boards = null; let urlA = null; let urlOld = null; let db = null;
try {
  log('# lane band writers: scratch database probe, 2026-11-06');
  log('# Live database: NOT touched. The real lane.mjs runs against the scratch URL below.');
  const created = scratch('create', '--through', '5');
  if (created.status !== 0) throw new Error(`scratch create failed: ${created.stderr}`);
  urlA = JSON.parse(created.stdout).url;
  assertScratchUrl(urlA);
  log(`scratch database: ${maskUrl(urlA)}`);
  boards = makeBoards('zz-lbprobe', ['a', 'b']);
  const A = boards.boards.a; const B = boards.boards.b;
  db = new Client({ connectionString: urlA });
  await db.connect();

  /** Run the real lane.mjs. `dir` is the cwd, which picks the board through the temp registry. */
  const lane = (url, dir, args) => {
    const r = spawnSync(process.execPath, [LANE, ...args], {
      cwd: dir, encoding: 'utf8', env: laneEnv(url, boards, { CLAUDE_CODE_SESSION_ID: SESSION }),
    });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), all: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  };
  const a = (...args) => lane(urlA, A.dir, args);
  const b = (...args) => lane(urlA, B.dir, args);
  const row = async (id) => (await db.query('SELECT title, band, priority, project_key FROM agentic_os.lane WHERE id=$1', [id])).rows[0] ?? null;
  const events = async (id) => (await db.query(
    `SELECT body, detail, project_key FROM agentic_os.lane_event WHERE lane_id=$1 AND kind='band' ORDER BY id`, [id])).rows;
  const X = 'zz-lb-x'; const Y = 'zz-lb-y'; const Z = 'zz-lb-z'; const F = 'zz-lb-f';

  log('\n## add: new lane, then add again');
  let r = a('add', X, '--title', 'X one');
  check('add new lane exits 0', r.code === 0, r.all);
  check('add output shows band none and priority 50', /band none/.test(r.out) && /priority 50/.test(r.out), r.out);
  check('new lane: band NULL, priority 50', same(await row(X), { title: 'X one', band: null, priority: 50, project_key: A.key }), JSON.stringify(await row(X)));
  r = a('add', X, '--title', 'X one');
  check('add again with no flags: nothing changes', r.code === 0 && same(await row(X), { title: 'X one', band: null, priority: 50, project_key: A.key }));
  r = a('add', Y, '--title', 'Y', '--priority', '20', '--band', 'P2');
  check('add with --priority 20 --band P2 on a new lane', r.code === 0 && same(await row(Y), { title: 'Y', band: 'P2', priority: 20, project_key: A.key }), JSON.stringify(await row(Y)));
  r = a('add', Y, '--title', 'Y renamed');
  check('add again with no flags keeps priority 20 and band P2, title still updates',
    r.code === 0 && same(await row(Y), { title: 'Y renamed', band: 'P2', priority: 20, project_key: A.key }), JSON.stringify(await row(Y)));

  log('\n## band verb');
  r = a('band', X, 'P0');
  check('band X P0 exits 0 and prints old and new', r.code === 0 && /none/.test(r.out) && /P0/.test(r.out), r.all);
  check('band X P0 stored', (await row(X))?.band === 'P0');
  r = a('add', X, '--title', 'X one');
  check('add again with no flags: band P0 and priority 50 both stay', r.code === 0 && (await row(X))?.band === 'P0' && (await row(X))?.priority === 50, JSON.stringify(await row(X)));
  r = a('add', X, '--title', 'X one', '--priority', '7');
  check('add with explicit --priority 7: priority 7, band stays P0', r.code === 0 && (await row(X))?.priority === 7 && (await row(X))?.band === 'P0', JSON.stringify(await row(X)));
  r = a('add', X, '--title', 'X one');
  check('add again with no flags: priority 7 and band P0 stay', r.code === 0 && (await row(X))?.priority === 7 && (await row(X))?.band === 'P0', JSON.stringify(await row(X)));
  r = a('band', X, 'none');
  check('band X none sets NULL', r.code === 0 && (await row(X))?.band === null, r.all);
  r = a('band', X, 'P1');
  check('band X P1 stored', r.code === 0 && (await row(X))?.band === 'P1', r.all);
  const before2 = (await events(X)).length;
  r = a('band', X, 'P1');
  check('band X P1 a second time says unchanged', r.code === 0 && /unchanged/.test(r.out), r.all);
  check('the unchanged call wrote no event', (await events(X)).length === before2);
  await a('add', Z, '--title', 'Z');
  r = a('band', Z, 'none');
  check('band Z none on a NULL band says unchanged and writes no event', r.code === 0 && /unchanged/.test(r.out) && (await events(Z)).length === 0, r.all);
  r = a('add', X, '--title', 'X one', '--band', 'none');
  check('add --band none on a P1 lane writes NULL (explicit flag wins)', r.code === 0 && (await row(X))?.band === null, r.all);
  await a('band', X, 'P1');
  r = a('band', X, 'P2', '--json');
  let j = null; try { j = JSON.parse(r.out); } catch { /* checked below */ }
  check('band --json returns id, from, to, changed', r.code === 0 && j?.id === X && j?.from === 'P1' && j?.to === 'P2' && j?.changed === true, r.out);
  await a('band', X, 'P1');

  log('\n## events: one band event per real change');
  const ev = await events(X);
  // Real changes made by the band verb, in order. The unchanged P1 call and the add --band none write no band event.
  const expect = ['band none -> P0', 'band P0 -> none', 'band none -> P1', 'band none -> P1', 'band P1 -> P2', 'band P2 -> P1'];
  check('X has exactly one band event per real band-verb change, in order', same(ev.map((e) => e.body), expect), JSON.stringify(ev.map((e) => e.body)));
  check('first band event detail is {from:null,to:"P0"} on board a', detailIs(ev[0], null, "P0") && ev[0]?.project_key === A.key, JSON.stringify(ev[0]));
  check('second band event detail is {from:"P0",to:null}', detailIs(ev[1], "P0", null), JSON.stringify(ev[1]));
  check('the P1 -> P2 event detail is {from:"P1",to:"P2"}', detailIs(ev[4], "P1", "P2"), JSON.stringify(ev[4]));

  log('\n## invalid input changes nothing');
  const snapX = await row(X); const evCount = (await events(X)).length;
  const bad = [
    ['--band P9', ['add', X, '--title', 'CHANGED', '--band', 'P9']],
    ['--band p0', ['add', X, '--title', 'CHANGED', '--band', 'p0']],
    ['--band (no value)', ['add', X, '--title', 'CHANGED', '--band']],
    ['--priority abc', ['add', X, '--title', 'CHANGED', '--priority', 'abc']],
    ['--priority 0', ['add', X, '--title', 'CHANGED', '--priority', '0']],
    ['--priority -3', ['add', X, '--title', 'CHANGED', '--priority', '-3']],
    ['--priority 1000', ['add', X, '--title', 'CHANGED', '--priority', '1000']],
    ['--priority 1.5', ['add', X, '--title', 'CHANGED', '--priority', '1.5']],
    ['--priority "" (empty)', ['add', X, '--title', 'CHANGED', '--priority', '']],
    ['--priority (no value)', ['add', X, '--title', 'CHANGED', '--priority']],
    ['band X P9', ['band', X, 'P9']],
    ['band X p0', ['band', X, 'p0']],
    ['band X (no value)', ['band', X]],
    ['band nosuch-lane P0', ['band', 'zz-lb-nosuch', 'P0']],
  ];
  for (const [label, args] of bad) {
    r = a(...args);
    const unchanged = same(await row(X), snapX) && (await events(X)).length === evCount && (await row('zz-lb-nosuch')) === null;
    check(`${label}: exit non-zero with a message, nothing written`, r.code !== 0 && r.err.length > 0 && unchanged, `exit ${r.code}: ${r.err.split('\n')[0]}`);
  }
  r = a('add', 'zz-lb-bad', '--title', 'bad', '--priority', 'abc');
  check('a bad --priority on a NEW lane does not create it (no silent 50)', r.code !== 0 && (await row('zz-lb-bad')) === null);

  log('\n## seed');
  const seedFile = join(boards.tmp, 'seed.json');
  const seed = (items) => { writeFileSync(seedFile, JSON.stringify(items)); return a('seed', seedFile); };
  r = seed([{ id: 'zz-lb-s1', title: 'S1', band: 'P0' }, { id: 'zz-lb-s2', title: 'S2', band: 'P9' }]);
  check('seed with a bad band rejects the whole file (exit non-zero, no lane written)', r.code !== 0 && (await row('zz-lb-s1')) === null && (await row('zz-lb-s2')) === null, `exit ${r.code}: ${r.err.split('\n')[0]}`);
  r = seed([{ id: 'zz-lb-s1', title: 'S1' }, { id: 'zz-lb-s2', title: 'S2', priority: 1000 }]);
  check('seed with a bad priority rejects the whole file', r.code !== 0 && (await row('zz-lb-s1')) === null && (await row('zz-lb-s2')) === null, `exit ${r.code}: ${r.err.split('\n')[0]}`);
  r = seed([{ id: 'zz-lb-s1', title: 'S1' }, { id: 'zz-lb-s2', title: 'S2', band: 'p1' }]);
  check('seed with a lower-case band rejects the whole file', r.code !== 0 && (await row('zz-lb-s1')) === null, `exit ${r.code}`);
  r = seed([{ id: 'zz-lb-s1', title: 'S1', band: 'P0' }, { id: 'zz-lb-s2', title: 'S2' }]);
  check('seed new lanes: s1 has band P0 priority 50, s2 band NULL priority 50',
    r.code === 0 && same(await row('zz-lb-s1'), { title: 'S1', band: 'P0', priority: 50, project_key: A.key }) && (await row('zz-lb-s2'))?.band === null, r.all);
  await a('add', 'zz-lb-s1', '--title', 'S1', '--priority', '33');
  r = seed([{ id: 'zz-lb-s1', title: 'S1 renamed' }]);
  check('seed on conflict with no band and no priority keeps both (P0, 33), title updates',
    r.code === 0 && same(await row('zz-lb-s1'), { title: 'S1 renamed', band: 'P0', priority: 33, project_key: A.key }), JSON.stringify(await row('zz-lb-s1')));
  r = seed([{ id: 'zz-lb-s1', title: 'S1 renamed', priority: 9 }]);
  check('seed with explicit priority 9 writes it, band stays P0', r.code === 0 && (await row('zz-lb-s1'))?.priority === 9 && (await row('zz-lb-s1'))?.band === 'P0', JSON.stringify(await row('zz-lb-s1')));
  r = seed([{ id: 'zz-lb-s1', title: 'S1 renamed', band: 'P2' }]);
  check('seed with explicit band P2 writes it, priority stays 9', r.code === 0 && (await row('zz-lb-s1'))?.band === 'P2' && (await row('zz-lb-s1'))?.priority === 9, JSON.stringify(await row('zz-lb-s1')));
  r = seed([{ id: 'zz-lb-s1', title: 'S1 renamed', band: 'none' }]);
  check('seed with band "none" writes NULL', r.code === 0 && (await row('zz-lb-s1'))?.band === null, r.all);

  log('\n## a lane of another board');
  r = b('add', F, '--title', 'F on b');
  check('lane F added on board b', r.code === 0 && (await row(F))?.project_key === B.key, r.all);
  const snapF = await row(F);
  r = a('band', F, 'P0');
  check('band on a lane of another board exits 1 and names that board, nothing written',
    r.code === 1 && r.err.includes(B.key) && same(await row(F), snapF) && (await events(F)).length === 0, `exit ${r.code}: ${r.err.split('\n')[0]}`);
  r = a('add', F, '--title', 'hijack', '--band', 'P0', '--priority', '5');
  check('add --band --priority on a lane of another board is refused, nothing written',
    r.code !== 0 && /belongs to board/.test(r.err) && same(await row(F), snapF), `exit ${r.code}: ${r.err.split('\n')[0]}`);
  r = b('band', F, 'P0');
  check('band from the right board works with no claim held', r.code === 0 && (await row(F))?.band === 'P0', r.all);
  check('that event is on board b', (await events(F)).length === 1 && (await events(F))[0].project_key === B.key);

  log('\n## a database without migration 0005 (deploy order: lane.mjs may ship before the migration)');
  const old = scratch('create', '--through', '4');
  if (old.status !== 0) throw new Error(`scratch create (through 4) failed: ${old.stderr}`);
  urlOld = JSON.parse(old.stdout).url;
  assertScratchUrl(urlOld);
  const o = (...args) => lane(urlOld, A.dir, args);
  r = o('add', 'zz-lb-old', '--title', 'old db');
  check('add with no band flag still works on a 0004 database', r.code === 0, r.all);
  r = o('add', 'zz-lb-old', '--title', 'old db', '--priority', '12');
  check('add --priority still works on a 0004 database', r.code === 0, r.all);
  r = o('band', 'zz-lb-old', 'P0');
  check('band on a 0004 database says migration 0005 is not applied', r.code === 1 && /0005/.test(r.err), r.err.split('\n')[0]);
  r = o('add', 'zz-lb-old', '--title', 'old db', '--band', 'P0');
  check('add --band on a 0004 database says migration 0005 is not applied', r.code === 1 && /0005/.test(r.err), r.err.split('\n')[0]);
} catch (e) {
  log(`ERROR: ${e.stack || e.message}`);
  results.push(['driver error', false]);
} finally {
  if (db) await db.end().catch(() => {});
  for (const u of [urlA, urlOld]) {
    if (!u) continue;
    try { assertScratchUrl(u); const d = scratch('drop', u); log(`drop: ${d.stdout.trim() || d.stderr.trim()}`); } catch (e) { log(`drop failed: ${e.message}`); results.push(['drop', false]); }
  }
  if (boards) boards.cleanup();
  const failed = results.filter((x) => !x[1]).length;
  log(`\nSUMMARY: ${results.length - failed} passed, ${failed} failed (of ${results.length} checks)`);
  process.exitCode = failed ? 1 : 0;
}


