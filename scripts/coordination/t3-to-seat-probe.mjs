#!/usr/bin/env node
/**
 * t3-to-seat-probe -- the end-to-end check of scripts/coordination/t3-to-seat.mjs (card coord-t3-advisory).
 *
 * It runs the real script as a child process against a scratch database that it makes and drops itself
 * (scratch-db.mjs, rule O3.9). It never reads a database URL from the environment and it asserts the scratch name
 * before its first connection. The primary checkout of the child is a temp folder (CCV3_USER_HOME), so the listed-id
 * list is a fixture: the ids are made at run time and stand in no file of the repo.
 *
 *   node scripts/coordination/t3-to-seat-probe.mjs
 *
 * Ways the script can fail, one check group each:
 *   1. it takes a carrier file outside .claudedocs/adversarial/ (a sibling file, a ".." path)        -> must exit 1
 *   2. it runs with no --file, or with a file that does not exist                                    -> must exit 1
 *   3. it sends a redteam brief with no sha or a bad sha                                             -> must exit 1
 *   4. it sends a DM over 2500 bytes (the limit itself must pass)                                    -> must exit 1
 *   5. it sends when the carrier or the summary holds a listed id, when the id hides behind an
 *      invisible mark, or when the list is absent                                                    -> must exit 3, 0 rows, no id printed
 *   6. --dry-run writes a row                                                                        -> must exit 0, 0 rows
 *   7. a send writes a wrong row, reads liveness from the heartbeat alone (an old heartbeat with
 *      fresh activity must read DELIVERED), prints the wrong status, or the seat cannot read the DM  -> 1 row each, DELIVERED / QUEUED
 *   8. it sends with no holder of re-program, or --seat routes a brief to a session that is not the
 *      holder (a builder); the holder named by id, id prefix or session name must still pass          -> must exit 2 / pass
 *   9. it writes a sessions row or changes the re-program lane row                                   -> both unchanged
 *  10. a stand-in home (CCV3_USER_HOME) is honoured on a database that is not a scratch database     -> must exit 1 before any connection
 *
 * Exit 0 when every check passes, 1 on a failed check, 2 when the scratch database cannot be made.
 */
import { execFile } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { requireDep } from '../lib/resolve-deps.mjs';
import { DATASET_REL, EVAL_CONFIG_REL } from './board-mask.mjs';
import { laneEnv } from './probe-boards.mjs';
import { assertScratchUrl } from './scratch-db.mjs';
import { MAX_DM_BYTES, SENDER, buildDm } from './t3-to-seat.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const SCRIPT = path.join(HERE, 't3-to-seat.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');
const LANE = path.join(HERE, 'lane.mjs');
/** The live database name on a port where nothing listens (the T1 form of probe-scratch-guard.test.mjs). Check 10 never connects. */
const DEAD_LIVE = 'postgresql://x:y@127.0.0.1:1/continuous_claude';

// The seat has a real session id shape (made at run time) and a session name, so --seat can name it by id, prefix and name.
const SEAT = randomUUID();
const SEAT_NAME = 'probe-seat';
const SEAT_LABEL = `${SEAT_NAME} #${SEAT.slice(0, 8)}`;
const OTHER = 'zz-t3probe-other';
/** A zero-width space, made from its code: the source file holds no invisible character. */
const ZWSP = String.fromCharCode(0x200b);
const MSG_LISTED = 't3-to-seat: REFUSED: listed holdout/gold id detected; nothing sent';
const MSG_NO_LIST = 't3-to-seat: REFUSED: the listed id list could not be read; nothing sent';

