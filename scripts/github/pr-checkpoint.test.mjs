// Tests for pr-checkpoint.mjs (PR A: the read-only recommendation engine).
// Run: node --test scripts/github/pr-checkpoint.test.mjs
// Spec: .claudedocs/2026-10-28-pr-checkpoint-mod-spec.md sections 2 and 6 (tests 1-15; 16-18 are PR B).
//
// The module does not exist yet. Every test imports it inside its own body, so a missing module or export fails
// that test by name and never hides the others.
//
// Contract under test (written before the code):
//   recommend(facts, policy) -> result       pure: no I/O, no clock, inputs never mutated
//   pathFiltersFrom(yamlText) -> string[]    the reviews.path_filters list of .coderabbit.yaml
//   parseNameStatus(text) -> [{filename, previous_filename?}]   the lines of `git diff --name-status -M`: a rename row
//                                            "R100<TAB>old<TAB>new" gives both names. Line counts come from a second source
//                                            (--numstat or the compare API) and are not part of this function.
//
//   facts = {
//     head,                                   the live head sha
//     now,                                    ISO time (credit state needs a clock; recommend never reads one)
//     stamp: { head, body_sha256, results: [{ step, status, detail }] } | null     pre-pr.mjs stamp.json
//     files: [{ filename, previous_filename?, additions, deletions }]              GitHub compare shape (a rename has both names)
//     cli: { bySeverity: { critical?, major?, ... } } | null                       parseAgentStream().bySeverity; null = unknown
//     dependabot: boolean,                    the Dependabot PR test of pr-review-loop.md:11-14, decided by the caller
//     config_drift: boolean,                  the branch config differs from main
//   }
//   policy = review-router.config.json (classes, deep_enabled, greptile, budget, checkpoint, coderabbit)
//            + path_filters: string[]         from pathFiltersFrom(.coderabbit.yaml)
//
//   result = { head, class, matched, size:{files,lines}, checks, cli, credits (the creditsState() object, so credits.u3_due follows facts.now),
//              capacity:{count,band,warning,...}, recommended, options:[{pathway,label,available,cost,reason}],
//              why:[string], budget:[coderabbit,greptile], config_drift }
//   pathway: 'none' | 'coderabbit' | 'both' | 'wait'. band: 'unknown' | 'ok' | 'warn' | 'high'.
//   R0 (stop): recommended null, options [], a why line that says to run pre-pr.mjs.
//   Config keys: budget, checkpoint.critical, checkpoint.parser, coderabbit.reviews_7d_manual and coderabbit.reviews_7d_manual_date.
//   R5 is the fallback: it runs only when R2, R3 and R4 did not match, and it needs reviewable lines (T2).
//   CLI seams: node pr-checkpoint.mjs --json [--facts facts.json] [--config router-config.json]. --facts replaces the git and stamp reads
//   (a fixture, like review-router.mjs --fixture). --confirm and --apply are PR B: exit 2.
//
// How the unit can fail, and the test that catches it:
//   R0  stamp missing, for another head, or with a failed row is ignored          -> T14, T15
//   R0  a NOTE or SKIP row in the stamp stops the checkpoint                      -> T14
//   R1  docs class is reviewed                                                    -> T1
//   R1  a diff with only filtered paths (dist, lock files) is reviewed            -> T2
//   size counts lines of filtered paths, or counts a rename once                  -> T2b, T13
//   R5  the class budget lookup is wrong (normal 1+1, infra and steering 1+2)     -> T2b, T2c
//   R1  beats R2 or R3 (a thoughts/ file next to a critical or parser file)       -> T3c
//   R1  thoughts/, artifacts/, .claudedocs/ only is reviewed                      -> T3
//   R1  a Dependabot PR is reviewed                                               -> T3b
//   R2  a parser tag is ignored, or gets the class budget alone                   -> T4
//   R2+R3 the parser line is lost, or the smaller budget wins                     -> T5
//   R2+R4 parser hides the r3 budget                                              -> T6
//   R3  a critical file does not get "both" when Greptile is free                 -> T8
//   R3  a held Greptile hides its reason                                          -> T7
//   Greptile "available" on unknown credits, or with under 3 credits left         -> T9, T9b
//   the u2 hold skips a non-r3 class, or blocks r3                                -> T10
//   R5  the capacity bands (39/40/49/50) shift, or "wait" is not first at 50      -> T11
//   "wait" or "none" leaks into R2, R3 or R4 results (both are R5 only)           -> T11b
//   an unknown 7-day count changes a rule                                         -> T12
//   a rename's old path is not classified                                         -> T13
//   R5  "none" is offered with an unknown or non-zero Major count, or is the default -> T16
//   option 1 is not the recommendation                                            -> T17
//   recommend mutates its input or reads state                                    -> T18
//   recommend reads the real clock instead of facts.now                           -> T18b
//   the rename parse of `git diff --name-status -M` loses the old path            -> T23
//   .coderabbit.yaml filters are mis-parsed (labels or branches read as paths)    -> T19
//   the config blocks are missing or mistyped                                     -> T20
//   the CLI --json output loses a field of the output shape                       -> T21
//   PR B modes (--confirm, --apply) exist in PR A, or write pathway.json          -> T22
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchGlob } from './review-router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const LIVE = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8'));
const YAML = readFileSync(path.join(ROOT, '.coderabbit.yaml'), 'utf8');
const NOW = '2026-10-28T12:00:00.000Z';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const load = () => import('./pr-checkpoint.mjs');

