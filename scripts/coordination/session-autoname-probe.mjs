/**
 * session-autoname-probe -- end-to-end gate for automatic session names (Session identity Phase 1).
 *
 * Feeds real SessionStart payloads into the BUILT hook (.claude/hooks/dist/session-register.mjs)
 * with a temp HOME, a temp CCV3_IDENTITY_DIR and the live local Postgres, then reads the hook's
 * stdout JSON and the identity file it wrote. Run `npm run build` in .claude/hooks first.
 *
 *   node scripts/coordination/session-autoname-probe.mjs
 *
 * Cases:
 *   A1  startup, no session_title -> hookSpecificOutput.sessionTitle is a list word, the file holds it,
 *       the greeting says "<word> #sid8"; a second start of the same uuid gives the same word
 *   A2  startup with session_title -> no sessionTitle key, the file keeps the given name
 *   A3  entrypoint sdk-cli -> unnamed; CCV3_AUTONAME=1 -> named; entrypoint cli -> named; CCV3_AUTONAME=0 -> unnamed
 *   A4  a live peer (identity file + fresh sessions row) holds the start word -> another word (DB path),
 *       and the same with the DB down (degraded folder scan)
 *   A5  resume with `previous` an ended named file -> carried; a third live session holds the word -> fresh word;
 *       resume of the SAME uuid (Claude Code keeps the id) -> same word
 *   A6  fork with a quiet parent -> carried; fork with a live parent -> fresh word
 *   A7  clear after an old file ended with endReason clear -> carried
 *   A8  all 48 words held -> "<word>2"
 *   A9  ten starts in a row -> ten distinct words (hard gate)
 *   A10 DB on a closed port -> named, under 10 s, greeting intact
 *   A11 DB on a port that accepts and never answers -> named, under 10 s, greeting intact
 *   A12 D5: resume and clear spawn lane.mjs adopt; fork does not (stub lane.mjs in a temp CCV3_REPO)
 *   A13 compact -> no name, no sessionTitle
 *   A14 D6: startup + session_title with one fresh unended twin -> hint line in the greeting, no lane.mjs spawn;
 *       no hint for an ended twin, a list word or two twins
 *
 * Every file and sessions row it makes is removed, including on failure. It never writes the real ~/.claude.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { AUTO_WORDS } from './session-label.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const HOOK = join(REPO, '.claude', 'hooks', 'dist', 'session-register.mjs');

let Client;
try { ({ Client } = requireDep('pg', { repoRoot: REPO })); } catch (e) { console.error(`session-autoname-probe: ${e.message}`); process.exit(2); }
const CONN = process.env.CONTINUOUS_CLAUDE_DB_URL
  || process.env.DATABASE_URL
  || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';

const ROOT = mkdtempSync(join(tmpdir(), 'ccv3-autoname-probe-'));
const HOME = join(ROOT, 'home');
const IDDIR = join(ROOT, 'identity');
const CWD = join(ROOT, 'cwd');
const MARKERS = join(ROOT, 'markers');
const STUB_REPO = join(ROOT, 'stub-repo');
for (const d of [HOME, IDDIR, CWD, MARKERS, join(STUB_REPO, 'scripts', 'coordination')]) mkdirSync(d, { recursive: true });
writeFileSync(join(STUB_REPO, 'scripts', 'coordination', 'lane.mjs'),
  "import { writeFileSync } from 'node:fs';\n" +
  "writeFileSync(`${process.env.PROBE_MARKERS}/${process.env.CLAUDE_CODE_SESSION_ID}.txt`, process.argv.slice(2).join(' '));\n");

const SESSIONS = [];
const sid = () => { const u = randomUUID(); SESSIONS.push(u); return u; };
const s8 = (u) => u.slice(0, 8);
const realMarker = join(homedir(), '.claude', '.coordination-session-id');
const realMarkerBefore = existsSync(realMarker) ? statSync(realMarker).mtimeMs : null;

function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['CLAUDE_CODE_ENTRYPOINT', 'CCV3_AUTONAME', 'CLAUDE_CODE_SESSION_ID', 'COORDINATION_SESSION_ID']) delete env[k];
  return {
    ...env, HOME, USERPROFILE: HOME, CCV3_IDENTITY_DIR: IDDIR, CONTINUOUS_CLAUDE_DB_URL: CONN,
    CCV3_REPO: join(ROOT, 'no-such-repo'), PROBE_MARKERS: MARKERS, ...extra,
  };
}

/** Run the built hook with a payload. Returns the parsed stdout, the wall time and the raw text. */
function run(payload, extra = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: CWD, ...payload }),
    encoding: 'utf8', env: baseEnv(extra), timeout: 20000,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* reported by the check */ }
  const hso = json?.hookSpecificOutput ?? {};
  return { json, hso, title: hso.sessionTitle, ctx: hso.additionalContext ?? '', ms: Date.now() - t0, raw: r.stdout, err: r.stderr, code: r.status };
}

