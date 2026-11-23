// Tests for coord-cap-override PART B (PR B): a one-run CLI cap override that needs Dave's tap.
// Run: node --test scripts/github/cap-override.test.mjs
// Two flags, each lifts ONE limit for ONE run and is never written to config:
//   the USD flag     lifts the daily USD cap (coderabbit.cli_daily_cap_usd) for that run
//   the extra-run flag lifts the per-branch run count (CR_RUN_LIMIT) for that run
// Dave's tap (a ship-ask cap-override question) is bound to branch + head + the exact flag set + the USD value, and is used once.
// No network, no real CodeRabbit run, no real decision store: a temp store, a fake runner and a temp ledger.
//
// How each part can fail, and the test that catches it (written before the code):
//   a bad flag value (text, empty, 0, negative, 3 decimals, trailing zero, =form) starts a run         -> F1..F3
//   a flag in the environment or in the config lifts a cap                                              -> F4
//   the override lowers or ignores the cap, or lifts a cap the config does not have                     -> C1, C2
//   the override is written to the config                                                               -> C3
//   a tap for another head, branch, flag set or value lifts the cap; a tap works twice                  -> T1..T6
//   the USD flag lifts the run count, or the extra-run flag lifts the USD cap                           -> R2, R4
//   the extra run does not start, or the extra run uses a slot of the next run                          -> R1, R5
//   a refused tap still starts the CLI                                                                  -> R3
//   the ledger row of an override run has no capOverride field, or a normal row gets one                -> L1, L2
//   the ship-ask question does not name the flag set, the value, the total, the cap and the files      -> Q1..Q3
//   cr-fix takes the extra-run flag, or the USD flag does not lift its cap                              -> X1, X2
//   the run-count copy in ship-ask counts an extra run                                                  -> Q4
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cliCapOf, recordCliSpend } from './cr-paid.mjs';
import { DECISIONS_ENV, decisionKey, decisionRecord, decisionRead, offerWrite } from './lib/decisions.mjs';
import {
  CAP_KEEP_LABEL, CAP_LIFT_LABEL, capFlagText, capOverrideKey, claimCapOverride, isLiftLabel, takeCapFlags,
} from './lib/cap-override.mjs';
import { crPaths, countedRuns, runCodeRabbit } from './pre-pr.mjs';
import * as FIX from './cr-fix.mjs';
import { capFactsOf, capOverrideSpec, countedRuns as shipCountedRuns, planOf } from './ship-ask.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BASE40 = 'c'.repeat(40);

// ---------- a temp decision store: never Dave's real one ----------
function tempStore() {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'capov-store-')), 'decisions.json');
  process.env[DECISIONS_ENV] = file;
  return file;
}
/** Dave's tap: an open offer, then the decision, for the branch, head and flag set. */
function tap({ branch = 'feat/x', head = HEAD, usd = null, extraRun = false, label = CAP_LIFT_LABEL } = {}) {
  const key = capOverrideKey({ branch, usd, extraRun });
  const spec = capOverrideSpec({ branch, head, usd, extraRun, total: 3, cap: 3, files: 4, estimateUsd: 1 });
  assert.equal(offerWrite({ step: 'cli-skip', key, head, spec }).ok, true);
  assert.equal(decisionRecord({ step: 'cli-skip', key, head, label }).ok, true);
  return key;
}

// ---------- F: the flags ----------

test('F1: takeCapFlags reads the USD flag and the extra-run flag and leaves every other argument alone', () => {
  assert.deepEqual(takeCapFlags(['--body', 'b.md', '--cli-cap-usd', '5', '--cli-extra-run', '--wait-lock']), { usd: 5, extraRun: true, rest: ['--body', 'b.md', '--wait-lock'] });
  assert.deepEqual(takeCapFlags(['--cli-cap-usd', '5.5']), { usd: 5.5, extraRun: false, rest: [] });
  assert.deepEqual(takeCapFlags(['--cli-extra-run']), { usd: null, extraRun: true, rest: [] });
  assert.deepEqual(takeCapFlags(['--body', 'b.md']), { usd: null, extraRun: false, rest: ['--body', 'b.md'] });
});

