#!/usr/bin/env node
/**
 * lane-compact-probe -- does a PreCompact keep the lane note and log the compaction as an event?
 *
 * Runs the REAL built hook (.claude/hooks/dist/pre-compact-lane-note.mjs) with a real PreCompact payload and a real
 * transcript fixture (TaskCreate / TaskUpdate lines). The hook calls the lane shim, which runs the real lane.mjs of
 * this checkout, against a throwaway lanes_pr1_* database. The live database is never touched.
 *
 * Checks: the held lane keeps its exact note, a lane with no note stays empty, one 'compact' event per held lane
 * (own session, self-addressed, with the open task and the branch), a lane of another session is untouched,
 * a peer inbox shows nothing, and an older lane CLI without the `compact` verb leaves the note alone.
 *
 * Run after .claude/hooks `npm run build`:  node scripts/coordination/lane-compact-probe.mjs
 * Exit 1 if a check fails, 2 if pg is missing. Output also goes to .claude/cache/e2e/2026-11-07-a3-probe.txt.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl, maskUrl } from './scratch-db.mjs';
import { laneEnv, makeBoards } from './probe-boards.mjs';

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  console.log('usage: node scripts/coordination/lane-compact-probe.mjs\n'
    + 'Pipes a PreCompact payload into the built pre-compact-lane-note hook, on a throwaway lanes_pr1_* database with the\n'
    + 'real lane.mjs. Build the hook first. Exit 1 if a check fails, 2 if pg is missing.');
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LANE = join(HERE, 'lane.mjs');
const SCRATCH = join(HERE, 'scratch-db.mjs');
const HOOK = join(REPO, '.claude', 'hooks', 'dist', 'pre-compact-lane-note.mjs');
const OUT = join(REPO, '.claude', 'cache', 'e2e', '2026-11-07-a3-probe.txt');

let Client;
try {
  ({ Client } = requireDep('pg', { repoRoot: REPO }));
} catch (e) {
  console.error(`lane-compact-probe: the pg package is not available (${e.message}). Set NODE_PATH to a folder that holds pg.`);
  process.exit(2);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, '');

const log = (s = '') => { const t = String(s).replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/g, '$1***@'); appendFileSync(OUT, t + '\n'); console.log(t); };
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };
const scratch = (...args) => spawnSync(process.execPath, [SCRATCH, ...args], { encoding: 'utf8' });

const ME = 'zz-lcprobe-me';
const PEER = 'zz-lcprobe-peer';
const NOTE = 'Dave progress: parser done, tests next';

/** A fake user home: the real shim, and a primary-checkout lane.mjs that is either the real one or a stub. */
function fakeHome(tmp, name, primaryBody) {
  const home = join(tmp, name);
  mkdirSync(join(home, '.claude', 'scripts'), { recursive: true });
  mkdirSync(join(home, '.claude', 'state'), { recursive: true });
  mkdirSync(join(home, 'continuous-claude', 'scripts', 'coordination'), { recursive: true });
  copyFileSync(join(REPO, '.claude', 'scripts', 'lane.mjs'), join(home, '.claude', 'scripts', 'lane.mjs'));
  writeFileSync(join(home, 'continuous-claude', 'scripts', 'coordination', 'lane.mjs'), primaryBody);
  return home;
}

// Real transcript shape (Claude Code 2.1.312): tool_use nested in message.content; the task id returns in toolUseResult.
const transcript = [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: 'TaskCreate', input: { subject: 'Fix the compact hook', description: 'd' }, caller: { type: 'direct' } }] } },
  { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_A', type: 'tool_result', content: 'Task #1 created successfully: Fix the compact hook' }] }, toolUseResult: { task: { id: '1', subject: 'Fix the compact hook' } } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_B', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' }, caller: { type: 'direct' } }] } },
].map((l) => JSON.stringify(l)).join('\n') + '\n';