/**
 * The live config with the switches pinned, so editing deep_enabled, the credit count or the 7-day count in the
 * live file cannot change a result. checkpoint.critical, budget and classes come from the live file (the contract).
 * checkpoint.parser is pinned to a test glob: the live list is a data choice, not behaviour.
 */
async function policy({ deep = false, used = null, count = null } = {}) {
  const { pathFiltersFrom } = await load();
  return {
    ...LIVE,
    deep_enabled: deep,
    greptile: { ...LIVE.greptile, credits_used_manual: used },
    coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: count },
    checkpoint: { ...LIVE.checkpoint, parser: ['lib/lexer/**'] },
    path_filters: pathFiltersFrom(YAML),
  };
}

const file = (filename, additions = 10, deletions = 0, previous_filename) =>
  ({ filename, additions, deletions, ...(previous_filename ? { previous_filename } : {}) });
const PASS_STAMP = { head: HEAD, body_sha256: 'f'.repeat(64), results: [{ step: 'git:branch', status: 'PASS', detail: 'ok' }] };
const facts = (files, over = {}) => ({
  head: HEAD, now: NOW, stamp: PASS_STAMP, files, cli: { bySeverity: { minor: 1 } }, dependabot: false, config_drift: false, ...over,
});
const run = async (files, factOver = {}, polOver = {}) => {
  const { recommend } = await load();
  return recommend(facts(files, factOver), await policy(polOver));
};
const pathways = (r) => r.options.map((o) => o.pathway);
const optionOf = (r, p) => r.options.find((o) => o.pathway === p);

const CRITICAL = '.claude/hooks/src/pre-pr-gate.ts';
const SQL = 'db/migrations/001_init.sql';
const PARSER = 'lib/lexer/tokenize.mjs';

test('T1 (R1): a docs-only PR gets none and costs nothing', async () => {
  const r = await run([file('docs/guide.md', 40)]);
  assert.equal(r.class, 'docs');
  assert.equal(r.recommended, 'none');
  assert.deepEqual(r.budget, [0, 0]);
});

test('T2 (R1): a dist-only diff is 0 reviewable lines and gets none, though its class is steering', async () => {
  const r = await run([file('.claude/hooks/dist/pre-pr-gate.mjs', 500, 20), file('package-lock.json', 900, 3)]);
  assert.equal(r.class, 'steering', 'the class still comes from classify()');
  assert.equal(r.size.lines, 0);
  assert.equal(r.size.files, 0);
  assert.equal(r.recommended, 'none', 'R1 wins over R5 when nothing is reviewable');
});

