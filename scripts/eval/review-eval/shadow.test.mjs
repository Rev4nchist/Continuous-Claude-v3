// Shadow failure modes (shadow spec section 8). The F-numbers are the shadow spec's, prefixed `s`.
//  sF1  CR at A, engine at B paired        -> compare 8 chars instead of 40 (fixture shas share the first 8)
//  sF2  thread reply as a round            -> covered in github.test.mjs (crRounds is the same function)
//  sF4  line:null after a push             -> crFindings reads `line`
//  sF5  notice as a clean round            -> pairState ignores round.notice
//  sF10 replay satisfies LR-PIN            -> engine record path under local-review/
//  sF13 unverified in precision            -> count unverified as noise
//  sF14 sample never ends                  -> ignore the TTL
//  sF15 eligible with a security escape    -> drop the row
//  sF16 eligible at 19 Majors              -> `>` vs `>=`
//  sF17 old version counted                -> drop the engineVersion filter
//  sF18 re-promotion window                -> change the 10-pair window
//  sF19 partial run paired                 -> drop the timedOut/failed/coverage check
//  sF20 waiver ignored                     -> drop the waiver row
//  sF21 starved sample passes              -> ignore sampleStarved
//  (sF3 summary round, sF6-sF9 match, sF11-sF12 judge: github/match/judge test files.)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PAIR_STATES, crFindings, decideBand, engineRecordPath, main, pairState, scoreBand } from './shadow.mjs';
import { underLocalReview } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CR = { login: 'coderabbitai[bot]', type: 'Bot' };
const sha = (c) => c.repeat(40);
const HOUR = 3_600_000;
const bar = { holdoutRecall: 0.8, precision: 0.78, minMajors: 20, minLabels: 30 };

test('PAIR_STATES lists the seven states of the spec', () => {
  // Breaks when: a state is renamed (the scorecard keys would drift).
  assert.deepEqual([...PAIR_STATES].sort(), ['cr_pending', 'engine_pending', 'excluded', 'paired', 'skipped', 'void_partial', 'void_sha']);
});

test('sF1 a CR round at A and an engine record at B are not paired, even when 8 chars match', () => {
  // Breaks when: the sha compare uses 8 characters (these two share the first 8 hex).
  const A = `deadbeef${'1'.repeat(32)}`;
  const B = `deadbeef${'2'.repeat(32)}`;
  const round = { sha40: A };
  const engine = { sha40: B, coverage: { selected: 2, reviewed: 2 } };
  assert.equal(pairState({ round, engine, pr: {}, now: 0, ttlMs: HOUR }).state, 'engine_pending');
  assert.equal(pairState({ round, engine, pr: { shaGone: true }, now: 0, ttlMs: HOUR }).state, 'void_sha');
  assert.equal(pairState({ round, engine: { ...engine, sha40: A }, pr: {}, now: 0, ttlMs: HOUR }).state, 'paired');
});

test('sF5 a rate-limit notice round, "too many files" and dependabot are excluded', () => {
  // Breaks when: pairState ignores round.notice or the author check.
  assert.equal(pairState({ round: { sha40: sha('a'), notice: 'rate limited' }, engine: null, pr: {}, now: 0, ttlMs: HOUR }).state, 'excluded');
  assert.equal(pairState({ round: { sha40: sha('a'), tooManyFiles: true }, engine: null, pr: {}, now: 0, ttlMs: HOUR }).state, 'excluded');
  assert.equal(pairState({ round: { sha40: sha('a') }, engine: null, pr: { author: 'dependabot[bot]' }, now: 0, ttlMs: HOUR }).state, 'excluded');
});

test('sF14 a drawn sample with no CR round is skipped after the TTL, or when the PR merged first', () => {
  // Breaks when: the TTL compare is dropped (the sample would wait forever) or is >= (the edge case below).
  const pr = { drawnAt: 1_000_000 };
  assert.equal(pairState({ round: null, engine: null, pr, now: 1_000_000 + 12 * HOUR, ttlMs: 12 * HOUR }).state, 'cr_pending');
  const late = pairState({ round: null, engine: null, pr, now: 1_000_000 + 12 * HOUR + 1, ttlMs: 12 * HOUR });
  assert.deepEqual([late.state, late.reason], ['skipped', 'ttl']);
  assert.deepEqual(pairState({ round: null, engine: null, pr: { ...pr, merged: true }, now: 1_000_001, ttlMs: 12 * HOUR }), { state: 'skipped', reason: 'merged' });
  assert.deepEqual(pairState({ round: null, engine: null, pr: { ...pr, closed: true }, now: 1_000_001, ttlMs: 12 * HOUR }), { state: 'skipped', reason: 'closed' });
});

