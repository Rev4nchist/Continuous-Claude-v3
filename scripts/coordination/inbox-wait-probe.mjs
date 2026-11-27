/**
 * inbox-wait-probe -- the live check of `lane.mjs inbox --wait` (card coord-inbox-wait).
 *
 * The unit rows in lane-inbox-wait.test.mjs seed event rows by SQL. This probe uses the real verbs of two sessions, as a builder and the seat
 * would: B starts `inbox --wait` in the background, A says to B with `say --to`. It needs a real database, so it makes a SCRATCH one (O3.9)
 * and drops it. It never touches the live database.
 *
 *   node scripts/coordination/inbox-wait-probe.mjs
 *
 * Assertions, in the order they can fail:
 *   1. WOKE        -- B exits 0 within 20 s of the `say --to`, with one line `inbox wait: event <id> from <label> kind <kind>`
 *   2. NO BODY     -- the line holds no word of the message
 *   3. NO CURSOR   -- B's watermark rows did not move
 *   4. STILL UNREAD -- a plain `inbox --peek` still lists the message (the next prompt page owes B the text)
 *   5. LIMIT       -- with nothing sent, a wait of 2 s exits 75
 * Exit 0 when all pass, 1 otherwise.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl } from './scratch-db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANE = path.join(HERE, 'lane.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');
const { Client } = requireDep('pg', { repoRoot: path.join(HERE, '..', '..') });
const fwd = (p) => String(p).replace(/\\/g, '/');

const created = spawnSync(process.execPath, [SCRATCH, 'create', '--through', '6'], { encoding: 'utf8' });
if (created.status !== 0) { console.error(`scratch create failed: ${created.stderr}`); process.exit(1); }
const { url } = JSON.parse(created.stdout);
assertScratchUrl(url);

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-wait-probe-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
fs.mkdirSync(path.join(tmp, 'ids'));
const registry = path.join(tmp, 'registry.json');
fs.writeFileSync(registry, JSON.stringify({ version: '1.0', projects: [{ name: 'probe', key: 'iw-probe', path: fwd(repo), status: 'active' }] }));
const A = randomUUID();
const B = randomUUID();
const envOf = (sid, extra = {}) => {
  const env = { ...process.env };
  for (const k of ['LANE_PROJECT', 'LANE_ALLOW_AS', 'LANE_WAIT_POLL_MS']) delete env[k];
  return Object.assign(env, { CONTINUOUS_CLAUDE_DB_URL: url, DATABASE_URL: url, OPC_POSTGRES_URL: url, LANE_REGISTRY_PATH: registry, CCV3_IDENTITY_DIR: path.join(tmp, 'ids'), CLAUDE_CODE_SESSION_ID: sid }, extra);
};
const run = (sid, args, extra) => spawnSync(process.execPath, [LANE, ...args], { cwd: repo, env: envOf(sid, extra), encoding: 'utf8', windowsHide: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const db = new Client({ connectionString: url });
await db.connect();
try {
  // `say --to` needs B to be a live session (resolveRecipient): one row in `sessions`, as the real hooks write it.
  await db.query(`INSERT INTO sessions (id, project, working_on, last_heartbeat, last_activity_at) VALUES ($1, 'probe', 'inbox-wait-probe fixture', now(), now())`, [B]);
  // B waits (1 s poll, a test setting: honoured only with LANE_ALLOW_AS=1); A says to B one second later.
  const t0 = Date.now();
  const child = spawn(process.execPath, [LANE, 'inbox', '--wait', '--timeout', '60'], { cwd: repo, env: envOf(B, { LANE_ALLOW_AS: '1', LANE_WAIT_POLL_MS: '1000' }), windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  await new Promise((r) => setTimeout(r, 1500));
  const said = run(A, ['say', 'PROBE-SECRET-TEXT please read', '--to', B.slice(0, 8)]);
  const marks = await db.query(`SELECT session_id, last_event_id::text AS n FROM agentic_os.lane_watermark ORDER BY session_id`);
  const code = await Promise.race([closed, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
  const ms = Date.now() - t0;
  if (code === 'timeout') child.kill();
  check('1 WOKE', said.status === 0 && code === 0 && /^inbox wait: event \d+ from \S.* kind note$/.test(out.trim()), `say exit ${said.status}${said.status === 0 ? '' : ` (${said.stderr.trim()})`}, wait exit ${code}, ${ms} ms, line ${JSON.stringify(out.trim())}`);
  check('2 NO BODY', !out.includes('PROBE-SECRET') && !out.includes('please read'));
  const after = await db.query(`SELECT session_id, last_event_id::text AS n FROM agentic_os.lane_watermark ORDER BY session_id`);
  check('3 NO CURSOR', JSON.stringify(after.rows) === JSON.stringify(marks.rows), `${after.rows.length} cursor rows, same before and after`);
  const peek = run(B, ['inbox', '--peek']);
  check('4 STILL UNREAD', peek.status === 0 && peek.stdout.includes('PROBE-SECRET-TEXT'), `peek exit ${peek.status}`);
  // B still has the unread message, so a wait would wake at once: the limit is checked with a third session that has nothing unread.
  const C = randomUUID();
  const none = run(C, ['inbox', '--wait', '--timeout', '2'], { LANE_ALLOW_AS: '1', LANE_WAIT_POLL_MS: '500' });
  check('5 LIMIT', none.status === 75 && none.stdout === '', `exit ${none.status}, stderr ${JSON.stringify(none.stderr.trim())}`);
} finally {
  await db.end().catch(() => {});
  const d = spawnSync(process.execPath, [SCRATCH, 'drop', url], { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`scratch database dropped (status ${d.status})`);
}
const failed = results.filter((x) => !x).length;
console.log(`inbox-wait-probe: ${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
