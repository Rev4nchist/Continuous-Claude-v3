// Tests for scripts/coordination/run-probes.mjs (card coord-test-suite, PR 2). No database: every child process is a fake.
//
// How the runner can fail, one test each:
//   T1  a SKIP line is not counted, or a line that only holds the word is counted: a skipped check passes the build
//   T2  the refusal environment keeps a live url, another url variable, docker settings, or more than the node folder on PATH
//   T3  the safety check passes when docker or psql can start in that environment, or when the start error is not ENOENT
//   T4  a probe that does not refuse a live url passes the refusal check (exit 0, exit 1, exit 2 with no refusal line, PASS or FAIL
//       on stdout, FAIL on stderr)
//   T5  an unknown or empty --only name runs fewer probes and the run still passes
//   T6  the refusal check runs, or a probe starts, although docker or psql could start in the refusal environment
//   T7  a probe that prints a SKIP line, exits non-zero, or leaves its database behind passes the run
//   T8  a failed probe leaves its scratch database (the drop is not in finally)
//   T9  no Postgres (create fails) gives exit 1 instead of 2, or goes on to the next probe
//   T10 a failing probe prints the password of the scratch url
//   T14 a probe gets the caller's home or the caller's session id, or two probes share one home or one session id
//   T15 the stand-in home does not link to the checkout that holds run-probes.mjs (a probe then tests another copy of the code)
//   T16 the cleanup deletes recursively, or removes the home before the link, or skips the cleanup of a failed probe
//   T17 (real folders) the cleanup empties the target of the link: a marker file in the target must survive
//   T18 the cleanup removes a path that is not a link (a real folder named continuous-claude)
//   T19 the cleanup goes on to remove the home while the link is still there
//   T20 a probe has no LANE_PROJECT (a runner folder has no board: lane.mjs refuses) or gets the board of the caller
//   T21 the error text of a racer loses its exit code, is not cut to 600 characters, or shows a url password
//   T22 lane-race-probe.mjs stops printing the first errored racer (the cause of "24 errored" is hidden again)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNoDocker, checkRefusal, countSkips, DEAD_LIVE, redact, refusalEnv, run } from './run-probes.mjs';
import * as probes from './run-probes.mjs'; // namespace import: a missing export fails its own test, not the whole file

/** The n-th scratch url the fake `scratch-db.mjs create` hands out: one name for each create, so a shared database shows. */
const scratchUrl = (n) => `postgresql://claude:s3cretPw@localhost:5432/lanes_pr1_abc${String(n).padStart(3, '0')}`;
const SCRATCH_URL = scratchUrl(1);
const REFUSAL = { status: 2, stdout: '', stderr: "x-probe: refusing to run: database 'continuous_claude' is not a scratch database.\n" };
const PASSED = { status: 0, stdout: 'PASS everything\n', stderr: '' };
const PROBES = [{ name: 'a', file: 'a-probe.mjs' }, { name: 'b', file: 'b-probe.mjs' }];
const noEnoent = { error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) };

/**
 * A spawn that fakes every child: docker and psql (ENOENT unless `dockerStarts`), scratch-db.mjs create and drop, and each
 * probe (a refusal answer when it gets the live url, a run answer when it gets the scratch url). `calls` records every call.
 */