test('sF19 a timed-out, failed or part-covered engine run is void_partial', () => {
  // Breaks when: the timedOut/failed/coverage check is dropped.
  const round = { sha40: sha('a') };
  const at = (engine) => pairState({ round, engine: { sha40: sha('a'), coverage: { selected: 3, reviewed: 3 }, ...engine }, pr: {}, now: 0, ttlMs: HOUR });
  assert.equal(at({ timedOut: true }).state, 'void_partial');
  assert.equal(at({ failed: true }).state, 'void_partial');
  assert.equal(at({ coverage: { selected: 3, reviewed: 2 } }).state, 'void_partial');
  assert.equal(pairState({ round: { sha40: sha('a'), filesSelected: 4 }, engine: { sha40: sha('a'), coverage: { selected: 3, reviewed: 3 } }, pr: {}, now: 0, ttlMs: HOUR }).state, 'void_partial');
  assert.equal(at({}).state, 'paired');
});

test('sF4 crFindings reads original_start_line..original_line when line is null', () => {
  // Breaks when: crFindings reads `line`.
  const inline = [{ id: 7, user: CR, in_reply_to_id: null, original_commit_id: sha('a'), path: 'a.mjs', line: null, original_start_line: 130, original_line: 136, body: '**<picture><img alt=""></picture> Major** · title\n\nbody text' }];
  const f = crFindings({ round: { sha40: sha('a') }, review: { id: 1, user: CR, body: '' }, inline });
  assert.equal(f.length, 1);
  assert.deepEqual([f[0].file, f[0].start, f[0].end, f[0].sev, f[0].src], ['a.mjs', 130, 136, 'major', 'cr']);
});

test('crFindings drops thread replies and comments from another commit', () => {
  // Breaks when: the in_reply_to_id or original_commit_id filter is dropped.
  const mk = (over) => ({ id: 1, user: CR, in_reply_to_id: null, original_commit_id: sha('a'), path: 'a.mjs', original_line: 3, body: '<picture></picture> Minor x', ...over });
  const f = crFindings({ round: { sha40: sha('a') }, review: { id: 1, user: CR, body: '' }, inline: [mk({}), mk({ id: 2, in_reply_to_id: 1 }), mk({ id: 3, original_commit_id: sha('b') })] });
  assert.deepEqual(f.map((x) => x.id), ['1']);
});

test('crFindings reads outside-diff findings from a real CR review body', () => {
  // Breaks when: the codeRabbitOutsideFindings call is dropped (body findings would vanish).
  const body = readFileSync(path.join(here, '..', '..', 'github', 'fixtures', 'coderabbit-severity', 'pr221-review-5712203534-outside-only.md'), 'utf8');
  const f = crFindings({ round: { sha40: sha('a') }, review: { id: 5712203534, user: CR, body }, inline: [] });
  assert.ok(f.length >= 1);
  assert.equal(f.every((x) => x.src === 'cr' && x.inDiff === false), true);
  assert.ok(f.some((x) => x.file && x.start > 0));
});

test('sF10 the shadow engine record path is under the shadow root and never under local-review/', () => {
  // Breaks when: the root is changed to ~/.claude/state/local-review (LR-PIN would read a replay).
  const p = engineRecordPath({ pr: 251, sha40: sha('a') }, { root: path.join('C:', 'x', 'state', 'local-review-shadow') });
  assert.ok(p.endsWith(path.join('251', `${sha('a')}.json`)));
  assert.equal(/[\\/]local-review[\\/]/.test(p), false);
  assert.throws(() => engineRecordPath({ pr: 251, sha40: sha('a') }, { root: path.join('C:', 'x', 'state', 'local-review') }), /local-review/);
});

// ---- scoring ----
const f = (id, sev, inDiff = true) => ({ id, sev, inDiff });
let ts = 0;
const P = (over = {}) => ({ v: 1, ts: new Date(1_700_000_000_000 + (ts += 1000)).toISOString(), pr: 1, sha40: sha('a'), round: 1, kind: 'sample', band: 'MID', engineVersion: 'v1', state: 'paired', cr: [], eng: [], matches: [], ...over });
const real = (id) => ({ findingId: id, verdict: 'real', by: 'dave' });
const opts = (over = {}) => ({ band: 'MID', engineVersion: 'v1', holdout: { engineVersion: 'v1', majors: 10, found: 9, recall: 0.9 }, waivers4w: 0, securityEscapes4w: 0, ...over });

