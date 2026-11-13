import { expect, test } from '@playwright/test';

import {
  buildPrFeedView,
  matchLane,
  parseOpenPrs,
  parsePrSpend,
  PR_ROW_CAP,
  type LaneRef,
} from '../src/server/queries/pr-feed-parse';

/**
 * Pure checks of the Open pull requests table (card prflow-pr-row, contract note section 6).
 * Pure Node: no server, no database, no browser (playwright.pure.config.ts runs it, and so does CI).
 * The feed shapes are the real ones: scripts/github/open-prs.mjs (open-prs.json) and scripts/github/pr-spend.mjs
 * (pr-spend.json). Each test names the source change that breaks it.
 */

const NOW = Date.parse('2026-11-13T16:40:00.000Z');
const FRESH = '2026-11-13T16:30:09.035Z'; // 10 minutes before NOW
const REF_CANARY = 'feat/canary-head-ref-91c2';
const SHA_CANARY = 'c'.repeat(40);
const keep = (text: string): string | null => text;

type Row = Record<string, unknown>;

function openRow(pr: number, patch: Row = {}): Row {
  return {
    pr,
    headRef: `feat/lane-${pr}`,
    head: 'a'.repeat(40),
    draft: false,
    labels: ['risk:normal'],
    band: 'LOW',
    ready: false,
    ci: ['mergeable-dirty', 'required-missing'],
    lastTap: null,
    status: 'ok',
    ...patch,
  };
}

function openDoc(rows: unknown[], patch: Row = {}): Row {
  return { schema: 1, exportedAt: FRESH, repo: 'Rev4nchist/Continuous-Claude-v3', listed: rows.length, kept: rows.length, capped: false, deadlineHit: false, rows, ...patch };
}

function spendRow(pr: number, patch: Row = {}): Row {
  return {
    key: `Rev4nchist/Continuous-Claude-v3#${pr}`,
    repo: 'Rev4nchist/Continuous-Claude-v3',
    pr,
    heads: 1,
    coderabbit: { usd: 1.25, rounds: 1, files: 5 },
    engine: { runs: 2, timedOut: 0, tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 } },
    landed: null,
    headless: 'not shown',
    sessionTokens: 'not shown',
    ...patch,
  };
}

const spendDoc = (rows: Row[]): Row => ({ schema: 1, exportedAt: FRESH, rows });

function view(open: unknown, spend: unknown = null, lanes: LaneRef[] = [], nowMs = NOW) {
  return buildPrFeedView(parseOpenPrs(open, keep), parsePrSpend(spend), lanes, nowMs);
}

