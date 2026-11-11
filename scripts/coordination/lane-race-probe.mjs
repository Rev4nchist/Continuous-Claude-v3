#!/usr/bin/env node
/**
 * lane-race-probe -- does the lane claim actually admit exactly one winner?
 *
 * WHY THIS EXISTS
 * ---------------
 * The entire value of the lane layer rests on one property: when two sessions
 * reach for the same lane at the same moment, exactly one gets it and the other
 * is TOLD. Everything else -- the board, the notes, the injection -- is
 * presentation. If this property is wrong, the board is worse than nothing,
 * because it would report a coordination that did not happen.
 *
 * This project has already shipped a coordination layer that passed its tests
 * while being broken, twice: the identity repair was verified single-shot and
 * still admitted 6 of 60 intruders under concurrency, and before that a lock
 * that "worked" was blocking sessions against themselves. So this probe runs
 * REAL concurrent processes rather than sequential calls in one event loop --
 * an in-process loop would serialize on the single connection and prove nothing.
 *
 * It also verifies the NEGATIVE cases, because a claim that always succeeds and
 * a claim that always fails both produce a green count if you only test one
 * direction:
 *
 *   1. N racers, one lane            -> exactly 1 win, N-1 denials, fence +1
 *   2. holder alive, lease expired   -> DENIED (both conditions are required)
 *   3. holder gone, lease expired    -> GRANTED (reclamation works at all)
 *   4. holder gone, lease live       -> DENIED (the lease alone still protects)
 *   5. the dependency and pack rules (contract t2.1, points 6 and 7), through the real CLI:
 *      open edge -> [open-dependency] exit 4 and no event; edge met -> claim; [blocked], [done];
 *      [pack-held]; [second-re-lane]; --dep-override writes one dep_override event.
 *   6. the owner rule, park and release --blocked (contract park-owner), through the real CLI:
 *      a non-owner `state <id> review` on a live-held lane -> [not-holder], exit 4, no change, no event;
 *      park --for 24h, then the owner dies and the leases move back 91 minutes: the control lane is claimed (exit 0),
 *      the parked lane is denied (exit 3), and the stored lease was within 1 minute of the requested end;
 *      release --blocked -> blocked, no owner, no lease, in ONE statement (a trigger raises on any lane that passes
 *      through ready, or through blocked with an owner), then a stranger's claim -> [blocked], exit 4;
 *      the exact argv of `program.mjs sync-board --apply` (state ... --if-state blocked --reason): exit 0, then [if-state];
 *      F13, a second connection holds the row lock while a plain done waits and a merged done commits: the lane stays met;
 *      F6, a forced event insert failure (a NOT VALID CHECK on lane_event): the --override change and its DM roll back;
 *      without the failure --override writes both events, the DM first.
 *
 * Cases 2 and 4 are the ones that matter. Reclaiming on either condition alone
 * is the exact bug that made the file lock steal files from sessions that were
 * merely mid-turn.
 *
 * Usage: CONTINUOUS_CLAUDE_DB_URL=<scratch url> node scripts/coordination/lane-race-probe.mjs [--racers 24]
 * Point CONTINUOUS_CLAUDE_DB_URL at a scratch database (scratch-db.mjs create --through 6). Section 5 is skipped
 * when table lane_dep is missing. A database whose name does not start with lanes_pr1_ is refused before any connection.
 * Exit 0 all properties hold | 1 a property failed | 2 could not run, or the database is not a scratch database.
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl, dbNameOf } from './scratch-db.mjs';
import { DEFAULT_BOARD } from './lane-board.mjs';
import { syncBoardStateArgv } from '../review-engine/lib/db-verbs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CLI = join(HERE, 'lane.mjs');

/** Every artifact this probe creates carries this prefix, so cleanup is a
 *  pattern delete and nothing it leaves behind can be mistaken for real work.
 *  Earlier probes in this repo left fixtures like `z | C:/x.md` in file_claims,
 *  which is exactly the "probe exhaust indistinguishable from a real conflict"
 *  problem that made the coordination tables hard to read. */
const PREFIX = '__laneprobe__';