test('F2: a bad value of the USD flag is an error: missing, text, empty, 0, negative, 3 decimals, a trailing zero, a plus sign, the equals form, a second use', () => {
  for (const argv of [['--cli-cap-usd'], ['--cli-cap-usd', 'abc'], ['--cli-cap-usd', ''], ['--cli-cap-usd', '0'], ['--cli-cap-usd', '-1'], ['--cli-cap-usd', '5.555'], ['--cli-cap-usd', '5.50'], ['--cli-cap-usd', '05'], ['--cli-cap-usd', '+5'], ['--cli-cap-usd', 'NaN'], ['--cli-cap-usd', '1e2'], ['--cli-cap-usd=5'], ['--cli-cap-usd', '5', '--cli-cap-usd', '6'], ['--cli-cap-usd', '--wait-lock']]) {
    const r = takeCapFlags(argv);
    assert.equal(typeof r.error, 'string', JSON.stringify(argv));
    assert.match(r.error, /cli-cap-usd/);
  }
  assert.equal(typeof takeCapFlags(['--cli-extra-run', '--cli-extra-run']).error, 'string', 'a second use of the extra-run flag is an error');
  assert.equal(typeof takeCapFlags(['--cli-extra-run=1']).error, 'string', 'the extra-run flag takes no value');
});

test('F3: the flag set has one canonical text, and the key of a tap carries it', () => {
  assert.equal(capFlagText({ usd: 5, extraRun: true }), 'usd=5,extra');
  assert.equal(capFlagText({ usd: 5.5 }), 'usd=5.5');
  assert.equal(capFlagText({ extraRun: true }), 'extra');
  assert.equal(capFlagText({}), '');
  assert.equal(capOverrideKey({ branch: 'feat/x', usd: 5, extraRun: true }), `${decisionKey({ branch: 'feat/x' })}!cap:usd=5,extra`);
});

test('F4: no environment variable and no config key lifts a cap: the helper reads argv only', () => {
  const env = { CLI_CAP_USD: '99', CLI_EXTRA_RUN: '1', CCV3_CLI_CAP_USD: '99' };
  assert.deepEqual(takeCapFlags([], env), { usd: null, extraRun: false, rest: [] });
  assert.equal(cliCapOf({ coderabbit: { cli_daily_cap_usd: 3, cli_cap_override_usd: 99 } }), 3);
});

// ---------- C: cliCapOf ----------

test('C1: the override is the new cap only when it is above the config cap', () => {
  const config = { coderabbit: { cli_daily_cap_usd: 3 } };
  assert.equal(cliCapOf(config, { override: 6 }), 6);
  assert.equal(cliCapOf(config, { override: 3 }), 3);
  assert.equal(cliCapOf(config, { override: 2 }), 3);
  for (const bad of [NaN, Infinity, '9', -1, 0, null, undefined]) assert.equal(cliCapOf(config, { override: bad }), 3, String(bad));
  assert.equal(cliCapOf(config), 3);
  assert.equal(cliCapOf(config, {}), 3);
});

test('C2: with no cap in the config the override adds none: no cap stays no cap', () => {
  assert.equal(cliCapOf({}, { override: 6 }), null);
  assert.equal(cliCapOf({ coderabbit: {} }, { override: 6 }), null);
});

test('C3: the override never writes the config', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'capov-cfg-')), 'review-router.config.json');
  const text = JSON.stringify({ coderabbit: { cli_daily_cap_usd: 3 } });
  writeFileSync(file, text);
  cliCapOf(JSON.parse(readFileSync(file, 'utf8')), { override: 9 });
  assert.equal(readFileSync(file, 'utf8'), text);
});

// ---------- T: the tap ----------

test('T1: a tap for this branch, head and flag set is claimed once; the second claim is refused', () => {
  tempStore();
  tap({ usd: 6 });
  const first = claimCapOverride({ branch: 'feat/x', head: HEAD, usd: 6, extraRun: false });
  assert.equal(first.ok, true);
  assert.match(String(first.tapAt), /^\d{4}-\d\d-\d\dT/);
  const second = claimCapOverride({ branch: 'feat/x', head: HEAD, usd: 6, extraRun: false });
  assert.equal(second.ok, false);
});