function fakeSpawn({ refusal = {}, runs = {}, dockerStarts = null, createFails = false, dropFails = false } = {}) {
  const calls = [];
  const created = [];
  const dropped = [];
  const fn = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, env: opts.env });
    if (cmd === 'docker' || cmd === 'psql') return dockerStarts && dockerStarts.includes(cmd) ? { status: 0, stdout: 'v1' } : noEnoent;
    const script = path.basename(String(args[0] ?? ''));
    if (script === 'scratch-db.mjs') {
      if (args[1] === 'create') {
        if (createFails) return { status: 1, stdout: '', stderr: 'ECONNREFUSED 127.0.0.1:5432' };
        const url = scratchUrl(created.length + 1);
        created.push(url);
        return { status: 0, stdout: `${JSON.stringify({ url, name: new URL(url).pathname.slice(1) })}\n`, stderr: '' };
      }
      dropped.push(args[2]);
      return dropFails ? { status: 1, stdout: '', stderr: 'database is being used' } : { status: 0, stdout: '', stderr: '' };
    }
    const live = opts.env?.CONTINUOUS_CLAUDE_DB_URL === DEAD_LIVE;
    return live ? (refusal[script] ?? REFUSAL) : (runs[script] ?? PASSED);
  };
  fn.calls = calls;
  fn.created = created;
  fn.dropped = dropped;
  return fn;
}
const probeCalls = (spawn) => spawn.calls.filter((c) => /-probe\.mjs$/.test(String(c.args[0] ?? '')));
const scratchCalls = (spawn, verb) => spawn.calls.filter((c) => /scratch-db\.mjs$/.test(String(c.args[0] ?? '')) && c.args[1] === verb);
/**
 * A fake file system for the stand-in home. `log` records every call. rmSync must never be called: the cleanup has no recursive delete.
 * `linkSurvivesUnlink` fakes an unlink that does nothing; `linkIsDir` fakes a real folder where the link should be.
 */
function fakeFs({ linkSurvivesUnlink = false, linkIsDir = false } = {}) {
  const log = [];
  const live = new Set();
  let n = 0;
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    log,
    mkdtempSync: (prefix) => { const d = `${prefix}${String(++n).padStart(6, '0')}`; log.push(['mkdtemp', d]); live.add(d); return d; },
    symlinkSync: (target, link, type) => { log.push(['symlink', target, link, type]); live.add(link); },
    lstatSync: (p) => { log.push(['lstat', p]); if (!live.has(p)) throw enoent(); return { isSymbolicLink: () => !linkIsDir }; },
    unlinkSync: (p) => { log.push(['unlink', p]); if (!linkSurvivesUnlink) live.delete(p); },
    rmdirSync: (p, o) => { log.push(['rmdir', p, o]); live.delete(p); },
    rmSync: (p, o) => { log.push(['rm', p, o]); },
  };
}
const ops = (fsx, name) => fsx.log.filter((e) => e[0] === name);
const go = (opts) => { const spawn = fakeSpawn(opts); const fsx = opts?.fsx ?? fakeFs(); return { spawn, fsx, r: run({ spawn, env: {}, probes: PROBES, dir: '/probes', fsx, ...(opts?.run ?? {}) }) }; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('T1 countSkips counts the lines that start with SKIP and no other line', () => {
  // Breaks when the pattern loses its ^ anchor (a line that only mentions SKIP counts) or its \s* (an indented SKIP line is missed).
  assert.equal(countSkips('PASS a\nSKIP  check 6 - no table\n  SKIP indented\nPASS c, nothing to SKIP here\nNO SKIPS HERE\nPASS b'), 2);
  assert.equal(countSkips(''), 0);
  assert.equal(countSkips(undefined), 0);
});

test('T2 the refusal environment names the live database on a dead port and holds only the node folder on PATH', () => {
  // Breaks when a delete is dropped, the live name is replaced, or the Windows `Path` spelling is kept next to PATH.
  const env = refusalEnv({ DATABASE_URL: 'u', OPC_POSTGRES_URL: 'u', DOCKER_HOST: 'tcp://h', DOCKER_CONTEXT: 'c', Path: 'C:\\docker', PATH: '/usr/bin', HOME: '/h' }, '/opt/node/bin/node');
  assert.equal(env.CONTINUOUS_CLAUDE_DB_URL, DEAD_LIVE);
  for (const k of ['DATABASE_URL', 'OPC_POSTGRES_URL', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'Path']) assert.equal(k in env, false, k);
  assert.equal(env.PATH, path.dirname('/opt/node/bin/node'));
  assert.equal(env.HOME, '/h');
});

test('T3 checkNoDocker passes when docker and psql cannot start, and fails closed otherwise', () => {
  // Breaks when it passes on a started docker or psql, or when it reads a start error that is not ENOENT (EACCES) as "cannot start".
  assert.equal(checkNoDocker({ spawn: fakeSpawn(), env: {} }).ok, true);
  for (const started of [['docker'], ['psql'], ['docker', 'psql']]) {
    const r = checkNoDocker({ spawn: fakeSpawn({ dockerStarts: started }), env: {} });
    assert.equal(r.ok, false, started.join());
    for (const cmd of started) assert.match(r.line, new RegExp(cmd));
  }
  const eacces = () => ({ error: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) });
  assert.equal(checkNoDocker({ spawn: eacces, env: {} }).ok, false);
});