const idFile = (u) => join(IDDIR, `${u}.json`);
const readId = (u) => { try { return JSON.parse(readFileSync(idFile(u), 'utf8')); } catch { return null; } };
function writeId(u, o = {}) {
  writeFileSync(idFile(u), JSON.stringify({
    uuid: u, short: s8(u), name: null, previous: null, cwd: CWD, endedAt: null, endReason: null,
    updatedAt: new Date().toISOString(), ...o,
  }));
}
/** A transcript whose head replays `ids` in order: the last id before `current` is the parent. */
function transcript(...ids) {
  const p = join(ROOT, `t-${randomUUID()}.jsonl`);
  writeFileSync(p, ids.map((sessionId) => JSON.stringify({ sessionId, type: 'user' })).join('\n') + '\n');
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORDSET = new Set(AUTO_WORDS);
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const isWord = (w) => WORDSET.has(w);

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([true, name]); } catch (e) { results.push([false, `${name} -- ${e.message}`]); }
}
let dbc = null;
const putLive = (u, ageMinutes = 0) => dbc.query(
  `INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,'zz-sid-probe','x', now() - ($2 || ' minutes')::interval)
   ON CONFLICT (id) DO UPDATE SET last_heartbeat = EXCLUDED.last_heartbeat, last_activity_at = NULL`, [u, String(ageMinutes)]);
const DEAD = 'postgresql://x:x@127.0.0.1:1/x';
const quiet = (u) => dbc.query(`UPDATE sessions SET last_heartbeat = now() - interval '1 day', last_activity_at = NULL WHERE id = $1`, [u]);

async function waitFor(file, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (existsSync(file)) return true; await sleep(150); }
  return false;
}