test('T2: a tap for another head is refused', () => {
  tempStore();
  tap({ usd: 6, head: OTHER });
  assert.equal(claimCapOverride({ branch: 'feat/x', head: HEAD, usd: 6, extraRun: false }).ok, false);
});

test('T3: a tap for another branch is refused', () => {
  tempStore();
  tap({ usd: 6, branch: 'feat/y' });
  assert.equal(claimCapOverride({ branch: 'feat/x', head: HEAD, usd: 6, extraRun: false }).ok, false);
});

test('T4: a tap for another flag set is refused: a USD tap does not open the extra-run flag, and the reverse', () => {
  tempStore();
  tap({ usd: 6 });
  assert.equal(claimCapOverride({ branch: 'feat/x', head: HEAD, extraRun: true }).ok, false);
  assert.equal(claimCapOverride({ branch: 'feat/x', head: HEAD, usd: 6, extraRun: true }).ok, false);
  tap({ extraRun: true });
  assert.equal(claimCapOverride({ branch: 'feat/x', head: HEAD, usd: 6, extraRun: true }).ok, false);
});

test('T5: a tap for another USD value is refused: 6 does not open 60 or 600', () => {
  tempStore();
  tap({ usd: 6 });
  for (const usd of [60, 600, 6.5, 5]) assert.equal(claimCapOverride({ branch: 'feat/x', head: HEAD, usd, extraRun: false }).ok, false, String(usd));
});

test('T6: the keep label is a decision that opens nothing', () => {
  tempStore();
  tap({ usd: 6, label: `${CAP_KEEP_LABEL} (Recommended)` });
  assert.equal(claimCapOverride({ branch: 'feat/x', head: HEAD, usd: 6, extraRun: false }).ok, false);
  assert.equal(isLiftLabel(CAP_KEEP_LABEL), false);
  assert.equal(isLiftLabel(CAP_LIFT_LABEL), true);
  assert.equal(isLiftLabel(`${CAP_LIFT_LABEL} (Recommended)`), true);
  assert.equal(isLiftLabel(`${CAP_LIFT_LABEL} now`), false);
});

test('T7: the tap uses the cli-skip store step with its own key: it never opens a flag skip of pre-pr-gate, and a flag skip never opens it', () => {
  tempStore();
  const key = tap({ usd: 6 });
  assert.notEqual(key, decisionKey({ branch: 'feat/x' }));
  assert.equal(decisionRead({ step: 'cli-skip', key: decisionKey({ branch: 'feat/x' }), head: HEAD }), null);
});

test('T8 (CLI finding 2): a tap re-recorded between the read and the use is refused, is not consumed, and no stale time is returned', () => {
  tempStore();
  const key = tap({ usd: 6 });
  const r = claimCapOverride({ branch: 'feat/x', head: HEAD, usd: 6, extraRun: false }, {
    afterRead: () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // a new tap gets a new time
      tap({ usd: 6 });
    },
  });
  assert.equal(r.ok, false, 'the replaced tap was consumed');
  assert.equal(r.tapAt, undefined);
  assert.notEqual(decisionRead({ step: 'cli-skip', key, head: HEAD }), null, 'the new tap is still in the store');
  assert.equal(claimCapOverride({ branch: 'feat/x', head: HEAD, usd: 6, extraRun: false }).ok, true, 'the new tap still opens one run');
});

// ---------- L: the ledger ----------

const USAGE_COST = { files: 4, costCents: 100 };
const ledgerOf = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'capov-ledger-')), 'coderabbit-paid.jsonl');
const rowsOf = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('L1: a billed run that used a flag writes capOverride { usd, extraRun, tapAt }, and the day total still counts the row', () => {
  const ledgerPath = ledgerOf();
  recordCliSpend({ branch: 'feat/x', head: HEAD, usageCost: USAGE_COST, capOverride: { usd: 6, extraRun: true, tapAt: '2026-11-22T23:00:00.000Z' } }, { ledgerPath, now: () => new Date('2026-11-22T23:05:00Z') });
  const [row] = rowsOf(ledgerPath);
  assert.deepEqual(row.capOverride, { usd: 6, extraRun: true, tapAt: '2026-11-22T23:00:00.000Z' });
  assert.equal(row.kind, 'cli');
  assert.equal(row.cost, 1);
});