test('sF13 unverified engine findings stay out of precision: 3 unverified + 1 real is 1.0', () => {
  // Breaks when: unverified findings are counted as noise (or as real).
  const pairs = [P({ eng: [f('e1', 'major'), f('e2', 'minor'), f('e3', 'minor'), f('e4', 'minor')] })];
  const s = scoreBand(pairs, [real('e1')], opts());
  assert.deepEqual([s.precision.real, s.precision.noise, s.precision.unverified, s.precision.value], [1, 0, 3, 1]);
});

test('sF9 a CR Major matched by an engine Minor is a downgrade and does not count as engine recall', () => {
  // Breaks when: severity is ignored in the recall count.
  const pairs = [P({ cr: [f('c1', 'major')], eng: [f('e1', 'minor')], matches: [{ crId: 'c1', engId: 'e1', how: 'line' }] })];
  const s = scoreBand(pairs, [real('c1')], opts());
  assert.equal(s.severityDowngrades, 1);
  assert.equal(s.engineRecall, 0);
  assert.equal(s.crRecall, 1);
});

test('sF17 pairs from another engineVersion are out of every count', () => {
  // Breaks when: the engineVersion filter is dropped.
  const pairs = [P({ cr: [f('c1', 'major')], eng: [f('e1', 'major')], matches: [{ crId: 'c1', engId: 'e1' }] }), P({ engineVersion: 'v0', cr: [f('c2', 'major')], eng: [f('e2', 'major')], matches: [{ crId: 'c2', engId: 'e2' }] })];
  const s = scoreBand(pairs, [real('c1'), real('c2')], opts());
  assert.equal(s.majorsUnion, 1);
  assert.equal(s.pairs.paired, 1);
});

test('sF21 a skip rate above 0.5 for two weeks sets sampleStarved, and the Majors row fails', () => {
  // Breaks when: decideBand ignores sampleStarved.
  const skipped = (n) => Array.from({ length: n }, () => P({ state: 'skipped', reason: 'ttl' }));
  const s = scoreBand([...skipped(6), P(), P(), P(), P()], [], opts({ priorSkipRate: 0.6 }));
  assert.equal(s.skipRate, 0.6);
  assert.equal(s.sampleStarved, true);
  const d = decideBand({ ...good(), sampleStarved: true, majorsCumulative: 30 }, bar);
  assert.ok(d.failed.includes('minMajors'));
  const once = scoreBand([...skipped(6), P(), P(), P(), P()], [], opts({ priorSkipRate: 0.2 }));
  assert.equal(once.sampleStarved, false);
});

// An all-green score; each test breaks one field.
function good(over = {}) {
  return {
    holdoutRecall: 0.9, engineRecall: 0.9, crRecall: 0.8, precision: { real: 28, noise: 4, unverified: 0, value: 0.875 }, majorsCumulative: 20, sampleStarved: false,
    securityEscapes4w: 0, waivers4w: 0, escapeRate4w: null, escapeBaseline: 0.1, recentMisses: 0, ...over,
  };
}

test('an all-green score is eligible', () => {
  // Breaks when: a row in decideBand fails a good score.
  assert.deepEqual(decideBand(good(), bar), { verdict: 'eligible', failed: [], proposal: false });
});

test('sF16 19 Majors hold with minMajors; 20 pass', () => {
  // Breaks when: the Majors row compares with `>` (20 would fail) or the floor moves.
  const d = decideBand(good({ majorsCumulative: 19 }), bar);
  assert.deepEqual([d.verdict, d.failed], ['hold', ['minMajors']]);
  assert.equal(decideBand(good({ majorsCumulative: 20 }), bar).verdict, 'eligible');
});

test('sF15 an eligible score with a security-tier escape is repromote', () => {
  // Breaks when: the securityEscapes4w row is dropped.
  assert.equal(decideBand(good({ securityEscapes4w: 1 }), bar).verdict, 'repromote');
});

test('sF20 one waiver on an engine-reviewed PR holds', () => {
  // Breaks when: the waiver row is dropped.
  const d = decideBand(good({ waivers4w: 1 }), bar);
  assert.deepEqual([d.verdict, d.failed], ['hold', ['waivers']]);
});

