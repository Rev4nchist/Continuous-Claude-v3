// Tests for lib/lane-cli.mjs. A fake CLI (a temp .mjs that writes its argv and env to a file) stands in for lane.mjs.
// The real lane.mjs never runs here, and no database is touched.
// Failure modes:
//   E1 the child inherits a live database URL in test mode (A2): all three URL variables must be the checked scratch URL
//   E2 test mode runs with no checked URL
//   E3 the session id does not reach the child
//   E4 a shell string or a changed argv: a lane id with a space or a quote must arrive as one argument
//   E5 a non-zero exit, a timeout or a spawn error is not reported as a failure with the first stderr line
//   E6 a database URL with a password reaches the failure text
//   E7 --lane-cli is honoured outside test mode
// Run: node --test scripts/review-engine/lane-cli.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ExitError } from './lib/errors.mjs';
import { laneCliPath, laneEnv, runLane } from './lib/lane-cli.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

const SCRATCH = 'postgresql://u:p@localhost:5432/lanes_pr1_ab12cd34';
const LIVE = 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';

function fakeCli(body) {
  const dir = mkdtempSync(join(tmpdir(), 're lane cli '));
  dirs.push(dir);
  const file = join(dir, 'fake-lane.mjs');
  const dump = join(dir, 'dump.json');
  writeFileSync(file, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
${body}`);
  return { file, dump: () => JSON.parse(readFileSync(dump, 'utf8')) };
}

// An explicit base env: the ambient env of the test run is never passed through by accident.
const BASE = () => ({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
  CONTINUOUS_CLAUDE_DB_URL: LIVE, DATABASE_URL: LIVE, OPC_POSTGRES_URL: LIVE,
});

test('E1 laneEnv in test mode sets all three URL variables to the checked url', () => {
  const env = laneEnv({ testMode: true, url: SCRATCH, sessionId: 'sid-1', base: BASE() });
  for (const k of ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL']) assert.equal(env[k], SCRATCH, k);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, 'sid-1');
  assert.equal(env.PATH, process.env.PATH);
});

test('E2 laneEnv in test mode throws without a checked url', () => {
  assert.throws(() => laneEnv({ testMode: true, sessionId: 's', base: BASE() }), (e) => e instanceof ExitError && e.exitCode === 3);
  assert.throws(() => laneEnv({ testMode: true, url: '', sessionId: 's', base: BASE() }), ExitError);
});

test('E1b laneEnv in live mode leaves the URL variables as the caller has them', () => {
  const env = laneEnv({ testMode: false, sessionId: 's', base: { DATABASE_URL: 'x', PATH: 'p' } });
  assert.deepEqual(env, { DATABASE_URL: 'x', PATH: 'p', CLAUDE_CODE_SESSION_ID: 's' });
});

test('E1c laneEnv does not change the base object', () => {
  const base = BASE();
  laneEnv({ testMode: true, url: SCRATCH, sessionId: 's', base });
  assert.equal(base.DATABASE_URL, LIVE);
});

test('E3 runLane passes argv and the scratch url to the child; a live url in the base env is replaced', () => {
  const cli = fakeCli('');
  const res = runLane(['state', 're-a', 'backlog', '--project', 'continuous-claude'], { cli: cli.file, testMode: true, url: SCRATCH, sessionId: 'sid-9', base: BASE() });
  assert.equal(res.status, 0);
  assert.equal(res.failure, null);
  const seen = cli.dump();
  assert.deepEqual(seen.argv, ['state', 're-a', 'backlog', '--project', 'continuous-claude']);
  for (const k of ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL']) assert.equal(seen.env[k], SCRATCH, k);
  assert.equal(seen.env.CLAUDE_CODE_SESSION_ID, 'sid-9');
});

test('E4 an argument with a space, a quote or a shell character arrives whole', () => {
  const cli = fakeCli('');
  const odd = ['state', 'a b', "c'd", 'e&echo hi', '--note', '$(x)'];
  runLane(odd, { cli: cli.file, testMode: true, url: SCRATCH, sessionId: 's', base: BASE() });
  assert.deepEqual(cli.dump().argv, odd);
});

test('E5 a non-zero exit is a failure with the first stderr line', () => {
  const cli = fakeCli(`process.stderr.write('first line\\nsecond line\\n'); process.exit(4);`);
  const res = runLane(['state', 're-a', 'backlog'], { cli: cli.file, testMode: true, url: SCRATCH, sessionId: 's', base: BASE() });
  assert.equal(res.status, 4);
  assert.equal(res.failure, 'lane.mjs exit 4: first line');
});

test('E5b a timeout is a failure and the status is null', () => {
  const cli = fakeCli(`setTimeout(() => {}, 20000);`);
  const res = runLane(['board'], { cli: cli.file, testMode: true, url: SCRATCH, sessionId: 's', base: BASE(), timeout: 400 });
  assert.equal(res.status, null);
  assert.match(res.failure, /^lane\.mjs timed out after 400 ms/);
});

test('E5c a CLI that cannot start is a failure', () => {
  const res = runLane(['board'], { cli: join(tmpdir(), 'no-such-dir-re', 'lane.mjs'), testMode: true, url: SCRATCH, sessionId: 's', base: BASE() });
  assert.notEqual(res.status, 0);
  assert.equal(typeof res.failure, 'string');
});

test('E6 a url with a password in the CLI stderr is masked in the failure', () => {
  const cli = fakeCli(`process.stderr.write('connect error postgresql://claude:s3cret@localhost:5432/db failed\\n'); process.exit(1);`);
  const res = runLane(['board'], { cli: cli.file, testMode: true, url: SCRATCH, sessionId: 's', base: BASE() });
  assert.equal(res.failure.includes('s3cret'), false);
  assert.match(res.failure, /postgresql:\/\/\*\*\*@localhost:5432\/db failed/);
});

test('E7 laneCliPath: the shim by default; --lane-cli only in test mode; outside test mode it is refused', () => {
  const shim = join(homedir(), '.claude/scripts/lane.mjs');
  assert.equal(laneCliPath({}), shim);
  assert.equal(laneCliPath({ 'test-mode': true }), shim);
  assert.equal(laneCliPath({ 'test-mode': true, 'lane-cli': 'fake/x.mjs' }), resolve('fake/x.mjs'));
  assert.throws(() => laneCliPath({ 'lane-cli': 'fake/x.mjs' }), (e) => e instanceof ExitError && e.exitCode === 3);
  assert.equal(laneCliPath({}, '/h'), join('/h', '.claude/scripts/lane.mjs'));
});