test('T4 checkRefusal passes only a probe that exits 2 with its refusal line and prints no PASS or FAIL', () => {
  // Breaks when the exit code, the refusal text or the PASS/FAIL test on either stream is dropped.
  const probe = { name: 'a', file: 'a-probe.mjs' };
  const verdict = (answer) => checkRefusal(probe, { spawn: () => answer, env: {}, dir: '/probes' }).ok;
  assert.equal(verdict(REFUSAL), true);
  assert.equal(verdict({ ...REFUSAL, status: 0 }), false);
  assert.equal(verdict({ ...REFUSAL, status: 1 }), false);
  assert.equal(verdict({ status: 2, stdout: '', stderr: 'something else\n' }), false);
  assert.equal(verdict({ ...REFUSAL, stdout: 'PASS cleanup\n' }), false);
  assert.equal(verdict({ ...REFUSAL, stderr: `${REFUSAL.stderr}FAIL cleanup of the live table\n` }), false);
  assert.equal(verdict({ ...REFUSAL, stderr: `${REFUSAL.stderr}PASSWORD is hidden\n` }), true, 'a word that only starts with PASS is not a PASS line');
});

test('T5 an unknown or empty --only is an error that names the known probes, and no child starts', () => {
  // Breaks when an unknown name is dropped (the run passes with fewer probes), or an empty list means "all".
  const typo = go({ run: { only: ['a', 'typo'] } });
  assert.equal(typo.r.code, 1);
  assert.match(typo.r.lines.join('\n'), /typo/);
  assert.match(typo.r.lines.join('\n'), /known: a, b/);
  assert.equal(typo.spawn.calls.length, 0);
  const empty = go({ run: { only: [] } });
  assert.equal(empty.r.code, 1);
  assert.equal(empty.spawn.calls.length, 0);
});

test('T6 when docker or psql can start in the refusal environment, the run stops before any probe or database', () => {
  // Breaks when the safety check is skipped, or its failure does not stop the run.
  const { spawn, r } = go({ dockerStarts: ['docker'] });
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /refusal environment: docker can start/);
  assert.equal(probeCalls(spawn).length, 0);
  assert.equal(scratchCalls(spawn, 'create').length, 0);
});

test('T7 refusal-only checks every probe and fails when one does not refuse', () => {
  // Breaks when the refusal result of a probe is not counted in the exit code.
  const ok = go({ run: { refusalOnly: true } });
  assert.equal(ok.r.code, 0);
  assert.equal(scratchCalls(ok.spawn, 'create').length, 0, 'refusal-only needs no database');
  const bad = go({ refusal: { 'b-probe.mjs': PASSED }, run: { refusalOnly: true } });
  assert.equal(bad.r.code, 1);
  assert.match(bad.r.lines.join('\n'), /FAIL refusal b: did not refuse/);
});

