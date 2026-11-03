/**
 * session-identity-probe -- the end-to-end gate for session names in lane.mjs.
 *
 * `session-label.test.mjs` covers the pure rules. This file proves the part a
 * unit test cannot: the real `lane.mjs` against the real local Postgres, with
 * fake identity files in a temp CCV3_IDENTITY_DIR.
 *
 *   node scripts/coordination/session-identity-probe.mjs
 *
 * Checks, in the order they can fail:
 *   1. whoami prints "name #sid8", the uuid and the held lanes
 *   2. adopt moves open lanes, unread direct messages and the inbox cursor
 *   3. adopt run twice moves nothing the second time
 *   4. adopt refuses when the names differ and `previous` is not set
 *   5. say --to <name> picks the live session; skips a `previous`; errors on two
 *   6. say --to <hex prefix> still works; a % in the prefix is not a wildcard
 *   7. inbox prints "HH:MM CST|CDT  from -> to"
 *   8. board --json keeps "me" as the plain id and adds me_short, me_name, owner_name; peers has no "on:"
 *   9. adopt refuses a live old session (no endedAt, fresh heartbeat), allows a quiet one
 *  10. adopt steps the cursor back when the new session already read past a moved DM
 *  11. say/note --agent store detail.agent, inbox shows "name/agent #sid8"; a bad agent is ignored
 *  12. a uuid inside an identity file does not redirect say --to <name>
 *
 * Every row and file it writes is removed, including on failure. Lane ids start
 * with `zz-sid-probe-`; session ids are random uuids tracked in SESSIONS.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LANE = join(HERE, 'lane.mjs');

function loadPg() {
  for (const anchor of [
    join(REPO, '.claude', 'hooks', 'package.json'),
    join(REPO, 'apps', 'agentic-os', 'package.json'),
  ]) {
    try { return createRequire(pathToFileURL(anchor)).call(null, 'pg'); } catch { /* next */ }
  }
  throw new Error('cannot resolve `pg`. Looked in .claude/hooks and apps/agentic-os.');
}
const { Client } = loadPg();
const CONN = process.env.CONTINUOUS_CLAUDE_DB_URL
  || process.env.DATABASE_URL
  || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';

const DIR = mkdtempSync(join(tmpdir(), 'ccv3-identity-probe-'));
const PREFIX = 'zz-sid-probe-';
const SESSIONS = [];
const sid = () => { const u = randomUUID(); SESSIONS.push(u); return u; };
const s8 = (u) => u.slice(0, 8);

function writeId(uuid, o = {}) {
  writeFileSync(join(DIR, `${uuid}.json`), JSON.stringify({
    uuid, short: s8(uuid), name: null, previous: null, cwd: null,
    endedAt: null, endReason: null, updatedAt: new Date().toISOString(), ...o,
  }));
}

/** Write an identity file whose name and content uuid can disagree. */
function writeIdAs(file, content) {
  writeFileSync(join(DIR, `${file}.json`), JSON.stringify(content));
}

function lane(as, ...args) {
  const r = spawnSync(process.execPath, [LANE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: as, CCV3_IDENTITY_DIR: DIR },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}

/** lane() without blocking the event loop, so this process can commit another transaction meanwhile. */
function laneAsync(as, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [LANE, ...args], {
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: as, CCV3_IDENTITY_DIR: DIR },
    });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err, all: `${out}${err}` }));
  });
}