test('T2b: size counts additions and deletions of unfiltered paths only', async () => {
  const r = await run([file('scripts/a.mjs', 10, 2), file('.claude/hooks/dist/x.mjs', 500), file('package-lock.json', 900)]);
  assert.deepEqual(r.size, { files: 1, lines: 12 });
  assert.equal(r.recommended, 'coderabbit');
  assert.deepEqual(r.budget, [1, 1], 'class normal: budget 1+1');
});

test('T2c (R5): the class budget comes from config: infra and steering get 1+2, not the normal 1+1', async () => {
  for (const [p, cls] of [['.github/workflows/x.yml', 'infra'], ['.claude/agents/x.md', 'steering']]) {
    const r = await run([file(p, 10)]);
    assert.equal(r.class, cls, p);
    assert.equal(r.recommended, 'coderabbit', p);
    assert.deepEqual(r.budget, [1, 2], p);
  }
});

test('T3 (R1): thoughts/, artifacts/ and .claudedocs/ only get none (a non-markdown .claudedocs file is class normal)', async () => {
  for (const p of ['thoughts/shared/handoff.yaml', 'artifacts/run/result.json', '.claudedocs/probe-output.json']) {
    const r = await run([file(p, 30)]);
    assert.equal(r.recommended, 'none', p);
  }
});

test('T3b (R1): a Dependabot PR gets none', async () => {
  const r = await run([file('package.json', 3, 3)], { dependabot: true });
  assert.equal(r.recommended, 'none');
});

test('T3d (R1, Dave decision 3): a Dependabot PR gets none even when it touches a critical or parser file, and the why line names the file', async () => {
  for (const [name, p] of [['critical', CRITICAL], ['parser', PARSER]]) {
    const r = await run([file('package.json', 3, 3), file(p, 20)], { dependabot: true });
    assert.equal(r.recommended, 'none', `${name}: Dependabot wins over R2 and R3`);
    assert.deepEqual(r.budget, [0, 0], name);
    assert.ok(r.why.some((w) => w.includes(p) && /Dependabot/i.test(w) && /bots? refuse/i.test(w)), `${name}: ${r.why.join(' | ')}`);
  }
  // Without the Dependabot flag the same files are still reviewed (R2 and R3 are unchanged).
  assert.equal((await run([file(CRITICAL, 20)])).recommended, 'coderabbit');
  assert.ok(!(await run([file('package.json', 3, 3), file(CRITICAL, 20)], { dependabot: true })).why.some((w) => w.includes('package.json') && /refuse/.test(w)), 'only the critical or parser file is named');
});

test('T3c: R1 applies only when no other rule matches: a thoughts/ file next to a critical or parser file is reviewed', async () => {
  const crit = await run([file('thoughts/x.yaml', 30), file(CRITICAL, 20)]);
  assert.equal(crit.recommended, 'coderabbit', 'R3 beats R1');
  assert.deepEqual(crit.budget, [1, 2]);
  const parser = await run([file('thoughts/x.yaml', 30), file(PARSER, 20)]);
  assert.equal(parser.recommended, 'coderabbit', 'R2 beats R1');
  assert.deepEqual(parser.budget, [1, 0]);
});

test('T4 (R2): a parser tag alone gives coderabbit with budget 1+0 and the do-not-loop line', async () => {
  const r = await run([file(PARSER, 80)]);
  assert.equal(r.recommended, 'coderabbit');
  assert.deepEqual(r.budget, [1, 0]);
  assert.ok(r.why.some((w) => /Do not loop\. Use a vetted parser\./.test(w)), r.why.join(' | '));
});

