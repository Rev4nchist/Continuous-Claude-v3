// Ways the cost reconcile check can fail. One test per way. Tests use a tiny fake projects and state folder in a temp dir.
// They never read the real ~/.claude, never write outside the temp dir, and import the real functions.
//
// PRICE CHECK (ledger tokens x prices.json vs ledger costUSD)
// R1  a complete non-Haiku row that is right passes, one that is off by 0.02% fails (gate 0.01%)
// R2  the cache write the 5m and 1h parts leave out is priced at 5m (not 1h)
// R3  a no-split row (no 5m/1h keys) fails the gate by mistake, or is not labelled "repaired, residual N%"
// R4  a Haiku row with cache tokens fails the gate (it must only be reported), or a Haiku row without cache tokens fails (it may only warn)
// R5  a model id that is not in prices.json passes, or <synthetic> fails
// R6  a row under one cent is checked (relative error is noise), or hides an unknown id
// R7  a fast or non-global transcript record gives no "rule unproven" warning; a standard one gives a false warning
// R8  a ledger row billed at fast or US-geo rates fails the 0.01% gate (it must warn, exit 10, and leave the complete count); a standard row still counts
// R9  a Haiku cache row or a no-split row gives no finding line with its own code (haiku-cache-row, no-split-row)
// PRICING UNITS
// U1  Haiku 5.5 reads the over-100K rates at 100,001 prompt tokens, and the low rates at 100,000
// U2  an advisor iteration is priced at its own model; the top-level usage is not charged twice
// U3  web search costs $0.01 per request
// TRANSCRIPT FOLD
// T1  the same message.id in two files is counted once
// T2  a record before the earliest ledger startTime is counted (no slice)
// T3  a ledger group that is not the last row of its startTime is summed, or two groups are not summed
// CLEAN AND STATS
// C1  a session is clean with one group, not resumed and total >= $1; each of the three conditions alone makes it not clean
// S1  median and p95abs use linear interpolation (the research script does)
// BANDS
// B1  warm-up: fewer than 20 window sessions never warns or fails
// B2  |median| > 3.27 warns; |median| > 4.27 on ONE run warns, on TWO consecutive runs fails; a run in between that is fine resets
// B3  a median closer to 0 than the baseline never warns or fails (fail high only)
// B4  a second run on the same day counts as a second consecutive run
// B5  one clean session over 8.48% is info, over 15% is warn, and nothing is ever a single-session fail
// B6  the window drops a session before the baseline cut-off, keeps a session once, orders by first timestamp, keeps the newest 20
// B8  a night over the same window as the last night does not count as a second consecutive run; new evidence does
// B7  the replay of baseline-like noise gives 0 warns and 0 fails; a shifted series fails
// END TO END (reconcile() on the fake folders)
// E1  the fake projects folder is unchanged after a run (read-only), and --no-run-state writes no state
// E2  the run-state file is written at the override path, a second run adds no session twice, an active session is held back
// E3  --out outside the e2e folder exits 2; --out inside it holds the same lines
// E4  an unknown id in the ledger exits 1; a clean run exits 0
// E6  warn exits 10, a fail exits 1 beside a warn, a clean run exits 0
// E7  two nights over the same window: warn, not fail
// V1  an empty state folder, or transcripts that are all missing, exits 2 (a vacuous pass); a quiet day (no session in the window) exits 0
// E5  the per-model residual of the fake clean session equals the hand-made value
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkPriceRow, evaluateBands, foldTranscripts, groupLedger, isClean, ledgerModelRows, loadPrices, median, priceCounts, priceStep,
  priceUsage, quantile, replayBands, singleSessionLevel, stat, updateWindow, windowSig,
} from './cost-reconcile-lib.mjs';
import { reconcile } from './cost-reconcile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CLI = join(HERE, 'cost-reconcile.mjs');
const PRICES_PATH = join(REPO, '.claude', 'plugins', 'ccv3-mods', 'hooks', 'shared', 'prices.json');
const BASELINE_PATH = join(HERE, 'capture-baseline.json');
const prices = loadPrices(PRICES_PATH);
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const closeTo = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

