// Drift guard: the ccv3-mods pr-loop mod is TypeScript and cannot import review-status.mjs, so it holds two
// strings by value. This test fails when they differ from review-status.mjs. Run: node --test scripts/github/pr-loop-sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROOF_REASON_PREFIX } from './review-status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = readFileSync(path.join(HERE, '..', '..', '.claude', 'plugins', 'ccv3-mods', 'hooks', 'pr-loop', 'model.ts'), 'utf8');
const STATUS = readFileSync(path.join(HERE, 'review-status.mjs'), 'utf8');

test('the mod holds the same PROOF_REASON_PREFIX as review-status.mjs', () => {
  const m = /export const PROOF_REASON_PREFIX = '([^']+)'/.exec(MODEL);
  assert.ok(m, 'model.ts no longer declares PROOF_REASON_PREFIX');
  assert.equal(m[1], PROOF_REASON_PREFIX);
});

test('the mod reads the rate-limit reason review-status.mjs writes', () => {
  const written = /reasons\.push\('(CodeRabbit rate limited:)/.exec(STATUS);
  assert.ok(written, 'review-status.mjs no longer writes a "CodeRabbit rate limited:" reason');
  const read = /const CODERABBIT_RATE_LIMITED = \/\^([^/]+)\//.exec(MODEL);
  assert.ok(read, 'model.ts no longer declares CODERABBIT_RATE_LIMITED');
  assert.equal(read[1], written[1]);
});

test('the mod reads the outside-diff reason review-status.mjs writes', () => {
  const written = /reasons\.push\(`(CodeRabbit lists) \$\{outsideDiff\} (outside-diff finding\(s\))/.exec(STATUS);
  assert.ok(written, 'review-status.mjs no longer writes a "CodeRabbit lists N outside-diff finding(s)" reason');
  const read = /const OUTSIDE_DIFF_REASON = \/\^([^/]+)\//.exec(MODEL);
  assert.ok(read, 'model.ts no longer declares OUTSIDE_DIFF_REASON');
  assert.ok(new RegExp(`^${read[1]}`).test(`${written[1]} 3 ${written[2]} on head abc1234`), `model regex ${read[1]} does not match the written reason`);
});

// PR C: the mod holds more of review-status.mjs's texts by value. Each one is pinned against the real export, and the mod
// must declare it (a regex on model.ts, as above), so a rewording on either side fails here.
const modelHolds = (name) => {
  const m = new RegExp(`(?:export )?const ${name} = '([^']+)'`).exec(MODEL);
  assert.ok(m, `model.ts must declare ${name} (a quoted string, kept equal to review-status.mjs)`);
  return m[1];
};

test('the mod holds the same DRAFT_REASON as review-status.mjs, and review-status.mjs writes that text for a draft', async () => {
  const RS = await import('./review-status.mjs');
  assert.equal(RS.DRAFT_REASON, 'PR is a draft (no bot review on drafts)', 'review-status.mjs must export DRAFT_REASON');
  assert.equal(modelHolds('DRAFT_REASON'), RS.DRAFT_REASON);
});

test('the mod text never tells a person to run /checkpoint, a built-in of Claude Code (it is /pathway)', () => {
  assert.ok(!MODEL.includes('/checkpoint'), 'model.ts names /checkpoint');
  assert.match(modelHolds('NONE_NO_CHECKPOINT_NOTE'), /call pr_checkpoint \{pr\} /);
  assert.match(modelHolds('CLASS_RAISED_NOTE'), /Call pr_checkpoint \{pr\}: it asks Dave whether to return the PR to draft and pick again/);
});

test('the mod holds the same ROUTER_NONE_UNVERIFIED_NOTE, NONE_NO_CHECKPOINT_NOTE and CLASS_RAISED_NOTE as review-status.mjs', async () => {
  const RS = await import('./review-status.mjs');
  for (const name of ['ROUTER_NONE_UNVERIFIED_NOTE', 'NONE_NO_CHECKPOINT_NOTE', 'CLASS_RAISED_NOTE']) {
    assert.equal(typeof RS[name], 'string', `review-status.mjs must export ${name}`);
    assert.equal(modelHolds(name), RS[name], `model.ts ${name} differs from review-status.mjs`);
  }
});

// PR D (Dave 2026-10-29): the opening ask waits 30 minutes. The wait is a constant and the ask text names it; one without the other
// tells Dave a time that the mod does not wait.
test('the mod waits OPENING_WAIT_MS before the opening ask and its ask text names the same number of minutes', () => {
  const wait = /export const OPENING_WAIT_MS = (\d+) \* 60_000/.exec(MODEL);
  assert.ok(wait, 'model.ts no longer declares OPENING_WAIT_MS as <minutes> * 60_000');
  const said = /CodeRabbit has not started on #\$\{status\.pr\} (\d+) minutes after ready/.exec(MODEL);
  assert.ok(said, 'model.ts no longer words the opening ask as "has not started on #N <minutes> minutes after ready"');
  assert.equal(said[1], wait[1], 'the ask text and OPENING_WAIT_MS name different minutes');
  assert.equal(Number(wait[1]), 30);
});

// PR D review C9: where only the CLI fix line blocks the carry, review-status.mjs says to run cr-fix.mjs and post no review. The mod tells
// the model the same only while it recognises that reason, so its prefix must be the start of the real reason.
test('the mod CARRY_REASON_PREFIX is the start of the reason review-status.mjs writes when only the CLI fix line blocks the carry', async () => {
  const RS = await import('./review-status.mjs');
  assert.equal(typeof RS.noReviewCliReason, 'function', 'review-status.mjs must export noReviewCliReason');
  const prefix = modelHolds('CARRY_REASON_PREFIX');
  assert.ok(RS.noReviewCliReason(221).startsWith(prefix), `the reason "${RS.noReviewCliReason(221)}" does not start with "${prefix}"`);
  assert.match(RS.noReviewCliReason(221), /cr-fix\.mjs --pr 221/, 'the reason no longer names cr-fix.mjs');
});

// Lane ready-no-check-runs (the seat 2026-11-11): review-status.mjs writes required-checks and base-branch lines. They change as CI
// runs, so the mod's CI_REASON keeps them out of the LIMITED/STALLED alert key, like the check, status and mergeable_state lines.
const ciReason = () => {
  const m = /^const CI_REASON = \/(.*)\/\s*$/m.exec(MODEL);
  assert.ok(m, 'model.ts no longer declares CI_REASON as a one-line regex literal');
  return new RegExp(m[1]);
};
const SHA = '9bd87cd599565431e5c6864266a0cad413b83977';
const syncPull = (base = 'main') => ({ number: 7, state: 'open', merged: false, mergeable_state: 'clean', body: '', labels: [], head: { sha: SHA, ref: 'fix/x' }, base: { ref: base } });
/** review-status.mjs's reasons for a head with no check runs, committed at 22:23:51Z and read at `now`. */
const syncReasons = async (now, base = 'main', checkRuns = []) => {
  const RS = await import('./review-status.mjs');
  return RS.evaluate({ pull: syncPull(base), combined: { statuses: [] }, checkRuns, threads: [], bodyEdits: [], reviews: [], comments: [], headCommittedAt: '2026-11-11T22:23:51Z', nowMs: Date.parse(now) }).reasons;
};
const REQUIRED_LINE = /^required checks |^base branch "/;

test('CI_REASON matches every required-checks and base-branch line review-status.mjs writes, and the older CI lines', async () => {
  const ci = ciReason();
  const skipped = [{ id: 1, name: 'trivy', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'skipped', started_at: '2026-11-11T22:24:00Z' }];
  const written = [
    ...(await syncReasons('2026-11-11T22:25:51Z')),
    ...(await syncReasons('2026-11-11T23:25:51Z')),
    ...(await syncReasons('2026-11-11T22:25:51Z', 'feat/stack')),
    ...(await syncReasons('2026-11-11T22:25:51Z', 'main', skipped)),
  ].filter((x) => REQUIRED_LINE.test(x));
  const kinds = new Set(written.map((x) => /^(required checks (not started|missing|ended skipped or neutral)|base branch)/.exec(x)?.[1]));
  assert.equal(kinds.size, 4, `the 4 kinds of line were written: ${written.join(' | ')}`);
  for (const line of written) assert.ok(ci.test(line), `CI_REASON does not match "${line}"`);
  assert.ok(ci.test('required checks not started on head 9bd87cd (push time unknown): ratchets. Wait for them'));
  assert.ok(ci.test('check "hooks" is in_progress/null'));
  assert.ok(ci.test('status "x" is pending'));
  assert.ok(ci.test('mergeable_state is "blocked"'));
});

test('CI_REASON does not match a review reason (the alert key keeps those)', async () => {
  const RS = await import('./review-status.mjs');
  const ci = ciReason();
  for (const reason of [RS.DRAFT_REASON, 'CodeRabbit rate limited: head not reviewed', RS.noReviewCliReason(7), RS.NO_REVIEW_UNVERIFIED_REASON]) {
    assert.equal(ci.test(reason), false, `CI_REASON matches the review reason "${reason}"`);
  }
});

test('the required-checks line of one state is byte-identical at two reads (no minute count in the alert text)', async () => {
  const lineOf = (reasons) => reasons.filter((x) => x.startsWith('required checks '));
  const notStarted = [await syncReasons('2026-11-11T22:24:51Z'), await syncReasons('2026-11-11T22:31:51Z')];
  assert.equal(lineOf(notStarted[0]).length, 1, notStarted[0].join(' | '));
  assert.deepEqual(lineOf(notStarted[1]), lineOf(notStarted[0]));
  assert.deepEqual(notStarted[1], notStarted[0], 'every reason, not only the required-checks line');
  const missing = [await syncReasons('2026-11-11T22:43:51Z'), await syncReasons('2026-11-11T23:53:51Z')];
  assert.deepEqual(missing[1], missing[0]);
  assert.notDeepEqual(lineOf(missing[0]), lineOf(notStarted[0]), '"not started" and "missing" read differently');
});