let boards = null; let url = null; let db = null;
try {
  log('# lane compact probe: scratch database, real built hook, real lane.mjs, 2026-11-07');
  log('# Live database: NOT touched.');
  const created = scratch('create', '--through', '5');
  if (created.status !== 0) throw new Error(`scratch create failed: ${created.stderr}`);
  url = JSON.parse(created.stdout).url;
  assertScratchUrl(url);
  log(`scratch database: ${maskUrl(url)}`);
  boards = makeBoards('zz-lcprobe', ['a']);
  const A = boards.boards.a;
  db = new Client({ connectionString: url });
  await db.connect();

  const realPrimary = `import ${JSON.stringify(pathToFileURL(LANE).href)};\n`;
  const homeNew = fakeHome(boards.tmp, 'home-new', realPrimary);
  const homeOld = fakeHome(boards.tmp, 'home-old',
    `// Stand-in for a lane.mjs from before the compact verb: it knows the old verbs only.\n`
    + `import { pathToFileURL } from 'node:url';\n`
    + `if (process.argv[2] === 'compact') { process.stderr.write('unknown command "compact"\\n'); process.exit(2); }\n`
    + `await import(${JSON.stringify(pathToFileURL(LANE).href)});\n`);
  const transcriptFile = join(boards.tmp, 'transcript.jsonl');
  writeFileSync(transcriptFile, transcript);

  const lane = (sid, args) => {
    const r = spawnSync(process.execPath, [LANE, ...args], { cwd: A.dir, encoding: 'utf8', env: laneEnv(url, boards, { CLAUDE_CODE_SESSION_ID: sid }) });
    return { code: r.status, out: (r.stdout || '').trim(), all: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  };
  const hook = (home, sid, extra = {}) => {
    const payload = JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: sid, transcript_path: transcriptFile, cwd: A.dir, ...extra });
    const r = spawnSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8', env: laneEnv(url, boards, { CCV3_USER_HOME: home }) });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
  const row = async (id) => (await db.query('SELECT note, owner_session_id, state, updated_at FROM agentic_os.lane WHERE id=$1', [id])).rows[0];
  const events = async (kind) => (await db.query(
    `SELECT lane_id, kind, session_id, to_session_id, body, project_key FROM agentic_os.lane_event WHERE kind=$1 ORDER BY id`, [kind])).rows;

  log('\n## setup: three lanes, two mine, one the peer holds');
  for (const [id, sid] of [['zz-lc-noted', ME], ['zz-lc-bare', ME], ['zz-lc-theirs', PEER]]) {
    let r = lane(sid, ['add', id, '--title', id]);
    check(`add ${id}`, r.code === 0, r.all);
    r = lane(sid, ['claim', id]);
    check(`claim ${id}`, r.code === 0, r.all);
  }
  let r = lane(ME, ['note', 'zz-lc-noted', NOTE]);
  check('note set on zz-lc-noted', r.code === 0 && (await row('zz-lc-noted')).note === NOTE, r.all);
  r = lane(PEER, ['note', 'zz-lc-theirs', 'peer note']);
  const bareBefore = await row('zz-lc-bare');
  const noteBefore = await row('zz-lc-noted');
  const theirsBefore = await row('zz-lc-theirs');
  log(`BEFORE zz-lc-noted note=${JSON.stringify(noteBefore.note)}`);
  log(`BEFORE zz-lc-bare  note=${JSON.stringify(bareBefore.note)}`);
  log(`BEFORE zz-lc-theirs note=${JSON.stringify(theirsBefore.note)}`);

  log('\n## PreCompact on the new CLI');
  const h = hook(homeNew, ME);
  log(`hook stdout: ${h.out}`);
  if (h.err) log(`hook stderr: ${h.err}`);
  check('hook exits 0 and reports 2 events logged', h.code === 0 && /compact event logged on 2 lane/.test(h.out), h.out);
  const noteAfter = await row('zz-lc-noted');
  const bareAfter = await row('zz-lc-bare');
  const theirsAfter = await row('zz-lc-theirs');
  log(`AFTER  zz-lc-noted note=${JSON.stringify(noteAfter.note)}`);
  log(`AFTER  zz-lc-bare  note=${JSON.stringify(bareAfter.note)}`);
  log(`AFTER  zz-lc-theirs note=${JSON.stringify(theirsAfter.note)}`);
  check('the held lane keeps its exact note', noteAfter.note === NOTE, JSON.stringify(noteAfter.note));
  check('a held lane with no note still has none', bareAfter.note === null, JSON.stringify(bareAfter.note));
  check('the peer lane is untouched', theirsAfter.note === 'peer note');
  const ev = await events('compact');
  for (const e of ev) log(`EVENT ${JSON.stringify(e)}`);
  check('one compact event per held lane, none for the peer lane', ev.map((e) => e.lane_id).sort().join() === 'zz-lc-bare,zz-lc-noted', ev.map((e) => e.lane_id).join());
  check('events are from my session, addressed to me, on the board', ev.length === 2 && ev.every((e) => e.session_id === ME && e.to_session_id === ME && e.project_key === A.key));
  check('event text carries the open TaskCreate task', ev.length === 2 && ev.every((e) => /^Compacting \(auto\) at \d\d:\d\d local/.test(e.body) && e.body.includes('Open task: Fix the compact hook.')), ev[0]?.body);
  r = lane(PEER, ['inbox', '--peek']);
  check('a peer inbox shows no compact line', r.code === 0 && !/Compacting/.test(r.all), r.all);
  check('the hook wrote no note event', (await events('note')).filter((e) => /^Compacting/.test(e.body ?? '')).length === 0);

  log('\n## cooldown: a second PreCompact inside 5 minutes does nothing');
  const h2 = hook(homeNew, ME);
  check('second call is skipped for cooldown', /cooldown/.test(h2.out), h2.out);
  check('still two compact events', (await events('compact')).length === 2);

  log('\n## an older lane CLI (no compact verb) must not fall back to note');
  const h3 = hook(homeOld, ME);
  log(`hook stdout: ${h3.out}`);
  check('hook skips and still continues', h3.code === 0 && /"continue":true/.test(h3.out) && /skipped/.test(h3.out), h3.out);
  check('the note is still the exact original', (await row('zz-lc-noted')).note === NOTE);

  log('\n## adopt after /clear: my own compact events must not turn into unread DMs for the new session');
  const OLD = '5a5a5a5a-0000-4000-8000-000000000001'; const NEW = '5a5a5a5a-0000-4000-8000-000000000002';
  writeFileSync(join(boards.identityDir, `${OLD}.json`), JSON.stringify({ name: 'zz-lcprobe', endedAt: new Date().toISOString() }));
  writeFileSync(join(boards.identityDir, `${NEW}.json`), JSON.stringify({ name: 'zz-lcprobe', previous: OLD }));
  r = lane(OLD, ['add', 'zz-lc-adopt', '--title', 'adopt me']);
  r = lane(OLD, ['claim', 'zz-lc-adopt']);
  check('old session claims zz-lc-adopt', r.code === 0, r.all);
  r = lane(OLD, ['compact', 'zz-lc-adopt', 'Compacting (auto) at 09:00 local. old session event']);
  check('old session logs a compact event', r.code === 0, r.all);
  // A real DM to the old session, written straight to the table (`say --to` needs a sessions row for the recipient).
  await db.query(
    `INSERT INTO agentic_os.lane_event (kind, session_id, to_session_id, body, detail, project_key) VALUES ('note', $1, $2, $3, '{}'::jsonb, $4)`,
    [PEER, OLD, 'real DM for the old session', A.key]);
  r = lane(NEW, ['adopt', '--from', OLD]);
  log(`adopt: ${r.all}`);
  check('adopt moves the lane and the one real DM, not the compact event', r.code === 0 && /1 lane\(s\)/.test(r.out) && /1 message\(s\)/.test(r.out), r.all);
  r = lane(NEW, ['inbox', '--peek']);
  check('the new session inbox shows the real DM', r.code === 0 && /real DM for the old session/.test(r.all), r.all);
  check('the new session inbox shows no Compacting line', !/Compacting/.test(r.all), r.all);

  log('\n## an event insert that fails: the verb exits nonzero and the hook does not start its cooldown');
  const homeFail = fakeHome(boards.tmp, 'home-fail', realPrimary);
  await db.query(`ALTER TABLE agentic_os.lane_event ADD CONSTRAINT zz_block_compact CHECK (kind <> 'compact') NOT VALID`);
  const eventsBefore = (await events('compact')).length;
  r = lane(ME, ['compact', 'zz-lc-noted', 'will fail']);
  log(`compact verb: exit ${r.code}: ${r.all.split('\n')[0]}`);
  check('the compact verb exits nonzero when the insert fails', r.code !== 0 && !/compact event on/.test(r.out), `exit ${r.code}`);
  const h4 = hook(homeFail, ME);
  log(`hook stdout: ${h4.out}`);
  check('the hook reports the failure, not success', h4.code === 0 && /skipped: every compact event write failed/.test(h4.out), h4.out);
  const stateFile = join(homeFail, '.claude', 'state', 'pre-compact-lane-note.json');
  const stamped = existsSync(stateFile) && ME in JSON.parse(readFileSync(stateFile, 'utf8'));
  check('the hook did not stamp the cooldown', !stamped);
  check('no compact event was recorded', (await events('compact')).length === eventsBefore);
  await db.query('ALTER TABLE agentic_os.lane_event DROP CONSTRAINT zz_block_compact');
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