test('L2: a run with no flag writes the row it always wrote: no capOverride key', () => {
  const ledgerPath = ledgerOf();
  recordCliSpend({ branch: 'feat/x', head: HEAD, usageCost: USAGE_COST }, { ledgerPath, now: () => new Date('2026-11-22T23:05:00Z') });
  assert.equal(Object.hasOwn(rowsOf(ledgerPath)[0], 'capOverride'), false);
});

// ---------- R: the CLI step of pre-pr ----------

const ev = (...objs) => `${objs.map((o) => JSON.stringify(o)).join('\n')}\n`;
const CONTEXT = { type: 'review_context', workingDirectory: '/x', currentBranch: 'feat/x', baseBranch: 'main', expectedDuration: 120 };
const DONE = { type: 'complete', status: 'review_completed', findings: 0, outcome: 'completed' };
const BILLED = { ...DONE, usageCost: { billedFilesCount: 4, costCents: 100, unitPriceCents: 25, billingMethod: 'usage_credits' } };
const USAGE_OK = ev({ type: 'usage', remaining: 5, fullCapacityInMs: 0 });

/** A fixture: a temp root with REVIEW.md, a fake cr runner, a temp ledger and a counter that already holds `runs` counted runs. */
function fixture({ runs = 0, ledgerCost = 0 } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capov-run-'));
  writeFileSync(path.join(root, 'REVIEW.md'), readFileSync(path.join(REPO, 'REVIEW.md'), 'utf8'));
  const calls = [];
  const runner = (o) => {
    if (o.args[0] === 'usage') return { status: 0, stdout: USAGE_OK, stderr: '' };
    calls.push(o);
    return { status: 0, stdout: ev(CONTEXT, BILLED), stderr: '' };
  };
  const ledgerPath = ledgerOf();
  const now = new Date('2026-11-22T20:00:00Z');
  if (ledgerCost > 0) {
    mkdirSync(path.dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, `${JSON.stringify({ ts: now.toISOString(), date: '2026-11-22', kind: 'cli', branch: 'feat/y', head: HEAD, files: 4, cost: ledgerCost, session: 's' })}\n`);
  }
  const counter = crPaths(root, 'feat/x').counter;
  mkdirSync(path.dirname(counter), { recursive: true });
  writeFileSync(counter, JSON.stringify({ branch: 'feat/x', runs: Array.from({ length: runs }, (_, i) => ({ head: String(i + 1).repeat(40), at: `2026-11-22T0${i}:00:00.000Z`, outcome: 'finished', complete: true, newCode: true })) }));
  return { root, calls, runner, ledgerPath, now, counter };
}
const opts = (f, extra = {}) => ({ root: f.root, branch: 'feat/x', head: HEAD, base: 'main', now: f.now, runner: f.runner, ledgerPath: f.ledgerPath, crStore: null, baseCommit: BASE40, guardPaths: ['src/clean.mjs'], cliCapUsd: 3, claimOverride: () => ({ ok: true, tapAt: '2026-11-22T19:00:00.000Z' }), ...extra });
const counterRows = (f) => JSON.parse(readFileSync(f.counter, 'utf8')).runs;

test('R1: with 2 counted runs the extra-run flag lets one run start; without it the step SKIPs cap; the extra row uses no slot', async () => {
  const f = fixture({ runs: 2 });
  const without = await runCodeRabbit(opts(f));
  assert.equal(without.status, 'SKIP');
  assert.equal(without.skipReason, 'cap');
  assert.equal(f.calls.length, 0);
  const withFlag = await runCodeRabbit(opts(f, { capOverride: { usd: null, extraRun: true } }));
  assert.equal(withFlag.status, 'PASS', JSON.stringify(withFlag));
  assert.equal(f.calls.length, 1);
  const rows = counterRows(f);
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1).extraRun, true);
  assert.equal(countedRuns(rows), 2, 'the extra run uses no slot, so the next run without the flag is capped again');
});