test('T5 (R2+R3): parser plus critical gives the class budget and keeps the parser line', async () => {
  const r = await run([file(PARSER, 80), file(CRITICAL, 20)]);
  assert.equal(r.recommended, 'coderabbit', 'Greptile is held (deep_enabled false)');
  assert.deepEqual(r.budget, [1, 2], 'the largest budget of any matched rule');
  assert.ok(r.why.some((w) => /Do not loop\. Use a vetted parser\./.test(w)), r.why.join(' | '));
});

test('T6 (R2+R4): parser plus SQL gives r3 with budget 1+2', async () => {
  const r = await run([file(PARSER, 80), file(SQL, 12)]);
  assert.equal(r.class, 'r3');
  assert.equal(r.recommended, 'coderabbit');
  assert.deepEqual(r.budget, [1, 2]);
});

test('T7 (R3): a critical file with Greptile held gives coderabbit and shows the hold reason', async () => {
  const r = await run([file(CRITICAL, 30)]);
  assert.equal(r.recommended, 'coderabbit');
  const both = optionOf(r, 'both');
  assert.ok(both, 'the held option is still listed');
  assert.equal(both.available, false);
  assert.match(both.reason, /apex_d3/);
  assert.ok(r.why.some((w) => /apex_d3/.test(w)), r.why.join(' | '));
});

test('T8 (R3): a critical file with Greptile available gives both', async () => {
  const r = await run([file(CRITICAL, 30)], {}, { deep: true, used: 10 });
  assert.equal(r.recommended, 'both');
  assert.equal(optionOf(r, 'both').available, true);
  assert.deepEqual(r.budget, [1, 2]);
});

test('T9: deep_enabled true with unknown credits never gives an available Greptile option', async () => {
  for (const files of [[file(CRITICAL, 30)], [file(SQL, 12)]]) {
    const r = await run(files, {}, { deep: true, used: null });
    assert.equal(r.recommended, 'coderabbit', files[0].filename);
    assert.ok(r.options.every((o) => o.pathway !== 'both' || o.available === false), files[0].filename);
  }
});

test('T9b: under 3 credits left is not available; exactly 3 left is (r3 is never held by u2)', async () => {
  const two = await run([file(SQL, 12)], {}, { deep: true, used: LIVE.greptile.monthly_credits - 2 });
  assert.equal(two.recommended, 'coderabbit');
  assert.equal(optionOf(two, 'both')?.available, false);
  const three = await run([file(SQL, 12)], {}, { deep: true, used: LIVE.greptile.monthly_credits - 3 });
  assert.equal(three.recommended, 'both');
});

test('T10: at u2 a non-r3 class is held with the credit reason; r3 is not held', async () => {
  const used = LIVE.greptile.u2_used + 1;
  const steering = await run([file(CRITICAL, 30)], {}, { deep: true, used });
  assert.equal(steering.recommended, 'coderabbit');
  assert.match(optionOf(steering, 'both').reason, /credits_u2/);
  const r3 = await run([file(SQL, 12)], {}, { deep: true, used });
  assert.equal(r3.recommended, 'both');
});

test('T11: the capacity bands: 39 no change, 40 and 49 warn, 50 makes wait the default', async () => {
  const at = (count, cli = { bySeverity: { major: 1 } }) => run([file('scripts/a.mjs', 20)], { cli }, { count });
  const r39 = await at(39);
  assert.equal(r39.capacity.band, 'ok');
  assert.ok(!r39.capacity.warning);
  assert.equal(r39.recommended, 'coderabbit');
  for (const n of [40, 49]) {
    const r = await at(n);
    assert.equal(r.capacity.band, 'warn', String(n));
    assert.match(r.capacity.warning, /6\/h at 40, 4\/h at 50/, String(n));
    assert.equal(r.recommended, 'coderabbit', `${n}: a warning never blocks or changes the default`);
  }
  const r50 = await at(50);
  assert.equal(r50.capacity.band, 'high');
  assert.equal(r50.recommended, 'wait');
  assert.equal(r50.options[0].pathway, 'wait');
  assert.equal(r50.options[1].pathway, 'coderabbit', 'option 2 is the rule pathway');
  assert.ok(!pathways(r50).includes('none'), 'a non-clean CLI offers no none');
  const clean = await at(60, { bySeverity: {} });
  assert.deepEqual(pathways(clean).slice(0, 3), ['wait', 'coderabbit', 'none'], 'option 3 is none when the CLI is clean');
});