const results = [];
function check(name, fn) {
  try { fn(); results.push([true, name]); } catch (e) { results.push([false, `${name} -- ${e.message}`]); }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

async function connect() {
  for (let i = 0; i < 4; i++) {
    const c = new Client({ connectionString: CONN, connectionTimeoutMillis: 4000 });
    try { await c.connect(); return c; } catch (e) {
      if (i === 3) throw e;
      await new Promise((r) => setTimeout(r, 60000));
    }
  }
}

async function cleanup(c) {
  await c.query(`DELETE FROM agentic_os.lane_event WHERE session_id = ANY($1) OR to_session_id = ANY($1) OR lane_id LIKE $2`, [SESSIONS, `${PREFIX}%`]);
  await c.query(`DELETE FROM agentic_os.lane_watermark WHERE session_id = ANY($1)`, [SESSIONS]);
  await c.query(`DELETE FROM agentic_os.lane WHERE id LIKE $1`, [`${PREFIX}%`]);
  await c.query(`DELETE FROM sessions WHERE id = ANY($1)`, [SESSIONS]);
  rmSync(DIR, { recursive: true, force: true });
}

const c = await connect();
try {
  const A = sid(); // old session, named probe-trex
  const B = sid(); // new session after /clear, same name, previous = A
  const C = sid(); // another live session, other name
  const D = sid(); // a session with another name
  const E = sid(); // a second live session also named probe-trex
  for (const u of [A, B, C, D, E]) {
    await c.query(`INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,'zz-sid-probe','secret prompt text',now())`, [u]);
  }
  writeId(A, { name: 'probe-trex', endedAt: new Date().toISOString(), endReason: 'clear' });
  writeId(B, { name: 'probe-trex', previous: A });
  writeId(C, { name: 'probe-cat' });
  writeId(D, { name: 'probe-dog' });

  const mk = (id, owner) => c.query(
    `INSERT INTO agentic_os.lane (id,title,track,state,owner_session_id,lease_expires_at)
     VALUES ($1,'probe lane','zz-probe','active',$2, now() + interval '30 minutes')`, [id, owner]);
  await mk(`${PREFIX}1`, A);
  await mk(`${PREFIX}2`, A);
  await mk(`${PREFIX}3`, C);

  const last = (await c.query(`SELECT COALESCE(max(id),0)::int AS n FROM agentic_os.lane_event`)).rows[0].n;
  await c.query(`INSERT INTO agentic_os.lane_watermark (session_id,last_event_id) VALUES ($1,$2)`, [A, last]);
  await c.query(
    `INSERT INTO agentic_os.lane_event (lane_id,kind,session_id,to_session_id,body) VALUES ($1,'note',$2,$3,'probe dm one')`,
    [`${PREFIX}1`, C, A]);

  // 1. whoami
  const w = lane(B, 'whoami');
  check('whoami prints label, uuid', () => {
    must(w.code === 0, `exit ${w.code}: ${w.err}`);
    must(w.out.includes(`probe-trex #${s8(B)}`), w.out);
    must(w.out.includes(B), 'uuid missing');
  });

  // 4 first: a refused adopt must change nothing.
  const refused = lane(D, 'adopt', '--from', C);
  check('adopt refuses a different name (exit 3)', () => {
    must(refused.code === 3, `exit ${refused.code}: ${refused.all}`);
  });
  const still = (await c.query(`SELECT owner_session_id FROM agentic_os.lane WHERE id=$1`, [`${PREFIX}3`])).rows[0];
  check('refused adopt did not move the lane', () => must(still.owner_session_id === C, 'lane moved'));

  // 2. adopt
  const ad = lane(B, 'adopt', '--from', A);
  const lanesNow = (await c.query(`SELECT id, owner_session_id FROM agentic_os.lane WHERE id IN ($1,$2)`, [`${PREFIX}1`, `${PREFIX}2`])).rows;
  const dm = (await c.query(`SELECT to_session_id FROM agentic_os.lane_event WHERE body='probe dm one' AND session_id=$1`, [C])).rows[0];
  const wm = (await c.query(`SELECT last_event_id::int AS n FROM agentic_os.lane_watermark WHERE session_id=$1`, [B])).rows[0];
  check('adopt moves lanes, the unread DM and the cursor', () => {
    must(ad.code === 0, `exit ${ad.code}: ${ad.all}`);
    must(lanesNow.every((l) => l.owner_session_id === B), 'lanes not moved');
    must(dm.to_session_id === B, 'DM not moved');
    must(wm && wm.n === last, `cursor ${JSON.stringify(wm)} != ${last}`);
    must(/2 lane/.test(ad.out) && /1 message/.test(ad.out), ad.out);
  });

  // 3. idempotent
  const ad2 = lane(B, 'adopt', '--from', A);
  check('adopt twice moves nothing the second time', () => {
    must(ad2.code === 0, `exit ${ad2.code}: ${ad2.all}`);
    must(/nothing to move/.test(ad2.out), ad2.out);
  });

  // 5. name lookup
  const toName = lane(C, 'say', 'probe hello', '--to', 'PROBE-TREX');
  check('say --to <name> (any case) picks the live session, skips previous', () => {
    must(toName.code === 0, `exit ${toName.code}: ${toName.all}`);
    must(toName.out.includes(`sent to probe-trex #${s8(B)}`), toName.out);
  });
  writeId(E, { name: 'probe-trex' });
  const amb = lane(C, 'say', 'x', '--to', 'probe-trex');
  check('two live sessions with one name is an error listing each', () => {
    must(amb.code === 1, `exit ${amb.code}: ${amb.all}`);
    must(amb.err.includes(`probe-trex #${s8(B)}`) && amb.err.includes(`probe-trex #${s8(E)}`), amb.err);
  });

  // 6. hex prefix + LIKE escaping
  const hex = lane(D, 'say', 'by hex', '--to', s8(C));
  check('say --to <hex prefix> still works', () => {
    must(hex.code === 0, `exit ${hex.code}: ${hex.all}`);
    must(hex.out.includes(`sent to probe-cat #${s8(C)}`), hex.out);
  });
  const wild = lane(D, 'say', 'wild', '--to', '%');
  const wild2 = lane(D, 'say', 'wild', '--to', '_');
  check('a % or _ in --to is not a wildcard', () => {
    must(wild.code === 1 && /no recent session/.test(wild.err), `% -> ${wild.all}`);
    must(wild2.code === 1 && /no recent session/.test(wild2.err), `_ -> ${wild2.all}`);
  });

  // 7. inbox
  const inbox = lane(B, 'inbox', '--peek');
  check('inbox prints "HH:MM CST|CDT  from -> to"', () => {
    must(inbox.code === 0, `exit ${inbox.code}: ${inbox.all}`);
    must(new RegExp(`^\\d\\d:\\d\\d (CST|CDT)  probe-cat #${s8(C)} -> probe-trex #${s8(B)}`, 'm').test(inbox.out), inbox.out);
  });

  // 8. board --json and peers
  const bj = lane(B, 'board', '--json');
  check('board --json keeps me as the id string and adds me_short, me_name, owner_name', () => {
    must(bj.code === 0, `exit ${bj.code}: ${bj.all}`);
    const j = JSON.parse(bj.out);
    must(j.me === B, `me ${JSON.stringify(j.me)}`);
    must(j.me_short === s8(B) && j.me_name === 'probe-trex', `${j.me_short} ${j.me_name}`);
    const l1 = j.lanes.find((l) => l.id === `${PREFIX}1`);
    const l3 = j.lanes.find((l) => l.id === `${PREFIX}3`);
    must(l1 && l1.owner_name === 'probe-trex', JSON.stringify(l1));
    must(l3 && l3.owner_name === 'probe-cat', JSON.stringify(l3));
  });
  const peers = lane(B, 'peers');
  check('peers shows the label and "<first> +N", not the prompt text', () => {
    must(peers.code === 0, `exit ${peers.code}: ${peers.all}`);
    must(!/secret prompt text/.test(peers.out) && !/\bon:/.test(peers.out), 'prompt text still shown');
    must(peers.out.includes(`probe-trex #${s8(B)}`), peers.out);
    must(new RegExp(`${PREFIX}1 \\+1`).test(peers.out), peers.out);
  });
  const board = lane(B, 'board');
  check('board header shows me=<label>', () => {
    must(board.out.split('\n')[0].includes(`me=probe-trex #${s8(B)}`), board.out.split('\n')[0]);
  });

  // 9. adopt must not take lanes from a live session
  const LIVE = sid(); const LIVE2 = sid(); const QUIET = sid(); const QUIET2 = sid();
  for (const u of [LIVE, LIVE2]) {
    await c.query(`INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,'zz-sid-probe','x',now())`, [u]);
  }
  for (const u of [QUIET, QUIET2]) {
    await c.query(
      `INSERT INTO sessions (id, project, working_on, last_heartbeat, last_activity_at)
       VALUES ($1,'zz-sid-probe','x', now() - interval '30 minutes', now() - interval '30 minutes')`, [u]);
  }
  writeId(LIVE, { name: 'probe-live' });
  writeId(LIVE2, { name: 'probe-live' });
  writeId(QUIET, { name: 'probe-quiet' });
  writeId(QUIET2, { name: 'probe-quiet' });
  await mk(`${PREFIX}live`, LIVE);
  await mk(`${PREFIX}quiet`, QUIET);
  const liveAd = lane(LIVE2, 'adopt', '--from', LIVE);
  const liveLane = (await c.query(`SELECT owner_session_id FROM agentic_os.lane WHERE id=$1`, [`${PREFIX}live`])).rows[0];
  check('adopt refuses a same-name old session that has not ended (exit 3, lane stays)', () => {
    must(liveAd.code === 3, `exit ${liveAd.code}: ${liveAd.all}`);
    must(/not ended/.test(liveAd.err), liveAd.err);
    must(liveLane.owner_session_id === LIVE, 'lane moved off a live session');
  });
  const quietAd = lane(QUIET2, 'adopt', '--from', QUIET);
  const quietLane = (await c.query(`SELECT owner_session_id FROM agentic_os.lane WHERE id=$1`, [`${PREFIX}quiet`])).rows[0];
  check('adopt allows an old session quiet for over 5 minutes', () => {
    must(quietAd.code === 0, `exit ${quietAd.code}: ${quietAd.all}`);
    must(quietLane.owner_session_id === QUIET2, 'lane not moved');
  });
  const badFrom = lane(LIVE2, 'adopt', '--from', '../x');
  check('adopt --from refuses an id that is not a session id', () => {
    must(badFrom.code === 1 && /not a session id/.test(badFrom.err), badFrom.all);
  });

  // 10. cursor step-back: the new session already read past a DM that adopt moves
  const OLD = sid(); const NEW = sid();
  for (const u of [OLD, NEW]) {
    await c.query(`INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,'zz-sid-probe','x',now())`, [u]);
  }
  writeId(OLD, { name: 'probe-step', endedAt: new Date().toISOString(), endReason: 'clear' });
  writeId(NEW, { name: 'probe-step', previous: OLD });
  const base = (await c.query(`SELECT COALESCE(max(id),0)::int AS n FROM agentic_os.lane_event`)).rows[0].n;
  await c.query(`INSERT INTO agentic_os.lane_watermark (session_id,last_event_id) VALUES ($1,$2)`, [OLD, base]);
  const dmId = (await c.query(
    `INSERT INTO agentic_os.lane_event (kind,session_id,to_session_id,body) VALUES ('note',$1,$2,'probe step dm') RETURNING id::int AS n`,
    [C, OLD])).rows[0].n;
  await c.query(`INSERT INTO agentic_os.lane_watermark (session_id,last_event_id) VALUES ($1,$2)`, [NEW, dmId + 5]);
  const step = lane(NEW, 'adopt', '--from', OLD, '--json');
  const wm2 = (await c.query(`SELECT last_event_id::int AS n FROM agentic_os.lane_watermark WHERE session_id=$1`, [NEW])).rows[0];
  const seen = lane(NEW, 'inbox', '--peek');
  check('adopt steps the cursor back to just before the moved DM', () => {
    must(step.code === 0, `exit ${step.code}: ${step.all}`);
    must(JSON.parse(step.out).cursor === 'stepped back', step.out);
    must(wm2.n === dmId - 1, `cursor ${wm2.n} != ${dmId - 1}`);
    must(seen.out.includes('probe step dm'), seen.out);
  });

  // 12. lane-context writes the new session's watermark at SessionStart while adopt runs. adopt reads no
  // row, then its insert waits on the other transaction's key. When that commits, the insert must not
  // fail and roll back the whole adopt. A second connection holds the row uncommitted to force the order.
  const ROLD = sid(); const RNEW = sid();
  for (const u of [ROLD, RNEW]) {
    await c.query(`INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,'zz-sid-probe','x',now())`, [u]);
  }
  writeId(ROLD, { name: 'probe-race', endedAt: new Date().toISOString(), endReason: 'clear' });
  writeId(RNEW, { name: 'probe-race', previous: ROLD });
  await c.query(`INSERT INTO agentic_os.lane_watermark (session_id,last_event_id) VALUES ($1,1)`, [ROLD]);
  await mk(`${PREFIX}race`, ROLD);
  const c2 = await connect();
  await c2.query('BEGIN');
  await c2.query(`INSERT INTO agentic_os.lane_watermark (session_id,last_event_id) VALUES ($1,1)`, [RNEW]);
  const pending = laneAsync(RNEW, 'adopt', '--from', ROLD);
  await new Promise((r) => setTimeout(r, 3000));
  await c2.query('COMMIT');
  await c2.end();
  const race = await pending;
  const raceLane = (await c.query(`SELECT owner_session_id FROM agentic_os.lane WHERE id=$1`, [`${PREFIX}race`])).rows[0];
  check('adopt survives a concurrent watermark insert for the new session (lane moves)', () => {
    must(race.code === 0, `exit ${race.code}: ${race.all}`);
    must(raceLane.owner_session_id === RNEW, 'adopt rolled back: lane still on the old session');
  });

  // 11. --agent on say and note
  const sayA = lane(B, 'say', '--agent', 'kraken', 'agent hello', '--to', 'probe-cat');
  const sayBad = lane(B, 'say', '--agent', 'bad agent;x', 'bad agent hello', '--to', 'probe-cat');
  const noteA = lane(B, 'note', `${PREFIX}1`, '--agent', 'critic', 'agent note');
  const ev = (await c.query(
    `SELECT body, detail FROM agentic_os.lane_event WHERE session_id=$1 AND body = ANY($2) ORDER BY id`,
    [B, ['agent hello', 'bad agent hello', 'agent note']])).rows;
  const byBody = Object.fromEntries(ev.map((r) => [r.body, r.detail]));
  const inboxC = lane(C, 'inbox', '--peek');
  check('say and note store detail.agent; an invalid agent is ignored', () => {
    must(sayA.code === 0 && sayBad.code === 0 && noteA.code === 0, `${sayA.all} ${sayBad.all} ${noteA.all}`);
    must(byBody['agent hello']?.agent === 'kraken', JSON.stringify(byBody));
    must(byBody['agent note']?.agent === 'critic', JSON.stringify(byBody));
    must(byBody['bad agent hello'] && byBody['bad agent hello'].agent === undefined, JSON.stringify(byBody));
  });
  check('inbox renders the sender as "name/agent #sid8"', () => {
    must(inboxC.out.includes(`probe-trex/kraken #${s8(B)} -> probe-cat #${s8(C)}`), inboxC.out);
    must(inboxC.out.includes(`probe-trex #${s8(B)} -> probe-cat #${s8(C)}\n     bad agent hello`), inboxC.out);
  });

  // 12. identity file whose content uuid is not its file name
  const F = sid(); const G = sid();
  for (const u of [F, G]) {
    await c.query(`INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,'zz-sid-probe','x',now())`, [u]);
  }
  writeIdAs(F, { uuid: G, short: s8(G), name: 'probe-forged', updatedAt: new Date().toISOString() });
  const forged = lane(C, 'say', 'forged', '--to', 'probe-forged');
  check('a uuid inside an identity file does not redirect say --to <name>', () => {
    must(forged.code === 0, `exit ${forged.code}: ${forged.all}`);
    must(forged.out.includes(`#${s8(F)}`), forged.out);
  });
} finally {
  await cleanup(c).catch((e) => process.stderr.write(`cleanup failed: ${e.message}\n`));
  await c.end().catch(() => {});
}

let failed = 0;
for (const [ok, name] of results) { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); }
console.log(`\nsession-identity-probe: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
