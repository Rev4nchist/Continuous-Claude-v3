// Tests for cr-paid.mjs. Run: node --test scripts/github/cr-paid.test.mjs
// No network: gh is an injected fake. The ledger is a real file in a temp directory.
//
// How cr-paid.mjs can fail, and the test that catches it (written before the code):
//   a cap lets a round through at the wrong edge (cost $5, day $15, 2 paid rounds, 30 fix lines)  -> CP1 to CP5
//   a fix round that adds a file is allowed                                                       -> CP6
//   round 1 counts a file that path_filters excludes (the live fixtures filter)                  -> CP7, CP8
//   the day ends at UTC midnight and not at Chicago midnight                                      -> CP9
//   a read error or a bad ledger line gives a verdict instead of exit 2                           -> CP10, CP11
//   the head already has a review and a $0 round is allowed                                       -> CP12
//   record writes a line that cannot be read back, or the check cannot read it                    -> CP13, CP14
//   ALLOW prints a comment other than the exact paid one                                          -> CP1
//   the round label is 2 for a third round (it must count the prior reviewed rounds + 1)          -> CP15, CP16
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as PAID from './cr-paid.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NOW = new Date('2026-10-30T15:00:00Z');
const CR_BOT = { login: 'coderabbitai[bot]', type: 'Bot' };
const review = (id, commit_id, submitted_at) => ({ id, user: CR_BOT, commit_id, submitted_at, body: 'Actionable comments posted: 1' });
const prFile = (n, over = {}) => ({ filename: `src/f${n}.ts`, additions: 5, deletions: 0, status: 'modified', ...over });
const files = (count) => Array.from({ length: count }, (_, i) => prFile(i));
const gqlNode = (c) => ({ databaseId: c.id, body: c.body, author: { login: 'coderabbitai', __typename: 'Bot' }, lastEditedAt: null, updatedAt: c.updated_at, userContentEdits: { nodes: [] } });