test('the other rows fail on their own: holdout recall, shadow recall, precision, labels floor, null holdout', () => {
  // Breaks when: a threshold or a null check is removed from decideBand.
  assert.ok(decideBand(good({ holdoutRecall: 0.79 }), bar).failed.includes('holdoutRecall'));
  assert.ok(decideBand(good({ holdoutRecall: null }), bar).failed.includes('holdoutRecall'));
  assert.ok(decideBand(good({ engineRecall: 0.7 }), bar).failed.includes('shadowRecall'));
  assert.ok(decideBand(good({ precision: { real: 20, noise: 12, unverified: 0, value: 0.625 } }), bar).failed.includes('precision'));
  assert.ok(decideBand(good({ precision: { real: 9, noise: 1, unverified: 0, value: 0.9 } }), bar).failed.includes('precision'));
  assert.ok(decideBand(good({ escapeRate4w: 0.3 }), bar).failed.includes('escapeRate'));
});

test('two eligible weeks in a row make a proposal', () => {
  // Breaks when: the prior verdict is ignored.
  assert.equal(decideBand(good(), bar, { verdict: 'eligible' }).proposal, true);
  assert.equal(decideBand(good(), bar, { verdict: 'hold' }).proposal, false);
});

test('sF18 two engine-missed Majors inside the last 10 paired sample pairs is repromote; at positions 1 and 11 it is hold', () => {
  // Breaks when: the window changes from 10 (position 11 would count, or position 10 would not).
  const miss = (n) => P({ pr: n, cr: [f(`c${n}`, 'major')], eng: [], matches: [] });
  const ok = (n) => P({ pr: n, cr: [], eng: [] });
  const labels = Array.from({ length: 30 }, (_, i) => real(`c${i}`));
  const build = (missAt) => {
    ts = 0;
    // oldest first; position 1 = newest.
    const arr = Array.from({ length: 12 }, (_, i) => (missAt.includes(12 - i) ? miss(i) : ok(i)));
    return arr;
  };
  const near = scoreBand(build([1, 10]), labels, opts());
  assert.equal(near.recentMisses, 2);
  assert.equal(decideBand({ ...good(), ...near, holdoutRecall: 0.9, engineRecall: 0.9, crRecall: 0.8 }, bar).verdict, 'repromote');
  const far = scoreBand(build([1, 11]), labels, opts());
  assert.equal(far.recentMisses, 1);
  assert.notEqual(decideBand({ ...good(), ...far, majorsCumulative: 20 }, bar).verdict, 'repromote');
});

test('scoreBand: holdoutRecall is null when the holdout was scored with another engine version', () => {
  // Breaks when: the version check on the holdout file is dropped (the row would pass on stale data).
  const s = scoreBand([], [], opts({ holdout: { engineVersion: 'v0', majors: 10, found: 9, recall: 0.9 } }));
  assert.equal(s.holdoutRecall, null);
  assert.equal(decideBand({ ...good(), holdoutRecall: s.holdoutRecall }, bar).failed.includes('holdoutRecall'), true);
});

test('scoreBand: the sample and required kinds are counted apart, and states are tallied', () => {
  // Breaks when: byKind merges kinds or states are not tallied.
  const s = scoreBand([P({ kind: 'sample' }), P({ kind: 'required' }), P({ state: 'engine_pending' }), P({ band: 'HIGH' })], [], opts());
  assert.deepEqual([s.byKind.sample, s.byKind.required], [2, 1]);
  assert.equal(s.pairs.engine_pending, 1);
  assert.equal(s.pairs.paired, 2);
});

test('sF10 decide writes band-state.json under the shadow root, never under local-review/', async () => {
  // Breaks when: the default band-state path goes back to ~/.claude/state/local-review/ (the folder LR-PIN reads).
  const root = mkdtempSync(path.join(process.env.REVIEW_EVAL_TMP || os.tmpdir(), 'shadow-decide-'));
  mkdirSync(root, { recursive: true });
  const row = (n, miss) => ({ v: 1, ts: new Date(1_700_000_000_000 + n * 1000).toISOString(), pr: n, sha40: sha('a'), round: 1, kind: 'sample', band: 'MID', engineVersion: 'v1', state: 'paired', cr: miss ? [{ id: `c${n}`, sev: 'major', inDiff: true }] : [], eng: [], matches: [] });
  writeFileSync(path.join(root, 'pairs.jsonl'), [row(1, true), row(2, true), row(3, false)].map((r) => `${JSON.stringify(r)}
`).join(''));
  writeFileSync(path.join(root, 'labels.jsonl'), [1, 2].map((n) => `${JSON.stringify({ findingId: `c${n}`, verdict: 'real', by: 'dave' })}
`).join(''));
  const code = await main(['decide', '--band', 'MID', '--engine-version', 'v1', '--root', root], { cfg: { shadow: { bar } }, stdout: () => {}, stderr: () => {}, now: () => 1_700_001_000_000 });
  assert.equal(code, 3);
  const file = path.join(root, 'band-state.json');
  assert.equal(existsSync(file), true);
  assert.equal(underLocalReview(file), false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).MID.mode, 'full');
});

