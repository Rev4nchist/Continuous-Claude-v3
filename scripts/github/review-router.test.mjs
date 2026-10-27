// Tests for review-router.mjs. Run: node --test scripts/github/review-router.test.mjs
//
// How each function can fail, and the test that catches it (written before the code):
//
// matchGlob / globToRegExp
//   - ** needs at least one segment, so `**/*.sql` misses a root file        -> G1
//   - ** or * leaks across a `/` (docs/** matches other/docs/x, * crosses dirs)   -> G2, G3
//   - regex characters in a glob are live (a.b matches axb)                  -> G5
//   - ? matches a slash                                                      -> G4
//   - a Windows path (backslashes) never matches                              -> classify G9
//   - an empty glob matches everything                                       -> G10
// classify
//   - the lowest class wins, or the first match wins instead of the highest   -> mixed-class tests
//   - CLAUDE.md falls to the docs *.md rule; _vendor copies count as steering -> steering/_vendor tests
//   - lock files or dist/ alone raise the class                               -> normal tests
//   - an empty path list throws or returns docs                               -> empty test
// creditsState / route
//   - unknown credits (null, string, negative, fraction) trigger u1/u2        -> credits tests
//   - deep_enabled false still adds review:deep                              -> route deep tests
//   - r3 loses review:deep at u2                                              -> u2 tests
//   - a label already on the PR is added again                                -> add-filter test
// decide
//   - a draft or closed PR gets labels                                        -> R-1
//   - a push removes or lowers a label                                        -> R-6
//   - the router re-adds a label a person removed                             -> R-7
//   - a person's review:* label gets another review label next to it          -> person-wins test
//   - a re-run adds labels or comments twice                                  -> idempotency tests, R-8
//   - the comment loses the held notice when only the builder line changes    -> comment regeneration test
//   - builder missing blocks (it only comments)                               -> builder tests
// previousClassFrom / findRouterComment / planOps / applyOps
//   - a stale lower risk label hides the higher class                         -> previousClassFrom tests
//   - a second comment is posted instead of an update                         -> planOps tests
//   - a dry run writes                                                        -> applyOps dry-run test
//   - a truncated file list is treated as the whole PR                        -> changedPaths test
// state and comment (the comment is the only memory; a forged one must not steer the router)
//   - a person's comment that quotes the marker is PATCHed or trusted                -> findRouterComment, CLI forged test
//   - a pasted dry-run print carries a live marker                                   -> maskMarker test
//   - the head is missing from the state, or the state is not updated on a new head  -> planOps head tests
//   - a person's risk label above the comment class is ignored                       -> raise tests
// ledger / CLI
//   - the ledger line is not one line of valid JSON, or hides unknown credits -> R-9
// follow-ups (2026-10-26)
//   - a held PR stays CodeRabbit-only after deep review is switched on         -> release tests
//   - the release re-adds review:deep a person removed after an earlier release -> release-once test
//   - the hold is not saved, so a release cannot tell config from a person     -> held state tests
//   - a person's label change writes labels, or writes no ledger row           -> labeled/unlabeled tests
//   - the file list is read from an endpoint that can lag the head             -> loadLive compare test
//   - a PR above the compare cap (300 files) can never be routed               -> loadLive fallback test
//   - compare returns more files than the PR has (base moved) and is trusted   -> changedPaths strict test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  globToRegExp, matchGlob, classify, creditsState, route, decide, previousClassFrom, stateFrom, builderOf,
  ROUTER_MARKER, renderComment, findRouterComment, planOps, applyOps, maskMarker, changedPaths, codeRabbitRateLimited, ledgerLine,
  loadLive, COMPARE_FILE_CAP,
} from './review-router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The path classes come from the live config (that is the contract under test). The switches are pinned here,
// so editing deep_enabled or credits_used_manual in the live file cannot change a test result.
const LIVE = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'review-router.config.json'), 'utf8'));
const BASE = { ...LIVE, deep_enabled: false, greptile: { ...LIVE.greptile, credits_used_manual: null } };
const cfg = (over = {}, greptile = {}) => ({ ...BASE, ...over, greptile: { ...BASE.greptile, ...greptile } });
const NOW = new Date('2026-10-26T12:00:00Z');
const HEAD = 'a'.repeat(40);
const pr = (paths, extra = {}) => ({ number: 7, head: HEAD, draft: false, state: 'open', paths, ...extra });
const READY = 'ready_for_review';
const B = 'builder:claude';

// ---------- glob ----------

test('G1: ** matches zero segments, one segment and many', () => {
  assert.ok(matchGlob('**/*.sql', 'a.sql'));
  assert.ok(matchGlob('**/*.sql', 'a/b.sql'));
  assert.ok(matchGlob('**/*.sql', 'a/b/c/d.sql'));
  assert.ok(!matchGlob('**/*.sql', 'a.sqlx'));
  assert.ok(!matchGlob('**/*.sql', 'a/b.sql.bak'));
});

test('G2: dir/** matches below the dir only, from the root', () => {
  assert.ok(matchGlob('docs/**', 'docs/a.md'));
  assert.ok(matchGlob('docs/**', 'docs/a/b/c.md'));
  assert.ok(!matchGlob('docs/**', 'docs'));
  assert.ok(!matchGlob('docs/**', 'docsx/a.md'));
  assert.ok(!matchGlob('docs/**', 'other/docs/a.md'));
});

test('G3: * stays inside one segment', () => {
  assert.ok(matchGlob('scripts/*.mjs', 'scripts/a.mjs'));
  assert.ok(!matchGlob('scripts/*.mjs', 'scripts/x/a.mjs'));
  assert.ok(matchGlob('scripts/sync-to-active*', 'scripts/sync-to-active.sh'));
  assert.ok(matchGlob('scripts/sync-to-active*', 'scripts/sync-to-active-cursor.test.sh'));
  assert.ok(!matchGlob('scripts/sync-to-active*', 'scripts/x/sync-to-active.sh'));
});

test('G4: ? is one character and never a slash', () => {
  assert.ok(matchGlob('a?c', 'abc'));
  assert.ok(!matchGlob('a?c', 'a/c'));
  assert.ok(!matchGlob('a?c', 'ac'));
});

test('G5: regex characters in a glob are literal', () => {
  assert.ok(matchGlob('a.b', 'a.b'));
  assert.ok(!matchGlob('a.b', 'axb'));
  assert.ok(matchGlob('a+(b)', 'a+(b)'));
  assert.ok(matchGlob('x[1].md', 'x[1].md'));
});

test('G6: ** in the middle spans zero or more whole segments', () => {
  assert.ok(matchGlob('a/**/b.txt', 'a/b.txt'));
  assert.ok(matchGlob('a/**/b.txt', 'a/x/y/b.txt'));
  assert.ok(!matchGlob('a/**/b.txt', 'a/xb.txt'));
});