test('R2: the USD flag alone does not lift the run count', async () => {
  const f = fixture({ runs: 2 });
  const r = await runCodeRabbit(opts(f, { capOverride: { usd: 6, extraRun: false } }));
  assert.equal(r.status, 'SKIP');
  assert.equal(r.skipReason, 'cap');
  assert.equal(f.calls.length, 0);
});

test('R3: a refused tap starts no CLI, writes no counter row and says why', async () => {
  const f = fixture({ runs: 2 });
  const before = readFileSync(f.counter, 'utf8');
  const r = await runCodeRabbit(opts(f, { capOverride: { usd: null, extraRun: true }, claimOverride: () => ({ ok: false, reason: 'no-decision' }) }));
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /tap|decision/i);
  assert.equal(f.calls.length, 0);
  assert.equal(readFileSync(f.counter, 'utf8'), before);
});

test('R4: the extra-run flag alone does not lift the USD cap', async () => {
  const f = fixture({ runs: 2, ledgerCost: 3 });
  const r = await runCodeRabbit(opts(f, { capOverride: { usd: null, extraRun: true } }));
  assert.equal(r.status, 'SKIP');
  assert.equal(r.skipReason, 'cli-cap');
  assert.equal(f.calls.length, 0);
});

test('R8 (item 6, coord-cap-override-followups): the extra-run flag with the run count below the limit is refused before the tap is claimed, with no CLI and no counter row', async () => {
  for (const capOverride of [{ usd: null, extraRun: true }, { usd: 6, extraRun: true }]) {
    const f = fixture({ runs: 1 });
    const before = readFileSync(f.counter, 'utf8');
    let claimed = 0;
    const r = await runCodeRabbit(opts(f, { capOverride, claimOverride: () => { claimed += 1; return { ok: true, tapAt: 'x' }; } }));
    assert.equal(r.status, 'FAIL', JSON.stringify(capOverride));
    assert.match(r.detail, /run (count|limit)/i);
    assert.match(r.detail, /below|not reached|no need/i);
    assert.equal(claimed, 0, 'the tap stays unused');
    assert.equal(f.calls.length, 0);
    assert.equal(readFileSync(f.counter, 'utf8'), before);
  }
});

test('R5: the USD flag lifts the daily cap for one run, and the billed row carries capOverride', async () => {
  const f = fixture({ runs: 0, ledgerCost: 3 });
  const capped = await runCodeRabbit(opts(f));
  assert.equal(capped.skipReason, 'cli-cap');
  const claims = [];
  const r = await runCodeRabbit(opts(f, { cliCapUsd: 6, capOverride: { usd: 6, extraRun: false }, claimOverride: (a) => { claims.push(a); return { ok: true, tapAt: '2026-11-22T19:00:00.000Z' }; } }));
  assert.equal(r.status, 'PASS', JSON.stringify(r));
  assert.equal(f.calls.length, 1);
  assert.equal(claims.length, 1, 'the tap is claimed once, before the CLI starts');
  assert.deepEqual({ branch: claims[0].branch, head: claims[0].head, usd: claims[0].usd, extraRun: claims[0].extraRun }, { branch: 'feat/x', head: HEAD, usd: 6, extraRun: false });
  const row = rowsOf(f.ledgerPath).at(-1);
  assert.deepEqual(row.capOverride, { usd: 6, extraRun: false, tapAt: '2026-11-22T19:00:00.000Z' });
});

test('R6: a run with no flag claims no tap and writes a row with no capOverride', async () => {
  const f = fixture({ runs: 0 });
  let claimed = 0;
  const r = await runCodeRabbit(opts(f, { claimOverride: () => { claimed += 1; return { ok: true }; } }));
  assert.equal(r.status, 'PASS', JSON.stringify(r));
  assert.equal(claimed, 0);
  assert.equal(Object.hasOwn(rowsOf(f.ledgerPath).at(-1), 'capOverride'), false);
});

