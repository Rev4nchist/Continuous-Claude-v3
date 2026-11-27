/**
 * wait-ci.test.mjs -- card coord-ci-green-wake.
 *
 * `node scripts/github/wait-ci.mjs <pr> [--timeout N] [--repo owner/name]` polls `review-status.mjs <pr> --json` and ends when the PR is
 * READY (exit 0), a check failed (exit 1, named), the time limit passed (exit 75), or the read broke 3 times in a row (exit 2).
 * It never defines READY itself: review-status does, the same reader land-pr.ps1 trusts.
 *
 * Rows run the real wait-ci.mjs as a child process. A fake review-status script (a node file in a temp folder) answers from a sequence file,
 * so no test calls GitHub. The fake path and the short poll step are read only when WAIT_CI_ALLOW_ENV is exactly "1".
 *
 *   C1  READY on the first poll                          -> exit 0, one line on stdout naming the PR and the head
 *   C2  not ready, then ready                            -> exit 0 after the second poll; the child got the PR number and --json
 *   C3  a failed check                                   -> exit 1, the check name and the head on stdout
 *   C4  the time limit                                   -> exit 75, nothing on stdout, one line on stderr
 *   C5  not ready for a reason that is not CI            -> keeps waiting; never exit 0 (open thread, proof)
 *   C6  a new head during the wait                       -> the new head is named on stderr; the old READY is not assumed
 *   C7  the read breaks 3 times in a row                 -> exit 2 and the error text; 2 errors then a good read keeps going
 *   C8  bad flags                                        -> exit 2 before the child runs
 *   C9  the test env is ignored without WAIT_CI_ALLOW_ENV -> stepMs() and reviewStatusPath() give the real values
 *   C10 pure core                                        -> classify() maps a child answer to ready, failed, wait or error
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WAIT_CI = path.join(HERE, 'wait-ci.mjs');
let tmp;
let fake;

const FAKE_SRC = `
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.FAKE_DIR;
const calls = path.join(dir, 'calls.txt');
const n = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(calls, process.argv.slice(2).join(' ') + '\\n');
const lines = fs.readFileSync(path.join(dir, 'seq.txt'), 'utf8').split('\\n').filter(Boolean);
const row = lines[Math.min(n, lines.length - 1)];
const tab = row.indexOf('\\t');
const code = Number(row.slice(0, tab));
const body = row.slice(tab + 1);
if (code === 2) { console.error(body); process.exit(2); }
console.log(body);
process.exit(code);
`;

const result = (o = {}) => JSON.stringify({ pr: 9, head: `${o.head ?? 'aaaaaaa'}0000000000000000000000000000000`.slice(0, 40), headShort: o.head ?? 'aaaaaaa', ready: !!o.ready, reasons: o.reasons ?? [], mergeable_state: 'clean' });
const seqRow = (code, o) => `${code}\t${code === 2 ? o : result(o)}`;

function newCase(rows) {
  const dir = fs.mkdtempSync(path.join(tmp, 'case-'));
  fs.writeFileSync(path.join(dir, 'seq.txt'), `${rows.join('\n')}\n`);
  return dir;
}
const callsOf = (dir) => (fs.existsSync(path.join(dir, 'calls.txt')) ? fs.readFileSync(path.join(dir, 'calls.txt'), 'utf8').split('\n').filter(Boolean) : []);

function run(dir, argv, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WAIT_CI, ...argv], {
      env: { ...process.env, WAIT_CI_ALLOW_ENV: '1', WAIT_CI_REVIEW_STATUS: fake, WAIT_CI_POLL_MS: '200', FAKE_DIR: dir, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

before(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wait-ci-')));
  fake = path.join(tmp, 'fake-review-status.mjs');
  fs.writeFileSync(fake, FAKE_SRC);
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('wait-ci: what ends the wait', () => {
  it('C1: READY on the first poll gives exit 0 and one line', async () => {
    const dir = newCase([seqRow(0, { ready: true, head: 'abc1234' })]);
    const r = await run(dir, ['9', '--timeout', '5']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), 'wait-ci: PR 9 READY at abc1234');
    assert.equal(callsOf(dir).length, 1);
  });

  it('C2: not ready, then ready: exit 0 after the second poll; the child gets the PR and --json', async () => {
    const dir = newCase([seqRow(1, { reasons: ['check "ci" is in_progress/null'] }), seqRow(0, { ready: true })]);
    const r = await run(dir, ['9', '--timeout', '5']);
    assert.equal(r.code, 0, r.err);
    const calls = callsOf(dir);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /^9\b.*--json/);
  });

  it('C3: a failed check gives exit 1 and names the check and the head', async () => {
    const dir = newCase([seqRow(1, { head: 'bad9999', reasons: ['check "gate-x" is completed/failure', '1 unresolved thread'] })]);
    const r = await run(dir, ['9', '--timeout', '5']);
    assert.equal(r.code, 1, r.err);
    assert.equal(r.out.trim(), 'wait-ci: PR 9 FAILED check "gate-x" at bad9999');
  });

  it('C3b: a cancelled or timed-out check also counts as failed; a pending one does not', async () => {
    for (const state of ['cancelled', 'timed_out', 'action_required']) {
      const dir = newCase([seqRow(1, { reasons: [`check "slow" is completed/${state}`] })]);
      const r = await run(dir, ['9', '--timeout', '5']);
      assert.equal(r.code, 1, `${state}: ${r.err}`);
    }
    const dir = newCase([seqRow(1, { reasons: ['check "slow" is queued/null'] })]);
    const r = await run(dir, ['9', '--timeout', '1']);
    assert.equal(r.code, 75, 'a queued check keeps waiting');
  });

  it('C4: the time limit gives exit 75, nothing on stdout, one line on stderr', async () => {
    const dir = newCase([seqRow(1, { reasons: ['check "ci" is in_progress/null'] })]);
    const t0 = Date.now();
    const r = await run(dir, ['9', '--timeout', '1']);
    assert.equal(r.code, 75);
    assert.equal(r.out, '');
    assert.equal(r.err.trim().split('\n').filter((l) => l.startsWith('wait-ci:')).length >= 1, true);
    assert.match(r.err, /no READY in 1 s/);
    assert.ok(Date.now() - t0 >= 900, 'it waited the limit');
    assert.ok(callsOf(dir).length >= 3, 'polled at once, every step, and once at the limit');
  });

  it('C5: not ready for a reason that is not CI keeps waiting and never exits 0', async () => {
    const dir = newCase([seqRow(1, { reasons: ['1 unresolved review thread', 'proof: no GREEN line for the head'] })]);
    const r = await run(dir, ['9', '--timeout', '1']);
    assert.equal(r.code, 75);
    assert.equal(r.out, '');
  });

  it('C6: a new head during the wait is named on stderr and the wait goes on', async () => {
    const dir = newCase([seqRow(1, { head: 'aaaaaaa', reasons: ['check "ci" is in_progress/null'] }), seqRow(1, { head: 'bbbbbbb', reasons: ['check "ci" is in_progress/null'] }), seqRow(0, { ready: true, head: 'bbbbbbb' })]);
    const r = await run(dir, ['9', '--timeout', '5']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /new head bbbbbbb/);
    assert.equal(r.out.trim(), 'wait-ci: PR 9 READY at bbbbbbb');
  });
});

describe('wait-ci: errors and flags', () => {
  it('C7: 3 broken reads in a row give exit 2 with the error text', async () => {
    const dir = newCase([seqRow(2, 'review-status: could not determine (HTTP 502 from gh)')]);
    const r = await run(dir, ['9', '--timeout', '30']);
    assert.equal(r.code, 2);
    assert.match(r.err, /HTTP 502 from gh/);
    assert.equal(callsOf(dir).length, 3, 'stops at the third error');
  });

  it('C7b: two errors and then a good read keep the wait going (the count resets)', async () => {
    const dir = newCase([seqRow(2, 'boom'), seqRow(2, 'boom'), seqRow(1, { reasons: ['check "ci" is in_progress/null'] }), seqRow(2, 'boom'), seqRow(2, 'boom'), seqRow(0, { ready: true })]);
    const r = await run(dir, ['9', '--timeout', '30']);
    assert.equal(r.code, 0, r.err);
  });

  it('C8: bad flags give exit 2 before the child runs', async () => {
    const bad = [[], ['abc'], ['9', '--timeout', '0'], ['9', '--timeout', '7201'], ['9', '--timeout', 'x'], ['9', '--timeout=5'], ['9', '--timeout'], ['9', '--repo']];
    for (const argv of bad) {
      const dir = newCase([seqRow(0, { ready: true })]);
      const r = await run(dir, argv);
      assert.equal(r.code, 2, `argv ${JSON.stringify(argv)}: ${r.err}`);
      assert.equal(callsOf(dir).length, 0, `argv ${JSON.stringify(argv)} must not run the child`);
      assert.equal(r.out, '');
    }
  });

  it('C9: the test env is ignored unless WAIT_CI_ALLOW_ENV is exactly "1"', async () => {
    const m = await import(pathToFileURL(WAIT_CI).href);
    assert.equal(m.stepMs({ WAIT_CI_POLL_MS: '200' }), 60000);
    assert.equal(m.stepMs({ WAIT_CI_POLL_MS: '200', WAIT_CI_ALLOW_ENV: 'true' }), 60000);
    assert.equal(m.stepMs({ WAIT_CI_POLL_MS: '200', WAIT_CI_ALLOW_ENV: '1' }), 200);
    assert.equal(m.stepMs({ WAIT_CI_POLL_MS: '0', WAIT_CI_ALLOW_ENV: '1' }), 60000);
    assert.equal(m.stepMs({ WAIT_CI_POLL_MS: '200.5', WAIT_CI_ALLOW_ENV: '1' }), 60000);
    assert.match(m.reviewStatusPath({ WAIT_CI_REVIEW_STATUS: '/x/y.mjs' }), /review-status\.mjs$/);
    assert.equal(m.reviewStatusPath({ WAIT_CI_REVIEW_STATUS: '/x/y.mjs', WAIT_CI_ALLOW_ENV: '1' }), '/x/y.mjs');
  });
});

describe('wait-ci: the pure core', () => {
  it('C10: classify maps one child answer to ready, failed, wait or error', async () => {
    const { classify } = await import(pathToFileURL(WAIT_CI).href);
    assert.deepEqual(classify({ code: 0, json: { ready: true, headShort: 'h1' } }), { kind: 'ready', head: 'h1' });
    assert.deepEqual(classify({ code: 1, json: { ready: false, headShort: 'h2', reasons: ['check "a" is completed/failure'] } }), { kind: 'failed', head: 'h2', check: 'a' });
    assert.deepEqual(classify({ code: 1, json: { ready: false, headShort: 'h3', reasons: ['check "a" is in_progress/null'] } }), { kind: 'wait', head: 'h3' });
    assert.equal(classify({ code: 2, stderr: 'x' }).kind, 'error');
    assert.equal(classify({ code: 0, json: null, stderr: '' }).kind, 'error', 'exit 0 with no JSON is not READY');
    assert.equal(classify({ code: 0, json: { ready: false, headShort: 'h' } }).kind, 'error', 'exit 0 but ready false is not READY');
    assert.equal(classify({ code: 7, json: {}, stderr: '' }).kind, 'error', 'an unknown exit code is an error, never wait');
    assert.equal(classify({ code: 1, json: { ready: true, headShort: 'h' } }).kind, 'error', 'exit 1 with ready true contradicts itself: an error, never wait');
    assert.equal(classify({ code: 1, json: { ready: false, headShort: 'h4', reasons: ['check "a" is queued/null'] } }).kind, 'wait', 'a queued check is not a failure');
  });

  it('C11: the loop polls at 0, every step and once at the limit, and sleeps only what is left', async () => {
    const { waitForReady } = await import(pathToFileURL(WAIT_CI).href);
    let t = 0;
    const sleeps = [];
    let polls = 0;
    const r = await waitForReady({
      pr: 9,
      timeoutS: 1,
      step: 400,
      poll: () => { polls += 1; return { code: 1, json: { ready: false, headShort: 'h', reasons: [] } }; },
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
      now: () => t,
    });
    assert.equal(r.exit, 75);
    assert.deepEqual(sleeps, [400, 400, 200], 'the last sleep is cut to the time left');
    assert.equal(polls, 4, 'polls at 0, 400, 800 and once at the limit 1000');
  });
});
