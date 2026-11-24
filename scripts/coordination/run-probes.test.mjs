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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkNoDocker, checkRefusal, countSkips, DEAD_LIVE, redact, refusalEnv, run } from './run-probes.mjs';

const SCRATCH_URL = 'postgresql://claude:s3cretPw@localhost:5432/lanes_pr1_abc123';
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
  const fn = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, env: opts.env });
    if (cmd === 'docker' || cmd === 'psql') return dockerStarts && dockerStarts.includes(cmd) ? { status: 0, stdout: 'v1' } : noEnoent;
    const script = path.basename(String(args[0] ?? ''));
    if (script === 'scratch-db.mjs') {
      if (args[1] === 'create') return createFails ? { status: 1, stdout: '', stderr: 'ECONNREFUSED 127.0.0.1:5432' } : { status: 0, stdout: `${JSON.stringify({ url: SCRATCH_URL, name: 'lanes_pr1_abc123' })}\n`, stderr: '' };
      return dropFails ? { status: 1, stdout: '', stderr: 'database is being used' } : { status: 0, stdout: '', stderr: '' };
    }
    const live = opts.env?.CONTINUOUS_CLAUDE_DB_URL === DEAD_LIVE;
    return live ? (refusal[script] ?? REFUSAL) : (runs[script] ?? PASSED);
  };
  fn.calls = calls;
  return fn;
}
const probeCalls = (spawn) => spawn.calls.filter((c) => /-probe\.mjs$/.test(String(c.args[0] ?? '')));
const scratchCalls = (spawn, verb) => spawn.calls.filter((c) => /scratch-db\.mjs$/.test(String(c.args[0] ?? '')) && c.args[1] === verb);
const go = (opts) => { const spawn = fakeSpawn(opts); return { spawn, r: run({ spawn, env: {}, probes: PROBES, dir: '/probes', ...(opts?.run ?? {}) }) }; };

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

test('T8 a full run gives each probe its own scratch database and drops each one', () => {
  // Breaks when two probes share a database, or a database is not dropped.
  const { spawn, r } = go();
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(scratchCalls(spawn, 'create').length, PROBES.length);
  assert.equal(scratchCalls(spawn, 'drop').length, PROBES.length);
  assert.equal(r.lines.filter((l) => /dropped lanes_pr1_abc123/.test(l)).length, PROBES.length);
  for (const c of probeCalls(spawn).filter((x) => x.env.CONTINUOUS_CLAUDE_DB_URL !== DEAD_LIVE)) {
    assert.equal(c.env.CONTINUOUS_CLAUDE_DB_URL, SCRATCH_URL);
    assert.equal(c.env.DATABASE_URL, SCRATCH_URL);
    assert.equal(c.env.OPC_POSTGRES_URL, SCRATCH_URL);
  }
});

test('T9 a probe that prints a SKIP line fails the run although it exits 0', () => {
  // Breaks when the skip count is not part of the verdict (dm-delivery exits 0 with a SKIP when a migration is missing).
  const { r } = go({ runs: { 'a-probe.mjs': { status: 0, stdout: 'PASS one\nSKIP  check 6 - no table\n', stderr: '' } } });
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /FAIL a on lanes_pr1_abc123: exit 0, 1 skip/);
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