test.describe('pr-feed-parse', () => {
  test('P2 a feed that is not an object, has no rows array or a wrong schema is absent', () => {
    // Breaks when parseOpenPrs stops checking the type of rows or the schema number.
    for (const bad of [null, 'text', [], { schema: 1, exportedAt: FRESH, rows: 'nope' }, openDoc([], { schema: 2 })]) {
      const v = view(bad);
      expect(v.status).toBe('absent');
      expect(v.rows).toEqual([]);
    }
  });

  test('P2b a bad row is skipped and counted; a good row beside it shows', () => {
    // Breaks when a row with a non-integer pr reaches the view.
    const v = view(openDoc([openRow(12), openRow(-1), openRow(Number.NaN), { pr: '13' }, 'x']));
    expect(v.rows.map((r) => r.pr)).toEqual([12]);
    expect(v.skipped).toBe(4);
  });

  test('P3 a feed older than 30 minutes is stale and carries its age; a future or bad time is stale', () => {
    // Breaks when the stale rule uses another limit or trusts a future exportedAt.
    expect(view(openDoc([openRow(1)])).stale).toBe(false);
    const old = view(openDoc([openRow(1)], { exportedAt: '2026-11-11T16:40:00.000Z' }));
    expect(old.stale).toBe(true);
    expect(old.ageMinutes).toBe(2 * 24 * 60);
    expect(view(openDoc([openRow(1)], { exportedAt: '2026-11-13T17:40:00.000Z' })).stale).toBe(true);
    const bad = view(openDoc([openRow(1)], { exportedAt: 'yesterday' }));
    expect(bad.stale).toBe(true);
    expect(bad.ageMinutes).toBeNull();
    expect(view(openDoc([openRow(1)], { exportedAt: '2026-11-13T16:09:00.000Z' })).stale).toBe(true); // 31 minutes
  });

  test('P4 the repo leaf "continuous-claude" in pr-spend joins the full repo name', () => {
    // Breaks when the spend join compares repo names exactly.
    const v = view(openDoc([openRow(7)]), spendDoc([spendRow(7, { repo: 'continuous-claude', key: 'continuous-claude#7' })]));
    expect(v.rows[0].spend).toEqual({ state: 'ok', usd: 1.25, engineRuns: 2 });
  });

  test('P5 another repo is excluded: a whole feed, and one spend row', () => {
    // Breaks when the repo check is dropped from either reader.
    const other = view(openDoc([openRow(1)], { repo: 'someone/else' }));
    expect(other.status).toBe('other-repo');
    expect(other.rows).toEqual([]);
    const v = view(openDoc([openRow(8)]), spendDoc([spendRow(8, { repo: 'someone/else', key: 'someone/else#8' })]));
    expect(v.rows[0].spend).toEqual({ state: 'ok', usd: 0, engineRuns: 0 });
  });

  test('P6 the view holds no head ref, head sha, labels or title', () => {
    // Breaks when a row is spread into the view instead of built from an allowlist.
    const v = view(openDoc([openRow(3, { headRef: REF_CANARY, head: SHA_CANARY, title: 'TITLE-CANARY', labels: ['LABEL-CANARY free text'] })]));
    const text = JSON.stringify(v);
    expect(text).not.toContain(REF_CANARY);
    expect(text).not.toContain(SHA_CANARY);
    expect(text).not.toContain('TITLE-CANARY');
    expect(text).not.toContain('LABEL-CANARY');
    expect(Object.keys(v.rows[0]).sort()).toEqual(
      ['band', 'ci', 'draft', 'landSha', 'lane', 'pr', 'ready', 'reviewPath', 'spend', 'status', 'tap'].sort(),
    );
  });

  test('P7 free text cannot pass through CI codes, band, status or the review label', () => {
    // Breaks when an unknown CI code, band or status is copied as given.
    const v = view(
      openDoc([
        openRow(4, {
          ci: ['check-failure', 'status-pending', 'required-missing', 'Error: token leak here', 'mergeable-' + 'x'.repeat(30), 5],
          band: 'SEVERE',
          status: 'weird status',
          labels: ['review:coderabbit', 'review:Free Text!'],
        }),
      ]),
    );
    const row = v.rows[0];
    expect(row.ci).toEqual(['check-failure', 'other', 'required-missing', 'status-pending']);
    expect(row.band).toBeNull();
    expect(row.status).toBe('other');
    expect(row.reviewPath).toBe('coderabbit');
  });

  test('P7b a long tap label is clipped; the review tap sets the review path', () => {
    // Breaks when the tap label clip is removed or the review step is not read.
    const label = 'No review, land on CI ($0) (Recommended) and more words to pass the clip';
    const v = view(openDoc([openRow(5, { lastTap: { step: 'review', label, at: '2026-11-13T16:00:00.000Z', headMatches: true } })]));
    const tap = v.rows[0].tap;
    expect(tap?.label.length).toBeLessThanOrEqual(40);
    expect(tap?.step).toBe('review');
    expect(v.rows[0].reviewPath).toBe(tap?.label);
    const badTime = view(openDoc([openRow(5, { lastTap: { step: 'land', label: 'Land now', at: 'soon', headMatches: true } })]));
    expect(badTime.rows[0].tap).toBeNull();
  });

  test('P7c a row that is not ok shows READY as unknown, never as not ready', () => {
    // Breaks when a null ready is read as false.
    const v = view(openDoc([openRow(6, { status: 'review-status-timeout', ready: null, ci: [] })]));
    expect(v.rows[0].ready).toBeNull();
    expect(v.rows[0].status).toBe('review-status-timeout');
  });

  test('P8 spend: no pr-spend file is "no data", never $0; an absent ledger inside it is null', () => {
    // Breaks when a missing ledger becomes 0.
    expect(view(openDoc([openRow(9)])).rows[0].spend).toEqual({ state: 'no-data' });
    expect(view(openDoc([openRow(9)]), spendDoc([spendRow(9, { coderabbit: null, engine: null })])).rows[0].spend).toEqual({
      state: 'ok',
      usd: null,
      engineRuns: null,
    });
    // The file exists, the PR has no row: nothing was spent.
    expect(view(openDoc([openRow(9)]), spendDoc([spendRow(10)])).rows[0].spend).toEqual({ state: 'ok', usd: 0, engineRuns: 0 });
  });

  test('P9 lane link: branch first, then the head ref leaf; 0 lanes is none, 2 lanes is many', () => {
    // Breaks when the leaf rule wins over the branch rule, or a second match is dropped.
    const lanes: LaneRef[] = [
      { id: 'prflow-spend-line', branch: null },
      { id: 'x-branch-owner', branch: 'feat/prflow-spend-line' },
      { id: 'dup-a', branch: 'feat/dup' },
      { id: 'dup-b', branch: 'feat/dup' },
      { id: 're-gold-c', branch: null },
    ];
    expect(matchLane('feat/prflow-spend-line', lanes)).toEqual({ kind: 'one', id: 'x-branch-owner' });
    expect(matchLane('re/re-gold-c', lanes)).toEqual({ kind: 'one', id: 're-gold-c' });
    expect(matchLane('feat/dup', lanes)).toEqual({ kind: 'many', count: 2 });
    expect(matchLane('feat/nothing-here', lanes)).toEqual({ kind: 'none' });
    expect(matchLane(null, lanes)).toEqual({ kind: 'none' });
  });

  test('P11 the row cap holds and rows sort by PR number, highest first', () => {
    // Breaks when the cap or the sort is removed.
    const rows = Array.from({ length: PR_ROW_CAP + 5 }, (_, i) => openRow(i + 1));
    const v = view(openDoc(rows));
    expect(v.rows).toHaveLength(PR_ROW_CAP);
    expect(v.rows[0].pr).toBe(PR_ROW_CAP + 5);
    expect(v.capped).toBe(true);
  });

  test('P12 land commit: 7 characters; the last 3 landed PRs show; a bad sha is dropped', () => {
    // Breaks when the full sha is sent or a non-hex sha passes.
    const spend = spendDoc([
      spendRow(20, { landed: { mergeSha: 'abcdef1234567890abcdef1234567890abcdef12', mergeCall: 'ok' } }),
      spendRow(19, { landed: { mergeSha: '1111111222222233333334444444555555566666', mergeCall: 'ok' } }),
      spendRow(18, { landed: { mergeSha: 'not-a-sha', mergeCall: 'ok' } }),
      spendRow(17, { landed: { mergeSha: '9999999888888877777776666666555555544444', mergeCall: 'ok' } }),
      spendRow(16, { landed: { mergeSha: '0000000aaaaaaabbbbbbbcccccccdddddddeeeee', mergeCall: 'ok' } }),
    ]);
    const v = view(openDoc([openRow(20)]), spend);
    expect(v.rows[0].landSha).toBe('abcdef1');
    expect(v.landed).toEqual([
      { pr: 20, sha7: 'abcdef1' },
      { pr: 19, sha7: '1111111' },
      { pr: 17, sha7: '9999999' },
    ]);
    expect(JSON.stringify(v)).not.toContain('abcdef1234567890');
  });
});