test('retro with no injected engine replays through replayRun (kind shadow, the non-notice rank) and writes under the shadow root', async () => {
  // Breaks when: main forwards deps.engine/git/runJudge as undefined (every round stays engine_pending, crBase null),
  // the default engine passes the raw round index (a notice round shifts it), or replay output leaves the shadow root.
  const root = mkdtempSync(path.join(process.env.REVIEW_EVAL_TMP || os.tmpdir(), 'shadow-default-'));
  const A = sha('a');
  const X = sha('c');
  const B = sha('b');
  const gh = async (args) => {
    const route = args[args.length - 1];
    if (route.includes('/reviews')) return [[
      { id: 10, user: CR, body: '> ## Review skipped\n> too many files', commit_id: X, submitted_at: '2026-11-01T00:00:00Z' },
      { id: 11, user: CR, body: '**Actionable comments posted: 1**', commit_id: A, submitted_at: '2026-11-01T01:00:00Z' },
    ]];
    if (route.includes('/issues/300/comments')) return [[]];
    if (route.includes('/commits')) return [[{ sha: X }, { sha: A }]];
    if (route.includes('/pulls/300/comments')) return [[{ id: 99, user: CR, in_reply_to_id: null, original_commit_id: A, original_line: 10, path: 'a.mjs', body: '**Bug**' }]];
    return { user: { login: 'dave' }, state: 'open', merged_at: null };
  };
  const git = (args) => (args[0] === 'merge-base' ? { status: 0, stdout: `${B}\n` } : { status: 0, stdout: '' });
  const findingsPath = path.join(root, 'f.json');
  writeFileSync(findingsPath, JSON.stringify({ timedOut: false, findings: [{ file: 'a.mjs', line: 10, lineEnd: null, severity: 'major', title: 't' }] }));
  const calls = [];
  const replayRun = async (args, deps) => { calls.push({ args, deps }); return { exit: 0, status: 'ok', pr: args.pr, round: args.round, record: { sha40: A }, findingsPath }; };
  const code = await main(['retro', '--from', '300', '--to', '300'], { root, cfg: { shadow: {}, freeze: { promptSha256: 'P' } }, gh, git, replayRun, engineVersion: 'v1', now: () => 1_700_000_000_000, stdout: () => {}, stderr: () => {} });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].args.pr, calls[0].args.round, calls[0].args.kind, calls[0].args.set], [300, 1, 'shadow', 'shadow']);
  for (const p of [calls[0].deps.outRoot, calls[0].deps.runsPath]) assert.ok(path.resolve(p).startsWith(path.resolve(root)), p);
  const rows = readFileSync(path.join(root, 'pairs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const row = rows.find((r) => r.sha40 === A);
  // crBase is round k-1 (here the notice round X): crRange's rule. Before the fix it was null (no git).
  assert.deepEqual([row.state, row.engineSource, row.crBase, row.matches.length], ['paired', 'shadow', X, 1]);
  const first = rows.find((r) => r.sha40 === X);
  assert.equal(first.crBase, B);
});