test('R7: pre-pr.mjs run from the shell refuses a bad flag value, and a flag with no tap, with exit 1 and no run', () => {
  const store = path.join(mkdtempSync(path.join(os.tmpdir(), 'capov-cli-')), 'decisions.json');
  const env = { ...process.env, [DECISIONS_ENV]: store, RUN_LOCK_DIR: mkdtempSync(path.join(os.tmpdir(), 'capov-lock-')) };
  const run = (...args) => spawnSync(process.execPath, [path.join(HERE, 'pre-pr.mjs'), '--body', path.join(REPO, 'README.md'), ...args], { encoding: 'utf8', env, cwd: REPO, timeout: 60_000 });
  const bad = run('--cli-cap-usd', 'abc');
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /cli-cap-usd/);
  const notap = run('--cli-extra-run');
  assert.equal(notap.status, 1, notap.stderr);
  assert.match(notap.stderr, /tap|ship-ask/i);
  assert.equal(existsSync(store), false, 'a refused flag writes no decision');
});

// ---------- X: cr-fix ----------

test('X1: cr-fix takes the USD flag and refuses the extra-run flag (it has no run counter)', () => {
  assert.deepEqual(FIX.takeFixFlags(['--pr', '5', '--cli-cap-usd', '6']), { usd: 6, rest: ['--pr', '5'] });
  const r = FIX.takeFixFlags(['--pr', '5', '--cli-extra-run']);
  assert.match(String(r.error), /extra-run/);
});

// X2 to X4 (the cr-fix run with the USD flag, the tap, the refusal) live in cr-fix.test.mjs as CF31 to CF34: that file holds the gh harness.

// ---------- J: the line-ends join (the pending join that PART B carries) ----------

test('J1: the checks-tests gate of pre-pr runs the line-ends test', async () => {
  const { gatesFor } = await import('./pre-pr.mjs');
  const g = gatesFor(['scripts/checks/proofs.json'], REPO).find((x) => x.id === 'checks-tests');
  assert.ok(g);
  assert.ok(g.args.includes('scripts/checks/line-ends-lf.test.mjs'), 'line-ends-lf.test.mjs is left out of the checks-tests gate');
  assert.ok(existsSync(path.join(REPO, 'scripts/checks/line-ends-lf.test.mjs')));
});

test('J2: CI runs the line-ends test in the checks step of ccv3-checks.yml', () => {
  const yml = readFileSync(path.join(REPO, '.github', 'workflows', 'ccv3-checks.yml'), 'utf8');
  assert.match(yml, /node --test [^\n]*scripts\/checks\/line-ends-lf\.test\.mjs/);
});

test('J3: the gate-coverage skip list no longer names the line-ends test', () => {
  const skip = JSON.parse(readFileSync(path.join(HERE, 'gate-coverage-skip.json'), 'utf8'));
  const text = JSON.stringify(skip);
  assert.equal(text.includes('"path":"scripts/checks/line-ends-lf.test.mjs"'), false);
  assert.equal((skip.skip ?? skip.skips ?? []).some((e) => e.path === 'scripts/checks/line-ends-lf.test.mjs'), false);
});