test('G7: **/Dockerfile* matches the root file and nested variants', () => {
  assert.ok(matchGlob('**/Dockerfile*', 'Dockerfile'));
  assert.ok(matchGlob('**/Dockerfile*', 'docker/Dockerfile.dev'));
  assert.ok(!matchGlob('**/Dockerfile*', 'docs/Dockerfile/readme.txt'));
});

test('G10: an empty glob is rejected', () => {
  assert.throws(() => globToRegExp(''), /empty glob/i);
});

// ---------- classify ----------

const cls = (paths, over) => classify(paths, over ?? BASE);

test('classify R-2: docs only', () => {
  assert.equal(cls(['docs/x.md']).class, 'docs');
  assert.equal(cls(['thoughts/shared/a.yaml', 'README.md']).class, 'docs');
});

test('classify R-3: a script is normal', () => {
  assert.equal(cls(['scripts/foo.mjs']).class, 'normal');
});

test('classify R-4: rules-src plus docs is steering', () => {
  const r = cls(['.claude/rules-src/x.md', 'docs/y.md']);
  assert.equal(r.class, 'steering');
  assert.deepEqual(r.matched, { steering: 1, docs: 1 });
});

test('classify R-5: a drizzle migration is r3', () => {
  assert.equal(cls(['apps/agentic-os/drizzle/0004.sql']).class, 'r3');
  assert.equal(cls(['db/migrations/001_x.ts']).class, 'r3');
});

test('classify: infra paths', () => {
  for (const p of ['.github/workflows/x.yml', 'scripts/github/review-status.mjs', 'scripts/sync-to-active.sh',
    '.coderabbit.yaml', '.greptile/config.json', 'docker/Dockerfile.x', 'review-router.config.json']) {
    assert.equal(cls([p]).class, 'infra', p);
  }
});

test('classify: highest class of any path wins, in the order r3 > infra > steering > normal > docs', () => {
  assert.equal(cls(['docs/a.md', 'scripts/a.mjs']).class, 'normal');
  assert.equal(cls(['scripts/a.mjs', '.claude/agents/x.md']).class, 'steering');
  assert.equal(cls(['.claude/agents/x.md', '.github/workflows/x.yml']).class, 'infra');
  assert.equal(cls(['.github/workflows/x.yml', 'x/y.sql', 'docs/a.md']).class, 'r3');
});

test('classify: root steering files are steering, not docs', () => {
  for (const p of ['CLAUDE.md', 'AGENTS.md', 'CONTEXT.md', '.claude/skills/foo/SKILL.md']) {
    assert.equal(cls([p]).class, 'steering', p);
  }
});

test('classify: _vendor byte copies are not steering', () => {
  assert.notEqual(cls(['.claude/skills/_vendor/skills-for-fabric/CHANGELOG.md']).class, 'steering');
  assert.notEqual(cls(['.claude/skills/_vendor/skills-for-fabric/x.json']).class, 'steering');
});

test('classify: lock files and dist alone do not raise above normal', () => {
  assert.equal(cls(['package-lock.json']).class, 'normal');
  assert.equal(cls(['apps/foo/dist/x.js', 'package-lock.json']).class, 'normal');
  assert.equal(cls(['pnpm-lock.yaml', 'docs/a.md']).class, 'normal');
});

test('classify: REVIEW.md is infra (the skip-list ratchet reads it); hook dist and plugins are steering', () => {
  assert.equal(cls(['REVIEW.md']).class, 'infra');
  assert.equal(cls(['.claude/hooks/dist/x.mjs']).class, 'steering');
  assert.equal(cls(['.claude/plugins/foo/plugin.json']).class, 'steering');
});

test('classify: prisma and supabase migrations are r3; eval fixtures are not', () => {
  for (const p of ['prisma/schema.prisma', 'packages/db/prisma/migrations/1/x.ts', 'supabase/migrations/001.txt']) {
    assert.equal(cls([p]).class, 'r3', p);
  }
  const evals = cls(['.claude/skills/databases/evals/files/schema.sql', '.claude/skills/premortem/evals/files/migrations/0007_x.sql']);
  assert.equal(evals.class, 'steering');
  assert.equal(evals.matched.r3, undefined);
});

test('classify: no paths is normal with no counts', () => {
  assert.deepEqual(cls([]), { class: 'normal', matched: {} });
});

test('G9: Windows separators and ./ prefixes are normalised', () => {
  assert.equal(cls(['scripts\\github\\x.mjs']).class, 'infra');
  assert.equal(cls(['./docs/a.md']).class, 'docs');
});

// ---------- credits ----------

test('creditsState: null and junk are unknown, numbers are classified', () => {
  const st = (v, over = {}) => creditsState(cfg({}, { credits_used_manual: v, ...over }), NOW);
  assert.equal(st(null).status, 'unknown');
  assert.equal(st(null).used, null);
  for (const bad of ['40', -1, 1.5, NaN, undefined]) assert.equal(st(bad).status, 'unknown', String(bad));
  assert.equal(st(0).status, 'ok');
  assert.equal(st(34).status, 'ok');
  assert.equal(st(35).status, 'u1');
  assert.equal(st(44).status, 'u1');
  assert.equal(st(45).status, 'u2');
});

test('creditsState: u3_due flips on the u3 date', () => {
  const at = (iso) => creditsState(cfg(), new Date(iso)).u3_due;
  assert.equal(at('2026-11-02T23:59:00Z'), false);
  assert.equal(at('2026-11-03T00:00:00Z'), true);
});

// ---------- route ----------

const unknown = creditsState(cfg(), NOW);
const used = (n, over = {}) => creditsState(cfg(over, { credits_used_manual: n }), NOW);

test('route: docs gets the risk label only', () => {
  const r = route('docs', [], BASE, unknown);
  assert.deepEqual(r.add, ['risk:docs']);
  assert.equal(r.comment, null);
  assert.equal(r.held, null);
});

test('route: normal gets review:coderabbit', () => {
  assert.deepEqual(route('normal', [], BASE, unknown).add, ['risk:normal', 'review:coderabbit']);
});

test('route R-8: deep_enabled false holds steering, infra and r3 (never review:deep)', () => {
  for (const c of ['steering', 'infra', 'high']) {
    const r = route(c, [], BASE, unknown);
    assert.deepEqual(r.add, [`risk:${c}`, 'review:coderabbit', 'review:deep-held'], c);
    assert.equal(r.held, 'apex_d3');
    assert.match(r.comment, /Greptile deep review is held \(Apex billing, D3\)/);
    assert.match(r.comment, /Dave decides: wait, or land on CodeRabbit \+ xreview/);
  }
  const r3 = route('r3', [], BASE, unknown);
  assert.deepEqual(r3.add, ['risk:r3', 'risk:high', 'review:coderabbit', 'review:deep-held']);
  assert.ok(!r3.add.includes('review:deep'));
});