// PR 300 with two CR rounds, X then A. Each test gets a fresh root.
function twoRoundPr() {
  const X = sha('c');
  const A = sha('a');
  const gh = async (args) => {
    const route = args[args.length - 1];
    if (route.includes('/reviews')) return [[
      { id: 10, user: CR, body: '**Actionable comments posted: 0**', commit_id: X, submitted_at: '2026-11-01T00:00:00Z' },
      { id: 11, user: CR, body: '**Actionable comments posted: 0**', commit_id: A, submitted_at: '2026-11-01T01:00:00Z' },
    ]];
    if (route.includes('/issues/300/comments')) return [[]];
    if (route.includes('/commits')) return [[{ sha: X }, { sha: A }]];
    if (route.includes('/pulls/300/comments')) return [[]];
    return { user: { login: 'dave' }, state: 'open', merged_at: null };
  };
  const git = (args) => (args[0] === 'merge-base' ? { status: 0, stdout: `${sha('b')}\n` } : { status: 0, stdout: '' });
  const root = mkdtempSync(path.join(process.env.REVIEW_EVAL_TMP || os.tmpdir(), 'shadow-sync-'));
  const readRows = () => readFileSync(path.join(root, 'pairs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { X, A, gh, git, root, readRows };
}

test('sync skips a round with a final stored row: no engine call, no budget spent, the stored row kept', async () => {
  // Breaks when: pairsForPr stops reading pairs.jsonl (the budget goes to old round X, the cap refusal
  // turns its stored paired row into engine_pending, and new round A gets no engine call).
  const { X, A, gh, git, root, readRows } = twoRoundPr();
  const stored = { v: 1, ts: '2026-10-01T00:00:00.000Z', pr: 300, sha40: X, round: 1, kind: 'retro', band: 'MID', crBase: sha('b'), engineSource: 'shadow', engineVersion: 'v1', state: 'paired', reason: 'stored-marker', paid: false, cr: [], eng: [], matches: [], crOnly: [], engOnly: [], disputed: [] };
  writeFileSync(path.join(root, 'pairs.jsonl'), `${JSON.stringify(stored)}\n`);
  const calls = [];
  const engine = async ({ sha40 }) => { calls.push(sha40); return null; }; // a cap refusal
  const code = await main(['sync', '--force', '--from', '300', '--to', '300', '--max', '1'], { root, cfg: { shadow: {} }, gh, git, engine, runJudge: async () => null, engineVersion: 'v1', now: () => 1_700_000_000_000, stdout: () => {}, stderr: () => {} });
  assert.equal(code, 0);
  assert.deepEqual(calls, [A]);
  const rows = readRows();
  assert.deepEqual(rows.filter((r) => r.sha40 === X), [stored]);
  assert.equal(rows.find((r) => r.sha40 === A).state, 'engine_pending');
});

test('sync writes kind sample and retro writes kind retro', async () => {
  // Breaks when: sync rows are written as retro (scoreBand's re-promotion window reads kind sample only).
  for (const [cmd, kind] of [['sync', 'sample'], ['retro', 'retro']]) {
    const { A, gh, git, root, readRows } = twoRoundPr();
    const engine = async ({ sha40 }) => ({ sha40, timedOut: false, failed: false, findings: [] });
    const code = await main([cmd, '--force', '--from', '300', '--to', '300'], { root, cfg: { shadow: {} }, gh, git, engine, runJudge: async () => null, engineVersion: 'v1', now: () => 1_700_000_000_000, stdout: () => {}, stderr: () => {} });
    assert.equal(code, 0);
    const row = readRows().find((r) => r.sha40 === A);
    assert.deepEqual([cmd, row.state, row.kind], [cmd, 'paired', kind]);
  }
});

test('the default shadow engine maps a failed replay to void_partial and a cap refusal to engine_pending', async () => {
  // Breaks when: a failed replay is read as paired, or a cap/frozen refusal is read as a failed run.
  const { defaultShadowEngine } = await import('./shadow.mjs');
  const A = sha('a');
  const mk = (res) => defaultShadowEngine({ cfg: {}, gh: null, root: os.tmpdir(), repoRoot: os.tmpdir(), replayRun: async () => res });
  const failed = await mk({ exit: 1, status: 'failed', reason: 'TIMED OUT after 1500 s', record: { sha40: A } })({ pr: 1, rank: 1, sha40: A });
  assert.equal(pairState({ round: { sha40: A }, engine: failed, pr: {}, now: 0, ttlMs: HOUR }).state, 'void_partial');
  const cap = await mk({ exit: 3, status: 'cap', reason: 'headroom' })({ pr: 1, rank: 1, sha40: A });
  assert.equal(pairState({ round: { sha40: A }, engine: cap, pr: {}, now: 0, ttlMs: HOUR }).state, 'engine_pending');
});
test('the default shadow engine still replays with the cursor-review reviewer: its engineVersion hashes the old freeze (breaks if the replay default reaches shadow)', async () => {
  const { defaultShadowEngine } = await import('./shadow.mjs');
  const seen = [];
  const engine = defaultShadowEngine({ cfg: {}, gh: null, root: os.tmpdir(), repoRoot: os.tmpdir(), replayRun: async (args) => { seen.push(args); return { exit: 3, status: 'cap' }; } });
  await engine({ pr: 1, rank: 1, sha40: sha('a') });
  assert.equal(seen[0].reviewer, 'cursor-review');
});