const args = process.argv.slice(2);
const RACERS = Number(args[args.indexOf('--racers') + 1]) || 24;

// Same env chain as lane.mjs, but this probe writes lanes, `re-` lanes and edges, so it runs on a scratch database only.
// The URL is never printed: only the database name (never the password) is named in the message.
const DB_URL = process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL || process.env.OPC_POSTGRES_URL
  || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';
try { assertScratchUrl(DB_URL); } catch {
  process.stderr.write(`lane-race-probe: refusing to run: database '${dbNameOf(DB_URL) || '(no name)'}' is not a scratch database. ` +
    "The probe writes lanes and edges. Set CONTINUOUS_CLAUDE_DB_URL to one made by 'node scripts/coordination/scratch-db.mjs create --through 6' (name starts with lanes_pr1_).\n");
  process.exit(2);
}

let Client;
try { ({ Client } = requireDep('pg', { repoRoot: REPO })); } catch (e) { console.error(`lane-race-probe: ${e.message}`); process.exit(2); }

function db() {
  return new Client({ connectionString: DB_URL, connectionTimeoutMillis: 4000 });
}

/** Run the real CLI in its own process, so N racers are N OS processes. `extra` goes after the lane id; `--as` goes last. */
function run(verb, laneId, asSession, extra = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, verb, laneId, ...extra, '--as', asSession],
      { cwd: REPO }, (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout), err: String(stderr) });
      });
  });
}
const claim = (laneId, asSession, extra = []) => run('claim', laneId, asSession, extra);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}\n`);
};

const c = db();
await c.connect();

const LANE = `${PREFIX}lane`;
// Section 5 lanes start with `re-`, because the pack and second-lane rules key on that prefix.
const RE = `re-${PREFIX}`;
const cleanup = async () => {
  // Section 6 puts a CHECK on lane_event and a trigger on lane for a moment; both are dropped in a `finally`, and again here.
  await c.query(`ALTER TABLE agentic_os.lane_event DROP CONSTRAINT IF EXISTS zz_probe_block`);
  await c.query(`DROP TRIGGER IF EXISTS zz_probe_no_split ON agentic_os.lane`);
  await c.query(`DROP FUNCTION IF EXISTS agentic_os.zz_probe_no_split()`);
  await c.query(`DELETE FROM agentic_os.lane_event WHERE lane_id LIKE $1 OR lane_id LIKE $2 OR session_id LIKE $1`, [`${PREFIX}%`, `${RE}%`]);
  if ((await c.query(`SELECT to_regclass('agentic_os.lane_dep') IS NOT NULL AS has`)).rows[0].has) {
    // Both columns, by the same prefixes (contract 1.5).
    await c.query(`DELETE FROM agentic_os.lane_dep WHERE lane_id LIKE $1 OR lane_id LIKE $2 OR depends_on LIKE $1 OR depends_on LIKE $2`, [`${PREFIX}%`, `${RE}%`]);
  }
  await c.query(`DELETE FROM agentic_os.lane WHERE id LIKE $1 OR id LIKE $2`, [`${PREFIX}%`, `${RE}%`]);
  await c.query(`DELETE FROM agentic_os.lane_watermark WHERE session_id LIKE $1`, [`${PREFIX}%`]);
  await c.query(`DELETE FROM sessions WHERE id LIKE $1`, [`${PREFIX}%`]);
};

const mkLane = (id, state = 'backlog', branch = null) => c.query(
  `INSERT INTO agentic_os.lane (id,title,track,state,priority,branch) VALUES ($1,'dep probe','probe',$2,99,$3)`, [id, state, branch]);
const events = async (id) => (await c.query(`SELECT kind FROM agentic_os.lane_event WHERE lane_id=$1`, [id])).rows.map((r) => r.kind);
/** A refusal: exit 4 and line 1 `REFUSED <verb> <id> [<token>] -- ...` (contract t2.1 point 6). The verb is part of the match, so a claim refusal never passes for a state refusal. */
const refusedVerb = (r, verb, token) => r.code === 4 && new RegExp(`^REFUSED ${verb} \\S+ \\[${token}\\] -- `, 'm').test(r.err);
const refused = (r, token) => refusedVerb(r, 'claim', token);

async function dependencyChecks() {
  const [dep, w, blocked, done] = ['dep', 'w', 'blocked', 'done'].map((n) => `${PREFIX}${n}`);
  await mkLane(dep, 'active'); await mkLane(w); await mkLane(blocked, 'blocked'); await mkLane(done, 'done');
  await c.query(`INSERT INTO agentic_os.lane_dep (lane_id, depends_on, project_key) VALUES ($1,$2,'continuous-claude')`, [w, dep]);
  const r5 = await claim(w, `${PREFIX}A`);
  check('open edge -> [open-dependency], exit 4', refused(r5, 'open-dependency') && r5.err.includes(dep), `exit ${r5.code}: ${r5.err.split('\n')[0]}`);
  check('a refusal writes no event and no owner', (await events(w)).length === 0 && (await c.query(`SELECT owner_session_id FROM agentic_os.lane WHERE id=$1`, [w])).rows[0].owner_session_id === null, `events: ${(await events(w)).join(',') || 'none'}`);
  await c.query(`UPDATE agentic_os.lane SET state='done' WHERE id=$1`, [dep]);
  await c.query(`INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, body, detail, project_key)
                 VALUES ($1,'done',$2,'probe done',$3,'continuous-claude')`, [dep, `${PREFIX}A`, JSON.stringify({ state: 'done', merged: 'a'.repeat(40) })]);
  const r6 = await claim(w, `${PREFIX}A`);
  check('edge met (done + merged SHA) -> claim succeeds', r6.code === 0, `exit ${r6.code}: ${r6.err.split('\n')[0]}`);
  const rb = await claim(blocked, `${PREFIX}A`);
  check('blocked lane -> [blocked], exit 4', refused(rb, 'blocked'), `exit ${rb.code}`);
  const rd = await claim(done, `${PREFIX}A`);
  check('done lane -> [done], exit 4', refused(rd, 'done'), `exit ${rd.code}`);

  const [v, f, m1, m2, ov] = ['v', 'f', 'm1', 'm2', 'ov'].map((n) => `${RE}${n}`);
  await mkLane(v, 'backlog', 're/__laneprobe__pack'); await mkLane(f, 'backlog', 're/__laneprobe__pack');
  const pa = await claim(v, `${PREFIX}P`);
  const pb = await claim(f, `${PREFIX}Q`);
  const pc = await claim(f, `${PREFIX}P`);
  check('pack: holder P claims lane 1, other session Q -> [pack-held], P claims lane 2', pa.code === 0 && refused(pb, 'pack-held') && pc.code === 0, `${pa.code}/${pb.code}/${pc.code}`);
  await mkLane(m1, 'backlog', 'main'); await mkLane(m2, 'backlog', 'main');
  const s1 = await claim(m1, `${PREFIX}S`);
  const s2 = await claim(m2, `${PREFIX}S`);
  check('two re- lanes on branch main, one session -> [second-re-lane]', s1.code === 0 && refused(s2, 'second-re-lane'), `${s1.code}/${s2.code}`);

  await mkLane(ov, 'backlog');
  await c.query(`INSERT INTO agentic_os.lane_dep (lane_id, depends_on, project_key) VALUES ($1,'__laneprobe__nobody','continuous-claude')`, [ov]);
  const ro = await claim(ov, `${PREFIX}T`, ['--dep-override', '--reason', 'probe']);
  const evs = await events(ov);
  check('--dep-override with a reason claims and writes one dep_override event', ro.code === 0 && evs.filter((k) => k === 'dep_override').length === 1, `exit ${ro.code}, events ${evs.join(',')}`);
}

// ------------------------------------------------ 6. owner rule, park, release --blocked (contract park-owner)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const laneRow = async (id) => (await c.query(`SELECT state, owner_session_id AS owner, lease_expires_at AS lease, note FROM agentic_os.lane WHERE id=$1`, [id])).rows[0];
const eventRows = async (id) => (await c.query(`SELECT kind, to_session_id AS "to", detail FROM agentic_os.lane_event WHERE lane_id=$1 ORDER BY id`, [id])).rows;
const leaseMinutes = async (id) => Number((await c.query(`SELECT EXTRACT(EPOCH FROM (lease_expires_at - now())) / 60 AS m FROM agentic_os.lane WHERE id=$1`, [id])).rows[0].m);
const liveSession = (sid) => c.query(
  `INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,'probe','probe',now()) ON CONFLICT (id) DO UPDATE SET last_heartbeat=now()`, [sid]);
/** A lane held by `owner` with a 90 minute lease. `live` also gives the owner a fresh sessions row. */
async function heldLane(id, owner, { live = true, state = 'active' } = {}) {
  await mkLane(id, state);
  await c.query(`UPDATE agentic_os.lane SET owner_session_id=$2, lease_expires_at = now() + interval '90 minutes' WHERE id=$1`, [id, owner]);
  if (live) await liveSession(owner);
}
async function withDdl(up, down, fn) {
  await c.query(up);
  try { return await fn(); } finally { await c.query(down); }
}

async function strangerStateChecks() {
  const [A, S, id] = ['A', 'S', 'own'].map((n) => `${PREFIX}own-${n}`);
  await heldLane(id, A);
  const r = await run('state', id, S, ['review']);
  const row = await laneRow(id);
  check('non-owner state <id> review on a live-held lane -> [not-holder], exit 4', refusedVerb(r, 'state', 'not-holder') && r.err.includes(A.slice(0, 8)), `exit ${r.code}: ${r.err.split('\n')[0]}`);
  check('the refused state change leaves state and owner alone and writes no event', row.state === 'active' && row.owner === A && (await eventRows(id)).length === 0,
    `state ${row.state}, owner ${row.owner}, events ${(await eventRows(id)).length}`);
  const ok = await run('state', id, A, ['review']);
  check('control: the holder changes its own lane, with one event', ok.code === 0 && (await laneRow(id)).state === 'review' && (await eventRows(id)).length === 1, `exit ${ok.code}: ${ok.err.split('\n')[0]}`);
}

async function parkChecks() {
  const [X, C1, C2, control, parked] = ['X', 'C1', 'C2', 'ctl', 'park'].map((n) => `${PREFIX}pk-${n}`);
  await mkLane(control, 'ready'); await mkLane(parked, 'ready');
  await liveSession(X);
  const claims = [await claim(control, X), await claim(parked, X)];
  const pk = await run('park', parked, X, ['--for', '24h', '--reason', 'probe park']);
  const minutes = await leaseMinutes(parked);
  check('park --for 24h by the holder: exit 0, stored lease within 1 minute of the requested end',
    claims.every((r) => r.code === 0) && pk.code === 0 && Math.abs(minutes - 1440) <= 1, `claims ${claims.map((r) => r.code)}, park exit ${pk.code}: ${pk.err.split('\n')[0]}, lease ${minutes.toFixed(1)}m`);
  // The owner dies and 91 minutes pass: only the lease of the control lane is then spent.
  await c.query(`DELETE FROM sessions WHERE id=$1`, [X]);
  await c.query(`UPDATE agentic_os.lane SET lease_expires_at = lease_expires_at - interval '91 minutes' WHERE id = ANY($1)`, [[control, parked]]);
  const rc = await claim(control, C1);
  const rp = await claim(parked, C2);
  check('dead owner, 91 minutes on: the control lane is claimed (exit 0), the parked lane is denied (exit 3)', rc.code === 0 && rp.code === 3, `control ${rc.code}, parked ${rp.code}`);
  const row = await laneRow(parked);
  check('the denied parked lane keeps its owner, the review state and the PARKED note', row.owner === X && row.state === 'review' && /^PARKED until /.test(row.note ?? ''), `${row.state}, ${row.owner}, ${row.note}`);
}

/** A trigger that raises when a lane passes through `ready`, or through `blocked` with an owner: a two statement release cannot pass it. */
const NO_SPLIT_UP = `CREATE FUNCTION agentic_os.zz_probe_no_split() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
  IF NEW.id LIKE '${PREFIX}%' AND ((NEW.state = 'ready' AND OLD.state <> 'ready') OR (NEW.state = 'blocked' AND NEW.owner_session_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'zz_probe_no_split: % went through % with owner %', NEW.id, NEW.state, NEW.owner_session_id;
  END IF; RETURN NEW; END $f$;
  CREATE TRIGGER zz_probe_no_split BEFORE UPDATE ON agentic_os.lane FOR EACH ROW EXECUTE FUNCTION agentic_os.zz_probe_no_split()`;
const NO_SPLIT_DOWN = `DROP TRIGGER IF EXISTS zz_probe_no_split ON agentic_os.lane; DROP FUNCTION IF EXISTS agentic_os.zz_probe_no_split()`;

async function releaseBlockedChecks() {
  const [H, S, id, other] = ['H', 'S', 'id', 'other'].map((n) => `${PREFIX}rb-${n}`);
  await heldLane(id, H); await heldLane(other, H);
  const r = await withDdl(NO_SPLIT_UP, NO_SPLIT_DOWN, () => run('release', id, H, ['--blocked', '--reason', 'probe hold']));
  const row = await laneRow(id);
  check('release --blocked by the holder: blocked, no owner, no lease, the note; never ready, never blocked with an owner',
    r.code === 0 && row.state === 'blocked' && row.owner === null && row.lease === null && row.note === 'probe hold', `exit ${r.code}: ${r.err.split('\n')[0]}, ${JSON.stringify(row)}`);
  const evs = await eventRows(id);
  check('release --blocked writes one state_changed board event for blocked and none for ready', evs.length === 1 && evs[0].kind === 'state_changed' && evs[0].to === null && evs[0].detail.state === 'blocked', JSON.stringify(evs));
  const rc = await claim(id, S);
  check('a stranger claim on the released lane -> [blocked], exit 4', refused(rc, 'blocked'), `exit ${rc.code}: ${rc.err.split('\n')[0]}`);
  const rs = await run('release', other, S, ['--blocked', '--reason', 'probe hold']);
  check('release --blocked by a stranger on a held lane -> [not-holder], exit 4, the lane is unchanged', refusedVerb(rs, 'release', 'not-holder') && (await laneRow(other)).state === 'active', `exit ${rs.code}: ${rs.err.split('\n')[0]}`);
}

/** The exact argv of sync-board --apply (scripts/review-engine/lib/db-verbs.mjs), through the CLI of this checkout. */
async function syncBoardArgvChecks() {
  const [S, id] = ['S', 'lane'].map((n) => `${PREFIX}sb-${n}`);
  // The argv comes from db-verbs.mjs itself, so a change there is a change here. mkLane puts the lane on the default board.
  const [verb, laneId, ...argv] = syncBoardStateArgv(id, DEFAULT_BOARD);
  await mkLane(id, 'blocked');
  const first = await run(verb, laneId, S, argv);
  check('sync-board argv on an unowned blocked lane: exit 0, state backlog, one event with the reason', first.code === 0 && (await laneRow(id)).state === 'backlog'
    && (await eventRows(id)).filter((e) => e.detail?.reason === 'program.mjs sync-board --apply').length === 1, `exit ${first.code}: ${first.err.split('\n')[0]}`);
  const again = await run(verb, laneId, S, argv);
  check('the same argv on a lane that is no longer blocked -> [if-state], exit 4, no second event', refusedVerb(again, 'state', 'if-state') && (await eventRows(id)).length === 1, `exit ${again.code}: ${again.err.split('\n')[0]}`);
}

/** F13: a plain done waits on the row lock while a merged done commits. The lane must stay met and the plain done must write nothing. */
async function doneRaceChecks() {
  const [H, id] = ['H', 'lane'].map((n) => `${PREFIX}f13-${n}`);
  const sha = 'b'.repeat(40);
  await heldLane(id, H);
  const c2 = db();
  await c2.connect();
  try {
    await c2.query('BEGIN');
    await c2.query(`SELECT 1 FROM agentic_os.lane WHERE id=$1 FOR UPDATE`, [id]);
    const plain = run('done', id, H);
    let waiting = false;
    for (const end = Date.now() + 10000; !waiting && Date.now() < end; await sleep(100)) {
      // Only the lane row lock of the plain done counts: lockLane's own query, not any other lock waiter on the database.
      waiting = (await c.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
        AND query LIKE '%owner_session_id, state FROM agentic_os.lane WHERE id=$1%FOR UPDATE%'`)).rows[0].n > 0;
    }
    await c2.query(`UPDATE agentic_os.lane SET state='done', owner_session_id=NULL, lease_expires_at=NULL WHERE id=$1`, [id]);
    await c2.query(`INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, body, detail, project_key) VALUES ($1,'done',$2,'probe merged done',$3,'continuous-claude')`,
      [id, `${PREFIX}merger`, JSON.stringify({ state: 'done', merged: sha })]);
    await c2.query('COMMIT');
    const r = await plain;
    const evs = await eventRows(id);
    check('F13: the plain done was waiting on the row lock when the merged done committed', waiting, waiting ? '' : 'no waiter seen in pg_stat_activity');
    check('F13: the plain done exits 0 with "already met" and the lane stays met (one done event, the merged one)',
      r.code === 0 && /already met/.test(r.out) && (await laneRow(id)).state === 'done' && evs.length === 1 && evs[0].detail.merged === sha, `exit ${r.code}: ${r.out.split('\n')[0]}${r.err.split('\n')[0]}, events ${evs.length}`);
  } finally {
    await c2.end().catch(() => {});
  }
}