// ---- builders -------------------------------------------------------------------------------------------------------
const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const usage = ({ i = 0, o = 0, cr = 0, w5 = 0, w1 = 0, rem = 0, ws = 0, speed = 'standard', geo = 'global', iterations } = {}) => ({
  input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: w5 + w1 + rem,
  cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, server_tool_use: { web_search_requests: ws },
  speed, inference_geo: geo, ...(iterations ? { iterations } : {}),
});
const asst = (id, model, u, ms) => ({ type: 'assistant', timestamp: iso(ms), message: { id, model, usage: u } });
const mu = ({ i = 0, o = 0, cr = 0, w5 = 0, w1 = 0, rem = 0, ws = 0, cost, split = true }) => ({
  inputTokens: i, outputTokens: o, thinkingTokens: 0, cacheReadInputTokens: cr, cacheCreationInputTokens: w5 + w1 + rem,
  ...(split ? { cacheCreationEphemeral5mInputTokens: w5, cacheCreationEphemeral1hInputTokens: w1 } : {}), webSearchRequests: ws, costUSD: cost,
});
const costState = (sessionId, startTime, total, modelUsage) => ({ type: 'cost-state', sessionId, totalCostUSD: total, startTime, modelUsage, hasUnknownModelCost: false });

// A request that costs 1.352 on Sonnet 5.5: (1000*2 + 20000*10 + 1e6*0.1 + 100000*2.5 + 200000*4) / 1e6.
const BIG = { i: 1000, o: 20000, cr: 1_000_000, w5: 100_000, w1: 200_000 };
const BIG_USD = 1.352;
// The ledger holds 5000 more output tokens than the transcript: 1.352 + 0.05 = 1.402, residual (1.352 - 1.402) / 1.402.
const LEDGER_OUT = 25000;
const LEDGER_USD = 1.402;
const BIG_RESIDUAL = ((BIG_USD - LEDGER_USD) / LEDGER_USD) * 100;

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3 }); });

