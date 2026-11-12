// Tests for lane-context-db-gate.mjs. Run: node --test scripts/github/lane-context-db-gate.test.mjs
//
// The gate makes a scratch database, runs vitest on .claude/hooks/src/__tests__/lane-context-db.test.ts with
// LANE_TEST_DB_URL set, and passes only when every test of that file ran and passed. The spawn function is injected,
// so these tests need no database and no vitest. One test (L12) runs the real program against a closed port.
//
// How the unit can fail, and the test that catches it (written before the code):
//   - a skipped file passes (vitest exits 0 when every test is skipped)                 -> L1
//   - a run with zero tests passes                                                       -> L2
//   - a vitest non-zero exit passes when the counts look fine                            -> L3
//   - a pass when fewer tests passed than ran; no pass when all passed                   -> L4
//   - a missing or unreadable JSON report is a pass, a throw or an ENV line              -> L5
//   - the scratch database is left behind after a pass, a fail or a throw                -> L6
//   - drop is called with no url when create failed                                      -> L7
//   - the url (or its password) reaches stdout, stderr or a thrown message               -> L8
//   - a url that is not a scratch database reaches vitest (or drop)                      -> L9
//   - no Postgres gives a pass, a stack trace or more than one line                      -> L10, L12
//   - vitest gets no LANE_TEST_DB_URL, another file, a shell, or create gets another --through -> L11
//   - vitest not installed gives a raw stack, and the database is not dropped            -> L13
//   - --help does database work                                                          -> L14
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_FILE, redact, run, verdict } from './lane-context-db-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, 'lane-context-db-gate.mjs');
const PASSWORD = 'S3cret-pw_9';
const URL_OK = `postgresql://claude:${PASSWORD}@localhost:5432/lanes_pr1_0a1b2c3d`;
const URL_LIVE = `postgresql://claude:${PASSWORD}@localhost:5432/continuous_claude`;
const VITEST = path.join(os.tmpdir(), 'fake-vitest', 'vitest.mjs');

const report = (o) => ({ numTotalTests: 19, numPassedTests: 19, numPendingTests: 0, numTodoTests: 0, numFailedTests: 0, ...o });

/**
 * A fake spawnSync. `create`, `vitest` and `drop` each return a result, or a function of (args, opts). The vitest step
 * writes `rep` (when given) to the --outputFile.json path, as the real reporter does. `calls` records every spawn.
 */
function fakeSpawn({ create, vitest, drop, rep } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const kind = args.includes('create') ? 'create' : args.includes('drop') ? 'drop' : args[0] === VITEST ? 'vitest' : 'other';
    calls.push({ kind, cmd, args, opts });
    if (kind === 'create') return typeof create === 'function' ? create(args, opts) : (create ?? { status: 0, stdout: `${JSON.stringify({ url: URL_OK, name: 'lanes_pr1_0a1b2c3d' })}\n`, stderr: 'creating scratch database lanes_pr1_0a1b2c3d on localhost:5432\n' });
    if (kind === 'drop') return typeof drop === 'function' ? drop(args, opts) : (drop ?? { status: 0, stdout: '{"dropped":"lanes_pr1_0a1b2c3d"}\n', stderr: '' });
    if (kind === 'vitest') {
      const out = args.find((a) => a.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length);
      if (rep !== undefined && out) writeFileSync(out, typeof rep === 'string' ? rep : JSON.stringify(rep));
      return typeof vitest === 'function' ? vitest(args, opts) : (vitest ?? { status: 0, stdout: ' Tests  19 passed (19)\n', stderr: '' });
    }
    return { status: 1, stdout: '', stderr: `unexpected spawn ${args.join(' ')}` };
  };
  return { spawn, calls };
}

function go(fake, more = {}) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'lcdb-gate-'));
  const r = run({ spawn: fake.spawn, env: { PATH: process.env.PATH ?? '' }, tmpDir, resolveVitest: () => VITEST, ...more });
  return { ...r, tmpDir, text: r.lines.join('\n') };
}

const kinds = (calls) => calls.map((c) => c.kind);

test('L1: a skipped file fails: vitest exit 0 with every test pending is not a pass', () => {
  const v = verdict(0, report({ numPassedTests: 0, numPendingTests: 19 }));
  assert.equal(v.ok, false);
  assert.equal(v.line, 'lane-context-db: 0 of 19 passed, 19 skipped');
  const r = go(fakeSpawn({ rep: report({ numPassedTests: 0, numPendingTests: 19 }) }));
  assert.equal(r.code, 1);
  assert.match(r.text, /0 of 19 passed, 19 skipped/);
  // A todo test is skipped too.
  assert.equal(verdict(0, report({ numPassedTests: 18, numTodoTests: 1 })).ok, false);
});