/** F6: the board event of an --override fails; the change and the DM roll back. Then, without the failure, both events exist. */
async function overrideRollbackChecks() {
  const [H, S, id] = ['H', 'S', 'lane'].map((n) => `${PREFIX}f6-${n}`);
  await heldLane(id, H);
  const argv = ['review', '--override', '--reason', 'probe handover'];
  const failed = await withDdl(`ALTER TABLE agentic_os.lane_event ADD CONSTRAINT zz_probe_block CHECK (kind <> 'state_changed') NOT VALID`,
    `ALTER TABLE agentic_os.lane_event DROP CONSTRAINT IF EXISTS zz_probe_block`, () => run('state', id, S, argv));
  const row = await laneRow(id);
  const evs = await eventRows(id);
  check('F6: --override with a failing board event: exit is not 0 or 4, state and owner unchanged, no event (not even the DM)',
    failed.code !== 0 && failed.code !== 4 && row.state === 'active' && row.owner === H && evs.length === 0, `exit ${failed.code}, ${row.state}, ${row.owner}, events ${evs.map((e) => e.kind)}`);
  const ok = await run('state', id, S, argv);
  const after = await eventRows(id);
  check('F6: --override --reason writes the DM to the old owner, then one board event (note, state_changed)',
    ok.code === 0 && (await laneRow(id)).state === 'review' && after.map((e) => e.kind).join() === 'note,state_changed' && after[0].to === H && after[1].to === null,
    `exit ${ok.code}: ${ok.err.split('\n')[0]}, ${JSON.stringify(after.map((e) => [e.kind, e.to]))}`);
}