function writeJsonl(file, records) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** sessions: [{ sid, main: [records], ledger: [cost-state records], agents: {name: [records]}, resumed, ageMin }] */
function makeEnv(sessions) {
  const root = mkdtempSync(join(tmpdir(), 'ccv3-cost-reconcile-'));
  roots.push(root);
  const env = { root, projects: join(root, 'projects'), state: join(root, 'state'), e2e: join(root, 'e2e'), runState: join(root, 'cache', 'run-state.json') };
  mkdirSync(env.state, { recursive: true });
  mkdirSync(env.e2e, { recursive: true });
  for (const s of sessions) {
    const main = join(env.projects, 'proj', `${s.sid}.jsonl`);
    writeJsonl(main, [...(s.main ?? []), ...(s.ledger ?? [])]);
    for (const [name, records] of Object.entries(s.agents ?? {})) writeJsonl(join(env.projects, 'proj', s.sid, 'subagents', `agent-${name}.jsonl`), records);
    writeFileSync(join(env.state, `${s.sid}.json`), JSON.stringify({ sessionId: s.sid, cache: { resumed: s.resumed ?? false } }));
    const old = new Date(Date.now() - (s.ageMin ?? 240) * 60_000);
    utimesSync(main, old, old);
  }
  return env;
}
const opts = (env, extra = {}) => ({ projects: env.projects, state: env.state, prices: PRICES_PATH, baseline: BASELINE_PATH, runState: null, e2eDir: env.e2e, now: new Date(), minIdleMin: 30, ...extra });
const kinds = (lines, kind) => lines.filter((l) => l.kind === kind);
const SID = (n) => `${String(n).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;
const cleanSession = (n, extra = {}) => ({
  sid: SID(n),
  main: [asst(`m${n}`, 'claude-sonnet-5-5', usage(BIG), T0 + 1000)],
  ledger: [costState(SID(n), T0, LEDGER_USD, { 'claude-sonnet-5-5': mu({ ...BIG, o: LEDGER_OUT, cost: LEDGER_USD }) })],
  ...extra,
});

// ---- PRICE CHECK ----------------------------------------------------------------------------------------------------
const lrow = (counts, cost, split = true) => ({ startTime: T0, model: 'claude-sonnet-5-5', counts, hasSplit: split, costUSD: cost });
const SONNET = { in: 1000, out: 2000, cr: 100000, cw5: 10000, cw1h: 20000, cw: 30000, ws: 0 };

test('R1 a complete non-Haiku row passes at 0.000% and fails above 0.01%', () => {
  const ok = checkPriceRow(prices, lrow(SONNET, 0.137), {});
  assert.equal(ok.status, 'pass');
  closeTo(ok.residualPct, 0, 1e-9);
  assert.equal(checkPriceRow(prices, lrow(SONNET, 0.137 * 1.00005), {}).status, 'pass');
  const bad = checkPriceRow(prices, lrow(SONNET, 0.137 / 1.0002), {});
  assert.equal(bad.status, 'fail');
  assert.equal(bad.code, 'price-mismatch');
});

test('R2 the write the 5m and 1h parts leave out is priced at 5m', () => {
  const counts = { ...SONNET, cw: 40000 }; // 10000 remainder
  assert.equal(checkPriceRow(prices, lrow(counts, 0.162), {}).status, 'pass'); // 0.137 + 10000 * 2.5 / 1e6
  assert.equal(checkPriceRow(prices, lrow(counts, 0.177), {}).status, 'fail'); // the 1h price of the same remainder
});

test('R3 a no-split row is repaired with the transcript 1h share, labelled, and never fails the gate', () => {
  const counts = { ...SONNET, cw5: 0, cw1h: 0 }; // 30000 written, no split keys
  // 1/3 of the writes at 1h: 20000 at 5m, 10000 at 1h = 0.002+0.02+0.01+0.05+0.04 = 0.122
  const exact = checkPriceRow(prices, lrow(counts, 0.122, false), { share1h: 1 / 3 });
  assert.equal(exact.status, 'repaired');
  closeTo(exact.residualPct, 0, 1e-6);
  assert.match(exact.note, /^repaired, residual 0\.00%/);
  const off = checkPriceRow(prices, lrow(counts, 0.122 / 1.0127, false), { share1h: 1 / 3 });
  assert.equal(off.status, 'repaired');
  assert.match(off.note, /^repaired, residual 1\.27%/);
  assert.ok(off.allFivePct < off.residualPct, 'the all-5m bound is reported beside it');
});

test('R4 a Haiku row with cache tokens is reported only; one without may warn, never fail', () => {
  const haiku = (counts, cost) => ({ startTime: T0, model: 'claude-haiku-5-5', counts, hasSplit: true, costUSD: cost });
  const cache = { in: 1000, out: 1000, cr: 1_000_000, cw5: 0, cw1h: 0, cw: 0, ws: 0 };
  const r = checkPriceRow(prices, haiku(cache, 0.5), {}); // the low-tier cost is 0.0106, so the ledger 0.5 is far off
  assert.equal(r.status, 'reported');
  assert.ok(Math.abs(r.residualPct) > 90);
  assert.equal(typeof r.highTierResidualPct, 'number');
  const plain = { in: 100000, out: 10000, cr: 0, cw5: 0, cw1h: 0, cw: 0, ws: 3 };
  closeTo(checkPriceRow(prices, haiku(plain, 0.045), {}).residualPct, 0, 1e-9); // 100000*0.1 + 10000*0.5 = 0.015, plus 3 searches * 0.01
  assert.equal(checkPriceRow(prices, haiku(plain, 0.9), {}).status, 'warn');
});

test('R5 an id that is not in prices.json fails; <synthetic> does not', () => {
  const unknown = checkPriceRow(prices, { ...lrow(SONNET, 0.137), model: 'claude-sonnet-9-9' }, {});
  assert.equal(unknown.status, 'fail');
  assert.equal(unknown.code, 'unknown-model');
  const syn = checkPriceRow(prices, { ...lrow({ in: 0, out: 0, cr: 0, cw5: 0, cw1h: 0, cw: 0, ws: 0 }, 0), model: '<synthetic>' }, {});
  assert.notEqual(syn.status, 'fail');
});

test('R6 a row under one cent is skipped, but an unknown id under one cent still fails', () => {
  assert.equal(checkPriceRow(prices, lrow({ ...SONNET, out: 3 }, 0.004), {}).status, 'skip-small');
  assert.equal(checkPriceRow(prices, { ...lrow(SONNET, 0.004), model: 'claude-nope-1' }, {}).status, 'fail');
});

test('R7 fast and non-global records give a "rule unproven" finding, standard ones none', () => {
  const env = makeEnv([
    { ...cleanSession(1), main: [asst('f1', 'claude-sonnet-5-5', usage({ ...BIG, speed: 'fast' }), T0 + 1000)] },
    { ...cleanSession(2), main: [asst('g1', 'claude-sonnet-5-5', usage({ ...BIG, geo: 'us' }), T0 + 1000)] },
    cleanSession(3),
  ]);
  const { lines } = reconcile(opts(env));
  const unproven = kinds(lines, 'finding').filter((f) => f.code === 'rule-unproven');
  assert.deepEqual(unproven.map((f) => [f.sid, f.level]).sort(), [['00000001', 'warn'], ['00000002', 'warn']]);
});

// A ledger row billed at fast or US-geo rates cannot pass the 0.01% gate: the row holds no fast or geo split (method 6.2).
// Opus 5.5: standard BIG = 2.704, fast (8 / 40 per M, writes and cache read at the same 2x) = 5.408, US geo = 2.704 * 1.1 = 2.9744.
const opusSession = (n, { speed, geo, cost }) => ({
  sid: SID(n),
  main: [asst(`o${n}`, 'claude-opus-5-5', usage({ ...BIG, speed, geo }), T0 + 1000)],
  ledger: [costState(SID(n), T0, cost, { 'claude-opus-5-5': mu({ ...BIG, cost }) })],
});

test('R8 a ledger row billed at fast or US-geo rates warns, exits 10 and leaves the complete count; a standard row still counts', () => {
  const env = makeEnv([
    opusSession(1, { speed: 'fast', cost: 5.408 }),
    opusSession(2, { geo: 'us', cost: 2.9744 }),
    opusSession(3, { cost: 2.704 }),
  ]);
  const { lines, exitCode } = reconcile(opts(env));
  const findings = kinds(lines, 'finding');
  assert.deepEqual(findings.filter((f) => f.level === 'fail'), []);
  assert.deepEqual(findings.filter((f) => f.code === 'rule-unproven').map((f) => [f.sid, f.level]).sort(), [['00000001', 'warn'], ['00000002', 'warn']]);
  assert.equal(exitCode, 10);
  const summary = kinds(lines, 'summary')[0];
  assert.equal(summary.priceCheck.complete.n, 1);
  assert.equal(summary.priceCheck.complete.failed, 0);
  assert.equal(summary.priceCheck.unproven.n, 2);
  assert.equal(summary.status, 'warn');
});

test('R8b a standard session with a wrong ledger price still fails beside the unproven ones', () => {
  const env = makeEnv([opusSession(1, { speed: 'fast', cost: 5.408 }), opusSession(2, { cost: 2.0 })]);
  const { lines, exitCode } = reconcile(opts(env));
  assert.equal(exitCode, 1);
  assert.deepEqual(kinds(lines, 'finding').filter((f) => f.level === 'fail').map((f) => [f.sid, f.code]), [['00000002', 'price-mismatch']]);
});

test('R9 a Haiku row with cache tokens gives a haiku-cache-row info finding; a no-split row gives a no-split-row info finding', () => {
  const haiku = cleanSession(1);
  haiku.ledger = [costState(SID(1), T0, LEDGER_USD + 0.5, {
    'claude-sonnet-5-5': mu({ ...BIG, o: LEDGER_OUT, cost: LEDGER_USD }),
    'claude-haiku-5-5': mu({ i: 1000, o: 1000, cr: 1_000_000, cost: 0.5 }),
  })];
  const nosplit = cleanSession(2);
  nosplit.ledger = [costState(SID(2), T0, LEDGER_USD, { 'claude-sonnet-5-5': mu({ ...BIG, o: LEDGER_OUT, cost: LEDGER_USD, split: false }) })];
  const env = makeEnv([haiku, nosplit]);
  const { lines, exitCode } = reconcile(opts(env));
  const f = kinds(lines, 'finding');
  assert.deepEqual(f.filter((x) => x.code === 'haiku-cache-row').map((x) => [x.sid, x.level]), [['00000001', 'info']]);
  assert.deepEqual(f.filter((x) => x.code === 'no-split-row').map((x) => [x.sid, x.level]), [['00000002', 'info']]);
  assert.equal(f.filter((x) => x.level === 'fail').length, 0);
  assert.notEqual(exitCode, 1);
});

// ---- PRICING UNITS --------------------------------------------------------------------------------------------------
test('U1 Haiku 5.5 uses the over-100K rates above 100,000 prompt tokens only', () => {
  const at = priceUsage(prices, usage({ i: 100_000, o: 1000 }), 'claude-haiku-5-5');
  const over = priceUsage(prices, usage({ i: 100_001, o: 1000 }), 'claude-haiku-5-5');
  closeTo(at, (100_000 * 0.1 + 1000 * 0.5) / 1e6);
  closeTo(over, (100_001 * 0.5 + 1000 * 2.5) / 1e6);
});

test('U2 an advisor iteration is priced at its own model and the top level is not charged twice', () => {
  const u = usage({ i: 10, o: 100, iterations: [
    { type: 'message', input_tokens: 10, output_tokens: 100 },
    { type: 'advisor_message', model: 'claude-fable-5-1', input_tokens: 1000, output_tokens: 200 },
  ] });
  const step = priceStep(prices, u, 'claude-sonnet-5-5');
  closeTo(step.usd, (10 * 2 + 100 * 10) / 1e6 + (1000 * 10 + 200 * 50) / 1e6);
  assert.equal(step.unknown, false);
});

test('U3 web search costs 0.01 dollars per request', () => {
  closeTo(priceUsage(prices, usage({ ws: 3 }), 'claude-haiku-5-5'), 0.03);
});

test('U4 priceCounts prices an aggregate row with the high Haiku tier when asked', () => {
  const c = { in: 1000, out: 0, cr: 0, cw5: 0, cw1h: 0, cw: 0, ws: 0 };
  closeTo(priceCounts(prices, 'claude-haiku-5-5', c, {}), 0.0001);
  closeTo(priceCounts(prices, 'claude-haiku-5-5', c, { tier: 'high' }), 0.0005);
  assert.equal(priceCounts(prices, 'claude-unknown-1', c, {}), null);
});

// ---- TRANSCRIPT FOLD ------------------------------------------------------------------------------------------------
test('T1 the same message.id in the main file and a subagent file is counted once', () => {
  const env = makeEnv([{ sid: SID(1), main: [asst('dup', 'claude-sonnet-5-5', usage(BIG), T0 + 1000)], agents: { a: [asst('dup', 'claude-sonnet-5-5', usage(BIG), T0 + 1000), asst('own', 'claude-sonnet-5-5', usage({ o: 1000 }), T0 + 2000)] } }]);
  const main = join(env.projects, 'proj', `${SID(1)}.jsonl`);
  const agent = join(env.projects, 'proj', SID(1), 'subagents', 'agent-a.jsonl');
  const fold = foldTranscripts(prices, [main, agent], { minMs: 0 });
  assert.equal(fold.models['claude-sonnet-5-5'].c.n, 2);
  closeTo(fold.models['claude-sonnet-5-5'].usd, BIG_USD + 0.01);
});

test('T2 records before the earliest ledger startTime are dropped (resumed session slice)', () => {
  const env = makeEnv([{ sid: SID(1), main: [asst('old', 'claude-sonnet-5-5', usage(BIG), T0 - 5000), asst('new', 'claude-sonnet-5-5', usage({ o: 1000 }), T0 + 5000)] }]);
  const main = join(env.projects, 'proj', `${SID(1)}.jsonl`);
  const fold = foldTranscripts(prices, [main], { minMs: T0 });
  assert.equal(fold.models['claude-sonnet-5-5'].c.n, 1);
  closeTo(fold.models['claude-sonnet-5-5'].usd, 0.01);
  assert.equal(fold.firstTs, iso(T0 + 5000));
});

test('T3 the last row of each startTime is kept and the groups are summed', () => {
  const a1 = costState('s', T0, 1, { m: { costUSD: 1 } });
  const a2 = costState('s', T0, 2, { m: { costUSD: 2 } });
  const b1 = costState('s', T0 + 9000, 5, { m: { costUSD: 5 } });
  const groups = groupLedger([a1, b1, a2]);
  assert.deepEqual(groups.map((g) => [g.startTime, g.row.totalCostUSD]), [[T0, 2], [T0 + 9000, 5]]);
  const rows = ledgerModelRows(groups);
  assert.deepEqual(rows.map((r) => [r.startTime, r.model, r.costUSD]), [[T0, 'm', 2], [T0 + 9000, 'm', 5]]);
});

// ---- CLEAN AND STATS ------------------------------------------------------------------------------------------------
test('C1 clean needs one group, not resumed, and a total of at least 1 dollar', () => {
  assert.equal(isClean({ groups: 1, resumed: false, totalUsd: 1 }), true);
  assert.equal(isClean({ groups: 1, resumed: undefined, totalUsd: 1.5 }), true);
  assert.equal(isClean({ groups: 2, resumed: false, totalUsd: 5 }), false);
  assert.equal(isClean({ groups: 1, resumed: true, totalUsd: 5 }), false);
  assert.equal(isClean({ groups: 1, resumed: false, totalUsd: 0.99 }), false);
});

test('S1 median and p95abs use linear interpolation', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  const xs = Array.from({ length: 21 }, (_, i) => i + 1); // k = 20 * 0.95 = 19 -> 20
  assert.equal(quantile(xs, 0.95), 20);
  assert.equal(quantile([1, 2], 0.95), 1.95);
  const s = stat([-1, -3, 2]);
  assert.deepEqual([s.n, s.median, s.maxabs], [3, -1, 3]);
  closeTo(s.p95abs, 2.9);
});

// ---- BANDS ----------------------------------------------------------------------------------------------------------
const run = (residuals, history = [], day = 'd1') => evaluateBands(baseline, residuals, history, day);
const win = (v, n = 20) => Array.from({ length: n }, () => v);

test('B1 fewer than 20 window sessions is warm-up and never warns or fails', () => {
  const r = run(win(-30, 19));
  assert.equal(r.status, 'warmup');
  assert.equal(r.n, 19);
});

test('B2 warn above 3.27; fail only on two consecutive runs above 4.27; a fine run between resets', () => {
  assert.equal(run(win(-3.0)).status, 'ok');
  assert.equal(run(win(-3.5)).status, 'warn');
  const first = run(win(-4.5), [], 'd1');
  assert.equal(first.status, 'warn');
  const second = run(win(-4.5), first.history, 'd2');
  assert.equal(second.status, 'fail');
  const fine = run(win(-2.3), first.history, 'd2');
  assert.equal(fine.status, 'ok');
  assert.equal(run(win(-4.5), fine.history, 'd3').status, 'warn');
});

test('B2b a median between 3.27 and 4.27 stays a warn on two consecutive runs (the fail line is 4.27, not 3.27)', () => {
  const first = run(win(-3.6), [], 'd1');
  assert.equal(first.status, 'warn');
  const second = run(win(-3.6), first.history, 'd2');
  assert.equal(second.status, 'warn');
  assert.equal(second.consecutiveOver, 0);
});

test('B3 a median closer to 0 than the baseline never warns or fails', () => {
  assert.equal(run(win(-0.2)).status, 'ok');
  assert.equal(run(win(1.0)).status, 'ok');
});

test('B4 a second run on the same day replaces the first and does not make two consecutive runs', () => {
  const first = run(win(-4.5), [], 'd1');
  const again = run(win(-4.5), first.history, 'd1');
  assert.equal(again.status, 'warn');
  assert.equal(again.history.length, 1);
});

test('B8 a night over the same window is not a second run; a night with a new session is', () => {
  const first = evaluateBands(baseline, win(-4.5), [], 'd1', 'sig-a');
  assert.equal(first.status, 'warn');
  const stale = evaluateBands(baseline, win(-4.5), first.history, 'd2', 'sig-a');
  assert.equal(stale.status, 'warn');
  assert.equal(stale.consecutiveOver, 1);
  assert.equal(stale.history.length, 1);
  const quietThenNew = evaluateBands(baseline, win(-4.5), stale.history, 'd3', 'sig-b');
  assert.equal(quietThenNew.status, 'fail');
  assert.equal(evaluateBands(baseline, win(-4.5), first.history, 'd2', 'sig-b').status, 'fail');
  const failing = evaluateBands(baseline, win(-4.5), quietThenNew.history, 'd4', 'sig-b');
  assert.equal(failing.status, 'fail');
  assert.equal(windowSig([{ sid: 'a' }, { sid: 'b' }]), windowSig([{ sid: 'a' }, { sid: 'b' }]));
  assert.notEqual(windowSig([{ sid: 'a' }, { sid: 'b' }]), windowSig([{ sid: 'a' }, { sid: 'c' }]));
});

test('B5 a single clean session is info above 8.48, warn above 15, never a fail', () => {
  assert.equal(singleSessionLevel(baseline, -8.4), null);
  assert.equal(singleSessionLevel(baseline, -8.6), 'info');
  assert.equal(singleSessionLevel(baseline, 8.6), 'info');
  assert.equal(singleSessionLevel(baseline, -15.1), 'warn');
  assert.equal(singleSessionLevel(baseline, -90), 'warn');
});

test('B6 the window drops sessions before the cut-off, takes a session once, orders by first timestamp, keeps 20', () => {
  const cutoff = { ...baseline, afterTs: '2026-11-01T00:00:00.000Z', window: 3 };
  const s = (sid, ts, r = -2) => ({ sid, firstTs: ts, residualPct: r });
  const w1 = updateWindow([], [s('old', '2026-10-31T23:00:00.000Z'), s('b', '2026-11-03T00:00:00.000Z'), s('a', '2026-11-02T00:00:00.000Z')], cutoff);
  assert.deepEqual(w1.map((x) => x.sid), ['a', 'b']);
  const w2 = updateWindow(w1, [s('a', '2026-11-02T00:00:00.000Z', -9), s('c', '2026-11-04T00:00:00.000Z'), s('d', '2026-11-05T00:00:00.000Z')], cutoff);
  assert.deepEqual(w2.map((x) => x.sid), ['b', 'c', 'd']);
  assert.equal(w2.find((x) => x.sid === 'b').residualPct, -2);
});

test('B7 replay: baseline-like noise gives no warn and no fail; a shifted series fails', () => {
  const noise = Array.from({ length: 36 }, (_, i) => -2.27 + (i % 2 === 0 ? 0.7 : -0.7));
  const calm = replayBands(baseline, noise);
  assert.equal(calm.fails, 0);
  assert.equal(calm.warns, 0);
  assert.equal(calm.steps.filter((x) => x.status !== 'warmup').length, 17);
  const shifted = replayBands(baseline, Array.from({ length: 36 }, () => -6));
  assert.ok(shifted.fails > 0);
});

// ---- END TO END -----------------------------------------------------------------------------------------------------
const snapshot = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else out.push([p, statSync(p).mtimeMs, statSync(p).size]);
    }
  };
  walk(dir);
  return JSON.stringify(out.sort());
};

test('E1 a run leaves the projects folder as it was and --no-run-state writes no state', () => {
  const env = makeEnv([cleanSession(1)]);
  const before = snapshot(env.projects);
  const { lines } = reconcile(opts(env, { runState: null }));
  assert.equal(snapshot(env.projects), before);
  assert.equal(existsSync(env.runState), false);
  assert.equal(kinds(lines, 'summary').length, 1);
});

test('E5 the fake clean session gives the hand-made residual per model and per session', () => {
  const env = makeEnv([cleanSession(1)]);
  const { lines } = reconcile(opts(env));
  const row = kinds(lines, 'row').find((r) => r.model === 'claude-sonnet-5-5');
  closeTo(row.recomputeUsd, BIG_USD, 1e-9);
  closeTo(row.ledgerUsd, LEDGER_USD, 1e-9);
  closeTo(row.residualPct, BIG_RESIDUAL, 1e-6);
  const session = kinds(lines, 'session')[0];
  assert.equal(session.clean, true);
  closeTo(session.residualPct, BIG_RESIDUAL, 1e-6);
  const summary = kinds(lines, 'summary')[0];
  assert.equal(summary.byModel['claude-sonnet-5-5'].all.n, 1);
  assert.equal(summary.priceCheck.complete.n, 1);
  closeTo(summary.priceCheck.complete.maxAbsPct, 0, 1e-9);
});

test('E2 the run-state is written at the override path; a rerun adds no session twice; an active session waits', () => {
  const env = makeEnv([cleanSession(1), cleanSession(2, { ageMin: 1 })]);
  const early = { ...baseline, afterTs: '2000-01-01T00:00:00.000Z' };
  const bl = join(env.root, 'baseline.json');
  writeFileSync(bl, JSON.stringify(early));
  const o = opts(env, { runState: env.runState, baseline: bl });
  reconcile(o);
  const state1 = JSON.parse(readFileSync(env.runState, 'utf8'));
  assert.deepEqual(state1.window.map((w) => w.sid), [SID(1)]); // session 2 is still active
  reconcile(o);
  const state2 = JSON.parse(readFileSync(env.runState, 'utf8'));
  assert.equal(state2.window.length, 1);
  assert.equal(state2.history.length, 1);
  assert.equal(state2.history[0].status, 'warmup');
});

test('E3 --out outside the e2e folder exits 2; --out inside it holds the same lines', () => {
  const env = makeEnv([cleanSession(1)]);
  const base = ['--projects', env.projects, '--state', env.state, '--prices', PRICES_PATH, '--baseline', BASELINE_PATH, '--no-run-state', '--e2e-dir', env.e2e];
  const bad = spawnSync(process.execPath, [CLI, ...base, '--out', join(env.root, 'elsewhere.jsonl')], { encoding: 'utf8' });
  assert.equal(bad.status, 2, bad.stderr);
  assert.equal(existsSync(join(env.root, 'elsewhere.jsonl')), false);
  const outFile = join(env.e2e, 'run.jsonl');
  const good = spawnSync(process.execPath, [CLI, ...base, '--out', outFile], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(readFileSync(outFile, 'utf8').trim(), good.stdout.trim());
});

test('E4 an unknown id in the ledger exits 1', () => {
  const s = cleanSession(1);
  s.ledger = [costState(SID(1), T0, LEDGER_USD, { 'claude-sonnet-9-9': mu({ ...BIG, o: LEDGER_OUT, cost: LEDGER_USD }) })];
  const env = makeEnv([s]);
  const { exitCode, lines } = reconcile(opts(env));
  assert.equal(exitCode, 1);
  assert.ok(kinds(lines, 'finding').some((f) => f.level === 'fail' && f.code === 'unknown-model'));
});

test('E6 a warn finding exits 10, a fail beside a warn exits 1, a clean run exits 0', () => {
  const warn = makeEnv([opusSession(1, { speed: 'fast', cost: 5.408 })]);
  const w = reconcile(opts(warn));
  assert.equal(w.exitCode, 10);
  assert.equal(kinds(w.lines, 'summary')[0].exitCode, 10);
  const both = makeEnv([opusSession(1, { speed: 'fast', cost: 5.408 }), opusSession(2, { cost: 2.0 })]);
  assert.equal(reconcile(opts(both)).exitCode, 1);
  assert.equal(reconcile(opts(makeEnv([cleanSession(1)]))).exitCode, 0);
});

test('E7 two nights over the same window warn; they do not fail', () => {
  const env = makeEnv([cleanSession(1)]);
  const bl = join(env.root, 'baseline.json');
  // One-session window, afterTs long ago, fail line at 2.77: the fake residual -3.57 is over it every night.
  writeFileSync(bl, JSON.stringify({ ...baseline, afterTs: '2000-01-01T00:00:00.000Z', window: 1, failDeltaPts: 0.5, warnDeltaPts: 0.25 }));
  const night = (k) => reconcile(opts(env, { runState: env.runState, baseline: bl, now: new Date(Date.now() + k * 86_400_000) }));
  const one = night(1);
  const two = night(2);
  assert.equal(kinds(one.lines, 'summary')[0].bands.status, 'warn');
  const bands = kinds(two.lines, 'summary')[0].bands;
  assert.equal(bands.status, 'warn');
  assert.equal(bands.consecutiveOver, 1);
  assert.equal(two.exitCode, 10);
});

const cli = (env, extra) => spawnSync(process.execPath, [CLI, '--projects', env.projects, '--state', env.state, '--prices', PRICES_PATH, '--baseline', BASELINE_PATH, '--no-run-state', '--quiet', ...extra], { encoding: 'utf8' });

test('V1 an empty state folder, or no transcript for any state file, exits 2; a quiet day exits 0', () => {
  const empty = makeEnv([]);
  const a = cli(empty, []);
  assert.equal(a.status, 2, a.stdout);
  assert.match(a.stderr, /^ENV: /);
  const moved = makeEnv([cleanSession(1), cleanSession(2)]);
  renameSync(join(moved.projects, 'proj'), join(moved.root, 'proj-gone'));
  mkdirSync(join(moved.projects, 'proj'));
  const b = cli(moved, []);
  assert.equal(b.status, 2, b.stdout);
  assert.match(b.stderr, /^ENV: /);
  const quiet = makeEnv([cleanSession(1)]);
  const c = cli(quiet, ['--since-hours', '1']);
  assert.equal(c.status, 0, c.stderr);
  const summary = JSON.parse(c.stdout.trim().split('\n').pop());
  assert.equal(summary.sessions, 0);
  assert.equal(summary.skipped.notSelected, 1);
});