test('route: deep_enabled true gives review:deep alone and no hold', () => {
  const on = cfg({ deep_enabled: true });
  const r = route('steering', [], on, unknown);
  assert.deepEqual(r.add, ['risk:steering', 'review:deep']);
  assert.equal(r.held, null);
  assert.equal(r.comment, null);
});

test('route: at u2 with deep on, r3 keeps review:deep and steering/infra are held', () => {
  const on = cfg({ deep_enabled: true }, { credits_used_manual: 45 });
  const c = used(45, { deep_enabled: true });
  const r3 = route('r3', [], on, c);
  assert.ok(r3.add.includes('review:deep'));
  assert.ok(!r3.add.includes('review:deep-held'));
  for (const k of ['steering', 'infra']) {
    const r = route(k, [], on, c);
    assert.deepEqual(r.add, [`risk:${k}`, 'review:coderabbit', 'review:deep-held'], k);
    assert.equal(r.held, 'credits_u2');
    assert.match(r.comment, /45 of 50/);
  }
});

test('route: deep_enabled false dominates the credit hold reason', () => {
  assert.equal(route('infra', [], BASE, used(46)).held, 'apex_d3');
});

test('route: u1 warns on a review:deep PR, only at or above u1', () => {
  const on = cfg({ deep_enabled: true });
  assert.equal(route('infra', [], on, used(34, { deep_enabled: true })).comment, null);
  const r = route('infra', [], on, used(36, { deep_enabled: true }));
  assert.match(r.comment, /36 of 50/);
  assert.ok(r.add.includes('review:deep'));
});

test('route: unknown credits trigger no u1 or u2 step', () => {
  const on = cfg({ deep_enabled: true });
  const r = route('infra', [], on, creditsState(on, NOW));
  assert.deepEqual(r.add, ['risk:infra', 'review:deep']);
  assert.equal(r.held, null);
  assert.equal(r.comment, null);
});

test('route: u3 line only on a deep class, only on or after the date, names the login when set', () => {
  const late = new Date('2026-11-04T00:00:00Z');
  const on = cfg({ deep_enabled: true }, { notify_login: 'dave-login' });
  const r = route('infra', [], on, creditsState(on, late));
  assert.match(r.comment, /credit check/i);
  assert.match(r.comment, /@dave-login/);
  assert.equal(route('normal', [], on, creditsState(on, late)).comment, null);
  assert.equal(route('infra', [], on, creditsState(on, NOW)).comment, null);
  const known = cfg({ deep_enabled: true }, { credits_used_manual: 10 });
  assert.equal(route('infra', [], known, creditsState(known, late)).comment, null, 'a known count means no U3 line');
  const quiet = cfg({ deep_enabled: true });
  assert.doesNotMatch(route('infra', [], quiet, creditsState(quiet, late)).comment, /@/);
});

test('route: a person-set review:deep drops the held note and adds no review label', () => {
  const r = route('infra', ['review:deep'], BASE, unknown);
  assert.equal(r.held, null);
  assert.equal(r.comment, null);
  assert.deepEqual(r.add, ['risk:infra']);
});

test('route: a label already on the PR is not in add, but stays in wanted', () => {
  const r = route('normal', ['risk:normal', 'review:coderabbit'], BASE, unknown);
  assert.deepEqual(r.add, []);
  assert.deepEqual(r.wanted, ['risk:normal', 'review:coderabbit']);
});

// ---------- decide ----------

const dec = (event, p, labels, prev, over, now = NOW) => decide(event, p, labels, prev, over ?? BASE, { now });

test('R-1: a draft gets nothing, but the class is still reported', () => {
  const d = dec(READY, pr(['.github/x.yml'], { draft: true }), [], null);
  assert.deepEqual(d.add, []);
  assert.equal(d.noop, true);
  assert.equal(d.reason, 'draft');
  assert.equal(d.comment, null);
  assert.equal(d.class, 'infra');
});

test('decide: a closed PR gets nothing', () => {
  const d = dec(READY, pr(['docs/a.md'], { state: 'closed' }), [], null);
  assert.deepEqual(d.add, []);
  assert.equal(d.reason, 'not_open');
});

test('decide: ignored events do nothing', () => {
  const d = dec('assigned', pr(['docs/a.md']), [], null);
  assert.equal(d.noop, true);
  assert.equal(d.reason, 'event_ignored');
});

test('R-2 and R-3 through decide, for opened, reopened and ready_for_review', () => {
  for (const ev of ['opened', 'reopened', READY]) {
    assert.deepEqual(dec(ev, pr(['docs/x.md']), [B], null).add, ['risk:docs'], ev);
    const d = dec(ev, pr(['scripts/foo.mjs']), [B], null);
    assert.deepEqual(d.add, ['risk:normal', 'review:coderabbit'], ev);
    assert.equal(d.reason, 'routed');
  }
});

test('R-4 through decide: steering is held while deep is off', () => {
  const d = dec(READY, pr(['.claude/rules-src/x.md', 'docs/y.md']), [B], null);
  assert.deepEqual(d.add, ['risk:steering', 'review:coderabbit', 'review:deep-held']);
  assert.equal(d.held, 'apex_d3');
  assert.match(d.comment, /held/);
});

test('R-5 through decide: r3 gets review:deep at u2 when deep is on', () => {
  const on = cfg({ deep_enabled: true }, { credits_used_manual: 46 });
  const d = dec(READY, pr(['apps/agentic-os/drizzle/0004.sql']), [B], null, on);
  assert.deepEqual(d.add, ['risk:r3', 'risk:high', 'review:deep']);
});

test('synchronize with no router comment routes as a first run (no PR is stuck unrouted)', () => {
  const d = dec('synchronize', pr(['.github/x.yml']), [B], null);
  assert.equal(d.noop, false);
  assert.equal(d.reason, 'routed');
  assert.deepEqual(d.add, ['risk:infra', 'review:coderabbit', 'review:deep-held']);
});

test('edited: ignored unless the base branch changed, then routed like a push', () => {
  assert.equal(dec('edited', pr(['docs/a.md']), [B], null).reason, 'event_ignored');
  const d = dec('edited', pr(['.github/x.yml'], { baseChanged: true }), [B], null);
  assert.equal(d.reason, 'routed');
  const up = dec('edited', pr(['.github/x.yml'], { baseChanged: true }), ['risk:normal', 'review:coderabbit', B], 'normal');
  assert.equal(up.reason, 'raised');
});

test('R-6: a push that lowers the class removes and adds nothing', () => {
  const labels = ['risk:steering', 'review:coderabbit', 'review:deep-held', B];
  const d = dec('synchronize', pr(['docs/a.md']), labels, 'steering');
  assert.deepEqual(d.add, []);
  assert.equal(d.reason, 'no_change');
  assert.ok(!('remove' in d));
  assert.equal(d.class, 'docs');
  assert.equal(d.effective, 'steering');
});