/** A temp ledger file plus a fake gh. `rows` (objects) or `raw` (text) seed the ledger. */
function harness({ reviews = [], comments = [], prFiles = files(4), compareFiles = [], rows = [], raw = null, filters = [], ghError = null, now = NOW, env = {}, commits = [] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cr-paid-'));
  const ledgerPath = path.join(dir, 'state', 'coderabbit-paid.jsonl');
  if (raw !== null || rows.length > 0) {
    const text = raw ?? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
    mkdirSync(path.dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, text);
  }
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (ghError) throw new Error(ghError);
    if (args.includes('graphql')) return { data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false }, nodes: comments.map(gqlNode) } } } } };
    if (args.some((a) => /issues\/\d+\/comments/.test(a))) return comments;
    if (args.some((a) => /compare\//.test(a))) return { files: compareFiles };
    if (args.some((a) => /pulls\/\d+\/files/.test(a))) return [prFiles];
    if (args.some((a) => /pulls\/\d+\/commits/.test(a))) return [commits.map((sha) => ({ sha }))];
    if (args.some((a) => /pulls\/\d+\/reviews/.test(a))) return [reviews];
    return { head: { sha: HEAD } };
  };
  const deps = { gh, now: () => now, ledgerPath, pathFilters: () => filters, env };
  return { dir, calls, deps, ledgerPath, check: (over = {}) => PAID.checkPr({ pr: 225, repo: 'Rev4nchist/Continuous-Claude-v3', ...over }, deps), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const row = (pr, cost, date = '2026-10-30') => ({ ts: `${date}T10:00:00.000Z`, date, pr, head: HEAD, files: cost * 4, cost, session: 's' });
const round2 = (over = {}) => harness({ reviews: [review(1, OLD, '2026-10-30T08:00:00Z')], compareFiles: [prFile(0, { additions: 10, deletions: 5 })], ...over });

test('CP1: ALLOW at exactly $5.00 (20 files) and prints the exact paid comment', async () => {
  const h = harness({ prFiles: files(20) });
  const r = await h.check();
  assert.equal(r.exitCode, 0);
  assert.equal(r.verdict, 'ALLOW');
  assert.equal(r.cost, 5);
  assert.equal(r.comment, '@coderabbitai review --use-credits');
  assert.ok(PAID.reportOf(r).out.includes('@coderabbitai review --use-credits'));
  h.done();
});

test('CP2: ESCALATE at $5.25 (21 files) with one reason line naming the round cost', async () => {
  const h = harness({ prFiles: files(21) });
  const r = await h.check();
  assert.equal(r.exitCode, 3);
  assert.equal(r.verdict, 'ESCALATE');
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /round cost \$5\.25 is over \$5\.00/);
  assert.equal(r.comment, null);
  h.done();
});

test('CP3: the day cap: $10.00 today + $5.00 allows, $10.25 today + $5.00 escalates', async () => {
  const ok = harness({ prFiles: files(20), rows: [row(1, 10)] });
  assert.equal((await ok.check()).exitCode, 0);
  const over = harness({ prFiles: files(20), rows: [row(1, 10.25)] });
  const r = await over.check();
  assert.equal(r.exitCode, 3);
  assert.match(r.reasons.join('\n'), /today \$10\.25 \+ round \$5\.00 is over \$15\.00/);
  ok.done(); over.done();
});

test('CP4: two paid rounds on this PR escalate (a third); another PR\'s rows do not count', async () => {
  const two = harness({ rows: [row(225, 1), row(225, 1)] });
  const r = await two.check();
  assert.equal(r.exitCode, 3);
  assert.equal(r.paidRounds, 2);
  assert.match(r.reasons.join('\n'), /2 paid rounds on this PR/);
  const other = harness({ rows: [row(1, 1), row(2, 1), row(225, 1)] });
  const o = await other.check();
  assert.equal(o.exitCode, 0);
  assert.equal(o.paidRounds, 1);
  two.done(); other.done();
});

test('CP5: round 2 fix of 30 lines allows, 31 lines escalates', async () => {
  const at = round2({ compareFiles: [prFile(0, { additions: 20, deletions: 10 })] });
  const ra = await at.check();
  assert.equal(ra.exitCode, 0);
  assert.equal(ra.round, 2);
  assert.equal(ra.fix.lines, 30);
  const over = round2({ compareFiles: [prFile(0, { additions: 20, deletions: 11 })] });
  const ro = await over.check();
  assert.equal(ro.exitCode, 3);
  assert.match(ro.reasons.join('\n'), /fix is 31 lines, over 30/);
  assert.ok(over.calls.some((a) => a.some((x) => new RegExp(`compare/${OLD}\\.\\.\\.${HEAD}`).test(x))), 'compares the last reviewed commit to the head');
  at.done(); over.done();
});

test('CP6: round 2 fix that adds a file escalates, even when small', async () => {
  const h = round2({ prFiles: [prFile(0), prFile(9)], compareFiles: [prFile(0), prFile(9, { status: 'added', additions: 1 })] });
  const r = await h.check();
  assert.equal(r.exitCode, 3);
  assert.equal(r.fix.added, 1);
  assert.match(r.reasons.join('\n'), /adds 1 file/);
  h.done();
});

test('CP7: round 1 bills every PR file after path_filters: a filtered fixture is not counted', async () => {
  const fixture = prFile(7, { filename: 'scripts/github/fixtures/x.json' });
  const h = harness({ prFiles: [...files(3), fixture], filters: ['!scripts/github/fixtures/**'] });
  const r = await h.check();
  assert.equal(r.round, 1);
  assert.equal(r.files, 3);
  assert.equal(r.total, 4, 'the unfiltered count is shown too, since billing exclusion is unproven');
  assert.equal(r.cost, 0.75);
  assert.ok(!h.calls.some((a) => a.some((x) => /compare\//.test(x))), 'round 1 reads no compare');
  h.done();
});

test('CP8: the live .coderabbit.yaml filters scripts/github/fixtures/** (test data needs no review)', () => {
  const live = PAID.liveFilters();
  assert.ok(live.includes('!scripts/github/fixtures/**'), `live filters: ${live.join(', ')}`);
  assert.equal(PAID.billable([{ filename: 'scripts/github/fixtures/a.json' }, { filename: 'scripts/github/cr-paid.mjs' }], live).length, 1);
});

test('CP9: the ledger day is the America/Chicago day: 2026-10-31T04:30Z is still 2026-10-30', async () => {
  assert.equal(PAID.chicagoDay(new Date('2026-10-31T04:30:00Z')), '2026-10-30');
  assert.equal(PAID.chicagoDay(new Date('2026-10-31T05:30:00Z')), '2026-10-31');
  const late = harness({ prFiles: files(20), rows: [row(1, 10.25, '2026-10-30')], now: new Date('2026-10-31T04:30:00Z') });
  assert.equal((await late.check()).exitCode, 3, 'a row of 2026-10-30 still counts at 04:30Z on the 31st');
  const next = harness({ prFiles: files(20), rows: [row(1, 10.25, '2026-10-30')], now: new Date('2026-10-31T05:30:00Z') });
  assert.equal((await next.check()).exitCode, 0, 'the next Chicago day starts at 05:00Z in CDT');
  late.done(); next.done();
});

test('CP10: a gh read error is exit 2 with no verdict', async () => {
  const h = harness({ ghError: 'HTTP 502' });
  const r = await h.check();
  assert.equal(r.exitCode, 2);
  assert.equal(r.verdict, null);
  assert.match(r.reason, /HTTP 502/);
  h.done();
});

test('CP11: a malformed ledger line is exit 2 with no verdict; a missing ledger is empty', async () => {
  const bad = harness({ raw: `${JSON.stringify(row(1, 1))}\n{not json\n` });
  const r = await bad.check();
  assert.equal(r.exitCode, 2);
  assert.equal(r.verdict, null);
  assert.match(r.reason, /ledger line 2/);
  const noCost = harness({ raw: `${JSON.stringify({ pr: 1, date: '2026-10-30' })}\n` });
  assert.equal((await noCost.check()).exitCode, 2, 'a line without a cost is bad');
  const none = harness();
  assert.ok(!existsSync(none.ledgerPath));
  assert.equal((await none.check()).exitCode, 0);
  bad.done(); noCost.done(); none.done();
});

test('CP12: the head already has a CodeRabbit review: exit 2, no $0 ALLOW', async () => {
  const h = harness({ reviews: [review(1, HEAD, '2026-10-30T08:00:00Z')] });
  const r = await h.check();
  assert.equal(r.exitCode, 2);
  assert.match(r.reason, /already reviewed the head/);
  h.done();
});

test('CP13: record appends one parseable line with ts, Chicago date, pr, head, files, cost, session', () => {
  const h = harness({ env: { CLAUDE_SESSION_ID: 'sess-1' }, now: new Date('2026-10-31T04:30:00Z') });
  PAID.recordPaid({ pr: 225, head: HEAD, files: 6 }, h.deps);
  PAID.recordPaid({ pr: 225, head: HEAD, files: 2 }, { ...h.deps, env: {} });
  const lines = readFileSync(h.ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { ts: '2026-10-31T04:30:00.000Z', date: '2026-10-30', pr: 225, head: HEAD, files: 6, cost: 1.5, session: 'sess-1' });
  assert.equal(lines[1].session, 'unknown');
  assert.throws(() => PAID.recordPaid({ pr: 225, head: 'nothex', files: 1 }, h.deps), /head/);
  assert.throws(() => PAID.recordPaid({ pr: 225, head: HEAD, files: -1 }, h.deps), /files/);
  h.done();
});

// Live ledger rows said "unknown": Claude Code sets CLAUDE_CODE_SESSION_ID (lane.mjs reads it), not CLAUDE_SESSION_ID.
test('CP13b: record writes the Claude Code session id from CLAUDE_CODE_SESSION_ID; it wins over CLAUDE_SESSION_ID', () => {
  const h = harness({ env: { CLAUDE_CODE_SESSION_ID: 'real-sess' } });
  assert.equal(PAID.recordPaid({ pr: 225, head: HEAD, files: 1 }, h.deps).session, 'real-sess');
  assert.equal(PAID.recordPaid({ pr: 225, head: HEAD, files: 1 }, { ...h.deps, env: { CLAUDE_CODE_SESSION_ID: 'a', CLAUDE_SESSION_ID: 'b' } }).session, 'a');
  assert.equal(PAID.recordPaid({ pr: 225, head: HEAD, files: 1 }, { ...h.deps, env: { CLAUDE_CODE_SESSION_ID: '' } }).session, 'unknown');
  h.done();
});

test('CP14: a recorded round counts in the next check and in today', async () => {
  const h = harness({ prFiles: files(20) });
  PAID.recordPaid({ pr: 225, head: HEAD, files: 20 }, h.deps);
  PAID.recordPaid({ pr: 225, head: HEAD, files: 20 }, h.deps);
  const r = await h.check();
  assert.equal(r.paidRounds, 2);
  assert.equal(r.today, 10);
  const t = PAID.todayOf(h.deps);
  assert.equal(t.total, 10);
  assert.equal(t.rows.length, 2);
  h.done();
});

test('CP15: parseArgs reads the subcommands and refuses a bad number or an unknown flag', () => {
  assert.deepEqual(PAID.parseArgs(['check', '--pr', '225', '--json']), { cmd: 'check', pr: 225, json: true, head: null, files: null, repo: 'Rev4nchist/Continuous-Claude-v3' });
  assert.equal(PAID.parseArgs(['record', '--pr', '9', '--head', HEAD, '--files', '3']).files, 3);
  assert.throws(() => PAID.parseArgs(['check']), /--pr/);
  assert.throws(() => PAID.parseArgs(['check', '--pr', 'x']), /--pr/);
  assert.throws(() => PAID.parseArgs(['check', '--pr', '1', '--frob']), /unknown/);
  assert.throws(() => PAID.parseArgs(['pay']), /usage/);
});

// PR #225 round 3: the label said "round 2" after two CodeRabbit rounds. Round = distinct reviewed rounds + 1 (newestCodeRabbitRound's view).
const OLDER = 'd'.repeat(40);
const BASE = 'c'.repeat(40);
const cleanSummary = (covered, at) => ({
  id: 800, user: CR_BOT, created_at: at, updated_at: at,
  body: `<!-- coderabbit-ai-generated:v1 -->

<!-- This is an auto-generated comment: summarize by coderabbit.ai -->

No actionable comments were generated in the recent review.

`
    + `Reviewing files that changed from the base of the PR and between ${BASE} and ${covered}.

`
    + `<!-- final_review_risk_coverage:{"sourceCommitId":"${covered}","coveredCommitId":"${covered}","kind":"reviewed"} -->
`,
});

test('CP15: two review objects on two commits label the next round 3, and the fix limits still apply', async () => {
  const h = harness({ reviews: [review(1, OLDER, '2026-10-30T07:00:00Z'), review(2, OLD, '2026-10-30T08:00:00Z')], compareFiles: [prFile(0, { additions: 10, deletions: 5 })] });
  const r = await h.check();
  assert.equal(r.round, 3);
  assert.equal(r.from, OLD);
  assert.equal(r.fix.lines, 15);
  assert.match(PAID.reportOf(r).out[0], /round 3,/);
  h.done();
});

test('CP16: a review object plus a newer summary-only clean round label the next round 3; an empty-body thread reply counts none', async () => {
  const reply = { ...review(3, OLDER, '2026-10-30T07:30:00Z'), body: '' };
  const h = harness({
    reviews: [review(1, OLDER, '2026-10-30T07:00:00Z'), reply],
    comments: [cleanSummary(OLD, '2026-10-30T08:00:00Z')],
    compareFiles: [prFile(0)],
  });
  const r = await h.check();
  assert.equal(r.round, 3);
  assert.equal(r.from, OLD);
  h.done();
});

test('CP17: a summary-only clean round on A, then a review object on B, label the next round 3 (the older summary round counts)', async () => {
  const h = harness({
    reviews: [review(1, OLD, '2026-10-30T08:00:00Z')],
    comments: [cleanSummary(OLDER, '2026-10-30T07:00:00Z')],
    compareFiles: [prFile(0)],
  });
  const r = await h.check();
  assert.equal(r.round, 3);
  assert.equal(r.from, OLD);
  h.done();
});

test('CP18: a summary that covers a commit a review object already holds counts no extra round', async () => {
  const h = harness({
    reviews: [review(1, OLD, '2026-10-30T08:00:00Z')],
    comments: [cleanSummary(OLD, '2026-10-30T07:00:00Z')],
    compareFiles: [prFile(0)],
  });
  assert.equal((await h.check()).round, 2);
  h.done();
});

// Lane review-status-bugs, bug 2: the round to estimate from is the newest REVIEWED commit (PR commit list), not the last-edited summary.
test('CP16: an older clean summary edited after a newer review object does not move the estimate off the newer commit', async () => {
  const h = harness({
    reviews: [review(1, OLD, '2026-10-30T07:00:00Z')],
    comments: [cleanSummary(OLDER, '2026-10-30T09:00:00Z')],
    commits: [OLDER, OLD, HEAD],
    compareFiles: [prFile(0, { additions: 10, deletions: 5 })],
  });
  const r = await h.check();
  assert.equal(r.from, OLD);
  h.done();
});

// ---- CLI spend ledger rows and the daily CLI cap (Dave, 2026-11-02) ----
// How the CLI spend log can fail, and the test that catches it:
//   a cli row (no pr) makes the ledger unreadable, so `check` exits 2 and `today` crashes   -> CP19
//   an old row with no kind stops reading as a PR row, or a PR row without a pr is accepted  -> CP19
//   a CLI row eats the PR $15 day cap, or a PR row eats the CLI cap                          -> CP20
//   recordCliSpend writes the wrong shape, a free run (cost 0) writes a row                  -> CP21
//   the cap sums another Chicago day, or compares with > and not >=                           -> CP22
//   a bad cap value or a bad ledger line gives "under cap"                                    -> CP23
//   `today` prints "PR #undefined" for a cli row                                              -> CP24
const cliRow = (cost, date = '2026-10-30', branch = 'feat/x') => ({ ts: `${date}T10:00:00.000Z`, date, kind: 'cli', branch, head: HEAD, files: cost * 4, cost, session: 's' });

test('CP19: a ledger of old PR rows (no kind) and cli rows reads; an unknown kind or a PR row with no pr is refused', () => {
  const h = harness({ rows: [row(225, 1), cliRow(0.5), { ...row(226, 0.25), kind: 'pr' }] });
  assert.equal(PAID.readLedger(h.ledgerPath).length, 3);
  assert.equal(PAID.todayOf(h.deps).rows.length, 2, 'today lists the two PR rows');
  h.done();
  for (const bad of [{ ...cliRow(1), kind: 'other' }, { ...row(1, 1), pr: undefined }, { ...cliRow(1), branch: undefined }]) {
    const g = harness({ rows: [bad] });
    assert.throws(() => PAID.readLedger(g.ledgerPath), /ledger line 1/);
    g.done();
  }
});

test('CP20: CLI spend does not count in the PR day cap, and PR spend does not count in the CLI cap', async () => {
  const h = harness({ prFiles: files(20), rows: [row(1, 10), cliRow(2.5)] });
  assert.equal((await h.check()).verdict, 'ALLOW', 'PR today $10 + round $5 = $15, with $2.50 of CLI spend not added');
  assert.equal(PAID.cliTodayOf(h.deps).total, 2.5);
  h.done();
});

test('CP21: recordCliSpend writes one cli row that reads back; a zero or bad cost writes nothing', () => {
  const h = harness();
  const usageCost = { files: 4, costCents: 100 };
  const r = PAID.recordCliSpend({ branch: 'fix/a', head: HEAD, usageCost }, { ...h.deps, env: { CLAUDE_CODE_SESSION_ID: 'sess-1' } });
  assert.deepEqual(r, { ts: NOW.toISOString(), date: '2026-10-30', kind: 'cli', branch: 'fix/a', head: HEAD, files: 4, cost: 1, session: 'sess-1' });
  assert.deepEqual(PAID.readLedger(h.ledgerPath), [r]);
  for (const bad of [null, { files: 4, costCents: 0 }, { files: 4, costCents: -5 }]) {
    assert.equal(PAID.recordCliSpend({ branch: 'fix/a', head: HEAD, usageCost: bad }, h.deps), null);
  }
  assert.equal(PAID.readLedger(h.ledgerPath).length, 1);
  h.done();
});

test('CP22: the CLI cap counts only today (Chicago) cli rows and blocks at the cap, not above it', () => {
  // 2026-10-30T15:00Z is 10:00 in Chicago. A row of 2026-10-29 and a PR row do not count.
  const h = harness({ rows: [cliRow(1.5), cliRow(1.25), cliRow(9, '2026-10-29'), row(225, 5)] });
  const under = PAID.cliCapCheck(3, h.deps);
  assert.equal(under.capped, false);
  assert.equal(under.total, 2.75);
  assert.equal(PAID.cliCapCheck(2.75, h.deps).capped, true, 'total equal to the cap is capped');
  assert.equal(PAID.cliCapCheck(2.76, h.deps).capped, false);
  const text = PAID.cliCapLine(PAID.cliCapCheck(2.5, h.deps));
  assert.match(text, /\$2\.75/);
  assert.match(text, /\$2\.50/);
  h.done();
  // 2026-10-31T03:00Z is still 2026-10-30 in Chicago (22:00 CDT): the row of that day counts.
  const late = harness({ rows: [cliRow(3)], now: new Date('2026-10-31T03:00:00Z') });
  assert.equal(PAID.cliCapCheck(3, late.deps).capped, true);
  late.done();
});

test('CP23: cliCapOf reads the config key; a missing, negative or non-number value means no cap; a bad ledger throws', () => {
  assert.equal(PAID.cliCapOf({ coderabbit: { cli_daily_cap_usd: 3 } }), 3);
  assert.equal(PAID.cliCapOf({ coderabbit: { cli_daily_cap_usd: 0 } }), 0);
  for (const cfg of [{}, { coderabbit: {} }, { coderabbit: { cli_daily_cap_usd: '3' } }, { coderabbit: { cli_daily_cap_usd: -1 } }, { coderabbit: { cli_daily_cap_usd: null } }, null]) {
    assert.equal(PAID.cliCapOf(cfg), null, JSON.stringify(cfg));
  }
  const h = harness({ raw: 'not json\n' });
  assert.throws(() => PAID.cliCapCheck(3, h.deps), /ledger line 1/);
  h.done();
});

test('CP24: `today` lists a cli row as CLI with its branch, not as PR #undefined', () => {
  const h = harness({ rows: [row(225, 1), cliRow(0.5, '2026-10-30', 'feat/x')] });
  const lines = PAID.todayLines(PAID.todayOf(h.deps), PAID.cliTodayOf(h.deps));
  const text = lines.join('\n');
  assert.doesNotMatch(text, /undefined/);
  assert.match(text, /CLI feat\/x/);
  assert.match(text, /PR #225/);
  h.done();
});

// ---------- the month counter (interim CodeRabbit rule, Dave 2026-11-04) ----------
// How it can fail: a CLI row counts; a row of another month counts; October counts in November (a prefix slip, "2026-1" matches "2026-10");
// a bad ledger gives a count instead of throwing; `month` asks for --pr like `check`; the day roll uses UTC and not Chicago.

const filesRow = (pr, files, date) => ({ ts: `${date}T10:00:00.000Z`, date, pr, head: HEAD, files, cost: files * 0.25, session: 's' });

test('CP25: monthToDateFiles sums the files of PR rows of that month only: no cli rows, no other month, no prefix slip', () => {
  const rows = [
    filesRow(1, 10, '2026-11-01'), filesRow(2, 5, '2026-11-04'),
    { ...cliRow(2, '2026-11-02'), files: 40 },
    filesRow(3, 100, '2026-10-31'), filesRow(4, 100, '2025-11-04'),
    { ts: '2026-11-03T10:00:00.000Z', date: '2026-11-03', kind: 'pr', pr: 5, head: HEAD, files: 7, cost: 1.75, session: 's' },
  ];
  assert.equal(PAID.monthToDateFiles(rows, '2026-11'), 22);
  assert.equal(PAID.monthToDateFiles(rows, '2026-10'), 100);
  assert.equal(PAID.monthToDateFiles(rows, '2026-1'.slice(0, 7)), 0, 'a short prefix is not a month');
  assert.equal(PAID.monthToDateFiles([], '2026-11'), 0);
});

test('CP26: monthOf reads the Chicago month of now (a UTC roll does not move it), and a bad ledger throws', () => {
  const h = harness({ rows: [filesRow(1, 12, '2026-10-31'), filesRow(2, 3, '2026-11-01')], now: new Date('2026-11-01T03:00:00Z') });
  // 2026-11-01T03:00Z is 2026-10-31 22:00 CDT: still October in Chicago.
  assert.deepEqual([PAID.monthOf(h.deps).month, PAID.monthOf(h.deps).files], ['2026-10', 12]);
  h.done();
  const nov = harness({ rows: [filesRow(1, 12, '2026-10-31'), filesRow(2, 3, '2026-11-01')], now: new Date('2026-11-04T15:00:00Z') });
  assert.deepEqual([PAID.monthOf(nov.deps).month, PAID.monthOf(nov.deps).files], ['2026-11', 3]);
  nov.done();
  const bad = harness({ raw: 'not json\n' });
  assert.throws(() => PAID.monthOf(bad.deps), /ledger line 1/);
  bad.done();
  assert.equal(PAID.monthOf(harness().deps).files, 0, 'a missing ledger is an empty month');
});

test('CP27: the `month` subcommand needs no --pr, and its line says the count undercounts free-slot reviews', () => {
  assert.equal(PAID.parseArgs(['month']).cmd, 'month');
  assert.equal(PAID.parseArgs(['month', '--json']).json, true);
  const h = harness({ rows: [filesRow(1, 12, '2026-10-30')] });
  const text = PAID.monthLines(PAID.monthOf(h.deps)).join('\n');
  assert.match(text, /2026-10/);
  assert.match(text, /12 file/);
  assert.match(text, /paid rounds only/i);
  assert.match(text, /free/i);
  h.done();
});
