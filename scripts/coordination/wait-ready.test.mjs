// Tests for wait-ready.mjs (card prepr-speed-bundle, L3): one READY wait for builders (rule V7.12). It polls review-status.mjs <pr> --json and
// prints READY only when review-status exits 0 AND its JSON says ready: true. No test here calls GitHub: the runner, the sleep and the clock are fakes.
// How it can fail, one test each, with the source change that makes it fail:
//   W1  review-status exits 2 (could not determine) and a READY text is printed anyway          (match the text, or ignore the exit code)
//   W2  exit 0 with ready:false ends the wait, or a later ready:true is missed                  (end on exit 0, or on the first poll)
//   W3  a ready PR prints no READY line, or the wrong head, or exits non-zero                   (change the line or the code)
//   W4  a failed check keeps the wait running to the timeout                                    (poll on every exit 1)
//   W5  a check that only runs or waits ends the wait as FAILED                                 (end on every exit 1)
//   W6  JSON that does not parse reads as ready or as not ready                                 (catch the error and go on)
//   W7  no timeout: the wait never ends                                                         (drop the --max test)
//   W8  the command line gives no usage error for a missing or bad PR number                    (no argument test)
//   W9  review-status is called without --json, or without the repo                             (change the argument list)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reviewStatusArgs, waitReady } from './wait-ready.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'wait-ready.mjs');

const json = (over = {}) => JSON.stringify({ pr: 671, headShort: '47aaeab', head: '47aaeab1c88360ef97f93029a900e980efa0a770', ready: false, reasons: [], ...over });
/** A run that answers from a list, one answer per poll. */
const script = (answers) => { const calls = []; const run = () => { calls.push(1); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; return { status: a.status, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }; }; return { run, calls }; };
/** A fake clock that moves only when the wait sleeps. */
const clock = () => { let t = 0; return { sleeps: [], now: () => t, sleep: async function (ms) { this.sleeps.push(ms); t += ms; } }; };
const go = async (answers, over = {}) => {
  const { run, calls } = script(answers);
  const c = clock();
  const out = [];
  const code = await waitReady({ pr: 671, run, sleep: (ms) => c.sleep(ms), now: c.now, out: (l) => out.push(l), intervalMs: 30_000, maxMs: 10 * 60_000, ...over });
  return { code, out, polls: calls.length, sleeps: c.sleeps };
};

test('W1: review-status exit 2 never prints READY, even when its text or JSON says READY', async () => {
  const r = await go([{ status: 2, stdout: json({ ready: true }), stderr: 'READY (but gh failed)' }]);
  assert.equal(r.code, 2);
  assert.equal(r.out.some((l) => /^READY/.test(l)), false, r.out.join('\n'));
  assert.ok(r.out.some((l) => /^ERROR 671/.test(l)), r.out.join('\n'));
  assert.equal(r.polls, 1);
});

test('W2: exit 0 with ready:false keeps polling; a later ready:true ends the wait with READY', async () => {
  const r = await go([{ status: 0, stdout: json({ ready: false }) }, { status: 1, stdout: json({ reasons: ['check "route" is in_progress/null'] }) }, { status: 0, stdout: json({ ready: true }) }]);
  assert.equal(r.code, 0);
  assert.equal(r.polls, 3);
  assert.deepEqual(r.sleeps, [30_000, 30_000], 'a poll every 30 s');
  assert.deepEqual(r.out, ['READY 671 47aaeab']);
});

test('W3: a ready PR prints READY with the 7 or 8 character head of the JSON and exits 0 at the first poll', async () => {
  const r = await go([{ status: 0, stdout: json({ ready: true }) }]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, ['READY 671 47aaeab']);
  assert.equal(r.polls, 1);
  assert.deepEqual(r.sleeps, []);
});

test('W4: a failed check ends the wait at once as FAILED with the reason, exit 1', async () => {
  const r = await go([{ status: 1, stdout: json({ reasons: ['check "ratchets" is completed/failure', 'mergeable_state is "unstable"'] }) }]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, ['FAILED 671 check "ratchets" is completed/failure']);
  assert.equal(r.polls, 1);
});

test('W5: checks that only run or wait (in_progress, queued, a missing review, unstable) keep the wait going', async () => {
  const reasons = ['check "route" is in_progress/null', 'check "semgrep" is queued/null', 'mergeable_state is "unstable"'];
  const r = await go([{ status: 1, stdout: json({ reasons }) }, { status: 1, stdout: json({ reasons }) }, { status: 0, stdout: json({ ready: true }) }]);
  assert.equal(r.code, 0);
  assert.equal(r.polls, 3);
  assert.equal(r.out.some((l) => /^FAILED/.test(l)), false);
});

test('W6: JSON that does not parse ends the wait with exit 2 and an ERROR line, never READY', async () => {
  const r = await go([{ status: 0, stdout: 'PR #671 READY\n' }]);
  assert.equal(r.code, 2);
  assert.equal(r.out.some((l) => /^READY/.test(l)), false);
  assert.ok(r.out.some((l) => /^ERROR 671/.test(l)), r.out.join('\n'));
});

test('W7: no ready PR by the --max time ends the wait with TIMEOUT and exit 3', async () => {
  const r = await go([{ status: 1, stdout: json({ reasons: ['check "route" is in_progress/null'] }) }], { maxMs: 100_000 });
  assert.equal(r.code, 3);
  assert.ok(r.out.some((l) => /^TIMEOUT 671 /.test(l)), r.out.join('\n'));
  assert.ok(r.polls >= 3 && r.polls <= 5, `polls ${r.polls}`);
});

test('W7b: the last sleep is cut to the time left, so the wait never runs past --max (100 s max, 30 s interval: 30, 30, 30, 10)', async () => {
  const r = await go([{ status: 1, stdout: json({ reasons: ['check "route" is in_progress/null'] }) }], { maxMs: 100_000 });
  assert.equal(r.code, 3);
  assert.deepEqual(r.sleeps, [30_000, 30_000, 30_000, 10_000]);
  assert.equal(r.sleeps.reduce((a, b) => a + b, 0), 100_000, 'the total wait is the --max time, not one interval more');
});

test('W8: the command line needs a PR number: none, text, or zero gives a usage error and exit 2', () => {
  for (const args of [[], ['abc'], ['0'], ['671', '--interval', 'x']]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: wait-ready\.mjs/);
  }
});

test('W9: the review-status call is node review-status.mjs <pr> --json, with --repo when given', () => {
  const a = reviewStatusArgs(671);
  assert.ok(/review-status\.mjs$/.test(a[0]), a[0]);
  assert.deepEqual(a.slice(1), ['671', '--json']);
  assert.deepEqual(reviewStatusArgs(671, 'Rev4nchist/Continuous-Claude-v3').slice(1), ['671', '--json', '--repo', 'Rev4nchist/Continuous-Claude-v3']);
});