test('a raise keeps a review label the person removed removed, and still adds the new class labels', () => {
  const labels = ['risk:normal', B]; // the router added review:coderabbit for normal; a person removed it
  const d = dec('synchronize', pr(['.github/workflows/x.yml']), labels, 'normal');
  assert.equal(d.reason, 'raised');
  assert.ok(!d.add.includes('review:coderabbit'), `person removal undone: ${d.add.join(', ')}`);
  assert.deepEqual(d.add, ['risk:infra', 'review:deep-held']);
});

test('a raise after deep_enabled flips on adds review:deep (it was never added, so it is not a person removal)', () => {
  const labels = ['risk:steering', 'review:coderabbit', 'review:deep-held', B]; // routed while deep was off
  const d = decide('synchronize', pr(['.github/workflows/x.yml']), labels, 'steering', cfg({ deep_enabled: true }));
  assert.equal(d.reason, 'raised');
  assert.ok(d.add.includes('review:deep'), `review:deep must be added: ${d.add.join(', ')}`);
});

test('a push that raises the class adds the new labels and keeps the old ones', () => {
  const labels = ['risk:normal', 'review:coderabbit', B];
  const d = dec('synchronize', pr(['scripts/a.mjs', '.github/workflows/x.yml']), labels, 'normal');
  assert.equal(d.reason, 'raised');
  assert.deepEqual(d.add, ['risk:infra', 'review:deep-held']);
  assert.ok(!('remove' in d));
});

test('R-7: a review label a person removed is not added back', () => {
  const on = cfg({ deep_enabled: true });
  const labels = ['risk:r3', 'risk:high', B]; // person removed review:deep
  for (const ev of ['synchronize', READY]) {
    const d = dec(ev, pr(['x/y.sql']), labels, 'r3', on);
    assert.deepEqual(d.add, [], ev);
    assert.equal(d.reason, 'person_override', ev);
  }
});

test('a review label a person already set stops the router adding another', () => {
  const d = dec(READY, pr(['.github/x.yml']), ['review:coderabbit', B], null);
  assert.deepEqual(d.add, ['risk:infra']);
  assert.equal(d.reason, 'person_override');
  assert.ok(!d.add.some((l) => l.startsWith('review:')));
});

test('a risk label a person added above the comment class is a raise and gets its review label', () => {
  const labels = ['risk:normal', 'review:coderabbit', 'risk:high', B];
  const held = dec('synchronize', pr(['scripts/a.mjs']), labels, 'normal');
  assert.equal(held.reason, 'raised');
  assert.deepEqual(held.add, ['review:deep-held']);
  const on = dec('synchronize', pr(['scripts/a.mjs']), labels, 'normal', cfg({ deep_enabled: true }));
  assert.deepEqual(on.add, ['review:deep']);
});

test('first run with a person-set risk:high and no router comment routes for high', () => {
  const d = dec(READY, pr(['scripts/a.mjs']), ['risk:high', B], null);
  assert.equal(d.reason, 'routed');
  assert.deepEqual(d.add, ['review:coderabbit', 'review:deep-held']);
  assert.equal(d.effective, 'high');
});

test('a risk label a person removed is not added back when the class did not rise', () => {
  const d = dec('synchronize', pr(['.claude/agents/x.md']), ['review:coderabbit', 'review:deep-held', B], 'steering');
  assert.deepEqual(d.add, []);
  assert.equal(d.reason, 'person_override');
  const r3 = dec('synchronize', pr(['x/y.sql']), ['risk:high', 'review:coderabbit', 'review:deep-held', B], 'r3');
  assert.deepEqual(r3.add, [], 'risk:r3 removed, risk:high left: not re-added');
  assert.equal(r3.reason, 'person_override');
});

test('idempotent: a re-run after the labels exist adds nothing and says no_change', () => {
  const first = dec(READY, pr(['.github/x.yml']), [B], null);
  const labels = [B, ...first.add];
  const second = dec(READY, pr(['.github/x.yml']), labels, 'infra');
  assert.deepEqual(second.add, []);
  assert.equal(second.reason, 'no_change');
  assert.equal(second.comment, first.comment, 'the comment text is regenerated whole, so an update keeps the held notice');
});

test('builder: none -> comment mentions it and nothing is blocked; one -> no line; two -> comment', () => {
  const none = dec(READY, pr(['scripts/a.mjs']), [], null);
  assert.match(none.comment, /builder/i);
  assert.deepEqual(none.add, ['risk:normal', 'review:coderabbit']);
  assert.equal(none.builder, null);
  const one = dec(READY, pr(['scripts/a.mjs']), ['builder:grok'], null);
  assert.equal(one.comment, null);
  assert.equal(one.builder, 'grok');
  const two = dec(READY, pr(['scripts/a.mjs']), ['builder:grok', 'builder:claude'], null);
  assert.match(two.comment, /more than one/i);
  assert.equal(two.builder, 'multiple');
});

test('builderOf reads only builder:* labels', () => {
  assert.equal(builderOf(['builder:claude', 'risk:docs']), 'claude');
  assert.equal(builderOf(['risk:docs']), null);
});

test('CodeRabbit rate limit: one note in the comment, no reroute', () => {
  const d = dec(READY, pr(['scripts/a.mjs'], { codeRabbitRateLimited: true }), [B], null);
  assert.match(d.comment, /CodeRabbit is rate limited/);
  assert.deepEqual(d.add, ['risk:normal', 'review:coderabbit']);
  assert.ok(!d.add.includes('review:deep'));
  const docs = dec(READY, pr(['docs/a.md'], { codeRabbitRateLimited: true }), [B], null);
  assert.equal(docs.comment, null, 'docs needs no CodeRabbit review, so the note is noise');
});

test('codeRabbitRateLimited: only the CodeRabbit app, only a rate-limit notice that names the head', () => {
  const marker = '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->';
  const notice = (sha, heading = 'Rate limit exceeded') => `${marker}\n> ## ${heading}\n> Commit: [${sha.slice(0, 7)}](https://github.com/o/r/commit/${sha})\n`;
  const bot = (body) => ({ id: 1, user: { login: 'coderabbitai[bot]', type: 'Bot' }, body, created_at: '2026-10-26T10:00:00Z' });
  assert.equal(codeRabbitRateLimited([bot(notice(HEAD))], HEAD), true);
  assert.equal(codeRabbitRateLimited([bot(notice('b'.repeat(40)))], HEAD), false);
  assert.equal(codeRabbitRateLimited([bot(notice(HEAD, 'Review skipped'))], HEAD), false);
  assert.equal(codeRabbitRateLimited([{ ...bot(notice(HEAD)), user: { login: 'someone', type: 'User' } }], HEAD), false);
  assert.equal(codeRabbitRateLimited([], HEAD), false);
});