test('T11b: at 50 the wait default and the none option belong to R5 only; R2, R3 and R4 results keep coderabbit and never offer none', async () => {
  for (const [name, p] of [['critical (R3)', CRITICAL], ['sql (R4)', SQL], ['parser (R2)', PARSER]]) {
    const high = await run([file(p, 20)], { cli: { bySeverity: { major: 1 } } }, { count: 55 });
    assert.equal(high.capacity.band, 'high', name);
    assert.equal(high.recommended, 'coderabbit', `${name}: the capacity default is R5 only`);
    assert.ok(!pathways(high).includes('wait'), name);
    const clean = await run([file(p, 20)], { cli: { bySeverity: {} } });
    assert.ok(!pathways(clean).includes('none'), `${name}: a clean CLI offers none for R5 only`);
  }
});

test('T12: an unknown 7-day count changes no rule', async () => {
  const unknown = await run([file('scripts/a.mjs', 20)], {}, { count: null });
  const known = await run([file('scripts/a.mjs', 20)], {}, { count: 10 });
  assert.equal(unknown.capacity.band, 'unknown');
  assert.equal(unknown.recommended, known.recommended);
  assert.deepEqual(unknown.options, known.options);
  assert.deepEqual(unknown.why, known.why);
  assert.deepEqual(unknown.budget, known.budget);
});

test('T13: the old path of a rename raises the class, and the rename counts as one file', async () => {
  const r = await run([file('notes/y.txt', 5, 5, SQL)]);
  assert.equal(r.class, 'r3');
  assert.equal(r.matched.r3, 1);
  assert.deepEqual(r.budget, [1, 2]);
  assert.equal(r.size.files, 1);
});

test('T14 (R0): no stamp, or a failed stamp row, stops with no options; NOTE and SKIP rows do not stop', async () => {
  const stop = (r, label) => {
    assert.equal(r.recommended, null, label);
    assert.deepEqual(r.options, [], label);
    assert.ok(r.why.some((w) => /pre-pr\.mjs/.test(w)), `${label}: ${r.why.join(' | ')}`);
  };
  stop(await run([file('scripts/a.mjs')], { stamp: null }), 'no stamp');
  const failed = { ...PASS_STAMP, results: [...PASS_STAMP.results, { step: 'gate:tests', status: 'FAIL', detail: 'x' }] };
  stop(await run([file('scripts/a.mjs')], { stamp: failed }), 'failed row');
  const soft = { ...PASS_STAMP, results: [...PASS_STAMP.results, { step: 'manual:x', status: 'NOTE', detail: 'x' }, { step: 'coderabbit', status: 'SKIP', detail: 'cap' }] };
  assert.equal((await run([file('scripts/a.mjs')], { stamp: soft })).recommended, 'coderabbit');
});

test('T15 (R0): a stamp for another head stops', async () => {
  const r = await run([file('scripts/a.mjs')], { stamp: { ...PASS_STAMP, head: OTHER } });
  assert.equal(r.recommended, null);
  assert.deepEqual(r.options, []);
  assert.ok(r.why.some((w) => /pre-pr\.mjs/.test(w)));
});

