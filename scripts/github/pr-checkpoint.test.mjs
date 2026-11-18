// Tests for pr-checkpoint.mjs: PR A (the read-only recommendation engine) and PR B (--confirm and --apply, the pathway record).
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
//   result = { head, class, matched, size:{files,lines,added}, checks, cli, credits (the creditsState() object, so credits.u3_due follows facts.now),
//              capacity:{count,band,warning,...}, recommended, options:[{pathway,label,available,cost,reason}],
//              why:[string], budget:[coderabbit,greptile], config_drift, config_drift_why (the warning text or null) }
//   pathway: 'none' | 'coderabbit' | 'both' | 'wait'. band: 'unknown' | 'ok' | 'warn' | 'high'.
//   R0 (stop): recommended null, options [], a why line that says to run pre-pr.mjs.
//   Config keys: budget, checkpoint.critical, checkpoint.parser, coderabbit.reviews_7d_manual and coderabbit.reviews_7d_manual_date.
//   R5 is the fallback: it runs only when R2, R3 and R4 did not match, and it needs reviewable lines (T2).
//   CLI seams: node pr-checkpoint.mjs --json [--facts facts.json] [--config router-config.json]. --facts replaces the git and stamp reads
//   (a fixture, like review-router.mjs --fixture).
//
// PR B contract (tests TB*, TA*, T5*, T20b, T22 below; spec sections 1, 3.1, 5, 6 and the PR B row of 7):
//   export PATHWAY_REL = '.claude/cache/pre-pr/pathway.json'      the file the pre-pr-gate hook reads (same dir as STAMP_REL)
//   --confirm <none|coderabbit|both> --by <dave|default> --body <file> [--state-dir <dir>] [--facts f] [--config c]
//       --body       the PR body file; its sha256 (pre-pr.mjs hashes the text the same way) must equal stamp.body_sha256.
//       --state-dir  the dir that holds stamp.json (real run) and pathway.json (default <repo>/.claude/cache/pre-pr). Test seam, like --facts.
//       Refuses (exit 1, stderr names the reason, nothing written) when: the stamp is missing, for another head or has a FAIL row (R0);
//       the body hash differs from the stamp; the pathway is wait, or is not an option of the result, or is a held option.
//       Writes pathway.json { head, body_sha256, pathway, label, class, recommended, decided_by, at, budget } and prints the same JSON, exit 0.
//       head, body_sha256: from the stamp; class: result.class; recommended: result.recommended (may be "wait");
//       at: facts.now; label: review:none | review:coderabbit | review:deep.
//       budget = option.budget (Dave 11-04): coderabbit the price its option shows (option.cost), both max(rule budget, class budget) and never
//       the display-only 1+1 floor of both.cost, none and wait [0,0]; never below [1,0] for coderabbit or both.
//       --body is required: a --confirm with no --body (or --body with no value) is bad usage, exit 2, nothing written (T22).
//       Stamp source: facts.stamp when the facts carry a `stamp` key (the fixture seam, TB1-TB7); when the facts have NO `stamp` key,
//       <state-dir>/stamp.json is read (the production path, TB8). A missing or unreadable stamp.json is the R0 refusal.
//       Default state dir (no --state-dir): <git toplevel of the cwd>/.claude/cache/pre-pr, i.e. PATHWAY_REL under the toplevel, the place
//       pre-pr.mjs and the hook use. Never next to the script, never the bare cwd (TB9).
//   --apply <pr>  [--state-dir <dir>]            reads pathway.json, then talks to gh. Exit 1 on a refusal or a gh failure.
//       --apply takes only --state-dir (and the PR number). It does not take --facts, --config or --body (runB sends them for --confirm only).
//       The refusals name their reason on stderr: "draft" for a PR that is not a draft, "head" for a moved head, "pathway" for a missing record (TA6).
//   export applyPathway({ pr, record, gh }) -> { ok: true } | { ok: false, error }     gh(args) -> { status, stdout, stderr }
//       gh call shapes (pinned; every call ends with '-R', DEFAULT_REPO so gh never picks the repo from the cwd remotes, where origin is parcadei):
//                                read   ['pr','view',String(pr),'--json','isDraft,headRefOid,labels','-R',repo] -> stdout {"isDraft":bool,"headRefOid":sha,"labels":[{name}]}
//                                label  ['pr','edit',String(pr),'--add-label',<label>,'-R',repo]
//                                comment ['pr','comment',String(pr),'--body',<marker + visible line>,'-R',repo]  (PR D: the router reads the marker)
//                                ready  ['pr','ready',String(pr),'-R',repo]
//       Order: read, refuse (not a draft, or headRefOid != record.head), label, comment, ready. A failed label or comment never reaches ready.
//   CLI gh seam: env PR_CHECKPOINT_GH=<script.mjs> runs `node <script.mjs> <gh args>` in place of gh (tests; never a real gh).
//   Exit codes: 0 done, 1 refused or gh failed, 2 bad usage (before anything is read or written), 3 internal error.
//
// PR B, config: checkpoint.enforce (boolean; false was the warn week, PR D flips it to true) in review-router.config.json; read by the pre-pr-gate hook.
// PR B, Dave decision 2026-10-28: R2 (parser) budget 1+0 wins over R3 (critical); R4 (r3 class) still gives 1+2.
//
// How the unit can fail, and the test that catches it:
//   R0  stamp missing, for another head, or with a failed row is ignored          -> T14, T15
//   R0  a NOTE or SKIP row in the stamp stops the checkpoint                      -> T14
//   R1  docs class is reviewed                                                    -> T1
//   R1  a diff with only filtered paths (dist, lock files) is reviewed            -> T2
//   size counts lines of filtered paths, or counts a rename once                  -> T2b, T13
//   R5  the class budget lookup is wrong (normal, infra, steering 1+1; r3 1+2)    -> T2b, PD10
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
//   R5  the capacity bands (29/30/39/40) shift, or "wait" is not first at 40      -> PD8 (was T11 at 40/50; PR D moved the bands to 30/40)
// PR D (rule RS, the small PR):
//   RS  missing, or a small PR with a clean CLI is not none                       -> PD1
//   RS  off by one on 3 files or 30 added lines                                   -> PD2
//   RS  counts deletions, or filtered files                                       -> PD3, PD4
//   RS  a Major, Critical or missing CLI result still gets none                   -> PD5
//   RS  beats R1 to R4 or Dependabot                                              -> PD6
//   RS  coderabbit option costs the class budget, not 1+0                         -> PD7
//   RS  none waits at a high 7-day count (Dave decision a)                        -> PD9
//   steering and infra budget is not 1+1, or r3 is not 1+2                        -> PD10
//   the budget _doc keeps "extra after fix pushes"                                -> PD12
//   the CLI --json loses the small-PR result                                      -> PD11
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
//   --confirm or --apply with bad usage writes or reads anything                  -> T22 (was the PR A "not available" test, replaced in PR B)
// PR B:
//   confirm records a body that is not the stamped body                           -> TB1 (spec 16)
//   confirm records for a missing stamp, another head or a failed stamp row       -> TB2 (spec 16)
//   the record loses a field, or stdout differs from the file                     -> TB3
//   both records the display-only 1+1 floor, or coderabbit loses its option price -> TB4, TB4b, TB4c (Dave 11-04, TREX N9)
//   none is recorded with a budget, or its label is wrong                         -> TB5
//   confirm records a pathway that was not offered, is held, or is wait           -> TB6
//   coderabbit over a docs recommendation gets budget 0, or "wait" is lost        -> TB7
//   bad usage reads or writes something, or --confirm works with no --body        -> T22
//   --confirm trusts facts.stamp only, so the stamp.json read and head check are untested  -> TB8
//   the default state dir is script-relative or cwd-relative, so the hook never sees the record  -> TB9
//   apply spends on a non-draft PR or a head that moved                           -> TA1, TA2 (spec 17)
//   apply marks ready before the label, or after a failed label                   -> TA3, TA4 (spec 18)
//   the wired CLI skips the checks, or calls the real gh                          -> TA5, TA6 (TA6 pins the one gh read, so a CLI that ignores PR_CHECKPOINT_GH fails)
//   R2 budget loses to R3, R2 swallows R4, or the parser line is lost             -> T5, T5b, T5c, T5d (spec 5, Dave 2026-10-28)
//   checkpoint.enforce is missing or not a boolean                                -> T20b
//   the pathway.json path drifts from the one the hook reads                      -> T20c
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPO, matchGlob } from './review-router.mjs';
import { makeTempDir, registerTempCleanup } from '../lib/temp-tracker.mjs';