// ---------- previousClassFrom, comment, ops ----------

const bot = (id, body, over = {}) => ({ id, user: { login: 'github-actions[bot]', type: 'Bot' }, body, ...over });

test('previousClassFrom reads only the comment state; labels never count', () => {
  assert.equal(previousClassFrom(''), null);
  assert.equal(previousClassFrom(null), null);
  assert.equal(previousClassFrom(renderComment('x', 'steering', HEAD)), 'steering');
  assert.equal(previousClassFrom(`${ROUTER_MARKER}\n<!-- review-router-state class=nonsense -->`), null);
  assert.equal(previousClassFrom(`${ROUTER_MARKER}\n<!-- review-router-state class=infra -->`), 'infra', 'old state without a head still reads');
});

test('state carries the class and the full head', () => {
  const body = renderComment('x', 'infra', HEAD);
  assert.match(body, new RegExp(`<!-- review-router-state class=infra head=${HEAD} -->`));
  assert.deepEqual(stateFrom(body), { class: 'infra', head: HEAD, held: null });
  assert.deepEqual(stateFrom(`${ROUTER_MARKER}\n<!-- review-router-state class=infra -->`), { class: 'infra', head: null, held: null });
  assert.deepEqual(stateFrom('nothing'), { class: null, head: null, held: null });
});

test('renderComment: the marker appears once and the body starts with it', () => {
  const body = renderComment('hello', 'infra', HEAD);
  assert.equal(body.split(ROUTER_MARKER).length - 1, 1);
  assert.ok(body.startsWith(ROUTER_MARKER));
  assert.match(body, /hello/);
});

test('findRouterComment: only github-actions[bot] (type Bot), marker first, LOWEST id wins', () => {
  const body = renderComment('x', 'infra', HEAD);
  assert.equal(findRouterComment([bot(9, body), bot(4, body), bot(7, body)]).id, 4);
  assert.equal(findRouterComment([bot(1, 'x')]), null);
  assert.equal(findRouterComment([]), null);
  assert.equal(findRouterComment(null), null);
});

test('findRouterComment: a forged marker is ignored (person, wrong bot, wrong type, marker not first)', () => {
  const body = renderComment('x', 'r3', HEAD);
  const person = { id: 1, user: { login: 'Rev4nchist', type: 'User' }, body };
  const otherBot = bot(2, body, { user: { login: 'coderabbitai[bot]', type: 'Bot' } });
  const spoofType = bot(3, body, { user: { login: 'github-actions[bot]', type: 'User' } });
  const quoted = bot(4, `Dry run:\n${body}`);
  const noUser = { id: 5, body };
  assert.equal(findRouterComment([person, otherBot, spoofType, quoted, noUser]), null);
  assert.equal(findRouterComment([person, bot(8, body)]).id, 8, 'the real one wins even with a lower forged id');
});

test('maskMarker: a dry-run print cannot be pasted as a live router comment', () => {
  const masked = maskMarker(renderComment('x', 'r3', HEAD));
  assert.ok(!masked.includes('<!-- review-router'));
  assert.match(masked, /dry-run/);
  const dry = applyOps([{ op: 'comment-create', body: renderComment('x', 'r3', HEAD) }], { repo: 'o/r', pr: 7, dryRun: true, gh: null });
  assert.ok(!dry.join('\n').includes('<!-- review-router'));
});

const decisionFor = (labels, prev, p = pr(['.github/x.yml']), over) => dec(READY, p, labels, prev, over);

const posted = (id, ops) => bot(id, ops.find((o) => o.op.startsWith('comment')).body);

test('R-8: first run creates one comment and one label call; the re-run on the same head does neither', () => {
  const d1 = decisionFor([B], null);
  const ops1 = planOps(d1, null);
  assert.deepEqual(ops1.map((o) => o.op), ['labels', 'comment-create']);
  const existing = posted(55, ops1);
  const labels2 = [B, ...d1.add];
  const d2 = decisionFor(labels2, previousClassFrom(existing.body));
  assert.deepEqual(planOps(d2, existing), []);
});

test('a docs PR with no notes still gets the comment (resolved text), so the state exists', () => {
  const d = dec(READY, pr(['docs/a.md']), [B], null);
  assert.equal(d.comment, null);
  const ops = planOps(d, null);
  assert.deepEqual(ops.map((o) => o.op), ['labels', 'comment-create']);
  assert.match(ops[1].body, /No open router notes/);
  assert.match(ops[1].body, new RegExp(`head=${HEAD}`));
});

test('every run on a new head updates the comment, even when nothing else changes', () => {
  const d1 = decisionFor([B], null);
  const existing = posted(55, planOps(d1, null));
  const labels = [B, ...d1.add];
  const newHead = 'c'.repeat(40);
  const d2 = dec('synchronize', pr(['.github/x.yml'], { head: newHead }), labels, 'infra');
  assert.deepEqual(d2.add, []);
  const ops = planOps(d2, existing);
  assert.deepEqual(ops.map((o) => o.op), ['comment-update']);
  assert.equal(ops[0].id, 55);
  assert.match(ops[0].body, new RegExp(`head=${newHead}`));
  assert.deepEqual(planOps(d2, bot(55, ops[0].body)), [], 'same head again: no second update');
});

test('a stale class in the comment is updated, in place, never a second comment', () => {
  const old = bot(55, renderComment('old text', 'normal', HEAD));
  const d = decisionFor([B, 'risk:normal', 'review:coderabbit'], 'normal');
  const ops = planOps(d, old);
  assert.deepEqual(ops.map((o) => o.op), ['labels', 'comment-update']);
  assert.match(ops[1].body, /class=infra/);
  assert.ok(!ops.some((o) => o.op === 'comment-create'));
});

test('notes gone: an old note comment becomes the resolved text once', () => {
  const d = dec(READY, pr(['scripts/a.mjs']), ['risk:normal', 'review:coderabbit', B], 'normal');
  assert.equal(d.comment, null);
  const old = bot(9, renderComment('Builder label is missing.', 'normal', HEAD));
  const ops = planOps(d, old);
  assert.deepEqual(ops.map((o) => o.op), ['comment-update']);
  assert.match(ops[0].body, /No open router notes/);
  assert.deepEqual(planOps(d, bot(9, ops[0].body)), []);
});

test('planOps: a noop decision (draft, closed, ignored event) plans nothing', () => {
  assert.deepEqual(planOps(dec(READY, pr(['.github/x.yml'], { draft: true }), [], null), null), []);
  assert.deepEqual(planOps(dec('labeled', pr(['.github/x.yml']), [], null), null), []);
});