test('T16 (R5): the default stays coderabbit; none is offered only when the CLI shows 0 Major', async () => {
  const clean = await run([file('scripts/a.mjs', 20)], { cli: { bySeverity: { minor: 2 } } });
  assert.equal(clean.recommended, 'coderabbit');
  assert.ok(pathways(clean).includes('none'));
  assert.equal(pathways(clean)[1], 'none', 'none is option 2');
  for (const [label, cli] of [['major finding', { bySeverity: { major: 1 } }], ['critical finding', { bySeverity: { critical: 1 } }], ['unknown', null]]) {
    const r = await run([file('scripts/a.mjs', 20)], { cli });
    assert.equal(r.recommended, 'coderabbit', label);
    assert.ok(!pathways(r).includes('none'), label);
  }
});

test('T17: option 1 is the recommendation', async () => {
  for (const [files, pol] of [[[file('scripts/a.mjs')], {}], [[file(CRITICAL)], { deep: true, used: 10 }], [[file('docs/a.md')], {}], [[file('scripts/a.mjs')], { count: 55 }]]) {
    const r = await run(files, {}, pol);
    assert.equal(r.options[0].pathway, r.recommended, files[0].filename);
  }
});

test('T18: recommend is pure: frozen inputs are not mutated and the same input gives the same result', async () => {
  const { recommend } = await load();
  const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
  const f = deepFreeze(facts([file(CRITICAL), file('scripts/b.mjs')]));
  const p = deepFreeze(await policy({ deep: true, used: 10 }));
  assert.deepEqual(recommend(f, p), recommend(f, p));
});

test('T18b: recommend takes the time from facts.now and never reads the clock', async () => {
  const { recommend } = await load();
  const p = await policy();
  const pinned = { ...p, greptile: { ...p.greptile, u3_date: '2026-11-03' } };
  const before = recommend(facts([file(CRITICAL)], { now: '2026-11-02T12:00:00.000Z' }), pinned);
  const after = recommend(facts([file(CRITICAL)], { now: '2026-11-04T12:00:00.000Z' }), pinned);
  assert.equal(before.credits.u3_due, false);
  assert.equal(after.credits.u3_due, true, 'the real clock (before 2026-11-03) would give false');
});

test('T19: pathFiltersFrom reads reviews.path_filters of the real .coderabbit.yaml and nothing else', async () => {
  const { pathFiltersFrom } = await load();
  const filters = pathFiltersFrom(YAML);
  for (const want of ['!**/dist/**', '!.claude/hooks/dist/**', '!**/package-lock.json', '!**/*.lock']) assert.ok(filters.includes(want), `${want} in ${filters.join(' ')}`);
  for (const alien of ['review:coderabbit', 'review:deep', '^main$']) assert.ok(!filters.includes(alien), `${alien} is not a path filter`);
  assert.ok(filters.every((f) => !/\s|#/.test(f)), 'quotes and comments are stripped');
});

test('T20: the config blocks exist and are typed', () => {
  assert.equal(typeof LIVE.budget, 'object');
  for (const k of ['docs', 'normal', 'steering', 'infra', 'r3']) assert.ok(k in LIVE.budget, `budget.${k}`);
  assert.ok(Array.isArray(LIVE.checkpoint?.critical) && LIVE.checkpoint.critical.length > 0, 'checkpoint.critical');
  assert.ok(Array.isArray(LIVE.checkpoint?.parser), 'checkpoint.parser');
  assert.ok(LIVE.coderabbit && 'reviews_7d_manual' in LIVE.coderabbit && 'reviews_7d_manual_date' in LIVE.coderabbit, 'coderabbit.reviews_7d_manual and its date');
  const n = LIVE.coderabbit?.reviews_7d_manual;
  assert.ok(n === null || (Number.isInteger(n) && n >= 0), 'a count or null');
  // The five critical files of spec section 2 are all tagged, and an ordinary hook is not.
  const hit = (p) => LIVE.checkpoint.critical.some((g) => matchGlob(g, p));
  for (const p of [CRITICAL, 'scripts/github/review-status.mjs', 'scripts/github/review-router.mjs', '.claude/hooks/src/destructive-command-guard.ts', 'scripts/github/land-pr.ps1']) assert.ok(hit(p), `${p} is critical`);
  assert.ok(!hit('.claude/hooks/src/session-start.ts'), 'an ordinary hook is not critical');
});

// ---------- CLI: the way the harness runs it ----------

function runCli(args, factsObj) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'checkpoint-'));
  const factsFile = path.join(dir, 'facts.json');
  const cfgFile = path.join(dir, 'config.json');
  if (factsObj) writeFileSync(factsFile, JSON.stringify(factsObj));
  writeFileSync(cfgFile, JSON.stringify({ ...LIVE, deep_enabled: false, greptile: { ...LIVE.greptile, credits_used_manual: null }, coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null } }));
  const r = spawnSync(process.execPath, [path.join(HERE, 'pr-checkpoint.mjs'), ...args, '--facts', factsFile, '--config', cfgFile], { encoding: 'utf8', cwd: dir });
  return { ...r, dir };
}