test('L2: zero tests fails', () => {
  const v = verdict(0, report({ numTotalTests: 0, numPassedTests: 0 }));
  assert.equal(v.ok, false);
  assert.equal(v.line, 'lane-context-db: 0 of 0 passed, 0 skipped');
});

test('L3: a vitest non-zero exit fails even when every counted test passed', () => {
  assert.equal(verdict(1, report()).ok, false);
  assert.equal(verdict(null, report()).ok, false);
  const r = go(fakeSpawn({ rep: report(), vitest: { status: 1, stdout: '', stderr: 'boom\n' } }));
  assert.equal(r.code, 1);
});

test('L4: pass only when P === T > 0 and nothing skipped; P < T fails', () => {
  assert.deepEqual(verdict(0, report()), { ok: true, line: 'lane-context-db: 19 of 19 passed, 0 skipped' });
  assert.equal(verdict(0, report({ numPassedTests: 18, numFailedTests: 1 })).ok, false);
  const r = go(fakeSpawn({ rep: report() }));
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.lines, ['lane-context-db: 19 of 19 passed, 0 skipped']);
});

test('L5: a missing or unparseable JSON report is a plain FAIL line, not a throw and not ENV', () => {
  for (const rep of [undefined, '{not json']) {
    const r = go(fakeSpawn({ rep }));
    assert.equal(r.code, 1);
    assert.match(r.lines.at(-1), /^lane-context-db: FAIL/);
    assert.equal(r.lines.some((l) => l.startsWith('ENV:')), false);
    assert.doesNotMatch(r.text, /\n\s+at /);
  }
  assert.equal(verdict(0, null).ok, false);
});

test('L6: the scratch database is dropped after a pass, after a fail and after a throw, and the temp report is removed', () => {
  const cases = {
    pass: fakeSpawn({ rep: report() }),
    fail: fakeSpawn({ rep: report({ numPassedTests: 0, numPendingTests: 19 }) }),
    throw: fakeSpawn({ vitest: () => { throw new Error('spawn exploded'); } }),
  };
  for (const [name, fake] of Object.entries(cases)) {
    const r = go(fake);
    assert.equal(r.code, name === 'pass' ? 0 : 1, `${name}: ${r.text}`);
    const drops = fake.calls.filter((c) => c.kind === 'drop');
    assert.equal(drops.length, 1, `${name}: one drop`);
    assert.ok(drops[0].args.includes(URL_OK), `${name}: drop names the scratch url`);
    assert.equal(kinds(fake.calls).at(-1), 'drop', `${name}: drop is the last spawn`);
    assert.deepEqual(readdirSync(r.tmpDir), [], `${name}: temp report removed`);
  }
  // A failed drop is a FAIL: a scratch database would be left behind.
  const r = go(fakeSpawn({ rep: report(), drop: { status: 1, stdout: '', stderr: `connect failed for ${URL_OK}\n` } }));
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.text, new RegExp(PASSWORD));
});

test('L7: drop is not called when create failed', () => {
  const fake = fakeSpawn({ create: { status: 1, stdout: '', stderr: 'connect ECONNREFUSED 127.0.0.1:5432\n' } });
  const r = go(fake);
  assert.equal(r.code, 1);
  assert.deepEqual(kinds(fake.calls), ['create']);
  // create exit 0 with no url in its output is a create failure too.
  const empty = fakeSpawn({ create: { status: 0, stdout: '\n', stderr: '' } });
  assert.equal(go(empty).code, 1);
  assert.deepEqual(kinds(empty.calls), ['create']);
});

test('L8: the url and its password never appear in any output, on pass, fail or throw', () => {
  const leak = `url=${URL_OK} pw=${PASSWORD}`;
  const cases = [
    fakeSpawn({ rep: report() }),
    fakeSpawn({ rep: report({ numPassedTests: 0, numPendingTests: 19 }), vitest: { status: 1, stdout: `${leak}\n`, stderr: `${leak}\n` } }),
    fakeSpawn({ vitest: () => { throw new Error(`cannot start with ${leak}`); } }),
    fakeSpawn({ create: { status: 1, stdout: `${leak}\n`, stderr: `error at ${leak}\n` } }),
    fakeSpawn({ rep: report(), drop: () => { throw new Error(`drop died: ${leak}`); } }),
  ];
  // The base url in env holds the same password as the scratch url (scratch-db keeps the server part), as on a real machine.
  const env = { PATH: process.env.PATH ?? '', CONTINUOUS_CLAUDE_DB_URL: URL_LIVE };
  for (const fake of cases) {
    const r = go(fake, { env });
    assert.ok(r.lines.length > 0);
    assert.doesNotMatch(r.text, new RegExp(PASSWORD), r.text);
    assert.equal(r.text.includes(URL_OK), false, r.text);
  }
  // redact also hides a url it was not told about (any scheme://user:pass@).
  assert.equal(redact(`x ${URL_LIVE} y`, URL_OK).includes(PASSWORD), false);
  assert.equal(redact(`a ${URL_OK} b ${PASSWORD} c`, URL_OK).includes(PASSWORD), false);
  // The real program prints only what run() returns: its stdout and stderr carry no url either (see L12).
});