async function ownerRuleChecks() {
  await strangerStateChecks();
  await parkChecks();
  await releaseBlockedChecks();
  await syncBoardArgvChecks();
  await doneRaceChecks();
  await overrideRollbackChecks();
}

try {
  await cleanup();

  // ---------------------------------------------------------------- 1. race
  await c.query(
    `INSERT INTO agentic_os.lane (id,title,track,state,priority) VALUES ($1,'race probe','probe','ready',99)`,
    [LANE],
  );
  const fence0 = (await c.query(`SELECT fence FROM agentic_os.lane WHERE id=$1`, [LANE])).rows[0].fence;

  const racers = Array.from({ length: RACERS }, (_, i) => `${PREFIX}r${i}`);
  const settled = await Promise.all(racers.map((s) => claim(LANE, s)));

  const winners = settled.filter((r) => r.code === 0);
  const denied = settled.filter((r) => r.code === 3);
  const broken = settled.filter((r) => r.code !== 0 && r.code !== 3);

  check('exactly one racer wins', winners.length === 1, `${winners.length} won of ${RACERS}`);
  check('every loser is denied cleanly (exit 3)', denied.length === RACERS - 1 && broken.length === 0,
    `${denied.length} denied, ${broken.length} errored`);

  const row = (await c.query(`SELECT * FROM agentic_os.lane WHERE id=$1`, [LANE])).rows[0];
  check('DB agrees exactly one owner', racers.includes(row.owner_session_id), `owner=${row.owner_session_id}`);
  check('fence advanced exactly once', row.fence === fence0 + 1, `${fence0} -> ${row.fence}`);

  // The denial must NAME the holder. "Denied" without a who sends the loser
  // hunting for a bug instead of talking to a person -- and a null holder in
  // the block message is a defect this project has already shipped once.
  // `every` on an empty array is true, so this assertion passed VACUOUSLY under
  // a sabotage run that produced zero denials -- a green line for a property
  // that was never exercised. Require at least one denial before believing it.
  const namesHolder = denied.length > 0
    && denied.every((r) => r.err.includes(row.owner_session_id.slice(0, 8)));
  check('every denial names the real holder', namesHolder,
    denied.length === 0 ? 'no denials produced -- nothing to check' : (namesHolder ? '' : `sample: ${denied[0]?.err.split('\n')[0]}`));

  // ------------------------------------------- 2. live holder, expired lease
  await c.query(
    `INSERT INTO sessions (id, project, working_on, last_heartbeat)
     VALUES ($1,'probe','probe',now())
     ON CONFLICT (id) DO UPDATE SET last_heartbeat=now()`, [row.owner_session_id],
  );
  await c.query(`UPDATE agentic_os.lane SET lease_expires_at = now() - interval '1 hour' WHERE id=$1`, [LANE]);
  const r2 = await claim(LANE, `${PREFIX}intruder`);
  check('live holder + expired lease -> DENIED', r2.code === 3,
    r2.code === 0 ? 'STOLE a lane from a live session' : `exit ${r2.code}`);

  // ------------------------------------------- 3. holder gone, lease expired
  await c.query(`DELETE FROM sessions WHERE id=$1`, [row.owner_session_id]);
  const r3 = await claim(LANE, `${PREFIX}reclaimer`);
  check('dead holder + expired lease -> GRANTED', r3.code === 0, `exit ${r3.code}`);
  const row3 = (await c.query(`SELECT * FROM agentic_os.lane WHERE id=$1`, [LANE])).rows[0];
  check('reclaim advanced the fence', row3.fence === fence0 + 2, `${row.fence} -> ${row3.fence}`);

  // ---------------------------------------------- 4. holder gone, lease live
  // The reclaimer holds it with a fresh 90m lease and has no sessions row.
  const r4 = await claim(LANE, `${PREFIX}latecomer`);
  check('dead holder + live lease -> DENIED', r4.code === 3,
    r4.code === 0 ? 'lease alone did not protect the claim' : `exit ${r4.code}`);

  // ------------------------------------------- 5. dependency and pack rules
  const hasDep = (await c.query(`SELECT to_regclass('agentic_os.lane_dep') IS NOT NULL AS has`)).rows[0].has;
  if (!hasDep) process.stdout.write('SKIP  section 5: table lane_dep is missing (database below migration 0006)\n');
  else await dependencyChecks();

  // ------------------------------------- 6. owner rule, park, release --blocked, the done race, the rollback
  await ownerRuleChecks();

} catch (e) {
  process.stderr.write(`probe could not run: ${e.message}\n`);
  await cleanup().catch(() => {});
  await c.end().catch(() => {});
  process.exit(2);
}

await cleanup();
const left = (await c.query(
  `SELECT (SELECT count(*) FROM agentic_os.lane WHERE id LIKE $1 OR id LIKE $2)::int
        + (SELECT count(*) FROM sessions WHERE id LIKE $1)::int AS n`, [`${PREFIX}%`, `${RE}%`],
)).rows[0].n;
check('probe left no fixtures behind', left === 0, `${left} row(s) remain`);
await c.end();

const failed = results.filter((r) => !r.pass);
process.stdout.write(`\n${results.length - failed.length}/${results.length} properties hold\n`);
process.exit(failed.length ? 1 : 0);