test('T8 a full run gives each probe its own scratch database, in order, and drops each one', () => {
  // Breaks when two probes share a database (the first url is reused), a probe gets a url that was not made for it,
  // an env variable of the chain keeps another url, or a database is not dropped.
  const { spawn, r } = go();
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(spawn.created.length, PROBES.length);
  assert.equal(new Set(spawn.created).size, PROBES.length, 'one distinct database for each probe');
  const runs = probeCalls(spawn).filter((x) => x.env.CONTINUOUS_CLAUDE_DB_URL !== DEAD_LIVE);
  assert.equal(runs.length, PROBES.length);
  runs.forEach((c, i) => {
    assert.equal(c.env.CONTINUOUS_CLAUDE_DB_URL, spawn.created[i], `probe ${i} runs on the database made for it`);
    assert.equal(c.env.DATABASE_URL, spawn.created[i]);
    assert.equal(c.env.OPC_POSTGRES_URL, spawn.created[i]);
  });
  assert.deepEqual([...spawn.dropped].sort(), [...spawn.created].sort(), 'every database made is dropped, none else');
  assert.equal(r.lines.filter((l) => /dropped lanes_pr1_abc\d+/.test(l)).length, PROBES.length);
});

test('T9 a probe that prints a SKIP line fails the run although it exits 0', () => {
  // Breaks when the skip count is not part of the verdict (dm-delivery exits 0 with a SKIP when a migration is missing).
  const { r } = go({ runs: { 'a-probe.mjs': { status: 0, stdout: 'PASS one\nSKIP  check 6 - no table\n', stderr: '' } } });
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /FAIL a on lanes_pr1_abc001: exit 0, 1 skip/);
});

test('T10 a failing probe still drops its database, and the run goes on to the next probe', () => {
  // Breaks when the drop leaves the finally block, or a failure ends the loop.
  const { spawn, r } = go({ runs: { 'a-probe.mjs': { status: 1, stdout: 'FAIL check 3\n', stderr: '' } } });
  assert.equal(r.code, 1);
  assert.equal(scratchCalls(spawn, 'drop').length, PROBES.length);
  assert.match(r.lines.join('\n'), /PASS b on/);
});

test('T11 a failed drop fails the run, with the database name in the line', () => {
  // Breaks when a drop failure is ignored: scratch databases pile up in the shared container.
  const { r } = go({ dropFails: true });
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /could not drop the scratch database/);
});

test('T12 no Postgres gives exit 2 with one ENV line and stops at the first probe', () => {
  // Breaks when exit 2 becomes 1 (the environment is read as a failing change), or the loop goes on after a failed create.
  const { spawn, r } = go({ createFails: true });
  assert.equal(r.code, 2);
  assert.match(r.lines.join('\n'), /ENV: run-probes needs local Postgres/);
  assert.equal(scratchCalls(spawn, 'create').length, 1);
  assert.equal(probeCalls(spawn).filter((c) => c.env.CONTINUOUS_CLAUDE_DB_URL !== DEAD_LIVE).length, 0);
});

test('T13 the output of a failing probe never shows the password of the scratch url', () => {
  // Breaks when redact() is not applied to the probe output, or masks the url but not its password.
  const leak = `connect failed for ${SCRATCH_URL} and password s3cretPw alone`;
  const { r } = go({ runs: { 'a-probe.mjs': { status: 1, stdout: leak, stderr: leak } } });
  const text = r.lines.join('\n');
  assert.equal(text.includes('s3cretPw'), false, text);
  assert.equal(redact(`see postgresql://u:hunter22@h/db`).includes('hunter22'), false);
});