registerTempCleanup();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
// These tests cover the plain (flag off) confirm path. checkpoint.ledger is on in the live config (Dave 2026-11-07), so pin it off here; pr-checkpoint-ledger.test.mjs covers the flag on.
const LIVE = (() => { const c = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8')); c.checkpoint = { ...c.checkpoint, ledger: false }; return c; })();
const YAML = readFileSync(path.join(ROOT, '.coderabbit.yaml'), 'utf8');
const NOW = '2026-10-28T12:00:00.000Z';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const load = () => import('./pr-checkpoint.mjs');

/**
 * The live config with the switches pinned, so editing deep_enabled, the credit count or the 7-day count in the
 * live file cannot change a result. checkpoint.critical, budget and classes come from the live file (the contract).
 * checkpoint.parser is pinned to a test glob: the live list is a data choice, not behaviour.
 * matrix is dropped (review matrix, Step C2): these tests cover the rule set R1 to R5 and RS, which a policy without a matrix block
 * keeps. With the live matrix block the band decides instead; review-router-band.test.mjs covers that path.
 */
async function policy({ deep = false, used = null, count = null } = {}) {
  const { pathFiltersFrom } = await load();
  return {
    ...LIVE,
    matrix: undefined,
    deep_enabled: deep,
    greptile: { ...LIVE.greptile, credits_used_manual: used },
    coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: count, reviews_7d_manual_date: null },
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
// PR D: a PR of 3 files or fewer and 30 added lines or fewer is "small" (rule RS). R5 tests need a PR over that limit.
// 4 files, 40 added lines, 2 deleted lines, class normal.
const R5_FILES = [file('scripts/a.mjs', 10, 2), file('scripts/b.mjs', 10), file('scripts/c.mjs', 10), file('scripts/d.mjs', 10)];
/** `n` files of 10 added lines each, all under `dir` with extension `ext`. */
const filesIn = (dir, ext, n = 3) => Array.from({ length: n }, (_, i) => file(`${dir}/f${i}.${ext}`, 10));
const CLEAN = { bySeverity: { minor: 1 } };
const MAJOR = { bySeverity: { major: 1 } };

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

test('T2b: size counts additions and deletions of unfiltered paths only (PD: moved to R5_FILES; size gains `added`)', async () => {
  const r = await run([...R5_FILES, file('.claude/hooks/dist/x.mjs', 500), file('package-lock.json', 900)]);
  assert.deepEqual(r.size, { files: 4, lines: 42, added: 40 });
  assert.equal(r.recommended, 'coderabbit');
  assert.deepEqual(r.budget, [1, 1], 'class normal: budget 1+1');
});

// T2c is replaced by PD10 (the steering and infra budget is 1+1 now, and the PR must be over the small limit to reach R5).

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
  assert.deepEqual(crit.budget, [1, 1], 'PD: the steering class budget is 1+1 now');
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

// PR B replaces the PR A test T5 (spec test 5). PR A pinned "the largest budget of any matched rule" = [1, 2] for parser plus
// critical. Dave decided on 2026-10-28 that R2 (parser) wins over R3 (critical): a parser PR is never looped, so budget 1+0.
test('T5 (R2+R3, Dave 2026-10-28): parser plus critical gives budget 1+0 (R2 wins over R3) and keeps the parser line', async () => {
  const r = await run([file(PARSER, 80), file(CRITICAL, 20)]);
  assert.equal(r.recommended, 'coderabbit', 'Greptile is held (deep_enabled false)');
  assert.deepEqual(r.budget, [1, 0], 'R2 budget 1+0 beats the R3 class budget 1+2');
  assert.ok(r.why.some((w) => /Do not loop\. Use a vetted parser\./.test(w)), r.why.join(' | '));
});

test('T5b (R2+R3): one file that is both parser and critical gets 1+0 (the live case: the two *-guard.ts parser files)', async () => {
  const { recommend } = await load();
  const both = '.claude/hooks/src/package-install-guard.ts';
  const p = { ...(await policy()), checkpoint: { ...LIVE.checkpoint, parser: [both] } };
  assert.ok(LIVE.checkpoint.critical.some((g) => matchGlob(g, both)), 'the fixture file is critical in the live config');
  const r = recommend(facts([file(both, 60)]), p);
  assert.equal(r.recommended, 'coderabbit');
  assert.deepEqual(r.budget, [1, 0]);
  assert.ok(r.why.some((w) => /Do not loop\. Use a vetted parser\./.test(w)), r.why.join(' | '));
});

test('T5c (R2+R3+R4): R2 wins over R3 only; an r3-class file in the same PR keeps budget 1+2', async () => {
  const r = await run([file(PARSER, 80), file(CRITICAL, 20), file(SQL, 12)]);
  assert.equal(r.class, 'r3');
  assert.deepEqual(r.budget, [1, 2], 'R4 is not R3: the r3 class budget stays');
});

test('T5d (R2+R3, Greptile available): the pathway stays both, and the rule budget is 1+0', async () => {
  const r = await run([file(PARSER, 80), file(CRITICAL, 20)], {}, { deep: true, used: 10 });
  assert.equal(r.recommended, 'both', 'R3 still raises the pathway');
  assert.deepEqual(r.budget, [1, 0]);
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
  assert.deepEqual(r.budget, [1, 1], 'PD: the steering class budget is 1+1 now');
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

// PD8 replaces T11 (PR D): the bands moved from 40/50 to 30/40, and the PR must be over the small limit (R5_FILES).
test('PD8 (R5, replaces T11): the capacity bands: 29 no change, 30 and 39 warn, 40 makes wait the default', async () => {
  const at = (count, cli = MAJOR) => run(R5_FILES, { cli }, { count });
  const r29 = await at(29);
  assert.equal(r29.capacity.band, 'ok');
  assert.ok(!r29.capacity.warning);
  assert.equal(r29.recommended, 'coderabbit');
  for (const n of [30, 39]) {
    const r = await at(n);
    assert.equal(r.capacity.band, 'warn', String(n));
    assert.match(r.capacity.warning, /warn at 30/, String(n));
    assert.equal(r.capacity.warning, `CodeRabbit 7-day count is ${n}: warn at 30; the rate drops to 6/h at 40.`, String(n));
    assert.equal(r.recommended, 'coderabbit', `${n}: a warning never blocks or changes the default`);
  }
  const r40 = await at(40);
  assert.equal(r40.capacity.band, 'high');
  assert.equal(r40.recommended, 'wait');
  assert.equal(r40.options[0].pathway, 'wait');
  assert.equal(r40.options[1].pathway, 'coderabbit', 'option 2 is the rule pathway');
  assert.ok(!pathways(r40).includes('none'), 'a non-clean CLI offers no none');
  assert.ok(r40.why.some((w) => /40 or more/.test(w)), r40.why.join(' | '));
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

// ---------- PR D: rule RS (a small PR with a clean CLI review gets none) ----------

test('PD1 (RS): 3 files and 30 added lines with a clean CLI give none at budget 0+0; coderabbit is option 2; any class normal, steering or infra', async () => {
  for (const [name, files] of [['normal', filesIn('scripts', 'mjs')], ['steering', filesIn('.claude/agents', 'md')], ['infra', filesIn('.github/workflows', 'yml')]]) {
    const r = await run(files, { cli: CLEAN });
    assert.equal(r.class, name);
    assert.equal(r.size.added, 30, name);
    assert.equal(r.recommended, 'none', name);
    assert.deepEqual(r.budget, [0, 0], name);
    assert.deepEqual(pathways(r).slice(0, 2), ['none', 'coderabbit'], name);
    assert.ok(r.why.some((w) => /small/i.test(w)), `${name}: ${r.why.join(' | ')}`);
  }
  const zero = await run(filesIn('scripts', 'mjs'), { cli: { bySeverity: {} } });
  assert.equal(zero.recommended, 'none', 'a CLI run with no findings is clean');
});

test('PD2 (RS): the limit is exact: 4 files, or 31 added lines, fall to R5', async () => {
  const four = await run(filesIn('scripts', 'mjs', 4).map((f) => ({ ...f, additions: 5 })), { cli: CLEAN });
  assert.equal(four.recommended, 'coderabbit', '4 files of 5 lines');
  assert.ok(!four.why.some((w) => /small/i.test(w)), four.why.join(' | '));
  assert.deepEqual(four.budget, [1, 1]);
  const thirtyOne = await run([file('scripts/a.mjs', 31)], { cli: CLEAN });
  assert.equal(thirtyOne.recommended, 'coderabbit', '1 file of 31 added lines');
  assert.ok(!thirtyOne.why.some((w) => /small/i.test(w)), thirtyOne.why.join(' | '));
  assert.equal((await run([file('scripts/a.mjs', 30)], { cli: CLEAN })).recommended, 'none', '30 added lines is still small');
  assert.equal((await run(filesIn('scripts', 'mjs', 3), { cli: CLEAN })).recommended, 'none', '3 files is still small');
});

test('PD3 (RS): deletions do not count toward the limit: +30 -200 is small', async () => {
  const r = await run([file('scripts/a.mjs', 30, 200)], { cli: CLEAN });
  assert.equal(r.size.added, 30);
  assert.equal(r.size.lines, 230, 'lines still counts additions plus deletions');
  assert.equal(r.recommended, 'none');
  const over = await run([file('scripts/a.mjs', 31, 0)], { cli: CLEAN });
  assert.equal(over.recommended, 'coderabbit');
});

test('PD4 (RS): filtered files (dist, lock files) count toward neither the file limit nor the added limit', async () => {
  const r = await run([...filesIn('scripts', 'mjs', 3), file('.claude/hooks/dist/x.mjs', 500), file('package-lock.json', 900)], { cli: CLEAN });
  assert.deepEqual(r.size, { files: 3, lines: 30, added: 30 });
  assert.equal(r.recommended, 'none');
});

test('PD5 (RS): a Major, a Critical or a missing CLI result on a small PR gives coderabbit at 1+0 and offers no none', async () => {
  for (const [label, cli] of [['major', { bySeverity: { major: 1 } }], ['critical', { bySeverity: { critical: 1 } }], ['no CLI result', null]]) {
    const r = await run(filesIn('scripts', 'mjs'), { cli });
    assert.equal(r.recommended, 'coderabbit', label);
    assert.deepEqual(r.budget, [1, 0], label);
    assert.ok(!pathways(r).includes('none'), label);
    assert.deepEqual(pathways(r).slice(0, 2), ['coderabbit', 'both'], label);
    assert.deepEqual(optionOf(r, 'coderabbit').cost, [1, 0], label);
    assert.ok(r.why.some((w) => /Major|Critical|no (completed )?CLI/i.test(w)), `${label}: ${r.why.join(' | ')}`);
  }
});

test('PD6 (RS): RS never beats a stronger rule: critical, parser, r3, docs and Dependabot files at 5 lines keep their result', async () => {
  const crit = await run([file(CRITICAL, 5)], { cli: CLEAN });
  assert.equal(crit.recommended, 'coderabbit', 'R3');
  assert.deepEqual(crit.budget, [1, 1]);
  assert.ok(!pathways(crit).includes('none'));
  const parser = await run([file(PARSER, 5)], { cli: CLEAN });
  assert.equal(parser.recommended, 'coderabbit', 'R2');
  assert.deepEqual(parser.budget, [1, 0]);
  assert.ok(!pathways(parser).includes('none'));
  const sql = await run([file(SQL, 5)], { cli: CLEAN });
  assert.equal(sql.class, 'r3');
  assert.equal(sql.recommended, 'coderabbit', 'R4');
  assert.deepEqual(sql.budget, [1, 2]);
  assert.ok(!pathways(sql).includes('none'));
  const docs = await run([file('docs/guide.md', 5)], { cli: CLEAN });
  assert.equal(docs.recommended, 'none', 'R1');
  assert.ok(docs.why.some((w) => /Class docs/.test(w)), docs.why.join(' | '));
  const dep = await run([file('package.json', 3, 3)], { dependabot: true, cli: CLEAN });
  assert.deepEqual(pathways(dep), ['none'], 'Dependabot offers none only');
  const quiet = await run([file('.claudedocs/probe-output.json', 5)], { cli: CLEAN });
  assert.ok(quiet.why.some((w) => /\.claudedocs/.test(w)), `R1 text, not RS: ${quiet.why.join(' | ')}`);
});

test('PD7 (RS): the coderabbit option of a clean small PR costs 1+0, and --confirm coderabbit records budget 1+0', async () => {
  const r = await run(filesIn('scripts', 'mjs'), { cli: CLEAN });
  assert.deepEqual(optionOf(r, 'coderabbit').cost, [1, 0], 'the class budget is 1+1, but RS prices a chosen review at 1+0');
  assert.deepEqual(optionOf(r, 'none').cost, [0, 0]);
  const c = confirm('coderabbit', 'dave', { files: filesIn('scripts', 'mjs') });
  assert.equal(c.status, 0, `${c.stdout} ${c.stderr}`);
  assert.deepEqual(recordOf(c).budget, [1, 0]);
  assert.equal(recordOf(c).recommended, 'none');
  const n = confirm('none', 'default', { files: filesIn('scripts', 'mjs') });
  assert.equal(n.status, 0, `--by default may confirm the recommended none: ${n.stdout} ${n.stderr}`);
  assert.equal(recordOf(n).label, 'review:none');
});

test('PD9 (RS, Dave decision a): a clean small PR defaults to none at any 7-day count; wait goes first only when RS picks coderabbit', async () => {
  for (const count of [10, 30, 40, 70]) {
    const r = await run(filesIn('scripts', 'mjs'), { cli: CLEAN }, { count });
    assert.equal(r.recommended, 'none', String(count));
    assert.deepEqual(pathways(r), ['none', 'coderabbit', 'both'], String(count));
  }
  const major39 = await run(filesIn('scripts', 'mjs'), { cli: MAJOR }, { count: 39 });
  assert.equal(major39.recommended, 'coderabbit');
  assert.deepEqual(pathways(major39), ['coderabbit', 'both']);
  const major40 = await run(filesIn('scripts', 'mjs'), { cli: MAJOR }, { count: 40 });
  assert.equal(major40.recommended, 'wait');
  assert.deepEqual(pathways(major40), ['wait', 'coderabbit', 'both']);
  assert.ok(major40.why.some((w) => /40 or more/.test(w)), major40.why.join(' | '));
  const noCli = await run(filesIn('scripts', 'mjs'), { cli: null }, { count: 55 });
  assert.equal(noCli.recommended, 'wait', 'no CLI result: RS picks coderabbit, so wait goes first');
});

test('PD10 (R5, replaces T2c): the live budget is 1+1 for normal, steering and infra and 1+2 for r3', async () => {
  for (const [dir, ext, cls] of [['scripts', 'mjs', 'normal'], ['.claude/agents', 'md', 'steering'], ['.github/workflows', 'yml', 'infra']]) {
    const r = await run(filesIn(dir, ext, 4), { cli: CLEAN });
    assert.equal(r.class, cls);
    assert.equal(r.recommended, 'coderabbit', cls);
    assert.deepEqual(r.budget, [1, 1], cls);
    assert.deepEqual(optionOf(r, 'coderabbit').cost, [1, 1], cls);
  }
  const r3 = await run([file(SQL, 12)]);
  assert.equal(r3.class, 'r3');
  assert.deepEqual(r3.budget, [1, 2]);
});

// ---------- the config text ----------

test('PD12 (PR D): the budget _doc says an extra round comes after a Major', () => {
  const doc = LIVE._doc.find((l) => /^budget:/.test(l));
  assert.ok(doc, 'the budget line exists');
  assert.match(doc, /extra after a Major/);
  assert.doesNotMatch(doc, /extra after fix pushes/);
});

test('T12: an unknown 7-day count changes no rule (PD: moved to R5_FILES)', async () => {
  const unknown = await run(R5_FILES, {}, { count: null });
  const known = await run(R5_FILES, {}, { count: 10 });
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
  assert.equal((await run(R5_FILES, { stamp: soft })).recommended, 'coderabbit'); // PD: moved to R5_FILES (a small PR gets none)
});

test('T15 (R0): a stamp for another head stops', async () => {
  const r = await run([file('scripts/a.mjs')], { stamp: { ...PASS_STAMP, head: OTHER } });
  assert.equal(r.recommended, null);
  assert.deepEqual(r.options, []);
  assert.ok(r.why.some((w) => /pre-pr\.mjs/.test(w)));
});

test('T16 (R5): the default stays coderabbit; none is offered only when the CLI shows 0 Major', async () => {
  const clean = await run(R5_FILES, { cli: { bySeverity: { minor: 2 } } }); // PD: moved to R5_FILES
  assert.equal(clean.recommended, 'coderabbit');
  assert.ok(pathways(clean).includes('none'));
  assert.equal(pathways(clean)[1], 'none', 'none is option 2');
  for (const [label, cli] of [['major finding', { bySeverity: { major: 1 } }], ['critical finding', { bySeverity: { critical: 1 } }], ['unknown', null]]) {
    const r = await run(R5_FILES, { cli });
    assert.equal(r.recommended, 'coderabbit', label);
    assert.ok(!pathways(r).includes('none'), label);
  }
});

test('T17: option 1 is the recommendation', async () => {
  for (const [files, pol] of [[R5_FILES, {}], [[file(CRITICAL)], { deep: true, used: 10 }], [[file('docs/a.md')], {}], [R5_FILES, { count: 55 }], [[file('scripts/a.mjs')], { count: 55 }]]) { // PD: R5_FILES added; the small case stays
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
  // The five critical files of spec section 2 are all tagged (and, since 2026-10-30, NEW_CRITICAL below), and an ordinary hook is not.
  const hit = (p) => LIVE.checkpoint.critical.some((g) => matchGlob(g, p));
  for (const p of [CRITICAL, 'scripts/github/review-status.mjs', 'scripts/github/review-router.mjs', '.claude/hooks/src/destructive-command-guard.ts', 'scripts/github/land-pr.ps1', ...NEW_CRITICAL]) assert.ok(hit(p), `${p} is critical`);
  assert.ok(!hit('.claude/hooks/src/session-start.ts'), 'an ordinary hook is not critical');
});

// The 2026-10-30 re-review study (section 4) extends checkpoint.critical to the files where a real Major came from a fix.
// A path missing from the list makes the carry and the small-PR rule treat that PR as ordinary. One test per way it can fail:
//   a new path is not in the live list (the list was not extended, or the glob is wrong)   -> PE1
//   the engine does not tag a new path (the PR stays a small clean PR and gets none)       -> PE2
//   a glob is too wide and tags an ordinary neighbour file                                  -> PE1
const NEW_CRITICAL = [
  '.claude/hooks/src/shared/checkpoint-shapes.ts',
  'scripts/github/pre-pr.mjs',
  'apps/agentic-os/src/server/sources/safe-message.ts',
  'apps/agentic-os/src/server/sources/prompt-text.ts',
  'apps/agentic-os/scripts/provision-roles.sql',
  'apps/agentic-os/scripts/provision-roles.mjs',
];

test('PE1: each path of the 2026-10-30 extension is critical in the live config; ordinary neighbour files are not', () => {
  const hit = (p) => LIVE.checkpoint.critical.some((g) => matchGlob(g, p));
  for (const p of NEW_CRITICAL) assert.ok(hit(p), `${p} is critical`);
  for (const p of [
    '.claude/hooks/src/shared/other.ts', 'scripts/github/pre-pr.test.mjs', 'apps/agentic-os/src/server/sources/other.ts',
    'apps/agentic-os/scripts/other.sql', 'apps/agentic-os/src/server/sources/safe-message.test.ts', 'scripts/github/cr-fix.mjs',
  ]) assert.ok(!hit(p), `${p} is not critical`);
});

test('PE2 (R3): a small clean PR on a new critical path is not "none"; the same size on an ordinary file is', async () => {
  for (const p of NEW_CRITICAL) {
    const r = await run([file(p, 5)]);
    assert.notEqual(r.recommended, 'none', `${p}: a critical file never takes the small-PR none`);
    assert.ok(r.why.some((w) => /^Critical file/.test(w)), `${p}: ${r.why.join(' | ')}`);
  }
  const ordinary = await run([file('scripts/github/pre-pr.test.mjs', 5)]);
  assert.equal(ordinary.recommended, 'none');
});

test('T20b (PR B, flipped by PR D): checkpoint.enforce is a boolean in the live config, and it is true (enforced)', () => {
  assert.equal(typeof LIVE.checkpoint?.enforce, 'boolean', 'checkpoint.enforce must exist (the pre-pr-gate hook reads it)');
  assert.equal(LIVE.checkpoint?.enforce, true, 'PR D flips warn mode to enforced (Dave, 2026-10-29; spike S6 passed live on PR #217)');
  assert.ok(LIVE._doc.some((l) => /checkpoint\.enforce/.test(l)), 'the _doc block explains the key');
});

test('T20c (PR B): PATHWAY_REL sits next to the stamp, and is the path the hook reads', async () => {
  const { PATHWAY_REL } = await load();
  const { STAMP_REL } = await import('./pre-pr.mjs');
  assert.equal(PATHWAY_REL, '.claude/cache/pre-pr/pathway.json');
  assert.equal(path.posix.dirname(PATHWAY_REL), path.posix.dirname(STAMP_REL));
});

// ---------- CLI: the way the harness runs it ----------

function runCli(args, factsObj) {
  const dir = makeTempDir('checkpoint-');
  const factsFile = path.join(dir, 'facts.json');
  const cfgFile = path.join(dir, 'config.json');
  if (factsObj) writeFileSync(factsFile, JSON.stringify(factsObj));
  writeFileSync(cfgFile, JSON.stringify({ ...LIVE, matrix: undefined, deep_enabled: false, greptile: { ...LIVE.greptile, credits_used_manual: null }, coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null, reviews_7d_manual_date: null } }));
  const r = spawnSync(process.execPath, [path.join(HERE, 'pr-checkpoint.mjs'), ...args, '--facts', factsFile, '--config', cfgFile], { encoding: 'utf8', cwd: dir });
  return { ...r, dir };
}

test('T21 (CLI): --json prints the whole output shape as one JSON object and exits 0', () => {
  const r = runCli(['--json'], facts([file(CRITICAL, 30), file('scripts/b.mjs', 5)]));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const shape = ['head', 'class', 'matched', 'size', 'checks', 'cli', 'credits', 'capacity', 'band', 'auto', 'recommended', 'options', 'why', 'budget', 'config_drift', 'config_drift_why'];
  assert.deepEqual(Object.keys(out).sort(), [...shape].sort());
  assert.equal(out.head, HEAD);
  assert.equal(out.recommended, 'coderabbit');
});

test('PD11 (CLI): the way the harness runs it, a small PR with a clean CLI prints recommended none', () => {
  const r = runCli(['--json'], facts(filesIn('scripts', 'mjs'), { cli: CLEAN }));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.recommended, 'none');
  assert.deepEqual(out.budget, [0, 0]);
  assert.deepEqual(out.size, { files: 3, lines: 30, added: 30 });
});

// PR B replaces the PR A test T22 ("--confirm and --apply exit 2, not available yet"). Both modes exist now; T22 keeps the
// part that still holds: bad usage exits 2 before anything is read or written.
test('T22 (CLI): bad --confirm or --apply usage exits 2 and writes no pathway.json', () => {
  const bad = [
    ['--confirm'], ['--confirm', '--by', 'dave'], ['--confirm', 'bogus', '--by', 'dave'], ['--confirm', 'none'],
    ['--confirm', 'none', '--by'], ['--confirm', 'none', '--by', 'robot'], ['--apply'], ['--apply', 'abc'], ['--apply', '-5'], ['--apply', '--json'],
  ];
  for (const args of bad) {
    const r = runB(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, /usage/i, args.join(' '));
    assert.ok(!existsSync(r.pathwayFile), `${args.join(' ')}: nothing written`);
  }
  // --body is required. A GREEN that treats it as optional (skips the hash check when it is absent) would record a pathway here.
  // The stamp and the facts are valid, so only the missing --body can make these exit 2.
  const noBody = [['--confirm', 'none', '--by', 'dave'], ['--confirm', 'coderabbit', '--by', 'default'], ['--confirm', 'none', '--by', 'dave', '--body']];
  for (const args of noBody) {
    const r = runB(args, { noBody: true });
    assert.equal(r.status, 2, `no --body: ${args.join(' ')}: ${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, /usage/i, args.join(' '));
    assert.match(r.stderr, /body/i, `${args.join(' ')}: names the missing flag`);
    assert.ok(!existsSync(r.pathwayFile), `no --body: ${args.join(' ')}: nothing written`);
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
  const dir = makeTempDir('checkpoint-usage-');
  for (const args of [['--bogus'], ['--facts'], ['--config'], ['--facts', '--json'], ['--json', '--config']]) {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: dir });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, /usage/i, args.join(' '));
  }
});

test('T31 (CLI input): a CodeRabbit CLI run that did not complete is not a clean review', async () => {
  const { cliFromStream } = await load();
  const minor = JSON.stringify({ type: 'finding', severity: 'minor', fileName: 'a.mjs' });
  const done = JSON.stringify({ type: 'complete', status: 'review_completed' });
  const error = JSON.stringify({ type: 'error', errorType: 'rate_limit', message: 'limited' });
  assert.equal(cliFromStream(minor), null, 'cut off before complete');
  assert.equal(cliFromStream(`${minor}\n${error}`), null, 'error event, no complete');
  assert.equal(cliFromStream(''), null, 'empty output');
  assert.deepEqual(cliFromStream(`${minor}\n${done}`), { bySeverity: { minor: 1 } }, 'completed run');
});

test('T32 (capacity): a 7-day count dated more than 7 days before now changes nothing and says it is stale', async () => {
  const { recommend } = await load();
  const at = async (date) => {
    const p = await policy({ count: 55 });
    return recommend(facts(R5_FILES, { cli: { bySeverity: { major: 1 } } }), { ...p, coderabbit: { ...p.coderabbit, reviews_7d_manual_date: date } }); // PD: moved to R5_FILES
  };
  const fresh = await at('2026-10-24');
  assert.equal(fresh.capacity.band, 'high', 'a count from 4 days ago still counts');
  assert.equal(fresh.recommended, 'wait');
  const stale = await at('2026-10-20');
  assert.equal(stale.capacity.band, 'unknown', 'a count from 8 days ago is stale');
  assert.equal(stale.recommended, 'coderabbit', 'a stale count never makes wait the default');
  assert.match(stale.capacity.warning, /2026-10-20.*over 7 days old/);
  for (const bad of ['not-a-date', '2026-11-05']) {
    const r = await at(bad);
    assert.equal(r.capacity.band, 'unknown', `${bad}: an invalid or future date is stale`);
    assert.equal(r.recommended, 'coderabbit', bad);
  }
});

// ---------- PR B: --confirm and --apply (spec sections 1, 3.1, 6 tests 16-18) ----------
// The CLI is run the way the harness runs it. A child never reaches a real gh or GitHub: its env holds a bad token and an empty gh config.

const sha = (t) => createHash('sha256').update(t).digest('hex');
const BODY_TEXT = 'PR body\nwith an Evidence block\n';
const BODY_SHA = sha(BODY_TEXT);
const BSTAMP = { ...PASS_STAMP, body_sha256: BODY_SHA };
const PATHWAY_PATH = '.claude/cache/pre-pr/pathway.json'; // T20c pins that PATHWAY_REL equals this
const RECORD_KEYS = ['at', 'body_sha256', 'budget', 'class', 'decided_by', 'head', 'label', 'pathway', 'recommended'];

/**
 * Run `node pr-checkpoint.mjs <mode...>` with the fixture seams. Returns the spawn result plus the state dir and its pathway.json path.
 * --body, --facts and --config are added for --confirm only (the --apply contract lists --state-dir alone).
 * Options: noBody (leave --body out), noStateDir (leave --state-dir out; the default dir applies), cwd (the child cwd, default the temp dir),
 *   stampFile: undefined = the stamp travels in the facts; an object or string = the facts carry NO stamp key and <state>/stamp.json holds it
 *   (a string is written raw); false = no stamp key in the facts and no stamp.json. stampAt: the dir that gets stamp.json instead of the state dir.
 */
function runB(mode, { files = R5_FILES, facts: factOver = {}, pol = {}, body = BODY_TEXT, env = {}, noBody = false, noStateDir = false, cwd = null, stampFile, stampAt = null } = {}) {
  const dir = makeTempDir('checkpoint-b-');
  const state = path.join(dir, 'pre-pr');
  mkdirSync(state, { recursive: true });
  const factsFile = path.join(dir, 'facts.json');
  const cfgFile = path.join(dir, 'config.json');
  const bodyFile = path.join(dir, 'body.md');
  const factsObj = facts(files, { stamp: BSTAMP, ...factOver });
  if (stampFile !== undefined) {
    delete factsObj.stamp;
    if (stampFile !== false) {
      mkdirSync(stampAt ?? state, { recursive: true });
      writeFileSync(path.join(stampAt ?? state, 'stamp.json'), typeof stampFile === 'string' ? stampFile : JSON.stringify(stampFile));
    }
  }
  writeFileSync(factsFile, JSON.stringify(factsObj));
  writeFileSync(bodyFile, body);
  writeFileSync(cfgFile, JSON.stringify({
    ...LIVE, matrix: undefined, deep_enabled: pol.deep ?? false,
    greptile: { ...LIVE.greptile, credits_used_manual: pol.used ?? null },
    coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: pol.count ?? null, reviews_7d_manual_date: null },
    checkpoint: { ...LIVE.checkpoint, parser: ['lib/lexer/**'] },
  }));
  const isConfirm = mode[0] === '--confirm';
  const args = [
    path.join(HERE, 'pr-checkpoint.mjs'), ...mode,
    ...(isConfirm && !noBody ? ['--body', bodyFile] : []),
    ...(noStateDir ? [] : ['--state-dir', state]),
    ...(isConfirm ? ['--facts', factsFile, '--config', cfgFile] : []),
  ];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: cwd ?? dir, env: { ...process.env, PR_CHECKPOINT_TEST: '1', CCV3_DECISIONS_FILE: path.join(dir, 'decisions.json'), GH_TOKEN: 'invalid-token', GH_CONFIG_DIR: dir, ...env } });
  return { ...r, dir, state, pathwayFile: path.join(state, 'pathway.json') };
}
const confirm = (pathway, by, opts) => runB(['--confirm', pathway, '--by', by], opts);
const recordOf = (r) => JSON.parse(readFileSync(r.pathwayFile, 'utf8'));
const refused = (r, why, label) => {
  assert.equal(r.status, 1, `${label}: ${r.stdout} ${r.stderr}`);
  assert.match(r.stderr, why, label);
  assert.ok(!existsSync(r.pathwayFile), `${label}: no pathway.json`);
};

test('TB1 (spec 16): --confirm refuses a body whose hash is not the stamped body hash, and writes nothing', () => {
  refused(confirm('coderabbit', 'dave', { body: `${BODY_TEXT}one more line\n` }), /body/i, 'edited body');
  refused(confirm('coderabbit', 'default', { body: '' }), /body/i, 'empty body');
});

test('TB2 (spec 16, R0): --confirm refuses a missing stamp, a stamp for another head and a stamp with a failed row', () => {
  const failed = { ...BSTAMP, results: [...BSTAMP.results, { step: 'gate:tests', status: 'FAIL', detail: 'x' }] };
  for (const [label, stamp] of [['no stamp', null], ['another head', { ...BSTAMP, head: OTHER }], ['failed row', failed]]) {
    refused(confirm('coderabbit', 'dave', { facts: { stamp } }), /pre-pr/i, label);
  }
});

test('TB3: --confirm writes the nine-field record and prints the same JSON', () => {
  const r = confirm('coderabbit', 'default');
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  const rec = recordOf(r);
  assert.deepEqual(Object.keys(rec).sort(), RECORD_KEYS);
  assert.deepEqual(rec, {
    head: HEAD, body_sha256: BODY_SHA, pathway: 'coderabbit', label: 'review:coderabbit', class: 'normal',
    recommended: 'coderabbit', decided_by: 'default', at: NOW, budget: [1, 1],
  });
  assert.deepEqual(JSON.parse(r.stdout), rec, 'stdout is the record');
});

// Dave 11-04 (lane pr-checkpoint-cost-record-split): coderabbit records the price its option showed; none records 0+0; both records
// max(rule budget, class budget) floored at 1+0 and never the display-only 1+1 floor (costOf), so pr_watch allows the rounds Dave chose.
// The R2 parser file is class normal, whose live budget is 1+1, so the rule (1+0) and class budgets differ only in the live case (TB4c).
// TB4 pins the class budget to 1+0 to separate the recorded budget from the option cost 1+1.
test('TB4: both on the R2 parser file records max(rule, class) = 1+0, not the display-only 1+1 floor the option shows', async () => {
  const { recommend, confirmRecord } = await load();
  const f = facts([file(PARSER, 80)], { stamp: BSTAMP });
  const pol = await policy({ deep: true, used: 10 });
  const result = recommend(f, { ...pol, budget: { ...pol.budget, normal: [1, 0] } });
  const both = result.options.find((o) => o.pathway === 'both');
  assert.deepEqual(result.budget, [1, 0], 'the rule budget is 1+0');
  assert.deepEqual(both.cost, [1, 1], 'the option still shows the 1+1 floor so it never looks free');
  const rec = confirmRecord({ result, facts: f, pathway: 'both', by: 'dave' });
  assert.equal(rec.pathway, 'both');
  assert.equal(rec.label, 'review:deep');
  assert.deepEqual(rec.budget, [1, 0]);
  assert.deepEqual(confirmRecord({ result, facts: f, pathway: 'coderabbit', by: 'dave' }).budget, [1, 0], 'coderabbit records its option price');
});

test('TB4c: both records the CLASS budget when it is higher than the rule budget (R2 parser file, live class normal 1+1; r3 1+2)', async () => {
  const { recommend, confirmRecord } = await load();
  const pol = await policy({ deep: true, used: 10 });
  const f = facts([file(PARSER, 80)], { stamp: BSTAMP });
  const result = recommend(f, pol);
  assert.deepEqual(result.budget, [1, 0], 'the rule budget is lower than the class budget');
  assert.deepEqual(confirmRecord({ result, facts: f, pathway: 'both', by: 'dave' }).budget, LIVE.budget.normal);
  // A class budget of 1+2 is above the 1+1 floor, so the record and the option agree on it.
  const r3 = recommend(f, { ...pol, budget: { ...pol.budget, normal: [1, 2] } });
  assert.deepEqual(confirmRecord({ result: r3, facts: f, pathway: 'both', by: 'dave' }).budget, [1, 2]);
});

// TREX verify N9 (evidence .claude/cache/e2e/trex-verify-p1/verify/evidence/bf4162aaea8e36f8/): with the live review matrix, a MID
// PR's CodeRabbit option is an escalation priced at the HIGH budget (review-matrix.md:24). confirmRecord stored 1+0.
test('TB4b (N9): with the live matrix, a CodeRabbit escalation below HIGH records the price the option showed', async () => {
  const { recommend, confirmRecord } = await load();
  const f = facts([file('apps/x/src/a.ts', 10)]);
  const result = recommend(f, LIVE);
  const option = result.options.find((o) => o.pathway === 'coderabbit');
  assert.ok(option, `coderabbit is offered: ${result.options.map((o) => o.pathway).join(', ')}`);
  assert.notDeepEqual(option.cost, result.budget, 'the price differs from the rule budget, so this test can tell them apart');
  assert.deepEqual(confirmRecord({ result, facts: f, pathway: 'coderabbit', by: 'dave' }).budget, option.cost);
  assert.deepEqual(confirmRecord({ result, facts: f, pathway: 'none', by: 'dave' }).budget, [0, 0], 'none never records a budget');
});

test('TB5: none (option 2 of R5 on a clean CLI) records label review:none, budget 0+0, decided_by dave, recommended coderabbit', () => {
  const r = confirm('none', 'dave');
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  const rec = recordOf(r);
  assert.equal(rec.pathway, 'none');
  assert.equal(rec.label, 'review:none');
  assert.equal(rec.recommended, 'coderabbit');
  assert.equal(rec.decided_by, 'dave');
  assert.deepEqual(rec.budget, [0, 0]);
});

test('TB6: --confirm records only an offered, available pathway; --by default must be the recommendation', () => {
  const critical = { files: [file(CRITICAL, 30)] };
  refused(confirm('both', 'dave', critical), /held|not available|apex_d3/i, 'held Greptile');
  refused(confirm('none', 'dave', critical), /not offered|not an option/i, 'none is not offered for a critical file');
  refused(confirm('coderabbit', 'dave', { files: [file('package.json', 3, 3)], facts: { dependabot: true } }), /not offered|not an option/i, 'Dependabot offers none only');
  refused(confirm('none', 'default'), /default|recommend/i, '--by default with a pathway that is not the recommendation');
  refused(confirm('wait', 'dave', { pol: { count: 55 }, facts: { cli: { bySeverity: { major: 1 } } } }), /wait/i, 'wait writes no pathway');
});

test('TB7: coderabbit chosen over a docs "none" records its option price (1+0 at least); chosen at count 55 it keeps recommended wait', async () => {
  const docs = confirm('coderabbit', 'dave', { files: [file('docs/guide.md', 40)] });
  assert.equal(docs.status, 0, `${docs.stdout} ${docs.stderr}`);
  assert.equal(recordOf(docs).recommended, 'none');
  const price = optionOf(await run([file('docs/guide.md', 40)]), 'coderabbit').cost;
  assert.ok(price[0] >= 1, 'a chosen CodeRabbit review is never budget 0+0');
  assert.deepEqual(recordOf(docs).budget, price, 'the record is the price the option showed (Dave 11-04)');
  const high = confirm('coderabbit', 'dave', { pol: { count: 55 }, facts: { cli: { bySeverity: { major: 1 } } } });
  assert.equal(high.status, 0, `${high.stdout} ${high.stderr}`);
  assert.equal(recordOf(high).recommended, 'wait');
  assert.equal(recordOf(high).pathway, 'coderabbit');
  assert.deepEqual(recordOf(high).budget, [1, 1]);
});

test('TB8: with no stamp in the facts, --confirm reads <state-dir>/stamp.json: a matching file confirms; a wrong body, head or a missing or broken file refuses', () => {
  const ok = confirm('coderabbit', 'dave', { stampFile: BSTAMP });
  assert.equal(ok.status, 0, `${ok.stdout} ${ok.stderr}`);
  assert.equal(recordOf(ok).head, HEAD);
  assert.equal(recordOf(ok).body_sha256, BODY_SHA);
  refused(confirm('coderabbit', 'dave', { stampFile: { ...BSTAMP, body_sha256: sha('another body\n') } }), /body/i, 'stamp.json holds another body hash');
  refused(confirm('coderabbit', 'dave', { stampFile: { ...BSTAMP, head: OTHER } }), /pre-pr/i, 'stamp.json is for another head');
  refused(confirm('coderabbit', 'dave', { stampFile: { ...BSTAMP, results: [{ step: 'gate:tests', status: 'FAIL', detail: 'x' }] } }), /pre-pr/i, 'stamp.json has a failed row');
  refused(confirm('coderabbit', 'dave', { stampFile: false }), /pre-pr/i, 'no stamp.json and no facts stamp');
  refused(confirm('coderabbit', 'dave', { stampFile: '{not json' }), /pre-pr/i, 'stamp.json is not JSON');
});

test('TB9: with no --state-dir, --confirm reads stamp.json and writes pathway.json under the git toplevel of the cwd (where pre-pr.mjs and the hook look), from a subdirectory too', () => {
  const repo = realpathSync(makeTempDir('checkpoint-repo-'));
  const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const sub = path.join(repo, 'sub', 'dir');
  mkdirSync(sub, { recursive: true });
  const r = runB(['--confirm', 'coderabbit', '--by', 'dave'], { noStateDir: true, cwd: sub });
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  const want = path.join(repo, ...PATHWAY_PATH.split('/'));
  assert.ok(existsSync(want), `pathway.json at the toplevel: ${want}`);
  assert.equal(JSON.parse(readFileSync(want, 'utf8')).head, HEAD);
  assert.ok(!existsSync(path.join(sub, ...PATHWAY_PATH.split('/'))), 'not under the cwd');
  assert.ok(!existsSync(r.pathwayFile), 'not in the fixture state dir, which this run never passed');
  // The stamp READ uses the same default dir: no facts stamp, stamp.json under the toplevel's .claude/cache/pre-pr, cwd in a subdirectory.
  const repo2 = realpathSync(makeTempDir('checkpoint-repo-'));
  assert.equal(spawnSync('git', ['init', '-q', repo2], { encoding: 'utf8' }).status, 0);
  const sub2 = path.join(repo2, 'sub');
  mkdirSync(sub2, { recursive: true });
  const r2 = runB(['--confirm', 'coderabbit', '--by', 'dave'], { noStateDir: true, cwd: sub2, stampFile: BSTAMP, stampAt: path.join(repo2, ...PATHWAY_PATH.split('/').slice(0, -1)) });
  assert.equal(r2.status, 0, `stamp read from the default dir: ${r2.stdout} ${r2.stderr}`);
  assert.equal(JSON.parse(readFileSync(path.join(repo2, ...PATHWAY_PATH.split('/')), 'utf8')).body_sha256, BODY_SHA);
});

// ---------- --apply: applyPathway with an injected gh, then the wired CLI with a fake gh script ----------

const RECORD = { head: HEAD, body_sha256: BODY_SHA, pathway: 'coderabbit', label: 'review:coderabbit', class: 'normal', recommended: 'coderabbit', decided_by: 'dave', at: NOW, budget: [1, 1] };
const LABEL_OF = { none: 'review:none', coderabbit: 'review:coderabbit', both: 'review:deep' };

/** A fake gh. A `pr edit`, `pr comment` or `pr ready` call is a mutation; every other call is a read and gets the PR view. */
const MUTATIONS = ['edit', 'comment', 'ready'];
function fakeGh({ view = { isDraft: true, headRefOid: HEAD }, fail = null } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const kind = args[0] === 'pr' ? args[1] : null;
    if (kind === fail) return { status: 1, stdout: '', stderr: `fake gh: ${kind} failed` };
    return { status: 0, stdout: MUTATIONS.includes(kind) ? '' : JSON.stringify(view), stderr: '' };
  };
  return { gh, calls, mutations: () => calls.filter((a) => a[0] === 'pr' && MUTATIONS.includes(a[1])) };
}

test('TA1 (spec 17): apply refuses a PR that is not a draft and makes no mutation', async () => {
  const { applyPathway } = await load();
  const g = fakeGh({ view: { isDraft: false, headRefOid: HEAD } });
  const r = await applyPathway({ pr: 201, record: RECORD, gh: g.gh });
  assert.equal(r.ok, false);
  assert.match(r.error, /draft/i);
  assert.deepEqual(g.mutations(), []);
});

test('TA2 (spec 17): apply refuses when the live head moved since confirm and makes no mutation', async () => {
  const { applyPathway } = await load();
  const g = fakeGh({ view: { isDraft: true, headRefOid: OTHER } });
  const r = await applyPathway({ pr: 201, record: RECORD, gh: g.gh });
  assert.equal(r.ok, false);
  assert.match(r.error, /head/i);
  assert.match(r.error, /call pr_checkpoint \{pr\}/i, 'the refusal sends the model to the tool, then a tap');
  assert.doesNotMatch(r.error, /\/pathway|\/slot/);
  assert.doesNotMatch(r.error, /\/checkpoint/, "/checkpoint is a built-in of Claude Code, not this mod's command");
  assert.deepEqual(g.mutations(), []);
});

test('TA3 (spec 18): apply adds the review label BEFORE it marks the PR ready, for every pathway (none adds review:none)', async () => {
  const { applyPathway } = await load();
  for (const pathway of ['none', 'coderabbit', 'both']) {
    const g = fakeGh();
    const r = await applyPathway({ pr: 201, record: { ...RECORD, pathway, label: LABEL_OF[pathway] }, gh: g.gh });
    assert.deepEqual(r, { ok: true }, pathway);
    const calls = g.calls.map((a) => `${a[0]} ${a[1]}`);
    assert.equal(calls[0], 'pr view', `${pathway}: the live PR is read before any mutation`);
    assert.deepEqual(calls.filter((c) => c !== 'pr view'), ['pr edit', 'pr comment', 'pr ready'], `${pathway}: label, then the pathway-confirmed comment, then ready last`);
    assert.equal(calls.lastIndexOf('pr view'), 0, `${pathway}: no read after a mutation`);
    assert.deepEqual(g.calls.find((a) => a[1] === 'edit'), ['pr', 'edit', '201', '--add-label', LABEL_OF[pathway], '-R', DEFAULT_REPO], pathway);
    assert.deepEqual(g.calls.find((a) => a[1] === 'ready'), ['pr', 'ready', '201', '-R', DEFAULT_REPO], pathway);
  }
});

test('TA4 (spec 18): a failed label never reaches ready; a failed ready after the label reports it', async () => {
  const { applyPathway } = await load();
  const noLabel = fakeGh({ fail: 'edit' });
  const a = await applyPathway({ pr: 201, record: RECORD, gh: noLabel.gh });
  assert.equal(a.ok, false);
  assert.match(a.error, /label/i);
  assert.ok(!noLabel.calls.some((c) => c[1] === 'ready'), 'ready after a failed label would route the PR with no label');
  const noReady = fakeGh({ fail: 'ready' });
  const b = await applyPathway({ pr: 201, record: RECORD, gh: noReady.gh });
  assert.equal(b.ok, false);
  assert.match(b.error, /ready/i);
});

// PR D: a ready_for_review alone is not a checkpoint. /pathway posts one comment with a hidden marker BEFORE it marks the PR ready;
// the router counts a ready_for_review as a new checkpoint only when a marker names the head and the label's pathway.
// It fails if: apply posts no marker, or posts it after ready (the router runs on the ready event and sees no marker) -> TA3b
//              the marker names another head or pathway than the record                                              -> TA3b, TA3c
//              a failed post still reaches ready                                                                      -> TA4c
//              the router cannot read the marker the apply step writes (two copies of the format drift)              -> TA3c
test('TA3b: apply posts one pr comment with the pathway-confirmed marker for the record head and pathway, before ready', async () => {
  const { applyPathway } = await load();
  for (const pathway of ['none', 'coderabbit', 'both']) {
    const g = fakeGh();
    const r = await applyPathway({ pr: 201, record: { ...RECORD, pathway, label: LABEL_OF[pathway] }, gh: g.gh });
    assert.deepEqual(r, { ok: true }, pathway);
    const comments = g.calls.filter((a) => a[1] === 'comment');
    assert.equal(comments.length, 1, pathway);
    const [c] = comments;
    assert.deepEqual([c[0], c[1], c[2]], ['pr', 'comment', '201'], pathway);
    assert.deepEqual(c.slice(-2), ['-R', DEFAULT_REPO], pathway);
    const body = c[c.indexOf('--body') + 1];
    assert.ok(body.startsWith(`<!-- pathway-confirmed head=${HEAD} pathway=${pathway} -->\n`), `${pathway}: ${body}`);
    assert.match(body, new RegExp(`Checkpoint: ${pathway} at ${HEAD.slice(0, 7)}, chosen in /pathway\\.`), pathway);
    const order = g.calls.map((a) => a[1]);
    assert.ok(order.indexOf('comment') < order.indexOf('ready'), `${pathway}: the marker comes before ready: ${order}`);
  }
});

test('TA3c: the router reads the marker the apply step writes (same head, same pathway), and nothing else', async () => {
  const { applyPathway } = await load();
  const { confirmedPathways } = await import('./review-router.mjs');
  const g = fakeGh();
  await applyPathway({ pr: 201, record: RECORD, gh: g.gh });
  const c = g.calls.find((a) => a[1] === 'comment');
  const comment = { id: 5, author_association: 'OWNER', body: c[c.indexOf('--body') + 1] };
  assert.deepEqual(confirmedPathways([comment], HEAD), ['coderabbit']);
  assert.deepEqual(confirmedPathways([comment], OTHER), []);
});

test('TA4c: a failed marker comment never reaches ready and says so; the label was already added', async () => {
  const { applyPathway } = await load();
  const g = fakeGh({ fail: 'comment' });
  const r = await applyPathway({ pr: 201, record: RECORD, gh: g.gh });
  assert.equal(r.ok, false);
  assert.match(r.error, /comment/i);
  assert.match(r.error, /not marked ready/i);
  assert.deepEqual(g.calls.map((a) => a[1]), ['view', 'edit', 'comment'], 'view, label, the failed comment, and no ready');
});

// M3 (pathway-flow-v2): on #349 a stale review:coderabbit stayed beside review:none and the router read the stronger label.
// It fails if: another review:* label stays after the apply                               -> TM3a
//              the removal comes in a later gh call than the add, or after the marker     -> TM3a
//              a risk:* label, or the chosen label itself, is removed                     -> TM3b
//              the edit shape changes when no stale review label exists (TA3 pins it)     -> TA3
test('TM3a: apply removes every OTHER review:* label in the same gh pr edit that adds the chosen one, before the marker and ready', async () => {
  const { applyPathway } = await load();
  const labels = [{ name: 'review:coderabbit' }, { name: 'risk:infra' }, { name: 'review:deep-held' }];
  const g = fakeGh({ view: { isDraft: true, headRefOid: HEAD, labels } });
  const r = await applyPathway({ pr: 201, record: { ...RECORD, pathway: 'none', label: 'review:none' }, gh: g.gh });
  assert.deepEqual(r, { ok: true });
  const edits = g.calls.filter((a) => a[1] === 'edit');
  assert.equal(edits.length, 1, 'one edit call: remove and add together');
  assert.deepEqual(edits[0], ['pr', 'edit', '201', '--remove-label', 'review:coderabbit', '--remove-label', 'review:deep-held', '--add-label', 'review:none', '-R', DEFAULT_REPO]);
  assert.deepEqual(g.calls.map((a) => a[1]), ['view', 'edit', 'comment', 'ready']);
});

test('TM3b: apply keeps risk:* labels and the chosen label, and reads label names given as plain strings', async () => {
  const { applyPathway } = await load();
  const g = fakeGh({ view: { isDraft: true, headRefOid: HEAD, labels: [{ name: 'review:none' }, { name: 'risk:high' }, 'review:deep'] } });
  assert.deepEqual(await applyPathway({ pr: 201, record: { ...RECORD, pathway: 'none', label: 'review:none' }, gh: g.gh }), { ok: true });
  assert.deepEqual(g.calls.find((a) => a[1] === 'edit'), ['pr', 'edit', '201', '--remove-label', 'review:deep', '--add-label', 'review:none', '-R', DEFAULT_REPO]);
});

// review-router.mjs `releasable` lifts a hold only while review:deep-held is still on the PR. A CodeRabbit pick must not remove it.
//   a coderabbit record removes review:deep-held with the other stale labels      -> TM3c
//   the keep rule spreads: a none or both record keeps review:deep-held             -> TM3c
test('TM3c: a review:coderabbit record keeps review:deep-held and removes the other review:* labels; none and both still remove it', async () => {
  const { applyPathway } = await load();
  const labels = [{ name: 'review:none' }, { name: 'review:deep-held' }, { name: 'risk:high' }];
  const g = fakeGh({ view: { isDraft: true, headRefOid: HEAD, labels } });
  assert.deepEqual(await applyPathway({ pr: 201, record: { ...RECORD, pathway: 'coderabbit', label: 'review:coderabbit' }, gh: g.gh }), { ok: true });
  assert.deepEqual(g.calls.find((a) => a[1] === 'edit'), ['pr', 'edit', '201', '--remove-label', 'review:none', '--add-label', 'review:coderabbit', '-R', DEFAULT_REPO]);
  for (const pathway of ['none', 'both']) {
    const h = fakeGh({ view: { isDraft: true, headRefOid: HEAD, labels } });
    await applyPathway({ pr: 201, record: { ...RECORD, pathway, label: LABEL_OF[pathway] }, gh: h.gh });
    assert.ok(h.calls.find((a) => a[1] === 'edit').includes('review:deep-held'), `${pathway}: review:deep-held is removed`);
  }
});

test('TA4b: apply with no record, or a record with an unknown pathway or no head, refuses before any gh call', async () => {
  const { applyPathway } = await load();
  for (const record of [null, undefined, {}, { ...RECORD, pathway: 'wait' }, { ...RECORD, pathway: 'bogus' }, { ...RECORD, head: '' }]) {
    const g = fakeGh();
    const r = await applyPathway({ pr: 201, record, gh: g.gh });
    assert.equal(r.ok, false, JSON.stringify(record));
    assert.deepEqual(g.calls, [], JSON.stringify(record));
  }
});

/** The wired CLI: a fake gh script (env PR_CHECKPOINT_GH) logs every call to a file and prints a canned PR view. */
function runApply({ record = RECORD, view = { isDraft: true, headRefOid: HEAD }, pr = '999999' } = {}) {
  const dir = makeTempDir('checkpoint-apply-');
  const state = path.join(dir, 'pre-pr');
  mkdirSync(state, { recursive: true });
  if (record) writeFileSync(path.join(state, 'pathway.json'), JSON.stringify(record));
  const script = path.join(dir, 'fake-gh.mjs');
  const log = path.join(dir, 'gh-calls.jsonl');
  writeFileSync(script, [
    "import { appendFileSync } from 'node:fs';",
    'const a = process.argv.slice(2);',
    "appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + '\\n');",
    "if (a[0] === 'pr' && a[1] === 'view') process.stdout.write(process.env.FAKE_GH_VIEW);",
  ].join('\n'));
  const r = spawnSync(process.execPath, [path.join(HERE, 'pr-checkpoint.mjs'), '--apply', pr, '--state-dir', state], {
    encoding: 'utf8', cwd: dir,
    env: { ...process.env, GH_TOKEN: 'invalid-token', GH_CONFIG_DIR: dir, PR_CHECKPOINT_GH: script, FAKE_GH_LOG: log, FAKE_GH_VIEW: JSON.stringify(view) },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...r, calls };
}

test('TA5 (CLI): --apply reads pathway.json, then the PR, adds the label and marks ready, in that order, through the injected gh', () => {
  const r = runApply();
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  const kinds = r.calls.map((a) => `${a[0]} ${a[1]}`);
  assert.equal(kinds[0], 'pr view');
  assert.deepEqual(kinds.filter((k) => k !== 'pr view'), ['pr edit', 'pr comment', 'pr ready']);
  assert.ok(r.calls.find((a) => a[1] === 'edit').includes('review:coderabbit'));
  assert.ok(r.calls.every((a) => a[0] !== 'pr' || a.includes('999999')), 'every pr call names the PR');
  assert.ok(r.calls.every((a) => a.slice(-2).join(' ') === `-R ${DEFAULT_REPO}`), `every gh call names the fork (critic: gh picks the repo from the cwd remotes otherwise): ${JSON.stringify(r.calls)}`);
});

test('TA6 (CLI): --apply exits 1 with no mutation when pathway.json is missing, the PR is not a draft, or the head moved', () => {
  const none = runApply({ record: null });
  assert.equal(none.status, 1, `${none.stdout} ${none.stderr}`);
  assert.match(none.stderr, /pathway/i);
  assert.match(none.stderr, /call pr_checkpoint \{pr\}/i, 'the refusal sends the model to the tool, then a tap');
  assert.doesNotMatch(none.stderr, /\/pathway|\/slot/, 'the refusal names no typed command');
  assert.doesNotMatch(none.stderr, /\/checkpoint/, "/checkpoint is a built-in of Claude Code, not this mod's command");
  assert.deepEqual(none.calls, [], 'no record: gh is not called');
  // The one gh call is the read. An empty call log would mean the injected gh was never used (the real gh failing on the bad token also exits 1).
  for (const [label, view, why] of [['not a draft', { isDraft: false, headRefOid: HEAD }, /draft/i], ['head moved', { isDraft: true, headRefOid: OTHER }, /head/i]]) {
    const r = runApply({ view });
    assert.equal(r.status, 1, `${label}: ${r.stdout} ${r.stderr}`);
    assert.deepEqual(r.calls, [['pr', 'view', '999999', '--json', 'isDraft,headRefOid,labels', '-R', DEFAULT_REPO]], `${label}: exactly one read through the injected gh, no mutation`);
    assert.match(r.stderr, why, `${label}: the refusal names its reason`);
  }
});

test('TB10 (critic): the facts (head, files, config drift, CLI output) come from the git toplevel of the cwd, the checkout the state dir belongs to, not from the checkout that holds the script', () => {
  const repo = realpathSync(makeTempDir('checkpoint-facts-'));
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });
  assert.equal(git('init', '-q', '-b', 'main').status, 0);
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  assert.equal(git('add', 'a.txt').status, 0);
  assert.equal(git('commit', '-q', '-m', 'one').status, 0);
  const tempHead = git('rev-parse', 'HEAD').stdout.trim();
  const configFile = path.join(repo, 'cfg.json');
  writeFileSync(configFile, JSON.stringify(LIVE));
  const scriptHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  assert.notEqual(tempHead, scriptHead, 'the fixture checkout and the script checkout differ');
  const r = spawnSync(process.execPath, [path.join(HERE, 'pr-checkpoint.mjs'), '--json', '--config', configFile], { cwd: repo, encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'invalid-token', PR_CHECKPOINT_CR: 'off', PR_CHECKPOINT_SLOT_STATE: path.join(repo, 'no-slot.json'), PR_CHECKPOINT_NO_PROBE: '1' } });
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).head, tempHead, 'head is the cwd checkout head, not the script checkout head');
});