async function main() {
  must(existsSync(HOOK), `${HOOK} is missing: run npm run build in .claude/hooks`);
  dbc = new Client({ connectionString: CONN, connectionTimeoutMillis: 4000 });
  await dbc.connect();

  await check('A1 startup with no title: sessionTitle is a list word, file and greeting agree, same uuid same word', async () => {
    const u = sid();
    const a = run({ session_id: u, source: 'startup' });
    must(isWord(a.title), `sessionTitle ${JSON.stringify(a.title)} is not a list word; stdout ${a.raw}; stderr ${a.err}`);
    must(a.hso.hookEventName === 'SessionStart' && a.ctx.includes('MULTI-SESSION COORDINATION ACTIVE'), 'greeting lost');
    must(readId(u)?.name === a.title, `file name ${readId(u)?.name}`);
    must(a.ctx.includes(`${a.title} #${s8(u)}`), 'greeting has no "<word> #sid8"');
    const b = run({ session_id: u, source: 'startup' });
    must(b.title === a.title, `second start gave ${b.title}, first ${a.title}`);
  });

  await check('A2 startup with session_title: no sessionTitle key, the given name stays', async () => {
    const u = sid();
    const a = run({ session_id: u, source: 'startup', session_title: 'trex' });
    must(!('sessionTitle' in a.hso), `sessionTitle present: ${a.title}`);
    must(readId(u)?.name === 'trex', `file name ${readId(u)?.name}`);
    must(a.ctx.includes(`trex #${s8(u)}`), 'greeting lost the name');
  });

  await check('A3 entrypoint gate: sdk-cli unnamed, CCV3_AUTONAME=1 named, cli named, CCV3_AUTONAME=0 unnamed', async () => {
    const u1 = sid(); const u2 = sid(); const u3 = sid(); const u4 = sid();
    const a = run({ session_id: u1, source: 'startup' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    must(!('sessionTitle' in a.hso) && !readId(u1)?.name, `sdk-cli was named: ${a.title} / ${readId(u1)?.name}`);
    must(a.ctx.includes('MULTI-SESSION'), 'sdk-cli greeting lost');
    const b = run({ session_id: u2, source: 'startup' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', CCV3_AUTONAME: '1' });
    must(isWord(b.title), `forced run unnamed: ${b.raw}`);
    const c = run({ session_id: u3, source: 'startup' }, { CLAUDE_CODE_ENTRYPOINT: 'cli' });
    must(isWord(c.title), `interactive run unnamed: ${c.raw}`);
    const d = run({ session_id: u4, source: 'startup' }, { CLAUDE_CODE_ENTRYPOINT: 'cli', CCV3_AUTONAME: '0' });
    must(!('sessionTitle' in d.hso) && !readId(u4)?.name, 'CCV3_AUTONAME=0 still named');
  });

  await check('A4 a live peer holds the start word: the next free word (DB path and degraded path)', async () => {
    for (const mode of ['db', 'degraded']) {
      const u = sid(); const peer = sid();
      const extra = mode === 'db' ? {} : { CONTINUOUS_CLAUDE_DB_URL: DEAD };
      const w = run({ session_id: u, source: 'startup' }, extra).title;
      must(isWord(w), `${mode}: first pick ${w}`);
      rmSync(idFile(u));
      writeId(peer, { name: w.toUpperCase() });
      await putLive(peer);
      const again = run({ session_id: u, source: 'startup' }, extra).title;
      must(isWord(again) && again !== w, `${mode}: held word ${w} picked again (${again})`);
      writeId(peer, { name: w, endedAt: new Date().toISOString() });
      rmSync(idFile(u));
      must(run({ session_id: u, source: 'startup' }, extra).title === w, `${mode}: an ended peer still holds ${w}`);
    }
  });

  await check('A5 resume carries the previous name; a live third holder forces a fresh word; same-uuid resume keeps the word', async () => {
    const prev = sid(); const nu = sid(); const third = sid();
    writeId(prev, { name: 'carry-a', endedAt: new Date().toISOString(), endReason: 'other' });
    const a = run({ session_id: nu, source: 'resume', transcript_path: transcript(prev, nu) });
    must(a.title === 'carry-a', `carried ${a.title}; ${a.raw} ${a.err}`);
    must(readId(nu)?.name === 'carry-a' && readId(nu)?.previous === prev, `file ${JSON.stringify(readId(nu))}`);
    const nu2 = sid();
    writeId(third, { name: 'carry-a' });
    await putLive(third);
    const b = run({ session_id: nu2, source: 'resume', transcript_path: transcript(prev, nu2) });
    must(isWord(b.title) && b.title !== 'carry-a', `third holder ignored: ${b.title}`);
    rmSync(idFile(third));
    const same = sid();
    const first = run({ session_id: same, source: 'startup' }).title;
    const again = run({ session_id: same, source: 'resume', transcript_path: transcript(same) });
    must(again.title === first, `same-uuid resume gave ${again.title}, expected ${first}`);
  });

  await check('A6 fork carries from a quiet parent only', async () => {
    const parent = sid(); const f1 = sid(); const f2 = sid();
    writeId(parent, { name: 'carry-b' });
    await putLive(parent, 0);
    const live = run({ session_id: f1, source: 'fork', transcript_path: transcript(parent, f1) });
    must(isWord(live.title) && live.title !== 'carry-b', `live parent: fork got ${live.title}`);
    await quiet(parent);
    const q = run({ session_id: f2, source: 'fork', transcript_path: transcript(parent, f2) });
    must(q.title === 'carry-b', `quiet parent: fork got ${q.title}`);
  });

  await check('A7 clear carries the name of the file that ended with endReason clear', async () => {
    const old = sid(); const nu = sid();
    writeId(old, { name: 'carry-c', endedAt: new Date().toISOString(), endReason: 'clear' });
    const a = run({ session_id: nu, source: 'clear' });
    must(a.title === 'carry-c', `clear got ${a.title}; ${a.raw}`);
    rmSync(idFile(old)); rmSync(idFile(nu));
  });

  await check('A8 all 48 words held: "<word>2"', async () => {
    const dir = IDDIR;
    const peers = AUTO_WORDS.map((w) => { const p = sid(); writeId(p, { name: w }); return p; });
    const u = sid();
    const a = run({ session_id: u, source: 'startup' }, { CONTINUOUS_CLAUDE_DB_URL: DEAD });
    must(/^[a-z]+2$/.test(a.title ?? '') && isWord(a.title.slice(0, -1)), `got ${a.title} (dir ${dir})`);
    for (const p of peers) rmSync(idFile(p));
  });

  await check('A9 ten starts in a row give ten distinct words', async () => {
    const words = [];
    for (let i = 0; i < 10; i++) {
      const u = sid();
      await putLive(u);
      words.push(run({ session_id: u, source: 'startup' }).title);
      await sleep(300);
    }
    must(words.every(isWord) && new Set(words).size === 10, `words ${words.join(',')}`);
  });

  await check('A10 DB on a closed port: named, under 10 s, greeting intact', async () => {
    const a = run({ session_id: sid(), source: 'startup' }, { CONTINUOUS_CLAUDE_DB_URL: DEAD });
    must(isWord(a.title) && a.ms < 10000 && a.ctx.includes('MULTI-SESSION'), `title ${a.title}, ${a.ms} ms`);
  });

  await check('A11 DB that accepts and never answers: named, under 10 s, greeting intact', async () => {
    const socks = [];
    const srv = createServer((s) => socks.push(s));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const url = `postgresql://x:x@127.0.0.1:${srv.address().port}/x`;
      const a = run({ session_id: sid(), source: 'startup' }, { CONTINUOUS_CLAUDE_DB_URL: url });
      results.push([true, `   (A11 took ${a.ms} ms)`]);
      must(isWord(a.title) && a.ms < 10000 && a.ctx.includes('MULTI-SESSION'), `title ${a.title}, ${a.ms} ms, stderr ${a.err}`);
    } finally {
      for (const s of socks) s.destroy();
      srv.close();
    }
  });

  await check('A12 D5: resume and clear spawn adopt, fork does not', async () => {
    const stub = { CCV3_REPO: STUB_REPO };
    const prev = sid();
    writeId(prev, { name: 'trex', endedAt: new Date().toISOString(), endReason: 'other' });
    const r = sid();
    run({ session_id: r, source: 'resume', transcript_path: transcript(prev, r) }, stub);
    must(await waitFor(join(MARKERS, `${r}.txt`)), 'resume spawned no adopt');
    must(readFileSync(join(MARKERS, `${r}.txt`), 'utf8').includes(`adopt --from ${prev}`), 'resume adopt args wrong');
    const old = sid(); const c = sid();
    writeId(old, { name: 'trex', endedAt: new Date().toISOString(), endReason: 'clear' });
    run({ session_id: c, source: 'clear' }, stub);
    must(await waitFor(join(MARKERS, `${c}.txt`)), 'clear spawned no adopt');
    const f = sid();
    const fk = run({ session_id: f, source: 'fork', transcript_path: transcript(prev, f) }, stub);
    await sleep(2500);
    must(!existsSync(join(MARKERS, `${f}.txt`)), 'fork spawned adopt');
    must(readId(f)?.previous === prev, `fork lost its previous link: ${JSON.stringify(readId(f))}`);
    must(fk.ctx.includes('MULTI-SESSION'), 'fork greeting lost');
  });

  await check('A13 compact: no name, no sessionTitle', async () => {
    const u = sid();
    const a = run({ session_id: u, source: 'compact' });
    must(!('sessionTitle' in a.hso) && !readId(u)?.name, `compact named: ${a.title} / ${readId(u)?.name}`);
  });

  await check('A14 D6: same-name startup hint reports, never moves; no hint for ended twin, list word, two twins', async () => {
    const stub = { CCV3_REPO: STUB_REPO };
    const twin = sid(); const u = sid();
    writeId(twin, { name: 'foo-probe' });
    const a = run({ session_id: u, source: 'startup', session_title: 'foo-probe' }, stub);
    must(a.ctx.includes(`lane.mjs adopt --from ${twin}`) && a.ctx.includes('never ended'), `no hint: ${a.ctx}`);
    await sleep(1500);
    must(!existsSync(join(MARKERS, `${u}.txt`)), 'the hint run moved lanes (spawned adopt)');
    rmSync(idFile(u)); // the run above wrote a fresh unended "foo-probe" file of its own
    writeId(twin, { name: 'foo-probe', endedAt: new Date().toISOString() });
    must(!run({ session_id: sid(), source: 'startup', session_title: 'foo-probe' }).ctx.includes('adopt --from'), 'hint for an ended twin');
    const w = sid(); const w2 = sid();
    writeId(w, { name: 'otter' });
    must(!run({ session_id: w2, source: 'startup', session_title: 'otter' }).ctx.includes('adopt --from'), 'hint for a list word');
    const t1 = sid(); const t2 = sid();
    writeId(t1, { name: 'bar-probe' }); writeId(t2, { name: 'bar-probe' });
    must(!run({ session_id: sid(), source: 'startup', session_title: 'bar-probe' }).ctx.includes('adopt --from'), 'hint for two twins');
  });

  await check('the real ~/.claude session marker was not touched', async () => {
    const after = existsSync(realMarker) ? statSync(realMarker).mtimeMs : null;
    must(after === realMarkerBefore, `mtime ${realMarkerBefore} -> ${after}`);
  });
}

try {
  await main();
} catch (e) {
  results.push([false, `probe crashed -- ${e.stack || e.message}`]);
} finally {
  try { if (dbc) await dbc.query(`DELETE FROM sessions WHERE id = ANY($1)`, [SESSIONS]); } catch { /* reported below */ }
  try { await dbc?.end(); } catch { /* ignore */ }
  rmSync(ROOT, { recursive: true, force: true });
}

let bad = 0;
for (const [ok, name] of results) {
  if (!name.startsWith('   ')) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) bad++; } else console.log(name);
}
console.log(`\nsession-autoname-probe: ${results.filter((r) => r[0] && !r[1].startsWith('   ')).length} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