test('L9: a url that is not a scratch database is refused before vitest runs, and is never dropped', () => {
  const fake = fakeSpawn({ create: { status: 0, stdout: `${JSON.stringify({ url: URL_LIVE, name: 'continuous_claude' })}\n`, stderr: '' } });
  const r = go(fake);
  assert.equal(r.code, 1);
  assert.deepEqual(kinds(fake.calls), ['create']);
  assert.match(r.text, /refusing/);
  assert.doesNotMatch(r.text, new RegExp(PASSWORD));
});

test('L10: no Postgres gives exit 1 and exactly one line, which starts with ENV:', () => {
  const fake = fakeSpawn({ create: { status: 1, stdout: '', stderr: 'creating scratch database lanes_pr1_aa on 127.0.0.1:1\nconnect ECONNREFUSED 127.0.0.1:1\n' } });
  const r = go(fake);
  assert.equal(r.code, 1);
  assert.equal(r.lines.length, 1, r.text);
  assert.match(r.lines[0], /^ENV: /);
  assert.match(r.lines[0], /ECONNREFUSED/);
  // A create that could not start at all (spawn error) is the environment too.
  const r2 = go(fakeSpawn({ create: { status: null, stdout: '', stderr: '', error: new Error('spawn ENOENT') } }));
  assert.equal(r2.lines.length, 1);
  assert.match(r2.lines[0], /^ENV: /);
});

test('L11: create gets --through 6; vitest runs the one file in .claude/hooks with LANE_TEST_DB_URL, no shell', () => {
  const fake = fakeSpawn({ rep: report() });
  const hooksDir = path.join(os.tmpdir(), 'some-hooks');
  go(fake, { hooksDir });
  const create = fake.calls.find((c) => c.kind === 'create');
  assert.deepEqual(create.args.slice(-3), ['create', '--through', '6']);
  assert.match(create.args[0].replace(/\\/g, '/'), /scripts\/coordination\/scratch-db\.mjs$/);
  const v = fake.calls.find((c) => c.kind === 'vitest');
  assert.equal(v.cmd, process.execPath);
  assert.deepEqual(v.args.slice(0, 3), [VITEST, 'run', TEST_FILE]);
  assert.equal(TEST_FILE, 'src/__tests__/lane-context-db.test.ts');
  assert.equal(v.opts.cwd, hooksDir);
  assert.equal(v.opts.env.LANE_TEST_DB_URL, URL_OK);
  assert.notEqual(v.opts.shell, true);
  for (const c of fake.calls) assert.equal(c.cmd, process.execPath, `${c.kind} runs node itself`);
});

test('L12: the real program with Postgres on a closed port exits 1 with one ENV: line and no password', () => {
  const env = { ...process.env, CONTINUOUS_CLAUDE_DB_URL: `postgresql://claude:${PASSWORD}@127.0.0.1:1/continuous_claude` };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [GATE], { encoding: 'utf8', env, windowsHide: true, timeout: 60_000 });
  const lines = `${r.stdout}${r.stderr}`.split(/\r?\n/).filter(Boolean);
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /^ENV: /);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, new RegExp(PASSWORD));
});

test('L13: vitest not installed is one ENV line, and the scratch database is still dropped', () => {
  const fake = fakeSpawn({ rep: report() });
  const r = go(fake, { resolveVitest: () => { throw new Error("Cannot find module 'vitest/package.json'"); } });
  assert.equal(r.code, 1);
  assert.equal(r.lines.filter((l) => l.startsWith('ENV:')).length, 1, r.text);
  assert.deepEqual(kinds(fake.calls), ['create', 'drop']);
});

test('L14: --help prints the usage, exits 0 and does no database work', () => {
  const env = { ...process.env, CONTINUOUS_CLAUDE_DB_URL: `postgresql://claude:${PASSWORD}@127.0.0.1:1/continuous_claude` };
  const r = spawnSync(process.execPath, [GATE, '--help'], { encoding: 'utf8', env, windowsHide: true, timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage: node scripts\/github\/lane-context-db-gate\.mjs/);
  assert.doesNotMatch(r.stdout + r.stderr, /^ENV:|ECONNREFUSED|creating scratch database/m);
  assert.ok(existsSync(GATE));
});