test('applyOps: a dry run never calls gh; a real run sends labels in one call and the comment once', () => {
  const calls = [];
  const gh = (args) => { calls.push(args); return { id: 1 }; };
  const ops = planOps(decisionFor([B], null), null);
  const dry = applyOps(ops, { repo: 'o/r', pr: 7, dryRun: true, gh });
  assert.equal(calls.length, 0);
  assert.equal(dry.length, 2);
  applyOps(ops, { repo: 'o/r', pr: 7, dryRun: false, gh });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].join(' ').includes('repos/o/r/issues/7/labels'));
  assert.equal(calls[0].filter((a) => a.startsWith('labels[]=')).length, 3, 'risk:infra, review:coderabbit, review:deep-held');
  assert.ok(calls[1].join(' ').includes('repos/o/r/issues/7/comments'));
  assert.ok(!calls[1].join(' ').includes('PATCH'));
});

test('applyOps: an update uses PATCH on the comment id', () => {
  const calls = [];
  const gh = (args) => { calls.push(args); return {}; };
  applyOps([{ op: 'comment-update', id: 55, body: 'b' }], { repo: 'o/r', pr: 7, dryRun: false, gh });
  assert.ok(calls[0].includes('PATCH'));
  assert.ok(calls[0].join(' ').includes('repos/o/r/issues/comments/55'));
});

test('changedPaths: includes the old name of a rename, dedupes, and refuses a truncated list', () => {
  const files = [{ filename: 'docs/new.md', previous_filename: '.github/old.yml' }, { filename: 'docs/new.md' }];
  assert.deepEqual(changedPaths(files, { changed_files: 2 }).sort(), ['.github/old.yml', 'docs/new.md']);
  assert.throws(() => changedPaths([{ filename: 'a' }], { changed_files: 3000 }), /3000|incomplete|truncated/i);
});

// ---------- ledger (R-9) and CLI ----------

test('R-9: one ledger line per decision, valid JSON, tool router, unknown credits stated', () => {
  const d = dec(READY, pr(['.github/x.yml']), [B], null);
  const line = ledgerLine({ d, pr: pr(['.github/x.yml']), event: READY, ops: planOps(d, null), now: NOW });
  assert.ok(!line.includes('\n'));
  const j = JSON.parse(line);
  for (const k of ['ts', 'pr', 'head', 'event', 'class', 'paths_matched', 'labels_added', 'held_reason', 'builder', 'credits', 'tool']) {
    assert.ok(k in j, k);
  }
  assert.equal(j.tool, 'router');
  assert.equal(j.pr, 7);
  assert.equal(j.head, HEAD);
  assert.equal(j.class, 'infra');
  assert.deepEqual(j.labels_added, ['risk:infra', 'review:coderabbit', 'review:deep-held']);
  assert.equal(j.held_reason, 'apex_d3');
  assert.equal(j.builder, 'claude');
  assert.equal(j.credits.used, null);
  assert.equal(j.credits.status, 'unknown');
  assert.equal(j.ts, NOW.toISOString());
});

test('R-9: person_override and draft are written to held_reason', () => {
  const on = cfg({ deep_enabled: true });
  const d = dec('synchronize', pr(['x/y.sql']), ['risk:r3', 'risk:high', B], 'r3', on);
  assert.equal(JSON.parse(ledgerLine({ d, pr: pr(['x/y.sql']), event: 'synchronize', ops: [], now: NOW })).held_reason, 'person_override');
  const dd = dec(READY, pr(['docs/a.md'], { draft: true }), [], null);
  assert.equal(JSON.parse(ledgerLine({ d: dd, pr: pr(['docs/a.md']), event: READY, ops: [], now: NOW })).held_reason, 'draft');
});

const PINNED_CONFIG = path.join(mkdtempSync(path.join(os.tmpdir(), 'router-cfg-')), 'config.json');
writeFileSync(PINNED_CONFIG, JSON.stringify(BASE));

function runCli(fixture, extra = [], env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'router-'));
  const file = path.join(dir, 'fixture.json');
  writeFileSync(file, JSON.stringify(fixture));
  return execFileSync(process.execPath,
    [path.join(HERE, 'review-router.mjs'), '7', '--dry-run', '--fixture', file, '--config', PINNED_CONFIG, ...extra],
    { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', RUNNER_TEMP: '', ...env } });
}
const ledgerOf = (out) => JSON.parse(out.split('\n').find((l) => l.startsWith('{')));

const FIX = (over = {}, comments = []) => ({
  pull: { number: 7, state: 'open', draft: false, changed_files: 2, head: { sha: HEAD }, labels: [{ name: B }], ...over },
  files: [{ filename: '.github/workflows/x.yml' }, { filename: 'scripts/github/y.mjs' }],
  comments,
});

test('CLI dry run on a fixture prints one ledger JSON line and the planned writes, and exits 0', () => {
  const out = runCli(FIX(), ['--event', READY]);
  assert.equal(out.split('\n').filter((l) => l.startsWith('{')).length, 1);
  const j = ledgerOf(out);
  assert.equal(j.class, 'infra');
  assert.deepEqual(j.labels_added, ['risk:infra', 'review:coderabbit', 'review:deep-held']);
  assert.match(out, /DRY RUN/);
  assert.ok(!out.includes('<!-- review-router'), 'the dry-run print masks the marker');
});

test('CLI: a draft fixture adds nothing; --assume-ready shows what would happen', () => {
  const draft = runCli(FIX({ draft: true }), ['--event', READY]);
  assert.deepEqual(ledgerOf(draft).labels_added, []);
  const j = ledgerOf(runCli(FIX({ draft: true }), ['--event', READY, '--assume-ready']));
  assert.deepEqual(j.labels_added, ['risk:infra', 'review:coderabbit', 'review:deep-held']);
  assert.equal(j.assumed_ready, true);
});

test('CLI: a forged marker comment by a person is ignored: labels added, comment 555 never updated', () => {
  const forged = { id: 555, user: { login: 'Rev4nchist', type: 'User' },
    body: 'Dry run output:\n# <!-- review-router -->\n# <!-- review-router-state class=r3 -->\n# create the router comment' };
  const out = runCli(FIX({}, [forged]), ['--event', READY]);
  const j = ledgerOf(out);
  assert.equal(j.class, 'infra', 'the forged r3 state is not trusted');
  assert.deepEqual(j.labels_added, ['risk:infra', 'review:coderabbit', 'review:deep-held']);
  assert.equal(j.comment, 'create');
  assert.doesNotMatch(out, /update router comment 555/);
});

test('CLI: the genuine bot comment is the state; an old head gets an in-place update and no new labels', () => {
  const state = bot(31, renderComment('High-risk PR.', 'infra', 'b'.repeat(40)));
  const labels = [B, 'risk:infra', 'review:coderabbit', 'review:deep-held'].map((name) => ({ name }));
  const out = runCli(FIX({ labels }, [state]), ['--event', 'synchronize']);
  const j = ledgerOf(out);
  assert.deepEqual(j.labels_added, []);
  assert.equal(j.comment, 'update');
  assert.match(out, /update router comment 31/);
});

test('CLI: a truncated file list exits 2 and still prints one error ledger line', () => {
  let err;
  try { runCli(FIX({ changed_files: 3000 }), ['--event', READY]); } catch (e) { err = e; }
  assert.equal(err.status, 2);
  const j = ledgerOf(err.stdout);
  assert.equal(j.decision, 'error');
  assert.equal(j.tool, 'router');
  assert.match(j.error, /incomplete/);
  assert.equal(j.pr, 7);
});

test('CLI: the ledger line is appended to $RUNNER_TEMP/review-ledger.jsonl', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'router-run-'));
  const out = runCli(FIX(), ['--event', READY], { RUNNER_TEMP: tmp });
  const file = readFileSync(path.join(tmp, 'review-ledger.jsonl'), 'utf8').trim().split('\n');
  assert.equal(file.length, 1);
  assert.equal(file[0], out.split('\n').find((l) => l.startsWith('{')));
});