test('T14 each probe gets its own stand-in home and its own fresh session id, never the ones of the caller', () => {
  // Breaks when the caller's CCV3_USER_HOME or CLAUDE_CODE_SESSION_ID reaches a probe, a value is reused, or the id is not a uuid.
  const { spawn, fsx, r } = go({ run: { env: { CLAUDE_CODE_SESSION_ID: 'caller-sid', CCV3_USER_HOME: '/caller/home' } } });
  assert.equal(r.code, 0, r.lines.join('\n'));
  const runs = probeCalls(spawn).filter((x) => x.env.CONTINUOUS_CLAUDE_DB_URL !== DEAD_LIVE);
  const homes = ops(fsx, 'mkdtemp').map((e) => e[1]);
  assert.equal(runs.length, PROBES.length);
  assert.equal(homes.length, PROBES.length);
  runs.forEach((c, i) => {
    assert.equal(c.env.CCV3_USER_HOME, homes[i], `probe ${i} runs with the home made for it`);
    assert.match(c.env.CLAUDE_CODE_SESSION_ID, UUID);
  });
  assert.equal(new Set(runs.map((c) => c.env.CCV3_USER_HOME)).size, PROBES.length, 'one home for each probe');
  assert.equal(new Set(runs.map((c) => c.env.CLAUDE_CODE_SESSION_ID)).size, PROBES.length, 'one session id for each probe');
  assert.equal(runs.some((c) => c.env.CLAUDE_CODE_SESSION_ID === 'caller-sid' || c.env.CCV3_USER_HOME === '/caller/home'), false);
  assert.ok(r.lines.some((l) => l.includes(homes[0])), 'the run prints the name of the stand-in home');
});

test('T20 each probe runs with LANE_PROJECT=continuous-claude, whatever the caller sets', () => {
  // Breaks when the variable is dropped: a runner folder has no registry entry, so every lane.mjs call of lane-race
  // ends with "no lane board for <dir>", and the caller's value would send a probe to another board.
  const { spawn, r } = go({ run: { env: { LANE_PROJECT: 'some-other-board' } } });
  assert.equal(r.code, 0, r.lines.join('\n'));
  const runs = probeCalls(spawn).filter((x) => x.env.CONTINUOUS_CLAUDE_DB_URL !== DEAD_LIVE);
  assert.equal(runs.length, PROBES.length);
  for (const c of runs) assert.equal(c.env.LANE_PROJECT, 'continuous-claude');
});

test('T21 racerError gives the exit code and the stderr of a failed racer, cut to 600 characters, with every url masked', async () => {
  // Breaks when the exit code or the text is dropped, the text is not cut, whitespace is kept, or a url keeps its password.
  const { racerError } = await import('./racer-error.mjs'); // dynamic: a missing module fails this test only
  const say = racerError({ code: 1, err: 'no lane board for /home/runner/work\n  set LANE_PROJECT=continuous-claude' });
  assert.match(say, /^code 1: no lane board for \/home\/runner\/work set LANE_PROJECT=continuous-claude$/);
  const cut = racerError({ code: 2, err: 'a'.repeat(2000) });
  assert.equal(cut.length, 'code 2: '.length + 600);
  const leak = racerError({ code: 1, err: 'connect postgresql://claude:s3cretPw@db.example:5432/lanes_pr1_x failed' });
  assert.equal(leak.includes('s3cretPw'), false, leak);
  assert.equal(racerError({ code: 7, err: '' }), 'code 7: (no stderr)');
  assert.equal(racerError({ code: 7 }), 'code 7: (no stderr)');
});

test('T22 lane-race-probe.mjs prints the first errored racer through racerError', () => {
  // Breaks when the import or the call is removed: a probe that hides the error text of a racer is a defect
  // (the first Linux CI run showed "0 denied, 24 errored" and nothing else).
  const src = fs.readFileSync(path.join(HERE, 'lane-race-probe.mjs'), 'utf8');
  assert.match(src, /import \{ racerError \} from '\.\/racer-error\.mjs';/);
  assert.match(src, /every loser is denied cleanly[^\n]*\n[^\n]*racerError\(broken\[0\]\)/);
});

test('T15 the stand-in home links continuous-claude to the checkout that holds run-probes.mjs', () => {
  // Breaks when the link points anywhere else (the primary checkout, the home of the caller): the probes would test other code.
  const { fsx } = go();
  const links = ops(fsx, 'symlink');
  assert.equal(links.length, PROBES.length);
  const repo = path.resolve(HERE, '..', '..');
  for (const [, target, link, type] of links) {
    assert.equal(path.resolve(target), repo);
    assert.equal(path.basename(link), 'continuous-claude');
    assert.equal(type, 'junction', 'a junction needs no privilege on Windows');
  }
});