test('T21 (CLI): --json prints the whole output shape as one JSON object and exits 0', () => {
  const r = runCli(['--json'], facts([file(CRITICAL, 30), file('scripts/b.mjs', 5)]));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const shape = ['head', 'class', 'matched', 'size', 'checks', 'cli', 'credits', 'capacity', 'recommended', 'options', 'why', 'budget', 'config_drift'];
  assert.deepEqual(Object.keys(out).sort(), [...shape].sort());
  assert.equal(out.head, HEAD);
  assert.equal(out.recommended, 'coderabbit');
});

test('T22 (CLI): --confirm and --apply are PR B; they exit 2 and write no pathway.json (not in cwd, not in the repo root)', () => {
  const rootRecord = path.join(ROOT, '.claude', 'cache', 'pre-pr', 'pathway.json');
  const stamp = () => (existsSync(rootRecord) ? statSync(rootRecord).mtimeMs : null);
  const before = stamp();
  for (const mode of [['--confirm', 'none', '--by', 'dave'], ['--apply', '201']]) {
    const r = runCli(mode, facts([file('scripts/a.mjs')]));
    assert.equal(r.status, 2, `${mode[0]}: ${r.stdout} ${r.stderr}`);
    assert.ok(!existsSync(path.join(r.dir, '.claude', 'cache', 'pre-pr', 'pathway.json')), mode[0]);
    assert.equal(stamp(), before, `${mode[0]}: the repo-root pathway.json is untouched`);
  }
});

test('T23: parseNameStatus keeps the old path of a rename, so the class of the old file counts', async () => {
  const { parseNameStatus } = await load();
  const rows = parseNameStatus('R100\tdb/migrations/001.sql\tnotes/y.txt\nM\tscripts/a.mjs\nD\tgone.txt\nA\tnew file.txt\n');
  const pick = ({ filename, previous_filename }) => ({ filename, previous_filename });
  assert.deepEqual(rows.map(pick), [
    { filename: 'notes/y.txt', previous_filename: 'db/migrations/001.sql' },
    { filename: 'scripts/a.mjs', previous_filename: undefined },
    { filename: 'gone.txt', previous_filename: undefined },
    { filename: 'new file.txt', previous_filename: undefined },
  ]);
  assert.deepEqual(parseNameStatus('').map(pick), [], 'an empty diff has no files');
});

// ---------- fix round 1 (critic findings): option pricing, Dependabot options, base ref, usage ----------