// ---------- follow-ups: held release, person label rows, files pinned to the head ----------

const ON = cfg({ deep_enabled: true });
const HELD_LABELS = ['risk:steering', 'review:coderabbit', 'review:deep-held', B];
const decH = (labels, prevHeld, over = ON, event = 'synchronize') =>
  decide(event, pr(['.claude/agents/x.md']), labels, 'steering', over, { now: NOW, previousHeld: prevHeld });

test('release: a PR held while deep was off gets review:deep once deep is on (only that label)', () => {
  const d = decH(HELD_LABELS, 'apex_d3');
  assert.equal(d.reason, 'released');
  assert.deepEqual(d.add, ['review:deep']);
  assert.equal(d.held, null, 'the saved state no longer says held');
  assert.ok(!('remove' in d), 'review:deep-held is never removed');
});

test('release: only review:deep is added, even when a person removed the risk label meanwhile', () => {
  const d = decH(['review:coderabbit', 'review:deep-held', B], 'apex_d3');
  assert.equal(d.reason, 'released');
  assert.deepEqual(d.add, ['review:deep']);
});

test('release: a saved credit hold is released when credits drop back under u2', () => {
  const d = decH(HELD_LABELS, 'credits_u2', cfg({ deep_enabled: true }, { credits_used_manual: 3 }));
  assert.equal(d.reason, 'released');
  assert.deepEqual(d.add, ['review:deep']);
});

test('release: no saved hold means review:deep missing is a person removal (state, not labels, decides)', () => {
  const d = decH(HELD_LABELS, null);
  assert.equal(d.reason, 'person_override');
  assert.deepEqual(d.add, []);
});

test('release: while deep is still off nothing is added and the hold stays saved', () => {
  const d = decH(HELD_LABELS, 'apex_d3', BASE);
  assert.equal(d.reason, 'no_change');
  assert.deepEqual(d.add, []);
  assert.equal(d.held, 'apex_d3');
  assert.match(renderComment('x', d.effective, HEAD, d.held), /held=apex_d3/);
});

test('release: a person who removed review:deep-held during the hold opted out; nothing is added', () => {
  const d = decH(['risk:steering', 'review:coderabbit', B], 'apex_d3');
  assert.deepEqual(d.add, []);
  assert.equal(d.reason, 'person_override');
});

test('release once: after the release a person removing review:deep is not undone', () => {
  const first = decH(HELD_LABELS, 'apex_d3');
  const saved = stateFrom(renderComment('x', first.effective, HEAD, first.held)).held;
  assert.equal(saved, null);
  const later = decH(HELD_LABELS, saved); // a person removed review:deep after the release
  assert.deepEqual(later.add, []);
  assert.equal(later.reason, 'person_override');
});

test('held state: renderComment writes held only when set; stateFrom reads it; old comments still parse', () => {
  assert.equal(renderComment('x', 'infra', HEAD), `${ROUTER_MARKER}\n<!-- review-router-state class=infra head=${HEAD} -->\nx`);
  const body = renderComment('x', 'infra', HEAD, 'apex_d3');
  assert.deepEqual(stateFrom(body), { class: 'infra', head: HEAD, held: 'apex_d3' });
  assert.deepEqual(stateFrom(renderComment('x', 'infra', HEAD)), { class: 'infra', head: HEAD, held: null });
  assert.equal(stateFrom(`${ROUTER_MARKER}\n<!-- review-router-state class=infra head=${HEAD} held=junk -->`).held, null);
});

test('held state: planOps saves the hold, and a release rewrites the comment without it', () => {
  const held = dec(READY, pr(['.github/x.yml']), [B], null);
  const [, create] = planOps(held, null);
  assert.match(create.body, /class=infra head=a{40} held=apex_d3 -->/);
  const rel = decide('synchronize', pr(['.github/x.yml']), ['risk:infra', 'review:coderabbit', 'review:deep-held', B], 'infra', ON,
    { now: NOW, previousHeld: 'apex_d3' });
  const ops = planOps(rel, { id: 9, body: create.body });
  assert.deepEqual(ops[0], { op: 'labels', labels: ['review:deep'] });
  assert.doesNotMatch(ops[1].body, /held=/);
});

test('labeled / unlabeled: a person label change writes a ledger row and nothing else', () => {
  for (const ev of ['labeled', 'unlabeled']) {
    const d = dec(ev, pr(['.github/x.yml']), ['review:deep', B], 'infra');
    assert.equal(d.noop, true, ev);
    assert.deepEqual(d.add, [], ev);
    assert.equal(d.reason, 'person_label', ev);
    assert.deepEqual(planOps(d, null), [], ev);
    const j = JSON.parse(ledgerLine({ d, pr: pr(['.github/x.yml'], { labelChange: { name: 'review:deep', by: 'dave' } }), event: ev, now: NOW }));
    assert.equal(j.decision, 'person_label');
    assert.equal(j.held_reason, 'person_label');
    assert.equal(j.label, 'review:deep');
    assert.equal(j.by, 'dave');
  }
});

test('CLI: a labeled event payload gives one ledger row with the label and the person, and no writes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'router-ev-'));
  const ev = path.join(dir, 'event.json');
  writeFileSync(ev, JSON.stringify({ action: 'unlabeled', label: { name: 'review:coderabbit' }, sender: { login: 'dave', type: 'User' }, pull_request: { number: 7 } }));
  const out = runCli(FIX(), [], { GITHUB_EVENT_PATH: ev });
  const j = ledgerOf(out);
  assert.equal(j.event, 'unlabeled');
  assert.equal(j.decision, 'person_label');
  assert.equal(j.label, 'review:coderabbit');
  assert.equal(j.by, 'dave');
  assert.deepEqual(j.labels_added, []);
  assert.match(out, /no writes planned/);
});