let failed = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total += 1;
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}\n`);
};

/** A child run that never throws: { code, out, err }. */
async function child(file, args, opts) {
  try {
    const { stdout, stderr } = await run(process.execPath, [file, ...args], { timeout: 60_000, windowsHide: true, ...opts });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? e.message) };
  }
}

/** The fixture: a stand-in home with a primary checkout, a carrier folder, a listed-id list, a registry and an empty identity folder. */
function makeFixture() {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zz-t3probe-')));
  const home = path.join(tmp, 'home');
  const primary = path.join(home, 'continuous-claude');
  const adv = path.join(primary, '.claudedocs', 'adversarial');
  fs.mkdirSync(path.join(adv, 'sub'), { recursive: true });
  // Listed ids of the fixture, made at run time: a PR number, a comment id (a long digit run) and a round sha (hex with a letter).
  const ids = { pr: 40000 + randomInt(9999), comment: `9${randomInt(1e9, 1e10 - 1)}`, sha: `ab${randomBytes(7).toString('hex')}` };
  const put = (rel, text) => { const p = path.join(primary, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  put(DATASET_REL, JSON.stringify({ prs: [{ pr: ids.pr }], findings: [{ pr: ids.pr, comment_id: Number(ids.comment), round: ids.sha }] }));
  put(EVAL_CONFIG_REL, JSON.stringify({ reserve: [], holdoutExclude: [] }));
  const brief = '# Brief\n\nKind: redteam\nSummary: one finding, see the table.\n';
  const files = {
    ok: put('.claudedocs/adversarial/ok.md', brief),
    sub: put('.claudedocs/adversarial/sub/ok.md', brief),
    listedSha: put('.claudedocs/adversarial/listed-sha.md', `${brief}\nReviewed commit ${ids.sha.slice(0, 10)}.\n`),
    // The comment id with a zero-width space inside it: the plain matcher sees two short runs, a reader sees the id.
    listedHidden: put('.claudedocs/adversarial/listed-hidden.md', `${brief}\nSee comment ${ids.comment.slice(0, 5)}${ZWSP}${ids.comment.slice(5)}.\n`),
    outside: put('.claudedocs/outside.md', brief),
  };
  // A second home with a carrier file and no list at all.
  const bare = path.join(tmp, 'home-no-list');
  const barePrimary = path.join(bare, 'continuous-claude');
  fs.mkdirSync(path.join(barePrimary, '.claudedocs', 'adversarial'), { recursive: true });
  fs.writeFileSync(path.join(barePrimary, '.claudedocs', 'adversarial', 'ok.md'), brief);
  const registry = path.join(tmp, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({
    version: '1.0',
    projects: [{ name: 'continuous-claude', key: 'continuous-claude', path: primary.replace(/\\/g, '/'), status: 'active' }],
  }));
  const identityDir = path.join(tmp, 'ids');
  fs.mkdirSync(identityDir);
  fs.writeFileSync(path.join(identityDir, `${SEAT}.json`), JSON.stringify({ uuid: SEAT, name: SEAT_NAME, updatedAt: new Date().toISOString() }));
  return { tmp, home, primary, files, ids, bare, barePrimary, registry, identityDir, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

async function main() {
  // 0. The scratch database. `create` connects to the maintenance database only, then to the new one.
  const made = await child(SCRATCH, ['create', '--through', '6'], { cwd: REPO });
  let url;
  let name;
  try { ({ url, name } = JSON.parse(made.out.trim().split('\n').pop())); } catch { /* handled below */ }
  if (made.code !== 0 || !url) {
    process.stderr.write(`t3-to-seat-probe: cannot make a scratch database (exit ${made.code}). Is Postgres up?\n${made.err}\n`);
    process.exit(2);
  }
  assertScratchUrl(url); // rule O3.9: before the first connection of this probe
  const fx = makeFixture();
  const { Client } = requireDep('pg', { repoRoot: REPO });
  const db = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });

  const t3 = (args, { home = fx.home, cwd = fx.primary, dbUrl = url } = {}) =>
    child(SCRIPT, args, { cwd, env: laneEnv(dbUrl, fx, { CCV3_USER_HOME: home }) });
  const rows = async () => (await db.query('SELECT count(*)::int AS n FROM agentic_os.lane_event WHERE session_id = $1', [SENDER])).rows[0].n;
  const lastRow = async () => (await db.query(
    'SELECT lane_id, kind, session_id, to_session_id, body, detail, project_key FROM agentic_os.lane_event WHERE session_id = $1 ORDER BY id DESC LIMIT 1', [SENDER],
  )).rows[0];
  const seatTimes = (heartbeat, activity) => db.query(
    `UPDATE public.sessions SET last_heartbeat = now() - $2::interval, last_activity_at = now() - $3::interval WHERE id = $1`, [SEAT, heartbeat, activity],
  );
  const laneRow = async () => JSON.stringify((await db.query(
    `SELECT owner_session_id, state, fence, claimed_at, lease_expires_at, note FROM agentic_os.lane WHERE id = 're-program'`,
  )).rows[0]);
  const base = ['--kind', 'plan', '--summary', 'probe summary'];

  try {
    await db.connect();
    await db.query(`SELECT set_config('lane.client_version', '2', false)`);
    await db.query(
      `INSERT INTO public.sessions (id, project, working_on, last_heartbeat, last_activity_at)
       VALUES ($1, $3, 'probe seat', now(), now()), ($2, $3, 'probe other', now(), now())`,
      [SEAT, OTHER, fx.primary.replace(/\\/g, '/').toLowerCase()],
    );
    await db.query(
      `INSERT INTO agentic_os.lane (id, title, track, state, priority, owner_session_id, claimed_at, lease_expires_at, fence)
       VALUES ('re-program', 'Probe master card', 'program', 'active', 1, $1, now(), now() + interval '90 minutes', 1)`, [SEAT],
    );
    const sessionsBefore = (await db.query('SELECT count(*)::int AS n FROM public.sessions')).rows[0].n;
    const laneBefore = await laneRow();

    // 1. carrier file outside the folder
    let r = await t3([...base, '--file', fx.files.outside]);
    check('1a a file beside the carrier folder is refused, exit 1', r.code === 1 && /must be inside/.test(r.err), `exit ${r.code}: ${r.err}`);
    r = await t3([...base, '--file', '.claudedocs/adversarial/../outside.md']);
    check('1b a ".." path that leaves the folder is refused, exit 1', r.code === 1 && /"\.\." segment/.test(r.err), `exit ${r.code}: ${r.err}`);
    r = await t3([...base, '--file', '.claudedocs/adversarial/sub/../ok.md']);
    check('1c a ".." path that stays in the folder is refused too, exit 1', r.code === 1 && /"\.\." segment/.test(r.err), `exit ${r.code}: ${r.err}`);
    r = await t3([...base, '--file', path.join(fx.primary, '.claudedocs', 'adversarial')]);
    check('1d the carrier folder itself is refused, exit 1', r.code === 1, `exit ${r.code}: ${r.err}`);

    // 2. no file
    r = await t3(base);
    check('2a no --file is refused, exit 1', r.code === 1 && /--file is required/.test(r.err), `exit ${r.code}: ${r.err}`);
    r = await t3([...base, '--file', '.claudedocs/adversarial/absent.md']);
    check('2b a file that does not exist is refused, exit 1', r.code === 1 && /does not exist/.test(r.err), `exit ${r.code}: ${r.err}`);

    // 3. redteam needs a valid sha
    const red = ['--kind', 'redteam', '--summary', 'probe summary', '--file', fx.files.ok];
    r = await t3(red);
    check('3a redteam with no --sha is refused, exit 1', r.code === 1 && /--sha is required/.test(r.err), `exit ${r.code}: ${r.err}`);
    for (const bad of ['zzzzzzz', 'abc123', `${'a1'.repeat(20)}f`]) {
      r = await t3([...red, '--sha', bad]);
      check(`3b redteam with a bad sha (${bad.length} characters) is refused, exit 1`, r.code === 1 && /7 to 40 hex/.test(r.err), `exit ${r.code}: ${r.err}`);
    }
    r = await t3(['--kind', 'gossip', '--summary', 'x', '--file', fx.files.ok]);
    check('3c an unknown --kind is refused, exit 1', r.code === 1 && /--kind must be one of/.test(r.err), `exit ${r.code}: ${r.err}`);

    // 4. the byte budget: the limit passes (dry run), one byte more is refused
    const overhead = Buffer.byteLength(buildDm({ kind: 'plan', summary: '', rel: '.claudedocs/adversarial/ok.md', sha: null }), 'utf8');
    const fit = 'z'.repeat(MAX_DM_BYTES - overhead);
    r = await t3(['--kind', 'plan', '--summary', fit, '--file', fx.files.ok, '--dry-run']);
    check(`4a a DM of exactly ${MAX_DM_BYTES} bytes passes the budget`, r.code === 0 && r.out.includes(`(${MAX_DM_BYTES} of ${MAX_DM_BYTES} bytes)`), `exit ${r.code}: ${r.err}`);
    r = await t3(['--kind', 'plan', '--summary', `${fit}z`, '--file', fx.files.ok]);
    check(`4b a DM of ${MAX_DM_BYTES + 1} bytes is refused, exit 1`, r.code === 1 && r.err.includes(`${MAX_DM_BYTES + 1} bytes`) && r.out === '', `exit ${r.code}: ${r.err}`);

    // 5. listed ids: exit 3, the fixed message, no id in any output
    const noIdShown = (x) => ![String(fx.ids.pr), fx.ids.comment, fx.ids.sha.slice(0, 7)].some((id) => `${x.out}${x.err}`.includes(id));
    const refused = (x, msg = MSG_LISTED) => x.code === 3 && x.out === '' && x.err.trim() === msg && noIdShown(x);
    r = await t3([...base, '--file', fx.files.listedSha]);
    check('5a a listed sha in the carrier file is refused, exit 3, fixed message', refused(r), `exit ${r.code}`);
    r = await t3(['--kind', 'plan', '--summary', `see PR #${fx.ids.pr} for the fix`, '--file', fx.files.ok]);
    check('5b a listed PR number in the summary is refused, exit 3, fixed message', refused(r), `exit ${r.code}`);
    r = await t3(['--kind', 'redteam', '--summary', 'probe summary', '--file', fx.files.ok, '--sha', fx.ids.sha]);
    check('5c a listed sha as --sha is refused, exit 3, fixed message', refused(r), `exit ${r.code}`);
    r = await t3([...base, '--file', fx.files.listedHidden]);
    check('5d a listed id split by an invisible mark is refused, exit 3, fixed message', refused(r), `exit ${r.code}`);
    r = await t3([...base, '--file', path.join(fx.barePrimary, '.claudedocs', 'adversarial', 'ok.md')], { home: fx.bare, cwd: fx.barePrimary });
    check('5e an absent id list is refused, exit 3 (fail closed)', refused(r, MSG_NO_LIST), `exit ${r.code}: ${r.err}`);
    check('5f no row after the refusals of groups 1 to 5', (await rows()) === 0, `rows ${await rows()}`);

    // 6. dry run
    await seatTimes('30 minutes', '10 seconds');
    r = await t3(['--kind', 'redteam', '--summary', 'probe summary', '--file', fx.files.sub, '--sha', 'c0ffee1', '--dry-run']);
    check('6a --dry-run exits 0 and prints the DM, the byte count and the seat status',
      r.code === 0 && r.out.includes('DRY RUN: nothing written.') && r.out.includes('[T3-ADVISOR] redteam — probe summary')
      && r.out.includes('File: .claudedocs/adversarial/sub/ok.md') && r.out.includes('SHA: c0ffee1') && /\(\d+ of 2500 bytes\)/.test(r.out)
      && /a send would be DELIVERED\./.test(r.out) && r.out.includes('lane.client_version=2'), `exit ${r.code}: ${r.out}${r.err}`);
    check('6b --dry-run writes no row', (await rows()) === 0, `rows ${await rows()}`);

    // 7. a real send, on the scratch database only
    r = await t3(['--kind', 'redteam', '--summary', 'probe summary', '--file', fx.files.ok, '--sha', 'c0ffee1']);
    const delivered = new RegExp(`^DELIVERED to Seat ${SEAT_LABEL} \\(active (\\d+)s ago — injects between tool calls\\)$`, 'm').exec(r.out);
    check('7a an old heartbeat with fresh activity reads DELIVERED (liveness is the later of the two times)',
      r.code === 0 && delivered !== null && Number(delivered[1]) <= 120, `exit ${r.code}: ${r.out}${r.err}`);
    check('7b the send sets and reports lane.client_version', /lane\.client_version=2$/m.test(r.out), r.out);
    let row = await lastRow();
    check('7c one row: sender t3-advisor, to the seat, kind note, board continuous-claude, no lane',
      (await rows()) === 1 && row.session_id === 't3-advisor' && row.to_session_id === SEAT && row.kind === 'note'
      && row.project_key === 'continuous-claude' && row.lane_id === null, JSON.stringify(row));
    check('7d the body has the M4.13 shape and the detail names source, kind, file and sha',
      row.body === '[T3-ADVISOR] redteam — probe summary\nFile: .claudedocs/adversarial/ok.md\nSHA: c0ffee1\nReply via ## Seat Disposition in carrier file.'
      // jsonb keeps no key order: compare the values, not the text.
      && isDeepStrictEqual(row.detail, { source: 't3-advisor', kind: 'redteam', file: '.claudedocs/adversarial/ok.md', sha: 'c0ffee1' }),
      JSON.stringify(row));

    await seatTimes('10 minutes', '7 minutes');
    r = await t3([...base, '--file', fx.files.ok, '--lane', 're-program']);
    check('7e an idle seat reads QUEUED with the idle minutes of the later time',
      r.code === 0 && r.out.split('\n').includes(`QUEUED for Seat ${SEAT_LABEL} (idle 7m — nudge Seat terminal or wait for CronList tick)`), `exit ${r.code}: ${r.out}${r.err}`);
    row = await lastRow();
    check('7f --lane puts the lane id on the row; a plan with no sha stores sha null',
      (await rows()) === 2 && row.lane_id === 're-program' && row.detail.sha === null && row.body.includes('\nSHA: none\n'), JSON.stringify(row));
    r = await t3([...base, '--file', fx.files.ok, '--lane', 'no-such-lane']);
    check('7g an unknown --lane is refused, exit 1, no row', r.code === 1 && (await rows()) === 2, `exit ${r.code}: ${r.err}`);

    const inbox = await child(LANE, ['inbox', '--peek', '--as', SEAT], { cwd: fx.primary, env: laneEnv(url, fx, { CCV3_USER_HOME: fx.home }) });
    check('7h the seat reads both DMs with the real lane.mjs inbox --peek',
      inbox.code === 0 && (inbox.out.match(/\[T3-ADVISOR\]/g) ?? []).length === 2, `exit ${inbox.code}: ${inbox.out}${inbox.err}`);

    // 8. the seat: --seat is a check, never a route. The receiver is always the holder of re-program.
    const notHolder = (x) => x.code === 2 && x.out === '' && /--seat does not name the session that holds re-program/.test(x.err);
    r = await t3([...base, '--file', fx.files.ok, '--seat', OTHER]);
    row = await lastRow();
    check('8a --seat with the id of a session that is not the holder (a builder) is refused, exit 2, no row',
      notHolder(r) && (await rows()) === 2 && row.to_session_id === SEAT, `exit ${r.code}: ${r.out}${r.err}`);
    r = await t3([...base, '--file', fx.files.ok, '--seat', 'nobody-here']);
    check('8b --seat that names no session is refused, exit 2, no row', notHolder(r) && (await rows()) === 2, `exit ${r.code}: ${r.out}${r.err}`);
    const wrongPrefix = `${SEAT.slice(0, 7)}${SEAT[7] === '0' ? '1' : '0'}`;
    for (const [what, value] of [['an id prefix of another id', wrongPrefix], ['a prefix of the holder under 8 characters', SEAT.slice(0, 4)]]) {
      r = await t3([...base, '--file', fx.files.ok, '--seat', value]);
      check(`8d --seat with ${what} is refused, exit 2, no row`, notHolder(r) && (await rows()) === 2, `exit ${r.code}: ${r.out}${r.err}`);
    }
    for (const [how, value] of [['its session name', SEAT_NAME.toUpperCase()], ['an id prefix with #', `#${SEAT.slice(0, 8)}`]]) {
      r = await t3([...base, '--file', fx.files.ok, '--seat', value, '--dry-run']);
      check(`8e --seat that names the holder by ${how} passes (dry run, no row)`,
        r.code === 0 && r.out.includes(`to ${SEAT_LABEL} on board`) && (await rows()) === 2, `exit ${r.code}: ${r.out}${r.err}`);
    }
    r = await t3([...base, '--file', fx.files.ok, '--seat', SEAT]);
    row = await lastRow();
    check('8f --seat with the whole id of the holder sends to the holder', r.code === 0 && (await rows()) === 3 && row.to_session_id === SEAT, `exit ${r.code}: ${r.err}`);

    // 9. what a send must never change (read before check 8c frees the lane)
    const sessionsAfter = (await db.query('SELECT count(*)::int AS n FROM public.sessions')).rows[0].n;
    const ghost = (await db.query('SELECT count(*)::int AS n FROM public.sessions WHERE id = $1', [SENDER])).rows[0].n;
    check('9a no sessions row is written (count unchanged, no t3-advisor row)', sessionsAfter === sessionsBefore && ghost === 0, `${sessionsBefore} -> ${sessionsAfter}, ghost ${ghost}`);
    check('9b the re-program lane row is unchanged (owner, state, fence, lease, note)', (await laneRow()) === laneBefore);

    await db.query(`UPDATE agentic_os.lane SET owner_session_id = NULL, lease_expires_at = NULL WHERE id = 're-program'`);
    r = await t3([...base, '--file', fx.files.ok]);
    check('8c no holder of re-program is refused, exit 2, no row', r.code === 2 && /no live Seat holds re-program/.test(r.err) && (await rows()) === 3, `exit ${r.code}: ${r.err}`);
    r = await t3([...base, '--file', fx.files.ok, '--seat', OTHER]);
    check('8g with no holder, --seat cannot name a receiver: exit 2, no row', r.code === 2 && /no live Seat holds re-program/.test(r.err) && (await rows()) === 3, `exit ${r.code}: ${r.err}`);

    // 10. the stand-in home is a scratch-only seam
    r = await t3([...base, '--file', fx.files.ok], { dbUrl: DEAD_LIVE });
    check('10 a stand-in home with a database that is not a scratch database is refused, exit 1, before any connection',
      r.code === 1 && /CCV3_USER_HOME/.test(r.err) && !/ECONNREFUSED|connect/i.test(r.err), `exit ${r.code}: ${r.err}`);
  } finally {
    await db.end().catch(() => {});
    fx.cleanup();
    const dropped = await child(SCRATCH, ['drop', url], { cwd: REPO });
    process.stdout.write(dropped.code === 0 ? `dropped scratch database ${name}\n` : `WARNING: scratch database ${name} was NOT dropped: ${dropped.err}\n`);
    if (dropped.code !== 0) failed += 1;
  }

  process.stdout.write(`${failed === 0 ? 'PASS' : 'FAIL'}  t3-to-seat-probe  ${total - Math.min(failed, total)}/${total} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { process.stderr.write(`t3-to-seat-probe: ${e.stack || e.message}\n`); process.exit(1); });
