import { expect, test } from '@playwright/test';

import { buildColumns, countsByState, isTruncated, type LaneRow } from '../src/server/queries/lane-board-fold';
import { foldSpendView, type DaySnapshot } from '../src/server/queries/spend-fold';

/**
 * Pure-Node check of the numbers behind lane agentic-os-tiles-truth (report 09-dataflow-review-2026-11-23.md).
 * No server, no database, no browser: playwright.pure.config.ts runs it, and so does CI.
 * The page text of the same items is in tiles-truth.spec.ts (database, scratch harness only).
 *
 * Ways the fold can lie, one test each (the change that breaks it is in the name):
 *   B1  C4: a column count is taken from the rows that survived the query cut (the old `items.length`)
 *   B2  C4: a state the board does not know is dropped from the counts instead of counted as backlog
 *   B3  C4: the cut flag is set by the done column (it shows 10 by design) or is never set for an open column
 *   B4  C4: the board total is the sum of the cut rows
 *   S1  C16: the day total of a mix of live and ended sessions reads as one `est` number
 *   S2  C6: the Spend view hides how many of its sessions are live
 */

const baseRow = (id: string, state: string | null, extra: Partial<LaneRow> = {}): LaneRow =>
  ({
    id,
    title: id,
    branch: null,
    track: null,
    state,
    owner_session_id: null,
    lease_lapsed: null,
    owner_state: null,
    updated_epoch: 0,
    remind_state: null,
    band: null,
    due_epoch: null,
    lease_epoch: null,
    now_epoch: 1_800_000_000,
    reclaimable: null,
    waits_on: [],
    ...extra,
  }) as LaneRow;

test.describe('lane board counts (C4)', () => {
  test('B1 a column count comes from the SQL counts, not from the rows that came back', () => {
    const rows = [baseRow('a', 'backlog'), baseRow('b', 'backlog')];
    const columns = buildColumns(rows, countsByState([{ state: 'backlog', n: 109 }]));
    const backlog = columns.find((c) => c.state === 'backlog');
    expect(backlog?.count).toBe(109);
    expect(backlog?.shown).toBe(2);
  });

  test('B2 an unknown state counts as backlog, a null state too', () => {
    const counts = countsByState([
      { state: 'backlog', n: 5 },
      { state: 'weird', n: 2 },
      { state: null, n: 1 },
      { state: 'done', n: 423 },
    ]);
    expect(counts.get('backlog')).toBe(8);
    expect(counts.get('done')).toBe(423);
    expect(counts.get('ready') ?? 0).toBe(0);
  });

  test('B3 the cut flag: an open column cut is true, a done column cut is false', () => {
    const doneRows = Array.from({ length: 10 }, (_, i) => baseRow(`d${i}`, 'done', { updated_epoch: i }));
    const doneOnly = buildColumns(doneRows, countsByState([{ state: 'done', n: 423 }]));
    expect(isTruncated(doneOnly), 'done shows 10 by design').toBe(false);

    const cutOpen = buildColumns([baseRow('a', 'ready')], countsByState([{ state: 'ready', n: 7 }]));
    expect(isTruncated(cutOpen)).toBe(true);

    const whole = buildColumns([baseRow('a', 'ready')], countsByState([{ state: 'ready', n: 1 }]));
    expect(isTruncated(whole)).toBe(false);
  });

  test('B4 the board total is the sum of the true counts', () => {
    const columns = buildColumns(
      [baseRow('a', 'backlog')],
      countsByState([
        { state: 'backlog', n: 109 },
        { state: 'done', n: 423 },
        { state: 'active', n: 3 },
      ]),
    );
    expect(columns.reduce((sum, c) => sum + c.count, 0)).toBe(535);
  });
});

const NOW = Date.parse('2026-11-23T20:00:00-06:00');

function snap(sessionId: string, costUsd: number): DaySnapshot {
  return { sessionId, at: NOW - 60_000, hud: { costUsd, limits: [] }, agentRuns: [], cache: null } as unknown as DaySnapshot;
}

test.describe('spend view scope (C6, C16)', () => {
  test('S1 live and ended sessions are summed apart: ended is final, live is an estimate', () => {
    const view = foldSpendView([snap('live-1', 10), snap('ended-1', 5)], new Set(['live-1']), NOW);
    expect(view.engine.usd).toBe(15);
    expect(view.split.live.usd).toBe(10);
    expect(view.split.live.sessions).toBe(1);
    expect(view.split.ended.usd).toBe(5);
    expect(view.split.ended.sessions).toBe(1);
  });

  test('S2 no live session: the live part is empty, not $0', () => {
    const view = foldSpendView([snap('ended-1', 5)], new Set(), NOW);
    expect(view.split.live.usd).toBeNull();
    expect(view.split.live.sessions).toBe(0);
    expect(view.split.ended.usd).toBe(5);
  });
});
