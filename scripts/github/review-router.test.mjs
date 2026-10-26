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
// ledger / CLI
//   - the ledger line is not one line of valid JSON, or hides unknown credits -> R-9
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  globToRegExp, matchGlob, classify, creditsState, route, decide, previousClassFrom, builderOf,
  ROUTER_MARKER, renderComment, findRouterComment, planOps, applyOps, changedPaths, codeRabbitRateLimited, ledgerLine,
} from './review-router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'review-router.config.json'), 'utf8'));
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
  assert.equal(cls(['.claude/hooks/dist/x.mjs', 'package-lock.json']).class, 'normal');
  assert.equal(cls(['pnpm-lock.yaml', 'docs/a.md']).class, 'normal');
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
  const quiet = cfg({ deep_enabled: true });
  assert.doesNotMatch(route('infra', [], quiet, creditsState(quiet, late)).comment, /@/);
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
  const d = dec('labeled', pr(['docs/a.md']), [], null);
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

test('synchronize with no earlier routing does nothing (not_routed)', () => {
  const d = dec('synchronize', pr(['.github/x.yml']), [B], null);
  assert.equal(d.noop, true);
  assert.equal(d.reason, 'not_routed');
  assert.deepEqual(d.add, []);
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

test('a person-added risk:high with no routing is respected on a push', () => {
  const d = dec('synchronize', pr(['scripts/a.mjs']), ['risk:high', B], 'high');
  assert.deepEqual(d.add, []);
});

test('idempotent: a re-run after the labels exist adds nothing and says no_change', () => {
  const first = dec(READY, pr(['.github/x.yml']), [B], null);
  const labels = [B, ...first.add];
  const second = dec(READY, pr(['.github/x.yml']), labels, previousClassFrom(labels));
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

test('previousClassFrom: highest risk label wins, junk is ignored', () => {
  assert.equal(previousClassFrom([]), null);
  assert.equal(previousClassFrom(['bug', 'review:deep']), null);
  assert.equal(previousClassFrom(['risk:docs', 'risk:normal']), 'normal');
  assert.equal(previousClassFrom(['risk:r3', 'risk:high']), 'r3');
  assert.equal(previousClassFrom(['risk:high']), 'high');
  assert.equal(previousClassFrom(['risk:infra', 'risk:steering']), 'infra');
  assert.equal(previousClassFrom(['risk:bogus']), null);
});

test('previousClassFrom: the comment state keeps the class when a person removed the risk labels', () => {
  const body = renderComment('x', 'steering');
  assert.equal(previousClassFrom([], body), 'steering');
  assert.equal(previousClassFrom(['risk:docs'], body), 'steering');
  assert.equal(previousClassFrom(['risk:infra'], body), 'infra');
  assert.equal(previousClassFrom([], `${ROUTER_MARKER}\n<!-- review-router-state class=nonsense -->`), null);
});

test('renderComment: the marker appears once; findRouterComment finds it by marker only', () => {
  const body = renderComment('hello', 'infra');
  assert.equal(body.split(ROUTER_MARKER).length - 1, 1);
  assert.match(body, /hello/);
  assert.equal(findRouterComment([{ id: 1, body: 'x' }, { id: 2, body }, { id: 3, body }]).id, 3, 'newest copy');
  assert.equal(findRouterComment([{ id: 1, body: 'x' }]), null);
  assert.equal(findRouterComment([]), null);
});

const decisionFor = (labels, prev, p = pr(['.github/x.yml']), over) => dec(READY, p, labels, prev, over);

test('R-8: first run creates one comment and one label call; the re-run does neither', () => {
  const d1 = decisionFor([B], null);
  const ops1 = planOps(d1, null, 7);
  assert.deepEqual(ops1.map((o) => o.op), ['labels', 'comment-create']);
  const posted = { id: 55, body: ops1[1].body };
  const labels2 = [B, ...d1.add];
  const d2 = decisionFor(labels2, previousClassFrom(labels2, posted.body));
  assert.deepEqual(planOps(d2, posted, 7), []);
});

test('planOps: a changed comment is an update of the same comment, never a second one', () => {
  const posted = { id: 55, body: renderComment('old text', 'infra') };
  const d = decisionFor([B, 'risk:infra', 'review:coderabbit', 'review:deep-held'], 'infra');
  const ops = planOps(d, posted, 7);
  assert.deepEqual(ops.map((o) => o.op), ['comment-update']);
  assert.equal(ops[0].id, 55);
  assert.ok(!ops.some((o) => o.op === 'comment-create'));
});

test('planOps: nothing to say and an old comment -> mark it resolved once', () => {
  const d = dec(READY, pr(['scripts/a.mjs']), ['risk:normal', 'review:coderabbit', B], 'normal');
  assert.equal(d.comment, null);
  const old = { id: 9, body: renderComment('Builder label is missing.', 'normal') };
  const ops = planOps(d, old, 7);
  assert.deepEqual(ops.map((o) => o.op), ['comment-update']);
  assert.match(ops[0].body, /No open router notes/);
  assert.deepEqual(planOps(d, { id: 9, body: ops[0].body }, 7), []);
  assert.deepEqual(planOps(d, null, 7), []);
});

test('planOps: a noop decision (draft, not_routed) plans nothing even with notes', () => {
  assert.deepEqual(planOps(dec(READY, pr(['.github/x.yml'], { draft: true }), [], null), null, 7), []);
  assert.deepEqual(planOps(dec('synchronize', pr(['.github/x.yml']), [], null), null, 7), []);
});

test('applyOps: a dry run never calls gh; a real run sends labels in one call and the comment once', () => {
  const calls = [];
  const gh = (args) => { calls.push(args); return { id: 1 }; };
  const ops = planOps(decisionFor([B], null), null, 7);
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
  const line = ledgerLine({ d, pr: pr(['.github/x.yml']), event: READY, ops: planOps(d, null, 7), now: NOW });
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

function runCli(fixture, extra = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'router-'));
  const file = path.join(dir, 'fixture.json');
  writeFileSync(file, JSON.stringify(fixture));
  const out = execFileSync(process.execPath, [path.join(HERE, 'review-router.mjs'), '7', '--dry-run', '--fixture', file, ...extra],
    { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  return out;
}

const FIX = (over = {}) => ({
  pull: { number: 7, state: 'open', draft: false, changed_files: 2, head: { sha: HEAD }, labels: [{ name: B }], ...over },
  files: [{ filename: '.github/workflows/x.yml' }, { filename: 'scripts/github/y.mjs' }],
  comments: [],
});

test('CLI dry run on a fixture prints one ledger JSON line and the planned writes, and exits 0', () => {
  const out = runCli(FIX(), ['--event', READY]);
  const jsonLines = out.split('\n').filter((l) => l.startsWith('{'));
  assert.equal(jsonLines.length, 1);
  const j = JSON.parse(jsonLines[0]);
  assert.equal(j.class, 'infra');
  assert.deepEqual(j.labels_added, ['risk:infra', 'review:coderabbit', 'review:deep-held']);
  assert.match(out, /DRY RUN/);
});

test('CLI: a draft fixture adds nothing; --assume-ready shows what would happen', () => {
  const draft = runCli(FIX({ draft: true }), ['--event', READY]);
  assert.deepEqual(JSON.parse(draft.split('\n').find((l) => l.startsWith('{'))).labels_added, []);
  const sim = runCli(FIX({ draft: true }), ['--event', READY, '--assume-ready']);
  const j = JSON.parse(sim.split('\n').find((l) => l.startsWith('{')));
  assert.deepEqual(j.labels_added, ['risk:infra', 'review:coderabbit', 'review:deep-held']);
  assert.equal(j.assumed_ready, true);
});

test('CLI: a truncated file list exits 2 and writes no ledger line', () => {
  const fx = FIX({ changed_files: 3000 });
  assert.throws(() => runCli(fx, ['--event', READY]), (e) => e.status === 2);
});