test('T16 the cleanup removes the link first, then the home, with no recursive delete, also for a failed probe', () => {
  // Breaks when the cleanup calls rmSync or a recursive rmdir (a Windows junction is followed and its target emptied), removes the
  // home before the link, does not check the link is gone, or skips the cleanup after a failed probe.
  const { fsx, r } = go({ runs: { 'a-probe.mjs': { status: 1, stdout: 'FAIL check 3\n', stderr: '' } } });
  assert.equal(r.code, 1);
  assert.equal(ops(fsx, 'rm').length, 0, 'no rmSync call');
  const homes = ops(fsx, 'mkdtemp').map((e) => e[1]);
  const links = ops(fsx, 'symlink').map((e) => e[2]);
  assert.equal(ops(fsx, 'unlink').length, PROBES.length, 'one unlink for each link, the failed probe too');
  assert.equal(ops(fsx, 'rmdir').length, PROBES.length);
  for (const [, , o] of ops(fsx, 'rmdir')) assert.ok(!o || !o.recursive, 'no recursive rmdir');
  homes.forEach((home, i) => {
    const at = (op, p) => fsx.log.findIndex((e) => e[0] === op && e[1] === p);
    const unlinked = at('unlink', links[i]);
    const checked = fsx.log.findIndex((e, k) => k > unlinked && e[0] === 'lstat' && e[1] === links[i]);
    const removed = at('rmdir', home);
    assert.ok(unlinked >= 0 && checked > unlinked && removed > checked, `home ${i}: unlink, then a check that the link is gone, then rmdir`);
  });
});

test('T17 with real folders the cleanup leaves the target of the link whole (a marker file survives)', () => {
  // Breaks when a recursive delete follows the link into the checkout. Real fs, real link, real marker.
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-target-'));
  const marker = path.join(target, 'marker.txt');
  fs.writeFileSync(marker, 'keep');
  let made = null;
  try {
    made = probes.makeStandInHome({ target });
    assert.equal(fs.readFileSync(path.join(made.link, 'marker.txt'), 'utf8'), 'keep', 'the link reaches the target');
    const gone = probes.removeStandInHome(made);
    assert.equal(gone.ok, true, gone.line);
    assert.equal(fs.existsSync(made.home), false, 'the stand-in home is gone');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep', 'the marker file in the target survives');
    made = null;
  } finally {
    if (made) { try { fs.unlinkSync(made.link); } catch { /* already gone */ } try { fs.rmdirSync(made.home); } catch { /* already gone */ } }
    fs.rmSync(target, { recursive: true, force: true }); // the target holds no link: a recursive delete is safe here
  }
});

test('T18 the cleanup refuses to remove a path that is not a link', () => {
  // Breaks when the cleanup unlinks or removes without the isSymbolicLink check: a real folder would be deleted.
  const fsx = fakeFs({ linkIsDir: true });
  const made = probes.makeStandInHome({ fsx, target: '/repo' });
  const gone = probes.removeStandInHome({ fsx, ...made });
  assert.equal(gone.ok, false);
  assert.match(gone.line, /not a link/);
  assert.equal(ops(fsx, 'unlink').length + ops(fsx, 'rmdir').length + ops(fsx, 'rm').length, 0, 'nothing is removed');
});

test('T19 the cleanup stops when the link is still there after the unlink', () => {
  // Breaks when the check after the unlink is dropped: the home would be removed with the link inside.
  const fsx = fakeFs({ linkSurvivesUnlink: true });
  const made = probes.makeStandInHome({ fsx, target: '/repo' });
  const gone = probes.removeStandInHome({ fsx, ...made });
  assert.equal(gone.ok, false);
  assert.match(gone.line, /still there/);
  assert.equal(ops(fsx, 'rmdir').length + ops(fsx, 'rm').length, 0);
});