test('T24: each option is priced from its own pathway, not from the recommendation', async () => {
  // R1 (docs): the coderabbit option is not free. CodeRabbit opens one review at least.
  const docs = await run([file('docs/guide.md', 40)]);
  assert.equal(docs.recommended, 'none');
  assert.ok(pathways(docs).includes('coderabbit'), 'a docs PR still offers coderabbit');
  assert.notDeepEqual(optionOf(docs, 'coderabbit').cost, [0, 0], 'R1 coderabbit option');
  assert.ok(optionOf(docs, 'coderabbit').cost[0] >= 1);
  assert.deepEqual(optionOf(docs, 'none').cost, [0, 0]);
  // R1 (quiet dir, class normal): the coderabbit option costs the class budget 1+1.
  const quiet = await run([file('.claudedocs/probe-output.json', 30)]);
  assert.deepEqual(optionOf(quiet, 'coderabbit').cost, [1, 1], 'class budget of the paths');
  // R2 alone is 1+0 for coderabbit; the both option adds a Greptile round, so it costs more than 1+0.
  const parser = await run([file(PARSER, 80)]);
  assert.deepEqual(optionOf(parser, 'coderabbit').cost, [1, 0], 'R2 coderabbit keeps 1+0');
  const both = optionOf(parser, 'both').cost;
  assert.notDeepEqual(both, [0, 0]);
  assert.notDeepEqual(both, [1, 0], 'R2 both option must not cost the same as coderabbit alone');
  assert.ok(both[1] >= 1, 'the second slot carries the Greptile final-head review');
});

test('T25 (Dave decision 3): a Dependabot PR offers only none, even when it touches a critical file', async () => {
  for (const files of [[file('package.json', 3, 3)], [file('package.json', 3, 3), file(CRITICAL, 20)]]) {
    const r = await run(files, { dependabot: true });
    assert.equal(r.recommended, 'none');
    assert.deepEqual(pathways(r), ['none'], files.map((f) => f.filename).join());
  }
});

test('T26: isDependabotAuthors is true only when every commit author is dependabot[bot]', async () => {
  const { isDependabotAuthors } = await load();
  const bot = '49699333+dependabot[bot]@users.noreply.github.com';
  assert.equal(isDependabotAuthors(`${bot}\n${bot}\n`), true);
  assert.equal(isDependabotAuthors(`${bot}\ndave@example.com\n`), false, 'a human commit on the branch makes it a human PR');
  assert.equal(isDependabotAuthors(''), false, 'no commits is not Dependabot');
  assert.equal(isDependabotAuthors('someone@notdependabot[bot]@users.noreply.github.com'), false);
});

test('T27: resolveBase names the base ref and commit, and warns when the ref may be stale', async () => {
  const { resolveBase } = await load();
  const sha = 'abcdef1234567890';
  const ok = resolveBase({ fetched: true, hasFork: true, sha });
  assert.equal(ok.ref, 'fork/main');
  assert.match(ok.notes.join(' '), /fork\/main at abcdef1/);
  assert.doesNotMatch(ok.notes.join(' '), /stale/i);
  const stale = resolveBase({ fetched: false, hasFork: true, sha });
  assert.equal(stale.ref, 'fork/main');
  assert.match(stale.notes.join(' '), /fetch.*failed.*stale/i);
  const local = resolveBase({ fetched: false, hasFork: false, sha });
  assert.equal(local.ref, 'main');
  assert.match(local.notes.join(' '), /local main.*stale/i);
});

test('T28: facts.notes reach why[], also on the R0 stop', async () => {
  const note = 'Base fork/main at abcdef1 (fetched).';
  assert.ok((await run([file('scripts/a.mjs')], { notes: [note] })).why.includes(note));
  assert.ok((await run([file('scripts/a.mjs')], { notes: [note], stamp: null })).why.includes(note));
});

test('T29 (CLI): --dependabot sets the flag the mod passes, and the result is none', () => {
  const r = runCli(['--json', '--dependabot'], facts([file('package.json', 3, 3), file(CRITICAL, 20)]));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.recommended, 'none');
  assert.ok(out.why.some((w) => w.includes(CRITICAL)));
});

test('T30 (CLI): bad usage exits 2: an unknown flag, or --facts or --config without a value', () => {
  const cli = path.join(HERE, 'pr-checkpoint.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'checkpoint-usage-'));
  for (const args of [['--bogus'], ['--facts'], ['--config'], ['--facts', '--json'], ['--json', '--config']]) {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: dir });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, /usage/i, args.join(' '));
  }
});