const fakeGh = (pull, { compareFiles = [], pullFiles = [], comments = [] } = {}) => {
  const calls = [];
  const gh = (args) => {
    const url = args.find((a) => a.startsWith('repos/'));
    calls.push(url);
    if (/\/compare\//.test(url)) return { files: compareFiles };
    if (/\/pulls\/\d+\/files/.test(url)) return [pullFiles];
    if (/\/issues\/\d+\/comments/.test(url)) return [comments];
    if (/\/pulls\/\d+$/.test(url)) return pull;
    throw new Error(`unexpected call ${url}`);
  };
  return { gh, calls };
};
const LIVE_PULL = { number: 7, changed_files: 1, head: { sha: HEAD }, base: { ref: 'main', sha: 'c'.repeat(40) } };

test('loadLive (N5): files come from compare pinned to the head SHA, not the lagging PR files list', () => {
  const { gh, calls } = fakeGh(LIVE_PULL, { compareFiles: [{ filename: '.github/x.yml' }], pullFiles: [{ filename: 'docs/stale.md' }] });
  const got = loadLive(gh, 'o/r', 7);
  assert.deepEqual(got.files.map((f) => f.filename), ['.github/x.yml']);
  assert.equal(got.filesSource, 'compare');
  assert.ok(calls.includes(`repos/o/r/compare/${'c'.repeat(40)}...${HEAD}`), `pinned to base.sha and head.sha: ${calls.join(' | ')}`);
  assert.ok(!calls.some((c) => /\/pulls\/7\/files/.test(c)));
});

test('loadLive: above the compare cap the paginated PR files list is used and the ledger says so', () => {
  const big = { ...LIVE_PULL, changed_files: COMPARE_FILE_CAP + 1 };
  const many = Array.from({ length: COMPARE_FILE_CAP + 1 }, (_, i) => ({ filename: `docs/${i}.md` }));
  const { gh, calls } = fakeGh(big, { pullFiles: many });
  const got = loadLive(gh, 'o/r', 7);
  assert.equal(got.filesSource, 'pulls');
  assert.equal(got.files.length, COMPARE_FILE_CAP + 1);
  assert.ok(!calls.some((c) => /\/compare\//.test(c)));
  assert.equal(COMPARE_FILE_CAP, 300, 'GitHub compare returns at most 300 files, all on page 1 (measured 2026-10-26)');
});

const seqGh = (pulls, compareFiles) => {
  const calls = [];
  let p = 0;
  const gh = (args) => {
    const url = args.find((a) => a.startsWith('repos/'));
    calls.push(url);
    if (/\/compare\//.test(url)) return { files: compareFiles };
    if (/\/issues\/\d+\/comments/.test(url)) return [[]];
    if (/\/pulls\/\d+$/.test(url)) return pulls[Math.min(p++, pulls.length - 1)];
    throw new Error(`unexpected call ${url}`);
  };
  return { gh, calls };
};

test('loadLive: a changed_files count that lags the push is re-read before giving up', () => {
  const two = [{ filename: 'a.mjs' }, { filename: 'b.mjs' }];
  const { gh, calls } = seqGh([{ ...LIVE_PULL, changed_files: 1 }, { ...LIVE_PULL, changed_files: 2 }], two);
  let slept = 0;
  const got = loadLive(gh, 'o/r', 7, { sleep: () => { slept++; }, waitMs: 0 });
  assert.equal(slept, 1);
  assert.equal(got.pull.changed_files, 2);
  assert.deepEqual(changedPaths(got.files, got.pull), ['a.mjs', 'b.mjs']);
  assert.equal(calls.filter((c) => /\/pulls\/7$/.test(c)).length, 2);
});

test('loadLive: a mismatch that never settles stops after 3 reads and changedPaths refuses it', () => {
  const { gh, calls } = seqGh([{ ...LIVE_PULL, changed_files: 1 }], [{ filename: 'a' }, { filename: 'b' }]);
  const got = loadLive(gh, 'o/r', 7, { sleep: () => {}, waitMs: 0 });
  assert.equal(calls.filter((c) => /\/compare\//.test(c)).length, 3);
  assert.throws(() => changedPaths(got.files, got.pull), /2 of 1/);
});

test('loadLive: a label event reads no files', () => {
  const { gh, calls } = seqGh([LIVE_PULL], []);
  const got = loadLive(gh, 'o/r', 7, { filesNeeded: false });
  assert.equal(got.files, null);
  assert.ok(!calls.some((c) => /\/compare\/|\/files/.test(c)), calls.join(' | '));
});

test('release: an unknown credit count never ends a credit hold (a config typo spends no credits)', () => {
  for (const v of [null, 'forty', -1]) {
    const d = decH(HELD_LABELS, 'credits_u2', cfg({ deep_enabled: true }, { credits_used_manual: v }));
    assert.deepEqual(d.add, [], String(v));
    assert.notEqual(d.reason, 'released', String(v));
  }
});

test('labeled: the ledger row reports no class (no files were read)', () => {
  const d = dec('labeled', pr([]), ['review:deep', B], 'infra');
  assert.equal(d.class, null);
  assert.equal(JSON.parse(ledgerLine({ d, pr: pr([]), event: 'labeled', now: NOW })).class, null);
});

test('workflow: each label run has its own concurrency group (never replaces a push run or another label run)', () => {
  const yml = readFileSync(path.join(HERE, '..', '..', '.github', 'workflows', 'review-router.yml'), 'utf8');
  assert.match(yml, /group: review-router-\$\{\{[^\n]*\}\}-\$\{\{ \(github\.event\.action == 'labeled' \|\| github\.event\.action == 'unlabeled'\) && format\('label-\{0\}', github\.run_id\) \|\| 'route' \}\}/);
});

test('labeled on a closed or draft PR: still a person_label row with no class', () => {
  for (const extra of [{ state: 'closed' }, { draft: true }]) {
    const d = dec('labeled', pr([], extra), ['risk:high', B], 'normal');
    assert.equal(d.reason, 'person_label', JSON.stringify(extra));
    assert.equal(d.class, null, JSON.stringify(extra));
    assert.deepEqual(d.add, []);
  }
});

test('changedPaths: more files than the PR has is refused too (compare against a moved base)', () => {
  assert.throws(() => changedPaths([{ filename: 'a' }, { filename: 'b' }], { changed_files: 1 }), /2 of 1/);
});

test('ledger: files_source is written when known', () => {
  const d = dec(READY, pr(['docs/a.md']), [B], null);
  const j = JSON.parse(ledgerLine({ d, pr: pr(['docs/a.md'], { filesSource: 'compare' }), event: READY, ops: [], now: NOW }));
  assert.equal(j.files_source, 'compare');
});