test('J4: gate-coverage still reads every test file and finds 0 ungated', () => {
  const r = spawnSync(process.execPath, [path.join(HERE, 'gate-coverage.mjs')], { encoding: 'utf8', cwd: REPO, timeout: 120_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /0 ungated/);
});

// ---------- Q: the ship-ask question ----------

const DATA = { branch: 'feat/x', head: HEAD, usd: 6, extraRun: true, total: 3, cap: 3, files: 16, estimateUsd: 4 };

test('Q1: the question names the branch, the head, the total, the cap, the files, the estimate, the flag set and the USD value', () => {
  const spec = capOverrideSpec(DATA);
  assert.equal(spec.header, 'CLI cap');
  const q = spec.question;
  for (const part of ['feat/x', 'aaaaaaa', '$3.00', '16 files', '$4.00', '--cli-cap-usd 6', '--cli-extra-run']) assert.ok(q.includes(part), `${part} in: ${q}`);
  assert.ok(q.split('\n').length <= 4, 'the question stays short');
});

test('Q2: the first option keeps the cap and spends nothing; the second lifts it with the exact labels', () => {
  const spec = capOverrideSpec(DATA);
  assert.equal(spec.options.length, 2);
  assert.equal(spec.options[0].label, `${CAP_KEEP_LABEL} (Recommended)`);
  assert.equal(spec.options[1].label, CAP_LIFT_LABEL);
});

test('Q3: a USD-only and an extra-run-only question name only their own flag', () => {
  const usdOnly = capOverrideSpec({ ...DATA, extraRun: false }).question;
  assert.ok(usdOnly.includes('--cli-cap-usd 6') && !usdOnly.includes('--cli-extra-run'));
  const extraOnly = capOverrideSpec({ ...DATA, usd: null }).question;
  assert.ok(extraOnly.includes('--cli-extra-run') && !extraOnly.includes('--cli-cap-usd'));
});

test('Q6 (CLI finding 3): an unknown spend, file count or estimate is printed as unknown, never as zero', () => {
  const q = capOverrideSpec({ ...DATA, total: null, files: null, estimateUsd: null }).question;
  assert.match(q, /unknown/);
  assert.equal(q.includes('$0.00'), false, q);
  assert.equal(q.includes('0 files'), false, q);
  const spendOnly = capOverrideSpec({ ...DATA, total: null }).question;
  assert.match(spendOnly, /spend is unknown/);
  assert.ok(spendOnly.includes('16 files'));
  const filesOnly = capOverrideSpec({ ...DATA, files: null, estimateUsd: null }).question;
  assert.match(filesOnly, /unknown files/);
  assert.ok(filesOnly.includes('$3.00'));
});

test('Q7 (CLI finding 3): a real zero stays zero: no spend today, an empty diff', () => {
  const q = capOverrideSpec({ ...DATA, total: 0, files: 0, estimateUsd: 0 }).question;
  assert.ok(q.includes('$0.00'), q);
  assert.ok(q.includes('0 files'), q);
  assert.equal(q.includes('unknown'), false, q);
});

test('Q8 (CLI finding 3): capFactsOf carries null for a failed spend read and a failed diff, and zero for an empty diff', () => {
  assert.deepEqual(capFactsOf({ readTotal: () => { throw new Error('ledger'); }, readNames: () => null }), { total: null, files: null, estimateUsd: null });
  assert.deepEqual(capFactsOf({ readTotal: () => 3, readNames: () => '' }), { total: 3, files: 0, estimateUsd: 0 });
  assert.deepEqual(capFactsOf({ readTotal: () => 0, readNames: () => 'a.mjs\nb.mjs\n' }), { total: 0, files: 2, estimateUsd: 0.5 });
  assert.deepEqual(capFactsOf({ readTotal: () => 'x', readNames: () => { throw new Error('read'); } }), { total: null, files: null, estimateUsd: null }, 'a spend that is not a number is unknown');
});

test('Q4: the run-count copy in ship-ask counts an extra run as no slot, as pre-pr does', () => {
  const rows = [{ at: '2026-11-22T01:00:00Z', newCode: true }, { at: '2026-11-22T02:00:00Z', newCode: true }, { at: '2026-11-22T03:00:00Z', newCode: true, extraRun: true }];
  assert.equal(shipCountedRuns(rows), 2);
  assert.equal(countedRuns(rows), 2);
});

test('Q5: planOf writes the offer for the exact key, branch head and flag set, and refuses a question with no flag', () => {
  const plan = planOf('cap-override', DATA, {});
  assert.equal(plan.key, capOverrideKey({ branch: 'feat/x', usd: 6, extraRun: true }));
  assert.equal(plan.head, HEAD);
  assert.ok(plan.spec.question.includes('--cli-cap-usd 6'));
  assert.match(String(planOf('cap-override', { ...DATA, usd: null, extraRun: false }, {}).refuse), /flag/i);
});
